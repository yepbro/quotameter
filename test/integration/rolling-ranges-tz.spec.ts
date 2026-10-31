import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLLING_RANGE_IDS, rollingRangeBounds } from '../../src/util/rolling-ranges';

/**
 * The task-116 done-condition suite: rolling-range boundaries are identical
 * under several process `TZ` values (spec §10, §17.1). Each case spawns the
 * real module in a real child process (`test/helpers/rollingRangeRunner.ts`)
 * with `TZ` fixed before startup — whole-hour zones (Berlin, New York), a
 * half-hour zone (Kolkata), a quarter-hour zone (Kathmandu), a +14 zone
 * (Kiritimati), `UTC`, and a process with no `TZ` at all. Every child
 * computes bounds for the same injected `now` (decision D-021), so the
 * `ranges` output must be byte-identical across all of them while their
 * `Intl`-resolved zones differ — the proof the environment genuinely varied
 * (a spawn bug that left every child in one zone would fail loudly instead
 * of passing vacuously).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = join(REPO_ROOT, 'test/helpers/rollingRangeRunner.ts');

/** 2026-10-30T12:00:00Z — the shared pinned instant every child computes. */
const NOW = 1_793_361_600_000;

/** The `TZ` matrix: `null` means "no `TZ` in the environment at all". */
const TZ_CASES: readonly (string | null)[] = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Kiritimati',
  null,
];

/** One runner result line (see the runner header for the shape). */
interface RunnerReport {
  tz: string | null;
  resolvedZone: string | null;
  now: number;
  ranges: Record<string, { from: number; to: number }>;
}

/** Spawns the runner under `tz` and resolves its parsed report. */
function runRunner(tz: string | null): Promise<RunnerReport> {
  const env: NodeJS.ProcessEnv = { ...process.env, QUOTAMETER_TEST_RUNNER_NOW: String(NOW) };
  if (tz === null) {
    delete env.TZ;
  } else {
    env.TZ = tz;
  }
  const child = spawn(process.execPath, ['--import', 'jiti/register', RUNNER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    // 'close' (not 'exit'): stdio is drained by then, so output is complete.
    child.once('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(
            `runner exited with code ${code} under TZ=${String(tz)}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(text) as RunnerReport);
      } catch {
        reject(new Error(`unparsable runner output under TZ=${String(tz)}: ${text}`));
      }
    });
    child.once('error', reject);
  });
}

describe('rolling range boundaries under several TZ values (task 116)', () => {
  it(
    'produces byte-identical bounds in every zone while the zones genuinely differ',
    { timeout: 60_000 },
    async () => {
      const reports = await Promise.all(TZ_CASES.map((tz) => runRunner(tz)));

      // The environment took effect: each explicit case ran under its own
      // `TZ` and resolved a real zone inside the child (ICU may canonicalize
      // an alias — `Asia/Kolkata` resolves as `Asia/Calcutta` on this ICU,
      // the D-014 item 8 behavior — so the guard is "resolved, and at least
      // four distinct zones occurred", not exact names).
      for (const [index, tz] of TZ_CASES.entries()) {
        if (tz === null) continue;
        expect(reports[index]?.tz).toBe(tz);
        expect(reports[index]?.resolvedZone).toBeTruthy();
      }
      const resolved = new Set(reports.map((report) => report.resolvedZone));
      expect(resolved.size).toBeGreaterThanOrEqual(4);
      // Pin at least one concrete difference so a uniform-zone spawn bug
      // cannot pass through a coincidentally-large set union.
      expect(reports[TZ_CASES.indexOf('UTC')]?.resolvedZone).not.toBe(
        reports[TZ_CASES.indexOf('Pacific/Kiritimati')]?.resolvedZone,
      );

      // The done-condition: identical bounds everywhere. Pin the exact JSON
      // serialization, not just deep equality — "byte-identical" output.
      const serialized = reports.map((report) => JSON.stringify(report.ranges));
      for (const candidate of serialized) {
        expect(candidate).toBe(serialized[0]);
      }

      // And the shared output equals the module's in-process truth: every
      // range present, exact `from`/`to` for the pinned now.
      expect(reports[0]?.now).toBe(NOW);
      for (const id of ROLLING_RANGE_IDS) {
        const expected = rollingRangeBounds(id, NOW);
        expect(reports[0]?.ranges[id]).toEqual({ from: expected.from, to: expected.to });
      }
    },
  );
});
