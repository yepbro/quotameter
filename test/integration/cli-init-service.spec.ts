import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '../../src/config/load';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The `init` service-setup step end-to-end through the real launcher (task
 * 137, spec §5.3 step 7, decision D-106).
 *
 * The development container ships no systemd and no sudo, so the branch that
 * can occur here for real is the §5.3 "systemd is unavailable" fallback —
 * exactly the branch this task exists to make actionable. These runs prove
 * it end-to-end: piped stdin, non-interactive `--yes`, and a real PTY
 * (`script`, the task-130 marker-gated pattern) all render the exact
 * manual-run command, exit 0, write no service files, and never hang.
 *
 * The routes the container cannot produce (the no-sudo user-unit
 * installation, the privileged system-unit plan, the owner-problem refusal,
 * the installation-failure fallbacks) are pinned seam-by-seam in
 * `test/unit/cli-service-setup.spec.ts`: each asks no question and has no
 * TTY-sensitive behavior, so a PTY would add nothing there — the prompter
 * they never construct is the only PTY-relevant seam, and task 130 already
 * pins it under a real PTY.
 *
 * Every run gets its own temporary configuration directory through
 * `QUOTAMETER_CONFIG_DIR`, and `HOME` is redirected there too so the
 * "manual branch writes nothing" assertion stays hermetic under parallel
 * waves. The no-network guard is preloaded into the child exactly as in
 * `cli-init.spec.ts` (the account-less runs here never reach a connection
 * test, but the guard makes that certain).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every child (see the suite header). */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;
const NODE_ARGS = ['--import', 'jiti/register', '--import', GUARD, BIN, 'init'];

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
  // A child that exits early turns stdin writes into EPIPE; the close event
  // (whose code the test asserts) is the failure signal, not a stream error.
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

/** The per-run environment: configuration and home both inside the temp dir. */
function childEnv(dir: TempDir): NodeJS.ProcessEnv {
  return { ...process.env, QUOTAMETER_CONFIG_DIR: dir.path, HOME: dir.path };
}

/**
 * Account-less fresh-run answers: time zone, then Enter for every default
 * — including the optional §5.3 step-4 password (Enter keeps none, D-141).
 */
const ANSWERS = `${['UTC', '', '', '', '', ''].join('\n')}\n`;

describe('quotameter init service setup (real launcher, systemd-less machine)', () => {
  it('an interactive fresh run prints the exact manual-run steps and writes no service files', async () => {
    const dir = await createTempDir('qm-init-service-137-');
    try {
      const child = spawn(process.execPath, NODE_ARGS, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
        env: childEnv(dir),
      });
      child.stdin?.write(ANSWERS);
      child.stdin?.end();
      const result = await collect(child);
      expect(result.code).toBe(0);
      // The §5.3 fallback: systemd unavailable ⇒ exact manual-run command.
      expect(result.stdout).toContain('Service setup: systemd is not available on this machine');
      expect(result.stdout).toContain('\n  quotameter run\n');
      expect(result.stdout).toContain(
        'This runs in the foreground and stops when its session ends.',
      );
      // The manual branch performs no installation: no unit directory, no
      // unit file — only the configuration the run itself wrote.
      expect(existsSync(join(dir.path, '.config/systemd'))).toBe(false);
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.server).toEqual({ host: '127.0.0.1', port: 8787 });
      expect(result.stderr).toBe('');
    } finally {
      await dir.remove();
    }
  }, 40_000);

  it('init --yes prints the same manual steps without touching stdin', async () => {
    const dir = await createTempDir('qm-init-service-137-');
    try {
      const child = spawn(process.execPath, [...NODE_ARGS, '--yes', '--timezone', 'UTC'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
        env: childEnv(dir),
      });
      const result = await collect(child);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Service setup: systemd is not available on this machine');
      expect(result.stdout).toContain('\n  quotameter run\n');
      expect(existsSync(join(dir.path, '.config/systemd'))).toBe(false);
    } finally {
      await dir.remove();
    }
  }, 40_000);
});

describe('quotameter init service setup (real PTY, manual steps on a terminal)', () => {
  /**
   * Runs the launcher under a PTY via `script`, typing each answer only
   * after its prompt appeared (the task-130 readiness-marker pattern, not
   * fixed sleeps): the transcript is the observable that proves the child
   * is at the right question, so the run stays deterministic under load.
   */
  function runUnderPty(dir: TempDir): Promise<RunResult> {
    const command = [process.execPath, ...NODE_ARGS].map((part) => JSON.stringify(part)).join(' ');
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(dir),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin?.on('error', () => undefined);
    const transcript = () =>
      Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8');

    const typed = (async () => {
      const markers = [
        'IANA time zone to use',
        'Bind host',
        'Port (Enter for 8787)',
        'Polling interval',
        'account label',
        'Web password (at least 12 characters',
      ];
      for (const [index, marker] of markers.entries()) {
        await waitFor(transcript, marker, 15_000);
        child.stdin?.write(index === 0 ? 'UTC\r' : '\r');
      }
      await waitFor(transcript, 'Initial configuration collected', 15_000);
      // The service-setup step renders after the summary; the run then
      // exits on its own — the close event settles the result promise.
      await waitFor(transcript, 'Service setup: systemd is not available', 15_000);
      await waitFor(transcript, '  quotameter run', 15_000);
      child.stdin?.end();
    })();

    return new Promise((resolve, reject) => {
      child.once('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
      child.once('error', reject);
      void typed.catch(reject);
    });
  }

  it('a fresh run under a PTY renders the manual steps and exits cleanly', async () => {
    const dir = await createTempDir('qm-init-service-137-pty-');
    try {
      const result = await runUnderPty(dir);
      expect(result.code).toBe(0);
      const transcript = result.stdout + result.stderr;
      expect(transcript).toContain('Service setup: systemd is not available on this machine');
      expect(transcript).toContain('  quotameter run');
      expect(transcript).toContain('This runs in the foreground and stops when its session ends.');
      expect(existsSync(join(dir.path, '.config/systemd'))).toBe(false);
    } finally {
      await dir.remove();
    }
  }, 40_000);
});

/** Resolves once `read()` contains `marker`; rejects after `timeoutMs`. */
function waitFor(read: () => string, marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (read().includes(marker)) resolve();
      else if (Date.now() > deadline)
        reject(new Error(`timed out waiting for ${JSON.stringify(marker)}`));
      else setTimeout(tick, 50);
    };
    tick();
  });
}
