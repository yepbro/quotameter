import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleComponent } from '../../src/server/app';
import { QuotameterApp } from '../../src/server/app';
import { runServer } from '../../src/server/main';
import {
  createSingleInstanceLock,
  isProcessAlive,
  lockFilePath,
} from '../../src/server/single-instance';
import { createTempDir } from '../helpers/isolation';

/**
 * Single-instance protection over the real filesystem (task 074, spec §5.6,
 * §17.1): mutual exclusion per data directory, lock release on normal
 * shutdown, automatic recovery of stale locks left by crashed holders, and
 * safe behavior under acquisition races. The process-boundary scenarios run
 * real child processes through `test/helpers/singleInstanceRunner.ts`, which
 * uses the actual lock module — the honest level for "the second process
 * exits with an actionable error".
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = join(REPO_ROOT, 'test/helpers/singleInstanceRunner.ts');

/** A PID no test process ever has; injected probes decide its liveness. */
const GHOST_PID = 4100001;

/** Reads and parses the lock file of `dataDir`. */
async function readLock(dataDir: string): Promise<{ pid: number }> {
  const content = await fs.readFile(lockFilePath(dataDir), 'utf8');
  const parsed: unknown = JSON.parse(content);
  return { pid: (parsed as { pid: number }).pid };
}

/** Installs a crafted lock file, simulating an existing holder. */
async function craftLock(dataDir: string, content: string): Promise<void> {
  await fs.writeFile(lockFilePath(dataDir), content, 'utf8');
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Spawns the real lock module in a child process (see the runner header). */
function spawnRunner(
  mode: 'hold' | 'run',
  dataDir: string,
): { child: ChildProcess; exited: Promise<ExitResult> } {
  const child = spawn(process.execPath, ['--import', 'jiti/register', RUNNER], {
    env: {
      ...process.env,
      QUOTAMETER_TEST_RUNNER_DATA_DIR: dataDir,
      QUOTAMETER_TEST_RUNNER_MODE: mode,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  // 'close' (not 'exit'): stdio is drained by then, so stderr is complete.
  const exited = new Promise<ExitResult>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr: Buffer.concat(chunks).toString('utf8') });
    });
  });
  return { child, exited };
}

/** Kills the child unless it has already exited. */
function killIfAlive(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(
    () => {
      expect(existsSync(file), `expected ${file} to appear`).toBe(true);
    },
    { timeout: timeoutMs, interval: 25 },
  );
}

