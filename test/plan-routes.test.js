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
