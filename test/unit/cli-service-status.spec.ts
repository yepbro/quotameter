import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigWithEnv, type ConfigEnvLoadResult } from '../../src/config/env';
import type { CliContext } from '../../src/cli/commands';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import type { ServiceLockRead } from '../../src/cli/service-reload';
import {
  assessEngineLiveness,
  describeManagerState,
  findLatestErrorRun,
  formatStatusTimestamp,
  openStatusStore,
  planManagerProbe,
  redactSecrets,
  resolveAccountConfigured,
  runStatusCommand,
  type ServiceStatusDeps,
  type StatusStoreRead,
} from '../../src/cli/service-status';
import type { CommandOutcome, ServiceCapabilities } from '../../src/cli/service-setup';
import { lockFilePath } from '../../src/server/single-instance';
import type {
  CollectionRunRecord,
  QuotaRepository,
  RunOutcome,
} from '../../src/storage/repository';
import type { EpochMs } from '../../src/util/clock';
import { createTempDir } from '../helpers/isolation';

/**
 * The `quotameter status` command handler (task 142, spec §5.2/§7.3, decision
 * D-114) — the done-condition's matrix: installed scope (system / user /
 * both / neither) × running state (lock absent / held / stale / unreadable /
 * invalid) × data presence (database absent / seeded / unreadable), each
 * rendered usefully, beside §7.3's account-status vocabulary through the
 * landed derivation, §10's configured-zone timestamps (a zone unlike any
 * machine default, so a machine-local leak would render differently), and
 * §15.4's marker-secret discipline (the configured key and password hash
 * never appear; a marker seeded into a stored error message renders as
 * `[REDACTED]`).
 *
 * The handler branches are seam-driven like the 139–141 suites (the
 * container and CI images ship no systemd and no quotameter service); the
 * production seams that ARE real here — the storage opener against real
 * temporary directories (a kernel-genuine absent file, and a corrupt
 * database refused by the §11.1 settings) — cover the arms the container
 * can produce deterministically. The real-launcher routes, including the
 * full report over a real migrated SQLite database, are pinned in
 * `test/integration/cli-service-status.spec.ts`.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the unprivileged side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** A sudo invocation holding privileges (D-105's other ok outcome). */
const HELD: ServiceOwnerContext = { kind: 'sudo', privileges: 'held', user: OWNER };

/** The §6.1 overrides the harness resolves through; both under one root. */
const PATH_ENV = {
  QUOTAMETER_CONFIG_DIR: '/qm/test/config',
  QUOTAMETER_DATA_DIR: '/qm/test/data',
} as const;

/** The configuration path the harness's config directory resolves to. */
const CONFIG_PATH = '/qm/test/config/config.json';

/** The lock path the harness's data directory resolves to. */
const LOCK_PATH = lockFilePath('/qm/test/data');

/**
 * A fixed clock reading (2025-11-01T12:26:40Z): November pins Europe/Berlin
 * to CET (+01:00) and Asia/Kolkata to +05:30 year-round, so both zones'
 * rendered wall times are unambiguous and unlike a UTC machine default.
 */
const NOW: EpochMs = 1_762_000_000_000;

/** Europe/Berlin at NOW: 13:26 local (CET, UTC+1). */
const BERLIN_NOW = '2025-11-01 13:26 (Europe/Berlin)';

/** The §17.1 marker values (§15.4): configured, never rendered. */
const MARKER_KEY = 'qm-marker-key-t142';
const MARKER_HASH = 'qm-marker-hash-t142';

/** The manager-capability facts the harness defaults to (a systemd-less box). */
const NO_SYSTEMD: ServiceCapabilities = { systemd: false, userManager: false };

/* ── Configuration fixtures (through the real pipeline, like 141's suite) ─ */

/**
 * A genuine pipeline success over raw file input; the validate seam must
 * return the real load-result shape, not a cast.
 */
function pipelineResult(fileInput: unknown): Extract<ConfigEnvLoadResult, { ok: true }> {
  const result = parseConfigWithEnv(fileInput, {});
  if (!result.ok) throw new Error('the pipeline rejected its own fixture');
  return { ...result, fileAbsent: false };
}

/**
 * A genuine pipeline success over the given accounts (the mandatory
 * `app.timezone` arrives through the file section).
 */
function pipelineConfig(
  accounts: readonly unknown[],
  timezone = 'Europe/Berlin',
): Extract<ConfigEnvLoadResult, { ok: true }> {
  return pipelineResult({ app: { timezone }, accounts: [...accounts] });
}

/** One configured account (§6.2/§6.3 shape); spreads for overrides. */
function accountConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'work', providerId: 'zai', label: 'Work plan', apiKey: MARKER_KEY, ...overrides };
}

/* ── The fake repository (the three reads the handler performs) ─────────── */

/** One seeded `collection_runs` row's variable fields. */
interface SeededRun {
  readonly outcome: RunOutcome;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly httpStatus?: number | null;
  readonly errorMessage?: string | null;
}

/**
 * An in-memory repository over the four reads the status handler uses
 * (`readPollingRunEvidence`'s validated surface, the outcome-filtered
 * latest read, and the lifecycle read for the derivation's rank-0 fact).
 * Ordering mirrors the real SQL: latest by
 * `(started_at, id)` desc, oldest-first for `listCollectionRuns`.
 */
