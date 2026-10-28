/**
 * Claude Code subscription quota adapter.
 *
 * Reads Claude Code's stored OAuth credentials (`~/.claude/.credentials.json`,
 * `CLAUDE_CONFIG_DIR` first; read-only) and queries
 * `GET https://api.anthropic.com/api/oauth/usage` (undocumented,
 * reverse-engineered) for the 5-hour / 7-day utilization plus the Opus /
 * Design weekly shares. A 429 replays the last good payload, because the
 * endpoint throttles the dashboard's polling.
 *
 * This adapter never renews that login, by design. Claude Code shares one saved
 * login per machine and coordinates renewal among its own processes through a
 * refresh lock (code.claude.com/docs/en/troubleshoot-install, "Not logged in or
 * token expired"), and renewal rotates the token. A second renewer outside that
 * lock that does not write the new pair back leaves the stored refresh token
 * dead, after which Claude Code clears the saved login and every model request
 * stops with `Login expired · Please run /login`
 * (code.claude.com/docs/en/errors, "Login expired"). So an expired access token
 * here waits for Claude Code's next run instead of being refreshed from under it.
 *
 * Because that wait can last hours (the access token lives 8 h, measured), a
 * lapsed token is not only reported: the adapter asks Claude Code to check its
 * own login (`claude auth status`), which renews under the CLI's lock and
 * rewrites the file when needed (measured: 0.11 s and no rewrite while the
 * token is fresh). The adapter never posts to the token endpoint itself.
 */

import { clampPct, notLoggedIn, request } from "./common.js";

/**
 * Normalize the Claude OAuth usage payload into the widget contract
 * `{ windows, extra, meta }`. Pure function — also exported for tests.
 */
export function normalizeClaudeUsage(raw) {
  const windows = {};
  const five = raw?.five_hour;
  if (five !== undefined && five !== null && Number.isFinite(Number(five.utilization))) {
    windows["5h"] = {
      status: "ok",
      percent: clampPct(five.utilization),
      ...(typeof five.resets_at === "string" && five.resets_at.length > 0 ? { resetsAt: five.resets_at } : {}),
    };
  }
  const seven = raw?.seven_day;
  if (seven !== undefined && seven !== null && Number.isFinite(Number(seven.utilization))) {
    windows["week"] = {
      status: "ok",
      percent: clampPct(seven.utilization),
      ...(typeof seven.resets_at === "string" && seven.resets_at.length > 0 ? { resetsAt: seven.resets_at } : {}),
    };
  }
  const extra = [];
  for (const [rawKey, id] of [["seven_day_opus", "opus"], ["seven_day_omelette", "design"]]) {
    const row = raw?.[rawKey];
    if (row !== undefined && row !== null && Number.isFinite(Number(row.utilization))) {
      extra.push({
        id,
        label: id,
        percent: clampPct(row.utilization),
        ...(typeof row.resets_at === "string" && row.resets_at.length > 0 ? { resetsAt: row.resets_at } : {}),
      });
    }
  }
  const meta = {};
  const extraUsage = raw?.extra_usage;
  if (extraUsage !== undefined && extraUsage !== null && typeof extraUsage === "object") {
    const summary = {};
    if (extraUsage.is_enabled !== undefined) summary.enabled = extraUsage.is_enabled === true;
    if (Number.isFinite(Number(extraUsage.used_credits))) summary.usedCredits = Number(extraUsage.used_credits);
    if (Number.isFinite(Number(extraUsage.monthly_limit))) summary.monthlyLimit = Number(extraUsage.monthly_limit);
    if (typeof extraUsage.currency === "string" && extraUsage.currency.length > 0) summary.currency = extraUsage.currency;
    if (Object.keys(summary).length > 0) meta.extraUsage = summary;
  }
  return { windows, extra, meta };
}

/**
 * Locate Claude Code's stored OAuth credentials (read-only). `expiresAt` is the
 * access token's own deadline, in milliseconds; 0 or absent means the file
 * carries none, and the usage request decides.
 */
