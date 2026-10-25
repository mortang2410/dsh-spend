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

/**
 * Vendor plan table, keyed by `"<5-hour cap>/<weekly cap>"` in credits and
 * given the plan's monthly credit pool. Published on
 * https://commandcode.ai/docs/resources/usage-limits (read 2026-10-25):
 * Go 2/5 -> 10, GOAT 14/35 -> 70, Pro 16/40 -> 80, Max 10x 45/90 -> 150,
 * Max 20x 90/180 -> 300, Team Pro 12/24 -> 40. The vendor's window caps
 * travel in the payload, so the plan identifies itself; a pair not listed
 * here omits the monthly row rather than guessing an allowance.
 */
const PLAN_BY_WINDOW_CAPS = new Map([
  ["2/5", { name: "Go", monthlyCredits: 10 }],
  ["14/35", { name: "GOAT", monthlyCredits: 70 }],
  ["16/40", { name: "Pro", monthlyCredits: 80 }],
  ["45/90", { name: "Max 10x", monthlyCredits: 150 }],
  ["90/180", { name: "Max 20x", monthlyCredits: 300 }],
  ["12/24", { name: "Team Pro", monthlyCredits: 40 }],
]);

/**
 * Monthly window derived from the plan's credit pool.
 *
 * The billing payload reports only the remainder (`credits.monthlyCredits`),
 * not the pool size, so the pool comes from the plan table above and the used
 * share is `pool - remainder`. Purchased credits can push the remainder above
 * the included pool; the share then clamps to 0 rather than going negative.
 */
export function commandcodeMonthWindow(parsed) {
  const fiveHourCap = Number(parsed?.windows?.["5h"]?.cap);
  const weeklyCap = Number(parsed?.windows?.week?.cap);
  const plan = PLAN_BY_WINDOW_CAPS.get(`${fiveHourCap}/${weeklyCap}`);
  const remaining = Number(parsed?.monthlyCredits);
  if (plan === undefined || !Number.isFinite(remaining)) return null;
  const used = Math.max(0, plan.monthlyCredits - remaining);
  const percent = Math.min(100, Math.max(0, Math.round((used / plan.monthlyCredits) * 100)));
  return { plan, row: { status: "ok", percent, used, limit: plan.monthlyCredits, remaining } };
}

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
  const month = commandcodeMonthWindow(parsed);
  const meta = {};
  if (Number.isFinite(Number(parsed.monthlyCredits))) meta.monthlyCredits = Number(parsed.monthlyCredits);
  if (month !== null) meta.plan = month.plan.name;
  return { windows: month === null ? windows : { ...windows, month: month.row }, extra: [], meta };
}
