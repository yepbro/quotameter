import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { parseConfigWithEnv } from '../../src/config/env';
import type { ConfigEnvLoadResult } from '../../src/config/env';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  classifySignalFailure,
  parseServiceLockPid,
  readServiceLock,
  runReloadCommand,
  sendSighup,
  type ServiceLockRead,
  type ServiceReloadDeps,
  type SignalDelivery,
} from '../../src/cli/service-reload';
import { withQuotameterEnv } from '../helpers/hermeticEnv';
import { createTempDir } from '../helpers/isolation';
import { createSingleInstanceLock, lockFilePath } from '../../src/server/single-instance';

/**
 * The `quotameter reload` command handler (task 141, spec §5.2/§6.4, decision
 * D-112) — the done-condition's matrix: the running service is discovered
 * through the §5.6 single-instance lock (absent / stale / unreadable /
 * invalid each report "not running" or a loud failure, never a signal at a
 * guess), the accepted/rejected answer comes from re-running the load
 * pipeline in-process, and SIGHUP is delivered only for a validated
 * configuration — a rejected file is reported with its problems and no
 * signal, because §6.2 pins the service-side consequence (keep the last
 * valid configuration) as a guaranteed no-op.
 *
 * The handler branches are seam-driven like the 139/140 suites (the
 * container and CI images ship no systemd and no quotameter service); the
 * production seams that ARE real here — the lock reader against real
 * directories (including a kernel-genuine `EACCES`), the signal sender
 * against real child processes (delivery, and `ESRCH` for a reaped pid),
 * and the pure errno classifier — cover the arms the container can produce
 * deterministically. The real-launcher routes, including a real SIGHUP to a
 * real child, are pinned in `test/integration/cli-service-reload.spec.ts`.
 */

/** Representative owner; a regular account, never root (D-105 guarantees it). */
const OWNER: PasswdEntry = { name: 'alice', uid: 1001, gid: 1001, home: '/home/alice' };

/** A regular-user invocation (the unprivileged side of the matrix). */
const REGULAR: ServiceOwnerContext = { kind: 'regular-user', privileges: 'none', user: OWNER };

/** The §6.1 overrides the harness resolves through; both under one root. */
const PATH_ENV = {
  QUOTAMETER_CONFIG_DIR: '/qm/test/config',
  QUOTAMETER_DATA_DIR: '/qm/test/data',
} as const;

/** The lock path the harness's data directory resolves to. */
const LOCK_PATH = '/qm/test/data/.quotameter.lock';

/** The configuration path the harness's config directory resolves to. */
const CONFIG_PATH = '/qm/test/config/config.json';

/**
 * A genuine pipeline success (env-only mode: the mandatory `app.timezone`
 * arrives from the environment, §6.3/D-023 — `parseConfig` never defaults
 * it) — the validate seam must return the real shape, not a cast.
 */
