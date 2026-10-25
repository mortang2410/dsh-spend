/**
 * Command Code adapter tests: normalization of the alpha billing payloads, the
 * monthly-credit derivation, and the credential order (credentials seam →
 * the CLI's own `~/.commandcode/auth.json` login file).
 *
 * Fixtures mirror the shapes returned live by
 * `GET /alpha/billing/credits` and `GET /alpha/usage/summary` (account
 * identifiers and the API key itself are not part of either payload).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDCODE_CREDITS_URL,
  COMMANDCODE_SUMMARY_URL,
  commandcodeUsageFetch,
  normalizeCommandcodeUsage,
} from "../lib/providers/quota-commandcode.js";

/** Live credits shape: rolling spend windows in credit dollars + balance. */
const creditsPayload = {
  success: true,
  credits: { creditThreshold: 0, monthlyCredits: 69.9743198186, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.0256801814, cap: 14, resetAt: 1792953288800 },
    weekly: { used: 0.0256801814, cap: 35, resetAt: 1793540088800 },
  },
};

/** Live summary shape: billed cost for the current billing period. */
const summaryPayload = {
  totalCount: 25,
  totalCost: 0.0212695565,
  completedCount: 25,
  failedCount: 0,
  totalTokens: 940175,
  periodStart: "2026-10-25T10:27:23.000Z",
};

/** Fake fetch queue: one scripted response per request, in call order. */
function stubFetch(responses) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url, headers: options?.headers ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const ioOf = (env, files = {}) => ({
  env,
  home: "/home/tester",
  resolveRef: async (name) => env[name],
  readText: async (path) => files[path],
});

test("normalizeCommandcodeUsage maps the vendor's rolling windows", () => {
  const { windows, extra, meta } = normalizeCommandcodeUsage(creditsPayload, summaryPayload);
  assert.equal(windows["5h"].status, "ok");
  assert.equal(windows["5h"].percent, 0, "0.0257 of 14 is 0.2%, rounded to 0");
  assert.equal(windows["5h"].resetsAt, new Date(1792953288800).toISOString());
  assert.equal(windows.week.percent, 0);
  assert.equal(windows.week.resetsAt, new Date(1793540088800).toISOString());
  assert.deepEqual(extra, []);
  assert.deepEqual(meta, {});
});

test("normalizeCommandcodeUsage rounds window percent and keeps the ms reset", () => {
  const { windows } = normalizeCommandcodeUsage(
    {
      credits: { monthlyCredits: 50, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { used: 7, cap: 14, resetAt: 1792953288800 },
        weekly: { used: 35, cap: 35, resetAt: 1793540088800 },
      },
    },
    { totalCost: 0 },
  );
  assert.equal(windows["5h"].percent, 50);
  assert.equal(windows.week.percent, 100);
});

test("normalizeCommandcodeUsage clamps an over-cap window at 100", () => {
  const { windows } = normalizeCommandcodeUsage(
    { windowLimits: { fiveHour: { used: 21, cap: 14, resetAt: 1792953288800 } } },
    undefined,
  );
  assert.equal(windows["5h"].percent, 100);
});

test("normalizeCommandcodeUsage derives the monthly row from remaining + billed", () => {
  const { windows } = normalizeCommandcodeUsage(
    { credits: { monthlyCredits: 50.99, purchasedCredits: 0, freeCredits: 0 } },
    { totalCost: 18.99 },
  );
  // grant = 50.99 + 18.99 = 69.98 → 18.99 / 69.98 = 27%
  assert.equal(windows.month.percent, 27, "the documented example: $50.99 left of $69.98 granted");
  assert.equal(windows.month.resetsAt, undefined, "the period end lives on the subscriptions route, which is not polled");
});

test("normalizeCommandcodeUsage drops the derived monthly row when on-demand credits are in play", () => {
  const withPurchased = normalizeCommandcodeUsage(
    { credits: { monthlyCredits: 50.99, purchasedCredits: 12, freeCredits: 0 } },
    { totalCost: 18.99 },
  );
  assert.equal(withPurchased.windows.month, undefined, "remaining + billed is no longer the grant once top-ups are spent");
  const withoutSummary = normalizeCommandcodeUsage(
    { credits: { monthlyCredits: 50.99, purchasedCredits: 0, freeCredits: 0 } },
    undefined,
  );
  assert.equal(withoutSummary.windows.month, undefined);
});

