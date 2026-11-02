import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigWithEnv, type ConfigEnvLoadResult } from '../../src/config/env';
import type { CliContext } from '../../src/cli/commands';
import {
  anyCheckFailed,
  authConsistencyCheck,
  authPendingProbeCheck,
  classifyBindError,
  classifyQuickCheck,
  clockCheck,
  openDoctorDatabase,
  parseTimedatectlShow,
  permissionsCheck,
  portCheck,
  probePortBinding,
  renderDoctorReport,
  runDoctorCommand,
  runTimedatectlShow,
  runtimeCheck,
  sqliteCheck,
  statConfigEntry,
  timezoneCheck,
  unitFreshnessCheck,
  type DoctorCheck,
  type DoctorDatabaseRead,
  type DoctorDeps,
  type EntryStat,
  type PortProbeOutcome,
  type TimedatectlRead,
} from '../../src/cli/doctor';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import type { ServiceLockRead } from '../../src/cli/service-reload';
import { buildSystemUnit } from '../../src/cli/systemd-unit';
import { buildUserUnit } from '../../src/cli/systemd-user-unit';
import type {
  CommandOutcome,
  ServiceCapabilities,
  ServiceExecPaths,
} from '../../src/cli/service-setup';
import type { QuotaProvider } from '../../src/providers/registry';
import type { Config } from '../../src/schemas/config';
import { openStorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import type { QuotaRepository } from '../../src/storage/repository';
import { createTempDir } from '../helpers/isolation';

/**
 * The `quotameter doctor` command handler (task 145, spec §5.5; decision
 * D-119) — the done-condition's matrix: every §5.5 check × every status of
 * the D-119 vocabulary (pass / fail / unavailable / skip), each rendered
 * actionably, beside the exit-code oracle (1 exactly when a check failed),
 * the `--raw` composition over the task-103 read path (D-067), and §15.4's
 * marker discipline (the configured key and password hash never appear; a
 * marker a hostile provider echoes back renders as `[REDACTED]`).
 *
 * Handler branches are seam-driven like the 139–144 suites (the container
 * and CI images ship no systemd, no timedatectl, and no quotameter
 * service); the production seams that ARE real here — the storage opener
 * against real temporary directories (a kernel-genuine absent file, a real
 * migrated database whose `PRAGMA quick_check` passes, a corrupt file the
 * §11.1 settings refuse) and the bind probe over real loopback sockets —
 * cover the arms the container can produce deterministically. The
 * real-launcher routes are pinned in `test/integration/cli-doctor.spec.ts`.
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

/** The §17.1 marker values (§15.4): configured, never rendered. */
const MARKER_KEY = 'qm-marker-key-t145';
const MARKER_HASH = 'qm-marker-hash-t145';

/** The manager-capability facts of a systemd machine (for the manager arms). */
const SYSTEMD: ServiceCapabilities = { systemd: true, userManager: true };

/** This installation's execution paths (the freshness comparison base). */
const EXEC_PATHS: ServiceExecPaths = {
  nodePath: '/usr/bin/node',
  cliPath: '/usr/local/bin/quotameter.mjs',
};

/** The §6.1 directories the generated system unit pins into ReadWritePaths. */
const EXPECTED_DIRS = { configDir: '/qm/test/config', dataDir: '/qm/test/data' };

/** The timedatectl read of a synchronized machine. */
const SYNCED: TimedatectlRead = { ok: true, stdout: 'NTPSynchronized=yes\nNTP=yes\n', detail: '' };

/** A stats double carrying exactly the fields the permission check reads. */
function statsFake(overrides: {
  mode?: number;
  uid?: number;
  kind?: 'dir' | 'file' | 'symlink';
}): Stats {
  const kind = overrides.kind ?? 'dir';
  return {
    mode: overrides.mode ?? 0o700,
    uid: overrides.uid ?? OWNER.uid,
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  } as unknown as Stats;
}

/** The ok-stat of an object with the given mode/uid/kind. */
function okStat(overrides: Parameters<typeof statsFake>[0]): EntryStat {
  return { state: 'ok', stats: statsFake(overrides) };
}

/* ── Pure-helper tables ────────────────────────────────────────────────── */

describe('renderDoctorReport (D-119 renderer)', () => {
  it('pins rows, tag alignment, detail indentation, and both summary lines', () => {
    const passing: readonly DoctorCheck[] = [
      { status: 'pass', summary: 'Node.js 22.13.0 (minimum 22.13.0)' },
      { status: 'skip', summary: 'no accounts configured' },
      { status: 'unavailable', summary: 'cannot determine' },
    ];
    expect(renderDoctorReport(passing, null)).toBe(
      [
        'Quotameter doctor',
        '',
        '  [pass]        Node.js 22.13.0 (minimum 22.13.0)',
        '  [skip]        no accounts configured',
        '  [unavailable] cannot determine',
        '',
        'No problems found (1 passed, 1 skipped, 1 unavailable).',
      ].join('\n'),
    );
    const failing: readonly DoctorCheck[] = [
      { status: 'fail', summary: 'problem one', detail: ['quotameter fix one'] },
      { status: 'fail', summary: 'problem two' },
    ];
    expect(renderDoctorReport(failing, null)).toBe(
      [
        'Quotameter doctor',
        '',
        '  [fail]        problem one',
        '                quotameter fix one',
        '  [fail]        problem two',
        '',
        '2 problems found — every [fail] row above names its next step.',
      ].join('\n'),
    );
    expect(renderDoctorReport([{ status: 'fail', summary: 'only' }], null)).toContain(
      '1 problem found — every [fail] row above names its next step.',
    );
  });

  it('appends the raw section after the summary when one is given', () => {
    const text = renderDoctorReport([{ status: 'pass', summary: 'ok' }], 'raw section text');
    expect(
      text.endsWith('No problems found (1 passed, 0 skipped, 0 unavailable).\n\nraw section text'),
    ).toBe(true);
  });

  it('anyCheckFailed is the exit-code oracle', () => {
    expect(
      anyCheckFailed([
        { status: 'pass', summary: '' },
        { status: 'skip', summary: '' },
      ]),
    ).toBe(false);
    expect(anyCheckFailed([{ status: 'unavailable', summary: '' }])).toBe(false);
    expect(anyCheckFailed([{ status: 'fail', summary: '' }])).toBe(true);
  });
});

describe('parseTimedatectlShow (spec §5.5, machine-readable show output)', () => {
  it('reads both boolean properties, case-insensitively', () => {
    expect(parseTimedatectlShow('NTPSynchronized=yes\nNTP=yes\n')).toEqual({
      synchronized: true,
      ntpActive: true,
    });
    expect(parseTimedatectlShow('NTPSynchronized=NO\nNTP=No\n')).toEqual({
      synchronized: false,
      ntpActive: false,
    });
  });

  it('reads absent keys and unrecognized values as undefined', () => {
    expect(parseTimedatectlShow('')).toEqual({ synchronized: undefined, ntpActive: undefined });
    expect(parseTimedatectlShow('NTPSynchronized=maybe\nTimezone=UTC\n')).toEqual({
      synchronized: undefined,
      ntpActive: undefined,
    });
    // The last occurrence wins, like any key=value stream.
    expect(parseTimedatectlShow('NTP=yes\nNTP=no\n')).toEqual({
      synchronized: undefined,
      ntpActive: false,
    });
  });
});

describe('runTimedatectlShow (production runner, real children)', () => {
  it('times out a wedged child and reads it as a failed command', async () => {
    const read = await runTimedatectlShow(
      [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
      100,
    );
    expect(read).toEqual({ ok: false, stdout: '', detail: 'timed out' });
  }, 10_000);
});

describe('clockCheck (spec §5.5, D-119 vocabulary)', () => {
  it('passes a synchronized, NTP-active machine', () => {
    expect(clockCheck(SYNCED)).toEqual({
      status: 'pass',
      summary: 'system clock synchronized, NTP service active',
    });
  });

  it('fails an unsynchronized machine with the set-ntp remedy', () => {
    expect(clockCheck({ ok: true, stdout: 'NTPSynchronized=no\nNTP=yes\n', detail: '' })).toEqual({
      status: 'fail',
      summary: 'system clock is not synchronized — timestamps and schedules depend on it',
      detail: ['sudo timedatectl set-ntp true'],
    });
  });

  it('fails a synchronized but NTP-inactive machine (drift risk)', () => {
    const check = clockCheck({ ok: true, stdout: 'NTPSynchronized=yes\nNTP=no\n', detail: '' });
    expect(check.status).toBe('fail');
    expect(check.summary).toContain('the clock will drift');
    expect(check.detail).toEqual(['sudo timedatectl set-ntp true']);
  });

  it('is unavailable when the command fails or the output is not recognizable', () => {
    const failed = clockCheck({
      ok: false,
      stdout: '',
      detail: 'System has not been booted with systemd',
    });
    expect(failed.status).toBe('unavailable');
    expect(failed.summary).toContain(
      'timedatectl failed (System has not been booted with systemd)',
    );
    const garbage = clockCheck({ ok: true, stdout: 'garbage output\n', detail: '' });
    expect(garbage.status).toBe('unavailable');
    expect(garbage.summary).toContain('output was not recognizable');
  });
});

describe('classifyQuickCheck (spec §5.5 quick_check verdict)', () => {
  it('a single ok row is health', () => {
    expect(classifyQuickCheck([{ quick_check: 'ok' }])).toEqual({ ok: true });
  });

  it('anything else is the problem list, stringified per row', () => {
    expect(
      classifyQuickCheck([
        { quick_check: 'row 5 missing from index events_pk' },
        { quick_check: 'ok' },
      ]),
    ).toEqual({
      ok: false,
      problems: ['row 5 missing from index events_pk', 'ok'],
    });
    expect(classifyQuickCheck([])).toEqual({ ok: false, problems: [] });
    expect(classifyQuickCheck(['freestanding'])).toEqual({ ok: false, problems: ['freestanding'] });
    expect(classifyQuickCheck([null])).toEqual({ ok: false, problems: ['null'] });
  });
});

describe('classifyBindError and portCheck (spec §5.5 port occupancy)', () => {
  it('classifies by errno', () => {
    expect(classifyBindError(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))).toEqual({
      state: 'in-use',
    });
    expect(classifyBindError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toEqual({
      state: 'denied',
      detail: 'denied',
    });
    expect(classifyBindError(Object.assign(new Error('away'), { code: 'EADDRNOTAVAIL' }))).toEqual({
      state: 'unbindable',
      detail: 'EADDRNOTAVAIL',
    });
    expect(classifyBindError(Object.assign(new Error('no name'), { code: 'ENOTFOUND' }))).toEqual({
      state: 'unbindable',
      detail: 'ENOTFOUND',
    });
    expect(classifyBindError(Object.assign(new Error('bad arg'), { code: 'EINVAL' }))).toEqual({
      state: 'unbindable',
      detail: 'EINVAL',
    });
    expect(classifyBindError(Object.assign(new Error('weird'), { code: 'EAGAIN' }))).toEqual({
      state: 'failed',
      detail: 'EAGAIN',
    });
    expect(classifyBindError(new Error('no code'))).toEqual({ state: 'failed', detail: 'no code' });
  });

  it('renders free, in-use (by the service or another process), denied, unbindable, failed', () => {
    expect(portCheck({ state: 'free' }, '127.0.0.1', 8787, false, false)).toEqual({
      status: 'pass',
      summary: '127.0.0.1:8787 is free — the service can bind it',
    });
    expect(portCheck({ state: 'in-use' }, '127.0.0.1', 8787, true, false)).toEqual({
      status: 'pass',
      summary: '127.0.0.1:8787 is in use by the running quotameter service',
    });
    const foreign = portCheck({ state: 'in-use' }, '0.0.0.0', 80, false, false);
    expect(foreign.status).toBe('fail');
    expect(foreign.summary).toContain('0.0.0.0:80 is already in use by another process');
    expect(
      portCheck({ state: 'denied', detail: 'EACCES' }, '127.0.0.1', 80, false, false).status,
    ).toBe('fail');
    const unbindable = portCheck(
      { state: 'unbindable', detail: 'EADDRNOTAVAIL' },
      '10.0.0.99',
      8787,
      false,
      false,
    );
    expect(unbindable.status).toBe('fail');
    expect(unbindable.summary).toContain(
      '10.0.0.99:8787 cannot be bound on this machine (EADDRNOTAVAIL)',
    );
    expect(unbindable.detail).toEqual(['Fix server.host or server.port in the configuration.']);
    expect(
      portCheck({ state: 'failed', detail: 'EAGAIN' }, '127.0.0.1', 8787, false, false).status,
    ).toBe('unavailable');
  });

  it('fails a privileged-port bind that only succeeds because this run holds privileges', () => {
    const check = portCheck({ state: 'free' }, '0.0.0.0', 80, false, true);
    expect(check.status).toBe('fail');
    expect(check.summary).toContain(
      "0.0.0.0:80 binds under this run's privileges, but the service runs as the unprivileged owner and cannot",
    );
    expect(check.detail).toEqual(['Pick an unprivileged port (>= 1024) in server.port.']);
    // An unprivileged port stays a plain pass even for a privileged run.
    expect(portCheck({ state: 'free' }, '0.0.0.0', 8080, false, true).status).toBe('pass');
  });
});

describe('runtimeCheck and sqliteCheck (spec §5.5 runtime checks)', () => {
  it('passes, fails below the minimum, and fails closed on an unparseable version', () => {
    expect(runtimeCheck('22.13.0', '22.13.0')).toEqual({
      status: 'pass',
      summary: 'Node.js 22.13.0 (minimum 22.13.0)',
    });
    const below = runtimeCheck('22.12.9', '22.13.0');
    expect(below.status).toBe('fail');
    expect(below.summary).toBe('Node.js 22.12.9 is below the minimum 22.13.0');
    expect(below.detail).toEqual([
      'Upgrade Node.js (for example via the official binaries or nvm) and try again.',
    ]);
    const garbage = runtimeCheck('not-a-version', '22.13.0');
    expect(garbage.status).toBe('fail');
    expect(garbage.summary).toContain('cannot determine the Node.js version');
  });

  it('renders the node:sqlite verdicts, with the derived minimum in the remedy', () => {
    expect(sqliteCheck(true, '22.13.0')).toEqual({
      status: 'pass',
      summary: 'node:sqlite is available',
    });
    const missing = sqliteCheck(false, '22.13.0');
    expect(missing.status).toBe('fail');
    expect(missing.summary).toContain('node:sqlite is not available');
    expect(missing.detail).toEqual([
      'Reinstall Node.js >= 22.13.0 from an official build (custom builds may omit it).',
    ]);
  });
});

describe('timezoneCheck (spec §5.5 through the clock module gate)', () => {
  it('passes a real IANA zone and fails anything else', () => {
    expect(timezoneCheck('Europe/Berlin')).toEqual({
      status: 'pass',
      summary: 'Europe/Berlin is a valid IANA time zone',
    });
    const invalid = timezoneCheck('Mars/Olympus_Mons');
    expect(invalid.status).toBe('fail');
    expect(invalid.summary).toContain('is not a valid IANA time zone');
  });
});

describe('authConsistencyCheck (spec §5.5, §15.1 — valid configurations)', () => {
  /** A defaults-completed configuration shape (D-018's invariant). */
  function config(overrides: {
    host?: string;
    port?: number;
    mode?: string;
    passwordHash?: string;
  }): Config {
    return {
      server: { host: overrides.host ?? '127.0.0.1', port: overrides.port ?? 8787 },
      app: { timezone: 'Europe/Berlin' },
      auth: {
        mode: (overrides.mode ?? 'auto') as 'auto' | 'required',
        passwordHash: overrides.passwordHash,
      },
      logging: { level: 'warn' },
      providers: {},
      accounts: [],
    } as Config;
  }

  it('renders the loopback-auto-no-password verdict and every password-set variant', () => {
    expect(authConsistencyCheck(config({})).summary).toBe(
      'loopback bind 127.0.0.1:8787 with auth.mode auto — no password required',
    );
    expect(authConsistencyCheck(config({ passwordHash: MARKER_HASH }))).toEqual({
      status: 'pass',
      summary: 'loopback bind 127.0.0.1:8787, auth.mode auto — a password is set',
    });
    expect(
      authConsistencyCheck(
        config({ host: '0.0.0.0', port: 9000, mode: 'required', passwordHash: 'h' }),
      ).summary,
    ).toBe('remote bind 0.0.0.0:9000, auth.mode required — a password is set');
    expect(authConsistencyCheck(config({ mode: 'required', passwordHash: 'h' })).summary).toBe(
      'loopback bind 127.0.0.1:8787, auth.mode required — a password is set',
    );
    // No output line ever contains the hash (§15.4).
    expect(authConsistencyCheck(config({ passwordHash: MARKER_HASH })).summary).not.toContain(
      MARKER_HASH,
    );
  });
});

describe('authPendingProbeCheck (spec §5.5, §15.1 — invalid configurations)', () => {
  it('a configuration whose only defect is the missing password gets the passwd remedy', () => {
    const pending = authPendingProbeCheck(
      { server: { host: '0.0.0.0' }, app: { timezone: 'Europe/Berlin' } },
      {},
    );
    expect(pending.status).toBe('fail');
    expect(pending.summary).toContain('a password is required');
    expect(pending.detail).toEqual(['Set one with: quotameter passwd']);
  });

  it("any further defect stays the Configuration row's problem list", () => {
    expect(
      authPendingProbeCheck(
        { server: { host: '0.0.0.0' }, app: { timezone: 'Mars/Olympus_Mons' } },
        {},
      ),
    ).toEqual({
      status: 'skip',
      summary: 'not checked — the configuration has other problems (see Configuration)',
    });
  });

  it("keeps environment overrides' precedence (a remote host from the environment)", () => {
    const pending = authPendingProbeCheck(
      { server: { host: '127.0.0.1' }, app: { timezone: 'Europe/Berlin' } },
      { QUOTAMETER_SERVER_HOST: '0.0.0.0' },
    );
    expect(pending.status).toBe('fail');
  });
});

describe('unitFreshnessCheck (spec §5.5, §5.4)', () => {
  /** A current system unit through the real generator. */
  function systemUnit(nodePath = EXEC_PATHS.nodePath): string {
    return buildSystemUnit({
      nodePath,
      cliPath: EXEC_PATHS.cliPath,
      user: OWNER.name,
      restartSecSeconds: 5,
      configDir: EXPECTED_DIRS.configDir,
      dataDir: EXPECTED_DIRS.dataDir,
    });
  }

  it('passes a current unit of either kind', () => {
    expect(unitFreshnessCheck(systemUnit(), 'system', EXEC_PATHS, EXPECTED_DIRS)).toEqual({
      status: 'pass',
      summary: 'system unit is current — Node/CLI paths and shape match this installation',
    });
    const userUnit = buildUserUnit({ ...EXEC_PATHS, restartSecSeconds: 5 });
    expect(unitFreshnessCheck(userUnit, 'user', EXEC_PATHS, EXPECTED_DIRS).status).toBe('pass');
  });

  it('fails a stale ExecStart with the §5.4 regeneration remedy', () => {
    const stale = unitFreshnessCheck(
      systemUnit('/opt/old-node/bin/node'),
      'system',
      EXEC_PATHS,
      EXPECTED_DIRS,
    );
    expect(stale.status).toBe('fail');
    expect(stale.summary).toContain('stale ExecStart');
    expect(stale.detail).toContain('Regenerate it with: sudo quotameter service install');
    const staleUser = unitFreshnessCheck(
      buildUserUnit({
        nodePath: '/opt/old-node/bin/node',
        cliPath: EXEC_PATHS.cliPath,
        restartSecSeconds: 5,
      }),
      'user',
      EXEC_PATHS,
      EXPECTED_DIRS,
    );
    expect(staleUser.detail).toContain('Regenerate it with: quotameter service install');
  });

  it('treats a spacing-only hand edit of a current ExecStart as fresh (token-exact)', () => {
    const spaced = systemUnit().replace(
      `ExecStart=${EXEC_PATHS.nodePath} ${EXEC_PATHS.cliPath} run`,
      `ExecStart=${EXEC_PATHS.nodePath}  ${EXEC_PATHS.cliPath}   run`,
    );
    expect(unitFreshnessCheck(spaced, 'system', EXEC_PATHS, EXPECTED_DIRS).status).toBe('pass');
  });

  it('fails parse problems and shape drift, with the problems as details', () => {
    const unparsable = unitFreshnessCheck(
      '[Service\nExecStart=broken\n',
      'user',
      EXEC_PATHS,
      EXPECTED_DIRS,
    );
    expect(unparsable.status).toBe('fail');
    expect(unparsable.summary).toContain('cannot be parsed');
    expect(unparsable.detail?.length).toBeGreaterThan(0);
    // Shape drift: a unit that parses and carries the current ExecStart but
    // diverges structurally elsewhere (here: a hardened-away directive).
    const drifted = systemUnit().replace('NoNewPrivileges=true\n', '');
    const check = unitFreshnessCheck(drifted, 'system', EXEC_PATHS, EXPECTED_DIRS);
    expect(check.status).toBe('fail');
    expect(check.summary).toContain('no longer matches the generated shape');
  });
});

describe('permissionsCheck (spec §5.5, §6.3 — diagnostic only)', () => {
  const DIR = '/qm/test/config';
  const FILE = '/qm/test/config/config.json';

  it('passes exact modes and owner', () => {
    expect(
      permissionsCheck(
        DIR,
        FILE,
        okStat({ mode: 0o700, kind: 'dir' }),
        okStat({ mode: 0o600, kind: 'file' }),
        OWNER.name,
        OWNER.uid,
      ),
    ).toEqual({
      status: 'pass',
      summary: 'configuration directory 0o700 and file 0o600, owned by alice',
    });
  });

  it('reports drifted modes with the chmod remedy, foreign ownership, and wrong types', () => {
    const drifted = permissionsCheck(
      DIR,
      FILE,
      okStat({ mode: 0o755, kind: 'dir' }),
      okStat({ mode: 0o644, kind: 'file' }),
      OWNER.name,
      OWNER.uid,
    );
    expect(drifted.status).toBe('fail');
    expect(drifted.detail).toEqual([
      `configuration directory ${DIR} has mode 0o755, expected 0o700 — run: chmod 700 ${DIR}`,
      `configuration file ${FILE} has mode 0o644, expected 0o600 — run: chmod 600 ${FILE}`,
    ]);
    const foreign = permissionsCheck(
      DIR,
      FILE,
      okStat({ mode: 0o700, kind: 'dir', uid: 0 }),
      okStat({ mode: 0o600, kind: 'file' }),
      OWNER.name,
      OWNER.uid,
    );
    expect(foreign.detail?.[0]).toContain(
      'owned by uid 0, but the service owner is alice (uid 1001)',
    );
    const symlinked = permissionsCheck(
      DIR,
      FILE,
      okStat({ mode: 0o700, kind: 'symlink' }),
      okStat({ mode: 0o600, kind: 'file' }),
      OWNER.name,
      OWNER.uid,
    );
    expect(symlinked.detail?.[0]).toContain('is a symbolic link');
    const wrongType = permissionsCheck(
      DIR,
      FILE,
      okStat({ mode: 0o700, kind: 'file' }),
      okStat({ mode: 0o600, kind: 'dir' }),
      OWNER.name,
      OWNER.uid,
    );
    expect(wrongType.detail?.[0]).toContain('is not a directory');
    expect(wrongType.detail?.[1]).toContain('is not a regular file');
  });

  it('skips when nothing is on disk and is unavailable when a stat fails', () => {
    expect(
      permissionsCheck(DIR, FILE, { state: 'absent' }, { state: 'absent' }, OWNER.name, OWNER.uid),
    ).toEqual({
      status: 'skip',
      summary: 'no configuration on disk yet — nothing to verify (see Configuration)',
    });
    const error = permissionsCheck(
      DIR,
      FILE,
      { state: 'error', detail: 'EACCES' },
      { state: 'absent' },
      OWNER.name,
      OWNER.uid,
    );
    expect(error).toEqual({
      status: 'unavailable',
      summary: 'cannot inspect the configuration paths (EACCES)',
    });
  });
});

/* ── Production seams against real files and sockets ───────────────────── */

describe('statConfigEntry (production stat seam)', () => {
  it('classifies ok and ENOENT-absent over real paths', async () => {
    const dir = await createTempDir('qm-doctor-stat-');
    try {
      const target = join(dir.path, 'entry');
      await writeFile(target, 'x', 'utf8');
      const ok = await statConfigEntry(target);
      expect(ok.state).toBe('ok');
      const absent = await statConfigEntry(join(dir.path, 'missing'));
      expect(absent).toEqual({ state: 'absent' });
    } finally {
      await dir.remove();
    }
  });

  it('classifies non-ENOENT failures as errors, never as absence', async () => {
    const dir = await createTempDir('qm-doctor-stat-eacces-');
    const locked = join(dir.path, 'locked');
    await mkdir(locked, { mode: 0o000 });
    try {
      const result = await statConfigEntry(join(locked, 'inside'));
      expect(result.state).toBe('error');
    } finally {
      // Restore traversability so the recursive remove works.
      const { chmod } = await import('node:fs/promises');
      await chmod(locked, 0o700);
      await dir.remove();
    }
  });
});

describe('probePortBinding (production bind probe, real sockets)', () => {
  /** An occupied loopback port: a server left listening for the probe. */
  function occupiedPort(): Promise<{ port: number; server: Server }> {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          throw new Error('expected a TCP address');
        }
        resolve({ port: address.port, server });
      });
    });
  }

  it('reports an occupied port as in-use and a free port as free', async () => {
    const { port, server } = await occupiedPort();
    try {
      await expect(probePortBinding('127.0.0.1', port)).resolves.toEqual({ state: 'in-use' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The port the server just released: retried once because another
    // process may legally re-bind it between close and probe.
    let outcome: PortProbeOutcome = await probePortBinding('127.0.0.1', port);
    if (outcome.state !== 'free') {
      outcome = await probePortBinding('127.0.0.1', port);
    }
    expect(outcome).toEqual({ state: 'free' });
  });

  it('classifies the privileged-port refusal as denied', async () => {
    const outcome = await probePortBinding('127.0.0.1', 23);
    // The container runs unprivileged, so binding 23 is refused — unless a
    // test environment somehow permits it, in which case it is free.
    expect(['denied', 'free', 'in-use']).toContain(outcome.state);
  });
});

describe('openDoctorDatabase (production opener, real directories)', () => {
  /** Seeds a real migrated database inside `dataDir`. */
  async function seedDatabase(dataDir: string): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const connection = openStorageConnection({ dataDir });
    try {
      await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
    } finally {
      connection.close();
    }
  }

  it('reads an empty data directory as absent', async () => {
    const dir = await createTempDir('qm-doctor-db-absent-');
    try {
      expect(await openDoctorDatabase(dir.path)).toEqual({ state: 'absent' });
    } finally {
      await dir.remove();
    }
  });

  it('opens a real migrated database and passes PRAGMA quick_check', async () => {
    const dir = await createTempDir('qm-doctor-db-open-');
    try {
      await seedDatabase(dir.path);
      const read = await openDoctorDatabase(dir.path);
      expect(read.state).toBe('open');
      if (read.state !== 'open') return;
      try {
        expect(classifyQuickCheck(read.runQuickCheck())).toEqual({ ok: true });
        expect(read.repository.listRawResponses('work', {})).toEqual([]);
      } finally {
        read.close();
      }
    } finally {
      await dir.remove();
    }
  });

  it('classifies a corrupt file as failed (the §11.1 settings refuse it)', async () => {
    const dir = await createTempDir('qm-doctor-db-corrupt-');
    try {
      await writeFile(join(dir.path, 'quotameter.sqlite'), 'definitely not a database\n', 'utf8');
      const read = await openDoctorDatabase(dir.path);
      expect(read.state).toBe('failed');
      if (read.state === 'failed') {
        expect(read.detail).toContain('cannot configure database');
      }
    } finally {
      await dir.remove();
    }
  });
});

