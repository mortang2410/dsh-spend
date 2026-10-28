/**
 * Helper-script tests: Bifrost commits a log row even when its billing refresh
 * fails (its own 504 timeout, or a cancelled fetch), but that row carries no
 * body. The helper must fall back to the newest row that does carry a payload
 * instead of blanking the card, and only report a failure when no recent row
 * has one.
 *
 * These run the real script against a throwaway SQLite database, so the SQL and
 * the row picking are exercised exactly as the adapter runs them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDCODE_SCRIPT, PYTHON } from "../lib/providers/quota-commandcode.js";

/** Billing payload as Bifrost captures it (GOAT plan: 5h cap 14, week cap 35). */
const billingBody = (fiveHourUsed) => JSON.stringify({
  windowLimits: {
    fiveHour: { used: fiveHourUsed, cap: 14, resetAt: 1793300000000 },
    weekly: { used: 3.5, cap: 35, resetAt: 1793400000000 },
  },
  credits: { monthlyCredits: 55.5, purchasedCredits: 0, freeCredits: 0 },
});

/** Build a Bifrost-shaped log database holding the given rows, newest last. */
async function writeLogDb(dir, rows) {
  const spec = join(dir, "rows.json");
  const db = join(dir, "logs.db");
  await writeFile(spec, JSON.stringify(rows));
  const create = [
    "import json, sqlite3, sys",
    "rows = json.load(open(sys.argv[1]))",
    "conn = sqlite3.connect(sys.argv[2])",
    "conn.execute('create table logs (timestamp text, status text, raw_response text, provider text)')",
    "conn.executemany(",
    "    'insert into logs (timestamp, status, raw_response, provider) values (?, ?, ?, ?)',",
    "    [(row['timestamp'], row['status'], row['body'], 'commandcode-billing') for row in rows],",
    ")",
    "conn.commit()",
    "conn.close()",
  ].join("\n");
  const created = spawnSync(PYTHON, ["-c", create, spec, db], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  return db;
}

/**
 * Run the helper offline: the refresh poke points at a closed port and the
 * stale window is huge, so a fixture row is used as-is.
 */
function runHelper(db) {
  return spawnSync(
    PYTHON,
    [COMMANDCODE_SCRIPT, "--db", db, "--gateway", "http://127.0.0.1:9", "--stale-seconds", "100000000"],
    { encoding: "utf8" },
  );
}

test("the newest row that carries a payload is the one reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-commandcode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-10-28 20:30:00.000000001+00:00", status: "success", body: billingBody(1) },
      { timestamp: "2026-10-28 20:35:00.000000001+00:00", status: "success", body: billingBody(7) },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 0, result.stderr);
    const usage = JSON.parse(result.stdout);
    assert.equal(usage.windows["5h"].percent, 50);
    assert.equal(usage.rowTimestamp, "2026-10-28 20:35:00.000000001+00:00");
    assert.equal(usage.rowStatus, "success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed refresh keeps the last good payload instead of an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-commandcode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-10-28 20:30:00.000000001+00:00", status: "success", body: billingBody(7) },
      // Newer rows exist, but these are what a 504 timeout and a cancelled
      // fetch leave behind: a committed row with no response body.
      { timestamp: "2026-10-28 20:35:00.000000001+00:00", status: "cancelled", body: "" },
      { timestamp: "2026-10-28 20:40:00.000000001+00:00", status: "error", body: null },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 0, result.stderr);
    const usage = JSON.parse(result.stdout);
    assert.equal(usage.windows["5h"].percent, 50);
    assert.equal(usage.rowTimestamp, "2026-10-28 20:30:00.000000001+00:00");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database with no payload row reports the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-commandcode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-10-28 20:35:00.000000001+00:00", status: "cancelled", body: "" },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hold no usage payload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
