/**
 * Aggregation tests: canonical provider-id matching in plan accounting
 * (regression coverage for #10 — usage reported under an alias must land
 * in the plan card and count toward the token-plan used cost).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { buildStats, computeSignature, normalizeProviderUsage, scanSessions } from "../lib/stats.js";

const now = Date.now();
const Flash = {
  model: "deepseek-v4-flash",
  inputPerMillion: 1,
  outputPerMillion: 1,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
};
const sample = (provider, model = "deepseek-v4-flash", outputTokens = 1000) => ({
  sessionId: "s1",
  cwd: "/w",
  createdAt: now,
  time: now,
  provider,
  model,
  turn: 0,
  step: 0,
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

test("token plan: alias-reported usage lands on the canonical plan card", () => {
  const stats = buildStats([sample("deepseek-official")], [Flash], {}, {
    plans: [{ provider: "deepseek", type: "token", balance: 100 }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "deepseek");
  assert.equal(stats.plans[0].type, "token");
  // 1000 output tokens at $1/M → $0.001, counted through the alias.
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.001) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
  assert.ok(Math.abs(stats.plans[0].remaining - (100 - 0.001)) < 1e-9);
});

test("token plan: usage from BOTH spellings of one provider adds up once", () => {
  const stats = buildStats(
    [sample("deepseek-official", "deepseek-v4-flash", 1000), sample("deepseek", "deepseek-v4-flash", 1000)],
    [Flash],
    {},
    { plans: [{ provider: "deepseek", type: "token", balance: 100 }] },
  );
  assert.equal(stats.plans.length, 1);
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.002) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
});

test("code plan: quota windows accumulate alias-reported usage", () => {
  const stats = buildStats([sample("glm"), sample("glm")], [], {}, {
    plans: [{ provider: "zhipu", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "zhipu");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("non-alias providers keep their exact match behavior", () => {
  const stats = buildStats([sample("opencode-go"), sample("opencode-go")], [], {}, {
    plans: [{ provider: "opencode-go", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "opencode-go");
  assert.equal(stats.plans[0].usedRequests, 2);
});

test("minimax-cn alias usage lands on the minimax code plan windows", () => {
  const stats = buildStats([sample("minimax-cn"), sample("minimax-cn")], [], {}, {
    plans: [{ provider: "minimax", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "minimax");
  assert.equal(stats.plans[0].type, "code");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("scanSessions streams zstd frames and reuses unchanged durable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-stats-"));
  const sessionDir = join(root, "workspace", "s1");
  const file = join(sessionDir, "session.jsonl.zstd");
  const now = Date.now();
  const writeSession = async (outputTokens) => {
    const frames = [
      [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
      ],
      [
        { type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "usage", usage: { outputTokens: outputTokens - 1 } } } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens } } },
      ],
    ];
    await writeFile(
      file,
      Buffer.concat(frames.map((events) => zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)))),
    );
  };

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeSession(2);
    const fileCache = new Map();
    const first = await scanSessions(root, [], fileCache);
    assert.equal(first.totalSessions, 1);
    assert.equal(first.decodeErrors, 0);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].outputTokens, 2);

    const reused = await scanSessions(root, [], fileCache);
    assert.deepEqual(reused.calls, first.calls);
    assert.equal(fileCache.size, 1);

    await writeSession(3);
    const changedAt = new Date(Date.now() + 2000);
    await utimes(file, changedAt, changedAt);
    const updated = await scanSessions(root, [], fileCache);
    assert.equal(updated.totalSessions, 1);
    assert.equal(updated.decodeErrors, 0);
    assert.equal(updated.calls.length, 1);
    assert.equal(updated.calls[0].outputTokens, 3);

    // A live session already owns the complete event snapshot. Its durable
    // file may still be mid-write, so the scanner must not decode it again.
    await writeFile(file, Buffer.from("incomplete zstd frame"));
    const live = await scanSessions(root, [{
      id: "s1",
      events: [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens: 4 } } },
      ],
      header: { cwd: "/workspace", createdAt: now },
    }], fileCache);
    assert.equal(live.totalSessions, 1);
    assert.equal(live.decodeErrors, 0);
    assert.equal(live.calls.length, 1);
    assert.equal(live.calls[0].outputTokens, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanSessions reads every session-format generation and prefers the current one", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-format-"));
  const now = Date.now();
  const logFrame = (id, outputTokens) => zstdCompressSync(Buffer.from(`${[
    { type: "session", id, cwd: "/workspace", createdAt: now },
    { type: "request/header", data: { header: { config: { provider: "bifrost", model: "commandcode/deepseek-goat" } } } },
    { type: "step/start", data: { turn: 0, step: 0 } },
    { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens } } },
  ].map((event) => JSON.stringify(event)).join("\n")}\n`));
  const currentFile = join(root, "workspace", "current", "session.v4.jsonl.zstd");
  const legacyFile = join(root, "workspace", "legacy", "session.jsonl.zstd");
  const bothDir = join(root, "workspace", "both");

  try {
    await mkdir(join(root, "workspace", "current"), { recursive: true });
    await mkdir(join(root, "workspace", "legacy"), { recursive: true });
    await mkdir(bothDir, { recursive: true });
    // The store DSH writes today: generation four carries the `vN` component.
    await writeFile(currentFile, logFrame("current", 2));
    // Generation zero keeps the suffix-only name; existing history must survive.
    await writeFile(legacyFile, logFrame("legacy", 3));
    // A directory that somehow holds both generations yields the current one only.
    await writeFile(join(bothDir, "session.jsonl.zstd"), logFrame("both", 4));
    await writeFile(join(bothDir, "session.v4.jsonl.zstd"), logFrame("both", 5));

    const scanned = await scanSessions(root, []);
    assert.equal(scanned.totalSessions, 3);
    assert.equal(scanned.decodeErrors, 0);
    assert.deepEqual(
      scanned.calls.map((call) => [call.sessionId, call.outputTokens]).sort(),
      [["both", 5], ["current", 2], ["legacy", 3]],
    );

    // Fingerprint must track the current generation too: a rewrite of the
    // generation-four file has to invalidate the cached snapshot.
    const before = await computeSignature(root, []);
    await writeFile(currentFile, logFrame("current", 6));
    const touchedAt = new Date(Date.now() + 2000);
    await utimes(currentFile, touchedAt, touchedAt);
    assert.notEqual(await computeSignature(root, []), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session-model rows keep the costliest rows inside the configured cap", () => {
  // Regression: uncapped, this section was 976 KB of the 1118 KB snapshot that
  // the pill re-fetches every refresh interval on a store of ~2900 sessions.
  const calls = Array.from({ length: 5 }, (_, index) => ({
    ...sample("deepseek-official", "deepseek-v4-flash", 1000 * (index + 1)),
    sessionId: `s${index}`,
  }));
  const capped = buildStats(calls, [Flash], {}, { maxSessionModelRows: 2 });
  assert.equal(capped.bySessionModel.length, 2);
  assert.deepEqual(capped.bySessionModel.map((row) => row.sessionId), ["s4", "s3"]);
  // The total is what the details view uses to say the table is a top slice.
  assert.equal(capped.sessionModelTotal, 5);
  // The default cap leaves a small store untouched.
  assert.equal(buildStats(calls, [Flash], {}, {}).bySessionModel.length, 5);
});

test("a rate-limited vendor window stays on the card with its percent", () => {
  // OpenCode Go answers `status: "rate-limited"` for a window whose allowance
  // is spent. The card renders only rows whose status is "ok", so that row
  // disappeared exactly when it mattered; the row must stay and the vendor's
  // own word must ride along for display.
  const usage = normalizeProviderUsage(
    {
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-11-13T15:26:46.149Z" },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-16T00:00:00.000Z" },
        monthly: { status: "ok", percent: 63, resetsAt: "2026-12-07T12:55:20.000Z" },
      },
    },
    "opencode-go",
  );
  assert.deepEqual(Object.keys(usage.windows), ["5h", "week", "month"]);
  assert.deepEqual(usage.windows.week, {
    status: "ok",
    percent: 100,
    vendorStatus: "rate-limited",
    resetsAt: "2026-11-16T00:00:00.000Z",
  });
  assert.equal(usage.windows["5h"].vendorStatus, undefined);
});

test("a window with no percent keeps its vendor status and no measurement", () => {
  const usage = normalizeProviderUsage(
    { usage: { weekly: { status: "error", percent: null } } },
    "opencode-go",
  );
  assert.deepEqual(usage.windows.week, { status: "error", percent: null });
});

test("a measured window with no status invents no vendor word", () => {
  // An absent status is not evidence that the vendor limited the window, so
  // the card must not claim it did.
  const usage = normalizeProviderUsage({ usage: { weekly: { percent: 50 } } }, "opencode-go");
  assert.deepEqual(usage.windows.week, { status: "ok", percent: 50 });
  assert.equal(usage.windows.week.vendorStatus, undefined);
});

test("an unfamiliar vendor status rides along without the limited badge", () => {
  const usage = normalizeProviderUsage(
    { usage: { weekly: { status: "quota-available", percent: 50 } } },
    "opencode-go",
  );
  assert.equal(usage.windows.week.vendorStatus, "quota-available");
  assert.notEqual(usage.windows.week.vendorStatus, "rate-limited");
});

// The renderer lives in the shipped client bundle, which exports nothing, so the
// badge is a named helper and these tests run the code itself. Comments are
// stripped before matching, because a comment carrying a correct-looking helper
// or row expression would otherwise satisfy a check whose subject is live code.
function withoutComments(source) {
  let out = "";
  let at = 0;
  const length = source.length;

  function lineComment() {
    while (at < length && source[at] !== "\n") at++;
  }

  function blockComment() {
    out += " ";
    at += 2;
    while (at < length && !(source[at] === "*" && source[at + 1] === "/")) {
      if (source[at] === "\n") out += "\n";
      at++;
    }
    at += 2;
  }

  function quoted(quote) {
    out += source[at++];
    while (at < length) {
      if (source[at] === "\\") {
        out += source[at] + (source[at + 1] ?? "");
        at += 2;
        continue;
      }
      const char = source[at++];
      out += char;
      if (char === quote) return;
    }
  }

  function template() {
    out += source[at++];
    while (at < length) {
      if (source[at] === "\\") {
        out += source[at] + (source[at + 1] ?? "");
        at += 2;
        continue;
      }
      if (source[at] === "`") {
        out += source[at++];
        return;
      }
      if (source[at] === "$" && source[at + 1] === "{") {
        out += "${";
        at += 2;
        code(true);
        out += "}";
        continue;
      }
      out += source[at++];
    }
  }

  function code(inTemplateExpression) {
    let depth = 0;
    while (at < length) {
      const char = source[at];
      if (char === "/" && source[at + 1] === "/") {
        lineComment();
        continue;
      }
      if (char === "/" && source[at + 1] === "*") {
        blockComment();
        continue;
      }
      if (char === '"' || char === "'") {
        quoted(char);
        continue;
      }
      if (char === "`") {
        template();
        continue;
      }
      if (inTemplateExpression) {
        if (char === "{") depth++;
        else if (char === "}") {
          if (depth === 0) {
            at++;
            return;
          }
          depth--;
        }
      }
      out += char;
      at++;
    }
  }

  code(false);
  return out;
}

const badgeDefinitions = (code) => [
  ...code.matchAll(/\n\t\tfunction planStatusBadge\(([^)]*)\) \{([\s\S]*?)\n\t\t\}/g),
];

const badgeCalls = (code) => [...code.matchAll(/\$\{\s*planStatusBadge\(t, w\)\s*\}/g)];

const readClientCode = () =>
  withoutComments(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));

test("the card shows the limited badge only for the rate-limited word", () => {
  // A condition that degrades to truthiness fails on behaviour, not on wording.
  const code = readClientCode();
  const definitions = badgeDefinitions(code);
  assert.equal(definitions.length, 1, "client.js must define planStatusBadge exactly once");
  const [definition] = definitions;
  const badge = new Function(...definition[1].split(",").map((name) => name.trim()), definition[2]);
  const t = (key) => key;
  assert.equal(badge(t, { vendorStatus: "rate-limited" }), " · plan.statusLimited");
  for (const window of [
    {},
    { vendorStatus: undefined },
    { vendorStatus: null },
    { vendorStatus: "" },
    { vendorStatus: "ok" },
    { vendorStatus: "quota-available" },
  ]) {
    assert.equal(badge(t, window), "", `no badge for ${JSON.stringify(window)}`);
  }
  const calls = badgeCalls(code);
  assert.equal(calls.length, 1, "the live window row must render through the helper exactly once");
  const lineStart = code.lastIndexOf("\n", calls[0].index) + 1;
  const rowLine = code.slice(lineStart, code.indexOf("\n", calls[0].index));
  assert.match(rowLine, /plan\.usedShort/, "the helper call sits in the live usage row");
});

test("a comment cannot stand in for the badge code", () => {
  // The extraction above reads source text, so a comment carrying a correct
  // helper or row expression must not count as the code that runs. This builds
  // that decoy: a broad active helper with a correct-looking one commented out
  // above it, and a row that suffixes the badge inline with the helper call in a
  // trailing comment.
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const decoy = source
    .replace(
      '\n\t\tfunction planStatusBadge(t, window) {\n\t\t\treturn window?.vendorStatus === "rate-limited" ? ',
      '\n\t\t/* function planStatusBadge(t, window) { return window.vendorStatus ? " · decoy" : ""; } */\n\t\tfunction planStatusBadge(t, window) {\n\t\t\treturn window.vendorStatus ? ',
    )
    .replace(
      "${planStatusBadge(t, w)}",
      '${w.vendorStatus ? ` · ${t("plan.statusLimited")}` : ""} /* planStatusBadge(t, w) */',
    );
  assert.notEqual(decoy, source, "the decoy fixture must differ from client.js");

  const code = withoutComments(decoy);
  const definitions = badgeDefinitions(code);
  assert.equal(definitions.length, 1, "only the active definition counts");
  const badge = new Function(
    ...definitions[0][1].split(",").map((name) => name.trim()),
    definitions[0][2],
  );
  assert.equal(
    badge((key) => key, { vendorStatus: "quota-available" }),
    " · plan.statusLimited",
    "the extracted definition is the active broad one, so the badge test fails on this decoy",
  );
  assert.equal(badgeCalls(code).length, 0, "the row's comment must not satisfy the call-site check");
});
