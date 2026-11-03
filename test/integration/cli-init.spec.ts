import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '../../src/config/load';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The interactive `init` command end-to-end (task 130, spec §5.3; decision
 * D-099): the real launcher (`bin/quotameter.mjs` through jiti, the same
 * child-process pattern as `cli-bin.spec.ts`) answering the real readline
 * prompter over a pipe — including the one-chunk piped-input case that
 * drops answers when a prompter relies on `readline`'s own `question()`.
 * The final cases run under a real PTY (`script`) to prove the typed API
 * key never reaches the terminal while normal answers do echo.
 *
 * Since task 132 a successful run writes the configuration (spec §5.3 step
 * 5), and since task 133 a collected key runs the initial connection test
 * (§5.3 step 6) — through the real production provider, which in these
 * child processes must never reach the real provider endpoint: the test
 * no-network guard is preloaded into the child (`--import`), so the check
 * fails deterministically as the `provider-unavailable` class and every
 * keyed script answers the §5.3 offer afterwards (`y`). The happy-path and
 * both failure classes through the real adapter are covered against the
 * loopback mock provider server by `test/integration/cli-init-account.spec.ts`.
 * Every run gets its own temporary configuration directory through
 * `QUOTAMETER_CONFIG_DIR` — no shared state, nothing in the container home.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every child (see the suite header). */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;
const NODE_ARGS = ['--import', 'jiti/register', '--import', GUARD, BIN, 'init'];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `quotameter init` with `stdinData` piped in, stdin then closed, and
 * the configuration redirected into `configDir`. Since U-042 a
 * password-writing run revokes the sessions of any surviving database in
 * the data directory, so every run gets its own temporary data directory
 * too (hermetic — never the container's shared default).
 */
async function runInit(stdinData: string, configDir: string): Promise<RunResult> {
  const dataDir = await createTempDir('qm-init-130-data-');
  const child = spawn(process.execPath, NODE_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QUOTAMETER_CONFIG_DIR: configDir,
      QUOTAMETER_DATA_DIR: dataDir.path,
    },
  });
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
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      child.once('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
      child.once('error', reject);
    });
  } finally {
    await dataDir.remove();
  }
}

/** A fresh temporary configuration directory per run (task 132: init writes). */
async function freshConfigDir(): Promise<TempDir> {
  return createTempDir('qm-init-130-');
}

