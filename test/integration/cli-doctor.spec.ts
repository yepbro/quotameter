import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openStorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository } from '../../src/storage/repository';
import { createTempDir, type TempDir } from '../helpers/isolation';
import { CLI_ENTRY_SOURCE } from '../helpers/hermetic-child-env';

/**
 * The `quotameter doctor` command end-to-end through the real launcher
 * (task 145, spec §5.5; decision D-119).
 *
 * Every route below is the real thing: the launcher resolves the owner,
 * runs the §5.5 check set through the production seams (the real
 * configuration pipeline of `QUOTAMETER_CONFIG_DIR`, the real read-only
 * database open and `PRAGMA quick_check` over a genuinely migrated SQLite
 * database in `QUOTAMETER_DATA_DIR`, the real §5.6 lock read, the real
 * ephemeral bind probe, the real `timedatectl` spawn — which the
 * systemd-less container answers with an honest unavailable row), and the
 * D-119 exit-code contract decides the process status. The `--raw` route
 * reads payloads seeded through the repository's own sanctioned write
 * path, and the marker discipline asserts the env-sourced synthetic key
 * of the guard-blocked connectivity attempt never appears on either
 * stream (§15.4; all values synthetic).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every launcher child. */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

/** The synthetic API key of the env-sourced account (never a secret). */
const ENV_KEY_NAME = 'QM_DOCTOR_TEST_KEY';

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

/** Runs the real launcher's `doctor` against one temporary home. */
function runDoctor(
  dir: TempDir,
  args: readonly string[] = ['doctor'],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, ...args],
    {
      env: {
        ...process.env,
        ...CLI_ENTRY_SOURCE,
        QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
        QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
        HOME: dir.path,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return collect(child);
}

/** Writes a valid loopback configuration file at §6.3 modes. */
async function writeConfig(dir: TempDir, body: Record<string, unknown>): Promise<string> {
  const configDir = join(dir.path, 'config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configFile = join(configDir, 'config.json');
  await writeFile(configFile, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
  return configFile;
}

/** A currently-free loopback port (bound, read, released — small race accepted). */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : 8787;
      server.close(() => resolve(port));
    });
  });
}

/** A real §5.6 lock naming a live child, held for the duration of `hold`. */
async function withLiveLock<T>(dataDir: string, hold: (pid: number) => Promise<T>): Promise<T> {
  const { writeFile: writeLock, stat } = await import('node:fs/promises');
  // The data directory must exist before the child writes its marker.
  await mkdir(dataDir, { recursive: true });
  const marker = join(dataDir, 'integration-child-marker');
  const child = spawn(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok'); setInterval(() => {}, 1000);`,
  ]);
  // Wait for the child's readiness marker (the U-001 handshake shape).
  for (let attempt = 0; ; attempt++) {
    try {
      await stat(marker);
      break;
    } catch {
      if (attempt > 100) throw new Error('lock child never became ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  // The §5.6 lock format: a JSON `{pid, id}` line inside the data directory.
  await writeLock(
    join(dataDir, '.quotameter.lock'),
    `${JSON.stringify({ pid: child.pid, id: 'integration-doctor-lock' })}\n`,
    'utf8',
  );
  try {
    return await hold(child.pid!);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }
}

/** Seeds a real migrated database with one parse-failure payload (§7.4). */
async function seedRawResponse(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const connection = openStorageConnection({ dataDir });
  try {
    await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database: connection.database });
    const now = Date.now();
    repository.insertAccount({
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'Work plan',
      createdAt: now,
    });
    const runId = repository.insertCollectionRun({
      accountId: 'work',
      startedAt: now - 1000,
      endedAt: now,
      intervalSeconds: 300,
      outcome: 'parse_error',
      httpStatus: 200,
      errorMessage: 'the response did not match the expected shape',
      attempts: 1,
    });
    repository.insertRawResponse({
      accountId: 'work',
      runId,
      capturedAt: now,
      httpStatus: 200,
      contentType: 'application/json',
      body: '{"unrecognized":"synthetic-sanitized-payload-t145"}',
    });
  } finally {
    connection.close();
  }
}

