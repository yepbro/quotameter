import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '../../src/config/load';
import { hermeticChildEnv } from '../helpers/hermetic-child-env';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The non-interactive `init --yes` end-to-end (task 131, spec §5.3; decision
 * D-100; idempotent behavior per task 132/D-101): the real launcher
 * (`bin/quotameter.mjs` through jiti, the task-130 child-process pattern)
 * with stdin closed — the mode never reads it. Pins the done-condition
 * evidence: a missing `--timezone` is the loud dedicated failure (never the
 * wizard's cancellation, never a prompt), a valid invocation is
 * reproducible, and the environment-sourced key value never reaches stdout
 * or stderr. Since task 132 every run resolves its configuration through
 * `QUOTAMETER_CONFIG_DIR` into a temporary directory: a successful run
 * writes the file, and the idempotency cases run twice in one directory.
 * Since task 133 a keyed invocation runs the initial connection test —
 * guard-blocked here into the deterministic `provider-unavailable` failure
 * class, explained and continued (§5.3 step 6, D-102).
 *
 * Since U-045 (D-173) every child environment is hermetic: the session
 * variables (`XDG_RUNTIME_DIR`, the `DBUS_*` session addresses) never reach
 * the launcher, so the §5.3 step-7 service-setup probe cannot observe — or,
 * through the user-unit route, act on — a live session manager of the
 * machine the suite happens to run on (the daily mutation failures of
 * 2026-11-02→04: on the hosted runner's live systemd the two runs of the
 * reproducibility cell diverged in the service-setup block). The
 * reproducibility assertion itself is unchanged: identical bytes are still
 * required — the environment the bytes are defined over is now pinned.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `quotameter init <args>` with stdin closed (`/dev/null`) and a
 * controlled environment. `--yes` must never depend on stdin; keeping it
 * closed makes any prompt fallback surface as an immediate EOF cancellation
 * that the assertions can tell apart from the dedicated failures. The test
 * no-network guard is preloaded into the child so a keyed invocation's
 * connection test fails deterministically (`provider-unavailable`) instead
 * of reaching a real provider endpoint (§17: no real endpoints, ever).
 */
function runInitYes(args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'jiti/register',
      '--import',
      pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href,
      BIN,
      'init',
      ...args,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
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

/**
 * The environment every child derives from (U-045, D-173): the parent
 * environment minus the session-manager variables, so the §5.3 step-7
 * probe stays deterministic on any machine (see the suite header and
 * `test/helpers/hermetic-child-env.ts`).
 */
function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...hermeticChildEnv(), ...overrides } as NodeJS.ProcessEnv;
}

const SECRET = 'sk-integration-key-value';
const KEY_ENV = childEnv({ QM_E2E_TEST_KEY: SECRET });
/** The same environment minus the key variable, for the unset-var cases. */
const NO_KEY_ENV = childEnv();
delete NO_KEY_ENV.QM_E2E_TEST_KEY;

const FULL_ARGS = [
  '--yes',
  '--timezone',
  'Europe/Berlin',
  '--host',
  '0.0.0.0',
  '--port',
  '9000',
  '--polling-interval',
  '120',
  '--account-label',
  'work',
  '--api-key-env',
  'QM_E2E_TEST_KEY',
] as const;

/** The marker password of the --password-env runs (§15.2 minimum met). */
const PASSWORD = 'yes-integration-password-42';
/** The environment holding it, beside the key variable. */
const PASSWORD_ENV = childEnv({ QM_E2E_TEST_PASSWORD: PASSWORD });
/** The same environment minus the password variable, for the unset cases. */
const NO_PASSWORD_ENV = childEnv();
delete NO_PASSWORD_ENV.QM_E2E_TEST_PASSWORD;

/**
 * Environment with the configuration redirected into `dir` (task 132) and
 * a data-directory redirect beside it: since U-042 a password-writing run
 * revokes the sessions of any surviving database, so the runs must stay
 * off the container's shared default data directory (hermetic; removed
 * with `dir`).
 */
function inDir(dir: TempDir, base: NodeJS.ProcessEnv = KEY_ENV): NodeJS.ProcessEnv {
  return {
    ...base,
    QUOTAMETER_CONFIG_DIR: dir.path,
    QUOTAMETER_DATA_DIR: join(dir.path, 'test-data'),
  } as NodeJS.ProcessEnv;
}

/** A fresh temporary configuration directory per run (task 132: init writes). */
async function freshConfigDir(): Promise<TempDir> {
  return createTempDir('qm-init-131-');
}

