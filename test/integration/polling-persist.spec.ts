import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAccountContext } from '../../src/providers/registry';
import {
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import { SnapshotParseError } from '../../src/providers/zai-coding-plan/snapshot';
import type { NormalizedMetric, ProviderSnapshot } from '../../src/schemas/metrics';
import { createCycleRecorder, type CycleRecorder } from '../../src/services/polling-persist';
import type { CycleOutcome } from '../../src/services/polling-outcomes';
import { runCycleWithRetries } from '../../src/services/polling-retry';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';
import { createFixedClock, type FixedClock } from '../../src/util/clock';

/**
 * Task 110's done-condition (spec §7.2, §11.1), proven end-to-end through the
 * settle seam against a real database: (a) an error cycle cannot create a
 * false snapshot — every failure classification (including a cycle that
 * succeeded at the provider level but failed §8.4 classification) writes
 * exactly one `collection_runs` row and no snapshot, no metric rows, no
 * events; (b) the last valid metrics remain queryable — after a success
 * followed by failures, the repository's series/latest reads still return the
 * last valid values with their collection time, never zeroed (§7.2's
 * "missing data must never be represented as zero"). The suite drives the
 * production composition — the real `runCycleWithRetries` (backoff stubbed)
 * around `attempt`, the real `persistCollectionCycle` over a migrated
 * disposable database. Conventions follow
 * `test/integration/collection-cycles.spec.ts`: the canonical migrations,
 * §11.1 foreign-key enforcement on, deterministic §11.1 timestamps. The
 * `node:sqlite` ExperimentalWarning is expected here, as in every storage
 * test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the factories. */
const T0 = 1_761_000_000_000;
/** The wall time between a cycle's attempt and its settle. */
const CYCLE_MS = 2_500;
/** The wall time between consecutive cycles (the §7.1 default interval). */
const INTERVAL_MS = 300_000;

/* ── Harness ───────────────────────────────────────────────────────────── */

/** Runs `body` against a fresh repository over a fully migrated disposable
 * database with §11.1 foreign-key enforcement on and the `work` account row
 * present — the recorder's run rows carry a foreign key to it. */
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

function metric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'five-hour-credits',
    label: 'Five-hour credits',
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 42,
    remaining: 58,
    limit: 100,
    percentUsed: 42,
    percentRemaining: 58,
    resetsAt: T0 + 3_600_000,
    isValid: true,
    ...overrides,
  };
}

/** A valid §8.4 snapshot collected at `collectedAt`. */
function snapshotAt(
  collectedAt: number,
  metrics: NormalizedMetric[] = [metric()],
): ProviderSnapshot {
  return {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: 'Pro',
    metrics,
  };
}

/** A recorder for `accountId` whose provider behaves as `collect`. */
function recorderFor(
  repository: QuotaRepository,
  clock: FixedClock,
  collect: () => Promise<ProviderSnapshot>,
  accountId = 'work',
): CycleRecorder {
  return createCycleRecorder({
    account: createAccountContext(accountId, 'Work plan', 'secret-value'),
    provider: {
      id: 'zai-coding-plan',
      name: 'Z.ai Coding Plan',
      validateCredentials: async () => {},
      fetchSnapshot: collect,
    },
    repository,
    clock,
    intervalSeconds: () => 300,
  });
}

/**
 * Runs one full cycle — attempt through the production wrapper (backoff
 * stubbed; delay bounds are task 106's own pin), settle through the seam —
 * and advances the clock past the cycle.
 */
async function runCycle(recorder: CycleRecorder, clock: FixedClock): Promise<CycleOutcome> {
  const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal), {
    random: () => 0,
    sleep: async () => {},
  });
  clock.advance(CYCLE_MS);
  const outcome = recorder.settleCycle(result);
  clock.advance(INTERVAL_MS - CYCLE_MS);
  return outcome;
}

/* ── Done-condition (a): error cycles cannot create a false snapshot ───── */

