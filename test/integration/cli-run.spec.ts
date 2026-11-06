import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { lockFilePath } from '../../src/server/single-instance';
import { hermeticChildEnv } from '../helpers/hermetic-child-env';
import { createTempDir } from '../helpers/isolation';

/**
 * The `run` command through the real launcher (task U-050, spec §5.2/§5.6):
 * `bin/quotameter.mjs run` starts the actual server over a temporary
 * configuration and shuts down cleanly on SIGTERM — the executable form of
 * "a fresh init installs a unit that works", since the generated unit's
 * `ExecStart` is exactly this invocation (§5.4).
 *
 * Readiness is the U-001/D-024 handshake discipline expressed through the
 * service's own public surface: the test waits for an answered
 * `GET /api/health` before signalling. An answered request proves the whole
 * `app.start()` settled (the listener is the last component) AND that the
 * SIGTERM handler is installed — the request is served from the event loop's
 * macrotask queue, while `runServer`'s synchronous post-`await app.start()`
 * continuation (keep-alive interval, `installShutdownSignals`) runs on the
 * microtask queue first, so no answered request can precede the handlers.
 * Production never passes `onSignalsReady` (D-024's seam stays a test and
 * embedder channel); the health endpoint is the observable equivalent.
 *
 * Every child gets the D-173 hermetic environment (session-manager
 * variables stripped) plus its own `QUOTAMETER_CONFIG_DIR`/`QUOTAMETER_DATA_DIR`
 * inside a temp directory, and the no-network guard preloaded exactly as in
 * `cli-init.spec.ts` — the suite's configurations define no accounts, so no
 * provider call is expected; the guard makes that certain.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
/** The no-network guard preloaded into every child (see the suite header). */
const GUARD = pathToFileURL(join(REPO_ROOT, 'test/helpers/network-guard.ts')).href;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the launcher with `args` over the given directories; resolves on
 * `close` (both streams drained) with code, signal, and output.
 */
function runLauncher(
  args: readonly string[],
  configDir: string,
  dataDir: string,
): { child: ChildProcess; exited: Promise<RunResult> } {
  const child = spawn(
    process.execPath,
    ['--import', 'jiti/register', '--import', GUARD, BIN, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: {
        ...hermeticChildEnv(),
        QUOTAMETER_CONFIG_DIR: configDir,
        QUOTAMETER_DATA_DIR: dataDir,
      },
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<RunResult>((resolve, reject) => {
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
  return { child, exited };
}

/** Kills the child unless it has already exited. */
function killIfAlive(child: ChildProcess): void {
  if (child.exitCode === null) child.kill('SIGKILL');
}

/**
 * Reserves an unused TCP port for the child's listener (bind `0`, read the
 * assignment, release); the server-main suite's own helper, same rationale.
 */
async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * One child boot through jiti plus the health poll and the exit phase —
 * the server-main children measured 1.9–2.0 s ambient and ≈5.5 s worst in a
 * full coverage `make check` under the six-hog rig (D-163), and the
 * launcher adds the dispatch-graph transpile; 40 s is the house value for
 * the real-launcher shape (the cli-init-service suite's) at well past 3×
 * that worst, per D-094.
 */
const LAUNCHER_TIMEOUT = 40_000;

/** The health-poll budget: one full child boot to a listening server. */
const HEALTH_WAIT_TIMEOUT_MS = 20_000;

describe('quotameter run (real launcher)', () => {
  it(
    'starts the real server over a temporary configuration and exits 0 after a clean SIGTERM shutdown',
    async () => {
      const port = await reservePort();
      const dir = await createTempDir('qm-run-u050-');
      let spawned: ChildProcess | undefined;
      try {
        const configDir = join(dir.path, 'config');
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        await writeConfigFile(configFilePath(configDir), {
          app: { timezone: 'UTC' },
          server: { host: '127.0.0.1', port },
        });
        const dataDir = join(dir.path, 'data');
        const started = runLauncher(['run'], configDir, dataDir);
        spawned = started.child;

        // The readiness handshake (suite header): /api/health answering is
        // the proof the server is up AND the signal handlers exist.
        await vi.waitFor(
          async () => {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`);
            expect(response.status).toBe(200);
            const body = (await response.json()) as { status?: string };
            expect(body.status).toBe('ok');
          },
          { timeout: HEALTH_WAIT_TIMEOUT_MS, interval: 100 },
        );

        spawned.kill('SIGTERM');
        const result = await started.exited;

        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        // §5.6's graceful shutdown released the single-instance lock (the
        // lock component's stop removes it) and checkpointed storage — the
        // lock file's absence is the observable half.
        expect(existsSync(lockFilePath(dataDir))).toBe(false);
        // The pre-logger fatal channel stayed silent: no startup or stop
        // failure was reported (node:sqlite's ExperimentalWarning is
        // expected stderr noise for a real database open, not an error).
        expect(result.stderr).not.toMatch(/quotameter: /);
      } finally {
        if (spawned) killIfAlive(spawned);
        await dir.remove();
      }
    },
    LAUNCHER_TIMEOUT,
  );

  it(
    'refuses to start on an invalid configuration and exits 1 (§6.2)',
    async () => {
      const dir = await createTempDir('qm-run-invalid-u050-');
      try {
        const configDir = join(dir.path, 'config');
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        // Raw bytes, deliberately invalid: `server` must be an object.
        await writeFile(configFilePath(configDir), '{"server": "not an object"}\n', {
          mode: 0o600,
        });
        const { child, exited } = runLauncher(['run'], configDir, join(dir.path, 'data'));
        try {
          const result = await exited;

          expect(result.code).toBe(1);
          expect(result.stdout).toBe('');
          // runServer's fatal channel explains the refusal with the §6.2
          // pipeline's field-addressed problems.
          expect(result.stderr).toMatch(/quotameter: refusing to start: invalid configuration/);
        } finally {
          killIfAlive(child);
        }
      } finally {
        await dir.remove();
      }
    },
    LAUNCHER_TIMEOUT,
  );

  it(
    'keeps the server module graph out of unrelated invocations (--help)',
    async () => {
      // The lazy-import pin, inverse direction: `--help` loads the dispatch
      // table (every command module, `run.ts` included) but must NOT load the
      // server graph — `node:sqlite`'s ExperimentalWarning on stderr is the
      // observable trace the composition's storage module would leave.
      const dir = await createTempDir('qm-run-help-u050-');
      try {
        const { child, exited } = runLauncher(
          ['--help'],
          join(dir.path, 'config'),
          join(dir.path, 'data'),
        );
        let result: RunResult;
        try {
          result = await exited;
        } finally {
          killIfAlive(child);
        }

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Usage: quotameter <command> [options]');
        expect(result.stderr).not.toMatch(/node:sqlite/);
      } finally {
        await dir.remove();
      }
    },
    LAUNCHER_TIMEOUT,
  );
});
