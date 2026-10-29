/**
 * Codex adapter tests: the saved OAuth pair belongs to the Codex CLI, so the
 * adapter reads `~/.codex/auth.json` and never posts to the token endpoint.
 * A lapsed access token is handed back to the CLI (`codex doctor`), which
 * renews under its own process (same rule as the Claude Code adapter).
 *
 * Network and clock are stubbed; no credential value leaves this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexFetch, resetCodexOwnerCheck } from "../lib/providers/oauth-codex.js";

/** Unsigned JWT-shaped token carrying only the `exp` claim the adapter reads. */
function tokenExpiringAt(unixSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: unixSeconds })}.signature`;
}

function credentials(expUnixSeconds) {
  return JSON.stringify({
    tokens: { access_token: tokenExpiringAt(expUnixSeconds), refresh_token: "refresh-a", account_id: "account-a" },
  });
}

/** Minimal io context; the fixture answers whichever candidate path is asked. */
function ioFor(text) {
  return { env: {}, home: "/home/tester", readText: async (path) => (path.endsWith("auth.json") ? text : undefined) };
}

/** Body shape of GET /backend-api/wham/usage, trimmed to what the adapter reads. */
function usageBody() {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 25, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 60, reset_at: 1_800_500_000 },
    },
  };
}

/** Replace the global clock and fetch for one test. */
function harness(responder) {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let clock = 1_000_000;
  const calls = [];
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(calls.length);
  };
  return {
    calls,
    advance(ms) {
      clock += ms;
    },
    restore() {
      Date.now = realNow;
      globalThis.fetch = realFetch;
      resetCodexOwnerCheck();
    },
  };
}

/** Minimal Response stand-in for the shared `request` helper. */
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("a live token reads the usage endpoint once", async () => {
  // Harness clock is 1_000_000 ms; exp is seconds, far in the future.
  const h = harness(() => response(200, usageBody()));
  try {
    const usage = await codexFetch(ioFor(credentials(2_000)), null);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /chatgpt\.com\/backend-api\/wham\/usage$/);
    assert.equal(usage.windows["5h"].percent, 25);
    assert.equal(usage.windows.week.percent, 60);
  } finally {
    h.restore();
  }
});

test("an expired access token makes no request at all", async () => {
  // exp 900 s = 900_000 ms, below the harness clock: stale.
  const h = harness(() => response(200, usageBody()));
  try {
    await assert.rejects(() => codexFetch(ioFor(credentials(900)), null), (error) => {
      assert.equal(error.code, "NOT_LOGGED_IN");
      assert.match(error.message, /expired/i);
      return true;
    });
    assert.equal(h.calls.length, 0);
  } finally {
    h.restore();
  }
});

test("a rejected token surfaces without renewing the saved login", async () => {
  // Renewing here would rotate the pair the Codex CLI owns and discards the
  // new one, so the CLI's stored credentials would stop being the live ones.
  const h = harness(() => response(401, { error: { type: "authentication_error" } }));
  try {
    await assert.rejects(() => codexFetch(ioFor(credentials(2_000)), null), (error) => {
      assert.equal(error.code, "AUTH");
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /backend-api\/wham\/usage$/);
    assert.doesNotMatch(h.calls[0].url, /oauth\/token/);
  } finally {
    h.restore();
  }
});

test("an opaque token without an exp claim is decided by the endpoint", async () => {
  // No readable expiry means "ask the API", not "expired".
  const opaque = JSON.stringify({ tokens: { access_token: "opaque-token", refresh_token: "refresh-a" } });
  const h = harness(() => response(200, usageBody()));
  try {
    const usage = await codexFetch(ioFor(opaque), null);
    assert.equal(h.calls.length, 1);
    assert.equal(usage.windows["5h"].percent, 25);
  } finally {
    h.restore();
  }
});

test("a fresh token never spawns the CLI", async () => {
  const runs = [];
  const io = {
    env: {},
    home: "/home/tester",
    readText: async (path) => (path.endsWith("auth.json") ? credentials(2_000) : undefined),
    run: async (file, args) => {
      runs.push({ file, args });
      return { code: 0 };
    },
  };
  const h = harness(() => response(200, usageBody()));
  try {
    await codexFetch(io, null);
    assert.equal(runs.length, 0);
    assert.equal(h.calls.length, 1);
  } finally {
    h.restore();
  }
});

test("a lapsed token is handed back to the Codex CLI, which renews it", async () => {
  // The adapter never posts to the token endpoint: it runs the CLI's own
  // diagnostic, the CLI rotates the pair into `auth.json`, and the file is
  // re-read.
  const state = { text: credentials(900) };
  const runs = [];
  const nudgeIo = {
    env: {},
    home: "/home/tester",
    readText: async (path) => (path.endsWith("auth.json") ? state.text : undefined),
    run: async (file, args) => {
      runs.push({ file, args });
      state.text = credentials(2_000);
      return { code: 0 };
    },
  };
  const h = harness(() => response(200, usageBody()));
  try {
    const usage = await codexFetch(nudgeIo, null);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].args, ["doctor", "--summary", "--no-color"]);
    assert.match(runs[0].file, /codex$/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.headers.Authorization, `Bearer ${JSON.parse(state.text).tokens.access_token}`);
    assert.equal(usage.windows["5h"].percent, 25);
  } finally {
    h.restore();
  }
});

test("a CLI that cannot renew is not asked again on every poll", async () => {
  const state = { text: credentials(900) };
  const runs = [];
  const nudgeIo = {
    env: {},
    home: "/home/tester",
    readText: async (path) => (path.endsWith("auth.json") ? state.text : undefined),
    run: async (file, args) => {
      runs.push({ file, args });
      return { code: 0 };
    },
  };
  const h = harness(() => response(200, usageBody()));
  try {
    await assert.rejects(() => codexFetch(nudgeIo, null), (error) => error.code === "NOT_LOGGED_IN" && /expired/i.test(error.message));
    h.advance(30_000);
    await assert.rejects(() => codexFetch(nudgeIo, null), (error) => error.code === "NOT_LOGGED_IN");
    assert.equal(runs.length, 1);
    h.advance(10 * 60 * 1000);
    await assert.rejects(() => codexFetch(nudgeIo, null), (error) => error.code === "NOT_LOGGED_IN");
    assert.equal(runs.length, 2);
    assert.equal(h.calls.length, 0);
  } finally {
    h.restore();
  }
});
