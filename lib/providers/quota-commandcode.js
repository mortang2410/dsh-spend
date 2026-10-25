/**
 * Command Code plan quota adapter.
 *
 * Command Code's usage endpoint needs a Command Code API key, and only the
 * Bifrost gateway may hold one (see AGENTS.md "Provider keys"). Bifrost is
 * configured with a dedicated `commandcode-billing` provider block whose
 * `list_models` path override points at
 * `https://api.commandcode.ai/alpha/billing/credits`, so Bifrost fetches that
 * payload with its own key and stores the body in its request log.
 *
 * This adapter therefore holds no credential: it runs
 * `scripts/commandcode-usage.py`, which asks Bifrost to refresh (a keyless
 * loopback GET on /v1/models), reads the newest captured body out of
 * Bifrost's log database, and prints the normalized windows as JSON.
 *
 * Endpoint (undocumented, `alpha` is the vendor's own "may move" marker).
 * Provider block setup: scripts/commandcode-usage.py header.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Python interpreter used to run the helper (override for unusual installs). */
const PYTHON = "python3";

/** Helper script, resolved relative to this file so a link install works. */
export const COMMANDCODE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "commandcode-usage.py",
);

/** Run the helper and resolve to its parsed JSON stdout. */
function defaultRun(scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [scriptPath],
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
 * Fetch the Command Code plan quota through the adapter I/O context.
 *
 * `io.runCommand` is an optional test seam; production uses execFile above.
 * The helper does the normalization, so this function only validates the shape
 * and maps it onto the widget contract `{ windows, extra, meta }`.
 */
export async function commandcodeUsageFetch(io, endpoint) {
  const scriptPath = io?.commandcodeScript ?? endpoint?.script ?? COMMANDCODE_SCRIPT;
  const run = typeof io?.runCommand === "function"
    ? (file) => io.runCommand(file, endpoint?.timeoutMs ?? 20000)
    : (file) => defaultRun(file, endpoint?.timeoutMs ?? 20000);
  const parsed = await run(scriptPath);
  if (parsed === null || typeof parsed !== "object") throw new Error("helper returned no data");
  if (typeof parsed.error === "string" && parsed.error.length > 0) throw new Error(parsed.error);
  const windows = parsed.windows;
  if (windows === null || typeof windows !== "object" || Object.keys(windows).length === 0) {
    throw new Error("no usage windows in the captured payload");
  }
  const meta = {};
  if (Number.isFinite(Number(parsed.monthlyCredits))) meta.monthlyCredits = Number(parsed.monthlyCredits);
  return { windows, extra: [], meta };
}
