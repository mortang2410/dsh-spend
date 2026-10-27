/**
 * OpenAI Codex subscription quota adapter.
 *
 * Reads the Codex CLI's stored OAuth credentials (`~/.codex/auth.json`,
 * `CODEX_HOME`/`~/.config/codex` first; read-only) and queries
 * `GET https://chatgpt.com/backend-api/wham/usage` (undocumented,
 * reverse-engineered — matches the approach of the GCMP VS Code
 * extension).
 *
 * This adapter never renews that login, by design. The OAuth pair belongs to
 * the Codex CLI, and nothing here can write a renewed pair back, so a refresh
 * from this adapter would leave the CLI's stored credentials out of sync with
 * the ones in use. A stale access token therefore surfaces instead and waits
 * for the CLI's next run (the same rule as the Claude Code adapter).
 */

import { clampPct, isoFromUnixSeconds, notLoggedIn, request } from "./common.js";

/**
 * Normalize the Codex wham payload into the widget contract
 * `{ windows, extra, meta }`. Pure function — also exported for tests.
 */
export function normalizeCodexUsage(raw) {
  const windows = {};
  const rateLimit = raw?.rate_limit ?? {};
  const primary = rateLimit.primary_window;
  if (primary !== undefined && primary !== null && Number.isFinite(Number(primary.used_percent))) {
    windows["5h"] = {
      status: "ok",
      percent: clampPct(primary.used_percent),
      ...(isoFromUnixSeconds(primary.reset_at) !== undefined ? { resetsAt: isoFromUnixSeconds(primary.reset_at) } : {}),
    };
  }
  const secondary = rateLimit.secondary_window;
  if (secondary !== undefined && secondary !== null && Number.isFinite(Number(secondary.used_percent))) {
    windows["week"] = {
      status: "ok",
      percent: clampPct(secondary.used_percent),
      ...(isoFromUnixSeconds(secondary.reset_at) !== undefined ? { resetsAt: isoFromUnixSeconds(secondary.reset_at) } : {}),
    };
  }
  const extra = [];
  const review = raw?.code_review_rate_limit?.primary_window;
  if (review !== undefined && review !== null && Number.isFinite(Number(review.used_percent))) {
    extra.push({
      id: "code_review",
      label: "code_review",
      percent: clampPct(review.used_percent),
      ...(isoFromUnixSeconds(review.reset_at) !== undefined ? { resetsAt: isoFromUnixSeconds(review.reset_at) } : {}),
    });
  }
  const meta = {};
  if (typeof raw?.plan_type === "string" && raw.plan_type.length > 0) meta.plan = raw.plan_type;
  const credits = raw?.credits;
  if (credits !== undefined && credits !== null && typeof credits === "object") {
    if (credits.has_credits === true) meta.credits = Number(credits.balance) || 0;
    if (credits.unlimited === true) meta.creditsUnlimited = true;
  }
  return { windows, extra, meta };
}

/**
 * Expiry of a JWT access token, in milliseconds; 0 when the token carries no
 * readable `exp` (opaque or unfamiliar format), which leaves the decision to
 * the usage request.
 */
function jwtExpiryMs(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Locate the Codex CLI's stored OAuth credentials (read-only). */
async function codexAuth(io) {
  const candidates = [
    typeof io.env.CODEX_HOME === "string" && io.env.CODEX_HOME.length > 0 ? `${io.env.CODEX_HOME}/auth.json` : undefined,
    `${io.home}/.config/codex/auth.json`,
    `${io.home}/.codex/auth.json`,
  ].filter(Boolean);
  for (const path of candidates) {
    const text = await io.readText(path);
    if (text === undefined || text.length === 0) continue;
    try {
      const payload = JSON.parse(text);
      const tokens = payload?.tokens ?? {};
      if (typeof tokens.access_token === "string" && tokens.access_token.length > 0) {
        return {
          accessToken: tokens.access_token,
          accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
          expiresAt: jwtExpiryMs(tokens.access_token),
        };
      }
    } catch {
      // malformed credential file — try the next location
    }
  }
  throw notLoggedIn("not logged in: no Codex credentials (~/.codex/auth.json); run `codex login` first");
}

/** GET the Codex rate-limit payload; throws `AUTH` for 401/403. */
async function codexWham(io, accessToken, accountId) {
  if (typeof accessToken !== "string" || accessToken.length === 0) throw Object.assign(new Error("missing access token"), { code: "AUTH" });
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (typeof accountId === "string" && accountId.length > 0) headers["ChatGPT-Account-Id"] = accountId;
  const res = await request("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`auth rejected (HTTP ${res.status})`), { code: "AUTH" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.json === undefined || typeof res.json !== "object") throw new Error("invalid response");
  return res.json;
}

/** Fetch the Codex quota through the adapter I/O context. */
export async function codexFetch(io, endpoint) {
  const auth = await codexAuth(io);
  if (auth.expiresAt > 0 && auth.expiresAt <= Date.now()) {
    throw notLoggedIn(
      "Codex access token expired; it renews on the next codex run (dsh-spend never renews the shared login)",
    );
  }
  return normalizeCodexUsage(await codexWham(io, auth.accessToken, auth.accountId));
}