/**
 * Claude Code adapter tests: the usage endpoint throttles hard (HTTP 429 at
 * roughly one request per minute, measured 2026-10-26), so the adapter caches
 * a successful payload and replays it instead of letting the card go blank.
 *
 * Network and clock are stubbed; no credential value leaves this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeFetch, resetClaudeUsageCache } from "../lib/providers/oauth-claude.js";

const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "token-a", refreshToken: "refresh-a" } });

const io = {
  env: {},
  home: "/home/tester",
  readText: async (path) => (path.endsWith(".credentials.json") ? credentials : undefined),
};

/** Body shape of GET /api/oauth/usage, trimmed to what the adapter reads. */
function usageBody() {
  return {
    five_hour: { utilization: 12, resets_at: "2026-10-26T09:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-10-29T23:59:59Z" },
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
    now: () => clock,
    restore() {
      Date.now = realNow;
      globalThis.fetch = realFetch;
      resetClaudeUsageCache();
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

test("caches a successful payload and skips the network inside the interval", async () => {
  const h = harness(() => response(200, usageBody()));
  try {
    const first = await claudeFetch(io, null);
    h.advance(1_000);
    const second = await claudeFetch(io, null);
    assert.equal(h.calls.length, 1);
    assert.equal(first.windows["5h"].percent, 12);
    assert.deepEqual(second.windows, first.windows);
    assert.equal(second.fetchedAt, h.now() - 1_000);
  } finally {
    h.restore();
  }
});

test("replays the cached payload when Anthropic throttles", async () => {
  const h = harness((n) => (n === 1 ? response(200, usageBody()) : response(429, { error: { type: "rate_limit_error" } })));
  try {
    const first = await claudeFetch(io, null);
    h.advance(5 * 60 * 1000 + 1);
    const throttled = await claudeFetch(io, null);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(throttled.windows, first.windows);
    assert.equal(throttled.fetchedAt, first.fetchedAt);
  } finally {
    h.restore();
  }
});

test("surfaces the throttle when nothing is cached yet", async () => {
  const h = harness(() => response(429, { error: { type: "rate_limit_error" } }));
  try {
    await assert.rejects(() => claudeFetch(io, null), (error) => {
      assert.equal(error.code, "RATE_LIMIT");
      assert.match(error.message, /rate limited/);
      return true;
    });
  } finally {
    h.restore();
  }
});

test("a non-throttle failure still surfaces instead of replaying stale data", async () => {
  const h = harness((n) => (n === 1 ? response(200, usageBody()) : response(500, { error: "boom" })));
  try {
    await claudeFetch(io, null);
    h.advance(5 * 60 * 1000 + 1);
    await assert.rejects(() => claudeFetch(io, null), /HTTP 500/);
  } finally {
    h.restore();
  }
});
