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
import { runInNewContext } from "node:vm";
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

// The card itself is the only honest subject. Locating the badge row by text
// accepted a correct-looking child that never runs (an uncalled function, a
// dead JSX call, text inside a comment or a literal) and rejected a
// behaviour-preserving refactor that moved the same child into a helper. These
// tests execute lib/client.js instead: the bundle loads with a stub React, the
// widget mounts through its own apply(), the pill is clicked open, and the plan
// rows the card would paint are read back.

const readClientSource = () =>
  readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const stubDomNode = () => ({
  nodeType: 1,
  id: "",
  style: {},
  dataset: {},
  children: [],
  textContent: "",
  innerHTML: "",
  appendChild(child) {
    this.children.push(child);
    return child;
  },
  remove() {},
  setAttribute() {},
  addEventListener() {},
  removeEventListener() {},
  focus() {},
  click() {},
});

const depsChanged = (previous, next) =>
  previous === null ||
  next === undefined ||
  next.length !== previous.length ||
  next.some((dep, index) => dep !== previous[index]);

/**
 * A React stub with just enough surface for the widget: function and class
 * components, the four hooks the bundle uses, and an element tree kept whole so
 * a rendered child can be read back. Effects run after each pass, so the
 * widget's own query lands in state the way the card's first paint does.
 */
function createReactStub() {
  const Fragment = Symbol("fragment");
  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
    }
  }
  Component.prototype.isReactComponent = {};

  const instances = new Map();
  const classes = new Map();
  const effects = [];
  let current = null;
  let dirty = false;
  let root = null;
  let mounted = null;

  const cell = (make) => {
    const index = current.cursor++;
    if (current.hooks.length <= index) current.hooks[index] = { value: make() };
    return current.hooks[index];
  };

  const react = {
    Fragment,
    Component,
    useState(init) {
      const store = cell(() => (typeof init === "function" ? init() : init));
      return [
        store.value,
        (next) => {
          const value = typeof next === "function" ? next(store.value) : next;
          if (value !== store.value) {
            store.value = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(init) {
      return cell(() => ({ current: init })).value;
    },
    useCallback(fn, deps) {
      const store = cell(() => ({ deps: null, fn }));
      if (depsChanged(store.value.deps, deps)) {
        store.value.fn = fn;
        store.value.deps = deps ?? null;
      }
      return store.value.fn;
    },
    useEffect(fn, deps) {
      const store = cell(() => ({ deps: null }));
      if (depsChanged(store.value.deps, deps)) effects.push(fn);
      store.value.deps = deps ?? null;
    },
  };

  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });

  const renderChildren = (children, path) => {
    const list = Array.isArray(children) ? children.flat(Infinity) : [children];
    return list.map((child, index) => renderNode(child, `${path}.${index}`));
  };

  const renderNode = (element, path) => {
    if (element === null || element === undefined || typeof element === "boolean") return null;
    if (typeof element === "string" || typeof element === "number") return String(element);
    const { type, props } = element;
    if (type === Fragment) {
      return { type: Fragment, props: {}, children: renderChildren(props.children, path) };
    }
    if (typeof type === "string") {
      return { type, props, children: renderChildren(props.children, path) };
    }
    if (typeof type === "function") {
      if (type.prototype && type.prototype.isReactComponent) return renderClass(type, props, `${path}<${type.name}>`);
      return renderFunction(type, props, `${path}<${type.name}>`);
    }
    throw new Error(`the stub renderer met an unsupported element type: ${String(type)}`);
  };

  const renderFunction = (type, props, path) => {
    let instance = instances.get(path);
    if (instance === undefined) {
      instance = { hooks: [], cursor: 0 };
      instances.set(path, instance);
    }
    const previous = current;
    current = instance;
    instance.cursor = 0;
    let output;
    try {
      output = type(props);
    } finally {
      current = previous;
    }
    return renderNode(output, path);
  };

  const renderClass = (type, props, path) => {
    let instance = classes.get(path);
    if (instance === undefined) {
      instance = new type(props);
      classes.set(path, instance);
    }
    instance.props = props;
    try {
      return renderNode(instance.render(), path);
    } catch (error) {
      if (typeof type.getDerivedStateFromError !== "function") throw error;
      instance.state = type.getDerivedStateFromError(error);
      return renderNode(instance.render(), path);
    }
  };

  const settle = async (rounds = 25) => {
    for (let round = 0; round < rounds; round += 1) {
      dirty = false;
      root = renderNode(mounted, "root");
      for (const effect of effects.splice(0, effects.length)) effect();
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) return root;
    }
    throw new Error(`the card did not settle after ${rounds} renders`);
  };

  const find = (node, predicate) => {
    if (node === null || node === undefined || typeof node === "string") return undefined;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
      const hit = find(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const text = (node) => {
    if (node === null || node === undefined) return "";
    if (typeof node === "string") return node;
    return (node.children ?? []).map(text).join("");
  };

  const rows = () =>
    (function collect(node, out) {
      if (node === null || node === undefined || typeof node === "string") return out;
      if (String(node.props?.className ?? "").includes("dsu-planRow")) out.push(text(node));
      for (const child of node.children ?? []) collect(child, out);
      return out;
    })(root, []);

  return {
    react,
    jsxRuntime: { jsx, jsxs: jsx, Fragment },
    createRoot() {
      return {
        render(element) {
          mounted = element;
        },
        unmount() {},
      };
    },
    settle,
    /** Click the pill the way the card opens: its own handler, not a state poke. */
    openCard() {
      const pill = find(root, (node) => node.type === "button" && node.props?.className === "dsu-pill");
      if (pill === undefined) throw new Error("the widget rendered no pill button to open the card");
      pill.props.onClick();
    },
    rows,
  };
}

const cardSnapshot = (providerUsage) => ({
  callCount: 1,
  sessionsScanned: 1,
  refreshSeconds: 30,
  rates: {},
  totals: { cost: 0.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
  byProvider: [],
  byModel: [],
  bySession: [],
  byDay: [],
  byHour: [],
  allCwds: [],
  billing: null,
  budget: null,
  overview: {},
  plans: [
    {
      label: "OpenCode Go",
      provider: "opencode-go",
      type: "code",
      subscription: null,
      tiers: null,
      quotaNote: null,
      limits: [],
      usedPct: 0,
      quotaRequests: null,
      quotaTokens: null,
      remainingRequests: null,
      remainingTokens: null,
      providerUsage,
    },
  ],
});

/** Render the shipped card against one vendor payload and return its plan rows. */
async function renderCard(source, windows, globals = {}) {
  const definitions = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => definitions.push(definition) } },
    document: {
      body: stubDomNode(),
      head: stubDomNode(),
      visibilityState: "visible",
      createElement: stubDomNode,
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
    },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 0,
    clearInterval() {},
    console,
    ...globals,
  };
  runInNewContext(source, sandbox);
  assert.equal(definitions.length, 1, "client.js registers one module definition");

  const stub = createReactStub();
  const requireStub = (name) => {
    if (name === "react") return stub.react;
    if (name === "react/jsx-runtime") return stub.jsxRuntime;
    if (name === "react-dom/client") return { createRoot: stub.createRoot };
    throw new Error(`the bundle required an unexpected module: ${name}`);
  };
  const stocked = definitions[0].factory(requireStub);
  const snapshot = cardSnapshot(normalizeProviderUsage({ usage: windows }, "opencode-go"));
  stocked.apply({
    connection: { rpc: { call: async () => ({ ok: true, value: snapshot }) } },
    locale: {
      register() {},
      // The dictionary's own words are not the subject here: the badge either
      // renders for the rate-limited word or it does not.
      bind: () => (key) => key,
    },
    effect(run) {
      run();
    },
  });
  await stub.settle();
  stub.openCard();
  await stub.settle();
  return stub.rows();
}

