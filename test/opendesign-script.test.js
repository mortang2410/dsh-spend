/**
 * OpenDesign control-plane helper tests.
 *
 * The allowance numbers can only be read on the account control plane with a
 * `vela_ctrl_…` control key, so the helper is exercised against a local stub
 * that speaks the same two routes: `workspaces/current` and
 * `workspaces/{id}/billing/preflight`. That pins the parsing, the percent
 * arithmetic, the window labels and every failure path without a real key.
 *
 * One assertion matters beyond correctness: the key must never leave the file.
 * Every case checks that the key text appears in neither stdout nor stderr.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PYTHON } from "../lib/providers/common.js";

export const OPENDESIGN_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "opendesign-usage.py",
);

const KEY = "vela_ctrl_testkeyvalue-not-a-real-key";

/** Preflight payload in the shape the control plane documents (Go plan). */
const PREFLIGHT = {
  codingPlan: {
    plan: "Go",
    windows: [
      {
        durationSeconds: 18000,
        limitCredits: 18,
        usedCredits: 2.9,
        remainingCredits: 15.1,
        resetsAt: "2026-11-13T08:00:00Z",
      },
      {
        durationSeconds: 604800,
        limitCredits: 55,
        usedCredits: 2.955,
        remainingCredits: 52.045,
        resetsAt: "2026-11-18T00:00:00Z",
      },
    ],
  },
};

/** Start a stub control plane; resolves to its base URL and a stop function. */
async function stubControlPlane(preflight = PREFLIGHT, preflightStatus = 200) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/v1/workspaces/current") {
      send(200, { activeWorkspaceId: "ws-1" });
      return;
    }
    if (request.url === "/api/v1/workspaces/ws-1/billing/preflight") {
      send(preflightStatus, preflightStatus === 200 ? preflight : { error: { message: "denied" } });
      return;
    }
    send(404, { error: { message: "no such route" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    requests,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Write a key file into a fresh directory and return both paths. */
async function keyFile(contents = KEY) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-spend-opendesign-"));
  const file = join(dir, "control-key");
  if (contents !== null) await writeFile(file, contents);
  return { dir, file };
}

/**
 * Run the helper against a base URL and key file.
 *
 * Asynchronously, because the stub lives in this process: a synchronous spawn
 * would hold the event loop and the stub could never answer the child.
 */
function runHelper(base, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-B", OPENDESIGN_SCRIPT, "--base", base, "--key-file", file]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the two vendor windows come back with used, limit and remaining credits", async () => {
  const server = await stubControlPlane();
  const { dir, file } = await keyFile();
  try {
    const result = await runHelper(server.base, file);
    assert.equal(result.status, 0, result.stderr);
    const usage = JSON.parse(result.stdout);
    const fiveHour = usage.windows["5h"];
    assert.equal(fiveHour.limit, 18);
    assert.equal(fiveHour.used, 2.9);
    assert.equal(fiveHour.remaining, 15.1);
    assert.equal(fiveHour.percent, 16.1);
    assert.equal(fiveHour.resetsAt, "2026-11-13T08:00:00Z");
    const week = usage.windows.week;
    assert.equal(week.limit, 55);
    assert.equal(week.percent, 5.4);
    assert.equal(usage.workspace, "ws-1");
    assert.equal(usage.plan, "Go");
    assert.deepEqual(
      server.requests.map((row) => row.url),
      ["/api/v1/workspaces/current", "/api/v1/workspaces/ws-1/billing/preflight"],
    );
    assert.equal(server.requests[0].authorization, "Bearer " + KEY);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing or empty key file stops before any request, and names od-login", async () => {
  const server = await stubControlPlane();
  const missing = await keyFile(null);
  const empty = await keyFile("\n");
  try {
    for (const { dir, file } of [missing, empty]) {
      const result = await runHelper(server.base, file);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /run od-login/);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes(KEY), false);
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(server.requests.length, 0, "no request may be sent without a key");
  } finally {
    await server.stop();
  }
});

test("a refused preflight reports the status and never the key", async () => {
  const server = await stubControlPlane(PREFLIGHT, 403);
  const { dir, file } = await keyFile();
  try {
    const result = await runHelper(server.base, file);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "billing/preflight answered HTTP 403");
    assert.equal(result.stdout, "");
    assert.equal((result.stderr + result.stdout).includes(KEY), false);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a payload without a usable window fails instead of printing an empty card", async () => {
  const server = await stubControlPlane({ codingPlan: { windows: [{ durationSeconds: 3600 }] } });
  const { dir, file } = await keyFile();
  try {
    const result = await runHelper(server.base, file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no recognizable allowance window/);
    assert.equal(result.stdout, "");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
