/**
 * Model-scoped attribution: one gateway route can serve several vendors, so a
 * call belongs to the vendor its model names, not to the route id. These tests
 * drive the production functions the service calls (`discoveredProviders`,
 * `buildStats`) rather than composing them by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveredProviders, discoverPlans } from "../lib/knowledge.js";
import { billingBreakdown, buildStats, foldSession } from "../lib/stats.js";

/** One logged call: a request header plus the usage the response reported. */
function callsFor(provider, model) {
  const now = Date.now();
  return foldSession(
    [
      { type: "request/header", time: now, data: { header: { config: { provider, model } } } },
      { type: "assistant/message", time: now, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500 } } },
    ],
    { id: "attribution-probe", cwd: "/", createdAt: now },
  );
}

test("a Meta model is discovered as Meta whatever route carried it", () => {
  const seen = discoveredProviders(callsFor("bifrost-responses", "meta/ember-mc"));
  assert.deepEqual([...seen], ["meta"]);
  assert.equal(discoverPlans(seen).autoPlans[0]?.provider, "meta");
});

test("another vendor's model on the same route is not discovered as Meta", () => {
  const seen = discoveredProviders(callsFor("bifrost-responses", "other-vendor/model"));
  assert.deepEqual([...seen], ["bifrost-responses"]);
  assert.deepEqual(discoverPlans(seen).autoPlans, []);
});

test("a call without a naming model falls back to its provider id", () => {
  const seen = discoveredProviders([
    { provider: "claude-sub", model: "opus" },
    { provider: "bifrost", model: "opendesign/deepseek-eco" },
  ]);
  assert.deepEqual([...seen], ["claude-sub", "bifrost"]);
  assert.deepEqual([...discoveredProviders(undefined)], []);
});

test("the provider bucket follows the model, so the plan card matches", () => {
  const calls = callsFor("bifrost-responses", "meta/ember-mc");
  const stats = buildStats(calls, [], {}, {
    plans: [{ provider: "meta", type: "code", subscription: { amount: 5, currency: "USD", period: "month" } }],
  });
  const providers = stats.byProvider.map((row) => row.provider);
  assert.deepEqual(providers, ["meta"], `byProvider=${JSON.stringify(providers)}`);
  assert.equal(stats.plans[0].usedRequests, 1, "the Meta plan must claim its own call");
});

test("a foreign model on the same route stays out of the Meta plan", () => {
  const calls = callsFor("bifrost-responses", "other-vendor/model");
  const stats = buildStats(calls, [], {}, {
    plans: [{ provider: "meta", type: "code", subscription: { amount: 5, currency: "USD", period: "month" } }],
  });
  assert.deepEqual(stats.byProvider.map((row) => row.provider), ["bifrost-responses"]);
  assert.equal(stats.plans[0].usedRequests, 0);
});

test("the billing summary bills the Meta route as the subscription, not token spend", () => {
  const calls = callsFor("bifrost-responses", "meta/ember-mc");
  const plans = [{ provider: "meta", type: "code", subscription: { amount: 5, currency: "USD", period: "month" } }];
  const stats = buildStats(calls, [], {}, { plans });
  const parts = billingBreakdown(stats.byProvider, plans, "USD", stats.recentCostByProvider);
  assert.deepEqual(parts, [{ provider: "meta", kind: "subscription", amount: 5, currency: "USD", period: "month" }]);
});

test("an unpriced foreign model on the same route stays on token billing", () => {
  const calls = callsFor("bifrost-responses", "other-vendor/model");
  const plans = [{ provider: "meta", type: "code", subscription: { amount: 5, currency: "USD", period: "month" } }];
  const stats = buildStats(calls, [], {}, { plans });
  const parts = billingBreakdown(stats.byProvider, plans, "USD", stats.recentCostByProvider);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].provider, "bifrost-responses");
  assert.equal(parts[0].kind, "token");
});
