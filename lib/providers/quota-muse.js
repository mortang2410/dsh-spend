/**
 * Muse Ember (Meta Muse Code subscription) allowance adapter.
 *
 * The `muse` CLI owns the login, so the adapter asks the CLI rather than the
 * vendor HTTP API: `muse usage --json` prints one object holding the rolling
 * 5-hour window and the weekly window as `{ usedPercent, resetsAtMs }`, plus
 * the plan tier. The adapter runs that command and reads its stdout; it never
 * opens the CLI's credential file, never asks the CLI to sign in, and never
 * touches a provider key. Whether the CLI renews its own credential internally
 * is the CLI's business and is not observable from here.
 *
 * The child process gets a minimal environment (PATH, HOME, XDG dirs, locale,
 * TMPDIR) instead of the plugin's whole `process.env`, so a provider key that a
 * future deployment happens to export can never be handed to a subprocess.
 *
 * Nothing from the CLI's output is copied into an error message: a malformed
 * reply or a vendor `reason` is reported by category, because the plan card
 * renders whatever error text it is given.
 *
 * Measured 2026-11-14 on Muse Code 1.4.18: one call takes about 2.5 s and
 * prints `{"allowance":{"asOfMs":…,"source":"mint","tier":"…","weekly":{…},
 * "window":{…}},"hint":null,"reason":null,"schemaVersion":1}`.
 */

import { clampPct, isoFromUnixMs, notLoggedIn } from "./common.js";

/** Where the CLI is installed; the first entry is resolved through PATH. */
const MUSE_BINARIES = ["muse", ".local/bin/muse", ".npm-global/bin/muse"];
/** One `muse usage` call measures ~2.5 s; the ceiling leaves room for a slow host. */
const CLI_TIMEOUT_MS = 15000;
/** Environment variables the CLI needs to find its config, locale and temp dir. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
];

/** The child's environment: only the allowlisted names the host actually sets. */
export function museChildEnv(env) {
  const out = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

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

/**
 * Classify the vendor's reason into one of a few fixed phrases. The reason is
 * never echoed: a token pasted into that field would otherwise be rendered by
 * the plan card, and character filtering does not stop a token, because a token
 * is made of ordinary word characters.
 */
export function reasonHint(reason) {
  const text = typeof reason === "string" ? reason.toLowerCase() : "";
  if (text.length === 0) return undefined;
  if (text.includes("expired")) return "session expired";
  if (text.includes("login") || text.includes("sign in") || text.includes("auth") || text.includes("token")) {
    return "not signed in";
  }
  if (text.includes("limit") || text.includes("quota") || text.includes("throttl")) return "plan limited";
  return undefined;
}

/** Parse the CLI's stdout without ever echoing it into an error. */
function parseAllowance(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) throw new Error("muse usage printed no output");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // The reply is not JSON: report the shape, never the bytes.
    throw new Error(`muse usage returned ${text.length} bytes that are not JSON`);
  }
  if (payload?.allowance === undefined || payload.allowance === null) {
    const reason = reasonHint(payload?.reason);
    throw notLoggedIn(
      reason === undefined
        ? "muse CLI reported no allowance; run `muse login` first"
        : `muse CLI reported no allowance (${reason}); run \`muse login\` first`,
    );
  }
  return payload;
}

/** Run the CLI once and resolve to its parsed allowance; throws otherwise. */
async function runMuse(io) {
  if (typeof io.run !== "function") throw new Error("the Muse adapter needs the CLI runner");
  const env = museChildEnv(io.env);
  for (const candidate of MUSE_BINARIES) {
    const bin = candidate.includes("/") ? `${io.home}/${candidate}` : candidate;
    let result;
    try {
      result = await io.run(bin, ["usage", "--json"], CLI_TIMEOUT_MS, { env });
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
    return parseAllowance(result?.stdout);
  }
  throw notLoggedIn("muse CLI not found; install it or put it on PATH");
}

/** Fetch the Muse Ember allowance through the adapter I/O context. */
export async function museUsageFetch(io, endpoint) {
  return normalizeMuseUsage(await runMuse(io));
}
