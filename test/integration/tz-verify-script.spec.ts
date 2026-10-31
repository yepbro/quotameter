import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The zone-facts guard's own contract (task 126, spec §17.1; decision
 * D-097): `scripts/verify-tz.mjs` is the non-vacuity half of the §17.1
 * time-zone matrix — CI's `timezone` job runs it before `npm run
 * test:time` under each matrix `TZ`, and `make test-time ZONE=…` does the
 * same locally. The script is judged here in real child processes (the
 * `rolling-ranges-tz.spec.ts` pattern): `Intl` resolves the process zone
 * at startup, so `TZ` is only honest when fixed before the process starts.
 *
 * The nine-zone list below is pinned deliberately, and not only against
 * the script: a structural check also compares it with the `timezone`
 * job's matrix in `.github/workflows/ci.yml`, so a zone dropped from (or
 * added to) either the script's table or the workflow's matrix fails this
 * suite — the membership contract of the matrix (the seven §17.1-required
 * identifiers plus the two selected extras).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/verify-tz.mjs');

/** The §17.1 matrix zones: seven required identifiers plus the two extras (D-097). */
const MATRIX_ZONES = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
] as const;

/** One completed child run: exit code plus both output streams. */
interface ScriptRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the guard under `tz` (`null` removes TZ entirely) and collects its output. */
function runGuard(tz: string | null): Promise<ScriptRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tz === null) {
    delete env.TZ;
  } else {
    env.TZ = tz;
  }
  const child = spawn(process.execPath, [SCRIPT], {
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
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.once('error', reject);
  });
}

/**
 * The `tz:` matrix list of the `timezone` job in `.github/workflows/ci.yml`
 * — a small line scanner, not a YAML parser (no YAML dependency exists, and
 * the workflow is actionlint-pinned to this block shape). Every failure
 * mode is a loud throw telling the editor to keep the guard in step, never
 * a silently empty list.
 */
function workflowTimezoneMatrix(): string[] {
  const lines = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n');
  const jobIndex = lines.findIndex((line) => line === '  timezone:');
  if (jobIndex === -1) {
    throw new Error(
      "the 'timezone:' job is missing from .github/workflows/ci.yml — the §17.1 matrix " +
        'would not run in CI; restore the job or retire this guard deliberately',
    );
  }
  const nextJob = lines.findIndex(
    (line, index) => index > jobIndex && /^ {2}[A-Za-z][A-Za-z0-9-]*:$/.test(line),
  );
  const jobLines = lines.slice(jobIndex + 1, nextJob === -1 ? lines.length : nextJob);
  const tzKey = jobLines.findIndex((line) => /^\s+tz:\s*$/.test(line));
  if (tzKey === -1) {
    throw new Error(
      "no 'tz:' matrix key found inside the timezone job — if the workflow's matrix " +
        'shape changed, update this scanner with it (the matrix is the §17.1 zone list)',
    );
  }
  const zones: string[] = [];
  for (const line of jobLines.slice(tzKey + 1)) {
    const item = /^\s+- (.+?)\s*$/.exec(line);
    if (!item?.[1]) break;
    zones.push(item[1]);
  }
  if (zones.length === 0) {
    throw new Error(
      "the timezone job's matrix list is empty or formatted in a shape this scanner " +
        'does not read — update the workflow or this scanner together',
    );
  }
  return zones;
}

describe('scripts/verify-tz.mjs — the matrix non-vacuity guard (task 126)', () => {
  it('the CI workflow timezone matrix equals the pinned zone list', () => {
    expect(workflowTimezoneMatrix()).toEqual([...MATRIX_ZONES]);
  });

  it(
    'accepts every matrix zone, echoing the resolved zone and both probe lines',
    { timeout: 60_000 },
    async () => {
      const runs = await Promise.all(MATRIX_ZONES.map((zone) => runGuard(zone)));
      const violations: string[] = [];
      for (const [index, zone] of MATRIX_ZONES.entries()) {
        const run = runs[index];
        if (run?.code !== 0) {
          violations.push(
            `${zone}: expected exit 0, got ${String(run?.code)} (stderr: ${run?.stderr.trim()})`,
          );
          continue;
        }
        // The success line names the zone and both fixed probes, so the CI
        // log carries the evidence of which cell ran.
        if (!run.stdout.includes(`tz ok: TZ=${zone} resolved`)) {
          violations.push(`${zone}: success line does not echo the zone: ${run.stdout.trim()}`);
        }
        if (
          !run.stdout.includes('2026-01-15T00:00:00Z') ||
          !run.stdout.includes('2026-07-15T00:00:00Z')
        ) {
          violations.push(
            `${zone}: success line does not carry both probe labels: ${run.stdout.trim()}`,
          );
        }
      }
      expect(violations.sort(), 'matrix zones the guard rejected').toEqual([]);
    },
  );

  it(
    'rejects a process without TZ, naming the fresh-process contract',
    { timeout: 60_000 },
    async () => {
      const run = await runGuard(null);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('TZ is not set');
      expect(run.stderr).toContain('fresh');
      expect(run.stdout).toBe('');
    },
  );

  it(
    'treats an empty TZ as unset (the uniform empty-means-unset rule)',
    { timeout: 60_000 },
    async () => {
      const run = await runGuard('');
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('TZ is not set');
    },
  );

  it(
    'rejects a valid IANA zone outside the matrix, listing the nine zones',
    { timeout: 60_000 },
    async () => {
      const run = await runGuard('Europe/Berlin');
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("TZ='Europe/Berlin'");
      // The actionable remedy names the full membership, so the operator
      // can extend the matrix deliberately instead of bypassing the guard.
      for (const zone of MATRIX_ZONES) {
        expect(run.stderr).toContain(zone);
      }
      expect(run.stderr).toContain('together');
    },
  );
});