test("normalizeCommandcodeUsage tolerates unusable payloads", () => {
  const empty = { windows: {}, extra: [], meta: {} };
  assert.deepEqual(normalizeCommandcodeUsage(undefined, undefined), empty);
  assert.deepEqual(normalizeCommandcodeUsage({}, {}), empty);
  assert.deepEqual(normalizeCommandcodeUsage({ windowLimits: null }, {}), empty);
  assert.deepEqual(
    normalizeCommandcodeUsage({ windowLimits: { fiveHour: { used: 1, cap: 0 } } }, {}),
    empty,
    "a zero cap is not a percentage",
  );
  assert.deepEqual(
    normalizeCommandcodeUsage({ windowLimits: { fiveHour: { used: "?", cap: 14 } } }, {}),
    empty,
    "an unparseable used value is skipped",
  );
});

test("commandcodeUsageFetch sends the seam key and polls credits then summary", async () => {
  const { seen, restore } = stubFetch([
    { status: 200, body: creditsPayload },
    { status: 200, body: summaryPayload },
  ]);
  try {
    const usage = await commandcodeUsageFetch(ioOf({ COMMANDCODE_API_KEY: "key-a" }), null);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, COMMANDCODE_CREDITS_URL);
    assert.equal(seen[1].url, COMMANDCODE_SUMMARY_URL);
    assert.equal(seen[0].headers.Authorization, "Bearer key-a");
    assert.equal(seen[0].headers["User-Agent"], "dsh-spend", "the alpha routes reject a bare client signature");
    assert.equal(usage.windows["5h"].status, "ok");
    assert.ok(usage.windows.month !== undefined, "summary present → monthly row");
  } finally {
    restore();
  }
});

test("commandcodeUsageFetch falls back to the CLI login file", async () => {
  const { seen, restore } = stubFetch([{ status: 200, body: creditsPayload }]);
  try {
    const usage = await commandcodeUsageFetch(
      ioOf({}, { "/home/tester/.commandcode/auth.json": JSON.stringify({ commandcode: { type: "oauth", access: "cli-key" } }) }),
      null,
    );
    assert.equal(seen[0].headers.Authorization, "Bearer cli-key");
    assert.equal(usage.windows.week.status, "ok");
    assert.equal(usage.windows.month, undefined, "no summary was served");
  } finally {
    restore();
  }
});

test("commandcodeUsageFetch accepts the other CLI auth-file shapes", async () => {
  for (const [label, file] of [
    ["apiKey", JSON.stringify({ apiKey: "shape-a" })],
    ["command-code.key", JSON.stringify({ "command-code": { type: "api", key: "shape-b" } })],
  ]) {
    const { seen, restore } = stubFetch([{ status: 200, body: creditsPayload }]);
    try {
      await commandcodeUsageFetch(ioOf({}, { "/home/tester/.commandcode/auth.json": file }), null);
      assert.equal(typeof seen[0].headers.Authorization, "string", label);
    } finally {
      restore();
    }
  }
});

test("commandcodeUsageFetch: an explicit apiKeyEnv override never falls back to the CLI file", async () => {
  await assert.rejects(
    () => commandcodeUsageFetch(
      ioOf({}, { "/home/tester/.commandcode/auth.json": JSON.stringify({ apiKey: "cli-key" }) }),
      { apiKeyEnv: "CUSTOM_COMMANDCODE_KEY" },
    ),
    /CUSTOM_COMMANDCODE_KEY/,
  );
});

test("commandcodeUsageFetch reports a missing key and a rejected key", async () => {
  await assert.rejects(() => commandcodeUsageFetch(ioOf({}), null), /API key not configured \(COMMANDCODE_API_KEY\)/);
  const { restore } = stubFetch([{ status: 401, body: { success: false } }]);
  try {
    await assert.rejects(() => commandcodeUsageFetch(ioOf({ COMMANDCODE_API_KEY: "bad" }), null), /API key rejected \(HTTP 401\)/);
  } finally {
    restore();
  }
});

test("commandcodeUsageFetch keeps the vendor windows when the summary call fails", async () => {
  const { restore } = stubFetch([
    { status: 200, body: creditsPayload },
    { status: 500, body: { success: false } },
  ]);
  try {
    const usage = await commandcodeUsageFetch(ioOf({ COMMANDCODE_API_KEY: "key-a" }), null);
    assert.equal(usage.windows["5h"].status, "ok");
    assert.equal(usage.windows.week.status, "ok");
    assert.equal(usage.windows.month, undefined);
  } finally {
    restore();
  }
});

test("commandcodeUsageFetch fails when the payload carries no window at all", async () => {
  const { restore } = stubFetch([{ status: 200, body: { success: true, credits: {} } }]);
  try {
    await assert.rejects(() => commandcodeUsageFetch(ioOf({ COMMANDCODE_API_KEY: "key-a" }), null), /no usage windows/);
  } finally {
    restore();
  }
});
