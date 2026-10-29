import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * Test isolation helpers (spec §11, §17).
 *
 * Rules enforced by convention:
 * - every test-owned directory comes from `createTempDir`/`withTempDir` and is
 *   removed automatically at the end of the scope;
 * - fake timers are always restored, even when the body throws;
 * - deferred cleanups are flushed exactly once.
 */

export interface TempDir {
  /** Absolute path of the temporary directory. */
  path: string;
  /** Remove the directory recursively. Safe to call twice. */
  remove(): Promise<void>;
}

/** Creates a unique temporary directory (removed best-effort on process exit). */
export async function createTempDir(prefix = 'quotameter-test-'): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  let removed = false;
  return {
    path,
    async remove() {
      if (removed) return;
      removed = true;
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `body` with a fresh temporary directory and removes it afterwards,
 * including a uniquely named SQLite file helper for storage tests.
 */
export async function withTempDir(
  body: (dir: TempDir & { sqlitePath: (name?: string) => string }) => Promise<void> | void,
): Promise<void> {
  const dir = await createTempDir();
  try {
    await body({
      ...dir,
      sqlitePath: (name = 'test.sqlite') => join(dir.path, name),
    });
  } finally {
    await dir.remove();
  }
}

/**
 * Collects cleanup callbacks and flushes them once, in reverse registration
 * order. Intended for `afterEach`/`afterAll` blocks:
 *
 * ```ts
 * const cleanup = deferList();
 * afterAll(() => cleanup.flush());
 * ```
 */
export function deferList(): {
  defer(fn: () => void | Promise<void>): void;
  flush(): Promise<void>;
} {
  const fns: Array<() => void | Promise<void>> = [];
  let flushed = false;
  return {
    defer(fn) {
      if (flushed) throw new Error('deferList.flush() already ran; cannot defer more work');
      fns.push(fn);
    },
    async flush() {
      if (flushed) return;
      flushed = true;
      for (const fn of fns.reverse()) {
        await fn();
      }
    },
  };
}

/**
 * Installs fake timers for the duration of `body` and restores real timers
 * afterwards, even on failure. The helpers mirror `vi` for convenience.
 */
export async function withFakeTimers(
  body: (clock: {
    advanceMs: (ms: number) => void;
    runAllTimersAsync: () => Promise<void>;
  }) => Promise<void> | void,
): Promise<void> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await body({
      advanceMs: (ms) => vi.advanceTimersByTime(ms),
      runAllTimersAsync: async () => {
        await vi.runAllTimersAsync();
      },
    });
  } finally {
    vi.useRealTimers();
  }
}
