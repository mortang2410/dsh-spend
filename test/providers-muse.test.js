/**
 * Muse Ember adapter tests: the Muse CLI owns the Muse Code login, so the
 * adapter runs `muse usage --json` and reads its stdout instead of opening a
 * credential file or calling the vendor. A signed-out CLI surfaces as
 * NOT_LOGGED_IN, the login is never renewed here, the child process gets a
 * minimal environment, and nothing the CLI prints is copied into an error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { museChildEnv, museUsageFetch, normalizeMuseUsage, reasonHint } from "../lib/providers/quota-muse.js";

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

/** Minimal io context: a runner that records its arguments and answers canned. */
function ioFor(result, env = {}) {
  const calls = [];
  return {
    calls,
    env,
    home: "/home/tester",
    run: async (file, args, timeoutMs, options) => {
      calls.push({ file, args, timeoutMs, options });
      return typeof result === "function" ? result(file, args) : result;
    },
  };
}

/** A secret-shaped variable the child must never see. */
const SENTINEL = "REVIEW_SECRET_SENTINEL_0123456789";

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

test("the child environment is an allowlist, not the plugin's whole env", async () => {
  const io = ioFor({ code: 0, stdout: JSON.stringify(allowanceBody()) }, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    LANG: "C.UTF-8",
    // Neither of these may reach the subprocess.
    META_API_KEY: SENTINEL,
    OPENROUTER_API_KEY: SENTINEL,
  });
  await museUsageFetch(io, null);
  const env = io.calls[0].options?.env;
  assert.ok(env !== undefined, "the adapter must pass an explicit environment");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.META_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.ok(!Object.values(env).includes(SENTINEL));
});

test("museChildEnv drops empty values and unknown names", () => {
  assert.deepEqual(museChildEnv({ PATH: "/bin", HOME: "", LEAKY_KEY: "x" }), { PATH: "/bin" });
  assert.deepEqual(museChildEnv(undefined), {});
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

test("a reply that carries no allowance reports the classified reason", async () => {
  const io = ioFor({ code: 0, stdout: JSON.stringify({ allowance: null, reason: "session expired" }) });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.equal(error.code, "NOT_LOGGED_IN");
    assert.match(error.message, /session expired/);
    return true;
  });
});

test("a token pasted into the vendor reason never reaches the error", async () => {
  // The plan card renders the error text, so a credential-looking reason has
  // to be reduced to its harmless words before it is surfaced.
  const io = ioFor({ code: 0, stdout: JSON.stringify({ allowance: null, reason: `bad key ${SENTINEL}` }) });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.ok(!error.message.includes(SENTINEL), "the sentinel leaked into the error message");
    assert.match(error.message, /no allowance/);
    return true;
  });
});

test("unparseable output is an error that never echoes the bytes", async () => {
  const io = ioFor({ code: 0, stdout: SENTINEL });
  await assert.rejects(() => museUsageFetch(io, null), (error) => {
    assert.match(error.message, /not JSON/);
    assert.ok(!error.message.includes(SENTINEL), "raw output leaked into the error message");
    return true;
  });
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

test("reasonHint classifies without echoing", () => {
  assert.equal(reasonHint("session expired"), "session expired");
  assert.equal(reasonHint("please sign in again"), "not signed in");
  assert.equal(reasonHint("quota throttled"), "plan limited");
  assert.equal(reasonHint("something odd"), undefined);
  assert.equal(reasonHint(undefined), undefined);
  // A token in the field yields a classification or nothing, never the token.
  assert.equal(reasonHint("sk-live-" + "a".repeat(40)), undefined);
});

test("normalizeMuseUsage tolerates a partial payload", () => {
  const usage = normalizeMuseUsage({ allowance: { weekly: { usedPercent: 7 } } });
  assert.equal(usage.windows["5h"], undefined);
  assert.equal(usage.windows.week.percent, 7);
  assert.deepEqual(usage.meta, {});
});
