import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import type { PromptHandle } from '../../src/cli/prompts';
import type { PasswdEntry, ServiceOwnerContext } from '../../src/cli/service-owner';
import {
  askNewPassword,
  NEW_PASSWORD_PROMPT,
  CONFIRM_PASSWORD_PROMPT,
  renderNoConfigSteps,
  renderPrivilegedSteps,
  renderReloadAdvisory,
  renderSuccessReport,
  revokeAllSessions,
  runPasswdCommand,
  type PasswdDeps,
  type SessionRevocation,
} from '../../src/cli/passwd';
import type { ExistingConfig } from '../../src/cli/init-persist';
import type { ServiceLockRead } from '../../src/cli/service-reload';
import { parseConfig, type CanonicalConfig } from '../../src/config/load';
import { openStorageConnection } from '../../src/storage/connection';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository } from '../../src/storage/repository';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import { validateSettings } from '../../src/services/config-validation';
import { createTempDir } from '../helpers/isolation';

/**
 * The `quotameter passwd` command handler (task 144, spec §5.2/§15.2;
 * decision D-118) — the done-condition's matrix through recorded seams:
 * the typed password never appears in any output line, only its hash
 * reaches the persisted configuration, sessions are revoked before the
 * write (fail-secure: a failure leaves the password unchanged), and every
 * refusal state (no configuration, invalid configuration, closed or
 * interrupted input, exhausted attempts, a changed file, a failed
 * revocation or write) exits 1 having changed nothing it should not.
 *
 * The real-launcher routes — the real prompter over piped input, the real
 * scrypt hash inside a real configuration file, and the real revocation
 * inside a real migrated SQLite database — are pinned in
 * `test/integration/cli-passwd.spec.ts`.
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

/** The configuration path the harness's directories resolve to. */
const CONFIG_PATH = '/qm/test/config/config.json';

/** The marker password every no-leak assertion hunts for (§15.2 minimum). */
const MARKER_PASSWORD = 'marker-password-0123456789';

/** The fake hash the seam produces (the real one lands in integration). */
const FAKE_HASH = 'unit-fake-scrypt-hash';

/** A canonical fixture through the real parser (no hand brands). */
function canonical(input: unknown): CanonicalConfig {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw new Error(`fixture configuration rejected: ${parsed.problems.join('; ')}`);
  return parsed.value as CanonicalConfig;
}

/** A canonical loopback configuration, optionally with a stored hash. */
function existingConfig(withHash = false): CanonicalConfig {
  const input: Record<string, unknown> = {
    server: { host: '127.0.0.1', port: 8787 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300 },
  };
  if (withHash) input.auth = { passwordHash: 'previous-hash' };
  return canonical(input);
}

/** The detection fixture for one configuration state. */
function detection(config: CanonicalConfig): ExistingConfig {
  return { state: 'existing', config, passwordPending: false };
}

/** A scripted prompter: consumes answers in order, `null` ends the input. */
function scriptedPrompter(
  answers: readonly (string | null)[],
  options?: { readonly interrupted?: boolean },
) {
  const queue = [...answers];
  const asked: string[] = [];
  const handle: PromptHandle = {
    async ask(prompt) {
      asked.push(prompt);
      return queue.shift() ?? null;
    },
    async askSecret(prompt) {
      asked.push(prompt);
      return queue.shift() ?? null;
    },
    close() {},
    interrupted: () => options?.interrupted === true,
  };
  return { handle, asked: () => asked };
}

