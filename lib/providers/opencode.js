/**
 * OpenCode Go subscription quota adapter.
 *
 * The vendor's usage route is `GET https://opencode.ai/zen/go/v1/usage` with a
 * Go API key, and only the Bifrost gateway may hold one (see AGENTS.md
 * "Provider keys"). Bifrost is configured with a dedicated
 * `opencode-go-billing` provider block whose `list_models` path override points
 * at that URL, so the gateway fetches it with its own key and stores the body
 * in its request log.
 *
 * This adapter therefore holds no credential: it runs
 * `scripts/opencode-go-usage.py`, which asks Bifrost to refresh (a keyless
 * loopback GET on /v1/models), reads the newest captured body out of the
 * gateway's log database, and prints it as JSON. The body reports the rolling
 * (5h), weekly and monthly windows as percent-used plus reset time, normalized
 * through `stats.normalizeProviderUsage`.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeProviderUsage } from "../stats.js";
import { helperRunner } from "./common.js";

/** Helper script, resolved relative to this file so a link install works. */
export const OPENCODE_GO_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "opencode-go-usage.py",
);

/**
 * Fetch the OpenCode Go quota through the adapter I/O context.
 *
 * `io.runCommand` is an optional test seam; production spawns the helper
 * through `python3`. The helper only copies the captured payload, so the
 * vendor's window names are mapped here.
 */
export async function opencodeGoFetch(io, endpoint) {
  const scriptPath = io?.opencodeScript ?? endpoint?.script ?? OPENCODE_GO_SCRIPT;
  const run = helperRunner(io, endpoint?.timeoutMs ?? 20000);
  const captured = await run(scriptPath);
  if (captured === null || typeof captured !== "object") throw new Error("helper returned no data");
  if (typeof captured.error === "string" && captured.error.length > 0) throw new Error(captured.error);
  const usage = normalizeProviderUsage(captured.payload, "opencode-go");
  if (Object.keys(usage.windows).length === 0) throw new Error("no usage windows in the captured payload");
  return { windows: usage.windows, extra: [] };
}
