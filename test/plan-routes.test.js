/**
 * Route-scoped plans: a gateway route's calls log the gateway's own provider
 * (`bifrost`) and the route id as the model, so a plan for the vendor behind
 * that route has to claim the samples by model id. These tests pin that the
 * claimed cost reaches the plan card without moving the by-provider bucket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRatesFor } from "../lib/knowledge.js";
import { buildStats } from "../lib/stats.js";

const now = Date.now();
// Built-in defaults from lib/index.js Config; this machine's profile sets none.
const defaultPricing = {
  inputPerMillion: 0.14,
  outputPerMillion: 0.28,
  cacheReadPerMillion: 0.0028,
  cacheWritePerMillion: 0,
};
const pricing = autoRatesFor("bifrost");

const routeSample = (model, inputTokens = 1_000_000) => ({
  sessionId: "s1",
  cwd: "/w",
  createdAt: now,
  time: now,
  provider: "bifrost",
  model,
  turn: 0,
  step: 0,
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

test("route-scoped token plan claims the gateway route's cost", () => {
  const stats = buildStats([routeSample("mistral/deepseek-mistral")], pricing, defaultPricing, {
    plans: [
      {
        provider: "mistral",
        label: "Mistral Vibe",
        type: "token",
        routes: ["mistral/deepseek-mistral"],
      },
    ],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].label, "Mistral Vibe");
  // 1M input at Mistral's $0.30/M, claimed through the route id.
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.3) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
  // Attribution is untouched: the sample stays in the gateway bucket.
  const gateway = stats.byProvider.find((row) => row.provider === "bifrost");
  assert.ok(Math.abs(gateway.cost - 0.3) < 1e-9, `bifrost.cost=${gateway.cost}`);
  assert.equal(stats.byProvider.some((row) => row.provider === "mistral"), false);
});

test("a route the plan does not list stays out of its cost", () => {
  const stats = buildStats([routeSample("strata/qwen-strata")], pricing, defaultPricing, {
    plans: [{ provider: "mistral", type: "token", routes: ["mistral/deepseek-mistral"] }],
  });
  assert.equal(stats.plans[0].usedCost, 0);
});

test("route-scoped code plan fills its quota windows", () => {
  const stats = buildStats(
    [routeSample("mistral/deepseek-mistral", 1000), routeSample("mistral/deepseek-mistral", 1000)],
    pricing,
    defaultPricing,
    { plans: [{ provider: "mistral", type: "code", routes: ["mistral/deepseek-mistral"], quota: { requestsPerWeek: 100 } }] },
  );
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("route-claimed code plan fills the vendor's 5h / week / month cost windows", () => {
  const now = Date.now();
  const call = (msAgo, inputTokens) => ({
    ...routeSample("opendesign/deepseek-opendesign", inputTokens),
    time: now - msAgo,
  });
  const stats = buildStats(
    [call(3600e3, 1_000_000), call(3 * 86400e3, 1_000_000)],
    pricing,
    defaultPricing,
    {
      plans: [{
        provider: "opendesign",
        label: "OpenDesign",
        type: "code",
        routes: ["opendesign/deepseek-opendesign"],
        quota: { dollarsPer5h: 18, dollarsPerWeek: 55, dollarsPerMonth: 220 },
      }],
    },
  );
  const limits = Object.fromEntries((stats.plans[0].limits ?? []).map((limit) => [limit.window, limit]));
  // 1M input tokens at the Flash credit rate ($0.15/M).
  assert.ok(Math.abs(limits["5h"].used - 0.15) < 1e-9, `5h used=${limits["5h"].used}`);
  assert.ok(Math.abs(limits["5h"].remaining - 17.85) < 1e-9, `5h remaining=${limits["5h"].remaining}`);
  // The call from three days ago is inside the week and month windows too.
  assert.ok(Math.abs(limits.week.used - 0.3) < 1e-9, `week used=${limits.week.used}`);
  assert.ok(Math.abs(limits.month.used - 0.3) < 1e-9, `month used=${limits.month.used}`);
  assert.ok(Math.abs(limits.week.pct - (0.3 / 55) * 100) < 1e-9, `week pct=${limits.week.pct}`);
  assert.equal(limits.week.unit, "cost");
  // The plan's headline figure is its week window.
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.3) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
});

test("a plan without a label keeps the provider as its title", () => {
  const stats = buildStats([routeSample("mistral/deepseek-mistral")], pricing, defaultPricing, {
    plans: [{ provider: "mistral", type: "token" }],
  });
  assert.equal(stats.plans[0].label, null);
  // An empty string must fall back too: the card title would render blank.
  const blank = buildStats([routeSample("mistral/deepseek-mistral")], pricing, defaultPricing, {
    plans: [{ provider: "mistral", type: "token", label: "" }],
  });
  assert.equal(blank.plans[0].label, null);
});

test("quota windows are trailing intervals, so a call older than the window drops out", () => {
  // The documented limit of the local estimate: windows end at `now` rather
  // than at the vendor's own reset anchor, so the week row is a trailing 7
  // days and the month row a trailing 30 days. A call outside a window must
  // stop counting in it.
  const t = Date.now();
  const at = (msAgo) => ({ ...routeSample("opendesign/deepseek-opendesign", 1_000_000), time: t - msAgo });
  const stats = buildStats(
    [at(6 * 86400e3), at(8 * 86400e3)],
    pricing,
    defaultPricing,
    {
      plans: [{
        provider: "opendesign",
        type: "code",
        routes: ["opendesign/deepseek-opendesign"],
        quota: { dollarsPerWeek: 55, dollarsPerMonth: 220 },
      }],
    },
  );
  const limits = Object.fromEntries((stats.plans[0].limits ?? []).map((limit) => [limit.window, limit]));
  // Only the six-day-old call ($0.15 credit) is inside the trailing week.
  assert.ok(Math.abs(limits.week.used - 0.15) < 1e-9, `week used=${limits.week.used}`);
  // Both calls sit inside the trailing month.
  assert.ok(Math.abs(limits.month.used - 0.3) < 1e-9, `month used=${limits.month.used}`);
});
