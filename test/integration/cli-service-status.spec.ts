import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openStorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository } from '../../src/storage/repository';
import { openStatusStore } from '../../src/cli/service-status';
import { readPollingRunEvidence } from '../../src/services/polling-status';
import { createTempDir, type TempDir } from '../helpers/isolation';
import { CLI_ENTRY_SOURCE } from '../helpers/hermetic-child-env';

/**
 * The `quotameter status` command end-to-end through the real launcher
 * (task 142, spec §5.2/§7.3, decision D-114).
 *
 * The development container and CI images ship no systemd and no installed
 * quotameter service, so the installed-scope × manager matrix is seam-driven
 * in `test/unit/cli-service-status.spec.ts`; what this suite pins are the
 * routes the container really produces: the bare machine (nothing installed,
 * stopped, nothing configured — exit 0, the answered-question contract), the
 * full report over a real configuration and a real migrated SQLite database
 * (§7.3 status, §10 configured-zone timestamps, the §7.2 last-error line,
 * the marker key never rendered), the invalid-configuration route (problems
 * on stderr, service facts kept, exit 1), and the running leg through a real
 * §5.6 lock naming a live pid. Every configuration value is synthetic, never
 * a secret; the no-network guard is preloaded exactly as in the 141 suite.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every launcher child. */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

/** The §17.1 marker key (§15.4): configured, never rendered. */
const MARKER_KEY = 'qm-marker-key-t142-integration';

/**
 * Fixed seeding instants (2025-11-01T12:26:40Z — November pins
 * Europe/Berlin to CET, UTC+1): the success's collection stamp and the
 * failure's end render deterministically in the report.
 */
const SUCCESS_AT = 1_762_000_001_000;
const ERROR_ENDED_AT = 1_762_000_003_000;

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

/** Runs the real launcher's `status` against one temporary home. */
function runStatus(dir: TempDir): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, 'status'],
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
 * A valid file configuration (the 141 suite's fixture shape) with one
 * marker-keyed account; every value is synthetic, never a secret.
 */
function validConfigFile(): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
    auth: { mode: 'auto' },
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
        id: 'work',
        providerId: 'zai',
        label: 'Work plan',
        enabled: true,
        apiKey: MARKER_KEY,
      },
    ],
  };
}

/**
 * Seeds a real migrated database in `dataDir` with one account's history:
 * a successful cycle (with its snapshot) followed by an auth-rejected one —
 * §7.2's two most-recents, both §7.3 inputs.
 */
async function seedDatabase(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const connection = openStorageConnection({ dataDir });
  try {
    await createMigrationRunner({
      database: connection.database,
      migrations: MIGRATIONS,
    }).up();
    const repository = createQuotaRepository({ database: connection.database });
    repository.insertAccount({
      id: 'work',
      providerId: 'zai',
      label: 'Work plan',
      createdAt: SUCCESS_AT - 60_000,
    });
    const successRunId = repository.insertCollectionRun({
      accountId: 'work',
      startedAt: SUCCESS_AT - 1_000,
      endedAt: SUCCESS_AT,
      intervalSeconds: 300,
      outcome: 'success',
      attempts: 1,
    });
    repository.insertSnapshot({ accountId: 'work', runId: successRunId, collectedAt: SUCCESS_AT });
    repository.insertCollectionRun({
      accountId: 'work',
      startedAt: ERROR_ENDED_AT - 1_000,
      endedAt: ERROR_ENDED_AT,
      intervalSeconds: 300,
      outcome: 'auth_error',
      httpStatus: 401,
      errorMessage: 'HTTP 401: the provider rejected the key',
      attempts: 1,
    });
  } finally {
    connection.close();
  }
}

