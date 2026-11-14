/**
 * Muse Ember adapter tests: the Muse CLI owns the Muse Code login, so the
 * adapter runs `muse usage --json` and reads its stdout instead of opening a
 * credential file or calling the vendor. A signed-out CLI surfaces as
 * NOT_LOGGED_IN and the login is never renewed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { museUsageFetch, normalizeMuseUsage } from "../lib/providers/quota-muse.js";

/** Body shape of `muse usage --json`, trimmed to what the adapter reads. */
function allowanceBody() {
  return {
    allowance: {
      asOfMs: 1_794_634_589_933,
      source: "mint",
      tier: "Muse Code Everyday Usage",
      window: { usedPercent: 12, resetsAtMs: 1_794_641_602_000 },
      weekly: { usedPercent: 3, resetsAtMs: 1_794_787_200_000 },
    },
    hint: null,
    reason: null,
    schemaVersion: 1,
  };
}

/** Minimal io context: a runner that answers with a canned result. */
function ioFor(result) {
  const calls = [];
  return {
    calls,
    env: {},
    home: "/home/tester",
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return typeof result === "function" ? result(file, args) : result;
    },
  };
}

test("a live allowance maps the 5h and weekly windows", async () => {
  const io = ioFor({ code: 0, stdout: JSON.stringify(allowanceBody()) });
  const usage = await museUsageFetch(io, null);
  assert.equal(io.calls.length, 1);
  assert.deepEqual(io.calls[0].args, ["usage", "--json"]);
  assert.equal(usage.windows["5h"].percent, 12);
  assert.equal(usage.windows.week.percent, 3);
  assert.equal(usage.windows["5h"].resetsAt, new Date(1_794_641_602_000).toISOString());
  assert.equal(usage.meta.plan, "Muse Code Everyday Usage");
});

test("a signed-out CLI surfaces as NOT_LOGGED_IN without a retry loop", async () => {
  const io = ioFor({ code: 1, stdout: "", stderr: "not signed in" });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.equal(error.code, "NOT_LOGGED_IN");
    assert.match(error.message, /muse login/);
    return true;
  });
  assert.equal(io.calls.length, 1);
});

test("a reply that carries no allowance reports the vendor reason", async () => {
  const io = ioFor({ code: 0, stdout: JSON.stringify({ allowance: null, reason: "session expired" }) });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.equal(error.code, "NOT_LOGGED_IN");
    assert.match(error.message, /session expired/);
    return true;
  });
});

test("unparseable output is an error, not an empty card", async () => {
  const io = ioFor({ code: 0, stdout: "Tier: Muse Code Everyday Usage\n" });
  await assert.rejects(() => museUsageFetch(io, null), /unparseable output/);
});

test("a missing binary falls through to the next candidate path", async () => {
  const io = ioFor((file) => {
    if (file === "muse") throw Object.assign(new Error("muse not found"), { code: "ENOENT" });
    return { code: 0, stdout: JSON.stringify(allowanceBody()) };
  });
  const usage = await museUsageFetch(io, null);
  assert.equal(usage.windows["5h"].percent, 12);
  assert.deepEqual(
    io.calls.map((call) => call.file),
    ["muse", "/home/tester/.local/bin/muse"],
  );
});

test("no candidate binary at all reports the missing CLI", async () => {
  const io = ioFor(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.equal(error.code, "NOT_LOGGED_IN");
    assert.match(error.message, /not found/);
    return true;
  });
});

test("normalizeMuseUsage tolerates a partial payload", () => {
  const usage = normalizeMuseUsage({ allowance: { weekly: { usedPercent: 7 } } });
  assert.equal(usage.windows["5h"], undefined);
  assert.equal(usage.windows.week.percent, 7);
  assert.deepEqual(usage.meta, {});
});