function pipelineOk(): Extract<ConfigEnvLoadResult, { ok: true }> {
  const result = parseConfigWithEnv({}, { QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' });
  if (!result.ok) throw new Error('the pipeline rejected its own env-only defaults');
  return { ...result, fileAbsent: true };
}

/** The handler's harness: recorded seams and captured output. */
function harness(options?: {
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly ownerHome?: string;
  readonly lock?: ServiceLockRead;
  readonly alive?: boolean;
  readonly problems?: readonly string[];
  readonly delivery?: SignalDelivery;
  readonly pathEnv?: NodeJS.ProcessEnv;
}): {
  readonly ctx: CliContext;
  out(): string;
  err(): string;
  lockReads(): readonly string[];
  validated(): readonly { configPath: string; env: NodeJS.ProcessEnv }[];
  signals(): readonly number[];
  readonly deps: ServiceReloadDeps;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const lockReads: string[] = [];
  const validated: { configPath: string; env: NodeJS.ProcessEnv }[] = [];
  const signals: number[] = [];
  const pathEnv: NodeJS.ProcessEnv = options?.pathEnv ?? PATH_ENV;
  const deps: ServiceReloadDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return {
        state: 'ok',
        context:
          options?.ownerHome === undefined
            ? REGULAR
            : {
                kind: 'regular-user',
                privileges: 'none',
                user: { ...OWNER, home: options.ownerHome },
              },
      };
    },
    pathEnv,
    readLock: async (lockPath) => {
      lockReads.push(lockPath);
      return options?.lock ?? { state: 'held', pid: 4242 };
    },
    isAlive: () => options?.alive ?? true,
    validate: async (configPath, env) => {
      validated.push({ configPath, env });
      if (options?.problems !== undefined) {
        return { ok: false as const, problems: [...options.problems] };
      }
      return pipelineOk();
    },
    deliverSignal: (pid) => {
      signals.push(pid);
      return options?.delivery ?? { delivered: true as const };
    },
  };
  return {
    ctx: {
      output: {
        out: (text: string) => void outLines.push(`${text}\n`),
        err: (text: string) => void errLines.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['reload'],
      flags: {},
      positionals: [],
    },
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    lockReads: () => lockReads,
    validated: () => validated,
    signals: () => signals,
    deps,
  };
}

/** Runs the handler against a harness and captures the exit code. */
async function reload(
  h: ReturnType<typeof harness>,
): Promise<{ code: number; out: string; err: string }> {
  const code = await runReloadCommand(h.deps)(h.ctx);
  return { code, out: h.out(), err: h.err() };
}

/* ── The lock payload mirror ───────────────────────────────────────────── */

describe('parseServiceLockPid (the §5.6 lock payload, mirrored)', () => {
  it('extracts the holder pid of a genuine lock payload', () => {
    expect(parseServiceLockPid(`${JSON.stringify({ pid: 4242, id: 'token' })}\n`)).toBe(4242);
    expect(parseServiceLockPid('{"pid":1}')).toBe(1);
  });

  it('rejects pids that are not positive integers', () => {
    expect(parseServiceLockPid('{"pid":0}')).toBeNull();
    expect(parseServiceLockPid('{"pid":-3}')).toBeNull();
    expect(parseServiceLockPid('{"pid":1.5}')).toBeNull();
    expect(parseServiceLockPid('{"pid":"9"}')).toBeNull();
    expect(parseServiceLockPid('{"pid":null}')).toBeNull();
  });

  it('rejects payloads without a pid and everything that is not an object', () => {
    expect(parseServiceLockPid('{"id":"token"}')).toBeNull();
    expect(parseServiceLockPid('null')).toBeNull();
    expect(parseServiceLockPid('"text"')).toBeNull();
    expect(parseServiceLockPid('[1]')).toBeNull();
  });

  it('rejects damaged content', () => {
    expect(parseServiceLockPid('not json')).toBeNull();
    expect(parseServiceLockPid('')).toBeNull();
  });
});

/* ── The production lock reader ────────────────────────────────────────── */

describe('readServiceLock (real filesystem)', () => {
  it('classifies a missing lock as absent', async () => {
    const dir = await createTempDir('qm-reload-lock-absent-');
    try {
      expect(await readServiceLock(join(dir.path, '.quotameter.lock'))).toEqual({
        state: 'absent',
      });
    } finally {
      await dir.remove();
    }
  });

  it('extracts the holder pid of a written lock', async () => {
    const dir = await createTempDir('qm-reload-lock-held-');
    try {
      const lockPath = join(dir.path, '.quotameter.lock');
      await writeFile(lockPath, `${JSON.stringify({ pid: 7777, id: 't' })}\n`);
      expect(await readServiceLock(lockPath)).toEqual({ state: 'held', pid: 7777 });
    } finally {
      await dir.remove();
    }
  });

  it('classifies damaged content as invalid', async () => {
    const dir = await createTempDir('qm-reload-lock-invalid-');
    try {
      const lockPath = join(dir.path, '.quotameter.lock');
      await writeFile(lockPath, 'damaged');
      expect(await readServiceLock(lockPath)).toEqual({ state: 'invalid' });
    } finally {
      await dir.remove();
    }
  });

  it('reads back a lock the landed writer actually acquired (the mirror pin)', async () => {
    // Review-round P3: the parse mirror's lockstep with
    // `src/server/single-instance.ts` must be executable, not prose — the
    // real `createSingleInstanceLock` publishes the payload, and this
    // module's reader must classify it as held with the acquiring pid.
    // Read-only use of the landed module; no `src/server/**` file changes.
    const dir = await createTempDir('qm-reload-lock-writer-');
    const lock = createSingleInstanceLock({ dataDir: dir.path });
    try {
      await lock.start();
      expect(await readServiceLock(lockFilePath(dir.path))).toEqual({
        state: 'held',
        pid: process.pid,
      });
    } finally {
      await lock.stop();
      await dir.remove();
    }
  });

  it('classifies an unreadable directory as unreadable with the errno detail', async () => {
    const dir = await createTempDir('qm-reload-lock-eacces-');
    try {
      const data = join(dir.path, 'data');
      await mkdir(data, { mode: 0o700 });
      await chmod(data, 0o000);
      const outcome = await readServiceLock(join(data, '.quotameter.lock'));
      expect(outcome.state).toBe('unreadable');
      expect((outcome as { detail: string }).detail).toContain('EACCES');
    } finally {
      await chmod(join(dir.path, 'data'), 0o700).catch(() => undefined);
      await dir.remove();
    }
  });
});

/* ── The signal sender and its classifier ──────────────────────────────── */

describe('classifySignalFailure', () => {
  it('maps ESRCH to the no-process arm', () => {
    const error = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    expect(classifySignalFailure(error)).toEqual({
      delivered: false,
      reason: 'no-process',
      detail: 'kill ESRCH',
    });
  });

  it('maps EPERM to the permission arm', () => {
    const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    expect(classifySignalFailure(error)).toEqual({
      delivered: false,
      reason: 'permission',
      detail: 'kill EPERM',
    });
  });

  it('maps every other failure to the generic arm', () => {
    expect(classifySignalFailure(new Error('kill EINVAL'))).toEqual({
      delivered: false,
      reason: 'failure',
      detail: 'kill EINVAL',
    });
    expect(classifySignalFailure('boom')).toEqual({
      delivered: false,
      reason: 'failure',
      detail: 'boom',
    });
  });
});

describe('sendSighup (real processes)', () => {
  /** Spawns a child that survives SIGHUP and says it is ready. */
  function hupProofChild(): Promise<{ pid: number; stop(): void }> {
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGHUP', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60_000);",
    ]);
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.once('data', () =>
        resolve({ pid: child.pid!, stop: () => child.kill('SIGKILL') }),
      );
    });
  }

  it('delivers SIGHUP to a live same-uid process', { timeout: 20_000 }, async () => {
    const child = await hupProofChild();
    try {
      expect(sendSighup(child.pid)).toEqual({ delivered: true });
    } finally {
      child.stop();
    }
  });

  it('classifies a reaped pid as no-process', { timeout: 20_000 }, async () => {
    const child = await hupProofChild();
    const pid = child.pid;
    child.stop();
    await new Promise<void>((resolve, reject) => {
      // Review-round P3 shape: the liveness read and the deadline check are
      // separate decisions, so a stuck child rejects the wait loudly instead
      // of resolving through the kill() catch.
      const until = Date.now() + 5000;
      const poll = (): void => {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (!alive) return resolve();
        if (Date.now() >= until) {
          return reject(new Error('the killed child did not exit within the wait'));
        }
        setTimeout(poll, 25);
      };
      poll();
    });
    const outcome = sendSighup(pid);
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('no-process');
  });
});

