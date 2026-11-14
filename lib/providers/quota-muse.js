/**
 * Muse Ember (Meta Muse Code subscription) allowance adapter.
 *
 * The `muse` CLI owns the login, so the adapter asks the CLI rather than the
 * vendor HTTP API: `muse usage --json` prints one object holding the rolling
 * 5-hour window and the weekly window as `{ usedPercent, resetsAtMs }`, plus
 * the plan tier. The adapter runs that command and reads its stdout; it never
 * opens the CLI's credential file, never posts a refresh, and never touches a
 * provider key (same rule as the Codex and Claude Code adapters — the shared
 * login stays in the CLI's hands).
 *
 * Measured 2026-11-14 on Muse Code 1.4.18: one call takes about 2.5 s and
 * prints `{"allowance":{"asOfMs":…,"source":"mint","tier":"…","weekly":{…},
 * "window":{…}},"hint":null,"reason":null,"schemaVersion":1}`. When Meta
 * throttles the plan, `allowance` stays present and `hint`/`reason` carry the
 * vendor's notice.
 */

import { clampPct, isoFromUnixMs, notLoggedIn } from "./common.js";

/** Where the CLI is installed; the first entry is resolved through PATH. */
const MUSE_BINARIES = ["muse", ".local/bin/muse", ".npm-global/bin/muse"];
/** One `muse usage` call measures ~2.5 s; the ceiling leaves room for a slow host. */
const CLI_TIMEOUT_MS = 15000;

/**
 * Normalize the CLI's allowance object into the widget contract
 * `{ windows, extra, meta }`. Pure function — also exported for tests.
 */
export function normalizeMuseUsage(raw) {
  const allowance = raw?.allowance ?? {};
  const windows = {};
  const window = allowance.window;
  if (window !== undefined && window !== null && Number.isFinite(Number(window.usedPercent))) {
    windows["5h"] = {
      status: "ok",
      percent: clampPct(window.usedPercent),
      ...(isoFromUnixMs(window.resetsAtMs) !== undefined ? { resetsAt: isoFromUnixMs(window.resetsAtMs) } : {}),
    };
  }
  const weekly = allowance.weekly;
  if (weekly !== undefined && weekly !== null && Number.isFinite(Number(weekly.usedPercent))) {
    windows.week = {
      status: "ok",
      percent: clampPct(weekly.usedPercent),
      ...(isoFromUnixMs(weekly.resetsAtMs) !== undefined ? { resetsAt: isoFromUnixMs(weekly.resetsAtMs) } : {}),
    };
  }
  const meta = {};
  if (typeof allowance.tier === "string" && allowance.tier.length > 0) meta.plan = allowance.tier;
  return { windows, extra: [], meta };
}

/** Parse the CLI's stdout, turning a malformed payload into a readable error. */
function parseAllowance(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) throw new Error("muse usage printed nothing");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`muse usage returned unparseable output: ${text.slice(0, 200)}`);
  }
  if (payload?.allowance === undefined || payload.allowance === null) {
    const reason = typeof payload?.reason === "string" && payload.reason.length > 0 ? payload.reason : "no allowance in the reply";
    throw notLoggedIn(`muse CLI reported no allowance (${reason}); run \`muse login\` first`);
  }
  return payload;
}

/** Run the CLI once and resolve to its parsed allowance; throws otherwise. */
async function runMuse(io) {
  if (typeof io.run !== "function") throw new Error("the Muse adapter needs the CLI runner");
  let missing = true;
  for (const candidate of MUSE_BINARIES) {
    const bin = candidate.includes("/") ? `${io.home}/${candidate}` : candidate;
    let result;
    try {
      result = await io.run(bin, ["usage", "--json"], CLI_TIMEOUT_MS);
    } catch (error) {
      // Only a missing binary is worth another candidate.
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    if (result?.code !== 0) {
      throw notLoggedIn(
        `muse usage exited ${result?.code}; run \`muse login\` (dsh-spend never renews the shared login)`,
      );
    }
    missing = false;
    return parseAllowance(result?.stdout);
  }
  if (missing) throw notLoggedIn("muse CLI not found; install it or put it on PATH");
  throw notLoggedIn("muse CLI not found; install it or put it on PATH");
}

/** Fetch the Muse Ember allowance through the adapter I/O context. */
export async function museUsageFetch(io, endpoint) {
  return normalizeMuseUsage(await runMuse(io));
}
