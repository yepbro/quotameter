import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { STDERR_CAPTURE_CAP, writeUnitFileToDisk } from '../../src/cli/service-setup';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  appendCappedStderrChunk,
  buildJournalctlCommand,
  LOG_OUTPUT_FORMATS,
  LOGS_DEFAULT_LINES,
  LOGS_DEFAULT_OUTPUT,
  parseLogLines,
  parseLogOutputFormat,
  runJournalctlPassthrough,
  runLogsCommand,
  type LogViewerOutcome,
  type ServiceLogsDeps,
  type StderrCapture,
} from '../../src/cli/service-logs';
import type { ServiceLockRead } from '../../src/cli/service-reload';
import { userUnitInstallPath } from '../../src/cli/systemd-user-unit';
import { lockFilePath } from '../../src/server/single-instance';
import { withQuotameterEnv } from '../helpers/hermeticEnv';
import { createTempDir } from '../helpers/isolation';

/**
 * The `quotameter logs` command handler (task 143, spec §5.2/§16, decision
 * D-116) — the done-condition's matrix: the journalctl scope follows the
 * installed unit (system → `-u`, user → `--user -u`, both → D-108's
 * privileges rule with the cross-unit note, neither → the §5.2 next step or
 * the honest foreground-run answer from D-112's lock), the convenience
 * defaults render into the exact vector, and the streaming passthrough
 * forwards stdout raw while SIGINT/SIGTERM reach the child — an
 * interrupted follow is a success.
 *
 * The handler branches are seam-driven like the 139–142 suites (the
 * container and CI images ship no systemd and no journalctl); the
 * production runner IS real here — real child processes cover the stdout
 * forwarding, the exit-code/detail arms, and the missing-binary arm. The
 * signal-forwarding path needs a process whose SIGINT can be delivered
 * without taking the test runner down, so its real-child proof lives in
 * `test/integration/cli-service-logs.spec.ts` (the U-001 discipline), and
 * the handler-level interrupt arms run against the seam double below.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the unprivileged side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** A sudo invocation (the privileged side; the owner stays a regular account). */
const HELD: ServiceOwnerContext = { kind: 'sudo', privileges: 'held', user: OWNER };

/** The §6.1 overrides the harness resolves through; both under one root. */
const PATH_ENV = {
  QUOTAMETER_CONFIG_DIR: '/qm/test/config',
  QUOTAMETER_DATA_DIR: '/qm/test/data',
} as const;

/** The lock path the harness's data directory resolves to. */
const LOCK_PATH = '/qm/test/data/.quotameter.lock';

/** The user unit path the harness owner's home resolves to. */
const USER_UNIT_PATH = '/home/alice/.config/systemd/user/quotameter.service';

/** The exact default vectors the matrix builds on, byte-pinned here too. */
const SYSTEM_DEFAULT_COMMAND = [
  'journalctl',
  '--no-pager',
  `--lines=${LOGS_DEFAULT_LINES}`,
  `--output=${LOGS_DEFAULT_OUTPUT}`,
  '-u',
  'quotameter.service',
];
const USER_DEFAULT_COMMAND = [
  'journalctl',
  '--user',
  '--no-pager',
  `--lines=${LOGS_DEFAULT_LINES}`,
  `--output=${LOGS_DEFAULT_OUTPUT}`,
  '-u',
  'quotameter.service',
];

/** Which unit files the disk probe reports as installed. */
type InstalledUnits = 'system' | 'user' | 'both' | 'none';

/** The handler's harness: recorded seams and captured output. */
function harness(options?: {
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly owner?: ServiceOwnerContext;
  readonly ownerHome?: string;
  readonly installed?: InstalledUnits;
  readonly capabilities?: { readonly systemd: boolean; readonly userManager: boolean };
  readonly lock?: ServiceLockRead;
  readonly alive?: boolean;
  readonly viewer?: LogViewerOutcome;
  readonly flags?: Readonly<Record<string, boolean | string>>;
}): {
  readonly ctx: CliContext;
  out(): string;
  err(): string;
  lockReads(): readonly string[];
  viewerCommands(): readonly string[];
  readonly deps: ServiceLogsDeps;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const lockReads: string[] = [];
  const viewerCommands: string[][] = [];
  const deps: ServiceLogsDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return {
        state: 'ok',
        context:
          options?.ownerHome === undefined
            ? (options?.owner ?? REGULAR)
            : {
                kind: 'regular-user',
                privileges: 'none',
                user: { ...OWNER, home: options.ownerHome },
              },
      };
    },
    probeCapabilities: () => options?.capabilities ?? { systemd: true, userManager: true },
    unitFileExists: (installPath) => {
      const installed = options?.installed ?? 'none';
      if (installPath === '/etc/systemd/system/quotameter.service') {
        return installed === 'system' || installed === 'both';
      }
      return installPath === USER_UNIT_PATH && (installed === 'user' || installed === 'both');
    },
    pathEnv: PATH_ENV,
    readLock: async (lockPath) => {
      lockReads.push(lockPath);
      return options?.lock ?? { state: 'absent' };
    },
    isAlive: () => options?.alive ?? true,
    runViewer: async (command) => {
      viewerCommands.push([...command]);
      return options?.viewer ?? { ok: true, interrupted: false };
    },
  };
  return {
    ctx: {
      output: {
        out: (text: string) => void outLines.push(`${text}\n`),
        err: (text: string) => void errLines.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['logs'],
      flags: { ...(options?.flags ?? {}) },
      positionals: [],
    },
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    lockReads: () => lockReads,
    viewerCommands: () => viewerCommands.map((command) => command.join(' ')),
    deps,
  };
}