describe('quotameter init (piped stdin, real launcher)', () => {
  /** The marker password of the keyed runs (§15.2 minimum met). */
  const PIPE_PASSWORD = 'integration-password-marker-42';

  it('collects, validates, tests, writes, and summarizes — key never printed', async () => {
    const dir = await freshConfigDir();
    try {
      // The child's connection test is guard-blocked (deterministic
      // `provider-unavailable`), so the run explains the failure, asks the
      // §5.3 offer, and the scripted `y` keeps the account. Since U-042 the
      // non-loopback bind collects the password pair before the test
      // (§5.3 step 4, D-141) — stored as a real scrypt hash, never echoed.
      const result = await runInit(
        `Europe/Berlin\n0.0.0.0\n9000\n120\nwork\nsk-e2e-key-value\n${PIPE_PASSWORD}\n${PIPE_PASSWORD}\ny\n`,
        dir.path,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Time zone:         Europe/Berlin');
      expect(result.stdout).toContain('Bind host:         0.0.0.0');
      expect(result.stdout).toContain('Port:              9000');
      expect(result.stdout).toContain('Polling interval:  120 seconds');
      expect(result.stdout).toContain(
        "'work' (API key configured, hidden; connection test failed: " +
          'provider-unavailable — stored in error state)',
      );
      expect(result.stdout).toContain('Password:          set (only a scrypt hash is stored)');
      expect(result.stderr).toContain("the initial connection test for 'work' failed:");
      expect(result.stderr).toContain('the check was inconclusive');
      expect(result.stdout + result.stderr).not.toContain('sk-e2e-key-value');
      expect(result.stdout + result.stderr).not.toContain(PIPE_PASSWORD);
      // Task 133: the run wrote the configuration with the account — the
      // key inside the file (§6.3, D-004), never in any stream. Task
      // U-042: the password lives in the same file as its scrypt hash
      // only (§15.2) — the plaintext appears nowhere, not even the file.
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
          apiKey: 'sk-e2e-key-value',
        },
      ]);
      expect(JSON.stringify(config)).toContain('sk-e2e-key-value');
      expect(JSON.stringify(config)).not.toContain(PIPE_PASSWORD);
      const auth = config.auth as { mode?: string; passwordHash?: string };
      expect(auth.mode).toBe('auto');
      expect(auth.passwordHash).toMatch(/^scrypt\$/);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('empty lines take the shown defaults, skip the account, and skip the password', async () => {
    const dir = await freshConfigDir();
    try {
      // The sixth empty line skips the optional §5.3 step-4 password
      // (loopback bind) — the done-condition's §15.1 half at the real
      // launcher: completing init without a password keeps `auto`/no hash.
      const result = await runInit('UTC\n\n\n\n\n\n', dir.path);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Time zone:         UTC');
      expect(result.stdout).toContain('Bind host:         127.0.0.1');
      expect(result.stdout).toContain('Port:              8787');
      expect(result.stdout).toContain('Polling interval:  300 seconds');
      expect(result.stdout).toContain('Account:           none (add one later in the UI)');
      expect(result.stdout).toContain('Password:          none');
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.server).toEqual({ host: '127.0.0.1', port: 8787 });
      expect(config.auth).toEqual({ mode: 'auto' });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('an empty time-zone answer is rejected loudly, not defaulted to the hint', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('\nUTC\n\n\n\n\n\n', dir.path);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Time zone is required');
      expect(result.stderr).toContain('never applies the system time zone');
      expect(result.stdout).toContain('Time zone:         UTC');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('invalid answers complain on stderr and are asked again', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('Nope/Zone\nUTC\n\nabc\n8788\n\n\n\n', dir.path);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("'Nope/Zone' is not a valid IANA time zone");
      expect(result.stderr).toContain("Port must be a whole number (got 'abc')");
      expect(result.stdout).toContain('Port:              8788');
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('a too-short password on a non-loopback bind draws the §15.2 complaint', async () => {
    const dir = await freshConfigDir();
    try {
      // The required pair: a short first answer is complained about and
      // re-asked; a valid pair then stores the hash (the marker never
      // reaches any stream).
      const marker = 'piped-password-marker-42';
      const result = await runInit(`UTC\n0.0.0.0\n\n\n\nshort\n${marker}\n${marker}\n`, dir.path);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        'the password must be at least 12 characters long — try again',
      );
      expect(result.stdout + result.stderr).not.toContain(marker);
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as {
        auth?: { passwordHash?: string };
      };
      expect(config.auth?.passwordHash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(config)).not.toContain(marker);
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('three rejected password attempts on a non-loopback bind cancel the run', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('UTC\n0.0.0.0\n\n\n\n\n\n\n', dir.path);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('quotameter init: too many unsuccessful password attempts');
      await expect(readFile(configFilePath(dir.path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('EOF at the password question cancels the run (no default, no file)', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('UTC\n\n\n\n\n', dir.path);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'quotameter init: input closed before the password was answered — initialization cancelled',
      );
      await expect(readFile(configFilePath(dir.path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('EOF before any answer cancels with exit 1 — no hang, no default, no file', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('', dir.path);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'quotameter init: input closed before the questions were answered — initialization cancelled',
      );
      await expect(readFile(configFilePath(dir.path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dir.remove();
    }
  }, 20_000);

  it('EOF mid-flow cancels with exit 1 and prints no summary', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runInit('Europe/Berlin\n', dir.path);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('input closed before the questions were answered');
      expect(result.stdout).not.toContain('Initial configuration collected');
    } finally {
      await dir.remove();
    }
  }, 20_000);
});

describe('quotameter init (real PTY, hidden key entry)', () => {
  /** The marker password of the PTY runs (§15.2 minimum met). */
  const PTY_PASSWORD = 'pty-password-marker-42';

  /**
   * Runs the launcher under a PTY via `script`. Each answer is written only
   * after its prompt has appeared (the D-087 readiness-marker pattern, not
   * fixed sleeps): the transcript is the observable that proves the child is
   * in raw mode and at the right question, so the runs stay deterministic
   * under load and cannot accidentally type the key into an earlier prompt.
   */
  async function runUnderPty(
    mode: 'typed' | 'pasted',
    lines: readonly string[],
    configDir: string,
  ): Promise<RunResult> {
    // A per-run temporary data directory: the typed/pasted password means
    // the child revokes surviving sessions, which must never reach the
    // container's shared default data directory.
    const dataDir = await createTempDir('qm-init-130-pty-data-');
    const command = [process.execPath, ...NODE_ARGS].map((part) => JSON.stringify(part)).join(' ');
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QUOTAMETER_CONFIG_DIR: configDir,
        QUOTAMETER_DATA_DIR: dataDir.path,
      },
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
      // Task 133: the guard-blocked connection test makes the keyed runs
      // fail into the §5.3 offer — the extra marker and answer step.
      // Task U-042: the password pair sits between the key and the offer;
      // its two markers prove the muted secret questions really ran on
      // the terminal before the typed/pasted secret is judged unechoed.
      const markers = [
        'IANA time zone to use',
        'Bind host',
        'Port (Enter for 8787)',
        'Polling interval',
        'account label',
        "API key for 'work'",
        'Web password (at least 12 characters',
        'Confirm password:',
        "Keep 'work' configured anyway?",
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

    try {
      return await new Promise<RunResult>((resolve, reject) => {
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
    } finally {
      await dataDir.remove();
    }
  }

  it('echoes typed answers but never the typed API key or password', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runUnderPty(
        'typed',
        ['Europe/Berlin', '', '', '', 'work', 'sk-pty-key-value', PTY_PASSWORD, PTY_PASSWORD, 'y'],
        dir.path,
      );
      expect(result.code).toBe(0);
      const transcript = result.stdout + result.stderr;
      // Normal answers echo on the terminal (terminal-mode readline)…
      expect(transcript).toContain('Europe/Berlin');
      expect(transcript).toContain('work');
      // …the typed secrets never do, and the summary reports them hidden.
      expect(transcript).not.toContain('sk-pty-key-value');
      expect(transcript).toContain('API key configured, hidden');
      expect(transcript).not.toContain(PTY_PASSWORD);
      expect(transcript).toContain('Password:          set (only a scrypt hash is stored)');
      // The guard-blocked connection test is explained (the §5.3 step-6
      // failure contract) without ever naming the key…
      expect(transcript).toContain("the initial connection test for 'work' failed:");
      expect(transcript).toContain('the check was inconclusive');
      expect(transcript).toContain('stored in error state');
      // …and the written configuration carries the account — key inside
      // the file only (§6.3, D-004) — plus the password's scrypt hash,
      // never its plaintext (§15.2, D-141).
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(config.accounts).toEqual([
        {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'work',
          enabled: true,
          apiKey: 'sk-pty-key-value',
        },
      ]);
      expect((config.auth as { passwordHash?: string }).passwordHash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(config)).not.toContain(PTY_PASSWORD);
      expect(transcript).not.toContain('sk-pty-key-value');
    } finally {
      await dir.remove();
    }
  }, 40_000);

  it('a whole-block paste never echoes the block — the pasted key stays hidden', async () => {
    const dir = await freshConfigDir();
    try {
      const result = await runUnderPty(
        'pasted',
        ['Europe/Berlin', '', '', '', 'work', 'sk-pty-key-value', PTY_PASSWORD, PTY_PASSWORD, 'y'],
        dir.path,
      );
      expect(result.code).toBe(0);
      const transcript = result.stdout + result.stderr;
      // Prompts and the summary are the only terminal output…
      expect(transcript).toContain('IANA time zone to use');
      expect(transcript).toContain('Initial configuration collected');
      expect(transcript).toContain('API key configured, hidden');
      expect(transcript).toContain('Password:          set (only a scrypt hash is stored)');
      // …the pasted block never echoes: the time zone appears exactly once
      // (the summary line), never a second time as terminal echo…
      expect(transcript.split('Europe/Berlin').length - 1).toBe(1);
      // …and the pasted secrets appear nowhere at all — not in the
      // transcript and not in the written file, whose auth carries only
      // the scrypt hash (§15.2, D-141).
      expect(transcript).not.toContain('sk-pty-key-value');
      expect(transcript).not.toContain(PTY_PASSWORD);
      const config = JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as {
        auth?: { passwordHash?: string };
      };
      expect(config.auth?.passwordHash).toMatch(/^scrypt\$/);
      expect(JSON.stringify(config)).not.toContain(PTY_PASSWORD);
    } finally {
      await dir.remove();
    }
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
