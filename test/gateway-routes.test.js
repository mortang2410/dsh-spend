/**
 * Gateway route pricing tests: a Bifrost call arrives as `provider:
 * "bifrost"` with the client-facing route id as its model
 * (`mistral/deepseek-mistral`), which appears in no vendor rate table. The
 * route table in lib/knowledge.js has to price that route from the vendor
 * rate card while every other route keeps its fall-through to
 * `defaultPricing`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRatesFor, GATEWAY_ROUTES, PROVIDER_KNOWLEDGE } from "../lib/knowledge.js";
import { buildStats, costOf, resolvePrice } from "../lib/stats.js";

// Built-in defaults from lib/index.js Config; this machine's profile sets no
// explicit `pricing` rows that could match a route id.
const defaultPricing = {
  inputPerMillion: 0.14,
  outputPerMillion: 0.28,
  cacheReadPerMillion: 0.0028,
  cacheWritePerMillion: 0,
};

/** The pricing array lib/index.js assembles for a set of logged providers. */
const assemble = (providers) => providers.flatMap((provider) => autoRatesFor(provider));

// Routes this machine's ledger reports under provider "bifrost"; all of them
// keep the default card after the new route is registered.
const unchangedRoutes = [
  "opencode-go-custom/deepseek-go",
  "commandcode/deepseek-goat",
  "strata/qwen-strata",
  "openrouter-custom/bunny-free",
];

test("mistral/deepseek-mistral prices at Mistral's documented rates", () => {
  const pricing = assemble(["bifrost"]);
  const price = resolvePrice("mistral/deepseek-mistral", "bifrost", pricing, defaultPricing);
  assert.equal(price.inputPerMillion, 0.3);
  assert.equal(price.cacheReadPerMillion, 0.007);
  assert.equal(price.cacheWritePerMillion, 0);
  assert.equal(price.outputPerMillion, 1.2);
});

