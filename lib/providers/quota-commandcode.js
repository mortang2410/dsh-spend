/**
 * Command Code (commandcode.ai) plan quota adapter.
 *
 * Endpoints (undocumented — `alpha` is the vendor's own "this may move"
 * marker, and these are the same read-only calls the official `cmd` CLI's
 * `/usage` display makes, so polling them spends no credits):
 *   GET https://api.commandcode.ai/alpha/billing/credits   — the rolling
 *       5-hour and weekly spend windows (`used` / `cap` in credit dollars +
 *       `resetAt` in ms) and the remaining monthly credit balance.
 *   GET https://api.commandcode.ai/alpha/usage/summary     — billed cost for
 *       the current billing period, used to derive the monthly window.
 *
 * Auth is the Command Code API key (the same key the CLI and the Provider API
 * use) as a Bearer token. It is resolved through the credentials seam as
 * `COMMANDCODE_API_KEY`, then from the CLI's own login file
 * (`~/.commandcode/auth.json`, written by `cmd login`, read-only). The
 * Provider API itself publishes no usage route, so this alpha surface is the
 * only programmatic source of the plan windows.
 */

import { clampPct, isoFromUnixMs, notLoggedIn, numOr, request, resolveBearerKey } from "./common.js";

/** Default credential seam / env name. */
export const COMMANDCODE_KEY_ENV = "COMMANDCODE_API_KEY";

/** Default credits endpoint (undocumented, used by the official CLI). */
export const COMMANDCODE_CREDITS_URL = "https://api.commandcode.ai/alpha/billing/credits";

/** Default billing-period summary endpoint (undocumented, same CLI). */
export const COMMANDCODE_SUMMARY_URL = "https://api.commandcode.ai/alpha/usage/summary";

/**
 * The alpha routes sit behind a CDN that rejects some bare client
 * signatures, so the adapter identifies itself instead of sending the
 * runtime's default agent.
 */
const COMMANDCODE_USER_AGENT = "dsh-spend";

/** Window key per vendor field under `windowLimits`. */
const COMMANDCODE_WINDOW = { fiveHour: "5h", weekly: "week" };

/**
 * Normalize the `/alpha/billing/credits` payload (plus the optional
 * `/alpha/usage/summary` payload) into the widget usage contract
 * `{ windows, extra, meta }`. Percent is what the window has USED of its cap,
 * which is how the vendor reports it (`used` / `cap` in credit dollars).
 *
 * The monthly row is derived: the monthly balance the API reports is what is
 * LEFT, so the period's grant is `monthlyCredits + billed` and the used
 * percent is `billed / grant`. That identity only holds while nothing outside
 * the monthly pool was spent, so the row is dropped when purchased or free
 * credits are in play — a derived-but-wrong percentage is worse than no row.
 * Pure function.
 */
export function normalizeCommandcodeUsage(credits, summary) {
  const windows = {};
  const limits = credits?.windowLimits;
  if (limits !== null && typeof limits === "object") {
    for (const [field, key] of Object.entries(COMMANDCODE_WINDOW)) {
      const row = limits[field];
      if (row === null || typeof row !== "object") continue;
      const used = numOr(row.used);
      const cap = numOr(row.cap);
      if (used === null || cap === null || cap <= 0) continue;
      const resetsAt = isoFromUnixMs(row.resetAt);
      windows[key] = {
        status: "ok",
        percent: clampPct((used / cap) * 100),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      };
    }
  }
  const remaining = numOr(credits?.credits?.monthlyCredits);
  const purchased = numOr(credits?.credits?.purchasedCredits) ?? 0;
  const free = numOr(credits?.credits?.freeCredits) ?? 0;
  const billed = numOr(summary?.totalCost);
  if (remaining !== null && billed !== null && purchased === 0 && free === 0) {
    const grant = remaining + billed;
    if (grant > 0) windows.month = { status: "ok", percent: clampPct((billed / grant) * 100) };
  }
  return { windows, extra: [], meta: {} };
}

/**
 * Read the API key from the CLI's own login file (`cmd login`):
 * `{ apiKey }`, `{ commandcode: { access } }` and
 * `{ "command-code": { key } }` are all shapes the CLI has written.
 * Returns undefined when the file is absent or holds no usable key.
 */
async function commandcodeCliKey(io) {
  const path = `${io.home}/.commandcode/auth.json`;
  const text = await io.readText(path);
  if (typeof text !== "string" || text.length === 0) return undefined;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  const candidates = [
    payload?.apiKey,
    payload?.commandcode?.access,
    payload?.commandcode?.apiKey,
    payload?.["command-code"]?.key,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Resolve the Bearer key: seam/env first, then the CLI login file. */
async function commandcodeKey(io, endpoint) {
  const envName = endpoint?.apiKeyEnv ?? COMMANDCODE_KEY_ENV;
  try {
    return await resolveBearerKey(io, envName);
  } catch (error) {
    // An explicit `apiKeyEnv` override must surface its own missing-key error
    // rather than silently reading a different credential.
    if (endpoint?.apiKeyEnv !== undefined) throw error;
  }
  const fromCli = await commandcodeCliKey(io);
  if (fromCli !== undefined) return fromCli;
  throw notLoggedIn(`API key not configured (${envName}); run \`cmd login\` or add the key to the credentials seam`);
}

/** One authenticated JSON GET; throws on 401/403 or a non-200 status. */
async function commandcodeGet(url, key, timeoutMs) {
  const res = await request(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": COMMANDCODE_USER_AGENT,
    },
    timeoutMs: timeoutMs ?? 15000,
  });
  if (res.status === 401 || res.status === 403) throw notLoggedIn(`API key rejected (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.json === undefined || typeof res.json !== "object") throw new Error("invalid response");
  return res.json;
}

/** Fetch the Command Code plan quota through the adapter I/O context. */
export async function commandcodeUsageFetch(io, endpoint) {
  const key = await commandcodeKey(io, endpoint);
  const timeoutMs = endpoint?.timeoutMs ?? 15000;
  const credits = await commandcodeGet(endpoint?.url ?? COMMANDCODE_CREDITS_URL, key, timeoutMs);
  if (credits.success === false) throw new Error(credits.error?.message ?? "credits API error");
  // The monthly row is a nice-to-have: a failed summary call must not take the
  // vendor-reported 5-hour and weekly windows down with it.
  let summary;
  try {
    summary = await commandcodeGet(COMMANDCODE_SUMMARY_URL, key, timeoutMs);
  } catch {
    summary = undefined;
  }
  const usage = normalizeCommandcodeUsage(credits, summary);
  if (Object.keys(usage.windows).length === 0) throw new Error("no usage windows");
  return usage;
}