describe('quotameter status (real launcher)', () => {
  it(
    'opens the seeded database in-process and reads evidence through it (the production opener)',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-status-store-open-');
      try {
        await seedDatabase(join(dir.path, 'data'));
        const store = await openStatusStore(join(dir.path, 'data'));
        expect(store.state).toBe('open');
        if (store.state !== 'open') return;
        try {
          const evidence = readPollingRunEvidence(store.repository, 'work');
          expect(evidence.latestRunOutcome).toBe('auth_error');
          expect(evidence.lastSuccessAt).toBe(SUCCESS_AT);
          expect(store.repository.getLatestCollectionRun('work')?.outcome).toBe('auth_error');
        } finally {
          store.close();
        }
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'answers the bare machine with a full, useful report and exits 0',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-status-bin-bare-');
      try {
        const result = await runStatus(dir);
        expect(result.code).toBe(0);
        // The node:sqlite ExperimentalWarning rides stderr (expected, per
        // docs/agents/gotchas.md); what must stay absent is any failure
        // line — the bare machine is a fully answered question.
        expect(result.stderr).not.toContain('quotameter status');
        expect(result.stdout).toContain('Quotameter status');
        expect(result.stdout).toContain('  Installed: no systemd service');
        expect(result.stdout).toContain(
          `  Running: stopped (no instance holds the data directory ${join(dir.path, 'data')})`,
        );
        expect(result.stdout).toContain(
          `  Configuration: ${join(dir.path, 'config', 'config.json')} (not configured yet)`,
        );
        expect(result.stdout).toContain(
          'Accounts: none configured yet — add one with quotameter init or in the web UI.',
        );
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'renders the full report over a real configuration and database, without the key',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-status-bin-full-');
      try {
        await mkdir(join(dir.path, 'config'), { recursive: true });
        await writeFile(
          join(dir.path, 'config', 'config.json'),
          JSON.stringify(validConfigFile(), null, 2),
        );
        await seedDatabase(join(dir.path, 'data'));

        const result = await runStatus(dir);
        expect(result.code).toBe(0);
        // The node:sqlite ExperimentalWarning rides stderr (expected); no
        // failure line belongs on this route.
        expect(result.stderr).not.toContain('quotameter status');
        // The service section: stopped (no lock), valid configuration, zone.
        expect(result.stdout).toContain('  Configuration: ');
        expect(result.stdout).toContain(' (valid)');
        expect(result.stdout).toContain('  Display time zone: Europe/Berlin');
        // The §7.3 status, the §10 last collection, the §7.2 last error —
        // deterministic strings from the seeded instants (CET, UTC+1).
        expect(result.stdout).toContain('  Work plan (zai)');
        expect(result.stdout).toContain('    Status: Auth rejected');
        expect(result.stdout).toContain('    Last collection: 2025-11-01 13:26 (Europe/Berlin)');
        expect(result.stdout).toContain(
          '    Last error: 2025-11-01 13:26 (Europe/Berlin): Auth rejected — ' +
            'HTTP 401: the provider rejected the key',
        );
        // §15.4: the configured key never reaches stdout or stderr.
        expect(result.stdout).not.toContain(MARKER_KEY);
        expect(result.stderr).not.toContain(MARKER_KEY);
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'reports an invalid configuration with its problems while keeping the service facts',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-status-bin-invalid-');
      try {
        const config = validConfigFile();
        (config.app as { timezone: string }).timezone = 'Not/AZone';
        await mkdir(join(dir.path, 'config'), { recursive: true });
        await writeFile(join(dir.path, 'config', 'config.json'), JSON.stringify(config, null, 2));

        const result = await runStatus(dir);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('quotameter status: ');
        expect(result.stderr).toContain('app.timezone');
        expect(result.stdout).toContain('(invalid — the problems are on stderr)');
        expect(result.stdout).toContain(
          'Accounts: unavailable — the configuration is invalid (the problems are on stderr)',
        );
        // The service facts the other probes established still render.
        expect(result.stdout).toContain('  Running: stopped');
        // The key inside the rejected file never renders either.
        expect(result.stdout).not.toContain(MARKER_KEY);
        expect(result.stderr).not.toContain(MARKER_KEY);
      } finally {
        await dir.remove();
      }
    },
  );

  it(
    'discovers a running service through a real lock naming a live pid',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-status-bin-running-');
      try {
        // The vitest worker's own pid is alive at read time; the §5.6 lock
        // payload contract is what task 074's module writes.
        await mkdir(join(dir.path, 'data'), { recursive: true });
        await writeFile(
          join(dir.path, 'data', '.quotameter.lock'),
          `${JSON.stringify({ pid: process.pid, id: 'integration' })}\n`,
        );

        const result = await runStatus(dir);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`  Running: running (pid ${process.pid})`);
      } finally {
        await dir.remove();
      }
    },
  );
});
