import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  getMetricSeriesWithRetention,
  listCollectionRunsWithRetention,
  listQuotaEventsWithRetention,
  type RequestedHistoryRange,
} from '../../src/storage/history-retention';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type NewAccount,
  type NewCollectionRun,
  type NewMetricValue,
  type NewQuotaEvent,
  type NewSnapshot,
  type QuotaEventDetails,
  type QuotaRepository,
} from '../../src/storage/repository';
import {
  historyCutoff,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  runRetentionCleanup,
} from '../../src/storage/retention-cleanup';
import { DAY_MS } from '../../src/util/rolling-ranges';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 123's done-condition (spec §11.3, §13): "callers can identify the
 * effective history range" — verified against real disposable `node:sqlite`
 * databases by bounding requested ranges around a retention horizon and
 * asserting both halves of every read: the reported outcome (ok / truncated /
 * rejected, with the effective bounds — or the horizon and the requested
 * bounds on rejection) and the rows actually served. Around that core the
 * suite pins the horizon boundaries against real rows (the landed reads'
 * closed intervals against D-063's strict-before deletes: a row at exactly
 * the horizon is served, one millisecond older never is), the window
 * validation reaching the reads (§11.3's 7–3650 days rejected before
 * anything is read), the §13 semantics (only the lower bound clamps;
 * rejection is data, not a throw; out-of-policy rows are hidden even before
 * the daily cleanup deletes them), per-account isolation, the pass-through
 * facade filters (metric key, run outcome), the wrap-not-modify pin (the raw
 * facade reads stay unclamped, D-058), and the D-063 alignment (after a
 * cleanup with the same window, the raw table contains exactly the rows the
 * clamp had served).
 *
 * Conventions follow `test/integration/repository.spec.ts` — fresh
 * disposable databases, the canonical migrations, deterministic §11.1
 * timestamps, rows seeded through the facade with `PRAGMA foreign_keys =
 * ON`. The pure clamp's own outcome/validation table lives in
 * `test/unit/history-retention.spec.ts` (the unit/integration split,
 * docs/agents/testing.md). The `node:sqlite` ExperimentalWarning is
 * expected here, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond base for the factories and seeds. */
const T0 = 1_761_000_000_000;

/** The window's "now" — 40 days after the seed base. */
const NOW = T0 + 40 * DAY_MS;

/** The retention window under test: 30 of §11.3's 7–3650 days. */
const RETENTION_DAYS = 30;

/** The horizon that window leaves: NOW − 30 d = T0 + 10 d. */
const HORIZON = NOW - RETENTION_DAYS * DAY_MS;

/** Day-count helpers keeping the seed stamps readable. */
const days = (count: number): number => T0 + count * DAY_MS;

/**
 * Runs `body` against a fresh repository over a fully migrated disposable
 * database with §11.1 foreign-key enforcement on.
 */
async function withHistoryRepository(
  body: (repository: QuotaRepository, database: DatabaseSync) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    try {
      await body(repository, database);
    } finally {
      database.close();
    }
  });
}

/* ── Row factories (every field explicit, spreads for overrides) ───────── */

function account(overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    planName: 'Pro',
    createdAt: T0,
    ...overrides,
  };
}

function run(overrides: Partial<NewCollectionRun> = {}): NewCollectionRun {
  return {
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 1_200,
    intervalSeconds: 300,
    outcome: 'success',
    httpStatus: 200,
    errorMessage: null,
    attempts: 1,
    retryAfterSeconds: null,
    ...overrides,
  };
}

function snapshot(runId: number, overrides: Partial<NewSnapshot> = {}): NewSnapshot {
  return { accountId: 'work', runId, collectedAt: T0, planName: 'Pro', ...overrides };
}

function metric(runId: number, overrides: Partial<NewMetricValue> = {}): NewMetricValue {
  return {
    accountId: 'work',
    runId,
    collectedAt: T0,
    metricKey: 'monthly-credits',
    limitType: 'MONTHLY',
    unit: 'CREDITS',
    windowSeconds: null,
    used: 80,
    remaining: 20,
    limit: 100,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: T0 + 86_400_000,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    ...overrides,
  };
}

function eventDetails(): QuotaEventDetails {
  return {
    reason: 'used decreased beyond tolerance',
    previous: { collectedAt: T0, used: 80, resetsAt: T0 + 86_400_000 },
    current: { collectedAt: T0 + 300_000, used: 5, resetsAt: T0 + 172_800_000 },
    tolerance: 0.5,
    eventTimeSource: 'previous-resets-at',
  };
}