/** Runs the handler against a harness and captures the exit code. */
async function logs(
  h: ReturnType<typeof harness>,
): Promise<{ code: number; out: string; err: string }> {
  const code = await runLogsCommand(h.deps)(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

/* ── The flag parsers ──────────────────────────────────────────────────── */

describe('parseLogLines', () => {
  it('accepts whole numbers >= 1 and the all marker', () => {
    expect(parseLogLines('1')).toEqual({ ok: true, lines: 1 });
    expect(parseLogLines('50')).toEqual({ ok: true, lines: 50 });
    expect(parseLogLines(`${LOGS_DEFAULT_LINES}`)).toEqual({ ok: true, lines: 100 });
    expect(parseLogLines('9007199254740991')).toEqual({ ok: true, lines: 9007199254740991 });
    expect(parseLogLines('all')).toEqual({ ok: true, lines: 'all' });
  });

  it('rejects everything that is not a whole count >= 1 or all', () => {
    for (const value of ['0', '-5', '1.5', '1e3', 'abc', '', ' 5', '5 ', '9007199254740993']) {
      const outcome = parseLogLines(value);
      expect(outcome.ok, `--lines ${JSON.stringify(value)} is rejected`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.problem).toContain('--lines must be');
        expect(outcome.problem).toContain(JSON.stringify(value));
      }
    }
  });
});

describe('parseLogOutputFormat', () => {
  it('accepts every format of the closed enum', () => {
    for (const format of LOG_OUTPUT_FORMATS) {
      expect(parseLogOutputFormat(format)).toEqual({ ok: true, format });
    }
  });

  it('rejects anything else, listing the allowed values', () => {
    for (const value of ['bogus', 'SHORT-PRECISE', 'short_precise', '']) {
      const outcome = parseLogOutputFormat(value);
      expect(outcome.ok, `--output ${JSON.stringify(value)} is rejected`).toBe(false);
      if (!outcome.ok) {
        for (const format of LOG_OUTPUT_FORMATS) {
          expect(outcome.problem).toContain(format);
        }
        expect(outcome.problem).toContain(JSON.stringify(value));
      }
    }
  });
});

/* ── The journalctl vector ─────────────────────────────────────────────── */

describe('buildJournalctlCommand', () => {
  it('renders the system defaults exactly', () => {
    expect(
      buildJournalctlCommand({
        kind: 'system',
        follow: false,
        lines: 100,
        output: 'short-precise',
      }),
    ).toEqual(SYSTEM_DEFAULT_COMMAND);
  });

  it('renders the user defaults exactly, --user first', () => {
    expect(
      buildJournalctlCommand({ kind: 'user', follow: false, lines: 100, output: 'short-precise' }),
    ).toEqual(USER_DEFAULT_COMMAND);
  });

  it('places -f between the defaults and the unit match', () => {
    expect(
      buildJournalctlCommand({ kind: 'system', follow: true, lines: 100, output: 'short-precise' }),
    ).toEqual([
      'journalctl',
      '--no-pager',
      '--lines=100',
      '--output=short-precise',
      '-f',
      '-u',
      'quotameter.service',
    ]);
  });

  it('renders the all backlog and any accepted format', () => {
    expect(
      buildJournalctlCommand({ kind: 'user', follow: true, lines: 'all', output: 'cat' }),
    ).toEqual([
      'journalctl',
      '--user',
      '--no-pager',
      '--lines=all',
      '--output=cat',
      '-f',
      '-u',
      'quotameter.service',
    ]);
  });
});

/* ── The handler, seam by seam ─────────────────────────────────────────── */

describe('runLogsCommand (seam-driven matrix)', () => {
  it('reports owner problems and exits 1 before anything runs', async () => {
    const h = harness({ ownerProblems: ['problem one', 'problem two'], installed: 'system' });
    const result = await logs(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter logs: problem one\nquotameter logs: problem two\n');
    expect(h.viewerCommands()).toEqual([]);
    expect(h.lockReads()).toEqual([]);
  });

  it('renders the broken-system owner throw as one failure line', async () => {
    const h = harness({ ownerThrows: new Error('userdb unreadable'), installed: 'system' });
    const result = await logs(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter logs: resolving the service owner failed (userdb unreadable)\n',
    );
    expect(h.viewerCommands()).toEqual([]);
  });

  it('rejects a bad --lines value with the flag problem, before discovery', async () => {
    const h = harness({ installed: 'system', flags: { lines: '0' } });
    const result = await logs(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--lines must be');
    expect(h.viewerCommands()).toEqual([]);
  });

  it('rejects a bad --output value, before discovery', async () => {
    const h = harness({ installed: 'system', flags: { output: 'bogus' } });
    const result = await logs(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--output must be one of');
    expect(h.viewerCommands()).toEqual([]);
  });

  it('fails the unusable owner home when no system unit exists', async () => {
    const h = harness({ ownerHome: 'not absolute', installed: 'none' });
    const result = await logs(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('resolving the user unit path failed');
    expect(h.lockReads()).toEqual([]);
  });

  it('skips the unresolvable user unit beside an installed system unit (the 140 shape)', async () => {
    const h = harness({ ownerHome: 'not absolute', installed: 'system' });
    const result = await logs(h);
    expect(result.code).toBe(0);
    expect(h.viewerCommands()).toEqual([SYSTEM_DEFAULT_COMMAND.join(' ')]);
  });

  describe('nothing installed (the §5.2 next step and the foreground check)', () => {
    it('prints the install steps for an absent lock', async () => {
      const h = harness({ installed: 'none', lock: { state: 'absent' } });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toBe(
        'quotameter logs: no systemd service is installed — there is no journal to read\n',
      );
      expect(result.out).toContain('sudo quotameter service install');
      expect(result.out).toContain('quotameter service install');
      expect(result.out).toContain('quotameter run');
      expect(h.lockReads()).toEqual([LOCK_PATH]);
    });

    it('answers a live lock holder with the honest foreground-run guidance', async () => {
      const h = harness({ installed: 'none', lock: { state: 'held', pid: 4242 }, alive: true });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain('no systemd service is installed');
      expect(result.out).toContain('running in the foreground (pid 4242)');
      expect(result.out).toContain('nothing for this wrapper to show');
      expect(result.out).not.toContain('Or set everything up in one step');
    });

    it('treats a dead lock holder as nothing running (the plain install steps)', async () => {
      const h = harness({ installed: 'none', lock: { state: 'held', pid: 4242 }, alive: false });
      const result = await logs(h);
      expect(result.code).toBe(1);
      // No foreground run exists (the holder is dead): the guidance must
      // not claim one — the pid of the stale holder stays absent.
      expect(result.out).not.toContain('pid 4242');
      expect(result.out).toContain('Install the service');
    });

    it('adds one stderr line for an unreadable lock, keeping the steps', async () => {
      const h = harness({
        installed: 'none',
        lock: { state: 'unreadable', detail: 'EACCES' },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`reading the service lock ${LOCK_PATH} failed (EACCES)`);
      expect(result.out).toContain('Install the service');
    });

    it('adds one stderr line for an invalid lock, keeping the steps', async () => {
      const h = harness({ installed: 'none', lock: { state: 'invalid' } });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${LOCK_PATH} is not a valid quotameter lock file`);
      expect(result.out).toContain('Install the service');
    });

    it('reads the lock of the owner-scoped data directory (D-112 discipline)', async () => {
      const h = harness({ installed: 'none', lock: { state: 'absent' } });
      await logs(h);
      expect(h.lockReads()).toEqual([lockFilePath('/qm/test/data')]);
    });
  });

  describe('system unit installed', () => {
    it('streams the system vector and prints nothing of its own on success', async () => {
      const h = harness({ installed: 'system', viewer: { ok: true, interrupted: false } });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(result.out).toBe('');
      expect(result.err).toBe('');
      expect(h.viewerCommands()).toEqual([SYSTEM_DEFAULT_COMMAND.join(' ')]);
      expect(h.lockReads()).toEqual([]);
    });

    it('treats an interrupted run as success, equally silently', async () => {
      const h = harness({ installed: 'system', viewer: { ok: true, interrupted: true } });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(result.out).toBe('');
      expect(h.viewerCommands()).toHaveLength(1);
    });

    it('reads the system journal from a privileged run too (unprivileged query, D-105)', async () => {
      const h = harness({
        owner: HELD,
        installed: 'system',
        viewer: { ok: true, interrupted: false },
      });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(h.viewerCommands()).toEqual([SYSTEM_DEFAULT_COMMAND.join(' ')]);
    });

    it('fails honestly when systemd is absent', async () => {
      const h = harness({
        installed: 'system',
        capabilities: { systemd: false, userManager: false },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain("installed system service's journal cannot be read");
      expect(result.out).toContain('/etc/systemd/system/quotameter.service');
      expect(result.out).toContain('quotameter status');
      expect(h.viewerCommands()).toEqual([]);
    });

    it('reports the missing journalctl through the spawn arm', async () => {
      const h = harness({
        installed: 'system',
        viewer: { ok: false, spawnFailed: true, detail: 'spawn journalctl ENOENT' },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain('journalctl is not available (spawn journalctl ENOENT)');
      expect(result.out).toContain('ships with systemd');
      expect(result.out).toContain('quotameter status');
    });

    it('reports a failed read with the exact command and the sudo remedy', async () => {
      const h = harness({
        installed: 'system',
        viewer: { ok: false, spawnFailed: false, detail: 'No journal files were opened' },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        `\`${SYSTEM_DEFAULT_COMMAND.join(' ')}\` failed (No journal files were opened)`,
      );
      expect(result.out).toContain(`sudo ${SYSTEM_DEFAULT_COMMAND.join(' ')}`);
      expect(result.out).toContain('systemd-journal');
      expect(result.out).toContain('quotameter status');
    });

    it('rebuilds the remedy from the flags the user actually passed', async () => {
      const h = harness({
        installed: 'system',
        flags: { follow: true, lines: 'all', output: 'json' },
        viewer: { ok: false, spawnFailed: false, detail: 'No journal files were opened' },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        'sudo journalctl --no-pager --lines=all --output=json -f -u quotameter.service',
      );
      expect(result.out).not.toContain('short-precise');
    });
  });

  describe('user unit installed', () => {
    it('streams the user vector on success', async () => {
      const h = harness({ installed: 'user', viewer: { ok: true, interrupted: false } });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(result.out).toBe('');
      expect(h.viewerCommands()).toEqual([USER_DEFAULT_COMMAND.join(' ')]);
      expect(h.lockReads()).toEqual([]);
    });

    it('refuses a privileged run with the regular-account step, never a wrong query', async () => {
      const h = harness({
        owner: HELD,
        installed: 'user',
        viewer: { ok: true, interrupted: false },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain("user service's journal belongs to the regular account");
      expect(result.out).toContain('quotameter logs');
      expect(result.out).toContain("alice's");
      expect(h.viewerCommands()).toEqual([]);
    });

    it('fails honestly when systemd is absent (before the session question)', async () => {
      const h = harness({
        installed: 'user',
        capabilities: { systemd: false, userManager: false },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain("installed user service's journal cannot be read");
      expect(result.out).toContain(USER_UNIT_PATH);
      expect(h.viewerCommands()).toEqual([]);
    });

    it('fails honestly when the user manager is unreachable, naming the session command', async () => {
      const h = harness({
        installed: 'user',
        capabilities: { systemd: true, userManager: false },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain('systemd user manager is not reachable');
      expect(result.out).toContain(USER_UNIT_PATH);
      expect(result.out).toContain('journalctl --user -u quotameter.service');
      expect(h.viewerCommands()).toEqual([]);
    });

    it('reports a failed read with the user remedy (a login session, not sudo)', async () => {
      const h = harness({
        installed: 'user',
        viewer: { ok: false, spawnFailed: false, detail: 'Failed to get D-Bus connection' },
      });
      const result = await logs(h);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        `\`${USER_DEFAULT_COMMAND.join(' ')}\` failed (Failed to get D-Bus connection)`,
      );
      // The remedy is the exact command that ran — the user's flags carry
      // over, only the sudo prefix (never present for a user unit) differs.
      expect(result.out).toContain(`  ${USER_DEFAULT_COMMAND.join(' ')}`);
      expect(result.out).not.toContain('sudo journalctl');
    });
  });

  describe('both units installed (D-108 rule, the 139 warning)', () => {
    it('selects the user unit for a regular run and warns before streaming', async () => {
      const h = harness({ owner: REGULAR, installed: 'both' });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(result.err).toContain(
        'note: a system unit is also installed (/etc/systemd/system/quotameter.service)',
      );
      expect(result.err).toContain('only one should be installed');
      expect(h.viewerCommands()).toEqual([USER_DEFAULT_COMMAND.join(' ')]);
    });

    it('selects the system unit for a privileged run and warns', async () => {
      const h = harness({ owner: HELD, installed: 'both' });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(result.err).toContain('note: a user unit is also installed for alice');
      expect(h.viewerCommands()).toEqual([SYSTEM_DEFAULT_COMMAND.join(' ')]);
    });
  });

  describe('flags reach the vector', () => {
    it('renders --follow, --lines, and --output into the command', async () => {
      const h = harness({
        installed: 'system',
        flags: { follow: true, lines: '25', output: 'json-pretty' },
      });
      const result = await logs(h);
      expect(result.code).toBe(0);
      expect(h.viewerCommands()).toEqual([
        [
          'journalctl',
          '--no-pager',
          '--lines=25',
          '--output=json-pretty',
          '-f',
          '-u',
          'quotameter.service',
        ].join(' '),
      ]);
    });

    it('keeps the defaults when no flag is given', async () => {
      const h = harness({ installed: 'user' });
      await logs(h);
      expect(h.viewerCommands()).toEqual([USER_DEFAULT_COMMAND.join(' ')]);
    });
  });
});

/* ── The production default seams, in-process (the 139/140 pattern) ───── */

describe('runLogsCommand (production defaults)', () => {
  /**
   * The container and the CI runners ship no systemd and no quotameter
   * installation, so the default seams are exercised on the branches those
   * environments deterministically produce — the entry-evaluated seam
   * consts cover the `??` default arms the moment the command runs, before
   * any gate decides whether journalctl actually streams.
   */
  function recorder(): { ctx: CliContext; out(): string; err(): string } {
    const outLines: string[] = [];
    const errLines: string[] = [];
    return {
      ctx: {
        output: {
          out: (text: string) => void outLines.push(`${text}\n`),
          err: (text: string) => void errLines.push(`${text}\n`),
        },
        version: 'test',
        commandPath: ['logs'],
        flags: {},
        positionals: [],
      },
      out: () => outLines.join(''),
      err: () => errLines.join(''),
    };
  }

  it('no injection at all resolves the real owner, disk, and lock (nothing installed)', async () => {
    const dir = await createTempDir('qm-logs-defaults-absent-');
    try {
      const sink = recorder();
      await withQuotameterEnv(
        {
          QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
          QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
        },
        async () => {
          const code = await runLogsCommand()(sink.ctx);
          expect(code).toBe(1);
        },
      );
      expect(sink.err()).toBe(
        'quotameter logs: no systemd service is installed — there is no journal to read\n',
      );
      expect(sink.out()).toContain('quotameter service install');
    } finally {
      await dir.remove();
    }
  });

  it('a real lock naming this live process takes every default seam to the foreground answer', async () => {
    const dir = await createTempDir('qm-logs-defaults-foreground-');
    try {
      await mkdir(join(dir.path, 'data'), { recursive: true });
      await writeFile(
        join(dir.path, 'data', '.quotameter.lock'),
        `${JSON.stringify({ pid: process.pid, id: 'defaults' })}\n`,
      );
      const sink = recorder();
      await withQuotameterEnv(
        {
          QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
          QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
        },
        async () => {
          const code = await runLogsCommand()(sink.ctx);
          expect(code).toBe(1);
        },
      );
      expect(sink.err()).toBe(
        'quotameter logs: no systemd service is installed — there is no journal to read\n',
      );
      expect(sink.out()).toContain(`running in the foreground (pid ${process.pid})`);
    } finally {
      await dir.remove();
    }
  });

  it('a real user unit under a temp home reaches the real capability probe (managerless outcome)', async () => {
    const dir = await createTempDir('qm-logs-defaults-user-');
    try {
      const installPath = userUnitInstallPath(dir.path);
      await writeUnitFileToDisk(installPath, '# installed by an earlier quotameter\n');
      const sink = recorder();
      const code = await runLogsCommand({
        resolveOwner: () => ({
          state: 'ok',
          context: { kind: 'regular-user', privileges: 'none', user: { ...OWNER, home: dir.path } },
        }),
      })(sink.ctx);
      expect(code).toBe(1); // the systemd-less test environments
      expect(sink.err()).toBe(
        "quotameter logs: systemd is not available on this machine, so the installed user service's journal cannot be read here\n",
      );
      expect(sink.out()).toContain(installPath);
      expect(sink.out()).toContain('quotameter status');
    } finally {
      await dir.remove();
    }
  });
});

/* ── The bounded stderr capture (pure) ─────────────────────────────────── */

describe('appendCappedStderrChunk', () => {
  it('stores chunks whole while they fit under the cap', () => {
    const capture: StderrCapture = { chunks: [], size: 0 };
    appendCappedStderrChunk(capture, Buffer.from('first complaint\n'));
    appendCappedStderrChunk(capture, Buffer.from('second complaint\n'));
    expect(capture.chunks.map((chunk) => chunk.toString('utf8')).join('')).toBe(
      'first complaint\nsecond complaint\n',
    );
    expect(capture.size).toBe('first complaint\nsecond complaint\n'.length);
  });

  it('slices a chunk that crosses the cap and ignores everything after it', () => {
    const capture: StderrCapture = { chunks: [], size: 0 };
    const almostFull = 'x'.repeat(STDERR_CAPTURE_CAP - 4);
    appendCappedStderrChunk(capture, Buffer.from(almostFull));
    appendCappedStderrChunk(capture, Buffer.from('tail-of-the-flood'));
    appendCappedStderrChunk(capture, Buffer.from('long-ignored-tail'));
    expect(capture.size).toBe(STDERR_CAPTURE_CAP);
    expect(capture.chunks.at(-1)!.toString('utf8')).toBe('tail');
  });

  it('ignores chunks for a capture that is already at the cap', () => {
    const capture: StderrCapture = {
      chunks: [Buffer.alloc(STDERR_CAPTURE_CAP)],
      size: STDERR_CAPTURE_CAP,
    };
    appendCappedStderrChunk(capture, Buffer.from('late'));
    expect(capture.chunks).toHaveLength(1);
    expect(capture.size).toBe(STDERR_CAPTURE_CAP);
  });
});

/* ── The production passthrough runner, against real children ─────────── */

describe('runJournalctlPassthrough (real children)', () => {
  /**
   * Installs a recorder on this process's stdout (the cli-output.spec.ts
   * precedent) and runs `body` with an accessor for everything forwarded so
   * far; the spy is restored no matter the outcome. The runner's forwarding
   * is the thing under test, so its writes must be observable in-process.
   */
  async function withForwarding<T>(
    body: (forwarded: () => string) => Promise<T>,
  ): Promise<{ readonly result: T; readonly wrote: string }> {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const forwarded = (): string => spy.mock.calls.map((call) => String(call[0])).join('');
    try {
      const result = await body(forwarded);
      return { result, wrote: forwarded() };
    } finally {
      spy.mockRestore();
    }
  }

  it('forwards stdout raw, in order, and resolves ok for a clean exit', async () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      stdoutError: process.stdout.listenerCount('error'),
      stderrError: process.stderr.listenerCount('error'),
    };
    const { result, wrote } = await withForwarding(() =>
      runJournalctlPassthrough([
        process.execPath,
        '-e',
        'process.stdout.write("first line\\n"); process.stdout.write("second line\\n");',
      ]),
    );
    expect(result).toEqual({ ok: true, interrupted: false });
    // The child's two writes arrive as contiguous forwarded chunks — a
    // `toContain` on the joined stream keeps the assertion immune to any
    // interleaved runner chatter without weakening the order claim.
    expect(wrote).toContain('first line\nsecond line\n');
    // The signal forwarders and the stream-error listeners are gone once
    // the child closed.
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.stdout.listenerCount('error')).toBe(before.stdoutError);
    expect(process.stderr.listenerCount('error')).toBe(before.stderrError);
  });

  it('forwards a line split across child writes as-is, adding no newline of its own', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const outcome = await runJournalctlPassthrough([
        process.execPath,
        '-e',
        "process.stdout.write('first '); process.stdout.write('line\\n');",
      ]);
      expect(outcome).toEqual({ ok: true, interrupted: false });
      // Byte-exact passthrough of the content: the pipe may coalesce the
      // two child writes into one chunk, but nothing of OURS may appear —
      // no line reassembly, no re-splitting, no injected newline (a
      // line-buffering wrapper would turn this into two lines).
      const forwarded = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(forwarded).toBe('first line\n');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('resolves a non-zero exit with journalctl-style first stderr line as detail', async () => {
    const outcome = await runJournalctlPassthrough([
      process.execPath,
      '-e',
      'process.stderr.write("Could not read journal: permission denied\\nand more\\n"); process.exit(7);',
    ]);
    expect(outcome).toEqual({
      ok: false,
      spawnFailed: false,
      detail: 'Could not read journal: permission denied',
    });
  });

  it('flushes a non-empty captured stderr on a successful exit, adding nothing when empty', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        runJournalctlPassthrough([
          process.execPath,
          '-e',
          'process.stderr.write("journal file is corrupted, skipping\\n");',
        ]),
      ).resolves.toEqual({ ok: true, interrupted: false });
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toBe(
        'journal file is corrupted, skipping\n',
      );
      stderrSpy.mockClear();
      await expect(
        runJournalctlPassthrough([
          process.execPath,
          '-e',
          'process.stdout.write("only stdout\\n");',
        ]),
      ).resolves.toEqual({ ok: true, interrupted: false });
      expect(stderrSpy.mock.calls).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('falls back to the exit status when stderr stays empty', async () => {
    const outcome = await runJournalctlPassthrough([process.execPath, '-e', 'process.exit(3);']);
    expect(outcome).toEqual({ ok: false, spawnFailed: false, detail: 'exit status 3' });
  });

  it('caps the captured stderr without breaking on a flooded child', async () => {
    // More than STDERR_CAPTURE_CAP of stderr: the buffer stops growing, the
    // child still closes, and the detail stays the bounded first line.
    const outcome = await runJournalctlPassthrough([
      process.execPath,
      '-e',
      "process.stderr.write('first complaint\\n' + 'x'.repeat(64 * 1024) + '\\n'); process.exit(9);",
    ]);
    expect(outcome).toEqual({ ok: false, spawnFailed: false, detail: 'first complaint' });
  });

  it(
    'treats a closed output pipe (EPIPE) as an interrupted success',
    { timeout: 15_000 },
    async () => {
      // `quotameter logs | head` closes our stdout early: the EPIPE must
      // end the run like a Ctrl-C (child terminated, exit-0 outcome),
      // never crash the CLI on an unhandled stream error. The error event
      // is emitted on the stream directly — the same listener invocation
      // the kernel-driven EPIPE produces.
      const outcome = runJournalctlPassthrough([
        process.execPath,
        '-e',
        'setInterval(() => {}, 60_000);',
      ]);
      process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await expect(outcome).resolves.toEqual({ ok: true, interrupted: true });
    },
  );

  it('resolves a non-EPIPE stdout stream error as a failed run', async () => {
    const outcome = runJournalctlPassthrough([
      process.execPath,
      '-e',
      'setInterval(() => {}, 60_000);',
    ]);
    process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
    const resolved = await outcome;
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.spawnFailed).toBe(false);
      expect(resolved.detail).toBe('write EIO');
    }
  });

  it(
    'swallows EPIPE on stderr (nothing is left to report through) and ends via a forward',
    { timeout: 15_000 },
    async () => {
      const registrations = new Map<string, () => void>();
      const onSpy = vi.spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: never,
      ) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          registrations.set(event, listener as unknown as () => void);
        }
        return process;
      }) as unknown as typeof process.on);
      let outcome: Promise<LogViewerOutcome> | undefined;
      try {
        outcome = runJournalctlPassthrough([
          process.execPath,
          '-e',
          'setInterval(() => {}, 60_000);',
        ]);
        // The reporting pipe is gone too (`2>&1 | head`): the error is
        // swallowed, never crashing the run and never failing it.
        process.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      } finally {
        onSpy.mockRestore();
      }
      registrations.get('SIGINT')!();
      await expect(outcome).resolves.toEqual({ ok: true, interrupted: true });
    },
  );

  it('records a non-EPIPE stderr stream error as the failure detail', async () => {
    const outcome = runJournalctlPassthrough([
      process.execPath,
      '-e',
      'setInterval(() => {}, 60_000);',
    ]);
    process.stderr.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
    const resolved = await outcome;
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.detail).toBe('write EIO');
    }
  });

  it(
    'gates forwarding on the sink until it drains (backpressure)',
    { timeout: 15_000 },
    async () => {
      // A full sink (`write` returning false) must stop the forwarding
      // until `drain` fires — `--lines=all` over a slow pipe cannot queue
      // the whole journal in memory. The flood child stays alive while
      // gated (its own exit would resume the stream, as the runner
      // guarantees for `close`), so the gate itself is what holds.
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => false);
      let drainListener: (() => void) | undefined;
      const onceSpy = vi.spyOn(process.stdout, 'once').mockImplementation(((
        _event: string,
        listener: () => void,
      ) => {
        drainListener = listener;
        return process.stdout;
      }) as unknown as typeof process.stdout.once);
      let outcome: Promise<LogViewerOutcome> | undefined;
      try {
        outcome = runJournalctlPassthrough([
          process.execPath,
          '-e',
          "for (let i = 0; i < 200; i++) process.stdout.write('flood' + i + '\\n');" +
            'setTimeout(() => process.exit(0), 5000);',
        ]);
        // Wait until the first chunk was forwarded, then let the flood
        // finish behind the paused pipe: the gating must hold.
        const until = Date.now() + 5000;
        while (writeSpy.mock.calls.length === 0) {
          if (Date.now() >= until) throw new Error('the flood child never forwarded a chunk');
          await new Promise((wait) => setTimeout(wait, 25));
        }
        const gated = writeSpy.mock.calls.length;
        await new Promise((wait) => setTimeout(wait, 200));
        expect(writeSpy.mock.calls.length, 'forwarding is gated while the sink is full').toBe(
          gated,
        );
        expect(drainListener, 'a drain listener was registered').toBeDefined();
        // Drain with the sink still reporting full: the next chunk pauses
        // again and REPLACES the pending drain listener (one at a time).
        const firstDrain = drainListener!;
        firstDrain();
        const untilReplaced = Date.now() + 5000;
        while (drainListener === firstDrain) {
          if (Date.now() >= untilReplaced) {
            throw new Error('the re-pause never registered a second drain listener');
          }
          await new Promise((wait) => setTimeout(wait, 25));
        }
        writeSpy.mockImplementation(() => true);
        drainListener!();
      } finally {
        onceSpy.mockRestore();
      }
      const resolved = await outcome!;
      expect(resolved).toEqual({ ok: true, interrupted: false });
      // Ungated forwarding resumed and delivered the whole flood. The
      // invariant is content, not a write count: under load the OS pipe
      // coalesces the 1.6 KB flood into as few as two chunks (the second
      // consumed by the re-pause read at the listener-replacement wait
      // above), so "more than two writes happened" is a chunking
      // assumption, not a resumption fact — joining the forwarded calls
      // and requiring both ends of the flood holds under any chunking
      // (a split mid-line still joins).
      const delivered = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(delivered).toContain('flood0');
      expect(delivered).toContain('flood199');
      writeSpy.mockRestore();
    },
  );

  it(
    'reports a child terminated without our forwarding as a failed run',
    { timeout: 15_000 },
    async () => {
      const { result } = await withForwarding(async (forwarded) => {
        const outcome = runJournalctlPassthrough([
          process.execPath,
          '-e',
          "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 60_000);",
        ]);
        // Wait for the grandchild's pid line to be forwarded (the U-001
        // discipline: nothing signals it before it announces itself).
        const until = Date.now() + 5000;
        let pid: number | undefined;
        for (;;) {
          const match = forwarded().match(/^(\d+)\s*$/m);
          if (match !== null) {
            pid = Number(match[1]);
            break;
          }
          if (Date.now() >= until) {
            throw new Error('the grandchild never announced its pid');
          }
          await new Promise((wait) => setTimeout(wait, 25));
        }
        process.kill(pid!, 'SIGKILL');
        return outcome;
      });
      expect(result).toEqual({
        ok: false,
        spawnFailed: false,
        detail: 'the command was terminated',
      });
    },
  );

  it(
    'forwards a signal to the child through the registered handler and ends the run as interrupted',
    { timeout: 15_000 },
    async () => {
      // The forwarder is what a real SIGINT to this process would invoke;
      // calling the registered handler directly proves the same closure
      // (child.kill with the received signal, the interrupted latch)
      // without signalling the test runner's own process — the full
      // process-signal path (kernel SIGINT → handler → child) is the
      // driver child's proof in the integration suite.
      const registrations = new Map<string, () => void>();
      // Capture the runner's signal registrations instead of dropping
      // them; everything else `process.on` receives during the window
      // passes through untouched (none is expected — the runner registers
      // exactly its two forwarders synchronously on call).
      const onSpy = vi.spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: never,
      ) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          registrations.set(event, listener as unknown as () => void);
        }
        return process;
      }) as unknown as typeof process.on);
      let outcome: Promise<LogViewerOutcome> | undefined;
      try {
        outcome = runJournalctlPassthrough([
          process.execPath,
          '-e',
          'setInterval(() => {}, 60_000);',
        ]);
      } finally {
        onSpy.mockRestore();
      }
      const handler = registrations.get('SIGINT');
      expect(handler, 'the runner registered a SIGINT forwarder').toBeDefined();
      expect(
        registrations.get('SIGTERM'),
        'the runner registered a SIGTERM forwarder',
      ).toBeDefined();
      handler!();
      await expect(outcome).resolves.toEqual({ ok: true, interrupted: true });
    },
  );

  it(
    'escalates a second signal to SIGKILL for a child that ignores the first',
    { timeout: 15_000 },
    async () => {
      // A wedged child must not hold the terminal hostage: the second
      // Ctrl-C force-kills it and still resolves as an interrupted run.
      // The grandchild swallows SIGINT (a stuck-tool shape) and records
      // nothing — only SIGKILL can end it.
      const registrations = new Map<string, () => void>();
      const onSpy = vi.spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: never,
      ) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          registrations.set(event, listener as unknown as () => void);
        }
        return process;
      }) as unknown as typeof process.on);
      let outcome: Promise<LogViewerOutcome> | undefined;
      try {
        outcome = runJournalctlPassthrough([
          process.execPath,
          '-e',
          "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});" +
            'setInterval(() => {}, 60_000);',
        ]);
      } finally {
        onSpy.mockRestore();
      }
      const handler = registrations.get('SIGINT')!;
      handler();
      handler();
      await expect(outcome).resolves.toEqual({ ok: true, interrupted: true });
    },
  );

  it('resolves the missing binary through the spawn arm with the errno detail', async () => {
    const outcome = await runJournalctlPassthrough([
      'quotameter-definitely-missing-binary-143',
      '--version',
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.spawnFailed).toBe(true);
      expect(outcome.detail).toContain('ENOENT');
    }
  });
});
