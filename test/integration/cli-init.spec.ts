import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The interactive `init` command end-to-end (task 130, spec §5.3; decision
 * D-099): the real launcher (`bin/quotameter.mjs` through jiti, the same
 * child-process pattern as `cli-bin.spec.ts`) answering the real readline
 * prompter over a pipe — including the one-chunk piped-input case that
 * drops answers when a prompter relies on `readline`'s own `question()`.
 * The final case runs under a real PTY (`script`) to prove the typed API
 * key never reaches the terminal while normal answers do echo.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
const NODE_ARGS = ['--import', 'jiti/register', BIN, 'init'];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `quotameter init` with `stdinData` piped in and stdin then closed. */
function runInit(stdinData: string): Promise<RunResult> {
  const child = spawn(process.execPath, NODE_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  // A child that exits before consuming its stdin turns the writes below
  // into EPIPE; the close event (whose code the test asserts) is the failure
  // signal, not an unhandled stream error.
  child.stdin?.on('error', () => undefined);
  child.stdin?.write(stdinData);
  child.stdin?.end();
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

describe('quotameter init (piped stdin, real launcher)', () => {
  it('collects, validates, and summarizes typed answers — key never printed', async () => {
    const result = await runInit('Europe/Berlin\n0.0.0.0\n9000\n120\nwork\nsk-e2e-key-value\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Time zone:         Europe/Berlin');
    expect(result.stdout).toContain('Bind host:         0.0.0.0');
    expect(result.stdout).toContain('Port:              9000');
    expect(result.stdout).toContain('Polling interval:  120 seconds');
    expect(result.stdout).toContain("'work' (API key configured, hidden)");
    expect(result.stdout).toContain('requires a password before the service');
    expect(result.stdout + result.stderr).not.toContain('sk-e2e-key-value');
  }, 20_000);

  it('empty lines take the shown defaults and skip the account', async () => {
    const result = await runInit('UTC\n\n\n\n\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Time zone:         UTC');
    expect(result.stdout).toContain('Bind host:         127.0.0.1');
    expect(result.stdout).toContain('Port:              8787');
    expect(result.stdout).toContain('Polling interval:  300 seconds');
    expect(result.stdout).toContain('Account:           none (add one later in the UI)');
  }, 20_000);

  it('an empty time-zone answer is rejected loudly, not defaulted to the hint', async () => {
    const result = await runInit('\nUTC\n\n\n\n\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Time zone is required');
    expect(result.stderr).toContain('never applies the system time zone');
    expect(result.stdout).toContain('Time zone:         UTC');
  }, 20_000);

  it('invalid answers complain on stderr and are asked again', async () => {
    const result = await runInit('Nope/Zone\nUTC\n\nabc\n8788\n\n\n');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("'Nope/Zone' is not a valid IANA time zone");
    expect(result.stderr).toContain("Port must be a whole number (got 'abc')");
    expect(result.stdout).toContain('Port:              8788');
  }, 20_000);

  it('EOF before any answer cancels with exit 1 — no hang, no default', async () => {
    const result = await runInit('');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'quotameter init: input closed before the questions were answered — initialization cancelled',
    );
  }, 20_000);

  it('EOF mid-flow cancels with exit 1 and prints no summary', async () => {
    const result = await runInit('Europe/Berlin\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('input closed before the questions were answered');
    expect(result.stdout).not.toContain('Initial configuration collected');
  }, 20_000);
});

describe('quotameter init (real PTY, hidden key entry)', () => {
  /**
   * Runs the launcher under a PTY via `script`. Each answer is written only
   * after its prompt has appeared (the D-087 readiness-marker pattern, not
   * fixed sleeps): the transcript is the observable that proves the child is
   * in raw mode and at the right question, so the runs stay deterministic
   * under load and cannot accidentally type the key into an earlier prompt.
   */
  function runUnderPty(mode: 'typed' | 'pasted', lines: readonly string[]): Promise<RunResult> {
    const command = [process.execPath, ...NODE_ARGS].map((part) => JSON.stringify(part)).join(' ');
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A child that exits early (or a closed PTY) turns stdin writes into
    // EPIPE; that must surface as the close event, not an unhandled throw.
    child.stdin?.on('error', () => undefined);
    const transcript = () =>
      Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8');

    const typed = (async () => {
      const markers = [
        'IANA time zone to use',
        'Bind host',
        'Port (Enter for 8787)',
        'Polling interval',
        'account label',
        "API key for 'work'",
      ];
      if (mode === 'pasted') {
        // The whole answer block in one write — a paste. The prompt having
        // appeared proves raw mode is on; the block must stay unechoed.
        await waitFor(transcript, markers[0]!, 15_000);
        child.stdin?.write(`${lines.join('\r')}\r`);
      } else {
        for (const [index, line] of lines.entries()) {
          await waitFor(transcript, markers[index]!, 15_000);
          child.stdin?.write(`${line}\r`);
        }
      }
      await waitFor(transcript, 'Initial configuration collected', 15_000);
      child.stdin?.end();
    })();

    return new Promise((resolve, reject) => {
      child.once('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
      child.once('error', reject);
      void typed.catch(reject);
    });
  }

  it('echoes typed answers but never the typed API key', async () => {
    const result = await runUnderPty('typed', [
      'Europe/Berlin',
      '',
      '',
      '',
      'work',
      'sk-pty-key-value',
    ]);
    expect(result.code).toBe(0);
    const transcript = result.stdout + result.stderr;
    // Normal answers echo on the terminal (terminal-mode readline)…
    expect(transcript).toContain('Europe/Berlin');
    expect(transcript).toContain('work');
    // …the typed secret never does, and the summary reports it hidden.
    expect(transcript).not.toContain('sk-pty-key-value');
    expect(transcript).toContain("'work' (API key configured, hidden)");
  }, 40_000);

  it('a whole-block paste never echoes the block — the pasted key stays hidden', async () => {
    const result = await runUnderPty('pasted', [
      'Europe/Berlin',
      '',
      '',
      '',
      'work',
      'sk-pty-key-value',
    ]);
    expect(result.code).toBe(0);
    const transcript = result.stdout + result.stderr;
    // Prompts and the summary are the only terminal output…
    expect(transcript).toContain('IANA time zone to use');
    expect(transcript).toContain('Initial configuration collected');
    expect(transcript).toContain("'work' (API key configured, hidden)");
    // …the pasted block never echoes: the time zone appears exactly once
    // (the summary line), never a second time as terminal echo…
    expect(transcript.split('Europe/Berlin').length - 1).toBe(1);
    // …and the pasted secret appears nowhere at all.
    expect(transcript).not.toContain('sk-pty-key-value');
  }, 40_000);
});

/** Resolves once `read()` contains `marker`; rejects after `timeoutMs`. */
function waitFor(read: () => string, marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (read().includes(marker)) resolve();
      else if (Date.now() > deadline)
        reject(new Error(`timed out waiting for ${JSON.stringify(marker)}`));
      else setTimeout(tick, 50);
    };
    tick();
  });
}
