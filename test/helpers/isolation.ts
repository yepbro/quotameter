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

/** The fake-clock controls {@link withFakeTimers} hands to its body. */
export interface FakeClock {
  /** Advance the fake clock synchronously; timers fire, microtasks do not flush. */
  advanceMs: (ms: number) => void;
  /**
   * Advance the fake clock while flushing the microtask queue between
   * timer firings — the control for promise-chained async waits such as a
   * backoff sleep followed by the next attempt.
   */
  advanceMsAsync: (ms: number) => Promise<void>;
  runAllTimersAsync: () => Promise<void>;
}

/** Options for {@link withFakeTimers}. */
export interface FakeTimerOptions {
  /**
   * Whether real elapsed time keeps advancing the fake clock (default
   * `true`, for bodies that await real-timer work under fake timers).
   * Exact-boundary timer tests opt out: with drift enabled, a few real
   * milliseconds can push the fake clock past a boundary mid-test and
   * make the assertion flaky (spec §17.3 forbids flaky tests).
   */
  readonly shouldAdvanceTime?: boolean;
  /**
   * The fake clock's starting epoch (default: the current real time).
   * Suites that assert absolute timestamps pin `0` so readings are plain
   * elapsed milliseconds.
   */
  readonly now?: number;
}

/**
 * Installs fake timers for the duration of `body` and restores real timers
 * afterwards, even on failure. The helpers mirror `vi` for convenience.
 */
export async function withFakeTimers(
  body: (clock: FakeClock) => Promise<void> | void,
  options: FakeTimerOptions = {},
): Promise<void> {
  vi.useFakeTimers({ shouldAdvanceTime: options.shouldAdvanceTime ?? true, now: options.now });
  try {
    await body({
      advanceMs: (ms) => vi.advanceTimersByTime(ms),
      advanceMsAsync: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
      runAllTimersAsync: async () => {
        await vi.runAllTimersAsync();
      },
    });
  } finally {
    vi.useRealTimers();
  }
}