/* ── The handler harness ───────────────────────────────────────────────── */

/** A genuine pipeline success over raw file input (the real load shape). */
function pipelineResult(
  fileInput: unknown,
  env: NodeJS.ProcessEnv = {},
): Extract<ConfigEnvLoadResult, { ok: true }> {
  const result = parseConfigWithEnv(fileInput, env);
  if (!result.ok) throw new Error('the pipeline rejected its own fixture');
  return { ...result, fileAbsent: false };
}

/** A minimal valid configuration body (loopback, Europe/Berlin). */
function validConfigInput(
  accounts: readonly unknown[] = [],
  auth: Record<string, unknown> = {},
): Record<string, unknown> {
  return { app: { timezone: 'Europe/Berlin' }, accounts: [...accounts], auth: { ...auth } };
}

/** One configured account (§6.2/§6.3 shape); spreads for overrides. */
function accountInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    apiKey: MARKER_KEY,
    ...overrides,
  };
}

/** A provider fake over just the §8.1 surface doctor uses. */
function fakeProvider(behavior: 'accept' | { reject: Error }): QuotaProvider {
  return {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    validateCredentials: async () => {
      if (behavior !== 'accept') throw behavior.reject;
    },
    fetchSnapshot: async () => {
      throw new Error('not used by doctor');
    },
  };
}

