#!/usr/bin/env node
/**
 * Report the size of the usage snapshot the widget re-fetches every refresh,
 * broken down per section, from the host's persisted replay cache.
 *
 * The cache path is the host's own (see UsageStatsService.scanCacheFile); pass
 * another path to measure a different store. Build with the same caps the
 * service passes, so the numbers match what travels over the wire.
 *
 * Usage: node scripts/measure-snapshot.mjs [cachePath]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildStats } from "../lib/stats.js";

const cachePath = process.argv[2] ?? join(homedir(), ".dsh", "storages", "dsh-spend-scan-cache.json");
const cache = JSON.parse(await readFile(cachePath, "utf8"));
const calls = [];
for (const entry of Object.values(cache)) {
  if (Array.isArray(entry?.samples) && entry.decodeError !== true) calls.push(...entry.samples);
}

const stats = buildStats(calls, [], {}, { maxSessions: 20, maxRecentCalls: 50, maxSessionModelRows: 200, seriesHours: 168 });
const total = JSON.stringify(stats).length;
const sections = Object.keys(stats)
  .map((key) => [key, JSON.stringify(stats[key])?.length ?? 0])
  .sort((a, b) => b[1] - a[1]);

console.log(`files ${Object.keys(cache).length}  calls ${calls.length}  snapshot ${Math.round(total / 1024)} KB`);
for (const [key, bytes] of sections.slice(0, 8)) {
  console.log(`  ${key}: ${Math.round(bytes / 1024)} KB`);
}