async function claudeAuth(io) {
  const candidates = [
    typeof io.env.CLAUDE_CONFIG_DIR === "string" && io.env.CLAUDE_CONFIG_DIR.length > 0 ? `${io.env.CLAUDE_CONFIG_DIR}/.credentials.json` : undefined,
    `${io.home}/.claude/.credentials.json`,
  ].filter(Boolean);
  for (const path of candidates) {
    const text = await io.readText(path);
    if (text === undefined || text.length === 0) continue;
    try {
      const payload = JSON.parse(text);
      const oauth = payload?.claudeAiOauth ?? payload?.oauthAccount ?? null;
      const accessToken = oauth?.accessToken ?? oauth?.oauthToken ?? undefined;
      if (typeof accessToken === "string" && accessToken.length > 0) {
        const expiresAt = Number(oauth?.expiresAt);
        return { accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
      }
    } catch {
      // malformed credential file — try the next location
    }
  }
  throw notLoggedIn("not logged in: no Claude credentials (~/.claude/.credentials.json); run `claude` once");
}

/** GET the Claude OAuth usage payload; throws `AUTH` for 401/403. */
async function claudeUsage(io, accessToken) {
  if (typeof accessToken !== "string" || accessToken.length === 0) throw Object.assign(new Error("missing access token"), { code: "AUTH" });
  const res = await request("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`auth rejected (HTTP ${res.status})`), { code: "AUTH" });
  if (res.status === 429) throw Object.assign(new Error("rate limited by Claude (HTTP 429)"), { code: "RATE_LIMIT" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.json === undefined || typeof res.json !== "object") throw new Error("invalid response");
  return res.json;
}

/**
 * Claude's usage endpoint is rate limited hard: one poll per minute or so gets
 * HTTP 429 for minutes at a time, and the Claude Code CLI competes for the same
 * per-account budget. The dashboard polls every `refreshSeconds`, so this
 * adapter keeps the last payload and only asks Anthropic once per interval;
 * a rate-limited poll replays the cached payload (with its real fetch time)
 * instead of blanking the card. Measured 2026-10-26: alternating 200/429 at one
 * request per minute.
 */
const CACHE_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Beyond this age the cached payload is too old to present as live data. */
const CACHE_MAX_STALE_MS = 60 * 60 * 1000;
/** First wait after a failed poll, doubled per consecutive failure. */
const BACKOFF_START_MS = 60 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
/**
 * A lapsed token is handed back to Claude Code, one check per cooldown at
 * most, so a CLI that cannot renew cannot turn the card's 30 s poll into a
 * spawn loop.
 */
const OWNER_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
/** Where the CLI is installed; the first entry is resolved through PATH. */
const CLAUDE_BINARIES = ["claude", ".local/bin/claude", ".npm-global/bin/claude"];

let cache = null;
let retryAt = 0;
let backoffMs = 0;
let lastError = null;
let ownerCheckAt = 0;

/** Drop the in-memory cache (tests; a credential change makes it moot). */
export function resetClaudeUsageCache() {
  cache = null;
  retryAt = 0;
  backoffMs = 0;
  lastError = null;
  ownerCheckAt = 0;
}

/** Payload replay that keeps the card's "updated" line honest. */
function replay(cached) {
  return { ...cached.data, fetchedAt: cached.at };
}

/** Ask Claude Code to check (and, when lapsed, renew) its own saved login. */
async function askClaudeToCheckLogin(io) {
  if (typeof io.run !== "function") return;
  if (Date.now() - ownerCheckAt < OWNER_CHECK_COOLDOWN_MS) return;
  ownerCheckAt = Date.now();
  for (const candidate of CLAUDE_BINARIES) {
    const bin = candidate.includes("/") ? `${io.home}/${candidate}` : candidate;
    try {
      await io.run(bin, ["auth", "status"], 20000);
      return;
    } catch (error) {
      // Only a missing binary is worth another candidate; any other failure
      // means the CLI ran and declined, and the stale token will say so.
      if (error?.code !== "ENOENT") return;
    }
  }
}

/** Fetch the Claude quota through the adapter I/O context. */
export async function claudeFetch(io, endpoint) {
  // A lapsed token goes back to its owner: the CLI renews it under its own
  // lock, and the adapter only re-reads the file afterwards.
  let auth = await claudeAuth(io);
  const cached = cache !== null && cache.token === auth.accessToken ? cache : null;
  if (cached !== null && Date.now() - cached.at < CACHE_MIN_INTERVAL_MS) return replay(cached);
  if (auth.expiresAt > 0 && auth.expiresAt <= Date.now()) {
    await askClaudeToCheckLogin(io);
    auth = await claudeAuth(io);
    if (auth.expiresAt > 0 && auth.expiresAt <= Date.now()) {
      throw notLoggedIn(
        "Claude Code access token expired; it renews on the next claude run (dsh-spend never renews the shared login)",
      );
    }
  }
  const now = Date.now();
  if (now < retryAt) {
    if (cached !== null && now - cached.at < CACHE_MAX_STALE_MS) return replay(cached);
    throw lastError ?? Object.assign(new Error("rate limited by Claude (HTTP 429)"), { code: "RATE_LIMIT" });
  }
  let json;
  try {
    json = await claudeUsage(io, auth.accessToken);
  } catch (error) {
    backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
    retryAt = Date.now() + backoffMs;
    lastError = error;
    // A throttled poll keeps the numbers the card already had; anything else
    // (logout, network down) must surface, because stale data would hide it.
    const throttled = error?.code === "RATE_LIMIT" && cached !== null && Date.now() - cached.at < CACHE_MAX_STALE_MS;
    if (throttled) return replay(cached);
    throw error;
  }
  const data = normalizeClaudeUsage(json);
  cache = { token: auth.accessToken, at: Date.now(), data };
  retryAt = 0;
  backoffMs = 0;
  lastError = null;
  return replay(cache);
}