describe('createSingleInstanceLock', () => {
  it('acquires the lock, records its own pid, and releases it on stop', async () => {
    const dir = await createTempDir('quotameter-lock-happy-');
    try {
      expect(lockFilePath(dir.path)).toBe(join(dir.path, '.quotameter.lock'));
      const lock = createSingleInstanceLock({ dataDir: dir.path });

      await lock.start();

      expect(existsSync(lockFilePath(dir.path))).toBe(true);
      const payload: unknown = JSON.parse(await fs.readFile(lockFilePath(dir.path), 'utf8'));
      const { pid, id } = payload as { pid: unknown; id: unknown };
      expect(pid).toBe(process.pid);
      // Every acquisition carries a unique token that identifies it at release.
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      await lock.stop();

      expect(existsSync(lockFilePath(dir.path))).toBe(false);
      // No scratch or recovery files are left behind in the data directory.
      expect(readdirSync(dir.path)).toEqual([]);
      // A second stop is a no-op.
      await lock.stop();
      expect(readdirSync(dir.path)).toEqual([]);
    } finally {
      await dir.remove();
    }
  });

  it('refuses a second acquirer on the same data directory and keeps the lock intact', async () => {
    const dir = await createTempDir('quotameter-lock-taken-');
    try {
      const first = createSingleInstanceLock({ dataDir: dir.path });
      await first.start();

      const second = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => true,
      });
      await expect(second.start()).rejects.toThrow(
        new RegExp(
          `refusing to start: another quotameter instance \\(pid ${process.pid}\\) is using data ` +
            `directory ${escapeRegExp(dir.path)}; stop that process first`,
        ),
      );
      // The refusal message names the lock file as the way out.
      await expect(second.start()).rejects.toThrow(lockFilePath(dir.path));
      // The running holder is untouched.
      expect((await readLock(dir.path)).pid).toBe(process.pid);
      await first.stop();
    } finally {
      await dir.remove();
    }
  });

  it('lets instances with different data directories coexist', async () => {
    const dirA = await createTempDir('quotameter-lock-coexist-a-');
    const dirB = await createTempDir('quotameter-lock-coexist-b-');
    try {
      const a = createSingleInstanceLock({ dataDir: dirA.path });
      const b = createSingleInstanceLock({ dataDir: dirB.path });

      await Promise.all([a.start(), b.start()]);

      expect((await readLock(dirA.path)).pid).toBe(process.pid);
      expect((await readLock(dirB.path)).pid).toBe(process.pid);

      await Promise.all([a.stop(), b.stop()]);
      expect(existsSync(lockFilePath(dirA.path))).toBe(false);
      expect(existsSync(lockFilePath(dirB.path))).toBe(false);
    } finally {
      await Promise.all([dirA.remove(), dirB.remove()]);
    }
  });

  it('breaks a stale lock whose holder pid is no longer alive', async () => {
    const dir = await createTempDir('quotameter-lock-stale-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);

      const lock = createSingleInstanceLock({ dataDir: dir.path, isAlive: () => false });
      await lock.start();

      expect((await readLock(dir.path)).pid).toBe(process.pid);
      expect(readdirSync(dir.path)).toEqual(['.quotameter.lock']);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('tolerates unknown extra fields in a stale lock payload', async () => {
    const dir = await createTempDir('quotameter-lock-extra-fields-');
    try {
      await craftLock(dir.path, `{"pid":${GHOST_PID},"writtenBy":"a future version"}\n`);

      const lock = createSingleInstanceLock({ dataDir: dir.path, isAlive: () => false });
      await lock.start();

      expect((await readLock(dir.path)).pid).toBe(process.pid);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('retries when the blocking lock vanishes before inspection', async () => {
    const dir = await createTempDir('quotameter-lock-vanish-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      const lockPath = lockFilePath(dir.path);
      const contended: string[] = [];

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        // The holder releases its lock right after we noticed the contention.
        onContended: () => {
          contended.push(lockPath);
          rmSync(lockPath);
        },
      });
      await lock.start();

      expect(contended).toEqual([lockPath]);
      expect((await readLock(dir.path)).pid).toBe(process.pid);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('retries when the stale lock disappears before the break', async () => {
    const dir = await createTempDir('quotameter-lock-break-vanish-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      const lockPath = lockFilePath(dir.path);

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => {
          // The stale lock disappears between our inspection and our
          // stale-break: another contender removed it first.
          rmSync(lockPath, { force: true });
          return false;
        },
      });
      await lock.start();

      expect((await readLock(dir.path)).pid).toBe(process.pid);
      expect(readdirSync(dir.path)).toEqual(['.quotameter.lock']);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('restores a lock that a concurrent winner replaced mid-break, then converges', async () => {
    const dir = await createTempDir('quotameter-lock-midbreak-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      const lockPath = lockFilePath(dir.path);
      const probed: number[] = [];
      let replaced = false;

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: (pid) => {
          probed.push(pid);
          if (!replaced) {
            // Between our inspection and our stale-break, a concurrent
            // winner breaks the stale lock and installs a fresh one.
            replaced = true;
            writeFileSync(`${lockPath}.fresh`, `${JSON.stringify({ pid: GHOST_PID + 1 })}\n`);
            renameSync(lockPath, `${lockPath}.taken`);
            renameSync(`${lockPath}.fresh`, lockPath);
          }
          return false;
        },
      });
      await lock.start();

      // The stolen replacement was restored and re-inspected: the second
      // probe saw the winner's pid, and our publish finally succeeded.
      expect(probed).toEqual([GHOST_PID, GHOST_PID + 1]);
      expect((await readLock(dir.path)).pid).toBe(process.pid);
      // The simulated winner's artefact is ours to clean; the module leaves
      // no scratch or recovery files of its own.
      rmSync(`${lockPath}.taken`);
      expect(readdirSync(dir.path)).toEqual(['.quotameter.lock']);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('refuses when the attempt limit is reached under persistent contention', async () => {
    const dir = await createTempDir('quotameter-lock-exhausted-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => false,
        maxAttempts: 1,
      });
      await expect(lock.start()).rejects.toThrow(
        /refusing to start: the attempt limit \(1\) for acquiring the single-instance lock/,
      );
      // The stale lock was broken, but no second publish attempt was made.
      expect(existsSync(lockFilePath(dir.path))).toBe(false);
    } finally {
      await dir.remove();
    }
  });

  it.each([
    'not json at all',
    '',
    '{"pid":"4100001"}',
    '{"pid":0}',
    '{"pid":-3}',
    '{"pid":1.5}',
    '[]',
    '{"other":true}',
    'null',
    '{"pid":4100001}trailing',
  ])('refuses on a damaged lock file (%s) without touching it', async (content: string) => {
    const dir = await createTempDir('quotameter-lock-damaged-');
    try {
      await craftLock(dir.path, content);

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => {
          throw new Error('liveness must not be probed for an unparseable lock');
        },
      });
      await expect(lock.start()).rejects.toThrow(/is not a valid quotameter lock file/);
      await expect(lock.start()).rejects.toThrow(/verify that no quotameter process is running/);
      // The damaged file is left exactly as it was found.
      expect(await fs.readFile(lockFilePath(dir.path), 'utf8')).toBe(content);
    } finally {
      await dir.remove();
    }
  });

  it('treats pid 1 (alive, but owned by another user) as a live holder', async () => {
    const dir = await createTempDir('quotameter-lock-pid1-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: 1 })}\n`);

      // Default probe: process.kill(1, 0) answers EPERM (or success) — alive.
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      await expect(lock.start()).rejects.toThrow(
        /refusing to start: another quotameter instance \(pid 1\) is using data directory/,
      );
    } finally {
      await dir.remove();
    }
  });

  it('refuses with the wrapped errno when the contended lock cannot be read', async () => {
    const dir = await createTempDir('quotameter-lock-eacces-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      // Mode 000 on the lock file (foreign-owned 0600 in production): the
      // publish sees EEXIST, and inspecting the holder then fails — a
      // filesystem failure, not a deliberate refusal, so it surfaces with
      // the data-directory context and the errno (runs as non-root).
      await fs.chmod(lockFilePath(dir.path), 0o000);

      const lock = createSingleInstanceLock({ dataDir: dir.path, isAlive: () => true });
      await expect(lock.start()).rejects.toThrow(
        new RegExp(
          `cannot acquire the single-instance lock for data directory ` +
            `${escapeRegExp(dir.path)}: \\(EACCES\\)`,
        ),
      );
      // The file is left exactly as it was found (restore read access for
      // the assertion; the refusal itself never touched it).
      await fs.chmod(lockFilePath(dir.path), 0o600);
      expect(await fs.readFile(lockFilePath(dir.path), 'utf8')).toBe(
        `${JSON.stringify({ pid: GHOST_PID })}\n`,
      );
    } finally {
      await dir.remove();
    }
  });

  it('wraps a failing liveness probe without inventing an errno for it', async () => {
    const dir = await createTempDir('quotameter-lock-probe-error-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => {
          throw new Error('probe wiring is broken');
        },
      });
      // A code-less Error renders by message alone — no "(code)" prefix.
      await expect(lock.start()).rejects.toThrow(
        new RegExp(
          `cannot acquire the single-instance lock for data directory ` +
            `${escapeRegExp(dir.path)}: probe wiring is broken$`,
        ),
      );
    } finally {
      await dir.remove();
    }
  });

  it('renders a non-Error probe failure as a string, still wrapped with context', async () => {
    const dir = await createTempDir('quotameter-lock-probe-string-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);

      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => {
          throw 'probe exploded';
        },
      });
      await expect(lock.start()).rejects.toThrow(
        new RegExp(
          `cannot acquire the single-instance lock for data directory ` +
            `${escapeRegExp(dir.path)}: probe exploded$`,
        ),
      );
    } finally {
      await dir.remove();
    }
  });

  it('creates the data directory when it does not exist', async () => {
    const root = await createTempDir('quotameter-lock-mkdir-');
    try {
      const dataDir = join(root.path, 'nested', 'data');
      const lock = createSingleInstanceLock({ dataDir });

      await lock.start();

      expect(existsSync(dataDir)).toBe(true);
      expect((await readLock(dataDir)).pid).toBe(process.pid);
      await lock.stop();
    } finally {
      await root.remove();
    }
  });

  it('explains when the data directory path is occupied by a regular file', async () => {
    const root = await createTempDir('quotameter-lock-blocked-');
    try {
      const dataDir = join(root.path, 'blocker');
      writeFileSync(dataDir, 'not a directory\n');

      const lock = createSingleInstanceLock({ dataDir });
      await expect(lock.start()).rejects.toThrow(
        /cannot create the data directory .*blocker.*(EEXIST|ENOTDIR)/,
      );
    } finally {
      await root.remove();
    }
  });

  it.each([
    `{"pid":${GHOST_PID}}\n`,
    `{"pid":${GHOST_PID},"id":"00000000-0000-4000-8000-000000000000"}\n`,
    'not json at all',
    'null',
    '42',
  ])('leaves a foreign lock alone when releasing one that is no longer ours', async (foreign) => {
    const dir = await createTempDir('quotameter-lock-foreign-release-');
    try {
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      await lock.start();

      // A recovery race replaced the path after our acquisition — with an
      // id-less writer, a different acquisition's token, or plain garbage.
      rmSync(lockFilePath(dir.path));
      writeFileSync(lockFilePath(dir.path), foreign);

      await expect(lock.stop()).resolves.toBeUndefined();
      expect(await fs.readFile(lockFilePath(dir.path), 'utf8')).toBe(foreign);
    } finally {
      await dir.remove();
    }
  });
});

