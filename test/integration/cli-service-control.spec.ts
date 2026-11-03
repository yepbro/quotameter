import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The `quotameter start` / `stop` / `restart` commands end-to-end through
 * the real launcher (task 140, spec §5.2, decision D-110).
 *
 * The development container and CI images ship no systemd and no sudo, and
 * no service is installed there, so the route that can occur here for real
 * is §5.2's not-installed case — the helpful next step (exit 1, guidance
 * naming the install command) instead of a cryptic failure. The
 * installed-unit routes, the privilege and manager-availability branches,
 * and the manager-command failures are pinned seam-by-seam in
 * `test/unit/cli-service-control.spec.ts`; the handlers never open stdin,
 * so there is no TTY-sensitive behavior to pin under a PTY.
 *
 * Every run gets its own temporary home and configuration directory so the
 * "writes no service files" assertion stays hermetic under parallel waves.
 * The no-network guard is preloaded into the child exactly as in
 * `cli-service-install.spec.ts` (the commands perform no network I/O, but
 * the guard makes that certain).
 */

/**
 * Every test below spawns exactly one real launcher boot: the child pays
 * the `jiti/register` transpile of the CLI module graph, and the parent's
 * full-pool v8-coverage `make check` contends for the CPU while it runs.
 * The 2026-11-02 parallel-worktree waves pushed that boot past Vitest's
 * 5 s default three times (tasks 154/158/166; always green in isolation).
 * Sized per decision D-094 (U-039): measured 1.2 s clean isolated (4.6 s
 * for the first test after a fresh install — the cold jiti boot), worst
 * 5.9 s in a full coverage `make check` under the six-hog starvation rig
 * at load 16–21, and 13.4 s in the one sizing run where a sibling
 * worktree's burst stacked on the hogs (load 21–38) — still green. That
 * stacked-burst sample is tail evidence, not the sizing basis: the hogs
 * are the instrument that calibrates to the observed ambient waves
 * (~18), so a burst on top models a world harsher than any observed
 * wave. The house 30 s (the 141/142/143 real-launcher suites' value for
 * the same boot shape) holds ≈5× the regime worst — D-094's bar is
 * ≈3× — stayed green through the burst, and a genuinely stuck run
 * still fails in 30 s.
 */
const LAUNCHER_TEST_TIMEOUT_MS = 30_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every child (see the suite header). */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Collects a child's output; resolves on close with the exit code. */
function collect(child: ChildProcess): Promise<RunResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.once('error', reject);
  });
}

/** Runs the real launcher with the given service-control arguments. */
function runControl(args: readonly string[], dir: TempDir): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, ...args],
    {
      env: { ...process.env, QUOTAMETER_CONFIG_DIR: dir.path, HOME: dir.path },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return collect(child);
}

describe('quotameter start/stop/restart (real launcher, nothing installed)', () => {
  // One launcher boot per test (jiti startup ~1-2 s): the loop generates
  // one `it` per verb instead of iterating inside a single test.
  for (const verb of ['start', 'stop', 'restart']) {
    it(
      `${verb} exits 1 with the helpful next step naming the install command`,
      { timeout: LAUNCHER_TEST_TIMEOUT_MS },
      async () => {
        const dir = await createTempDir(`qm-control-${verb}-bin-`);
        try {
          const result = await runControl([verb], dir);
          expect(result.code, `exit 1 for ${verb}`).toBe(1);
          expect(result.stderr).toBe(
            `quotameter ${verb}: no systemd service is installed — nothing to ${verb}\n`,
          );
          expect(result.stdout).toContain(
            'not installed as a systemd service — there is nothing to ' + verb,
          );
          expect(result.stdout).toContain('sudo quotameter service install');
          expect(result.stdout).toContain('quotameter service install');
          expect(result.stdout).toContain('quotameter init');
          expect(existsSync(join(dir.path, '.config/systemd/user/quotameter.service'))).toBe(false);
        } finally {
          await dir.remove();
        }
      },
    );
  }

  it(
    'start --help documents the command (exit 0)',
    { timeout: LAUNCHER_TEST_TIMEOUT_MS },
    async () => {
      const dir = await createTempDir('qm-control-help-bin-');
      try {
        const result = await runControl(['start', '--help'], dir);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Usage: quotameter start [options]');
      } finally {
        await dir.remove();
      }
    },
  );
});
