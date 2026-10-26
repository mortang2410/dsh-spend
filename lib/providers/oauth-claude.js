/**
 * Claude Code subscription quota adapter.
 *
 * Reads Claude Code's stored OAuth credentials (`~/.claude/.credentials.json`,
 * `CLAUDE_CONFIG_DIR` first; read-only) and queries
 * `GET https://api.anthropic.com/api/oauth/usage` (undocumented,
 * reverse-engineered) for the 5-hour / 7-day utilization plus the Opus /
 * Design weekly shares. A 401 triggers one OAuth refresh through
 * `platform.claude.com/v1/oauth/token` before failing; a 429 replays the last
 * good payload, because the endpoint throttles the dashboard's polling.
 */

import { clampPct, notLoggedIn, request } from "./common.js";

/** Claude Code OAuth client id (public in Claude Code). */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** OAuth scopes Claude Code requests on login. */
export const CLAUDE_SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

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

/** Locate Claude Code's stored OAuth credentials (read-only). */
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
      const refreshToken = oauth?.refreshToken ?? oauth?.refresh_token ?? undefined;
      if (typeof accessToken === "string" && accessToken.length > 0
        || typeof refreshToken === "string" && refreshToken.length > 0) {
        return { accessToken, refreshToken };
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

/** Refresh the Claude Code OAuth access token from the stored refresh token. */
async function claudeRefresh(io, refreshToken) {
  const res = await request("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: CLAUDE_SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  if (res.json === undefined || typeof res.json !== "object") throw new Error("token refresh: invalid response");
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

let cache = null;
let retryAt = 0;
let backoffMs = 0;
let lastError = null;

/** Drop the in-memory cache (tests; a credential change makes it moot). */
export function resetClaudeUsageCache() {
  cache = null;
  retryAt = 0;
  backoffMs = 0;
  lastError = null;
}

/** Payload replay that keeps the card's "updated" line honest. */
function replay(cached) {
  return { ...cached.data, fetchedAt: cached.at };
}

/** Fetch the Claude quota through the adapter I/O context. */
export async function claudeFetch(io, endpoint) {
  const auth = await claudeAuth(io);
  const now = Date.now();
  const cached = cache !== null && cache.token === auth.accessToken ? cache : null;
  if (cached !== null && now - cached.at < CACHE_MIN_INTERVAL_MS) return replay(cached);
  if (now < retryAt) {
    if (cached !== null && now - cached.at < CACHE_MAX_STALE_MS) return replay(cached);
    throw lastError ?? Object.assign(new Error("rate limited by Claude (HTTP 429)"), { code: "RATE_LIMIT" });
  }
  let json;
  try {
    try {
      json = await claudeUsage(io, auth.accessToken);
    } catch (error) {
      if (error?.code !== "AUTH" || typeof auth.refreshToken !== "string") throw error;
      const refreshed = await claudeRefresh(io, auth.refreshToken);
      json = await claudeUsage(io, refreshed.access_token);
    }
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