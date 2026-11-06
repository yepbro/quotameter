import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The real CLI launcher as a process (task 128, spec §5.2): `bin/quotameter.mjs`
 * runs through jiti (`node --import jiti/register`) so the TypeScript command
 * modules load without a build step — the same child-process pattern as the
 * server-main tests (task 060). The dispatch logic itself is covered
 * in-process by `test/unit/cli-dispatch.spec.ts`; here the contract under
 * test is exit codes and stream routing across the process boundary.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
const VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs the launcher with `args`; resolves when output streams are drained. */
function runBin(args: readonly string[]): Promise<RunResult> {
  const child = spawn(process.execPath, ['--import', 'jiti/register', BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<RunResult>((resolve, reject) => {
    // 'close' (not 'exit'): both streams are drained by then.
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.once('error', reject);
  });
}

describe('bin/quotameter.mjs (child process, jiti)', () => {
  it('--help exits 0 and lists the §5.2 command surface on stdout', async () => {
    const result = await runBin(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: quotameter <command> [options]');
    for (const name of [
      'init',
      'run',
      'start',
      'stop',
      'restart',
      'reload',
      'status',
      'logs',
      'service',
      'passwd',
      'doctor',
    ]) {
      expect(result.stdout, `help must mention '${name}'`).toContain(name);
    }
  }, 20_000);

  it('--version and -v print exactly the package version and exit 0', async () => {
    for (const flag of ['--version', '-v']) {
      const result = await runBin([flag]);
      expect(result.code, `exit 0 for ${flag}`).toBe(0);
      expect(result.stdout).toBe(`${VERSION}\n`);
      expect(result.stderr).toBe('');
    }
  }, 20_000);

  it('an unknown command exits 2 with the standard error line on stderr', async () => {
    const result = await runBin(['definitely-not-a-command']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("quotameter: unknown command 'definitely-not-a-command'");
    expect(result.stderr).toContain("Try 'quotameter --help'");
    expect(result.stdout).toBe('');
  }, 20_000);

  it('renders real command help for run and exits 0 on stdout', async () => {
    // `run` is real since U-050 (the last stub): help renders from the
    // dispatch table without invoking the handler — no server starts, and
    // the invocation stays cheap at the process boundary. The server-start
    // behavior itself is pinned by test/integration/cli-run.spec.ts.
    const result = await runBin(['run', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: quotameter run [options]');
    expect(result.stdout).toContain('Foreground execution for systemd and debugging');
    expect(result.stderr).toBe('');
  }, 20_000);
});
