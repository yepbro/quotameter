import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';
import { CLI_ENTRY_SOURCE } from '../helpers/hermetic-child-env';

/**
 * The `quotameter logs` command end-to-end through the real launcher
 * (task 143, spec §5.2/§16, decision D-116).
 *
 * The development container and CI images ship no systemd and no
 * journalctl, so the installed-unit routes cannot run here (they are the
 * seam-driven matrix of `test/unit/cli-service-logs.spec.ts`). What the
 * launcher CAN prove is real: the owner resolution against the real user
 * database, the nothing-installed guidance, D-112's foreground-run honesty
 * over a real §5.6 lock naming a live child, and — through a driver child
 * that runs the real passthrough runner — the full follow-mode interrupt:
 * SIGINT reaches the CLI-like process, is forwarded to journalctl's
 * stand-in, and the run resolves as an interrupted success (the U-001
 * discipline: nothing is signalled before the child announced readiness;
 * every wait is at a generous round-trip deadline, D-087).
 *
 * Every value is synthetic. The no-network guard is preloaded into the
 * launcher children exactly as in `cli-service-control.spec.ts` (the
 * command performs no network I/O, but the guard makes that certain).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every launcher child. */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;
/** The real passthrough runner, imported by the driver child through jiti. */
const RUNNER_MODULE = pathToFileURL(join(REPO_ROOT, 'src/cli/service-logs.ts')).href;

/** How long a file-wait polls before giving up (D-087: generous, load-proof). */
const WAIT_DEADLINE_MS = 30_000;

/** Polls until `path` exists, or fails after the deadline. */
async function waitForFile(path: string, what: string): Promise<void> {
  const until = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() >= until)
      throw new Error(`${what} did not appear within ${WAIT_DEADLINE_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

/** Runs the real launcher's `logs` against one temporary home. */
function runLogs(dir: TempDir, args: readonly string[] = []): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, 'logs', ...args],
    {
      env: {
        ...process.env,
        ...CLI_ENTRY_SOURCE,
        QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
        QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
        HOME: dir.path,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return collect(child);
}

/**
 * A child that plays the running foreground service: it announces readiness
 * through `readyPath` (U-001 — nothing signals it before the handlers
 * exist) and stays alive until killed.
 */
function spawnForegroundChild(readyPath: string): ChildProcess {
  const child = spawn(process.execPath, [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, '');` +
      'setInterval(() => {}, 60_000);',
  ]);
  child.stderr?.on('data', () => undefined);
  return child;
}

/** Writes the §5.6 lock payload naming `pid` into the data directory. */
async function writeLock(dataDir: string, pid: number): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, '.quotameter.lock'),
    `${JSON.stringify({ pid, id: 'integration' })}\n`,
  );
}

describe('quotameter logs (real launcher)', () => {
  // Every launcher boot pays the jiti startup (~1-2 s isolated, several
  // seconds under a full-suite coverage run), so each test declares the
  // house 30 s timeout (the 141/142 suites' value for the same shape).

  it(
    'exits 1 with the helpful next step when nothing is installed',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-logs-notinstalled-bin-');
      try {
        const result = await runLogs(dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe(
          'quotameter logs: no systemd service is installed — there is no journal to read\n',
        );
        expect(result.stdout).toContain('sudo quotameter service install');
        expect(result.stdout).toContain('quotameter service install');
        expect(result.stdout).toContain('quotameter init');
        expect(result.stdout).toContain(
          'A foreground run (quotameter run) logs to its own terminal',
        );
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'answers a live lock holder with the honest foreground-run guidance',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-logs-foreground-bin-');
      const ready = join(dir.path, 'ready');
      const child = spawnForegroundChild(ready);
      try {
        await waitForFile(ready, 'the foreground child readiness marker');
        await writeLock(join(dir.path, 'data'), child.pid!);
        const result = await runLogs(dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe(
          'quotameter logs: no systemd service is installed — there is no journal to read\n',
        );
        expect(result.stdout).toContain(`running in the foreground (pid ${child.pid})`);
        expect(result.stdout).toContain('nothing for this wrapper to show');
        expect(result.stdout).toContain('quotameter service install');
      } finally {
        child.kill('SIGKILL');
        await dir.remove();
      }
    },
  );

  it('documents the wrapper options in --help (exit 0)', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-logs-help-bin-');
    try {
      const result = await runLogs(dir, ['--help']);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: quotameter logs [options]');
      expect(result.stdout).toContain('-f, --follow');
      expect(result.stdout).toContain('-n, --lines <value>');
      expect(result.stdout).toContain('-o, --output <value>');
    } finally {
      await dir.remove();
    }
  });

  it(
    'forwards SIGINT to the streamed child and reports the interrupt as success',
    { timeout: 90_000 },
    async () => {
      const dir = await createTempDir('qm-logs-follow-driver-');
      const ready = join(dir.path, 'grandchild-ready');
      const marker = join(dir.path, 'grandchild-interrupted');
      // The grandchild stands in for journalctl in follow mode: it installs
      // its SIGINT handler and announces readiness BEFORE anything may
      // signal it (U-001), streams one entry, and records the received
      // signal in `marker` before exiting 0 — journalctl's graceful
      // Ctrl-C shape.
      const grandchild = [
        `process.on('SIGINT', () => {`,
        `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');`,
        `  process.exit(0);`,
        `});`,
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');`,
        `process.stdout.write('grandchild entry line\\n');`,
        `setInterval(() => {}, 60_000);`,
      ].join('\n');
      // The driver is the CLI-like process: it runs the REAL passthrough
      // runner — imported through jiti exactly like the launcher's own
      // command modules, with the same namespace resolution the bin uses
      // (under jiti the TypeScript module arrives as CommonJS whose named
      // exports sit on `default`) — and prints the resolved outcome behind
      // a marker, letting the event loop drain afterwards (the runner
      // removed its signal forwarders; nothing else holds it open).
      const driver = [
        `const mod = await import(${JSON.stringify(RUNNER_MODULE)});`,
        `const runner = mod.runJournalctlPassthrough ?? mod.default?.runJournalctlPassthrough;`,
        `const outcome = await runner([`,
        `  process.execPath, '-e', ${JSON.stringify(grandchild)},`,
        `]);`,
        `process.stdout.write('@@OUTCOME@@' + JSON.stringify(outcome) + '\\n');`,
      ].join('\n');
      const child = spawn(
        process.execPath,
        ['--import', 'jiti/register', '--input-type=module', '-e', driver],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        // U-001: the grandchild's handler exists once the ready file does;
        // the SIGINT to the driver happens strictly after.
        await waitForFile(ready, 'the grandchild readiness marker');
        child.kill('SIGINT');
        const result = await collect(child);
        expect(result.code).toBe(0);
        expect(existsSync(marker), 'the grandchild received the forwarded SIGINT').toBe(true);
        expect(result.stdout).toContain('grandchild entry line\n');
        expect(result.stdout).toContain('@@OUTCOME@@{"ok":true,"interrupted":true}');
      } finally {
        child.kill('SIGKILL');
        await rm(dir.path, { recursive: true, force: true });
      }
    },
  );
});
