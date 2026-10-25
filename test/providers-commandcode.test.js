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

/** Helper output as the python script emits it for a live GOAT row. */
const helperPayload = {
  windows: {
    "5h": { status: "ok", percent: 10, used: 1.3952408215, cap: 14, resetsAt: "2026-10-25T18:34:48.800000Z" },
    week: { status: "ok", percent: 4, used: 1.3952408215, cap: 35, resetsAt: "2026-11-01T13:34:48.800000Z" },
  },
  monthlyCredits: 68.6047591785,
  purchasedCredits: 0,
  freeCredits: 0,
  fetchedAt: "2026-10-25T17:00:58.089575Z",
  rowTimestamp: "2026-10-25 16:58:36.394226511+00:00",
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
  assert.equal(usage.windows["5h"].percent, 10);
  assert.equal(usage.windows.week.resetsAt, "2026-11-01T13:34:48.800000Z");
  assert.deepEqual(usage.extra, []);
  assert.equal(usage.meta.monthlyCredits, 68.6047591785);
});

test("the GOAT window caps yield the monthly pool row and the plan name", async () => {
  const io = { runCommand: async () => helperPayload };
  const usage = await commandcodeUsageFetch(io, null);
  // GOAT is a $70 pool with $14 / $35 rolling caps; 70 - 68.6048 = 1.3952 used.
  assert.equal(usage.windows.month.percent, 2);
  assert.equal(usage.windows.month.limit, 70);
  assert.equal(usage.windows.month.remaining, 68.6047591785);
  assert.equal(usage.meta.plan, "GOAT");
});

test("an unlisted cap pair omits the monthly row instead of guessing", async () => {
  const payload = {
    ...helperPayload,
    windows: {
      "5h": { ...helperPayload.windows["5h"], cap: 14 },
      week: { ...helperPayload.windows.week, cap: 40 },
    },
  };
  const io = { runCommand: async () => payload };
  const usage = await commandcodeUsageFetch(io, null);
  assert.equal(usage.windows.month, undefined);
  assert.equal(usage.meta.plan, undefined);
  assert.equal(usage.meta.monthlyCredits, 68.6047591785);
});

test("purchased credits above the included pool clamp the monthly share to zero", async () => {
  const io = { runCommand: async () => ({ ...helperPayload, monthlyCredits: 75 }) };
  const usage = await commandcodeUsageFetch(io, null);
  assert.equal(usage.windows.month.percent, 0);
  assert.equal(usage.windows.month.used, 0);
});

test("a payload without caps or monthly credits omits the monthly row", async () => {
  const noCaps = { ...helperPayload, windows: { "5h": { status: "ok", percent: 6 }, week: { status: "ok", percent: 2 } } };
  const usage = await commandcodeUsageFetch({ runCommand: async () => noCaps }, null);
  assert.equal(usage.windows.month, undefined);
  assert.equal(usage.meta.plan, undefined);

  const noCredits = { ...helperPayload, monthlyCredits: undefined };
  const second = await commandcodeUsageFetch({ runCommand: async () => noCredits }, null);
  assert.equal(second.windows.month, undefined);
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