describe('isProcessAlive', () => {
  it('reports the current process and pid 1 as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(1)).toBe(true);
  });
});

describe('QuotameterApp integration (task 060 seam)', () => {
  it('acquires the lock at start and releases it last at stop', async () => {
    const dir = await createTempDir('quotameter-lock-app-');
    try {
      const lockPath = lockFilePath(dir.path);
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      const lockStillHeldWhenSiblingStopped: boolean[] = [];
      const sibling: LifecycleComponent = {
        name: 'sibling',
        async start() {},
        async stop() {
          // The lock must still be held while earlier components stop.
          lockStillHeldWhenSiblingStopped.push(existsSync(lockPath));
        },
      };
      const app = new QuotameterApp({ components: [lock, sibling] });

      await app.start();

      expect(app.running).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      await app.stop();

      expect(app.state).toBe('stopped');
      expect(lockStillHeldWhenSiblingStopped).toEqual([true]);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await dir.remove();
    }
  });

  it('releases the lock when a later component fails to start', async () => {
    const dir = await createTempDir('quotameter-lock-rollback-');
    try {
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      const failing: LifecycleComponent = {
        name: 'failing',
        async start() {
          throw new Error('later component exploded');
        },
        async stop() {},
      };
      const app = new QuotameterApp({ components: [lock, failing] });

      await expect(app.start()).rejects.toThrow('later component exploded');

      expect(app.state).toBe('failed');
      expect(existsSync(lockFilePath(dir.path))).toBe(false);
    } finally {
      await dir.remove();
    }
  });
});

