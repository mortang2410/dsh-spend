/**
 * Shared helpers for the provider usage/balance adapters
 * (`lib/providers/*.js`). Everything here is intentionally small and
 * dependency-free so each adapter stays a thin, testable unit.
 */

import { execFile } from "node:child_process";

/** Python interpreter used to run a helper script (override for unusual installs). */
export const PYTHON = "python3";

/** Clamp a percent (0–100) with rounding; tolerates null/undefined ("0"). */
export function clampPct(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
}

/** Number from a payload field, or null when unparseable. */
export function numOr(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** ISO string from a unix-*seconds* timestamp (or undefined when invalid). */
export function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

/** ISO string from a unix-*milliseconds* timestamp (or undefined when invalid). */
export function isoFromUnixMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** Conventional credential name for a provider: `DEEPSEEK` → `DEEPSEEK_API_KEY`. */
export function bearerEnvName(provider) {
  return `${String(provider).replaceAll("-", "_").toUpperCase()}_API_KEY`;
}

/** Reusable "not logged in" marker so callers can surface a friendly hint. */
export function notLoggedIn(message) {
  const error = new Error(message);
  error.code = "NOT_LOGGED_IN";
  return error;
}

/**
 * JSON request with an abort timeout. Never throws on HTTP errors — the
 * caller decides how to surface `status`. A network failure throws with
 * `code: "NETWORK"`.
 */
export async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    throw Object.assign(new Error(`request failed: ${String(error?.message ?? error)}`), { code: "NETWORK" });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json };
}

/**
 * Resolve one resource's bearer key through the adapter I/O context
 * (credentials seam first, then the process environment): throws
 * `NOT_LOGGED_IN` when nothing is configured.
 */
export async function resolveBearerKey(io, envName) {
  const key = await io.resolveRef(envName);
  if (typeof key !== "string" || key.length === 0) throw notLoggedIn(`API key not configured (${envName})`);
  return key;
}

/**
 * Run one helper script with the interpreter and resolve to its parsed JSON
 * stdout; a non-zero exit rejects with the helper's own stderr message.
 *
 * `-B` keeps the interpreter from writing `__pycache__` beside the helper: the
 * plugin runs from its own source tree, and the helpers import one sibling
 * module, so the default would litter that tree on every refresh.
 */
export function runHelperScript(scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      ["-B", scriptPath],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim() || String(error.message || error);
          reject(new Error(detail));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          reject(new Error(`helper returned unparseable output: ${String(stdout).slice(0, 200)}`));
        }
      },
    );
  });
}

/**
 * Resolve `(scriptPath) => Promise<parsed JSON>` for an adapter: `io.runCommand`
 * is the test seam and receives the script path plus timeout, so an adapter
 * test never spawns an interpreter.
 */
export function helperRunner(io, timeoutMs) {
  return typeof io?.runCommand === "function"
    ? (scriptPath) => io.runCommand(scriptPath, timeoutMs)
    : (scriptPath) => runHelperScript(scriptPath, timeoutMs);
}