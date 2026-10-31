import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAccountContext } from '../../src/providers/registry';
import { TransportAbortError, TransportConnectionError } from '../../src/providers/transport';
import type { NormalizedMetric, ProviderSnapshot } from '../../src/schemas/metrics';
import { createCycleRecorder, type CycleRecorder } from '../../src/services/polling-persist';
import type { CycleOutcome } from '../../src/services/polling-outcomes';
import { runCycleWithRetries } from '../../src/services/polling-retry';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';
import { createFixedClock, type FixedClock } from '../../src/util/clock';

/**
 * Task 118's done-condition (spec §12.1), proven end-to-end through the
 * settle seam against a real database: a successful cycle's persisted
 * events are exactly the detector's output — the detection reason stored
 * in `details.reason` with the D-046 evidence vocabulary, and the event
 * time following §12.1's rule (the previous `resetsAt` when it lies
 * between the snapshots, else the new collection time) — computed against
 * the account's previous valid points read from the stored series. Every
 * edge of the wiring is pinned here through real persistence: first
 * cycles, steady cycles, failed and aborted cycles, invalid intermediate
 * points, per-metric independence, and the no-refold invariant (a stored
 * reset is never re-detected by a later cycle). The pure rule itself is
 * task 117's unit matrix; this suite drives the production composition —
 * the real `runCycleWithRetries` around `attempt`, the real
 * `persistCollectionCycle` over a migrated disposable database with §11.1
 * foreign-key enforcement on (`test/integration/polling-persist.spec.ts`
 * conventions; the `node:sqlite` ExperimentalWarning is expected here, as
 * in every storage test).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the factories. */
const T0 = 1_761_000_000_000;
/** The wall time between a cycle's attempt and its settle. */
const CYCLE_MS = 2_500;
/** The wall time between consecutive cycles (the §7.1 default interval). */
const INTERVAL_MS = 300_000;
/** One hour — the rolling-window declaration horizon of the scenarios. */
const HOUR_MS = 3_600_000;

/* ── Harness (polling-persist.spec.ts conventions) ─────────────────────── */

/** Runs `body` against a fresh repository over a fully migrated disposable
 * database with §11.1 foreign-key enforcement on and the `work` account row
 * present — the recorder's run and event rows carry foreign keys to it. */
async function withRepository(
  body: (repository: QuotaRepository, clock: FixedClock) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    repository.insertAccount({
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'Work plan',
      planName: 'Pro',
      createdAt: T0,
    });
    const clock = createFixedClock(T0);
    try {
      await body(repository, clock);
    } finally {
      database.close();
    }
  });
}

/** A fixed-period `DAILY` quota in `REQUESTS` (values-only unless stated). */
function dailyMetric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'daily-requests',
    label: 'Daily requests',
    limitType: 'DAILY',
    unit: 'REQUESTS',
    used: 90,
    remaining: 10,
    limit: 100,
    percentUsed: 90,
    percentRemaining: 10,
    isValid: true,
    ...overrides,
  };
}

/** A rolling-window quota in `PERCENT` (the Z.ai `tokens-5h` shape). */
function rollingMetric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'tokens-5h',
    label: 'Five-hour usage',
    limitType: 'ROLLING_WINDOW',
    unit: 'PERCENT',
    windowSeconds: 18_000,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: T0 + HOUR_MS,
    isValid: true,
    ...overrides,
  };
}

/** A valid §8.4 snapshot collected at `collectedAt`. */
function snapshotAt(collectedAt: number, metrics: NormalizedMetric[]): ProviderSnapshot {
  return {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: 'Pro',
    metrics,
  };
}

/** A recorder whose provider resolves the snapshot `next` currently holds. */
function recorderFor(
  repository: QuotaRepository,
  clock: FixedClock,
  next: { collect: () => Promise<ProviderSnapshot> },
): CycleRecorder {
  return createCycleRecorder({
    account: createAccountContext('work', 'Work plan', 'secret-value'),
    provider: {
      id: 'zai-coding-plan',
      name: 'Z.ai Coding Plan',
      validateCredentials: async () => {},
      fetchSnapshot: () => next.collect(),
    },
    repository,
    clock,
    intervalSeconds: () => 300,
  });
}

