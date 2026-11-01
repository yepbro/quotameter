import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The `quotameter reload` command end-to-end through the real launcher
 * (task 141, spec §5.2/§6.4, decision D-112).
 *
 * The development container and CI images ship no systemd and no running
 * quotameter service, but the command's discovery and delivery need neither:
 * the §5.6 single-instance lock is a data-directory file, and the signal
 * target can be a real child process of the test. Every route below is
 * therefore the real thing — the launcher resolves the owner, reads the
 * lock of `QUOTAMETER_DATA_DIR`, validates `QUOTAMETER_CONFIG_DIR`'s file
 * through the landed pipeline, and (only for a valid configuration) sends a
 * real SIGHUP to the live pid the lock names. The signal-holding child
 * follows the U-001 readiness discipline: the test waits for the child's
 * ready file before anything signals it, and the SIGHUP marker is awaited
 * at a generous round-trip deadline (D-087 — every load factor only delays
 * the marker, never moves it before the signal).
 *
 * Every configuration value is synthetic, never a secret. The no-network
 * guard is preloaded into the launcher child exactly as in
 * `cli-service-control.spec.ts` (the command performs no network I/O, but
 * the guard makes that certain).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every launcher child. */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

/** How long a file-wait polls before giving up (D-087: generous, load-proof). */
const WAIT_DEADLINE_MS = 5000;

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

/** Runs the real launcher's `reload` against one temporary home. */
function runReload(dir: TempDir): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, 'reload'],
    {
      env: {
        ...process.env,
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
 * A child that plays the running service's signal side: it announces
 * readiness through `readyPath` (U-001 — the test signals nothing before
 * the handlers exist) and records a received SIGHUP in `markerPath`.
 */
function spawnSignalChild(readyPath: string, markerPath: string): ChildProcess {
  const child = spawn(process.execPath, [
    '-e',
    `process.on('SIGHUP', () => { require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, ''); });` +
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

/**
 * A valid file configuration (the `config-reload.spec.ts` fixture shape);
 * every value is synthetic, never a secret.
 */
function validConfigFile(): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto', passwordHash: 'synthetic-scrypt-hash' },
    logging: { level: 'warn' },
    providers: {
      zai: {
        peakHours: {
          timezone: 'Asia/Singapore',
          offPeakMultiplier: 0.5,
          windows: [
            {
              id: 'zai-weekday-peak',
              name: 'Z.ai Coding Plan peak hours',
              days: ['mon', 'tue', 'wed', 'thu', 'fri'],
              start: '14:00',
              end: '18:00',
              multiplier: 1,
            },
          ],
        },
        requestTimeoutSeconds: 15,
      },
    },
    accounts: [
      {
        id: 'zai-main',
        providerId: 'zai',
        label: 'Main subscription',
        enabled: true,
        apiKey: 'synthetic-test-key-not-a-real-secret',
      },
    ],
  };
}

describe('quotameter reload (real launcher, real signal target)', () => {
  it(
    'reports the not-running outcome with the start guidance when no lock exists',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-reload-bin-absent-');
      try {
        const result = await runReload(dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('quotameter reload: the quotameter service is not running');
        expect(result.stderr).toContain(join(dir.path, 'data'));
        expect(result.stdout).toContain('quotameter start');
        expect(result.stdout).toContain('quotameter run');
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'reports a rejected configuration with its problems and sends no SIGHUP',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-reload-bin-rejected-');
      const ready = join(dir.path, 'child-ready');
      const marker = join(dir.path, 'child-hup');
      const child = spawnSignalChild(ready, marker);
      try {
        await waitForFile(ready, 'the signal child did not become ready');
        await writeLock(join(dir.path, 'data'), child.pid!);
        const config = validConfigFile();
        (config.app as { timezone: string }).timezone = 'Not/AZone';
        await mkdir(join(dir.path, 'config'), { recursive: true });
        await writeFile(join(dir.path, 'config', 'config.json'), JSON.stringify(config, null, 2));

        const result = await runReload(dir);
        expect(result.code).toBe(1);
        // Field-addressed problems (D-018): the invalid time zone is named
        // on stderr, one prefixed line per problem.
        expect(result.stderr).toContain('quotameter reload: ');
        expect(result.stderr).toContain('app.timezone');
        expect(result.stdout).toContain('no SIGHUP was sent');
        expect(result.stdout).toContain('keep the last valid configuration');

        // The no-signal contract, pinned against the real child: nothing
        // arrives, even after a settle that outlastes the command.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(existsSync(marker)).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await rm(join(dir.path, 'data'), { recursive: true, force: true }).catch(() => undefined);
        await dir.remove();
      }
    },
  );

  it(
    'delivers a real SIGHUP to the live holder and reports the accepted outcome',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-reload-bin-accepted-');
      const ready = join(dir.path, 'child-ready');
      const marker = join(dir.path, 'child-hup');
      const child = spawnSignalChild(ready, marker);
      try {
        await waitForFile(ready, 'the signal child did not become ready');
        await writeLock(join(dir.path, 'data'), child.pid!);
        await mkdir(join(dir.path, 'config'), { recursive: true });
        await writeFile(
          join(dir.path, 'config', 'config.json'),
          JSON.stringify(validConfigFile(), null, 2),
        );

        const result = await runReload(dir);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('reload accepted');
        expect(result.stdout).toContain(`pid ${child.pid}`);
        expect(result.stdout).toContain('quotameter restart');

        // The delivery itself: the child's SIGHUP marker appears.
        await waitForFile(marker, 'the SIGHUP marker of the signal child');
      } finally {
        child.kill('SIGKILL');
        await rm(join(dir.path, 'data'), { recursive: true, force: true }).catch(() => undefined);
        await dir.remove();
      }
    },
  );
});
