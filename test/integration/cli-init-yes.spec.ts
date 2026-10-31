import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The non-interactive `init --yes` end-to-end (task 131, spec §5.3; decision
 * D-100): the real launcher (`bin/quotameter.mjs` through jiti, the
 * task-130 child-process pattern) with stdin closed — the mode never reads
 * it. Pins the done-condition evidence: a missing `--timezone` is the loud
 * dedicated failure (never the wizard's cancellation, never a prompt), a
 * valid invocation is byte-for-byte reproducible, and the environment-sourced
 * key value never reaches stdout or stderr.
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
function runInitYes(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
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

describe('quotameter init --yes (real launcher, stdin closed)', () => {
  it('collects every value from the options and prints the masked summary', async () => {
    const result = await runInitYes(FULL_ARGS, KEY_ENV);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Time zone:         Europe/Berlin');
    expect(result.stdout).toContain('Bind host:         0.0.0.0');
    expect(result.stdout).toContain('Port:              9000');
    expect(result.stdout).toContain('Polling interval:  120 seconds');
    expect(result.stdout).toContain(
      "'work' (API key from environment variable 'QM_E2E_TEST_KEY', value never stored or printed)",
    );
    expect(result.stdout).toContain('requires a password before the service');
    // The key value itself never reaches any stream (spec §15.4).
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  }, 20_000);

  it('takes the spec defaults for absent options', async () => {
    const result = await runInitYes(['--yes', '--timezone', 'UTC']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Time zone:         UTC');
    expect(result.stdout).toContain('Bind host:         127.0.0.1');
    expect(result.stdout).toContain('Port:              8787');
    expect(result.stdout).toContain('Polling interval:  300 seconds');
    expect(result.stdout).toContain('Account:           none (add one later in the UI)');
  }, 20_000);

  it('is reproducible: the same invocation prints identical bytes', async () => {
    const first = await runInitYes(FULL_ARGS, KEY_ENV);
    const second = await runInitYes(FULL_ARGS, KEY_ENV);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  }, 20_000);

  it('a missing --timezone is the dedicated failure — no prompt, no default', async () => {
    const result = await runInitYes(['--yes'], KEY_ENV);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('quotameter init: --timezone is required with --yes');
    expect(result.stderr).toContain('never applies the system time zone automatically');
    // Not the wizard's EOF cancellation and not a prompt: stdin was closed,
    // and a fallback would have surfaced as the cancellation message.
    expect(result.stderr).not.toContain('input closed before the questions');
    expect(result.stdout).not.toContain('IANA time zone to use');
    expect(result.stdout).not.toContain('Initial configuration collected');
  }, 20_000);

  it('a service environment override does not satisfy the missing flag', async () => {
    const env = { ...process.env, QUOTAMETER_APP_TIMEZONE: 'Europe/Berlin' };
    const result = await runInitYes(['--yes'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--timezone is required with --yes');
  }, 20_000);

  it('reports every invalid value in one run', async () => {
    const result = await runInitYes(
      ['--yes', '--timezone', 'Nope/Zone', '--port', 'abc'],
      NO_KEY_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("'Nope/Zone' is not a valid IANA time zone");
    expect(result.stderr).toContain("Port must be a whole number (got 'abc')");
    expect(result.stdout).not.toContain('Initial configuration collected');
  }, 20_000);

  it('an unset key variable fails without echoing the name or any value', async () => {
    const result = await runInitYes(
      ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', 'QM_E2E_TEST_KEY'],
      NO_KEY_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--api-key-env names an environment variable that is not set');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).not.toContain('QM_E2E_TEST_KEY');
  }, 20_000);

  it('a key pasted as the --api-key-env argument never reaches output', async () => {
    // The operator mistake the no-echo rule exists for: the KEY lands where
    // the variable NAME belongs (spec §15.4 — review-round pin).
    const result = await runInitYes(
      ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', SECRET],
      NO_KEY_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  }, 20_000);

  it('an inherited property name (toString) is not a set variable', async () => {
    const result = await runInitYes(
      ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', 'toString'],
      NO_KEY_ENV,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--api-key-env names an environment variable that is not set');
  }, 20_000);

  it('the reserved QUOTAMETER_ prefix is rejected with its remedy', async () => {
    const result = await runInitYes(
      ['--yes', '--timezone', 'UTC', '--account-label', 'work', '--api-key-env', 'QUOTAMETER_KEY'],
      { ...process.env, QUOTAMETER_KEY: SECRET },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must not use the reserved QUOTAMETER_ prefix');
  }, 20_000);

  it('an unknown option is a usage error with exit 2', async () => {
    const result = await runInitYes(['--yes', '--bogus'], NO_KEY_ENV);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--bogus'");
    expect(result.stderr).toContain("Try 'quotameter init --help'");
  }, 20_000);

  it('a value option without --yes fails clearly instead of starting the wizard', async () => {
    const result = await runInitYes(['--host', '0.0.0.0'], NO_KEY_ENV);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--host requires --yes (non-interactive mode)');
    expect(result.stderr).not.toContain('input closed before the questions');
    expect(result.stdout).not.toContain('IANA time zone to use');
  }, 20_000);
});