/**
 * A scripted scenario: each queued collection runs one full cycle — attempt
 * through the production wrapper (backoff stubbed), settle through the
 * seam — against a shared deterministic clock, returning the
 * classifications in cycle order.
 */
async function runScenario(
  repository: QuotaRepository,
  clock: FixedClock,
  cycles: ReadonlyArray<() => Promise<ProviderSnapshot>>,
): Promise<CycleOutcome[]> {
  const next: { collect: () => Promise<ProviderSnapshot> } = {
    collect: () => Promise.reject(new Error('scenario has no such cycle')),
  };
  const recorder = recorderFor(repository, clock, next);
  const outcomes: CycleOutcome[] = [];
  for (const collect of cycles) {
    next.collect = collect;
    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal), {
      random: () => 0,
      sleep: async () => {},
    });
    clock.advance(CYCLE_MS);
    outcomes.push(recorder.settleCycle(result));
    clock.advance(INTERVAL_MS - CYCLE_MS);
  }
  return outcomes;
}

/* ── The §12.1 event time, both branches, through real persistence ─────── */

describe('the event time follows §12.1 against the stored series', () => {
  it('uses the previous resetsAt when it lies between the two snapshots', async () => {
    await withRepository(async (repository, clock) => {
      const firstCollectedAt = T0 + 1_200;
      const declaredResetAt = T0 + HOUR_MS; // strictly after the first snapshot
      const secondCollectedAt = T0 + INTERVAL_MS + HOUR_MS + 1_200; // past the declaration

      await runScenario(repository, clock, [
        // The first cycle: no previous point, so no event whatever it carries.
        () => Promise.resolve(snapshotAt(firstCollectedAt, [rollingMetric()])),
      ]);
      clock.advance(HOUR_MS); // the declaration horizon passes before cycle 2
      await runScenario(repository, clock, [
        // A declared window expiry plus a strictly later resetsAt — the only
        // admissible rolling-window evidence (D-074's conservative rule).
        () =>
          Promise.resolve(
            snapshotAt(secondCollectedAt, [
              rollingMetric({
                percentUsed: 10,
                percentRemaining: 90,
                resetsAt: declaredResetAt + HOUR_MS,
              }),
            ]),
          ),
      ]);

      // §12.1: the previous point's resetsAt lay between the snapshots, so
      // it — not the new collection time — is the event time, the reason
      // carries the conservative suffix, and the evidence round-trips the
      // D-046 contract (the SQL CHECKs accepted it at insert; the read
      // parses it back with every compared field intact).
      expect(repository.listQuotaEvents('work')).toEqual([
        {
          accountId: 'work',
          metricKey: 'tokens-5h',
          eventType: 'RESET',
          eventAt: declaredResetAt,
          runId: 2, // the cycle whose snapshot the event evidences
          details: {
            reason: 'resets_at_advanced+rolling_window_conservative',
            previous: {
              runId: 1,
              collectedAt: firstCollectedAt,
              percentUsed: 80,
              percentRemaining: 20,
              resetsAt: declaredResetAt,
            },
            current: {
              collectedAt: secondCollectedAt,
              percentUsed: 10,
              percentRemaining: 90,
              resetsAt: declaredResetAt + HOUR_MS,
            },
            tolerance: { absolute: 0, percent: 1 },
            eventTimeSource: 'previous_resets_at',
          },
        },
      ]);
    });
  });

  it('uses the new collection time when no declaration lies between them', async () => {
    await withRepository(async (repository, clock) => {
      const firstCollectedAt = T0 + 1_200;
      const secondCollectedAt = T0 + INTERVAL_MS + 1_200;

      await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(firstCollectedAt, [dailyMetric({ resetsAt: undefined })])),
        () =>
          Promise.resolve(
            snapshotAt(secondCollectedAt, [
              dailyMetric({
                resetsAt: undefined,
                used: 5,
                remaining: 95,
                percentUsed: 5,
                percentRemaining: 95,
              }),
            ]),
          ),
      ]);

      // §12.1's other branch: no resetsAt lay between the snapshots (none
      // was declared), so the new snapshot's collection time is the event
      // time; the fixed-period value condition fired on its own.
      expect(repository.listQuotaEvents('work')).toEqual([
        {
          accountId: 'work',
          metricKey: 'daily-requests',
          eventType: 'RESET',
          eventAt: secondCollectedAt,
          runId: 2,
          details: {
            reason: 'usage_decreased+remaining_increased',
            previous: {
              runId: 1,
              collectedAt: firstCollectedAt,
              used: 90,
              remaining: 10,
              percentUsed: 90,
              percentRemaining: 10,
            },
            current: {
              collectedAt: secondCollectedAt,
              used: 5,
              remaining: 95,
              percentUsed: 5,
              percentRemaining: 95,
            },
            tolerance: { absolute: 0, percent: 1 },
            eventTimeSource: 'current_collected_at',
          },
        },
      ]);
    });
  });
});