/** A provider-neutral rejection with the structural `kind` discriminant. */
function rejection(kind: 'credentials-rejected' | 'provider-unavailable', message: string): Error {
  return Object.assign(new Error(message), { kind });
}

/** An in-memory database read with a raw-payload listing fake. */
function openRead(
  quickCheck: () => unknown[],
  rawBodies: readonly string[] = [],
  listThrows?: Error,
): Extract<DoctorDatabaseRead, { state: 'open' }> & { readonly closedCount: number } {
  let closed = 0;
  const read: Extract<DoctorDatabaseRead, { state: 'open' }> & { closedCount: number } = {
    state: 'open',
    runQuickCheck: quickCheck,
    repository: {
      listRawResponses: (accountId: string) => {
        if (listThrows !== undefined) throw listThrows;
        return rawBodies.map((body, index) => ({
          runId: index + 1,
          accountId,
          capturedAt: 1_762_000_000_000 - index * 1000,
          httpStatus: 200,
          contentType: 'application/json',
          body,
        }));
      },
    } as unknown as QuotaRepository,
    close: () => {
      closed += 1;
    },
    get closedCount() {
      return closed;
    },
  };
  return read;
}

/** Everything the harness can preset; defaults describe a healthy machine. */
interface HarnessOptions {
  readonly owner?: ServiceOwnerContext;
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly ownerHome?: string;
  readonly config?: ConfigEnvLoadResult;
  readonly configText?: string;
  readonly configReadFails?: boolean;
  readonly statDir?: EntryStat | { readonly state: 'error'; readonly detail: string };
  readonly statFile?: EntryStat | { readonly state: 'error'; readonly detail: string };
  readonly nodeVersion?: string;
  readonly sqlite?: boolean;
  readonly database?: DoctorDatabaseRead;
  readonly lock?: ServiceLockRead;
  readonly alive?: boolean;
  /** A unit's presence: `false`/absent = none, `true` = on disk but unreadable, a string = its content. */
  readonly systemUnit?: string | boolean;
  readonly userUnit?: string | boolean;
  readonly capabilities?: ServiceCapabilities;
  readonly managerOutcome?: CommandOutcome;
  readonly provider?: QuotaProvider;
  readonly port?: PortProbeOutcome;
  readonly timedatectl?: TimedatectlRead;
  readonly rawFlag?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** The handler harness: recorded seams and captured output. */
function harness(options?: HarnessOptions): {
  readonly ctx: CliContext;
  out(): string;
  err(): string;
  readonly deps: DoctorDeps;
  databasesOpened(): readonly string[];
  portsProbed(): readonly { host: string; port: number }[];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const databases: string[] = [];
  const ports: { host: string; port: number }[] = [];
  const env: NodeJS.ProcessEnv = options?.env ?? PATH_ENV;
  const owner: PasswdEntry = { ...OWNER, home: options?.ownerHome ?? OWNER.home };
  const context: ServiceOwnerContext = options?.owner ?? { ...REGULAR, user: owner };
  const deps: DoctorDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return { state: 'ok', context };
    },
    pathEnv: env,
    validate: async (configPath) => {
      if (options?.config !== undefined) return options.config;
      // The bare-machine default: no configuration file exists (the
      // pipeline's pinned not-found message, task 064's contract).
      return { ok: false as const, problems: [`configuration file not found: ${configPath}`] };
    },
    readConfigText: async () => {
      if (options?.configReadFails) throw new Error('(EIO) read failed');
      return options?.configText ?? '';
    },
    statEntry: (target) =>
      target === PATH_ENV.QUOTAMETER_CONFIG_DIR
        ? Promise.resolve(options?.statDir ?? okStat({ mode: 0o700, kind: 'dir' }))
        : Promise.resolve(options?.statFile ?? okStat({ mode: 0o600, kind: 'file' })),
    nodeVersion: () => options?.nodeVersion ?? '22.13.0',
    minimumNodeVersion: async () => '22.13.0',
    probeSqlite: async () => options?.sqlite ?? true,
    openDatabase: async (dataDir) => {
      databases.push(dataDir);
      return options?.database ?? { state: 'absent' };
    },
    createProvider: () => options?.provider ?? fakeProvider('accept'),
    unitFileExists: (installPath) => {
      if (installPath === '/etc/systemd/system/quotameter.service') {
        return options?.systemUnit !== undefined && options.systemUnit !== false;
      }
      return options?.userUnit !== undefined && options.userUnit !== false;
    },
    readUnitFile: async (installPath) => {
      const content =
        installPath === '/etc/systemd/system/quotameter.service'
          ? options?.systemUnit
          : options?.userUnit;
      if (content === true) {
        throw new Error('(EACCES) unit unreadable');
      }
      return String(content);
    },
    execPaths: () => EXEC_PATHS,
    probeCapabilities: () => options?.capabilities ?? SYSTEMD,
    runCommand: async () => options?.managerOutcome ?? { ok: true, detail: '' },
    readLock: async () => options?.lock ?? { state: 'held', pid: 4321 },
    isAlive: () => options?.alive ?? true,
    probePort: async (host, port) => {
      ports.push({ host, port });
      return options?.port ?? { state: 'free' };
    },
    readTimedatectl: async () => options?.timedatectl ?? SYNCED,
  };
  const flags: Record<string, boolean | string> = {};
  if (options?.rawFlag !== undefined) {
    flags.raw = options.rawFlag;
  }
  return {
    ctx: {
      output: {
        out: (text: string) => void outLines.push(`${text}\n`),
        err: (text: string) => void errLines.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['doctor'],
      flags,
      positionals: [],
    },
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    deps,
    databasesOpened: () => [...databases],
    portsProbed: () => [...ports],
  };
}