/** The handler's harness: recorded seams and captured output. */
function harness(options?: {
  readonly ownerContext?: ServiceOwnerContext;
  readonly ownerProblems?: readonly string[];
  readonly ownerThrows?: Error;
  readonly existing?: readonly ExistingConfig[];
  readonly answers?: readonly (string | null)[];
  readonly interrupted?: boolean;
  readonly hashFails?: Error;
  readonly driftProblems?: readonly string[];
  readonly revocation?: SessionRevocation;
  readonly revokeFails?: boolean;
  readonly persistFails?: Error;
  readonly lock?: ServiceLockRead;
  readonly alive?: boolean;
}) {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const persisted: { configDir: string; configFile: string; config: unknown }[] = [];
  const defaultDetection = detection(existingConfig());
  // The handler reads the file twice (initial detection + the stale guard
  // re-read), so a scripted state repeats unless the test says otherwise.
  const detections = [...(options?.existing ?? [defaultDetection, defaultDetection])];
  const readCalls: string[] = [];
  const revoked: string[] = [];
  const hashError = options?.hashFails;
  const driftProblems = options?.driftProblems;
  const persistError = options?.persistFails;
  const defaultRevocation: SessionRevocation = options?.revocation ?? {
    state: 'revoked',
    count: 2,
  };
  const prompter = scriptedPrompter(options?.answers ?? [MARKER_PASSWORD, MARKER_PASSWORD], {
    interrupted: options?.interrupted,
  });
  const deps: PasswdDeps = {
    resolveOwner: () => {
      if (options?.ownerThrows !== undefined) throw options.ownerThrows;
      if (options?.ownerProblems !== undefined) {
        return { state: 'problems', problems: options.ownerProblems };
      }
      return { state: 'ok', context: options?.ownerContext ?? REGULAR };
    },
    pathEnv: PATH_ENV,
    createPrompter: () => prompter.handle,
    readExisting: async (targetPath) => {
      readCalls.push(targetPath);
      const next = detections.shift();
      if (next === undefined) throw new Error('unexpected extra detection read');
      return next;
    },
    hash:
      hashError === undefined
        ? async () => FAKE_HASH
        : async () => {
            throw hashError;
          },
    validate:
      driftProblems === undefined
        ? undefined
        : () => ({ ok: false as const, problems: [...driftProblems] }),
    revokeSessions: options?.revokeFails
      ? async () => ({ state: 'failed' as const, detail: 'disk I/O error' })
      : async (dataDir) => {
          revoked.push(dataDir);
          return defaultRevocation;
        },
    persistConfig:
      persistError === undefined
        ? async (write) => {
            persisted.push({ ...write });
          }
        : async () => {
            throw persistError;
          },
    readLock: async () => options?.lock ?? { state: 'absent' as const },
    isAlive: () => options?.alive ?? true,
  };
  const ctx: CliContext = {
    output: {
      out: (text: string) => void outLines.push(`${text}\n`),
      err: (text: string) => void errLines.push(`${text}\n`),
    },
    version: 'test',
    commandPath: ['passwd'],
    flags: {},
    positionals: [],
  };
  return {
    ctx,
    deps,
    prompter,
    out: () => outLines.join(''),
    err: () => errLines.join(''),
    all: () => `${outLines.join('')}${errLines.join('')}`,
    persisted: () => persisted,
    readCalls: () => readCalls,
    revoked: () => revoked,
  };
}

/** Runs the handler against a harness and captures the exit code. */
async function passwd(
  h: ReturnType<typeof harness>,
): Promise<{ code: number; out: string; err: string; all: string }> {
  const code = await runPasswdCommand(h.deps)(h.ctx);
  return { code, out: h.out(), err: h.err(), all: h.all() };
}

/** The no-leak pin (task done-condition): the marker never reaches output. */
function expectNoLeak(result: { all: string }): void {
  expect(result.all).not.toContain(MARKER_PASSWORD);
}

/* ── The prompt flow (spec §15.2 minimum, confirmation pair) ───────────── */

