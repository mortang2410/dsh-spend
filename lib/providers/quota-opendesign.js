/**
 * OpenDesign plan allowance adapter.
 *
 * OpenDesign's inference key (`sk-amr-…`) cannot read quota: every usage route
 * answers 404 for it, and live completions carry no allowance headers. The
 * allowance windows live on the account control plane
 * (`amr-api.open-design.ai`) behind a separate `vela_ctrl_…` control key.
 *
 * This adapter holds no credential. It runs `scripts/opendesign-usage.py`,
 * which reads the key file the `od-login` helper stores owner-only, resolves
 * the workspace and calls `billing/preflight`. The helper already normalizes
 * the vendor payload to the window contract this registry expects:
 *
 *   {"windows": {"5h": {status, percent, used, limit, remaining, resetsAt},
 *                "week": {...}}, "plan": "Go", "workspace": "<id>"}
 *
 * The vendor reports the 5-hour and 7-day windows for a Go plan; Plus, Pro and
 * Max report only the 7-day window, so whatever the payload carries is passed
 * through and nothing is invented for a window the vendor omits.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { helperRunner } from "./common.js";

/** Helper script, resolved relative to this file so a link install works. */
export const OPENDESIGN_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "opendesign-usage.py",
);

/**
 * Read the plan allowances from the control plane.
 *
 * @param io - host services; `runCommand` runs the helper in-process when the
 *   host provides one, so tests can answer without spawning python.
 * @param endpoint - the matching `usageEndpoints` row, which may override the
 *   script path and timeout.
 * @returns `{ windows, extra, meta }` in the registry's usage contract.
 */
export async function opendesignUsageFetch(io, endpoint) {
  const scriptPath = io?.opendesignScript ?? endpoint?.script ?? OPENDESIGN_SCRIPT;
  const run = helperRunner(io, endpoint?.timeoutMs ?? 20000);
  const parsed = await run(scriptPath);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("helper returned no data");
  }
  if (typeof parsed.error === "string" && parsed.error.length > 0) {
    throw new Error(parsed.error);
  }
  const windows = parsed.windows;
  if (windows === null || typeof windows !== "object" || Object.keys(windows).length === 0) {
    throw new Error("no allowance windows in the control-plane payload");
  }
  const meta = {};
  if (typeof parsed.plan === "string" && parsed.plan.length > 0) meta.plan = parsed.plan;
  if (typeof parsed.workspace === "string" && parsed.workspace.length > 0) meta.workspace = parsed.workspace;
  return { windows, extra: [], meta };
}
