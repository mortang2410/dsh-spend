/**
 * The adapter I/O context, exercised for real: `createProviderIo().run` must
 * forward the caller's environment allowlist to `execFile`, capture stdout,
 * and report a missing binary as ENOENT. These run the same module the service
 * loads, so a change in that wiring fails here rather than passing silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderIo } from "../lib/providers/io.js";

const SENTINEL = "REVIEW_SECRET_SENTINEL_0123456789";

function ioFor() {
  return createProviderIo({
    env: { PATH: process.env.PATH, HOME: process.env.HOME, REVIEW_SECRET_SENTINEL: SENTINEL },
    home: process.env.HOME,
    resolveRef: async () => undefined,
  });
}

test("the child sees the allowlist and nothing else", async () => {
  const result = await ioFor().run(
    process.execPath,
    ["-e", "process.stdout.write(`${process.env.HOME ? 'home' : 'nohome'}:${process.env.REVIEW_SECRET_SENTINEL ?? 'absent'}`)"],
    10000,
    { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "home:absent");
  assert.ok(!result.stdout.includes(SENTINEL));
});

test("stdout is captured and a non-zero exit reports its code", async () => {
  const io = ioFor();
  const ok = await io.run(process.execPath, ["-e", "process.stdout.write('hello')"], 10000, { env: { PATH: process.env.PATH } });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hello");

  const failed = await io.run(process.execPath, ["-e", "process.exit(3)"], 10000, { env: { PATH: process.env.PATH } });
  assert.equal(failed.code, 3);
});

test("a missing binary rejects with ENOENT so callers can try another path", async () => {
  await assert.rejects(
    () => ioFor().run("definitely-not-a-real-binary-xyz", [], 5000, { env: { PATH: "/bin" } }),
    (error) => error.code === "ENOENT",
  );
});

test("readText answers undefined for a missing file instead of throwing", async () => {
  assert.equal(await ioFor().readText("/nonexistent/path/for/dsh-spend"), undefined);
});