/* ── Cycles that must store no events ──────────────────────────────────── */

describe('cycles that store no events', () => {
  it('stores none for an account’s first cycle — there is no previous point', async () => {
    await withRepository(async (repository, clock) => {
      const outcomes = await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(T0 + 1_200, [dailyMetric(), rollingMetric()])),
      ]);

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['success']);
      expect(repository.listQuotaEvents('work')).toHaveLength(0);
    });
  });

  it('stores none when no §12.1 condition fired (steady values, same resetsAt)', async () => {
    await withRepository(async (repository, clock) => {
      const steady = dailyMetric();

      await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(T0 + 1_200, [steady])),
        () => Promise.resolve(snapshotAt(T0 + INTERVAL_MS + 1_200, [dailyMetric()])),
      ]);

      expect(repository.listSnapshots('work')).toHaveLength(2);
      expect(repository.listQuotaEvents('work')).toHaveLength(0);
    });
  });

  it('stores none for failed and aborted cycles, and they leave the comparison base unchanged', async () => {
    await withRepository(async (repository, clock) => {
      const outcomes = await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(T0 + 1_200, [dailyMetric()])),
        // A caller abort: service lifecycle, deliberately unpersisted (D-069).
        () => Promise.reject(new TransportAbortError()),
        // A network failure after retries: a run row, but no snapshot — and
        // no new point, so it can never be a comparison base either.
        () => Promise.reject(new TransportConnectionError('ECONNREFUSED')),
        // The next success compares against cycle 1's point, not the gaps.
        () =>
          Promise.resolve(
            snapshotAt(T0 + 3 * INTERVAL_MS + 1_200, [
              dailyMetric({ used: 4, remaining: 96, percentUsed: 4, percentRemaining: 96 }),
            ]),
          ),
      ]);

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'success',
        'cancelled',
        'network_error',
        'success',
      ]);
      const runs = repository.listCollectionRuns('work');
      expect(runs.map((run) => run.outcome)).toEqual(['success', 'network_error', 'success']);
      expect(repository.getSnapshotByRun(runs[1]!.id)).toBeNull(); // the failure has no snapshot
      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: runs[2]!.id,
        eventAt: T0 + 3 * INTERVAL_MS + 1_200,
      });
      expect(events[0]?.details.previous).toMatchObject({ runId: runs[0]!.id, used: 90 });
    });
  });
});

/* ── The comparison base: previous VALID point ─────────────────────────── */

describe('the comparison base skips invalid stored points', () => {
  it('compares against the last valid point across an invalid intermediate row', async () => {
    await withRepository(async (repository, clock) => {
      const firstCollectedAt = T0 + 1_200;
      const thirdCollectedAt = T0 + 2 * INTERVAL_MS + 1_200;

      await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(firstCollectedAt, [dailyMetric()])),
        // §8.4: an invalid metric carries no numeric values, only a reason —
        // it persists as a row but does not participate in comparisons.
        () =>
          Promise.resolve(
            snapshotAt(T0 + INTERVAL_MS + 1_200, [
              dailyMetric({
                used: undefined,
                remaining: undefined,
                limit: undefined,
                percentUsed: undefined,
                percentRemaining: undefined,
                resetsAt: undefined,
                isValid: false,
                invalidReason: 'provider reported no usage data',
              }),
            ]),
          ),
        () =>
          Promise.resolve(
            snapshotAt(thirdCollectedAt, [
              dailyMetric({ used: 3, remaining: 97, percentUsed: 3, percentRemaining: 97 }),
            ]),
          ),
      ]);

      // The event's evidence names cycle 1's point as the previous valid
      // point — cycle 2's invalid row was neither compared nor made the base.
      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runId: 3, eventAt: thirdCollectedAt });
      expect(events[0]?.details.previous).toEqual({
        runId: 1,
        collectedAt: firstCollectedAt,
        used: 90,
        remaining: 10,
        percentUsed: 90,
        percentRemaining: 10,
      });
      expect(repository.getMetricSeries('work', 'daily-requests')).toHaveLength(3);
    });
  });
});

