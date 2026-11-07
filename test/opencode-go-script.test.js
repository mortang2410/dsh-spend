/**
 * Helper-script tests for the OpenCode Go capture: the script reads the newest
 * row that carries a usage payload, because Bifrost commits a row even when its
 * refresh fails (its own 504 timeout, or a cancelled fetch) and that row has no
 * body.
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
import { OPENCODE_GO_SCRIPT } from "../lib/providers/opencode.js";
import { PYTHON } from "../lib/providers/common.js";

/** Usage body as Bifrost captures it: a one-element array around the payload. */
const usageBody = (rollingPercent) => JSON.stringify([{
  usage: {
    rolling: { status: "ok", percent: rollingPercent, resetsAt: "2026-11-07T18:04:55.000Z" },
    weekly: { status: "ok", percent: 4, resetsAt: "2026-11-09T00:00:00.000Z" },
    monthly: { status: "ok", percent: 7, resetsAt: "2026-12-07T12:55:20.000Z" },
  },
}]);

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
    "    [(row['timestamp'], row['status'], row['body'], 'opencode-go-billing') for row in rows],",
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
    ["-B", OPENCODE_GO_SCRIPT, "--db", db, "--gateway", "http://127.0.0.1:9", "--stale-seconds", "100000000"],
    { encoding: "utf8" },
  );
}

test("the newest row that carries a payload is the one reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-opencode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-11-07 13:20:00.000000001+00:00", status: "success", body: usageBody(1) },
      { timestamp: "2026-11-07 13:23:05.000000001+00:00", status: "success", body: usageBody(6) },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.payload.usage.rolling.percent, 6);
    assert.equal(captured.rowTimestamp, "2026-11-07 13:23:05.000000001+00:00");
    assert.equal(captured.rowStatus, "success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed refresh keeps the last good payload instead of an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-opencode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-11-07 13:20:00.000000001+00:00", status: "success", body: usageBody(6) },
      // Newer rows exist, but these are what a 504 timeout and a cancelled
      // fetch leave behind: a committed row with no response body.
      { timestamp: "2026-11-07 13:25:00.000000001+00:00", status: "cancelled", body: "" },
      { timestamp: "2026-11-07 13:30:00.000000001+00:00", status: "error", body: null },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.payload.usage.rolling.percent, 6);
    assert.equal(captured.rowTimestamp, "2026-11-07 13:20:00.000000001+00:00");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database with no payload row reports the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-opencode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-11-07 13:25:00.000000001+00:00", status: "cancelled", body: "" },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim().split("\n").at(-1),
      "rows for 'opencode-go-billing' hold no usage payload "
        + "(newest 2026-11-07 13:25:00.000000001+00:00 status=cancelled); "
        + "capture disabled, body trimmed, or every recent fetch failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a payload without usage windows reports the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-opencode-"));
  try {
    const db = await writeLogDb(dir, [
      { timestamp: "2026-11-07 13:25:00.000000001+00:00", status: "success", body: JSON.stringify([{ usage: null }]) },
    ]);
    const result = runHelper(db);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no usage windows/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