/**
 * One successful cycle of `accountId` collected at `collectedAt` carrying one
 * metric row per key; returns the run id. The run spans `durationMs` before
 * the collection stamp — zero by default, so `started_at === collected_at`
 * and the boundary assertions align both columns exactly (the straddle case
 * has its own dedicated test).
 */
function seedCycleAt(
  repository: QuotaRepository,
  accountId: string,
  collectedAt: number,
  metricKeys: ReadonlyArray<string> = ['monthly-credits'],
  durationMs = 0,
): number {
  if (repository.getAccount(accountId) === null) {
    repository.insertAccount(account({ id: accountId, label: accountId }));
  }
  const runId = repository.insertCollectionRun(
    run({ accountId, startedAt: collectedAt - durationMs, endedAt: collectedAt }),
  );
  repository.insertSnapshot(snapshot(runId, { accountId, collectedAt }));
  repository.insertMetricValues(
    metricKeys.map((metricKey) => metric(runId, { accountId, collectedAt, metricKey })),
  );
  return runId;
}

describe('retention-aware metric series (task 123, spec §13, D-082)', () => {
  const window = { now: NOW, retentionDays: RETENTION_DAYS };

  it('serves the full range with the effective range unchanged when inside retention', async () => {
    await withHistoryRepository((repository) => {
      seedCycleAt(repository, 'work', days(12));
      seedCycleAt(repository, 'work', days(16));
      seedCycleAt(repository, 'work', days(20));
      seedCycleAt(repository, 'work', days(24));

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(15), to: days(25) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'ok',
        effectiveFrom: days(15),
        effectiveTo: days(25),
      });
      // Ascending (the facade order), and the day-12 row — inside retention,
      // outside the request — stays out.
      expect(read.rows.map((row) => row.collectedAt)).toEqual([days(16), days(20), days(24)]);
    });
  });

  it('truncates a partially older range: rows from the horizon on, the horizon row included', async () => {
    await withHistoryRepository((repository) => {
      seedCycleAt(repository, 'work', days(5));
      seedCycleAt(repository, 'work', days(9));
      seedCycleAt(repository, 'work', HORIZON);
      seedCycleAt(repository, 'work', days(12));

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(4), to: days(15) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'truncated',
        effectiveFrom: HORIZON,
        effectiveTo: days(15),
        requestedFrom: days(4),
      });
      // Exactly the closed interval [horizon, to]: the day-10 row (== the
      // horizon) is served, the day-9 row one day short of it never is.
      expect(read.rows.map((row) => row.collectedAt)).toEqual([HORIZON, days(12)]);
    });
  });

  it('rejects an entirely older range — out-of-policy rows are hidden even undeleted', async () => {
    await withHistoryRepository((repository) => {
      seedCycleAt(repository, 'work', days(1));
      seedCycleAt(repository, 'work', days(9));

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(1), to: days(9) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'rejected',
        horizon: HORIZON,
        requestedFrom: days(1),
        requestedTo: days(9),
      });
      expect(read.rows).toEqual([]);
    });
  });

  it('answers empty rows for an empty database, on both ok and rejected ranges', async () => {
    await withHistoryRepository((repository) => {
      const ok = getMetricSeriesWithRetention(
        repository,
        'ghost',
        'monthly-credits',
        { from: days(15), to: days(25) },
        window,
      );
      expect(ok.range.outcome).toBe('ok');
      expect(ok.rows).toEqual([]);

      const rejected = getMetricSeriesWithRetention(
        repository,
        'ghost',
        'monthly-credits',
        { from: days(1), to: days(9) },
        window,
      );
      expect(rejected.range.outcome).toBe('rejected');
      expect(rejected.rows).toEqual([]);
    });
  });

  it('answers ok with empty rows when the horizon is newer than all data', async () => {
    await withHistoryRepository((repository) => {
      // Every seed stamp is older than the horizon; the request sits inside
      // retention but after all data — absence, not a retention outcome.
      seedCycleAt(repository, 'work', T0);
      seedCycleAt(repository, 'work', T0 + 3_600_000);

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(30), to: days(35) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'ok',
        effectiveFrom: days(30),
        effectiveTo: days(35),
      });
      expect(read.rows).toEqual([]);
    });
  });

  it('isolates accounts', async () => {
    await withHistoryRepository((repository) => {
      seedCycleAt(repository, 'work', days(20));
      seedCycleAt(repository, 'personal', days(20));

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(15), to: days(25) },
        window,
      );
      expect(read.rows).toHaveLength(1);
      expect(read.rows[0]!.accountId).toBe('work');
    });
  });

  it('validates the window before reading anything', async () => {
    await withHistoryRepository((repository) => {
      seedCycleAt(repository, 'work', days(20));
      expect(() =>
        getMetricSeriesWithRetention(
          repository,
          'work',
          'monthly-credits',
          { from: days(15), to: days(25) },
          { now: NOW, retentionDays: 6 },
        ),
      ).toThrow(/retentionDays must be an integer between 7 and 3650 days/);
    });
  });
});