/* ── The no-refold invariant ───────────────────────────────────────────── */

describe('detection does not re-run over already-persisted history', () => {
  it('attributes the stored reset to the cycle that detected it, exactly once', async () => {
    await withRepository(async (repository, clock) => {
      const dropped = dailyMetric({ used: 5, remaining: 95, percentUsed: 5, percentRemaining: 95 });

      await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(T0 + 1_200, [dailyMetric()])),
        () => Promise.resolve(snapshotAt(T0 + INTERVAL_MS + 1_200, [dropped])),
        // A third cycle as steady as the second: nothing new fires — and the
        // stored p1→p2 pair is not re-folded into a second event either.
        () => Promise.resolve(snapshotAt(T0 + 2 * INTERVAL_MS + 1_200, [dropped])),
      ]);

      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1); // a re-fold would have re-minted it at cycle 3
      expect(events[0]).toMatchObject({ runId: 2, metricKey: 'daily-requests' });
    });
  });
});

/* ── Per-metric independence ───────────────────────────────────────────── */

describe('the metrics of one snapshot are handled independently', () => {
  it('records the resetting metric only, beside a drastic rolling drop with no declaration', async () => {
    await withRepository(async (repository, clock) => {
      await runScenario(repository, clock, [
        () =>
          Promise.resolve(
            snapshotAt(T0 + 1_200, [dailyMetric(), rollingMetric({ resetsAt: undefined })]),
          ),
        () =>
          Promise.resolve(
            snapshotAt(T0 + INTERVAL_MS + 1_200, [
              dailyMetric({ used: 5, remaining: 95, percentUsed: 5, percentRemaining: 95 }),
              // A full rolling-window replenishment with no declaration: the
              // conservative approach records nothing however drastic (D-074).
              rollingMetric({
                resetsAt: undefined,
                percentUsed: 10,
                percentRemaining: 90,
              }),
            ]),
          ),
      ]);

      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1);
      expect(events[0]?.metricKey).toBe('daily-requests');
    });
  });

  it('records two resetting metrics with their own evidence', async () => {
    await withRepository(async (repository, clock) => {
      const weeklyMetric = (overrides: Partial<NormalizedMetric> = {}): NormalizedMetric => ({
        key: 'weekly-requests',
        label: 'Weekly requests',
        limitType: 'WEEKLY',
        unit: 'REQUESTS',
        used: 700,
        remaining: 300,
        limit: 1000,
        percentUsed: 70,
        percentRemaining: 30,
        isValid: true,
        ...overrides,
      });
      const secondCollectedAt = T0 + INTERVAL_MS + 1_200;

      await runScenario(repository, clock, [
        () => Promise.resolve(snapshotAt(T0 + 1_200, [dailyMetric(), weeklyMetric()])),
        () =>
          Promise.resolve(
            snapshotAt(secondCollectedAt, [
              dailyMetric({ used: 5, remaining: 95, percentUsed: 5, percentRemaining: 95 }),
              weeklyMetric({ used: 40, remaining: 960, percentUsed: 4, percentRemaining: 96 }),
            ]),
          ),
      ]);

      // Same event time, so the rowid tiebreak keeps the snapshot's order.
      const events = repository.listQuotaEvents('work');
      expect(events.map((event) => event.metricKey)).toEqual(['daily-requests', 'weekly-requests']);
      expect(events.map((event) => event.eventAt)).toEqual([secondCollectedAt, secondCollectedAt]);
      expect(events[0]?.details.current).toMatchObject({ used: 5 });
      expect(events[1]?.details.current).toMatchObject({ used: 40 });
    });
  });
});