describe('a failed cycle writes exactly one run row and no snapshot', () => {
  it.each<[string, string, number, () => Promise<ProviderSnapshot>]>([
    [
      'a network failure after retries',
      'network_error',
      4,
      async () => {
        throw new TransportConnectionError('ECONNREFUSED');
      },
    ],
    [
      'a timeout after retries',
      'timeout',
      4,
      async () => {
        throw new TransportTimeoutError(15_000);
      },
    ],
    [
      'an HTTP 503 after retries',
      'server_error',
      4,
      async () => {
        throw new TransportStatusError(503, 'Service Unavailable', undefined);
      },
    ],
    [
      'an HTTP 401 (auth rejected, un-retried)',
      'auth_error',
      1,
      async () => {
        throw new TransportStatusError(401, 'Unauthorized', undefined);
      },
    ],
    [
      'an HTTP 429 with Retry-After',
      'rate_limited',
      1,
      async () => {
        throw new TransportStatusError(429, 'Too Many Requests', '37');
      },
    ],
    [
      'an adapter parse failure with its §7.4 payload',
      'parse_error',
      1,
      async () => {
        throw new SnapshotParseError(
          'response envelope was not the expected object',
          200,
          '{"code":0}',
        );
      },
    ],
    [
      'a transport-level parse failure (content type)',
      'parse_error',
      1,
      async () => {
        throw new TransportContentTypeError('text/html');
      },
    ],
    [
      'a provider-level success whose value failed §8.4 classification',
      'parse_error',
      1,
      async () => ({ garbage: true }) as unknown as ProviderSnapshot,
    ],
  ])('%s', async (_label, outcome, attempts, collect) => {
    await withRepository(async (repository, clock) => {
      let invocation = 0;
      const call = () => {
        invocation++;
        return collect();
      };
      const recorder = recorderFor(repository, clock, call);

      const classified = await runCycle(recorder, clock);

      expect(classified.outcome).toBe(outcome);
      expect(invocation).toBe(attempts); // §7.2's attempt count, verified at the provider
      const runs = repository.listCollectionRuns('work');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome, attempts });
      // The false-snapshot half of the done-condition: nothing queryable
      // exists for the failed cycle, whatever its class.
      expect(repository.getSnapshotByRun(runs[0]!.id)).toBeNull();
      expect(repository.listSnapshots('work')).toHaveLength(0);
      expect(repository.getLatestSnapshot('work')).toBeNull();
      expect(repository.getMetricSeries('work', 'five-hour-credits')).toHaveLength(0);
      expect(repository.listQuotaEvents('work')).toHaveLength(0);
    });
  });

  it('keeps the §7.4 payload queryable only beside its parse-error run', async () => {
    await withRepository(async (repository, clock) => {
      const recorder = recorderFor(repository, clock, async () => {
        throw new SnapshotParseError(
          'response envelope was not the expected object',
          200,
          '{"code":0}',
        );
      });

      await runCycle(recorder, clock);

      const run = repository.listCollectionRuns('work')[0]!;
      expect(repository.getRawResponseByRun(run.id)?.body).toBe('{"code":0}');
      expect(repository.listRawResponses('work')).toHaveLength(1);
    });
  });

  it('persists a cancelled cycle as nothing at all (D-069)', async () => {
    await withRepository(async (repository, clock) => {
      const recorder = recorderFor(repository, clock, async () => {
        throw new TransportAbortError();
      });

      const classified = await runCycle(recorder, clock);

      expect(classified.outcome).toBe('cancelled');
      expect(repository.listCollectionRuns('work')).toHaveLength(0);
    });
  });
});

/* ── Done-condition (b): the last valid metrics remain queryable ───────── */

