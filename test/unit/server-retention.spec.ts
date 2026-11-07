import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRetentionSchedule } from '../../src/server/retention';
import type { RetentionScheduleOptions } from '../../src/server/retention';
import { CONFIG_DEFAULTS, type Config } from '../../src/schemas/config';
import type { StorageConnection } from '../../src/storage/connection';
import type { QuotaRepository } from '../../src/storage/repository';
import type {
  RetentionCleanupInput,
  RetentionCleanupOptions,
  RetentionCleanupReport,
} from '../../src/storage/retention-cleanup';
import { DAY_MS } from '../../src/util/rolling-ranges';
import { createFixedClock } from '../../src/util/clock';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * The retention cleanup schedule (task U-053, decision D-178): the
 * component's own matrix — the startup run, the daily re-arm, the
 * read-at-run-time retention window (§6.4), stop's cancellation, and the
 * §16 fault containment — against a spy cleanup and fake timers driving
 * the schedule's real default sleep. The production end-to-end behavior
 * (real cleanup over a real temporary database, real composition) is
 * `test/integration/composition-retention.spec.ts`'s.
 */

/** The fixed clock reading every case starts from: 2026-11-06T12:00:00Z. */
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** A minimal configuration whose retention window the harness can change. */
const configOf = (historyRetentionDays?: number): Config =>
  ({
    app: {
      timezone: 'UTC',
      ...(historyRetentionDays === undefined ? {} : { historyRetentionDays }),
    },
  }) as Config;

/** The empty removal counts of a cleanup that found nothing to delete. */
const NOTHING_REMOVED: RetentionCleanupReport['removed'] = {
  collectionRuns: 0,
  quotaEvents: 0,
  rawResponses: 0,
  sessions: 0,
};

/** One recorded cleanup call: what it was handed. */
interface CleanupCall {
  readonly options: RetentionCleanupOptions;
  readonly input: RetentionCleanupInput;
}

/**
 * The cleanup spy: records every call (the storage connection's database
 * identity included, so the lazy-resolution contract is pinned) and can be
 * scripted to throw. Which phase a call belonged to is the component's
 * own log record's fact (`retention cleanup completed/failed` carries
 * `phase`), not something the call itself can know.
 */
function cleanupSpy() {
  const calls: CleanupCall[] = [];
  let throwNext = 0;
  const runCleanup = (
    options: RetentionCleanupOptions,
    input: RetentionCleanupInput,
  ): RetentionCleanupReport => {
    calls.push({ options, input });
    if (throwNext > 0) {
      throwNext--;
      throw new Error(`injected cleanup failure ${calls.length}`);
    }
    return {
      historyCutoff: input.now - input.retentionDays * DAY_MS,
      rawResponseCutoff: input.now - 30 * DAY_MS,
      removed: NOTHING_REMOVED,
      maintenance: {
        walCheckpoint: { busy: false, walPages: 0, checkpointedPages: 0 },
        autoVacuumMode: 'incremental',
      },
    };
  };
  return {
    calls,
    /** The next `count` cleanup calls throw (contained per §16). */
    failNext(count: number): void {
      throwNext = count;
    },
    runCleanup,
  };
}

/** Everything {@link createRetentionSchedule} needs, with the spy installed. */
function scheduleHarness(config: Config, overrides: Partial<RetentionScheduleOptions> = {}) {
  const clock = createFixedClock(T0);
  const sink: MemoryLogSink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'debug', destination: sink });
  const cleanup = cleanupSpy();
  const database = { mark: 'the-storage-connection-database' };
  const connection = { database } as unknown as StorageConnection;
  const storageState: { open: boolean } = { open: true };
  // The live configuration the schedule reads at each run — mutable so a
  // test can reload §6.4-style between runs.
  let live: Config = config;
  const options: RetentionScheduleOptions = {
    clock,
    logger,
    config: () => live,
    repository: {} as QuotaRepository,
    storage: () => (storageState.open ? connection : undefined),
    runCleanup: cleanup.runCleanup,
    ...overrides,
  };
  return {
    clock,
    sink,
    cleanup,
    database,
    storageState,
    options,
    /** Swaps the live configuration the next run will read. */
    setConfig(next: Config): void {
      live = next;
    },
    schedule: createRetentionSchedule(options),
  };
}