function fakeRepository(
  runs: readonly SeededRun[],
  snapshots: readonly number[] = [],
  archivedIds: readonly string[] = [],
): QuotaRepository {
  let nextId = 1;
  const runRows: CollectionRunRecord[] = runs.map((run) => ({
    id: nextId++,
    accountId: 'work',
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    intervalSeconds: 300,
    outcome: run.outcome,
    httpStatus: run.httpStatus ?? null,
    errorMessage: run.errorMessage ?? null,
    attempts: 1,
    retryAfterSeconds: null,
  }));
  const snapshotRows = snapshots.map((collectedAt) => ({
    runId: 0,
    accountId: 'work',
    collectedAt,
    planName: null,
  }));
  return {
    getAccount(accountId: string) {
      // The handler reads only the lifecycle fact (rank 0, D-191): an
      // archived id answers its §8.2 row, anything else no row at all.
      return archivedIds.includes(accountId)
        ? {
            id: accountId,
            providerId: 'zai',
            label: 'Work plan',
            planName: null,
            status: 'archived',
            createdAt: NOW - 86_400_000,
            archivedAt: NOW - 3_600_000,
          }
        : null;
    },
    getLatestCollectionRun(accountId: string, outcome?: RunOutcome) {
      const matching = runRows.filter(
        (row) => row.accountId === accountId && (outcome === undefined || row.outcome === outcome),
      );
      return matching.length === 0
        ? null
        : matching.reduce((best, row) =>
            row.startedAt > best.startedAt || (row.startedAt === best.startedAt && row.id > best.id)
              ? row
              : best,
          );
    },
    getLatestSnapshot(accountId: string) {
      const matching = snapshotRows.filter((row) => row.accountId === accountId);
      return matching.length === 0
        ? null
        : matching.reduce((best, row) => (row.collectedAt >= best.collectedAt ? row : best));
    },
    listCollectionRuns(accountId: string) {
      return runRows
        .filter((row) => row.accountId === accountId)
        .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id)
        .slice(0, 1);
    },
  } as unknown as QuotaRepository;
}

/* ── The handler harness ───────────────────────────────────────────────── */

/** Everything the harness can preset; defaults describe a bare machine. */
interface HarnessOptions {
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly owner?: ServiceOwnerContext;
  readonly lock?: ServiceLockRead;
  readonly alive?: boolean;
  readonly systemUnit?: boolean;
  readonly userUnit?: boolean;
  readonly capabilities?: ServiceCapabilities;
  readonly managerOutcome?: CommandOutcome;
  readonly config?: ConfigEnvLoadResult;
  readonly configProblems?: readonly string[];
  readonly store?: StatusStoreRead;
  readonly env?: NodeJS.ProcessEnv;
}

/** The handler's harness: recorded seams and captured output. */
function harness(options?: HarnessOptions): {
  readonly ctx: CliContext;
  out(): string;
  err(): string;
  lockReads(): readonly string[];
  commandsRun(): readonly (readonly string[])[];
  validated(): readonly { configPath: string; env: NodeJS.ProcessEnv }[];
  storesOpened(): readonly string[];
  closed(): number;
  readonly deps: ServiceStatusDeps;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const lockReads: string[] = [];
  const commands: (readonly string[])[] = [];
  const validated: { configPath: string; env: NodeJS.ProcessEnv }[] = [];
  const stores: string[] = [];
  let closes = 0;
  const env: NodeJS.ProcessEnv = options?.env ?? PATH_ENV;
  const injectedStore: StatusStoreRead = options?.store ?? { state: 'absent' };
  const deps: ServiceStatusDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return { state: 'ok', context: options?.owner ?? REGULAR };
    },
    pathEnv: env,
    readLock: async (lockPath) => {
      lockReads.push(lockPath);
      return options?.lock ?? { state: 'absent' };
    },
    isAlive: () => options?.alive ?? true,
    unitFileExists: (installPath) =>
      installPath === '/etc/systemd/system/quotameter.service'
        ? (options?.systemUnit ?? false)
        : (options?.userUnit ?? false),
    probeCapabilities: () => options?.capabilities ?? NO_SYSTEMD,
    runCommand: async (command) => {
      commands.push(command);
      return options?.managerOutcome ?? { ok: true, detail: '' };
    },
    validate: async (configPath, validateEnv) => {
      validated.push({ configPath, env: validateEnv });
      if (options?.config !== undefined) return options.config;
      if (options?.configProblems !== undefined) {
        return { ok: false as const, problems: [...options.configProblems] };
      }
      // The bare-machine default: no configuration file exists (the
      // pipeline's pinned not-found message, task 064's contract).
      return { ok: false as const, problems: [`configuration file not found: ${configPath}`] };
    },
    openStore: async (dataDir) => {
      stores.push(dataDir);
      if (injectedStore.state !== 'open') return injectedStore;
      return {
        state: 'open',
        repository: injectedStore.repository,
        close: () => {
          closes += 1;
          injectedStore.close();
        },
      };
    },
    now: () => NOW,
  };
  return {
    ctx: {
      output: {
        out: (text: string) => void outLines.push(`${text}\n`),
        err: (text: string) => void errLines.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['status'],
      flags: {},
      positionals: [],
    },
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    lockReads: () => lockReads,
    commandsRun: () => commands,
    validated: () => validated,
    storesOpened: () => stores,
    closed: () => closes,
    deps,
  };
}