describe('after a success followed by failures', () => {
  it('the last valid values and their collection time stay queryable', async () => {
    await withRepository(async (repository, clock) => {
      const collectedAt = T0 + 1_200;
      let collect: () => Promise<ProviderSnapshot> = async () => snapshotAt(collectedAt);
      const recorder = recorderFor(repository, clock, () => collect());

      await runCycle(recorder, clock); // the success, at T0
      collect = async () => {
        throw new TransportConnectionError('ECONNREFUSED');
      };
      await runCycle(recorder, clock); // a network failure, a full interval later
      collect = async () => {
        throw new TransportStatusError(401, 'Unauthorized', undefined);
      };
      await runCycle(recorder, clock); // an auth rejection
      collect = async () => {
        throw new TransportStatusError(429, 'Too Many Requests', '37');
      };
      await runCycle(recorder, clock); // a rate limit

      // §7.2: "Retain and display the latest valid values and their
      // collection time after an error" — the latest snapshot is still the
      // successful one, and the series still returns its values unchanged
      // (never zeroed) with their collection time.
      expect(repository.getLatestSnapshot('work')).toEqual({
        runId: 1,
        accountId: 'work',
        collectedAt,
        planName: 'Pro',
      });
      const series = repository.getMetricSeries('work', 'five-hour-credits');
      expect(series).toHaveLength(1);
      expect(series[0]).toMatchObject({
        collectedAt,
        used: 42,
        remaining: 58,
        limit: 100,
        percentUsed: 42,
        isValid: true,
      });
      // The history itself stays truthful: four runs (one per cycle), the
      // latest overall is the failure, the latest success is the success.
      const runs = repository.listCollectionRuns('work');
      expect(runs.map((run) => run.outcome)).toEqual([
        'success',
        'network_error',
        'auth_error',
        'rate_limited',
      ]);
      expect(repository.getLatestCollectionRun('work')?.outcome).toBe('rate_limited');
      const lastSuccess = repository.getLatestCollectionRun('work', 'success');
      expect(lastSuccess?.startedAt).toBe(T0);
      expect(repository.listSnapshots('work')).toHaveLength(1);
    });
  });

  it('serves multiple successes as a growing series with their own times', async () => {
    await withRepository(async (repository, clock) => {
      let collect: () => Promise<ProviderSnapshot> = async () => snapshotAt(T0 + 1_200);
      const recorder = recorderFor(repository, clock, () => collect());

      await runCycle(recorder, clock);
      const secondCollectedAt = T0 + INTERVAL_MS + 1_200;
      collect = async () => snapshotAt(secondCollectedAt, [metric({ used: 7, remaining: 93 })]);
      await runCycle(recorder, clock);

      const series = repository.getMetricSeries('work', 'five-hour-credits');
      expect(series.map((point) => point.collectedAt)).toEqual([T0 + 1_200, secondCollectedAt]);
      expect(series.map((point) => point.used)).toEqual([42, 7]);
      expect(repository.listSnapshots('work')).toHaveLength(2);
    });
  });
});

/* ── Successful cycles and the write boundary ──────────────────────────── */

describe('successful cycles', () => {
  it('stores a zero-metric snapshot (§8.4 boundary, §11.1 sentence)', async () => {
    await withRepository(async (repository, clock) => {
      const recorder = recorderFor(repository, clock, async () => snapshotAt(T0 + 1_200, []));

      await runCycle(recorder, clock);

      const run = repository.listCollectionRuns('work')[0]!;
      expect(run.outcome).toBe('success');
      expect(repository.getSnapshotByRun(run.id)).not.toBeNull();
      expect(repository.getMetricValuesForRun(run.id)).toHaveLength(0);
    });
  });

  it('round-trips the run evidence: attempts, status, message, retry-after', async () => {
    await withRepository(async (repository, clock) => {
      let collect: () => Promise<ProviderSnapshot> = async () => {
        throw new TransportStatusError(503, 'Service Unavailable', undefined);
      };
      const recorder = recorderFor(repository, clock, () => collect());
      await runCycle(recorder, clock); // retried to the cap: attempts 4
      collect = async () => {
        throw new TransportStatusError(429, 'Too Many Requests', '37');
      };
      await runCycle(recorder, clock); // the §7.2 deferral evidence

      const runs = repository.listCollectionRuns('work');
      expect(runs[0]).toMatchObject({
        outcome: 'server_error',
        attempts: 4,
        httpStatus: 503,
        errorMessage: 'provider responded with HTTP 503 Service Unavailable',
        retryAfterSeconds: null,
      });
      expect(runs[1]).toMatchObject({
        outcome: 'rate_limited',
        attempts: 1,
        httpStatus: 429,
        retryAfterSeconds: 37,
        startedAt: T0 + INTERVAL_MS,
      });
    });
  });

  it('fails loudly when the account row is absent — the run write is refused whole', async () => {
    await withRepository(async (repository, clock) => {
      const recorder = recorderFor(repository, clock, async () => snapshotAt(T0 + 1_200), 'ghost');
      const result = await runCycleWithRetries(
        () => recorder.attempt(new AbortController().signal),
        { random: () => 0, sleep: async () => {} },
      );

      expect(() => recorder.settleCycle(result)).toThrow();
      expect(repository.listCollectionRuns('ghost')).toHaveLength(0);
    });
  });
});
