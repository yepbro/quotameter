/**
 * Child-process entry for the rolling-range `TZ`-invariance tests (task 116).
 *
 * Spawned as `node --import jiti/register test/helpers/rollingRangeRunner.ts`
 * — the pattern of `singleInstanceRunner.ts` (task 074) — so the real module
 * runs in a real process whose `TZ` the spawner fixed before startup. That is
 * the only honest level for spec §10's "works consistently under any `TZ`
 * setting": `Intl` and libc read `TZ` once at process start, so mutating
 * `process.env.TZ` inside an already-running test process proves nothing.
 *
 * Environment:
 *
 * - `QUOTAMETER_TEST_RUNNER_NOW` — the pinned `now` in UTC epoch ms
 *   (required, must be finite). The module takes time as an argument
 *   (decision D-021), so every child computes bounds for the same instant
 *   regardless of its zone.
 *
 * Output: one JSON line on stdout — the effective `TZ`, the zone `Intl`
 * resolved inside the child (proof the environment took effect), the echo
 * of `now`, and the bounds of every supported range. The spec asserts the
 * `ranges` half is byte-identical across all children while the resolved
 * zones differ (non-vacuity).
 */
import { ROLLING_RANGE_IDS, rollingRangeBounds } from '../../src/util/rolling-ranges';

const rawNow = requiredEnv('QUOTAMETER_TEST_RUNNER_NOW');
const now = Number(rawNow);
if (!Number.isFinite(now)) {
  throw new Error(`QUOTAMETER_TEST_RUNNER_NOW must be a finite epoch-ms number, got '${rawNow}'`);
}

const ranges: Record<string, { from: number; to: number }> = {};
for (const id of ROLLING_RANGE_IDS) {
  const { from, to } = rollingRangeBounds(id, now);
  ranges[id] = { from, to };
}

process.stdout.write(
  `${JSON.stringify({
    tz: process.env.TZ ?? null,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    now,
    ranges,
  })}\n`,
);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}