const liveWindows = (overrides = {}) => ({
  rolling: { status: "ok", percent: 0 },
  weekly: { status: "rate-limited", percent: 100 },
  monthly: { status: "quota-available", percent: 63 },
  ...overrides,
});

const expectRateLimitedBadge = (rows) => {
  const rolling = rows.filter((row) => row.startsWith("plan.window5h"));
  assert.equal(rolling.length, 1, `the card renders one 5-hour row, got ${JSON.stringify(rows)}`);
  assert.equal(
    rolling[0],
    "plan.window5hplan.usedShort 0%",
    "a 5-hour window the vendor did not limit carries no badge",
  );
  const week = rows.filter((row) => row.startsWith("plan.windowWeek"));
  assert.equal(week.length, 1, `the card renders one 7-day row, got ${JSON.stringify(rows)}`);
  assert.equal(
    week[0],
    "plan.windowWeekplan.usedShort 100% · plan.statusLimited",
    "the spent 7-day row carries the badge",
  );
  const month = rows.filter((row) => row.startsWith("plan.windowMonth"));
  assert.equal(month.length, 1, `the card renders one monthly row, got ${JSON.stringify(rows)}`);
  assert.equal(month[0], "plan.windowMonthplan.usedShort 63%", "only the rate-limited word earns the badge");
};