describe('retention-aware quota events (task 123, spec §13, D-082)', () => {
  const window = { now: NOW, retentionDays: RETENTION_DAYS };

  /** Seeds one cycle at `at` plus a RESET event per key, referencing it. */
  const seedEventsAt = (
    repository: QuotaRepository,
    at: number,
    metricKeys: ReadonlyArray<string>,
  ): void => {
    const runId = seedCycleAt(repository, 'work', at, metricKeys);
    for (const metricKey of metricKeys) {
      const event: NewQuotaEvent = {
        accountId: 'work',
        metricKey,
        eventType: 'RESET',
        eventAt: at,
        runId,
        details: eventDetails(),
      };
      repository.insertQuotaEvent(event);
    }
  };

  it('truncates and keeps the metric-key filter passing through', async () => {
    await withHistoryRepository((repository) => {
      seedEventsAt(repository, days(5), ['monthly-credits']);
      seedEventsAt(repository, days(12), ['monthly-credits', 'weekly-requests']);

      const read = listQuotaEventsWithRetention(
        repository,
        'work',
        { from: days(4), to: days(20) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'truncated',
        effectiveFrom: HORIZON,
        effectiveTo: days(20),
        requestedFrom: days(4),
      });
      // Only the events at/after the horizon: the day-5 event is out of
      // policy even though it is still stored.
      expect(read.rows.map((row) => [row.metricKey, row.eventAt])).toEqual([
        ['monthly-credits', days(12)],
        ['weekly-requests', days(12)],
      ]);

      const filtered = listQuotaEventsWithRetention(
        repository,
        'work',
        { from: days(4), to: days(20) },
        window,
        'weekly-requests',
      );
      expect(filtered.rows.map((row) => row.metricKey)).toEqual(['weekly-requests']);
    });
  });

  it('rejects an entirely older range with empty rows', async () => {
    await withHistoryRepository((repository) => {
      seedEventsAt(repository, days(9), ['monthly-credits']);

      const read = listQuotaEventsWithRetention(
        repository,
        'work',
        { from: days(1), to: days(9) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'rejected',
        horizon: HORIZON,
        requestedFrom: days(1),
        requestedTo: days(9),
      });
      expect(read.rows).toEqual([]);
    });
  });
});

describe('retention-aware collection runs (task 123, spec §12.2, §13, D-082)', () => {
  const window = { now: NOW, retentionDays: RETENTION_DAYS };

  it('truncates on started_at and keeps the outcome filter passing through', async () => {
    await withHistoryRepository((repository) => {
      repository.insertAccount(account());
      const seeds: ReadonlyArray<Partial<NewCollectionRun>> = [
        { startedAt: days(5), endedAt: days(5) + 1_200, outcome: 'success' },
        {
          startedAt: days(6),
          endedAt: days(6) + 1_200,
          outcome: 'network_error',
          httpStatus: null,
          errorMessage: 'socket hang up',
        },
        { startedAt: days(12), endedAt: days(12) + 1_200, outcome: 'success' },
        {
          startedAt: days(13),
          endedAt: days(13) + 1_200,
          outcome: 'timeout',
          httpStatus: null,
          errorMessage: 'deadline exceeded',
        },
      ];
      for (const seed of seeds) {
        repository.insertCollectionRun(run(seed));
      }

      const read = listCollectionRunsWithRetention(
        repository,
        'work',
        { from: days(4), to: days(20) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'truncated',
        effectiveFrom: HORIZON,
        effectiveTo: days(20),
        requestedFrom: days(4),
      });
      expect(read.rows.map((row) => [row.startedAt, row.outcome])).toEqual([
        [days(12), 'success'],
        [days(13), 'timeout'],
      ]);

      const failures = listCollectionRunsWithRetention(
        repository,
        'work',
        { from: days(4), to: days(20) },
        window,
        'network_error',
      );
      // The only network_error run is pre-horizon: out of policy, not served.
      expect(failures.rows).toEqual([]);
    });
  });

  it('serves a range inside retention unchanged', async () => {
    await withHistoryRepository((repository) => {
      repository.insertAccount(account());
      repository.insertCollectionRun(run({ startedAt: days(12), endedAt: days(12) + 1_200 }));
      repository.insertCollectionRun(run({ startedAt: days(13), endedAt: days(13) + 1_200 }));

      const read = listCollectionRunsWithRetention(
        repository,
        'work',
        { from: days(11), to: days(14) },
        window,
      );
      expect(read.range).toEqual({
        outcome: 'ok',
        effectiveFrom: days(11),
        effectiveTo: days(14),
      });
      expect(read.rows.map((row) => row.startedAt)).toEqual([days(12), days(13)]);
    });
  });
});