/** Runs the handler once through the harness. */
async function run(options?: HarnessOptions): Promise<{ code: number; out: string; err: string }> {
  const h = harness(options);
  const code = await runStatusCommand(h.deps)(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

/* ── The owner gate (D-105's reporting, the 139–141 precedent) ──────────── */

describe('quotameter status — the owner gate', () => {
  it('reports D-105 owner problems on stderr and exits 1 without a report', async () => {
    const result = await run({
      ownerProblems: ['this run is root without a verifiable SUDO_USER (spec §5.3 step 1)'],
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: this run is root without a verifiable SUDO_USER (spec §5.3 step 1)\n',
    );
    expect(result.out).toBe('');
  });

  it('renders a broken user database (the D-105 throw) as the standard failure line', async () => {
    const result = await run({ ownerThrows: new Error('EACCES: permission denied') });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: resolving the service owner failed (EACCES: permission denied)\n',
    );
    expect(result.out).toBe('');
  });

  it('renders an unusable owner home as the directory-resolution failure', async () => {
    const result = await run({
      owner: { kind: 'regular-user', privileges: 'none', user: { ...OWNER, home: '' } },
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: resolving the service directories failed ' +
        '(systemd unit input: homeDir must not be empty)\n',
    );
    expect(result.out).toBe('');
  });
});

/* ── The bare machine: nothing installed, stopped, nothing configured ───── */

describe('quotameter status — the bare report (exit 0: every probe answered)', () => {
  it('renders the not-installed/stopped/not-configured report and exits 0', async () => {
    const h = harness();
    const code = await runStatusCommand(h.deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toBe(
      [
        'Quotameter status',
        '',
        'Service:',
        '  Owner: alice',
        '  Installed: no systemd service (run in the foreground with quotameter run, or install one)',
        '  Running: stopped (no instance holds the data directory /qm/test/data)',
        '  Data directory: /qm/test/data',
        `  Configuration: ${CONFIG_PATH} (not configured yet)`,
        '',
        'Accounts: none configured yet — add one with quotameter init or in the web UI.',
        '',
      ].join('\n'),
    );
    // No unit is installed, so no manager command may run.
    expect(h.commandsRun()).toEqual([]);
    expect(h.lockReads()).toEqual([LOCK_PATH]);
  });

  it('renders a valid empty-accounts configuration with the display time zone', async () => {
    const result = await run({ config: pipelineConfig([]) });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`  Configuration: ${CONFIG_PATH} (valid)`);
    expect(result.out).toContain('  Display time zone: Europe/Berlin');
    expect(result.out).toContain(
      'Accounts: none configured yet — add one with quotameter init or in the web UI.',
    );
  });

  it('reports an env-only configuration by its provenance (§6.3, no file claimed)', async () => {
    const env = { ...PATH_ENV, QUOTAMETER_APP_TIMEZONE: 'Asia/Kolkata' };
    const result = parseConfigWithEnv({}, env);
    if (!result.ok) throw new Error('the pipeline rejected its own env-only fixture');
    const run2 = await run({
      config: { ...result, fileAbsent: true },
      env,
    });
    expect(run2.code).toBe(0);
    expect(run2.out).toContain(
      `  Configuration: ${CONFIG_PATH} (valid — from environment overrides, no configuration file)`,
    );
    expect(run2.out).toContain('  Display time zone: Asia/Kolkata');
  });
});

/* ── The installed-scope × manager matrix (D-110's discovery) ───────────── */

describe('quotameter status — installed scope and the manager view', () => {
  const SYSTEM_PATH = '/etc/systemd/system/quotameter.service';
  const USER_PATH = '/home/alice/.config/systemd/user/quotameter.service';
  const WITH_SYSTEMD: ServiceCapabilities = { systemd: true, userManager: false };

  it('queries the system unit unprivileged and renders the active state', async () => {
    const h = harness({ systemUnit: true, capabilities: WITH_SYSTEMD });
    const code = await runStatusCommand(h.deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.commandsRun()).toEqual([['systemctl', 'is-active', 'quotameter.service']]);
    expect(h.out()).toContain(`  Installed: system service (${SYSTEM_PATH})`);
    expect(h.out()).toContain('  Manager: active');
  });

  it('renders not active for a manager reporting the unit inactive', async () => {
    const result = await run({
      systemUnit: true,
      capabilities: WITH_SYSTEMD,
      managerOutcome: { ok: false, detail: '' },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('  Manager: not active');
  });

  it('marks a manager command that cannot answer unknown and exits 1 (D-114)', async () => {
    const result = await run({
      systemUnit: true,
      capabilities: WITH_SYSTEMD,
      managerOutcome: { ok: false, detail: 'Failed to connect to bus: No medium found' },
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('  Manager: unknown (Failed to connect to bus: No medium found)');
  });

  it('queries the user unit through its own manager from a regular account', async () => {
    const h = harness({
      userUnit: true,
      capabilities: { systemd: true, userManager: true },
    });
    const code = await runStatusCommand(h.deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.commandsRun()).toEqual([['systemctl', '--user', 'is-active', 'quotameter.service']]);
    expect(h.out()).toContain(`  Installed: user service (${USER_PATH})`);
    expect(h.out()).toContain('  Manager: active');
  });

  it('names both units as the mistake it is, and privileges select the manager kind', async () => {
    const regular = await run({
      systemUnit: true,
      userUnit: true,
      capabilities: { systemd: true, userManager: true },
    });
    expect(regular.code).toBe(0);
    expect(regular.out).toContain(
      `  Installed: both a system service (${SYSTEM_PATH}) and a user service (${USER_PATH}) — ` +
        'two independent services for the same data; only one should be installed',
    );
    expect(regular.out).toContain('  Manager: active (user service)');

    const sudo = await run({
      owner: HELD,
      systemUnit: true,
      userUnit: true,
      capabilities: { systemd: true, userManager: true },
    });
    expect(sudo.code).toBe(0);
    expect(sudo.out).toContain('  Manager: active (system service)');
  });

  it('renders an honest unknown when the manager cannot be queried here', async () => {
    const systemless = await run({ systemUnit: true, capabilities: NO_SYSTEMD });
    expect(systemless.code).toBe(0);
    expect(systemless.out).toContain(
      '  Manager: unknown (systemd is not available on this machine)',
    );

    const userless = await run({
      userUnit: true,
      capabilities: { systemd: true, userManager: false },
    });
    expect(userless.code).toBe(0);
    expect(userless.out).toContain(
      '  Manager: unknown (the systemd user manager is not reachable in this session)',
    );

    // A privileged run never asks a --user manager (D-105: it would be
    // root's, not the owner's) — the exact regular-account step instead.
    const held = await harness({
      owner: HELD,
      userUnit: true,
      capabilities: { systemd: true, userManager: true },
    });
    const code = await runStatusCommand(held.deps)(held.ctx);
    expect(code).toBe(0);
    expect(held.commandsRun()).toEqual([]);
    expect(held.out()).toContain(
      "  Manager: unknown (the user service manager belongs to alice's regular account — " +
        'run quotameter status there, without sudo)',
    );
  });
});

/* ── The running state (D-112's lock read, run-mode independent) ────────── */

describe('quotameter status — the running state through the §5.6 lock', () => {
  it('renders running with the holder pid for a live lock', async () => {
    const result = await run({ lock: { state: 'held', pid: 4242 }, alive: true });
    expect(result.code).toBe(0);
    expect(result.out).toContain('  Running: running (pid 4242)');
  });

  it('renders the stale-lock stop with its automatic-clearance explanation', async () => {
    const result = await run({ lock: { state: 'held', pid: 4242 }, alive: false });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      '  Running: stopped (stale lock naming pid 4242 — the service stopped without ' +
        'releasing it; the next start clears it automatically)',
    );
  });

  it('marks an unreadable lock unknown, fails on stderr, and exits 1 without hiding the rest', async () => {
    const result = await run({
      lock: { state: 'unreadable', detail: 'EACCES: permission denied' },
      config: pipelineConfig([]),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `quotameter status: reading the service lock ${LOCK_PATH} failed (EACCES: permission denied)\n`,
    );
    expect(result.out).toContain(`  Running: unknown (the lock file ${LOCK_PATH} cannot be read)`);
    expect(result.out).toContain('  Configuration: /qm/test/config/config.json (valid)');
  });

  it('marks a damaged (invalid) lock unknown, fails on stderr, and exits 1', async () => {
    const result = await run({ lock: { state: 'invalid' } });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `quotameter status: ${LOCK_PATH} is not a valid quotameter lock file\n`,
    );
    expect(result.out).toContain(
      `  Running: unknown (${LOCK_PATH} is not a valid quotameter lock file)`,
    );
  });
});

/* ── The configuration gate ─────────────────────────────────────────────── */

describe('quotameter status — the configuration', () => {
  it("prints an invalid configuration's pipeline problems and exits 1, keeping the service facts", async () => {
    const result = await run({
      lock: { state: 'held', pid: 4242 },
      configProblems: ['app.timezone: expected an IANA time zone, got "Not/AZone"'],
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: app.timezone: expected an IANA time zone, got "Not/AZone"\n',
    );
    expect(result.out).toContain(
      `  Configuration: ${CONFIG_PATH} (invalid — the problems are on stderr)`,
    );
    expect(result.out).toContain(
      'Accounts: unavailable — the configuration is invalid (the problems are on stderr)',
    );
    expect(result.out).not.toContain('Display time zone:');
  });

  it('validates through the exact service pipeline over the owner-scoped path', async () => {
    const h = harness({ config: pipelineConfig([]) });
    await runStatusCommand(h.deps)(h.ctx);
    expect(h.validated()).toEqual([{ configPath: CONFIG_PATH, env: PATH_ENV }]);
  });
});

/* ── The account facts (§7.3 vocabulary, §7.2 most-recents, §10 zone) ───── */

/** Twenty seconds before NOW — fresh, and inside the same wall-clock minute. */
const FRESH_AT = NOW - 20_000;

describe('quotameter status — per-account facts', () => {
  /**
   * Runs the handler over one account configuration with a seeded store and
   * returns the captured report; the §7.3 matrix's shared shape.
   */
  async function reportAccount(
    account: Record<string, unknown>,
    runs: readonly SeededRun[] = [],
    snapshots: readonly number[] = [],
    env: NodeJS.ProcessEnv = PATH_ENV,
    archivedIds: readonly string[] = [],
  ): Promise<{ code: number; out: string; err: string }> {
    let closed = 0;
    const result = await run({
      config: pipelineConfig([account]),
      env,
      store: {
        state: 'open',
        repository: fakeRepository(runs, snapshots, archivedIds),
        close: () => {
          closed += 1;
        },
      },
    });
    expect(closed, 'the store handle closes after the read').toBe(1);
    return result;
  }

  it('renders Fresh with the §10 timestamp of the latest collection', async () => {
    const result = await reportAccount(
      accountConfig(),
      [{ outcome: 'success', startedAt: FRESH_AT - 1_000, endedAt: FRESH_AT }],
      [FRESH_AT],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      [
        'Accounts (1):',
        '  Work plan (zai)',
        '    Status: Fresh',
        `    Last collection: ${BERLIN_NOW}`,
        '    Last error: none',
      ].join('\n'),
    );
  });

  it('renders the configured-zone timestamp, never a machine-local reading (§10)', async () => {
    // Asia/Kolkata is +05:30 year-round: any machine-local leak (the
    // container runs UTC) would render 12:26 instead of 17:56.
    const kolkata = await run({
      config: pipelineConfig([accountConfig()], 'Asia/Kolkata'),
      store: {
        state: 'open',
        repository: fakeRepository(
          [{ outcome: 'success', startedAt: FRESH_AT - 1_000, endedAt: FRESH_AT }],
          [FRESH_AT],
        ),
        close: () => undefined,
      },
    });
    expect(kolkata.out).toContain('    Last collection: 2025-11-01 17:56 (Asia/Kolkata)');
    expect(kolkata.out).toContain('  Display time zone: Asia/Kolkata');
  });

  it('renders Stale, Collecting, Disabled, and Not configured from their evidence', async () => {
    const stale = await reportAccount(
      accountConfig(),
      [],
      [NOW - 4 * 300_000], // older than three intervals
    );
    expect(stale.out).toContain('    Status: Stale');

    const collecting = await reportAccount(accountConfig(), [], []);
    expect(collecting.out).toContain('    Status: Collecting');
    expect(collecting.out).toContain(
      '    Last collection: none yet (no successful collection recorded)',
    );

    const disabled = await reportAccount(accountConfig({ enabled: false }));
    expect(disabled.out).toContain('    Status: Disabled');

    // §6.3: an apiKeyEnv variable this invocation does not provide.
    const notConfigured = await reportAccount(
      accountConfig({ apiKey: undefined, apiKeyEnv: 'QUOTAMETER_TEST_KEY' }),
    );
    expect(notConfigured.out).toContain('    Status: Not configured');
  });

  it('renders Archived for a hand-re-added archived id — the lifecycle fact outranks fresh data (D-191)', async () => {
    // The §4.1 contradiction's CLI face: the configured entry (enabled,
    // key resolved) beside an archived row with retained fresh history.
    // The report must agree with the web UI's accounts surface, not
    // derive a runtime status from the entry.
    const result = await reportAccount(
      accountConfig(),
      [{ outcome: 'success', startedAt: FRESH_AT - 1_000, endedAt: FRESH_AT }],
      [FRESH_AT],
      PATH_ENV,
      ['work'],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('    Status: Archived');
    // The retained history stays honest beside the lifecycle token (§8.2).
    expect(result.out).toContain(`    Last collection: ${BERLIN_NOW}`);
  });

  it('renders the three §7.3 failure statuses from the latest run', async () => {
    const auth = await reportAccount(
      accountConfig(),
      [{ outcome: 'auth_error', startedAt: NOW - 60_000, endedAt: NOW - 30_000, httpStatus: 401 }],
      [NOW - 10 * 60_000],
    );
    expect(auth.out).toContain('    Status: Auth rejected');

    const format = await reportAccount(accountConfig(), [
      { outcome: 'parse_error', startedAt: NOW - 60_000, endedAt: NOW - 30_000 },
    ]);
    expect(format.out).toContain('    Status: Format changed');

    const unreachable = await reportAccount(accountConfig(), [
      { outcome: 'timeout', startedAt: NOW - 60_000, endedAt: NOW - 30_000 },
    ]);
    expect(unreachable.out).toContain('    Status: Unreachable');
  });

  it('renders the most recent error independently of the most recent success (§7.2)', async () => {
    const result = await reportAccount(
      accountConfig(),
      [
        { outcome: 'network_error', startedAt: NOW - 9 * 60_000, endedAt: NOW - 9 * 60_000 + 500 },
        { outcome: 'success', startedAt: FRESH_AT - 1_000, endedAt: FRESH_AT },
        // The newest failure — later than the success — is the last error.
        {
          outcome: 'auth_error',
          startedAt: NOW - 30_000,
          endedAt: NOW - 20_000,
          httpStatus: 403,
          errorMessage: 'provider rejected the key',
        },
      ],
      [FRESH_AT],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(`    Last collection: ${BERLIN_NOW}`);
    expect(result.out).toContain(
      '    Last error: 2025-11-01 13:26 (Europe/Berlin): Auth rejected — provider rejected the key',
    );
  });

  it('falls back to the HTTP status when a failing run stored no message', async () => {
    const result = await reportAccount(accountConfig(), [
      {
        outcome: 'rate_limited',
        startedAt: NOW - 40_000,
        endedAt: NOW - 30_000,
        httpStatus: 429,
        errorMessage: null,
      },
    ]);
    expect(result.out).toContain(
      '    Last error: 2025-11-01 13:26 (Europe/Berlin): Rate limited (HTTP 429)',
    );
  });

  it('treats an absent database as empty evidence (no runs, no failure)', async () => {
    const h = harness({ config: pipelineConfig([accountConfig()]) });
    const code = await runStatusCommand(h.deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.storesOpened()).toEqual(['/qm/test/data']);
    expect(h.out()).toContain('    Status: Collecting');
  });

  it('reports a storage that cannot be opened: stderr failure, unavailable accounts, exit 1', async () => {
    const result = await run({
      config: pipelineConfig([accountConfig()]),
      store: { state: 'failed', detail: 'file is not a database' },
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: reading the service database failed (file is not a database)\n',
    );
    expect(result.out).toContain('Accounts: unavailable — the storage read failed (see stderr)');
  });

  it('reports a repository that throws mid-read the same way, and still closes the handle', async () => {
    let closed = 0;
    const throwing = {
      getLatestCollectionRun: () => {
        throw new Error('no such table: accounts');
      },
      getLatestSnapshot: () => null,
      listCollectionRuns: () => [],
    } as unknown as QuotaRepository;
    const result = await run({
      config: pipelineConfig([accountConfig()]),
      store: {
        state: 'open',
        repository: throwing,
        close: () => {
          closed += 1;
        },
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter status: reading the service database failed (no such table: accounts)\n',
    );
    expect(result.out).toContain('Accounts: unavailable — the storage read failed (see stderr)');
    expect(closed).toBe(1);
  });
});

/* ── The dead-engine suspicion (FSM-4, D-192) ────────────────────────────── */

describe('quotameter status — the dead-engine suspicion (FSM-4, D-192)', () => {
  /** The §12.2 silence threshold at the fixture's default 300 s interval. */
  const THRESHOLD_MS = 990_000; // 3 × 300 s × the 1.1 jitter allowance

  /** One account's newest-run evidence at the given stamp. */
  const evidence = (
    startedAt: number,
    outcome: RunOutcome = 'network_error',
    retryAfterSeconds: number | null = null,
  ) => ({ startedAt, outcome, retryAfterSeconds });

  it('assessEngineLiveness: the evidence table, strict at the boundary', () => {
    // A stopped service never warns: an old cycle is expected then.
    expect(
      assessEngineLiveness({
        serviceRunning: false,
        accounts: [evidence(NOW - THRESHOLD_MS * 10)],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'no-evidence' });
    // No runs at all (fresh install, empty store): honest ambiguity.
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'no-evidence' });
    // Exactly at the threshold is NOT stale — the gap rule's strict
    // boundary (D-178: "elapsed strictly greater").
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(NOW - THRESHOLD_MS)],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'current' });
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(NOW - THRESHOLD_MS + 1)],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'current' });
    // One millisecond past: the silence suggests a dead engine.
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(NOW - THRESHOLD_MS - 1)],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'stale-silence', newestCycleAt: NOW - THRESHOLD_MS - 1 });
  });

  it('assessEngineLiveness: the threshold follows the configured interval (one source)', () => {
    // One elapsed reading judged under two intervals: 198 001 ms of
    // silence is well inside 3 × 300 s × 1.1 but just past 3 × 60 s × 1.1
    // — the same gapThresholdMs the §12.2 timeline reads, never a
    // re-derived twin.
    const at300 = assessEngineLiveness({
      serviceRunning: true,
      accounts: [evidence(NOW - 198_001)],
      intervalSeconds: 300,
      nowEpochMs: NOW,
    });
    expect(at300).toEqual({ kind: 'current' });
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(NOW - 198_001)],
        intervalSeconds: 60,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'stale-silence', newestCycleAt: NOW - 198_001 });
  });

  it('assessEngineLiveness: legitimate pauses widen the expectation — per account (review P2)', () => {
    // A 429 run's stored Retry-After is the provider's requested pause:
    // the same silence that would warn for a plain account is expected
    // inside the deferral window, and suspicious only past it.
    const deferred = NOW - 1_200_000; // 20 min silent at the 300 s interval
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(deferred, 'rate_limited', 1800)], // a 30-min ask
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'current' });
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(deferred, 'rate_limited', 60)], // a 60-s ask: long past
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'stale-silence', newestCycleAt: deferred });
    // An auth_error newest run is the D-064 suspended shape: §7.2's
    // hourly verification cadence legitimately stretches the silence by
    // an hour — the exact false positive the review found (an account
    // suspended at 12:26 probes at most hourly, well past the 16.5-min
    // base threshold).
    const suspended = NOW - 3_600_000; // one hour silent
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(suspended, 'auth_error')],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'current' }); // inside base + the 60-min cadence
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(suspended - 990_001, 'auth_error')], // past even that
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'stale-silence', newestCycleAt: suspended - 990_001 });
    // One provably-live account clears the whole suspicion: the loop
    // dispatched a cycle for it within its own expectation.
    expect(
      assessEngineLiveness({
        serviceRunning: true,
        accounts: [evidence(NOW - 4_000_000), evidence(NOW - 60_000)],
        intervalSeconds: 300,
        nowEpochMs: NOW,
      }),
    ).toEqual({ kind: 'current' });
  });

  it('assessEngineLiveness: fail-fast on malformed inputs (the house convention)', () => {
    const base = {
      serviceRunning: true,
      accounts: [evidence(NOW)],
      intervalSeconds: 300,
      nowEpochMs: NOW,
    } as const;
    expect(() => assessEngineLiveness({ ...base, nowEpochMs: Number.NaN })).toThrow(/nowEpochMs/u);
    expect(() => assessEngineLiveness({ ...base, intervalSeconds: 59 })).toThrow(RangeError);
    expect(() => assessEngineLiveness({ ...base, intervalSeconds: 3_601 })).toThrow(RangeError);
    expect(() =>
      assessEngineLiveness({ ...base, accounts: [evidence(Number.POSITIVE_INFINITY)] }),
    ).toThrow(/startedAt/u);
    expect(() =>
      assessEngineLiveness({ ...base, accounts: [evidence(NOW, 'rate_limited', -1)] }),
    ).toThrow(/retryAfterSeconds/u);
  });

  /**
   * Runs the handler with the service running (a live pid holding the
   * lock) over one seeded run at `startedAt`; the warning scenario's
   * shared shape.
   */
  async function reportWithEngine(
    startedAt: number,
    alive = true,
    lock: ServiceLockRead = { state: 'held', pid: 4321 },
    outcome: RunOutcome = 'network_error',
  ): Promise<{ code: number; out: string; err: string }> {
    return run({
      lock,
      alive,
      config: pipelineConfig([accountConfig()]),
      store: {
        state: 'open',
        repository: fakeRepository([{ outcome, startedAt, endedAt: startedAt + 1_000 }]),
        close: () => {},
      },
    });
  }

  it('warns when the running service has not recorded a cycle for three intervals — exit stays 0', async () => {
    const lastCycleAt = NOW - 1_200_000; // 20 min silent at the 300 s interval
    const result = await reportWithEngine(lastCycleAt);
    expect(result.code, 'the suspicion is advisory, never a probe failure (D-114)').toBe(0);
    // NOW − 20 min renders 13:06 Berlin (13:26 minus 20 minutes, CET).
    expect(result.out).toContain(
      'Warning: the service is running, but the newest collection cycle is older than three ' +
        'polling intervals (last cycle 2025-11-01 13:06 (Europe/Berlin)) — the polling engine ' +
        'may have stopped. Run quotameter logs to inspect the service records.',
    );
  });

  it('does not warn while cycles are current, and never for a stopped service', async () => {
    // A current cycle under a running service: silence below the threshold.
    const current = await reportWithEngine(NOW - 60_000);
    expect(current.out).not.toContain('Warning');
    // The same ancient cycle with the service stopped (a stale lock): the
    // Running line already explains the silence.
    const stopped = await reportWithEngine(NOW - 1_200_000, false, { state: 'absent' });
    expect(stopped.out).not.toContain('Warning');
    expect(stopped.out).toContain('Running: stopped');
    // …and with a dead holder pid (the stale-lock shape), same verdict.
    const staleLock = await reportWithEngine(NOW - 1_200_000, false);
    expect(staleLock.out).not.toContain('Warning');
    expect(staleLock.out).toContain('stopped (stale lock naming pid 4321');
  });

  it('does not warn for the suspended shape the evidence itself explains (review P2)', async () => {
    // One hour of silence under an auth_error newest run is the D-064
    // suspended shape — §7.2's hourly verification cadence legitimately
    // stretches the account's expectation — so the report shows
    // `Auth rejected` WITHOUT claiming the engine may have stopped: the
    // exact false positive the review round found.
    const suspended = await reportWithEngine(NOW - 3_600_000, true, undefined, 'auth_error');
    expect(suspended.out).not.toContain('Warning');
    expect(suspended.out).toContain('Status: Auth rejected');
    // Past even the widened expectation the suspicion returns — an
    // account suspended for over an hour and 16.5 minutes with no probe
    // run is no longer explained by the cadence alone.
    const abandoned = await reportWithEngine(
      NOW - 3_600_000 - 995_000,
      true,
      undefined,
      'auth_error',
    );
    expect(abandoned.out).toContain('Warning');
  });

  it('ignores the silence of accounts the engine would never poll', async () => {
    // A disabled account never runs, so its ancient cycle is not evidence
    // of a dead engine; neither is an unconfigured one (the CLI-side
    // approximation of the pollable set, D-192).
    for (const account of [
      accountConfig({ enabled: false }),
      accountConfig({ apiKey: undefined, apiKeyEnv: 'QMON_TEST_KEY' }),
    ]) {
      let closed = 0;
      const result = await run({
        lock: { state: 'held', pid: 4321 },
        config: pipelineConfig([account]),
        env: PATH_ENV, // QMON_TEST_KEY is unset here
        store: {
          state: 'open',
          repository: fakeRepository([
            { outcome: 'network_error', startedAt: NOW - 1_200_000, endedAt: NOW - 1_199_000 },
          ]),
          close: () => {
            closed += 1;
          },
        },
      });
      expect(result.out, JSON.stringify(account)).not.toContain('Warning');
      expect(closed).toBe(1);
    }
  });
});