/** Runs the handler once with the given harness options. */
async function runDoctor(
  options?: HarnessOptions,
): Promise<{ code: number; out: string; err: string }> {
  const h = harness(options);
  const code = await runDoctorCommand(h.deps)(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

describe('runDoctorCommand — the healthy machine (spec §5.5, D-119)', () => {
  const HEALTHY: HarnessOptions = {
    config: pipelineResult(validConfigInput()),
    lock: { state: 'held', pid: 4321 },
    alive: true,
    systemUnit: false,
    userUnit: false,
  };

  it('renders every check and exits 0 when nothing needs attention', async () => {
    const result = await runDoctor(HEALTHY);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Quotameter doctor');
    expect(result.out).toContain('[pass]        Node.js 22.13.0 (minimum 22.13.0)');
    expect(result.out).toContain('[pass]        node:sqlite is available');
    expect(result.out).toContain(`[pass]        valid at ${CONFIG_PATH}`);
    expect(result.out).toContain(
      '[pass]        configuration directory 0o700 and file 0o600, owned by alice',
    );
    expect(result.out).toContain('[pass]        Europe/Berlin is a valid IANA time zone');
    expect(result.out).toContain(
      '[skip]        no database yet — the service creates it on first start',
    );
    expect(result.out).toContain(
      '[skip]        no systemd unit installed — the service runs in the foreground with quotameter run',
    );
    expect(result.out).toContain(
      '[pass]        running in the foreground (pid 4321) — no systemd unit installed',
    );
    expect(result.out).toContain('[pass]        127.0.0.1:8787 is free — the service can bind it');
    expect(result.out).toContain(
      '[pass]        loopback bind 127.0.0.1:8787 with auth.mode auto — no password required',
    );
    expect(result.out).toContain(
      '[skip]        no accounts configured — add one with quotameter init or in the web UI',
    );
    expect(result.out).toContain('[pass]        system clock synchronized, NTP service active');
    expect(result.out).toContain('No problems found (9 passed, 3 skipped, 0 unavailable).');
  });

  it('probes the configured endpoint and opens the owner-scoped database', async () => {
    const h = harness(HEALTHY);
    await runDoctorCommand(h.deps)(h.ctx);
    expect(h.portsProbed()).toEqual([{ host: '127.0.0.1', port: 8787 }]);
    expect(h.databasesOpened()).toEqual([PATH_ENV.QUOTAMETER_DATA_DIR]);
  });

  it('reports the environment-only configuration with its provenance', async () => {
    const result = await runDoctor({
      ...HEALTHY,
      config: {
        ...pipelineResult(validConfigInput(), { QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' }),
        fileAbsent: true,
      },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `valid — from environment overrides, no configuration file (${CONFIG_PATH} would be used)`,
    );
  });
});

describe('runDoctorCommand — pre-flight failures', () => {
  it('exits 1 on owner problems, printing each verbatim, with no report', async () => {
    const result = await runDoctor({
      ownerProblems: ['cannot determine the uid of the running process'],
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter doctor: cannot determine the uid of the running process\n');
    expect(result.out).toBe('');
  });

  it('renders the broken-system throw as the standard failure line', async () => {
    const result = await runDoctor({ ownerThrows: new Error('EACCES: /etc/passwd') });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter doctor: resolving the service owner failed (EACCES: /etc/passwd)\n',
    );
  });

  it('exits 1 when the owner home cannot name the directories', async () => {
    const result = await runDoctor({ ownerHome: '/home/with space' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter doctor: resolving the service directories failed');
  });

  it('rejects a blank --raw account id with the correct spelling', async () => {
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), rawFlag: '  ' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter doctor: --raw needs an account id — for example: quotameter doctor --raw work\n',
    );
    expect(result.out).toBe('');
  });
});

/** Healthy defaults shared by the variants below. */
function HEALTHY_DEFAULTS(): HarnessOptions {
  return {
    config: pipelineResult(validConfigInput()),
    lock: { state: 'held', pid: 4321 },
    alive: true,
    systemUnit: false,
    userUnit: false,
  };
}

describe('runDoctorCommand — configuration row', () => {
  it('fails an absent configuration with the init next step', async () => {
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), config: undefined });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      `[fail]        no configuration file at ${CONFIG_PATH} — initialize first:`,
    );
    expect(result.out).toContain('                quotameter init');
    expect(result.out).toContain('1 problem found');
  });

  it('fails an invalid configuration with the pipeline problems, and the dependent rows skip', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: {
        ok: false,
        problems: ['app.timezone: missing required property', 'auth: a password is required'],
      },
      configText: '{"app":{"timezone":"Europe/Berlin"},"server":{"host":"0.0.0.0"}}',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('[fail]        invalid — the problems are:');
    expect(result.out).toContain('                app.timezone: missing required property');
    expect(result.out).toContain(
      '[skip]        not checked — the configuration is not usable (see Configuration)',
    );
    expect(result.out).toContain(
      '[skip]        accounts not checked — the configuration is not usable (see Configuration)',
    );
    // The §15.1 probe runs over this file: a remote host without a hash is
    // the pending state, so the auth row carries the passwd remedy.
    expect(result.out).toContain(
      'a password is required (auth.mode "required" or a non-loopback server.host)',
    );
  });
});

describe('runDoctorCommand — §15.1 probe through the invalid configuration', () => {
  it('names the passwd remedy when the missing password is the only defect', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: { ok: false, problems: ['auth: a password is required'] },
      configText: '{"app":{"timezone":"Europe/Berlin"},"server":{"host":"0.0.0.0"}}',
    });
    expect(result.out).toContain(
      'a password is required (auth.mode "required" or a non-loopback server.host)',
    );
    expect(result.out).toContain('                Set one with: quotameter passwd');
  });

  it('skips when the file cannot be read or parsed', async () => {
    const unreadable = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: {
        ok: false,
        problems: ['cannot read configuration file /qm/test/config/config.json: EIO'],
      },
      configReadFails: true,
    });
    expect(unreadable.out).toContain(
      'not checked — the configuration file could not be read or parsed (see Configuration)',
    );
    const unparsable = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: { ok: false, problems: ['invalid JSON: ...'] },
      configText: '{not json',
    });
    expect(unparsable.out).toContain(
      'not checked — the configuration file could not be read or parsed (see Configuration)',
    );
  });
});