describe('the retention cleanup schedule (U-053, D-178)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the cleanup once at startup with the clock now and the live window', async () => {
    const harness = scheduleHarness(configOf(120));
    await harness.schedule.component.start();
    expect(harness.cleanup.calls.length).toBe(1);
    const [firstCall] = harness.cleanup.calls;
    const call = firstCall!;
    expect(call.input).toEqual({ now: T0, retentionDays: 120 });
    // The repository and the resolved storage connection's database are
    // what the cleanup was handed — the lazy resolution happened at run
    // time, not at construction.
    expect(call.options.database).toBe(harness.database);
    expect(call.options.repository).toBe(harness.options.repository);
    // §16: the start and the completed run are info lifecycle records.
    const startedLine = harness.sink
      .lines()
      .find((line) => line.includes('retention schedule started'));
    expect(startedLine, 'the schedule start is an info record').toBeDefined();
    const completed = harness.sink
      .records()
      .find((record) => record.msg === 'retention cleanup completed');
    expect(completed).toMatchObject({ phase: 'startup', retentionDays: 120 });
    await harness.schedule.component.stop();
  });

  it('falls back to the configured default when the config omits the window', async () => {
    const harness = scheduleHarness(configOf(undefined));
    await harness.schedule.component.start();
    expect(harness.cleanup.calls[0]?.input.retentionDays).toBe(
      CONFIG_DEFAULTS.app.historyRetentionDays,
    );
    await harness.schedule.component.stop();
  });

  it('re-runs daily over the real default sleep', async () => {
    const harness = scheduleHarness(configOf(180));
    await harness.schedule.component.start();
    // One day passes on both faces the schedule sees: the fake timer
    // drives the default sleep, the fixed clock is the shared clock the
    // run reads its `now` from (D-021) — advanced here to prove the read
    // happens at run time, not at schedule time.
    harness.clock.advance(DAY_MS);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(2);
    expect(harness.cleanup.calls[1]?.input.now).toBe(T0 + DAY_MS);
    harness.clock.advance(DAY_MS);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(3);
    expect(
      harness.sink
        .records()
        .filter((record) => record.msg === 'retention cleanup completed')
        .map((record) => record.phase),
    ).toEqual(['startup', 'daily', 'daily']);
    await harness.schedule.component.stop();
  });

  it('reads the retention window at run time — a reload between runs applies at the next run', async () => {
    // §6.4/§11.3: the reduced window applies at the NEXT cleanup, so a
    // config reader is the only reload surface the schedule needs.
    const harness = scheduleHarness(configOf(180));
    await harness.schedule.component.start();
    expect(harness.cleanup.calls[0]?.input.retentionDays).toBe(180);
    // The operator reduces retention (§6.4: no restart, no feed)…
    harness.setConfig(configOf(30));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls[1]?.input.retentionDays).toBe(30);
    await harness.schedule.component.stop();
  });

  it('stop cancels the daily wait — no further run after the component stops', async () => {
    const harness = scheduleHarness(configOf(180));
    await harness.schedule.component.start();
    await harness.schedule.component.stop();
    await vi.advanceTimersByTimeAsync(DAY_MS * 3);
    expect(harness.cleanup.calls.length).toBe(1);
    // A second stop (the app retries a rejected stop) stays a no-op.
    await harness.schedule.component.stop();
    expect(harness.cleanup.calls.length).toBe(1);
  });

  it('contains a failed startup cleanup: start resolves, the schedule survives', async () => {
    const harness = scheduleHarness(configOf(180));
    harness.cleanup.failNext(1);
    await expect(harness.schedule.component.start()).resolves.toBeUndefined();
    expect(harness.cleanup.calls.length).toBe(1);
    const warn = harness.sink
      .records()
      .find(
        (record) =>
          typeof record.msg === 'string' && record.msg.startsWith('retention cleanup failed'),
      );
    expect(warn).toMatchObject({ phase: 'startup', error: 'injected cleanup failure 1' });
    // The daily cadence was armed regardless — the retry IS the recovery.
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(2);
    expect(
      harness.sink
        .records()
        .filter(
          (record) =>
            typeof record.msg === 'string' && record.msg.startsWith('retention cleanup failed'),
        ).length,
    ).toBe(1);
    await harness.schedule.component.stop();
  });

  it('contains a failed daily cleanup: the schedule re-arms and the next day retries', async () => {
    const harness = scheduleHarness(configOf(180));
    await harness.schedule.component.start();
    harness.cleanup.failNext(1);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(2);
    expect(
      harness.sink
        .records()
        .find(
          (record) =>
            typeof record.msg === 'string' && record.msg.startsWith('retention cleanup failed'),
        ),
    ).toMatchObject({ phase: 'daily' });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(3);
    // The third run is a completed daily retry, beside the contained one.
    expect(
      harness.sink
        .records()
        .filter(
          (record) =>
            typeof record.msg === 'string' && record.msg.startsWith('retention cleanup completed'),
        )
        .map((record) => record.phase),
    ).toEqual(['startup', 'daily']);
    await harness.schedule.component.stop();
  });

  it('skips the run with a warn when storage is not open (a wiring bug)', async () => {
    const harness = scheduleHarness(configOf(180));
    harness.storageState.open = false;
    await harness.schedule.component.start();
    expect(harness.cleanup.calls.length).toBe(0);
    expect(
      harness.sink
        .records()
        .find(
          (record) =>
            typeof record.msg === 'string' && record.msg.startsWith('retention cleanup skipped'),
        ),
    ).toBeDefined();
    // The skip is contained exactly like a failure: the cadence survives.
    harness.storageState.open = true;
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(harness.cleanup.calls.length).toBe(1);
    await harness.schedule.component.stop();
  });

  it('reports a broken sleep seam at error and stops scheduling (no unhandled rejection)', async () => {
    const boom = new Error('broken sleep seam');
    const harness = scheduleHarness(configOf(180), { sleep: () => Promise.reject(boom) });
    await harness.schedule.component.start();
    // Let the loop's catch settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(
      harness.sink
        .records()
        .find(
          (record) =>
            typeof record.msg === 'string' &&
            record.msg.startsWith('retention schedule loop failed'),
        ),
    ).toMatchObject({ error: 'broken sleep seam' });
    // The loop is dead: no more runs, and the promise never rejected
    // outside its own catch.
    await vi.advanceTimersByTimeAsync(DAY_MS * 2);
    expect(harness.cleanup.calls.length).toBe(1);
    await harness.schedule.component.stop();
  });
});