// The row's own template, verbatim. A fixture that no longer matches the bundle
// fails loudly instead of quietly replacing nothing.
const LIVE_ROW = '`${t("plan.usedShort")} ${livePct}%${planStatusBadge(t, w)}${resetText !== null ? ` · ${t("plan.resetAt")} ${resetText}` : ""}`';

test("the card paints the 7-day row and badges only the rate-limited word", async () => {
  const source = readClientSource();
  expectRateLimitedBadge(await renderCard(source, liveWindows()));
  // The negative half of the discrimination: the same card with the vendor's
  // word absent must show the percent and no badge at all.
  const neutral = await renderCard(
    source,
    liveWindows({ weekly: { status: "ok", percent: 100 } }),
  );
  assert.deepEqual(neutral.filter((row) => row.startsWith("plan.windowWeek")), [
    "plan.windowWeekplan.usedShort 100%",
  ]);
  // The 5-hour row is checked in both directions too: an unrelated window that
  // the vendor does limit earns the same badge, so the row's status is what
  // decides it rather than the row's position in the card.
  const rollingBadged = await renderCard(
    source,
    liveWindows({ rolling: { status: "rate-limited", percent: 0 } }),
  );
  assert.deepEqual(rollingBadged.filter((row) => row.startsWith("plan.window5h")), [
    "plan.window5hplan.usedShort 0% · plan.statusLimited",
  ]);
});

const HELPER_HEAD = "\n\t\tfunction planStatusBadge(t, window) {";
const HELPER_FULL =
  HELPER_HEAD +
  '\n\t\t\treturn window?.vendorStatus === "rate-limited" ? ` · ${t("plan.statusLimited")}` : "";\n\t\t}';

const HELPER_CONDITION = 'window?.vendorStatus === "rate-limited"';
const DECOY_ROW =
  "\n\t\tfunction unusedBadgeRowInTest(t, livePct, w, resetText) {\n" +
  '\t\t\treturn react_jsx_runtime.jsx("b", { children: ' +
  LIVE_ROW +
  " });\n\t\t}";

test("an uncalled jsx decoy cannot stand in for the row the card paints", async () => {
  const source = readClientSource();
  // The decoy is a function that is never called and whose JSX child is the
  // live row template character for character: a check that locates the row by
  // source text finds this one. The rendered card shows it never runs. Every
  // copy of the helper is rewritten, so a duplicate earlier in the file cannot
  // absorb the fixture and leave the live helper untouched.
  const withDecoy = source.replaceAll(HELPER_FULL, HELPER_FULL + DECOY_ROW);
  assert.notEqual(withDecoy, source, "the dead-decoy fixture must apply to client.js");
  expectRateLimitedBadge(await renderCard(withDecoy, liveWindows()));

  // The same fixture over a live helper that degrades to truthiness badges an
  // unfamiliar status, and the check that passed above must fail.
  const broadHelper = withDecoy.replaceAll(HELPER_CONDITION, "window?.vendorStatus");
  assert.notEqual(broadHelper, withDecoy, "the broad-helper fixture must apply to client.js");
  const rows = await renderCard(broadHelper, liveWindows());
  assert.throws(
    () => expectRateLimitedBadge(rows),
    /only the rate-limited word earns the badge/,
    "a truthy live helper badges an unfamiliar vendor status",
  );
});

const ROW_CHILD_HELPER = "children: `${liveUsedText(";

test("a helper-backed row child still renders the badge", async () => {
  // Behaviour-preserving refactor: the same text built by a helper instead of
  // an inline template beside `children:`. A text matcher rejects this; the
  // rendered card must not care.
  const source = readClientSource();
  if (source.includes(ROW_CHILD_HELPER)) {
    // The shipped row already builds its child through a helper.
    expectRateLimitedBadge(await renderCard(source, liveWindows()));
    return;
  }
  // Every copy of the row template is rewritten, so a duplicate — in a comment,
  // a string, or a dead function — cannot absorb the fixture and leave the row
  // the card paints inline. The helper counts its calls, and the card has to
  // reach it: a rewrite that landed anywhere else leaves the count at zero.
  let calls = 0;
  const refactored = source.replaceAll(
    LIVE_ROW,
    "liveUsedText(t, livePct, w, resetText, " + LIVE_ROW + ")",
  );
  assert.notEqual(refactored, source, "the helper-backed fixture must find the row template");
  expectRateLimitedBadge(
    await renderCard(refactored, liveWindows(), {
      liveUsedText: (t, livePct, w, resetText, text) => {
        calls += 1;
        return text;
      },
    }),
  );
  assert.ok(calls > 0, "the card's row child must be built by the helper");
});