describe('runDoctorCommand — permissions row', () => {
  it('fails drifted modes with the chmod remedies', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      statDir: okStat({ mode: 0o755, kind: 'dir' }),
      statFile: okStat({ mode: 0o640, kind: 'file' }),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`chmod 700 ${PATH_ENV.QUOTAMETER_CONFIG_DIR}`);
    expect(result.out).toContain(`chmod 600 ${CONFIG_PATH}`);
  });

  it('is unavailable when a stat fails loudly', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      statDir: { state: 'error', detail: 'EACCES' },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('[unavailable] cannot inspect the configuration paths (EACCES)');
  });
});

describe('runDoctorCommand — database row', () => {
  it('passes a healthy database and closes the handle', async () => {
    const read = openRead(() => [{ quick_check: 'ok' }]);
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), database: read });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      '[pass]        database opened read-only, PRAGMA quick_check passed',
    );
    expect(read.closedCount).toBe(1);
  });

  it('fails a failed open with the hot-journal hint and skips closing', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: { state: 'failed', detail: "cannot open database at 'x': (SQLITE_CANTOPEN)" },
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('[fail]        the database cannot be opened read-only');
    expect(result.out).toContain('its journal needs a writer');
  });

  it('fails quick_check problems and a throwing probe alike', async () => {
    const problems = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: openRead(() => [{ quick_check: 'row 3 missing from index runs_pk' }]),
    });
    expect(problems.code).toBe(1);
    expect(problems.out).toContain('PRAGMA quick_check reported problems');
    expect(problems.out).toContain('                row 3 missing from index runs_pk');
    const thrown = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: openRead(() => {
        throw new Error('database closed');
      }),
    });
    expect(thrown.code).toBe(1);
    expect(thrown.out).toContain('PRAGMA quick_check could not be executed');
    expect(thrown.out).toContain('database closed');
  });
});

