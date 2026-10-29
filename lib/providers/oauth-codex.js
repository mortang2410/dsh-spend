/**
 * OpenAI Codex subscription quota adapter.
 *
 * Reads the Codex CLI's stored OAuth credentials (`~/.codex/auth.json`,
 * `CODEX_HOME`/`~/.config/codex` first; read-only) and queries
 * `GET https://chatgpt.com/backend-api/wham/usage` (undocumented,
 * reverse-engineered — matches the approach of the GCMP VS Code
 * extension).
 *
 * This adapter never renews that login, by design: the OAuth pair belongs to
 * the Codex CLI (one saved login per machine), and a refresh posted from here
 * would rotate the pair out of the CLI's hands. Instead a lapsed access token
 * goes back to its owner the same way the Claude Code adapter does it: the
 * adapter runs the CLI's own diagnostic (`codex doctor --summary --no-color`),
 * which refreshes the pair under the CLI's own process and rewrites
 * `auth.json`, and then re-reads that file. Measured 2026-10-30: doctor takes
 * ~1 s and moved a 10-day-old access token's `exp` ten days forward, rotating
 * the refresh token with it.
 */

import { clampPct, isoFromUnixSeconds, notLoggedIn, request } from "./common.js";

/**
 * A lapsed access token is handed back to the Codex CLI, one check per cooldown
 * at most, so a CLI that cannot renew cannot turn the card's 30 s poll into a
 * spawn loop.
 */
const OWNER_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
/** The CLI's own diagnostic; renewing a lapsed pair is part of what it does. */
const OWNER_CHECK_ARGS = ["doctor", "--summary", "--no-color"];
/** Where the CLI is installed; the first entry is resolved through PATH. */
const CODEX_BINARIES = ["codex", ".local/bin/codex", ".npm-global/bin/codex", ".cargo/bin/codex"];

let ownerCheckAt = 0;

/** Drop the owner-check cooldown (tests). */
export function resetCodexOwnerCheck() {
  ownerCheckAt = 0;
}

/** Ask the Codex CLI to check (and, when lapsed, renew) its own saved login. */
async function askCodexToCheckLogin(io) {
  if (typeof io.run !== "function") return;
  if (Date.now() - ownerCheckAt < OWNER_CHECK_COOLDOWN_MS) return;
  ownerCheckAt = Date.now();
  for (const candidate of CODEX_BINARIES) {
    const bin = candidate.includes("/") ? `${io.home}/${candidate}` : candidate;
    try {
      await io.run(bin, OWNER_CHECK_ARGS, 20000);
      return;
    } catch (error) {
      // Only a missing binary is worth another candidate; any other failure
      // means the CLI ran and declined, and the stale token will say so.
      if (error?.code !== "ENOENT") return;
    }
  }
}

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
  // A lapsed token goes back to its owner: the CLI renews it under its own
  // process and rewrites `auth.json`, and the adapter only re-reads that file.
  let auth = await codexAuth(io);
  if (auth.expiresAt > 0 && auth.expiresAt <= Date.now()) {
    await askCodexToCheckLogin(io);
    auth = await codexAuth(io);
    if (auth.expiresAt > 0 && auth.expiresAt <= Date.now()) {
      throw notLoggedIn(
        "Codex access token expired; run `codex` once to renew it (dsh-spend never renews the shared login)",
      );
    }
  }
  return normalizeCodexUsage(await codexWham(io, auth.accessToken, auth.accountId));
}