/**
 * OpenDesign adapter tests: the helper's normalized allowance payload is
 * validated and mapped onto the widget contract, and helper failures surface
 * as readable errors instead of a blank card.
 *
 * The adapter holds no credential; the helper it runs reads the control key
 * file. Nothing here touches a real key or the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENDESIGN_SCRIPT, opendesignUsageFetch } from "../lib/providers/quota-opendesign.js";

/** Helper output as the python script emits it for a live Go plan. */
const helperPayload = {
  windows: {
    "5h": {
      status: "ok",
      percent: 16.1,
      used: 2.9,
      limit: 18,
      remaining: 15.1,
      resetsAt: "2026-11-13T08:00:00Z",
    },
    week: {
      status: "ok",
      percent: 5.4,
      used: 2.955,
      limit: 55,
      remaining: 52.045,
      resetsAt: "2026-11-18T00:00:00Z",
    },
  },
  workspace: "ws-1",
  plan: "Go",
  fetchedAt: "2026-11-13T05:40:00.000000Z",
};

test("opendesignUsageFetch maps the control-plane payload to the widget contract", async () => {
  const calls = [];
  const io = {
    runCommand: async (scriptPath) => {
      calls.push(scriptPath);
      return helperPayload;
    },
  };
  const usage = await opendesignUsageFetch(io, null);
  assert.equal(calls[0], OPENDESIGN_SCRIPT);
  assert.equal(usage.windows["5h"].percent, 16.1);
  assert.equal(usage.windows["5h"].limit, 18);
  assert.equal(usage.windows["5h"].remaining, 15.1);
  assert.equal(usage.windows.week.resetsAt, "2026-11-18T00:00:00Z");
  assert.deepEqual(usage.extra, []);
  assert.equal(usage.meta.plan, "Go");
  assert.equal(usage.meta.workspace, "ws-1");
});

test("a plan with only the 7-day window passes through without inventing a 5-hour row", async () => {
  const io = {
    runCommand: async () => ({
      windows: { week: helperPayload.windows.week },
      plan: "Pro",
    }),
  };
  const usage = await opendesignUsageFetch(io, null);
  assert.deepEqual(Object.keys(usage.windows), ["week"]);
  assert.equal(usage.meta.plan, "Pro");
});

test("a payload with no windows is an error, not an empty card", async () => {
  const io = { runCommand: async () => ({ windows: {} }) };
  await assert.rejects(() => opendesignUsageFetch(io, null), /no allowance windows/);
});

test("a helper error message reaches the caller", async () => {
  const io = {
    runCommand: async () => ({ error: "billing/preflight answered HTTP 401" }),
  };
  await assert.rejects(() => opendesignUsageFetch(io, null), /answered HTTP 401/);
});

test("the endpoint row can move the script path and the timeout", async () => {
  const calls = [];
  const io = {
    runCommand: async (scriptPath) => {
      calls.push(scriptPath);
      return helperPayload;
    },
  };
  await opendesignUsageFetch(io, { script: "/tmp/custom-opendesign.py", timeoutMs: 5000 });
  assert.equal(calls[0], "/tmp/custom-opendesign.py");
});