describe('runDoctorCommand — service rows', () => {
  /** A current system unit through the real generator. */
  function currentSystemUnit(): string {
    return buildSystemUnit({
      nodePath: EXEC_PATHS.nodePath,
      cliPath: EXEC_PATHS.cliPath,
      user: OWNER.name,
      restartSecSeconds: 5,
      configDir: EXPECTED_DIRS.configDir,
      dataDir: EXPECTED_DIRS.dataDir,
    });
  }

  /** A current user unit through the real generator. */
  function currentUserUnit(): string {
    return buildUserUnit({ ...EXEC_PATHS, restartSecSeconds: 5 });
  }

  it('passes an installed, current, active system unit', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      systemUnit: currentSystemUnit(),
      managerOutcome: { ok: true, detail: '' },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      '[pass]        system unit is current — Node/CLI paths and shape match this installation',
    );
    expect(result.out).toContain('[pass]        the system service is active');
  });

  it('fails a stopped installed unit with the start next step (sudo for a regular user facing a system unit)', async () => {
    const regular = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      systemUnit: currentSystemUnit(),
      managerOutcome: { ok: false, detail: '' },
    });
    expect(regular.code).toBe(1);
    expect(regular.out).toContain('the system service is installed but not active — start it:');
    expect(regular.out).toContain('                sudo quotameter start');
    const held = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      owner: HELD,
      systemUnit: currentSystemUnit(),
      managerOutcome: { ok: false, detail: '' },
    });
    expect(held.out).toContain('                quotameter start');
  });

  it('renders an unknown manager state as unavailable, never a false not-active', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      systemUnit: currentSystemUnit(),
      managerOutcome: { ok: false, detail: 'Failed to connect to bus' },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      '[unavailable] the manager state is unknown (Failed to connect to bus)',
    );
  });

  it('fails a stale installed unit with the regeneration remedy', async () => {
    const stale = currentSystemUnit().replace(EXEC_PATHS.nodePath, '/opt/old/node');
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), systemUnit: stale });
    expect(result.code).toBe(1);
    expect(result.out).toContain('stale ExecStart');
    expect(result.out).toContain('Regenerate it with: sudo quotameter service install');
  });

  it('is unavailable when the installed unit cannot be read', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      systemUnit: true,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      '[unavailable] cannot read the installed system unit at /etc/systemd/system/quotameter.service ((EACCES) unit unreadable)',
    );
  });

  it('fails the both-installed mistake and skips the manager question', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      systemUnit: currentSystemUnit(),
      userUnit: currentUserUnit(),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('both a system unit and a user unit are installed');
    expect(result.out).toContain(
      '[skip]        not checked — two units are installed (see the Service unit row)',
    );
  });

  it('renders the foreground, stale, absent, and unreadable lock states of a unit-less machine', async () => {
    const stale = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      lock: { state: 'held', pid: 999 },
      alive: false,
    });
    expect(stale.out).toContain('not running — a stale lock names pid 999');
    const absent = await runDoctor({ ...HEALTHY_DEFAULTS(), lock: { state: 'absent' } });
    expect(absent.code).toBe(1);
    expect(absent.out).toContain('the service is neither installed nor running');
    expect(absent.out).toContain('                Install it: quotameter service install');
    const unreadable = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      lock: { state: 'unreadable', detail: 'EACCES' },
    });
    expect(unreadable.out).toContain('the service lock cannot be read (EACCES)');
    const invalid = await runDoctor({ ...HEALTHY_DEFAULTS(), lock: { state: 'invalid' } });
    expect(invalid.out).toContain('not a valid quotameter lock file');
  });

  it('passes a current, active user unit (and never asks a --user manager under sudo)', async () => {
    const regular = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      userUnit: currentUserUnit(),
      capabilities: SYSTEMD,
      managerOutcome: { ok: true, detail: '' },
    });
    expect(regular.code).toBe(0);
    expect(regular.out).toContain('the user service is active');
    const held = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      owner: HELD,
      userUnit: currentUserUnit(),
      capabilities: SYSTEMD,
      managerOutcome: { ok: true, detail: '' },
    });
    expect(held.code).toBe(0);
    expect(held.out).toContain(
      "[unavailable] the manager state is unknown (the user service manager belongs to alice's regular account — run quotameter status there, without sudo)",
    );
  });
});