/* ── Secret discipline (§15.4, the §17.1 marker scenario) ───────────────── */

describe('quotameter status — secret discipline', () => {
  it('never renders the configured key or password hash, and redacts a marker inside a stored error', async () => {
    const result = await run({
      config: pipelineResult({
        app: { timezone: 'Europe/Berlin' },
        auth: { mode: 'required', passwordHash: MARKER_HASH },
        accounts: [accountConfig()],
      }),
      store: {
        state: 'open',
        repository: fakeRepository([
          {
            outcome: 'parse_error',
            startedAt: NOW - 40_000,
            endedAt: NOW - 30_000,
            // The write side sanitizes by construction (D-048); a seeded
            // marker proves the belt-and-suspenders redaction anyway.
            errorMessage: `unexpected field near ${MARKER_KEY} in response`,
          },
        ]),
        close: () => undefined,
      },
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(MARKER_KEY);
    expect(result.out).not.toContain(MARKER_HASH);
    expect(result.err).not.toContain(MARKER_KEY);
    expect(result.out).toContain(
      '    Last error: 2025-11-01 13:26 (Europe/Berlin): Format changed — ' +
        `unexpected field near [REDACTED] in response`,
    );
  });

  it('redacts an environment-sourced key value the same way (§6.3 secret source parity)', async () => {
    const MARKER_ENV_KEY = 'qm-marker-env-key-t142';
    const result = await run({
      config: pipelineResult({
        app: { timezone: 'Europe/Berlin' },
        accounts: [accountConfig({ apiKey: undefined, apiKeyEnv: 'QUOTAMETER_TEST_KEY' })],
      }),
      env: { ...PATH_ENV, QUOTAMETER_TEST_KEY: MARKER_ENV_KEY },
      store: {
        state: 'open',
        repository: fakeRepository([
          {
            outcome: 'network_error',
            startedAt: NOW - 40_000,
            endedAt: NOW - 30_000,
            errorMessage: `request failed after echoing ${MARKER_ENV_KEY}`,
          },
        ]),
        close: () => undefined,
      },
    });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(MARKER_ENV_KEY);
    expect(result.out).toContain('echoing [REDACTED]');
  });

  it('never renders the key while reporting an unusable lock either', async () => {
    // The report renders (lock unknown) while the validated configuration
    // carrying the marker key sits in memory — the marker must stay hidden.
    const withKey = await run({
      config: pipelineResult({
        app: { timezone: 'Europe/Berlin' },
        accounts: [accountConfig()],
      }),
      lock: { state: 'invalid' },
    });
    expect(withKey.out).not.toContain(MARKER_KEY);
    expect(withKey.err).not.toContain(MARKER_KEY);
  });
});

/* ── The pure helpers ───────────────────────────────────────────────────── */

describe('planManagerProbe (the pure manager decision)', () => {
  const ownerName = 'alice';

  it('skips when nothing is installed', () => {
    expect(
      planManagerProbe({
        selected: undefined,
        privileges: 'none',
        capabilities: NO_SYSTEMD,
        ownerName,
      }),
    ).toEqual({ state: 'skip' });
  });

  it('asks the system manager only when systemd runs', () => {
    expect(
      planManagerProbe({
        selected: 'system',
        privileges: 'none',
        capabilities: NO_SYSTEMD,
        ownerName,
      }),
    ).toEqual({ state: 'unavailable', reason: 'systemd is not available on this machine' });
    expect(
      planManagerProbe({
        selected: 'system',
        privileges: 'none',
        capabilities: { systemd: true, userManager: false },
        ownerName,
      }),
    ).toEqual({
      state: 'ask',
      command: ['systemctl', 'is-active', 'quotameter.service'],
      kind: 'system',
    });
  });

  it('never asks a --user manager from a privileged run, and only asks a reachable one', () => {
    expect(
      planManagerProbe({
        selected: 'user',
        privileges: 'held',
        capabilities: { systemd: true, userManager: true },
        ownerName,
      }).state,
    ).toBe('unavailable');
    expect(
      planManagerProbe({
        selected: 'user',
        privileges: 'none',
        capabilities: { systemd: true, userManager: false },
        ownerName,
      }),
    ).toEqual({
      state: 'unavailable',
      reason: 'the systemd user manager is not reachable in this session',
    });
    expect(
      planManagerProbe({
        selected: 'user',
        privileges: 'none',
        capabilities: { systemd: true, userManager: true },
        ownerName,
      }),
    ).toEqual({
      state: 'ask',
      command: ['systemctl', '--user', 'is-active', 'quotameter.service'],
      kind: 'user',
    });
  });
});

describe('describeManagerState', () => {
  it('omits the line for the skip plan and renders the binary contract otherwise', () => {
    expect(describeManagerState({ state: 'skip' }, undefined, false)).toEqual({
      line: null,
      incomplete: false,
    });
    expect(
      describeManagerState(
        { state: 'ask', command: ['systemctl'], kind: 'system' },
        { ok: true, detail: '' },
        false,
      ),
    ).toEqual({ line: 'active', incomplete: false });
    expect(
      describeManagerState(
        { state: 'ask', command: ['systemctl'], kind: 'user' },
        { ok: false, detail: '' },
        true,
      ),
    ).toEqual({ line: 'not active (user service)', incomplete: false });
    expect(describeManagerState({ state: 'unavailable', reason: 'why' }, undefined, false)).toEqual(
      { line: 'unknown (why)', incomplete: false },
    );
  });

  it('marks a command that could not answer unknown and incomplete (D-114)', () => {
    // A non-zero exit carrying a diagnostic (the spawn seam's error arm, or a
    // manager that cannot reach its bus) is a probe that did not answer —
    // never the negative fact "not active".
    expect(
      describeManagerState(
        { state: 'ask', command: ['systemctl'], kind: 'system' },
        { ok: false, detail: 'Failed to connect to bus' },
        false,
      ),
    ).toEqual({ line: 'unknown (Failed to connect to bus)', incomplete: true });
    expect(
      describeManagerState(
        { state: 'ask', command: ['systemctl'], kind: 'user' },
        { ok: false, detail: 'spawn systemctl ENOENT' },
        true,
      ),
    ).toEqual({ line: 'unknown (spawn systemctl ENOENT)', incomplete: true });
  });
});

describe("resolveAccountConfigured (§6.3, this invocation's environment)", () => {
  const env = { QUOTAMETER_TEST_KEY: 'set', EMPTY_KEY: '' } as const;

  it('resolves apiKey, a provided apiKeyEnv, and nothing else', () => {
    expect(resolveAccountConfigured({ apiKey: 'k' }, env)).toBe(true);
    expect(resolveAccountConfigured({ apiKeyEnv: 'QUOTAMETER_TEST_KEY' }, env)).toBe(true);
    expect(resolveAccountConfigured({ apiKeyEnv: 'MISSING_KEY' }, env)).toBe(false);
    expect(resolveAccountConfigured({ apiKeyEnv: 'EMPTY_KEY' }, env)).toBe(false);
    expect(resolveAccountConfigured({}, env)).toBe(false);
  });
});

describe('findLatestErrorRun (the newest non-success run)', () => {
  it('ignores successes and picks the newest failure by (started_at, id)', () => {
    const repository = fakeRepository([
      { outcome: 'success', startedAt: NOW, endedAt: NOW },
      { outcome: 'network_error', startedAt: NOW - 500, endedAt: NOW - 400 },
      { outcome: 'rate_limited', startedAt: NOW - 500, endedAt: NOW - 450, httpStatus: 429 },
    ]);
    const latest = findLatestErrorRun(repository, 'work');
    expect(latest?.outcome).toBe('rate_limited'); // same startedAt, higher id
    expect(latest?.httpStatus).toBe(429);
  });

  it('returns null when every run succeeded', () => {
    const repository = fakeRepository([{ outcome: 'success', startedAt: NOW, endedAt: NOW }]);
    expect(findLatestErrorRun(repository, 'work')).toBeNull();
  });
});

describe('formatStatusTimestamp (§10 discipline)', () => {
  it('renders the configured zone with its name, DST-correct', () => {
    expect(formatStatusTimestamp(NOW, 'Europe/Berlin')).toBe(BERLIN_NOW);
    expect(formatStatusTimestamp(NOW, 'Asia/Kolkata')).toBe('2025-11-01 17:56 (Asia/Kolkata)');
    expect(formatStatusTimestamp(NOW, 'UTC')).toBe('2025-11-01 12:26 (UTC)');
  });

  it('rejects a zone the configuration contract would reject', () => {
    expect(() => formatStatusTimestamp(NOW, 'Not/AZone')).toThrow(
      "'Not/AZone' is not a valid IANA time zone",
    );
  });
});

describe("redactSecrets (§7.4's exact-occurrence rule, mirrored)", () => {
  it('replaces every exact occurrence and ignores blank entries', () => {
    expect(redactSecrets(`a sk-1 b sk-1 c`, ['sk-1'])).toBe('a [REDACTED] b [REDACTED] c');
    expect(redactSecrets('a b', [''])).toBe('a b');
    expect(redactSecrets('nothing to do', ['sk-1'])).toBe('nothing to do');
  });
});

/* ── The production storage opener against real directories ─────────────── */

describe('openStatusStore (the production opener)', () => {
  it('reads a data directory without a database as absent', async () => {
    const dir = await createTempDir('qm-status-store-absent-');
    try {
      expect(await openStatusStore(dir.path)).toEqual({ state: 'absent' });
    } finally {
      await dir.remove();
    }
  });

  it('refuses a corrupt database file as failed, with the original message', async () => {
    const dir = await createTempDir('qm-status-store-corrupt-');
    try {
      await mkdir(dir.path, { recursive: true });
      await writeFile(join(dir.path, 'quotameter.sqlite'), 'definitely not a sqlite database');
      const store = await openStatusStore(dir.path);
      expect(store.state).toBe('failed');
      if (store.state === 'failed') {
        expect(store.detail).toContain('cannot configure database');
      }
    } finally {
      await dir.remove();
    }
  });
});