describe('askNewPassword (the prompt flow)', () => {
  /** An output seam that records lines. */
  function recorder() {
    const lines: string[] = [];
    return {
      lines: () => lines,
      output: {
        out: (text: string) => void lines.push(text),
        err: (text: string) => void lines.push(text),
      },
    };
  }

  it('asks the pair through the secret seam and accepts a matching pair', async () => {
    const rec = recorder();
    const prompter = scriptedPrompter([MARKER_PASSWORD, MARKER_PASSWORD]);
    const outcome = await askNewPassword('quotameter passwd', rec.output, prompter.handle);
    expect(outcome).toEqual({ state: 'provided', password: MARKER_PASSWORD });
    expect(prompter.asked()).toEqual([NEW_PASSWORD_PROMPT, CONFIRM_PASSWORD_PROMPT]);
    expect(rec.lines()).toEqual([]);
  });

  it('complains about a too-short password (a blank included) and re-asks the pair', async () => {
    const rec = recorder();
    const prompter = scriptedPrompter(['short', '', MARKER_PASSWORD, MARKER_PASSWORD]);
    const outcome = await askNewPassword('quotameter passwd', rec.output, prompter.handle);
    expect(outcome).toEqual({ state: 'provided', password: MARKER_PASSWORD });
    expect(rec.lines()).toEqual([
      'quotameter passwd: the password must be at least 12 characters long — try again',
      'quotameter passwd: the password must be at least 12 characters long — try again',
    ]);
    // Two rejected first answers restart the pair twice; the third attempt
    // completes it — four questions in total.
    expect(prompter.asked()).toHaveLength(4);
  });

  it('complains about a mismatching confirmation and re-asks the pair', async () => {
    const rec = recorder();
    // Both shapes: a shorter confirmation and a same-length one (the
    // constant-time comparison's equal-length arm).
    const prompter = scriptedPrompter([
      MARKER_PASSWORD,
      'different-but-long-enough',
      MARKER_PASSWORD,
      `X${MARKER_PASSWORD.slice(1)}`,
      MARKER_PASSWORD,
      MARKER_PASSWORD,
    ]);
    const outcome = await askNewPassword('quotameter passwd', rec.output, prompter.handle);
    expect(outcome).toEqual({ state: 'provided', password: MARKER_PASSWORD });
    expect(rec.lines()).toEqual([
      'quotameter passwd: the passwords do not match — try again',
      'quotameter passwd: the passwords do not match — try again',
    ]);
    expect(prompter.asked()).toHaveLength(6);
  });

  it('reports closed input when the stream ends at either question', async () => {
    const first = scriptedPrompter([null]);
    expect(await askNewPassword('quotameter passwd', recorder().output, first.handle)).toEqual({
      state: 'closed',
    });
    const second = scriptedPrompter([MARKER_PASSWORD, null]);
    expect(await askNewPassword('quotameter passwd', recorder().output, second.handle)).toEqual({
      state: 'closed',
    });
  });

  it('reports an interrupt distinctly from a plain close', async () => {
    for (const answers of [[null], [MARKER_PASSWORD, null]] as const) {
      const prompter = scriptedPrompter([...answers], { interrupted: true });
      expect(await askNewPassword('quotameter passwd', recorder().output, prompter.handle)).toEqual(
        { state: 'interrupted' },
      );
    }
  });

  it('aborts after three rejected pairs', async () => {
    const rec = recorder();
    const prompter = scriptedPrompter(['short', 'short', 'short']);
    const outcome = await askNewPassword('quotameter passwd', rec.output, prompter.handle);
    expect(outcome).toEqual({ state: 'aborted' });
    expect(rec.lines()).toHaveLength(3);
    expect(prompter.asked()).toHaveLength(3);
  });

  it('never echoes the rejected value in a complaint', async () => {
    const rec = recorder();
    const prompter = scriptedPrompter(['secret-short-value', MARKER_PASSWORD, MARKER_PASSWORD]);
    await askNewPassword('quotameter passwd', rec.output, prompter.handle);
    expect(rec.lines().join('\n')).not.toContain('secret-short-value');
  });
});

/* ── The renderers ─────────────────────────────────────────────────────── */

describe('renderers', () => {
  it('renders the no-configuration and privileged next steps', () => {
    expect(renderNoConfigSteps()).toContain('quotameter init');
    const privileged = renderPrivilegedSteps('alice');
    expect(privileged).toContain('alice');
    expect(privileged).toContain('quotameter passwd');
  });

  it('renders the success report per revocation state and count', () => {
    const set = renderSuccessReport({
      changed: false,
      configFile: CONFIG_PATH,
      revocation: { state: 'revoked', count: 2 },
    });
    expect(set).toContain('Web password set.');
    expect(set).toContain(CONFIG_PATH);
    expect(set).toContain('All 2 stored sessions were revoked.');
    expect(set).not.toContain('needs the new password');

    const changed = renderSuccessReport({
      changed: true,
      configFile: CONFIG_PATH,
      revocation: { state: 'revoked', count: 1 },
    });
    expect(changed).toContain('Web password changed.');
    expect(changed).toContain('All 1 stored session was revoked.');

    // An empty sessions table reads like no database at all (review P3).
    const empty = renderSuccessReport({
      changed: false,
      configFile: CONFIG_PATH,
      revocation: { state: 'revoked', count: 0 },
    });
    expect(empty).toContain('No stored sessions to revoke.');

    const none = renderSuccessReport({
      changed: false,
      configFile: CONFIG_PATH,
      revocation: { state: 'none' },
    });
    expect(none).toContain('No stored sessions to revoke.');
  });

  it('renders the reload advisory with the holder pid', () => {
    expect(renderReloadAdvisory(4242)).toContain('pid 4242');
    expect(renderReloadAdvisory(4242)).toContain('quotameter reload');
  });
});

