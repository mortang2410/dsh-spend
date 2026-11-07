/**
 * OpenCode Go adapter tests: the captured payload is normalized onto the widget
 * contract, and helper failures surface as readable errors.
 *
 * The helper itself (scripts/opencode-go-usage.py) is exercised in
 * opencode-go-script.test.js against a throwaway log database. This adapter
 * holds no credential, because Bifrost fetches the usage route with its own key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENCODE_GO_SCRIPT, opencodeGoFetch } from "../lib/providers/opencode.js";

/** Helper output as the python script emits it for a live captured body. */
const captured = {
  payload: {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-11-07T18:04:55.000Z" },
      weekly: { status: "ok", percent: 4, resetsAt: "2026-11-09T00:00:00.000Z" },
      monthly: { status: "ok", percent: 7, resetsAt: "2026-12-07T12:55:20.000Z" },
    },
  },
  fetchedAt: "2026-11-07T13:25:20.227830Z",
  rowTimestamp: "2026-11-07 13:23:05.658947707+00:00",
  rowStatus: "success",
  refreshed: false,
};

test("opencodeGoFetch maps the captured windows to the widget contract", async () => {
  const calls = [];
  const io = {
    runCommand: async (scriptPath) => {
      calls.push(scriptPath);
      return captured;
    },
  };
  const usage = await opencodeGoFetch(io, null);
  assert.equal(calls[0], OPENCODE_GO_SCRIPT);
  assert.deepEqual(usage, {
    windows: {
      "5h": { status: "ok", percent: 0, resetsAt: "2026-11-07T18:04:55.000Z" },
      week: { status: "ok", percent: 4, resetsAt: "2026-11-09T00:00:00.000Z" },
      month: { status: "ok", percent: 7, resetsAt: "2026-12-07T12:55:20.000Z" },
    },
    extra: [],
  });
});

test("a helper error surfaces as the card's failure note", async () => {
  const io = { runCommand: async () => ({ error: "rows for 'opencode-go-billing' hold no usage payload" }) };
  await assert.rejects(() => opencodeGoFetch(io, null), /hold no usage payload/);
});

test("a payload without usage windows is rejected instead of showing an empty card", async () => {
  const io = { runCommand: async () => ({ payload: { usage: {} } }) };
  await assert.rejects(() => opencodeGoFetch(io, null), /no usage windows/);
});

test("an endpoint script override is handed to the helper runner", async () => {
  let script;
  const io = { runCommand: async (scriptPath) => { script = scriptPath; return captured; } };
  await opencodeGoFetch(io, { script: "/tmp/custom-usage.py" });
  assert.equal(script, "/tmp/custom-usage.py");
});