describe('runDoctorCommand — port row', () => {
  it("fails a foreign occupation, passes the running service's, and renders refusals", async () => {
    const foreign = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      port: { state: 'in-use' },
      lock: { state: 'absent' },
      alive: false,
    });
    expect(foreign.code).toBe(1);
    expect(foreign.out).toContain('127.0.0.1:8787 is already in use by another process');
    const serviceHolds = await runDoctor({ ...HEALTHY_DEFAULTS(), port: { state: 'in-use' } });
    expect(serviceHolds.out).toContain(
      '127.0.0.1:8787 is in use by the running quotameter service',
    );
    const denied = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      port: { state: 'denied', detail: 'EACCES' },
    });
    expect(denied.code).toBe(1);
    expect(denied.out).toContain('binding 127.0.0.1:8787 was refused');
    const failed = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      port: { state: 'failed', detail: 'EINVAL' },
    });
    expect(failed.code).toBe(0);
    expect(failed.out).toContain('[unavailable] could not test 127.0.0.1:8787 (EINVAL)');
  });
});

describe('runDoctorCommand — per-account connectivity (§8.1 through the seam)', () => {
  it('passes an accepted key, fails a rejected one, and is unavailable for an inconclusive check', async () => {
    const accepted = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(validConfigInput([accountInput()])),
      provider: fakeProvider('accept'),
    });
    expect(accepted.out).toContain(
      "[pass]        the provider accepted the credentials for account 'Work plan'",
    );
    expect(accepted.code).toBe(0);

    const rejected = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(validConfigInput([accountInput()])),
      provider: fakeProvider({
        reject: rejection(
          'credentials-rejected',
          'the provider rejected the account credentials (HTTP 401)',
        ),
      }),
    });
    expect(rejected.code).toBe(1);
    expect(rejected.out).toContain(
      "[fail]        the provider rejected the credentials for account 'Work plan'",
    );
    expect(rejected.out).toContain(
      '                Replace the API key in the web UI or the configuration file.',
    );

    const inconclusive = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(validConfigInput([accountInput()])),
      provider: fakeProvider({ reject: rejection('provider-unavailable', 'fetch failed') }),
    });
    expect(inconclusive.code).toBe(0);
    expect(inconclusive.out).toContain(
      "[unavailable] could not verify account 'Work plan': fetch failed",
    );
  });

  it('skips disabled accounts and is honestly unavailable for an env key missing from this shell', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(
        validConfigInput([
          accountInput({ id: 'off', label: 'Off plan', enabled: false }),
          accountInput({ id: 'env', label: 'Env plan', apiKey: undefined, apiKeyEnv: 'ZAI_KEY' }),
        ]),
      ),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("[skip]        account 'Off plan' is disabled — not tested");
    expect(result.out).toContain(
      "[unavailable] account 'Env plan' reads its API key from environment variable 'ZAI_KEY', which is not set to a usable value in this shell — the service environment may hold it; not tested here",
    );
    // A whitespace-only value counts as unset (the D-011 blank rule).
    const blankEnv = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(
        validConfigInput([accountInput({ apiKey: undefined, apiKeyEnv: 'ZAI_KEY' })]),
      ),
      env: { ...PATH_ENV, ZAI_KEY: '   ' },
    });
    expect(blankEnv.out).toContain(
      "account 'Work plan' reads its API key from environment variable 'ZAI_KEY', which is not set to a usable value in this shell",
    );
  });

  it('guards the schema-valid-but-blank shapes the init flow already refuses (review P2)', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(
        validConfigInput([
          accountInput({ id: 'blank-label', label: ' ' }),
          accountInput({ id: 'blank-key', label: 'Blank key', apiKey: '   ' }),
        ]),
      ),
    });
    expect(result.code).toBe(1);
    // A blank label disables nothing but is named honestly; neither shape
    // throws — the report renders to its closing line.
    expect(result.out).toContain("account 'blank-label' (its label is blank)");
    expect(result.out).toContain(
      "[fail]        account 'blank-label' (its label is blank) — the label must not be blank; fix the configuration",
    );
    expect(result.out).toContain(
      "[fail]        account 'Blank key' has a blank API key — whitespace is never a credential",
    );
    expect(result.out).toContain('2 problems found');
  });

  it('never probes an account whose providerId this build does not carry (review P2)', async () => {
    let probes = 0;
    const countingProvider: QuotaProvider = {
      id: 'zai-coding-plan',
      name: 'Z.ai Coding Plan',
      validateCredentials: async () => {
        probes += 1;
      },
      fetchSnapshot: async () => {
        throw new Error('not used');
      },
    };
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(
        validConfigInput([accountInput({ id: 'other', providerId: 'some-other-provider' })]),
      ),
      provider: countingProvider,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "[fail]        account 'Work plan' names provider 'some-other-provider', but this build provides only 'zai-coding-plan'",
    );
    expect(probes).toBe(0);
  });

  it("resolves an env-sourced key from this invocation's environment and tests it", async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(
        validConfigInput([accountInput({ apiKey: undefined, apiKeyEnv: 'ZAI_KEY' })]),
      ),
      env: { ...PATH_ENV, ZAI_KEY: 'env-supplied-key' },
      provider: fakeProvider('accept'),
    });
    expect(result.out).toContain(
      "[pass]        the provider accepted the credentials for account 'Work plan'",
    );
  });
});

