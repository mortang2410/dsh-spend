/**
 * Command Code adapter tests: the helper's output is validated and mapped onto
 * the widget contract, and helper failures surface as readable errors.
 *
 * The helper itself (scripts/commandcode-usage.py) is exercised live against
 * Bifrost's log database; these tests cover the JavaScript boundary and never
 * touch a credential, because this adapter holds none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { COMMANDCODE_SCRIPT, commandcodeUsageFetch } from "../lib/providers/quota-commandcode.js";

/** Helper output as the python script emits it for a live row. */
const helperPayload = {
  windows: {
    "5h": { status: "ok", percent: 6, resetsAt: "2026-10-25T18:34:48.800000Z" },
    week: { status: "ok", percent: 2, resetsAt: "2026-11-01T13:34:48.800000Z" },
  },
  monthlyCredits: 69.2185837073,
  purchasedCredits: 0,
  freeCredits: 0,
  fetchedAt: "2026-10-25T15:38:09.858271Z",
  rowTimestamp: "2026-10-25 15:36:54.031077978+00:00",
  rowStatus: "success",
  refreshed: false,
};

test("commandcodeUsageFetch maps helper output to the widget contract", async () => {
  const calls = [];
  const io = {
    runCommand: async (scriptPath) => {
      calls.push(scriptPath);
      return helperPayload;
    },
  };
  const usage = await commandcodeUsageFetch(io, null);
  assert.equal(calls[0], COMMANDCODE_SCRIPT);
  assert.equal(usage.windows["5h"].percent, 6);
  assert.equal(usage.windows.week.resetsAt, "2026-11-01T13:34:48.800000Z");
  assert.deepEqual(usage.extra, []);
  assert.equal(usage.meta.monthlyCredits, 69.2185837073);
});

test("commandcodeUsageFetch surfaces a helper failure message", async () => {
  const io = {
    runCommand: async () => {
      throw new Error("no 'commandcode-billing' row in ~/.config/bifrost/logs.db");
    },
  };
  await assert.rejects(() => commandcodeUsageFetch(io, null), /no 'commandcode-billing' row/);
});

test("commandcodeUsageFetch rejects an empty window set", async () => {
  const io = { runCommand: async () => ({ windows: {} }) };
  await assert.rejects(() => commandcodeUsageFetch(io, null), /no usage windows/);
});

test("commandcodeUsageFetch rejects a helper error field", async () => {
  const io = { runCommand: async () => ({ error: "capture disabled" }) };
  await assert.rejects(() => commandcodeUsageFetch(io, null), /capture disabled/);
});

test("the helper script ships with the plugin and is readable", async () => {
  await access(COMMANDCODE_SCRIPT, constants.R_OK);
});