describe('wrap-not-modify and the D-063 alignment (task 123, D-058, D-063, D-082)', () => {
  const window = { now: NOW, retentionDays: RETENTION_DAYS };

  /** The shared seed: rows on both sides of the horizon. */
  const seedBothSides = (repository: QuotaRepository): void => {
    seedCycleAt(repository, 'work', days(5));
    seedCycleAt(repository, 'work', days(9));
    seedCycleAt(repository, 'work', HORIZON);
    seedCycleAt(repository, 'work', days(12));
  };

  it('keeps the raw facade reads unclamped (D-058)', async () => {
    await withHistoryRepository((repository) => {
      seedBothSides(repository);

      const requested: RequestedHistoryRange = { from: days(4), to: days(15) };
      const clamped = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        requested,
        window,
      );
      expect(clamped.range.outcome).toBe('truncated');
      expect(clamped.rows).toHaveLength(2);

      // The same bounds through the facade return every stored row — the
      // wrappers add policy around the reads, they do not change them.
      const raw = repository.getMetricSeries('work', 'monthly-credits', requested);
      expect(raw.map((row) => row.collectedAt)).toEqual([days(5), days(9), HORIZON, days(12)]);
    });
  });

  it('matches the D-063 deletes: after cleanup the raw table is the clamped rows', async () => {
    await withHistoryRepository((repository, database) => {
      seedBothSides(repository);

      const requested: RequestedHistoryRange = { from: days(4), to: days(15) };
      const clamped = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        requested,
        window,
      );
      expect(clamped.range.outcome).toBe('truncated');

      // The same window that truncates the query now drives the cleanup.
      runRetentionCleanup({ repository, database }, { now: NOW, retentionDays: RETENTION_DAYS });

      // Strict-before deletes + closed-interval clamp = the same retained
      // set: nothing the clamp served was deleted, nothing it hid survives.
      // (The seeds keep started_at === collected_at; the one shape where the
      // two columns disagree is pinned by the straddle test below.)
      const surviving = repository.getMetricSeries('work', 'monthly-credits');
      expect(surviving).toEqual(clamped.rows);
    });
  });

  it('pins the straddle: a run started before the horizon is served until its run deletes', async () => {
    await withHistoryRepository((repository, database) => {
      // The run straddles the horizon — started an hour before it, collected
      // an hour after. The clamp bounds the queried column (collected_at,
      // the D-039 denormalization) and the deletes bound the run's
      // started_at (D-063's retention unit), so this one shape legitimately
      // diverges: served by the effective range now, gone after the cleanup
      // — a divergence bounded by one run's duration around the horizon.
      seedCycleAt(repository, 'work', HORIZON + 3_600_000, ['monthly-credits'], 7_200_000);

      const read = getMetricSeriesWithRetention(
        repository,
        'work',
        'monthly-credits',
        { from: days(4), to: days(15) },
        window,
      );
      expect(read.range.outcome).toBe('truncated');
      expect(read.rows.map((row) => row.collectedAt)).toEqual([HORIZON + 3_600_000]);

      runRetentionCleanup({ repository, database }, { now: NOW, retentionDays: RETENTION_DAYS });
      expect(repository.getMetricSeries('work', 'monthly-credits')).toEqual([]);
    });
  });

  it('reports the horizon the shared D-063 definition computes, at both §11.3 bounds (D-091)', async () => {
    await withHistoryRepository((repository) => {
      // A request entirely older than each window's horizon — built from
      // this spec's own DAY_MS arithmetic — so the rejected branch carries
      // the horizon to compare against the exported helper. The pin: the
      // reported horizon is the helper's value, never re-derived or
      // adjusted inside the query seam. (The helper's own value oracle —
      // against an independent day-ms literal — lives in
      // retention-cleanup.spec.ts, beside the untouched D-063/D-082
      // alignment suites.)
      for (const retentionDays of [MIN_RETENTION_DAYS, RETENTION_DAYS, MAX_RETENTION_DAYS]) {
        const to = NOW - retentionDays * DAY_MS - 1;
        const from = to - DAY_MS;
        const read = getMetricSeriesWithRetention(
          repository,
          'work',
          'monthly-credits',
          { from, to },
          { now: NOW, retentionDays },
        );
        expect(read.range).toEqual({
          outcome: 'rejected',
          horizon: historyCutoff(NOW, retentionDays),
          requestedFrom: from,
          requestedTo: to,
        });
        expect(read.rows).toEqual([]);
      }
    });
  });
});