/* ── The production defaults, in-process ───────────────────────────────── */

describe('runReloadCommand (production defaults, no injection)', () => {
  /**
   * Spawns a child that survives SIGHUP, records receiving it in `marker`,
   * and announces readiness in `ready` (U-001 — nothing signals it before).
   */
  function signalChild(ready: string, marker: string): Promise<{ pid: number; stop(): void }> {
    const child = spawn(process.execPath, [
      '-e',
      `process.on('SIGHUP', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); });` +
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');` +
        'setInterval(() => {}, 60_000);',
    ]);
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      const announced = (): void => resolve({ pid: child.pid!, stop: () => child.kill('SIGKILL') });
      child.stdout?.once('data', announced);
      // The script writes the ready file without printing; poll it instead.
      const until = Date.now() + 5000;
      const poll = (): void => {
        if (existsSync(ready)) return announced();
        if (Date.now() >= until) return reject(new Error('the signal child did not become ready'));
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  it('walks the absent-lock route on the real owner, paths, and lock read', async () => {
    const dir = await createTempDir('qm-reload-defaults-absent-');
    await withQuotameterEnv(
      {
        QUOTAMETER_CONFIG_DIR: join(dir.path, 'config'),
        QUOTAMETER_DATA_DIR: join(dir.path, 'data'),
      },
      async () => {
        const outLines: string[] = [];
        const errLines: string[] = [];
        const code = await runReloadCommand()({
          output: {
            out: (text: string) => void outLines.push(`${text}\n`),
            err: (text: string) => void errLines.push(`${text}\n`),
          },
          version: 'test',
          commandPath: ['reload'],
          flags: {},
          positionals: [],
        });
        expect(code).toBe(1);
        expect(errLines.join('')).toContain('the quotameter service is not running');
        expect(errLines.join('')).toContain(join(dir.path, 'data'));
        expect(outLines.join('')).toContain('quotameter run');
      },
    );
    await dir.remove();
  });

  it(
    'delivers a real SIGHUP through every default seam over a real lock and configuration',
    { timeout: 30_000 },
    async () => {
      const dir = await createTempDir('qm-reload-defaults-delivered-');
      const ready = join(dir.path, 'ready');
      const marker = join(dir.path, 'hup');
      const child = await signalChild(ready, marker);
      try {
        const configDir = join(dir.path, 'config');
        const dataDir = join(dir.path, 'data');
        await mkdir(configDir, { recursive: true });
        await mkdir(dataDir, { recursive: true });
        await writeFile(
          join(configDir, 'config.json'),
          `${JSON.stringify(
            {
              app: { timezone: 'Europe/Berlin' },
              accounts: [
                {
                  id: 'a1',
                  providerId: 'zai',
                  label: 'L',
                  enabled: true,
                  apiKey: 'synthetic-test-key',
                },
              ],
            },
            null,
            2,
          )}\n`,
        );
        await writeFile(
          join(dataDir, '.quotameter.lock'),
          `${JSON.stringify({ pid: child.pid, id: 'defaults' })}\n`,
        );

        const outLines: string[] = [];
        const errLines: string[] = [];
        await withQuotameterEnv(
          { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir },
          async () => {
            const code = await runReloadCommand()({
              output: {
                out: (text: string) => void outLines.push(`${text}\n`),
                err: (text: string) => void errLines.push(`${text}\n`),
              },
              version: 'test',
              commandPath: ['reload'],
              flags: {},
              positionals: [],
            });
            expect(code).toBe(0);
          },
        );
        expect(errLines.join('')).toBe('');
        expect(outLines.join('')).toContain('reload accepted');
        expect(outLines.join('')).toContain(`pid ${child.pid}`);
        // The delivery itself, through the production signal sender.
        const until = Date.now() + 5000;
        while (!existsSync(marker)) {
          if (Date.now() >= until) throw new Error('the SIGHUP marker did not appear');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        child.stop();
        await dir.remove();
      }
    },
  );
});

/* ── The handler matrix ────────────────────────────────────────────────── */

describe('runReloadCommand', () => {
  it('prints every owner problem and exits 1 before any discovery', async () => {
    const h = harness({ ownerProblems: ['problem one', 'problem two'] });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter reload: problem one\nquotameter reload: problem two\n');
    expect(result.out).toBe('');
    expect(h.lockReads()).toEqual([]);
  });

  it('renders a broken user database as the standard failure line', async () => {
    const h = harness({ ownerThrows: new Error('cannot read /etc/passwd') });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: resolving the service owner failed (cannot read /etc/passwd)\n',
    );
    expect(result.out).toBe('');
  });

  it('renders an unusable owner home as the directory-resolution failure', async () => {
    const h = harness({ ownerHome: '' });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: resolving the service directories failed ' +
        '(systemd unit input: homeDir must not be empty)\n',
    );
  });

  it('reports no running service for an absent lock, without validating', async () => {
    const h = harness({ lock: { state: 'absent' } });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: the quotameter service is not running — no instance holds the data directory /qm/test/data\n',
    );
    expect(result.out).toBe(
      [
        'Service reload: there is no running service to reload.',
        'An installed service starts with quotameter start; without installation, run it in the foreground:',
        '  quotameter run',
        'Or set everything up in one step: quotameter init',
        'Check what is running: quotameter status',
        '',
      ].join('\n'),
    );
    expect(h.lockReads()).toEqual([LOCK_PATH]);
    expect(h.validated()).toEqual([]);
    expect(h.signals()).toEqual([]);
  });

  it('renders an unreadable lock as a failure with the errno detail', async () => {
    const h = harness({ lock: { state: 'unreadable', detail: 'EACCES: permission denied' } });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `quotameter reload: reading the service lock ${LOCK_PATH} failed (EACCES: permission denied)\n`,
    );
    expect(result.out).toContain(`${LOCK_PATH} exists but cannot be read`);
    expect(result.out).toContain('quotameter status');
    expect(h.signals()).toEqual([]);
  });

  it('renders an invalid lock payload with the lock module remedy', async () => {
    const h = harness({ lock: { state: 'invalid' } });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `quotameter reload: ${LOCK_PATH} is not a valid quotameter lock file\n`,
    );
    expect(result.out).toBe(
      [
        `Service reload: ${LOCK_PATH} is not a valid quotameter lock file, so the running service cannot be identified.`,
        'Verify that no quotameter process is running, then remove the file and start the service again.',
        '',
      ].join('\n'),
    );
    expect(h.validated()).toEqual([]);
    expect(h.signals()).toEqual([]);
  });

  it('reports a stale lock (dead pid) as not running, without validating', async () => {
    const h = harness({ lock: { state: 'held', pid: 999 }, alive: false });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: the quotameter service is not running — the lock file still names pid 999, which is not running\n',
    );
    expect(result.out).toBe(
      [
        'Service reload: the lock file still names pid 999, which is not running — the service stopped without releasing it (the next start clears it automatically).',
        'Start the service with quotameter start, or run it in the foreground with quotameter run, then reload again.',
        `If pid 999 is not running quotameter (for example a recycled pid), remove ${LOCK_PATH} and start again.`,
        '',
      ].join('\n'),
    );
    expect(h.validated()).toEqual([]);
    expect(h.signals()).toEqual([]);
  });

  it('reports a rejected configuration with every problem and sends no signal', async () => {
    const h = harness({ problems: ['app.timezone: not an IANA time zone name', 'problem two'] });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: app.timezone: not an IANA time zone name\nquotameter reload: problem two\n',
    );
    expect(result.out).toBe(
      [
        'Service reload: the configuration is invalid — the service would reject it and keep the last valid configuration, so no SIGHUP was sent.',
        `Configuration file: ${CONFIG_PATH}`,
        'Each problem is reported on stderr. Fix the file, then run quotameter reload again.',
        'The running service keeps its current settings.',
        '',
      ].join('\n'),
    );
    expect(h.validated()).toEqual([{ configPath: CONFIG_PATH, env: PATH_ENV }]);
    expect(h.signals()).toEqual([]);
  });

  it('delivers SIGHUP to the live holder and reports the accepted outcome', async () => {
    const h = harness({});
    const result = await reload(h);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(
      [
        'Service reload: the configuration is valid and SIGHUP was delivered to the running service (pid 4242) — reload accepted.',
        `Validated with the same checks the service applies on SIGHUP: ${CONFIG_PATH}`,
        'Live settings (accounts, time zone, polling interval, retention, provider peak-hour schedule, logging level, web password) apply without a restart.',
        'Changes to server.host, server.port, or auth.mode need a restart:',
        '  quotameter restart      (an installed service)',
        '  Ctrl-C, then quotameter run again      (a foreground run)',
        'The service writes its own reload record to its logs (quotameter logs, an installed service) or, in the foreground, to its terminal.',
        '',
      ].join('\n'),
    );
    expect(h.validated()).toEqual([{ configPath: CONFIG_PATH, env: PATH_ENV }]);
    expect(h.signals()).toEqual([4242]);
  });

  it('feeds the validation exactly the environment snapshot the paths came from', async () => {
    // D-112(4): one snapshot feeds both the owner-scoped §6.1 resolution and
    // the pre-flight validation — the QUOTAMETER_* overrides the service
    // would re-apply on SIGHUP (D-023) must reach the pipeline verbatim.
    const env = {
      ...PATH_ENV,
      QUOTAMETER_APP_TIMEZONE: 'Asia/Singapore',
      QUOTAMETER_SERVER_PORT: '9999',
    };
    const h = harness({ pathEnv: env });
    const result = await reload(h);
    expect(result.code).toBe(0);
    expect(h.validated()).toEqual([{ configPath: CONFIG_PATH, env }]);
  });

  it('renders a service that exited before the signal', async () => {
    const h = harness({
      delivery: { delivered: false, reason: 'no-process', detail: 'kill ESRCH' },
    });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: the service (pid 4242) exited before the signal could be delivered\n',
    );
    expect(result.out).toContain('pid 4242 stopped meanwhile');
    expect(result.out).toContain('quotameter start');
  });

  it('renders a permission-denied signal with the owner-account and sudo steps', async () => {
    const h = harness({
      delivery: { delivered: false, reason: 'permission', detail: 'kill EPERM' },
    });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: permission denied — the service (pid 4242) runs as a different user, so this run may not signal it\n',
    );
    expect(result.out).toBe(
      [
        'Service reload: SIGHUP could not be delivered to pid 4242 — the process belongs to another user, so this run may not signal it.',
        "Run the command from the service owner's own account:",
        '  quotameter reload',
        'Or with sudo from a regular account (repeat any QUOTAMETER_* path override this run used — sudo drops it by default):',
        '  sudo quotameter reload',
        '',
      ].join('\n'),
    );
  });

  it('renders any other signal failure as the standard failure line', async () => {
    const h = harness({ delivery: { delivered: false, reason: 'failure', detail: 'EINVAL' } });
    const result = await reload(h);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'quotameter reload: signaling the service (pid 4242) failed (EINVAL)\n',
    );
    expect(result.out).toBe('');
  });
});