describe('runServer integration', () => {
  /** Captures fatal diagnostics written to stderr; restores on `restore()`. */
  function captureStderr(): { lines(): string; restore(): void } {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      lines: () => spy.mock.calls.map((call) => String(call[0])).join(''),
      restore: () => spy.mockRestore(),
    };
  }

  it('exits 1 and explains when the data directory is already in use', async () => {
    const dir = await createTempDir('quotameter-lock-runserver-');
    const stderr = captureStderr();
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);

      const code = await runServer({
        components: [createSingleInstanceLock({ dataDir: dir.path, isAlive: () => true })],
      });

      expect(code).toBe(1);
      expect(stderr.lines()).toMatch(
        new RegExp(
          `quotameter: refusing to start: another quotameter instance \\(pid ${GHOST_PID}\\) ` +
            `is using data directory ${escapeRegExp(dir.path)}`,
        ),
      );
    } finally {
      stderr.restore();
      await dir.remove();
    }
  });
});

describe('real processes (child, via singleInstanceRunner)', () => {
  const CHILD_TIMEOUT = 20_000;

  it(
    'makes a second real process exit 1 with an actionable error',
    async () => {
      const dir = await createTempDir('quotameter-lock-child-second-');
      const holder = spawnRunner('hold', dir.path);
      try {
        await waitForFile(join(dir.path, 'held'));

        const second = spawnRunner('run', dir.path);
        const result = await second.exited;

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(
          /quotameter: refusing to start: another quotameter instance \(pid \d+\) is using data/,
        );
        expect(result.stderr).toContain(dir.path);
        // The holder keeps running and holding.
        expect((await readLock(dir.path)).pid).toBe(holder.child.pid);
      } finally {
        killIfAlive(holder.child);
        await holder.exited;
        await dir.remove();
      }
    },
    CHILD_TIMEOUT,
  );

  it(
    'releases the lock on SIGTERM and exits 0, after refusing a contender',
    async () => {
      const dir = await createTempDir('quotameter-lock-child-release-');
      const first = spawnRunner('run', dir.path);
      try {
        // Wait for signal readiness, not the lock file: the lock appears
        // inside `app.start()`, but `runServer` installs the SIGTERM/SIGINT
        // handlers only afterwards, and a signal delivered in that window
        // kills the handler-less child via the OS-default disposition (the
        // U-001 race). `signals-ready` is emitted only once both handlers
        // are installed — and implies the lock is held — so the SIGTERM
        // below is always caught (D-024 seam, shared with serverMainRunner).
        await waitForFile(join(dir.path, 'signals-ready'));

        // A contender proves the first process really holds the lock.
        const contender = spawnRunner('run', dir.path);
        const refusal = await contender.exited;
        expect(refusal.code).toBe(1);

        first.child.kill('SIGTERM');
        const result = await first.exited;

        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(existsSync(lockFilePath(dir.path))).toBe(false);
      } finally {
        killIfAlive(first.child);
        await first.exited;
        await dir.remove();
      }
    },
    CHILD_TIMEOUT,
  );

  it(
    'recovers a genuinely stale lock after the holder is SIGKILLed',
    async () => {
      const dir = await createTempDir('quotameter-lock-child-crash-');
      const holder = spawnRunner('hold', dir.path);
      try {
        await waitForFile(join(dir.path, 'held'));
        const holderPid = (await readLock(dir.path)).pid;
        expect(holderPid).toBe(holder.child.pid);

        // Hard kill: no shutdown handler runs, so the lock file is stale.
        holder.child.kill('SIGKILL');
        await holder.exited;

        expect(isProcessAlive(holderPid)).toBe(false);

        // The default liveness probe sees the dead pid and breaks the lock.
        const lock = createSingleInstanceLock({ dataDir: dir.path });
        await lock.start();
        expect((await readLock(dir.path)).pid).toBe(process.pid);
        await lock.stop();
        expect(existsSync(lockFilePath(dir.path))).toBe(false);
      } finally {
        killIfAlive(holder.child);
        await holder.exited;
        await dir.remove();
      }
    },
    CHILD_TIMEOUT,
  );
});

