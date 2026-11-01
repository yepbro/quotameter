import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The `service install` / `service uninstall` commands end-to-end through
 * the real launcher (task 139, spec §5.2/§5.4, decision D-108).
 *
 * The development container and CI images ship no systemd and no sudo, so
 * the routes that can occur here for real are the systemd-less ones — the
 * install refusal with the foreground alternative (exit 1, §5.2's helpful
 * next step) and the manager-less uninstall no-op (exit 0). The system-unit
 * and user-unit routes, the manager-command failure paths, and the
 * owner-problem refusals are pinned seam-by-seam in
 * `test/unit/cli-service-install.spec.ts`; neither command ever opens
 * stdin, so there is no TTY-sensitive behavior to pin under a PTY.
 *
 * Every run gets its own temporary home and configuration directory so the
 * "writes/removes no service files" assertions stay hermetic under parallel
 * waves. The no-network guard is preloaded into the child exactly as in
 * `cli-init-service.spec.ts` (neither command performs network I/O, but the
 * guard makes that certain).
 */

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

/** Runs the real launcher with the given `service` subcommand arguments. */
function runService(args: readonly string[], dir: TempDir): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, 'service', ...args],
    {
      env: { ...process.env, QUOTAMETER_CONFIG_DIR: dir.path, HOME: dir.path },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return collect(child);
}

describe('quotameter service install/uninstall (real launcher, systemd-less machine)', () => {
  it('install refuses with the exact foreground alternative and writes no unit file', async () => {
    const dir = await createTempDir('qm-service-install-bin-');
    try {
      const result = await runService(['install'], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'quotameter service install: systemd is not available on this machine, so the service cannot be installed here',
      );
      expect(result.stdout).toContain('\n  quotameter run\n');
      expect(result.stdout).toContain('runs in the foreground');
      expect(existsSync(join(dir.path, '.config/systemd/user/quotameter.service'))).toBe(false);
    } finally {
      await dir.remove();
    }
  });

  it('uninstall is an idempotent no-op with nothing installed', async () => {
    const dir = await createTempDir('qm-service-uninstall-bin-');
    try {
      const result = await runService(['uninstall'], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('no user service is installed — nothing to do');
    } finally {
      await dir.remove();
    }
  });

  it('an invalid --restart-sec value is a clear failure naming the flag', async () => {
    const dir = await createTempDir('qm-service-restart-sec-bin-');
    try {
      const result = await runService(['install', '--restart-sec', 'bogus'], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'quotameter service install: --restart-sec must be a whole number of seconds (got "bogus")',
      );
    } finally {
      await dir.remove();
    }
  });

  it('install --help documents the option surface (exit 0)', async () => {
    const dir = await createTempDir('qm-service-help-bin-');
    try {
      const result = await runService(['install', '--help'], dir);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: quotameter service install [options]');
      expect(result.stdout).toContain('--restart-sec <value>');
    } finally {
      await dir.remove();
    }
  });
});