describe('runDoctorCommand — clock row', () => {
  it('fails an unsynchronized clock and stays honest when timedatectl is missing', async () => {
    const unsynced = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      timedatectl: { ok: true, stdout: 'NTPSynchronized=no\nNTP=yes\n', detail: '' },
    });
    expect(unsynced.code).toBe(1);
    expect(unsynced.out).toContain('[fail]        system clock is not synchronized');
    const missing = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      timedatectl: { ok: false, stdout: '', detail: 'spawn timedatectl ENOENT' },
    });
    expect(missing.code).toBe(0);
    expect(missing.out).toContain(
      '[unavailable] cannot determine the system clock state — timedatectl failed (spawn timedatectl ENOENT)',
    );
  });
});

describe('runDoctorCommand — --raw <account> (spec §7.4, D-067)', () => {
  it('appends the retained payloads after the checks, without changing the exit code', async () => {
    const read = openRead(
      () => [{ quick_check: 'ok' }],
      ['{"sanitized":"body-1"}', '{"sanitized":"body-2"}'],
    );
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), database: read, rawFlag: 'work' });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Sanitized raw responses for account 'work':");
    expect(result.out).toContain('Sanitized raw responses: 2 shown (newest first)');
    expect(result.out).toContain('  {"sanitized":"body-1"}');
    expect(read.closedCount).toBe(1);
  });

  it('renders the honest sentences for absent and failed databases', async () => {
    const absent = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: { state: 'absent' },
      rawFlag: 'work',
    });
    expect(absent.out).toContain(
      "Sanitized raw responses for account 'work': no database exists yet",
    );
    const failed = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: { state: 'failed', detail: 'corrupt' },
      rawFlag: 'work',
    });
    expect(failed.out).toContain('the database cannot be opened (see the Database row)');
  });

  it('renders the read-failure sentence when the listing throws, keeping the report (review P1)', async () => {
    const read = openRead(
      () => [{ quick_check: 'ok' }],
      [],
      new Error('no such table: raw_responses'),
    );
    const result = await runDoctor({ ...HEALTHY_DEFAULTS(), database: read, rawFlag: 'work' });
    // The report survived, the section states the failure, the handle closed.
    expect(result.out).toContain('Quotameter doctor');
    expect(result.out).toContain(
      "Sanitized raw responses for account 'work': the read failed (no such table: raw_responses) — see the Database row.",
    );
    expect(result.out).toContain('No problems found');
    expect(read.closedCount).toBe(1);
  });

  it('renders the none-retained sentence for an account without payloads', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      database: openRead(() => [{ quick_check: 'ok' }]),
      rawFlag: 'unknown-account',
    });
    expect(result.out).toContain('No sanitized raw responses retained.');
  });
});

describe('runDoctorCommand — §15.4 marker discipline', () => {
  it('never renders the configured key or password hash, and scrubs an echoed key', async () => {
    const result = await runDoctor({
      ...HEALTHY_DEFAULTS(),
      config: pipelineResult(validConfigInput([accountInput()], { passwordHash: MARKER_HASH })),
      provider: fakeProvider({
        // A contract-violating provider echoing the key back inside its
        // rejection: defense in depth must scrub it (§15.4).
        reject: rejection('credentials-rejected', `request failed with key ${MARKER_KEY}`),
      }),
    });
    expect(result.out).not.toContain(MARKER_KEY);
    expect(result.err).not.toContain(MARKER_KEY);
    expect(result.out).not.toContain(MARKER_HASH);
    expect(result.out).toContain('[REDACTED]');
  });
});
