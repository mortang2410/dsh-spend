/**
 * The I/O context handed to the provider usage/balance adapters.
 *
 * Kept in its own module so the exact wiring the service uses — which process
 * environment a CLI subprocess receives, how stdout is captured, how a request
 * is timed out — can be exercised by a test without importing the service
 * (whose `@deepseek-ai/cordis` peer only exists inside the host).
 *
 * `run(file, args, timeoutMs, options)`: `options.env`, when given, replaces
 * the inherited environment wholesale. An adapter that runs a vendor CLI passes
 * an allowlist, so no secret in the plugin's own environment can reach that
 * subprocess. The result carries `{ code, stdout, stderr }`; a missing binary
 * rejects with `code: "ENOENT"` and every other failure resolves with its exit
 * code, because callers differ on whether a non-zero exit is fatal.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const MAX_CLI_OUTPUT = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/**
 * Build the adapter I/O context.
 *
 * @param {object} deps
 * @param {Record<string, string|undefined>} deps.env  the process environment
 *        the adapters may read allowlisted names from
 * @param {string} deps.home  home directory, for `~/.`-style candidates
 * @param {(envName: string) => Promise<string|undefined>} deps.resolveRef
 *        credentials-seam lookup used by the API-key adapters
 */
export function createProviderIo({ env, home, resolveRef }) {
  return {
    env,
    home,
    resolveRef,
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    run: (file, args, timeoutMs, options = {}) =>
      new Promise((resolve, reject) => {
        const settings = { timeout: timeoutMs, maxBuffer: MAX_CLI_OUTPUT };
        if (options.env !== undefined) settings.env = options.env;
        execFile(file, args, settings, (error, stdout, stderr) => {
          const output = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
          if (error === null) return resolve({ code: 0, ...output });
          // A missing binary is the only case the caller retries elsewhere.
          if (error.code === "ENOENT") {
            return reject(Object.assign(new Error(`${file} not found`), { code: "ENOENT" }));
          }
          resolve({ code: typeof error.code === "number" ? error.code : -1, ...output });
        });
      }),
    request: async (url, options = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
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
    },
  };
}