/* ── The handler matrix ────────────────────────────────────────────────── */

describe('runPasswdCommand (seam-driven matrix)', () => {
  it('sets the password: hash-only persistence, revocation, exit 0', async () => {
    const h = harness();
    const result = await passwd(h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Web password set.');
    expect(result.out).toContain(`Only the scrypt hash is stored — in ${CONFIG_PATH}.`);
    expect(result.out).toContain('All 2 stored sessions were revoked');
    expectNoLeak(result);
    // The persisted configuration is the canonical base with the hash
    // merged in — validated by the real D-022 boundary (the seam's
    // default), so the shape is the parser's own.
    const writes = h.persisted();
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write === undefined) throw new Error('expected exactly one persisted write');
    expect(write.configFile).toBe(CONFIG_PATH);
    const auth = (write.config as CanonicalConfig).auth;
    expect(auth.passwordHash).toBe(FAKE_HASH);
    expect(auth.mode).toBe('auto');
    expect(h.revoked()).toEqual(['/qm/test/data']);
    expect(h.readCalls()).toEqual([CONFIG_PATH, CONFIG_PATH]);
  });

  it('reports a change (not a set) when a hash was already stored', async () => {
    const withHash = detection(existingConfig(true));
    const h = harness({ existing: [withHash, withHash] });
    const result = await passwd(h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Web password changed.');
    const write = h.persisted()[0];
    if (write === undefined) throw new Error('expected exactly one persisted write');
    expect((write.config as CanonicalConfig).auth.passwordHash).toBe(FAKE_HASH);
    expectNoLeak(result);
  });

  it('completes a password-pending configuration (§15.1 state, §15.2 completer)', async () => {
    // The pending state is not parser-canonical by definition (§15.1's
    // invariant rejects a non-loopback bind without a hash), so the fixture
    // takes init-persist's own probe route: validate with a placeholder
    // hash, then strip it — exactly what readExistingConfig persists.
    const probed = canonical({
      server: { host: '0.0.0.0', port: 8787 },
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300 },
      auth: { passwordHash: 'probe-placeholder' },
    });
    const pendingConfig: CanonicalConfig = { ...probed, auth: { mode: probed.auth.mode } };
    const pendingDetection: ExistingConfig = {
      state: 'existing',
      config: pendingConfig,
      passwordPending: true,
    };
    const h = harness({ existing: [pendingDetection, pendingDetection] });
    const result = await passwd(h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Web password set.');
    expect(result.out).not.toContain('changed');
    expectNoLeak(result);
    // The security-relevant base fields survive the write (review P2):
    // a passwd run must never silently reset a non-loopback bind.
    const write = h.persisted()[0];
    if (write === undefined) throw new Error('expected exactly one persisted write');
    expect((write.config as CanonicalConfig).server.host).toBe('0.0.0.0');
    expect((write.config as CanonicalConfig).server.port).toBe(8787);
  });

  it('refuses when the owner resolution has problems, before any prompt', async () => {
    const h = harness({ ownerProblems: ['run as root without SUDO_USER'] });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter passwd: run as root without SUDO_USER');
    expect(h.prompter.asked()).toEqual([]);
    expect(h.persisted()).toEqual([]);
  });

  it('refuses a broken system (thrown owner resolution) with one failure line', async () => {
    const h = harness({ ownerThrows: new Error('cannot read /etc/passwd') });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter passwd: resolving the service owner failed');
    expect(result.err).toContain('cannot read /etc/passwd');
  });

  it('refuses a privileged invocation: the write would leave the file root-owned', async () => {
    const h = harness({
      ownerContext: { kind: 'sudo', privileges: 'held', user: OWNER },
    });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain("writes alice's configuration file");
    expect(result.out).toContain("alice's regular account");
    expect(h.prompter.asked()).toEqual([]);
    expect(h.persisted()).toEqual([]);
  });

  it('refuses when the owner home cannot scope the directories', async () => {
    const h = harness({
      ownerContext: {
        kind: 'regular-user',
        privileges: 'none',
        user: { ...OWNER, home: 'relative/home' },
      },
    });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('resolving the service directories failed');
  });

  it('refuses without a configuration and points at init', async () => {
    const h = harness({ existing: [{ state: 'none' }] });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`there is no configuration file at ${CONFIG_PATH}`);
    expect(result.out).toContain('quotameter init');
    expect(h.prompter.asked()).toEqual([]);
  });

  it('refuses an invalid configuration without touching it', async () => {
    const h = harness({
      existing: [{ state: 'invalid', problems: ['app.timezone: expected a string'] }],
    });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('but it is invalid — nothing was changed');
    expect(result.err).toContain('quotameter passwd:   app.timezone: expected a string');
    expect(result.err).toContain('fix or remove the file, then run passwd again');
    expect(h.prompter.asked()).toEqual([]);
    expect(h.persisted()).toEqual([]);
    expect(h.revoked()).toEqual([]);
  });

  it('cancels on closed input without revoking or writing', async () => {
    const h = harness({ answers: [null] });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'input closed before the password was confirmed — password change cancelled',
    );
    expect(h.persisted()).toEqual([]);
    expect(h.revoked()).toEqual([]);
    expectNoLeak(result);
  });

  it('cancels an interrupt with its own wording', async () => {
    const h = harness({ answers: [null], interrupted: true });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('interrupted — password change cancelled');
    expectNoLeak(result);
  });

  it('aborts after too many rejected pairs', async () => {
    const h = harness({
      answers: ['short', 'short', 'short'],
    });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('too many unsuccessful attempts — password change cancelled');
    expectNoLeak(result);
    expect(h.persisted()).toEqual([]);
  });

  it('cancels when the input closes at the confirmation question', async () => {
    const h = harness({ answers: [MARKER_PASSWORD, null] });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('input closed before the password was confirmed');
    expectNoLeak(result);
  });

  it('reports a failed hash derivation and changes nothing', async () => {
    const h = harness({ hashFails: new Error('scrypt unavailable') });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('hashing the password failed');
    expectNoLeak(result);
    expect(result.err).toContain('scrypt unavailable');
    expect(h.persisted()).toEqual([]);
    expect(h.revoked()).toEqual([]);
  });

  it('reports a boundary drift alarm without writing', async () => {
    const h = harness({ driftProblems: ['auth.passwordHash: unexpected shape'] });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('quotameter passwd: auth.passwordHash: unexpected shape');
    expectNoLeak(result);
    expect(h.persisted()).toEqual([]);
    expect(h.revoked()).toEqual([]);
  });

  it('refuses when the file changed between the read and the write (no-clobber)', async () => {
    const h = harness({
      existing: [
        detection(existingConfig()),
        detection(
          canonical({
            server: { host: '127.0.0.1', port: 9999 },
            app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300 },
          }),
        ),
      ],
    });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('the configuration changed while the password was being entered');
    expect(result.err).toContain('no session was revoked');
    expectNoLeak(result);
    expect(h.persisted()).toEqual([]);
    expect(h.revoked()).toEqual([]);
  });

  it('aborts before the write when the revocation fails (fail-secure order)', async () => {
    const h = harness({ revokeFails: true });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('revoking the sessions failed');
    expect(result.err).toContain('disk I/O error');
    expect(result.out).toContain(
      'The password was not changed — the configuration file was left untouched',
    );
    expectNoLeak(result);
    expect(h.persisted()).toEqual([]);
  });

  it('reports an honest partial outcome when the write fails after revocation', async () => {
    const h = harness({ persistFails: new Error('EACCES: permission denied') });
    const result = await passwd(h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('writing the configuration failed');
    expect(result.err).toContain('EACCES');
    expect(result.out).toContain(
      'The password was not changed, but 2 stored sessions had already been revoked',
    );
    expect(result.out).toContain('the next sign-in still needs the current password');
    expectNoLeak(result);
  });

  it('renders the reload advisory when a live service holds the lock', async () => {
    const h = harness({ lock: { state: 'held', pid: 4242 }, alive: true });
    const result = await passwd(h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('pid 4242');
    expect(result.out).toContain('quotameter reload');
    expectNoLeak(result);
  });

  it('renders no reload advisory for absent, stale, or unreadable locks', async () => {
    for (const lock of [
      { state: 'absent' },
      { state: 'held', pid: 4242 }, // holder dead below: alive defaults to false
      { state: 'unreadable', detail: 'EACCES' },
      { state: 'invalid' },
    ] as const) {
      const h = harness({ lock, alive: false });
      const result = await passwd(h);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain('quotameter reload');
      expectNoLeak(result);
    }
  });
});