describe('quotameter init --yes (real launcher, stdin closed)', () => {
  it('collects every value from the options, tests, writes, and masks the key', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(FULL_ARGS, inDir(dir));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Time zone:         Europe/Berlin');
      expect(result.stdout).toContain('Bind host:         0.0.0.0');
      expect(result.stdout).toContain('Port:              9000');
      expect(result.stdout).toContain('Polling interval:  120 seconds');
      expect(result.stdout).toContain(
        "'work' (API key from environment variable 'QM_E2E_TEST_KEY', value never " +
          'stored or printed; connection test failed: provider-unavailable — ' +
          'stored in error state)',
      );
      expect(result.stdout).toContain('requires a password before the service');
      // §5.3 step 6 through the guard: the failed test is explained with its
      // class and the run continues (exit 0) — never a prompt, never a crash.
      expect(result.stderr).toContain("the initial connection test for 'work' failed:");
      expect(result.stderr).toContain('the check was inconclusive');
      // The key value itself never reaches any stream (spec §15.4)…
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      // …and the written configuration carries the account with the
      // variable-name secret source — the value exists only in the
      // environment (§6.3, D-004, D-100).
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.server).toEqual({ host: '0.0.0.0', port: 9000 });
      expect(config.accounts).toEqual([
        {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'work',
          enabled: true,
          apiKeyEnv: 'QM_E2E_TEST_KEY',
        },
      ]);
      expect(JSON.stringify(config)).not.toContain(SECRET);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('takes the spec defaults for absent options', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(['--yes', '--timezone', 'UTC'], inDir(dir, NO_KEY_ENV));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Time zone:         UTC');
      expect(result.stdout).toContain('Bind host:         127.0.0.1');
      expect(result.stdout).toContain('Port:              8787');
      expect(result.stdout).toContain('Polling interval:  300 seconds');
      expect(result.stdout).toContain('Account:           none (add one later in the UI)');
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.server).toEqual({ host: '127.0.0.1', port: 8787 });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('is reproducible: the same invocation in a fresh directory prints identical bytes', async () => {
    // D-100's reproducibility pin, adjusted for task 132: the summary now
    // names the file it wrote, so each run gets its own fresh directory and
    // the paths are normalized before the byte comparison — everything
    // except the directory is deterministic output of flags + environment
    // (the environment hermetic since U-045, D-173). The comparison dumps
    // BOTH full normalized stdouts on mismatch: Stryker truncates assertion
    // strings to ~40 characters, and the 2026-11-02→04 daily failures hid
    // the diverging bytes behind exactly that truncation.
    const firstDir = await freshConfigDir();
    const secondDir = await freshConfigDir();
    try {
      const first = await runInitYes(FULL_ARGS, inDir(firstDir));
      const second = await runInitYes(FULL_ARGS, inDir(secondDir));
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const normalize = (text: string, dir: TempDir): string =>
        text.split(dir.path).join('<config-dir>');
      const firstOut = normalize(first.stdout, firstDir);
      const secondOut = normalize(second.stdout, secondDir);
      const firstErr = normalize(first.stderr, firstDir);
      const secondErr = normalize(second.stderr, secondDir);
      let divergeAt = 0;
      while (
        divergeAt < Math.min(firstOut.length, secondOut.length) &&
        firstOut[divergeAt] === secondOut[divergeAt]
      ) {
        divergeAt += 1;
      }
      const message =
        'the two real-launcher runs must print identical bytes; ' +
        `first divergence after ${Buffer.byteLength(firstOut.slice(0, divergeAt), 'utf8')} ` +
        'UTF-8 bytes of normalized stdout\n' +
        `first stdout (normalized): ${JSON.stringify(firstOut)}\n` +
        `second stdout (normalized): ${JSON.stringify(secondOut)}\n` +
        `first stderr (normalized): ${JSON.stringify(firstErr)}\n` +
        `second stderr (normalized): ${JSON.stringify(secondErr)}`;
      // Two-argument expect keeps the message AND the built-in diff — the
      // 2026-11-02→04 failures were undiagnosed for days because Stryker's
      // truncation left only the identical first 40 bytes visible.
      expect(secondOut, message).toBe(firstOut);
      // stderr is deterministic under the hermetic environment (D-173) and
      // carried the diagnosis in the recorded failure class (the enable
      // failure detail) — it is compared, not just dumped.
      expect(secondErr, message).toBe(firstErr);
    } finally {
      await firstDir.remove();
      await secondDir.remove();
    }
  }, 20_000);

  it('builds the launcher environment hermetically: session-manager variables never reach the child (U-045, D-173)', () => {
    // The spawn-boundary contract behind the reproducibility cell: the §5.3
    // step-7 probe reads an own-property XDG_RUNTIME_DIR and the user-unit
    // route acts on the session manager it names — the child environment
    // must therefore carry none of it, on any machine the suite runs on,
    // while everything the invocation genuinely needs passes through. The
    // cell pins the full helper contract: the strip set, verbatim
    // pass-through of everything else, the fresh-object guarantee (the
    // parent environment is never mutated — the D-028 discipline), and the
    // process.env default base the suite's own spawns rely on.
    const base = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/runner',
      QM_E2E_TEST_KEY: SECRET,
      QM_U045_UNRELATED: 'passes-through-verbatim',
      QUOTAMETER_CONFIG_DIR: '/tmp/qm-hermetic-pin',
      QUOTAMETER_DATA_DIR: '/tmp/qm-hermetic-pin/data',
      XDG_RUNTIME_DIR: '/run/user/1001',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
      DBUS_STARTER_ADDRESS: 'unix:path=/run/user/1001/bus',
      DBUS_STARTER_BUS_TYPE: 'session',
    } as NodeJS.ProcessEnv;
    const env = hermeticChildEnv(base);
    expect(env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(env.DBUS_STARTER_ADDRESS).toBeUndefined();
    expect(env.DBUS_STARTER_BUS_TYPE).toBeUndefined();
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.QM_E2E_TEST_KEY).toBe(SECRET);
    expect(env.QM_U045_UNRELATED).toBe('passes-through-verbatim');
    expect(env.QUOTAMETER_CONFIG_DIR).toBe('/tmp/qm-hermetic-pin');
    expect(env.QUOTAMETER_DATA_DIR).toBe('/tmp/qm-hermetic-pin/data');
    // Fresh object: the caller's base (process.env in production) is left
    // untouched — the stripped keys survive on it, the result is not it.
    expect(env).not.toBe(base);
    expect(base.XDG_RUNTIME_DIR).toBe('/run/user/1001');
    expect(base.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1001/bus');
    // The no-argument default is the parent process environment: a
    // variable this process carries (sentinel set and restored around the
    // call, the withQuotameterEnv restore discipline) must arrive in the
    // child environment — an empty or whitelisted default base would fail
    // here and starve every real spawn of PATH and friends.
    const sentinel = 'QM_U045_DEFAULT_BASE_SENTINEL';
    process.env[sentinel] = 'present';
    try {
      expect(hermeticChildEnv()[sentinel]).toBe('present');
    } finally {
      delete process.env[sentinel];
    }
  });

  it('running twice in one directory: the second run reports the existing config and keeps it', async () => {
    const dir = await freshConfigDir();
    try {
      const first = await runInitYes(FULL_ARGS, inDir(dir));
      expect(first.code).toBe(0);
      const file = configFilePath(dir.path);
      const created = await readFile(file, 'utf8');

      // Same time zone re-stated, every other option absent ⇒ retain all.
      const second = await runInitYes(['--yes', '--timezone', 'Europe/Berlin'], inDir(dir));
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Existing configuration found at');
      expect(second.stdout).toContain('Options that are not passed keep the current values.');
      expect(second.stdout).toContain('No changes — the existing configuration is kept');
      expect(await readFile(file, 'utf8')).toBe(created);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('the account options fail against an existing configuration', async () => {
    const dir = await freshConfigDir();
    try {
      await runInitYes(['--yes', '--timezone', 'UTC'], inDir(dir));
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--account-label', 'work'],
        inDir(dir),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('apply only to a fresh initialization');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a missing --timezone is the dedicated failure — no prompt, no default', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(['--yes'], inDir(dir, KEY_ENV));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('quotameter init: --timezone is required with --yes');
      expect(result.stderr).toContain('never applies the system time zone automatically');
      // Not the wizard's EOF cancellation and not a prompt: stdin was closed,
      // and a fallback would have surfaced as the cancellation message.
      expect(result.stderr).not.toContain('input closed before the questions');
      expect(result.stdout).not.toContain('IANA time zone to use');
      expect(result.stdout).not.toContain('Initial configuration collected');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a service environment override does not satisfy the missing flag', async () => {
    const dir = await freshConfigDir();
    try {
      const env = inDir(dir, childEnv({ QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' }));
      const result = await runInitYes(['--yes'], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--timezone is required with --yes');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('reports every invalid value in one run', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        ['--yes', '--timezone', 'Nope/Zone', '--port', 'abc'],
        inDir(dir, NO_KEY_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("'Nope/Zone' is not a valid IANA time zone");
      expect(result.stderr).toContain("Port must be a whole number (got 'abc')");
      expect(result.stdout).not.toContain('Initial configuration collected');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('an unset key variable fails without echoing the name or any value', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        [
          '--yes',
          '--timezone',
          'UTC',
          '--account-label',
          'work',
          '--api-key-env',
          'QM_E2E_TEST_KEY',
        ],
        inDir(dir, NO_KEY_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '--api-key-env names an environment variable that is not set',
      );
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      expect(result.stdout + result.stderr).not.toContain('QM_E2E_TEST_KEY');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a key pasted as the --api-key-env argument never reaches output', async () => {
    const dir = await freshConfigDir();
    try {
      // The operator mistake the no-echo rule exists for: the KEY lands where
      // the variable NAME belongs (spec §15.4 — review-round pin).
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', SECRET],
        inDir(dir, NO_KEY_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('an inherited property name (toString) is not a set variable', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', 'toString'],
        inDir(dir, NO_KEY_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '--api-key-env names an environment variable that is not set',
      );
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('the reserved QUOTAMETER_ prefix is rejected with its remedy', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        [
          '--yes',
          '--timezone',
          'UTC',
          '--account-label',
          'work',
          '--api-key-env',
          'QUOTAMETER_KEY',
        ],
        inDir(dir, childEnv({ QUOTAMETER_KEY: SECRET })),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('must not use the reserved QUOTAMETER_ prefix');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('an unknown option is a usage error with exit 2', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(['--yes', '--bogus'], inDir(dir, NO_KEY_ENV));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown option '--bogus'");
      expect(result.stderr).toContain("Try 'quotameter init --help'");
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a value option without --yes fails clearly instead of starting the wizard', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(['--host', '0.0.0.0'], inDir(dir, NO_KEY_ENV));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--host requires --yes (non-interactive mode)');
      expect(result.stderr).not.toContain('input closed before the questions');
      expect(result.stdout).not.toContain('IANA time zone to use');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('--password-env hashes the environment password and never echoes it (U-042, D-141)', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--password-env', 'QM_E2E_TEST_PASSWORD'],
        inDir(dir, PASSWORD_ENV),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Password:          set (only a scrypt hash is stored)');
      // The plaintext never reaches any stream (spec §15.4)…
      expect(result.stdout + result.stderr).not.toContain(PASSWORD);
      // …and the written configuration stores the scrypt hash only
      // (§15.2) — the plaintext appears nowhere in the file either.
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as {
        auth?: { mode?: string; passwordHash?: string };
      };
      expect(config.auth?.mode).toBe('auto');
      expect(config.auth?.passwordHash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(config)).not.toContain(PASSWORD);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('an unset --password-env variable fails without echoing any value', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--password-env', 'QM_E2E_TEST_PASSWORD'],
        inDir(dir, NO_PASSWORD_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '--password-env names an environment variable that is not set in this environment',
      );
      expect(result.stdout).not.toContain('Initial configuration collected');
      await expect(readFile(configFilePath(dir.path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a too-short --password-env value fails naming the rule, never the value', async () => {
    const dir = await freshConfigDir();
    try {
      const short = childEnv({ QM_E2E_SHORT_PASSWORD: 'tiny-pw-x9' });
      const result = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--password-env', 'QM_E2E_SHORT_PASSWORD'],
        inDir(dir, short),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '--password-env holds a password shorter than the spec §15.2 minimum of 12 characters',
      );
      expect(result.stdout + result.stderr).not.toContain('tiny-pw-x9');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('--password-env against an existing configuration fails with the passwd remedy', async () => {
    const dir = await freshConfigDir();
    try {
      const first = await runInitYes(['--yes', '--timezone', 'UTC'], inDir(dir, NO_PASSWORD_ENV));
      expect(first.code).toBe(0);
      const second = await runInitYes(
        ['--yes', '--timezone', 'UTC', '--password-env', 'QM_E2E_TEST_PASSWORD'],
        inDir(dir, PASSWORD_ENV),
      );
      expect(second.code).toBe(1);
      expect(second.stderr).toContain('--password-env applies only to a fresh initialization');
      expect(second.stderr).toContain('Change the password with quotameter passwd');
      // The existing configuration is untouched — no hash materialized.
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as {
        auth?: { passwordHash?: string };
      };
      expect(config.auth?.passwordHash).toBeUndefined();
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('--password-env without --yes fails clearly like every value option', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(
        ['--password-env', 'QM_E2E_TEST_PASSWORD'],
        inDir(dir, PASSWORD_ENV),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--password-env requires --yes (non-interactive mode)');
    } finally {
      await dir.remove();
    }
  }, 20_000);
});
