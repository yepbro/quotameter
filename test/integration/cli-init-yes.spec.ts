import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '../../src/config/load';
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
 * that the assertions can tell apart from the dedicated failures.
 */
function runInitYes(args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  const child = spawn(process.execPath, ['--import', 'jiti/register', BIN, 'init', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
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

const SECRET = 'sk-integration-key-value';
const KEY_ENV = { ...process.env, QM_E2E_TEST_KEY: SECRET } as NodeJS.ProcessEnv;
/** The same environment minus the key variable, for the unset-var cases. */
const NO_KEY_ENV = { ...process.env } as NodeJS.ProcessEnv;
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

/** Environment with the configuration redirected into `dir` (task 132). */
function inDir(dir: TempDir, base: NodeJS.ProcessEnv = KEY_ENV): NodeJS.ProcessEnv {
  return { ...base, QUOTAMETER_CONFIG_DIR: dir.path } as NodeJS.ProcessEnv;
}

/** A fresh temporary configuration directory per run (task 132: init writes). */
async function freshConfigDir(): Promise<TempDir> {
  return createTempDir('qm-init-131-');
}

describe('quotameter init --yes (real launcher, stdin closed)', () => {
  it('collects every value from the options, writes the config, and masks the key', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInitYes(FULL_ARGS, inDir(dir));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Time zone:         Europe/Berlin');
      expect(result.stdout).toContain('Bind host:         0.0.0.0');
      expect(result.stdout).toContain('Port:              9000');
      expect(result.stdout).toContain('Polling interval:  120 seconds');
      expect(result.stdout).toContain(
        "'work' (API key from environment variable 'QM_E2E_TEST_KEY', value never stored or printed)",
      );
      expect(result.stdout).toContain('requires a password before the service');
      // The key value itself never reaches any stream (spec §15.4)…
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      // …and never the written configuration either (the account is 133's).
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.server).toEqual({ host: '0.0.0.0', port: 9000 });
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
    // except the directory is deterministic output of flags + environment.
    const firstDir = await freshConfigDir();
    const secondDir = await freshConfigDir();
    try {
      const first = await runInitYes(FULL_ARGS, inDir(firstDir));
      const second = await runInitYes(FULL_ARGS, inDir(secondDir));
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const normalize = (text: string, dir: TempDir): string =>
        text.split(dir.path).join('<config-dir>');
      expect(normalize(second.stdout, secondDir)).toBe(normalize(first.stdout, firstDir));
    } finally {
      await firstDir.remove();
      await secondDir.remove();
    }
  }, 20_000);

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
      const env = inDir(dir, { ...process.env, QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' });
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
        inDir(dir, { ...process.env, QUOTAMETER_KEY: SECRET }),
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
});