/* ── The production revocation (real filesystem, no database seam) ─────── */

describe('revokeAllSessions (real filesystem)', () => {
  it('classifies a data directory without a database as none', async () => {
    const dir = await createTempDir('qm-passwd-revoke-none-');
    try {
      expect(await revokeAllSessions(dir.path)).toEqual({ state: 'none' });
    } finally {
      await dir.remove();
    }
  });

  it('deletes every session of a real migrated database and reports the count', async () => {
    const dir = await createTempDir('qm-passwd-revoke-real-');
    try {
      const dataDir = dir.path;
      await mkdir(dataDir, { recursive: true });
      const hashes = [
        'aa11111111111111111111111111111111111111111111111111111111111111',
        'bb22222222222222222222222222222222222222222222222222222222222222',
      ];
      const connection = openStorageConnection({ dataDir });
      try {
        await createMigrationRunner({
          database: connection.database,
          migrations: MIGRATIONS,
        }).up();
        const repository = createQuotaRepository({ database: connection.database });
        const now = Date.now();
        for (const [index, tokenHash] of hashes.entries()) {
          repository.insertSession({
            tokenHash,
            createdAt: now - 1000,
            lastSeenAt: now - 1000,
            expiresAt: now + 60_000 + index,
          });
        }
      } finally {
        connection.close();
      }

      expect(await revokeAllSessions(dataDir)).toEqual({ state: 'revoked', count: 2 });

      const reread = openStorageConnection({ dataDir });
      try {
        const repository = createQuotaRepository({ database: reread.database });
        for (const tokenHash of hashes) {
          expect(repository.getSession(tokenHash)).toBeNull();
        }
      } finally {
        reread.close();
      }
    } finally {
      await dir.remove();
    }
  });

  it('fails loudly on a database file it cannot open', async () => {
    const dir = await createTempDir('qm-passwd-revoke-failed-');
    try {
      await writeFile(join(dir.path, 'quotameter.sqlite'), 'not a database at all', 'utf8');
      const outcome = await revokeAllSessions(dir.path);
      expect(outcome.state).toBe('failed');
      if (outcome.state === 'failed') expect(outcome.detail).toBeTruthy();
    } finally {
      await dir.remove();
    }
  });

  it('treats an unsearchable data directory as failed, never as absence (review P2)', async () => {
    // The probe gates a §15.2 security control: `existsSync`-style false
    // on EACCES would read "no sessions" while sessions stay valid behind
    // the error. Mode 000 denies even the owning (non-root) uid.
    const dir = await createTempDir('qm-passwd-revoke-eacces-');
    const dataDir = join(dir.path, 'data');
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'quotameter.sqlite'), 'unused', 'utf8');
      await chmod(dataDir, 0o000);
      const outcome = await revokeAllSessions(dataDir);
      expect(outcome.state).toBe('failed');
      if (outcome.state === 'failed') expect(outcome.detail).toContain('EACCES');
    } finally {
      await chmod(dataDir, 0o700).catch(() => undefined);
      await dir.remove();
    }
  });
});

/* ── The production validate default (no injected seam) ────────────────── */

describe('dependency seams', () => {
  it('keeps the real validateSettings as the production default', () => {
    const base = existingConfig();
    const result = validateSettings(
      { auth: { passwordHash: FAKE_HASH } },
      base as Validated<Config>,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.pendingPassword === undefined) {
      expect((result.config as CanonicalConfig).auth.passwordHash).toBe(FAKE_HASH);
    } else {
      throw new Error('the real boundary rejected a hash-carrying submission');
    }
  });
});