describe('quotameter doctor (real launcher)', () => {
  it(
    'bare machine: the runtime rows pass, the absent configuration fails with the init step, exit 1',
    { timeout: 60_000 },
    async () => {
      const dir = await createTempDir('qm-doctor-bare-');
      try {
        const result = await runDoctor(dir);
        expect(result.code).toBe(1);
        // §5.5's node:sqlite check imports the built-in, so the runtime's
        // ExperimentalWarning is expected stderr on every doctor run.
        expect(result.stderr).not.toContain('quotameter doctor:');
        expect(result.stdout).toContain('Quotameter doctor');
        expect(result.stdout).toContain('[pass]        Node.js ');
        expect(result.stdout).toContain('(minimum 22.13.0)');
        expect(result.stdout).toContain('[pass]        node:sqlite is available');
        expect(result.stdout).toContain(
          `[fail]        no configuration file at ${join(dir.path, 'config', 'config.json')} — initialize first:`,
        );
        expect(result.stdout).toContain('                quotameter init');
        expect(result.stdout).toContain('[skip]        no database yet');
        // The container ships no systemd: the clock answer is honest.
        expect(result.stdout).toMatch(/\[unavailable\] cannot determine the system clock state/);
        // Two problems: no configuration, and nothing installed or running.
        expect(result.stdout).toContain('2 problems found');
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'healthy machine: valid configuration, migrated database, foreground lock — exit 0',
    { timeout: 60_000 },
    async () => {
      const dir = await createTempDir('qm-doctor-healthy-');
      try {
        const port = await freePort();
        await writeConfig(dir, {
          server: { host: '127.0.0.1', port },
          app: { timezone: 'Europe/Berlin' },
        });
        await seedRawResponse(join(dir.path, 'data'));
        let lockPid = 0;
        const result = await withLiveLock(join(dir.path, 'data'), async (pid) => {
          lockPid = pid;
          return runDoctor(dir);
        });
        expect(result.code).toBe(0);
        // Only the runtime's expected ExperimentalWarning is allowed on stderr.
        expect(result.stderr).not.toContain('quotameter doctor:');
        expect(result.stdout).toContain(`valid at ${join(dir.path, 'config', 'config.json')}`);
        expect(result.stdout).toContain(
          '[pass]        database opened read-only, PRAGMA quick_check passed',
        );
        expect(result.stdout).toContain(`[pass]        running in the foreground (pid ${lockPid})`);
        expect(result.stdout).toContain(`[pass]        127.0.0.1:${port} is free`);
        expect(result.stdout).toContain('No problems found');
        // The seeded parse-failure payload is invisible without --raw (§7.4).
        expect(result.stdout).not.toContain('synthetic-sanitized-payload-t145');
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'an env-sourced account: unset is an honest unavailable row; set but unreachable is honest too (exit 0)',
    { timeout: 60_000 },
    async () => {
      const dir = await createTempDir('qm-doctor-envkey-');
      try {
        const port = await freePort();
        await writeConfig(dir, {
          server: { host: '127.0.0.1', port },
          app: { timezone: 'Europe/Berlin' },
          accounts: [
            {
              id: 'work',
              providerId: 'zai-coding-plan',
              label: 'Work plan',
              apiKeyEnv: ENV_KEY_NAME,
            },
          ],
        });
        const unset = await withLiveLock(join(dir.path, 'data'), async () => runDoctor(dir));
        expect(unset.code).toBe(0);
        expect(unset.stdout).toContain(
          `account 'Work plan' reads its API key from environment variable '${ENV_KEY_NAME}', which is not set to a usable value in this shell`,
        );
        // With the variable set, the provider is really probed: the
        // preloaded no-network guard turns the attempt into an honest
        // inconclusive row (never a verdict), and the synthetic key stays
        // invisible (§15.4).
        const blocked = await withLiveLock(join(dir.path, 'data'), async () =>
          runDoctor(dir, ['doctor'], { [ENV_KEY_NAME]: 'synthetic-guarded-key-t145' }),
        );
        expect(blocked.code).toBe(0);
        expect(blocked.stdout).toContain("[unavailable] could not verify account 'Work plan':");
        expect(blocked.stdout).not.toContain('synthetic-guarded-key-t145');
        expect(blocked.stderr).not.toContain('synthetic-guarded-key-t145');
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    '--raw <account> shows the seeded sanitized payload through the CLI-only path',
    { timeout: 60_000 },
    async () => {
      const dir = await createTempDir('qm-doctor-raw-');
      try {
        const port = await freePort();
        await writeConfig(dir, {
          server: { host: '127.0.0.1', port },
          app: { timezone: 'Europe/Berlin' },
        });
        await seedRawResponse(join(dir.path, 'data'));
        const result = await withLiveLock(join(dir.path, 'data'), async () =>
          runDoctor(dir, ['doctor', '--raw', 'work']),
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Sanitized raw responses for account 'work':");
        expect(result.stdout).toContain('Sanitized raw responses: 1 shown (newest first)');
        expect(result.stdout).toContain('{"unrecognized":"synthetic-sanitized-payload-t145"}');
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'invalid configuration: the pipeline problems render, exit 1',
    { timeout: 60_000 },
    async () => {
      const dir = await createTempDir('qm-doctor-invalid-');
      try {
        const configDir = join(dir.path, 'config');
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        await writeFile(
          join(configDir, 'config.json'),
          '{"app":{"timezone":"Europe/Berlin"},"server":{"host":"0.0.0.0"}}\n',
          { encoding: 'utf8', mode: 0o600 },
        );
        const result = await runDoctor(dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain('[fail]        invalid — the problems are:');
        // The §15.1 pending state gets its own actionable row.
        expect(result.stdout).toContain(
          'a password is required (auth.mode "required" or a non-loopback server.host)',
        );
        expect(result.stdout).toContain('                Set one with: quotameter passwd');
      } finally {
        await dir.remove();
      }
    },
  );

  // One launcher boot, the family's lightest cell (parse and print, no
  // §5.5 check work — hence 30 s where the doctor-running siblings need
  // 60 s): the 2026-11-04/05 waves expired it at Vitest's 5 s default
  // repeatedly while every isolated run stayed green. Sized per D-094
  // (U-044, decision D-163): measured 1.2 s ambient, 1.5 s worst under
  // the six-hog rig in isolation, 4.1 s worst in a full coverage
  // `make check` under the rig (pool load ~16), against the family's
  // regime worst 5.9 s (U-039, load 16–21). The house 30 s — the value
  // every other single-boot launcher suite pins for the same
  // `jiti/register` boot shape — holds ≈5× that regime worst
  // (D-094's bar is ≈3×), and a genuinely stuck boot still fails in
  // 30 s.
  it('pins the --raw option surface in --help', { timeout: 30_000 }, async () => {
    const dir = await createTempDir('qm-doctor-help-');
    try {
      const result = await runDoctor(dir, ['doctor', '--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--raw <value>');
      expect(result.stdout).toContain(
        'Show sanitized provider responses stored for parse failures of <account>',
      );
    } finally {
      await dir.remove();
    }
  });
});