test("route cost splits into input / cached input / output at those rates", () => {
  const pricing = assemble(["bifrost"]);
  const sample = {
    provider: "bifrost",
    model: "mistral/deepseek-mistral",
    inputTokens: 1_000_000,
    cacheReadTokens: 2_000_000,
    cacheWriteTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const price = costOf(sample, pricing, defaultPricing);
  assert.ok(Math.abs(price.costInput - 0.3) < 1e-9, `costInput=${price.costInput}`);
  assert.ok(Math.abs(price.costCacheRead - 0.014) < 1e-9, `costCacheRead=${price.costCacheRead}`);
  assert.equal(price.costCacheWrite, 0);
  assert.ok(Math.abs(price.costOutput - 1.2) < 1e-9, `costOutput=${price.costOutput}`);
  assert.ok(Math.abs(price.cost - 1.514) < 1e-9, `cost=${price.cost}`);
});

test("the bare alias deepseek-mistral resolves to the same card", () => {
  const pricing = assemble(["bifrost"]);
  const price = resolvePrice("deepseek-mistral", "bifrost", pricing, defaultPricing);
  assert.deepEqual(
    {
      input: price.inputPerMillion,
      output: price.outputPerMillion,
      cacheRead: price.cacheReadPerMillion,
      cacheWrite: price.cacheWritePerMillion,
    },
    { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
  );
});

test("route rows are scoped to the gateway provider", () => {
  const rows = autoRatesFor("bifrost");
  assert.deepEqual(
    rows.map((row) => row.model).sort(),
    ["deepseek-mistral", "mistral/deepseek-mistral", "opendesign/deepseek-eco", "opendesign/deepseek-opendesign"],
  );
  for (const row of rows) {
    assert.equal(row.provider, "bifrost");
    assert.equal(row.auto, true);
  }
  // A vendor provider never inherits a route id.
  assert.equal(autoRatesFor("mistral").some((row) => row.model.includes("/")), false);
});

test("a Mistral sample of the same model prices identically", () => {
  const pricing = assemble(["mistral"]);
  const price = resolvePrice("deepseek-v4-1-flash-1017", "mistral", pricing, defaultPricing);
  assert.equal(price.inputPerMillion, 0.3);
  assert.equal(price.cacheReadPerMillion, 0.007);
  assert.equal(price.cacheWritePerMillion, 0);
  assert.equal(price.outputPerMillion, 1.2);
});

test("an opendesign provider id prices the vendor's own model ids", () => {
  // Same card as the routes, reached without a gateway: discovery emits one
  // row per knowledge rate for a provider whose models appear in the logs.
  const rows = autoRatesFor("opendesign");
  assert.deepEqual(rows.map((row) => row.model).sort(), ["deepseek-v4.1-flash", "deepseek-v4.1-flash-eco"]);
  for (const row of rows) {
    assert.equal(row.provider, "opendesign");
    assert.equal(row.auto, true);
  }
  const price = resolvePrice("deepseek-v4.1-flash", "opendesign", assemble(["opendesign"]), defaultPricing);
  assert.equal(price.inputPerMillion, 0.15);
  assert.equal(price.outputPerMillion, 0.6);
  assert.equal(price.cacheReadPerMillion, 0.003);
});

test("every registered route names a vendor rate card that prices it", () => {
  for (const [gateway, routes] of Object.entries(GATEWAY_ROUTES)) {
    const pricing = assemble([gateway]);
    for (const [routeId, target] of Object.entries(routes)) {
      const row = PROVIDER_KNOWLEDGE[target.provider]?.rates?.find((rate) => rate.model === target.model);
      assert.notEqual(row, undefined, `${target.provider}/${target.model} has no rate row`);
      // The emitted row carries the LOGGED provider id and the route id, so it
      // matches the samples the gateway writes.
      const emitted = pricing.find((candidate) => candidate.provider === gateway && candidate.model === routeId);
      assert.notEqual(emitted, undefined, `${gateway} has no row for ${routeId}`);
      assert.deepEqual(
        {
          input: emitted.inputPerMillion,
          output: emitted.outputPerMillion,
          cacheRead: emitted.cacheReadPerMillion,
          cacheWrite: emitted.cacheWritePerMillion,
        },
        {
          input: row.inputPerMillion,
          output: row.outputPerMillion,
          cacheRead: row.cacheReadPerMillion,
          cacheWrite: row.cacheWritePerMillion,
        },
        `${gateway}:${routeId}`,
      );
    }
  }
});

test("opendesign routes price from the OpenDesign card on both gateway client ids", () => {
  // Credit dollars: DeepSeek's peak rate x the vendor's Design Plan multiplier
  // (Flash 0.5x, Eco 0.27x), the unit the plan's window caps are quoted in.
  const cards = {
    "opendesign/deepseek-opendesign": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    "opendesign/deepseek-eco": { input: 0.081, output: 0.324, cacheRead: 0.00162, cacheWrite: 0 },
  };
  for (const gateway of ["bifrost", "vision-toolkit-bifrost"]) {
    const pricing = assemble([gateway]);
    for (const [routeId, expected] of Object.entries(cards)) {
      const price = resolvePrice(routeId, gateway, pricing, defaultPricing);
      assert.deepEqual(
        {
          input: price.inputPerMillion,
          output: price.outputPerMillion,
          cacheRead: price.cacheReadPerMillion,
          cacheWrite: price.cacheWritePerMillion,
        },
        expected,
        `${gateway}:${routeId}`,
      );
    }
  }
});

test("other gateway routes still fall through to defaultPricing", () => {
  const pricing = assemble(["bifrost"]);
  for (const model of unchangedRoutes) {
    const price = resolvePrice(model, "bifrost", pricing, defaultPricing);
    assert.deepEqual(
      {
        input: price.inputPerMillion,
        output: price.outputPerMillion,
        cacheRead: price.cacheReadPerMillion,
        cacheWrite: price.cacheWritePerMillion,
      },
      { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      model,
    );
  }
});

test("an unknown route id and an unknown provider both stay on the default card", () => {
  const pricing = assemble(["bifrost"]);
  assert.equal(resolvePrice("no-such-route/alias", "bifrost", pricing, defaultPricing), defaultPricing);
  assert.deepEqual(autoRatesFor("no-such-gateway"), []);
  assert.deepEqual(autoRatesFor("no-such-provider"), []);
});

test("gateway attribution stays on the bifrost bucket", () => {
  const now = Date.now();
  const stats = buildStats(
    [{
      sessionId: "s1",
      cwd: "/w",
      createdAt: now,
      time: now,
      provider: "bifrost",
      model: "mistral/deepseek-mistral",
      turn: 0,
      step: 0,
      inputTokens: 0,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    }],
    assemble(["bifrost"]),
    defaultPricing,
    {},
  );
  assert.equal(stats.byProvider.length, 1);
  assert.equal(stats.byProvider[0].provider, "bifrost");
  // 1000 output tokens at $1.20/M.
  assert.ok(Math.abs(stats.byProvider[0].cost - 0.0012) < 1e-9, `cost=${stats.byProvider[0].cost}`);
});