/** Escapes a literal string for embedding into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('createSingleInstanceLock (U-006 mutation triage)', () => {
  it('carries the documented component name', async () => {
    const dir = await createTempDir('quotameter-lock-name-');
    try {
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      expect(lock.name).toBe('single-instance-lock');
      await lock.start();
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('creates the lock file with owner-only permissions (0600)', async () => {
    const dir = await createTempDir('quotameter-lock-mode-');
    try {
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      await lock.start();
      const stat = await fs.stat(lockFilePath(dir.path));
      expect(stat.mode & 0o777).toBe(0o600);
      await lock.stop();
    } finally {
      await dir.remove();
    }
  });

  it('states the full attempt-limit remedy in the refusal message', async () => {
    const dir = await createTempDir('quotameter-lock-limit-tail-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      const lock = createSingleInstanceLock({
        dataDir: dir.path,
        isAlive: () => false,
        maxAttempts: 1,
      });
      await expect(lock.start()).rejects.toThrow(
        new RegExp(
          `refusing to start: the attempt limit \\(1\\) for acquiring the single-instance lock ` +
            `of data directory ${escapeRegExp(dir.path)} was reached; concurrent contention ` +
            `persists; retry once the other starter has settled$`,
        ),
      );
    } finally {
      await dir.remove();
    }
  });

  it('reports the errno of a failed publish and keeps the cause', async () => {
    const dir = await createTempDir('quotameter-lock-publish-errno-');
    try {
      // A directory at the lock path: the publish cannot take the path, and
      // inspecting the "holder" then fails reading a directory — a
      // filesystem failure, not contention, so it must surface with the
      // errno and the original error as `cause` (the exact errno differs by
      // filesystem: EPERM from link(2) on ext4, EISDIR from the read on
      // overlayfs).
      await fs.mkdir(lockFilePath(dir.path));
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      const error = await lock.start().catch((thrown: unknown) => thrown);
      expect((error as Error).message).toMatch(
        new RegExp(
          `cannot acquire the single-instance lock for data directory ` +
            `${escapeRegExp(dir.path)}: \\((EPERM|EISDIR)\\)`,
        ),
      );
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      await dir.remove();
    }
  });

  it('keeps the errno and cause of a data-directory creation failure', async () => {
    const root = await createTempDir('quotameter-lock-mkdir-cause-');
    try {
      const blocker = join(root.path, 'blocker');
      writeFileSync(blocker, 'not a directory\n');
      const lock = createSingleInstanceLock({ dataDir: join(blocker, 'nested') });
      const error = await lock.start().catch((thrown: unknown) => thrown);
      expect((error as Error).message).toMatch(/\(EEXIST\)|\(ENOTDIR\)/);
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      await root.remove();
    }
  });

  it('reports the write errno, not the cleanup errno, on a read-only directory', async () => {
    const dir = await createTempDir('quotameter-lock-readonly-');
    try {
      await fs.chmod(dir.path, 0o500);
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      // The scratch write fails with EACCES; the force-rm of the never-created
      // scratch file must not replace that errno with ENOENT.
      await expect(lock.start()).rejects.toThrow(/\(EACCES\)/);
    } finally {
      await fs.chmod(dir.path, 0o700);
      await dir.remove();
    }
  });

  it('closes the inspection handle before refusing a live holder', async () => {
    const dir = await createTempDir('quotameter-lock-fd-');
    try {
      await craftLock(dir.path, `${JSON.stringify({ pid: GHOST_PID })}\n`);
      const lock = createSingleInstanceLock({ dataDir: dir.path, isAlive: () => true });
      await expect(lock.start()).rejects.toThrow(/is using data directory/);
      // No file descriptor may remain open on the inspected lock file.
      const openOnLock = [] as string[];
      for (const entry of await fs.readdir('/proc/self/fd')) {
        const target = await fs.readlink(`/proc/self/fd/${entry}`).catch(() => '');
        if (target === lockFilePath(dir.path)) openOnLock.push(entry);
      }
      expect(openOnLock).toEqual([]);
    } finally {
      await dir.remove();
    }
  });

  it('puts a foreign null-payload lock back in place when releasing', async () => {
    const dir = await createTempDir('quotameter-lock-foreign-null-');
    try {
      const lock = createSingleInstanceLock({ dataDir: dir.path });
      await lock.start();
      // A recovery race left a payload whose token cannot even be extracted —
      // release must treat it as not-ours and restore it, never drop it.
      rmSync(lockFilePath(dir.path));
      writeFileSync(lockFilePath(dir.path), 'null');
      await expect(lock.stop()).resolves.toBeUndefined();
      expect(await fs.readFile(lockFilePath(dir.path), 'utf8')).toBe('null');
    } finally {
      await dir.remove();
    }
  });
});
