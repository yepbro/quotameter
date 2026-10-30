import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  persistCollectionCycle,
  type CollectionCycleWrite,
  type CycleEventInput,
  type CycleMetricInput,
  type CycleRawResponseInput,
  type NonParseFailureCollectionCycle,
  type ParseFailureCollectionCycle,
  type SuccessfulCollectionCycle,
  type SuccessfulCycleSnapshot,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type NewAccount,
  type QuotaRepository,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 089's done-condition (spec §11.1, §17.1): a collection cycle — the
 * run row, and for a successful cycle the snapshot, its metric rows, and
 * its events — commits as one unit, and an injected failure at ANY insert
 * position leaves no partial snapshot behind: zero run, snapshot, metric,
 * event, and raw-response rows. Failures are injected twice over: as SQL
 * rejections through crafted rows (the database refusing a statement —
 * FK, named CHECK, UNIQUE) at every position, and as driver-level throws
 * through a delegating proxy (a non-SQL exception must roll back
 * identically). Success paths pin the row set each outcome class produces:
 * a run row for every cycle, snapshots only for successful ones (§11.1),
 * the §7.4 payload only beside a parse-failure run. Conventions follow
 * `test/integration/repository.spec.ts`: fresh disposable databases, the
 * canonical migrations, §11.1 foreign-key enforcement on, and deterministic
 * §11.1 timestamps. The `node:sqlite` ExperimentalWarning is expected here,
 * as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the factories. */
const T0 = 1_761_000_000_000;

/**
 * Runs `body` against a fresh repository over a fully migrated disposable
 * database with §11.1 foreign-key enforcement on.
 */
async function withRepository(
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

/* ── Input factories (every field explicit, spreads for overrides) ─────── */

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

function metricInput(overrides: Partial<CycleMetricInput> = {}): CycleMetricInput {
  return {
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

function eventInput(overrides: Partial<CycleEventInput> = {}): CycleEventInput {
  return {
    metricKey: 'monthly-credits',
    eventType: 'RESET',
    eventAt: T0 + 86_400_000,
    details: {
      reason: 'used decreased beyond tolerance',
      previous: { collectedAt: T0, used: 80 },
      current: { collectedAt: T0 + 300_000, used: 5 },
    },
    ...overrides,
  };
}

function snapshotInput(overrides: Partial<SuccessfulCycleSnapshot> = {}): SuccessfulCycleSnapshot {
  return {
    collectedAt: T0 + 1_200,
    planName: 'Pro',
    metrics: [metricInput()],
    events: [],
    ...overrides,
  };
}

/** Overrides for {@link successCycle} — the snapshot may be overridden partially too. */
type SuccessCycleOverrides = Omit<Partial<SuccessfulCollectionCycle>, 'snapshot'> & {
  snapshot?: Partial<SuccessfulCycleSnapshot>;
};

function successCycle(overrides: SuccessCycleOverrides = {}): SuccessfulCollectionCycle {
  const { snapshot, ...rest } = overrides;
  return {
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: snapshotInput(snapshot ?? {}),
    ...rest,
  };
}

/** The run fields every failed cycle shares (§7.2 failure evidence). */
function failureFields() {
  return {
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 500,
    intervalSeconds: 300,
    attempts: 2,
    httpStatus: null as number | null,
    errorMessage: 'provider failed' as string | null,
    retryAfterSeconds: null as number | null,
  };
}

function otherFailureCycle(
  outcome: Exclude<CollectionCycleWrite['outcome'], 'success' | 'parse_error'>,
  overrides: Partial<NonParseFailureCollectionCycle> = {},
): NonParseFailureCollectionCycle {
  return { ...failureFields(), outcome, ...overrides };
}

function parseErrorCycle(
  overrides: Partial<ParseFailureCollectionCycle> = {},
): ParseFailureCollectionCycle {
  return {
    ...failureFields(),
    outcome: 'parse_error',
    errorMessage: 'envelope mismatch',
    ...overrides,
  };
}

/** A failed cycle of any failure outcome (§11.2's six non-success values). */
function failedCycle(
  outcome: Exclude<CollectionCycleWrite['outcome'], 'success'>,
): CollectionCycleWrite {
  return outcome === 'parse_error' ? parseErrorCycle() : otherFailureCycle(outcome);
}

function rawResponseInput(overrides: Partial<CycleRawResponseInput> = {}): CycleRawResponseInput {
  return {
    capturedAt: T0,
    httpStatus: 200,
    contentType: 'application/json',
    body: '{"limits": [1, 2]}',
    ...overrides,
  };
}

/* ── Fault injection ───────────────────────────────────────────────────── */

/**
 * Asserts the done-condition's zero-residue state: after a failed cycle
 * write, no run, snapshot, event, or raw-payload row of the account exists.
 */
function expectEmptyHistory(repository: QuotaRepository, accountId = 'work'): void {
  expect(repository.listCollectionRuns(accountId)).toEqual([]);
  expect(repository.listSnapshots(accountId)).toEqual([]);
  expect(repository.listQuotaEvents(accountId)).toEqual([]);
  expect(repository.listRawResponses(accountId)).toEqual([]);
}

/**
 * A delegating proxy over `repository` whose `method` throws `failure` —
 * the driver-level fault injection: a non-SQL exception at that insert
 * position. `withTransaction` is wrapped so the repository the callback
 * receives is proxied too (the real method hands the bare facade instance
 * back, which would slip past the injection).
 */
function withFailingMethod(
  repository: QuotaRepository,
  method: 'insertMetricValues' | 'insertQuotaEvent',
  failure: Error,
): QuotaRepository {
  const inject = (target: QuotaRepository): QuotaRepository =>
    new Proxy(target, {
      get(target, property) {
        if (property === method) {
          return () => {
            throw failure;
          };
        }
        if (property === 'withTransaction') {
          return (work: (tx: QuotaRepository) => number) =>
            target.withTransaction((tx) => work(inject(tx)));
        }
        return Reflect.get(target, property, target);
      },
    });
  return inject(repository);
}

describe('collection-cycle persistence — success paths (task 089, spec §11.1)', () => {
  it('writes a complete successful cycle as one unit and returns the run id', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const cycle = successCycle({
        snapshot: {
          metrics: [
            metricInput({ metricKey: 'monthly-credits' }),
            metricInput({ metricKey: 'weekly-requests', limitType: 'WEEKLY', unit: 'REQUESTS' }),
          ],
          events: [eventInput()],
        },
      });

      const runId = persistCollectionCycle(repository, cycle);

      expect(repository.getCollectionRun(runId)).toEqual({
        id: runId,
        accountId: 'work',
        startedAt: T0,
        endedAt: T0 + 1_200,
        intervalSeconds: 300,
        outcome: 'success',
        httpStatus: 200,
        errorMessage: null,
        attempts: 1,
        retryAfterSeconds: null,
      });
      expect(repository.getSnapshotByRun(runId)).toEqual({
        runId,
        accountId: 'work',
        collectedAt: T0 + 1_200,
        planName: 'Pro',
      });

      // The writer supplied the identity: both rows carry the snapshot's
      // account and collection time (the D-039 pinning, by construction).
      const metrics = repository.getMetricValuesForRun(runId);
      expect(metrics.map((row) => row.metricKey)).toEqual(['monthly-credits', 'weekly-requests']);
      for (const row of metrics) {
        expect(row.accountId).toBe('work');
        expect(row.collectedAt).toBe(T0 + 1_200);
        expect(row.runId).toBe(runId);
      }

      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1);
      expect(events[0]?.runId).toBe(runId);
      expect(events[0]?.details.reason).toBe('used decreased beyond tolerance');
    });
  });

  it('stores a successful snapshot even with no metrics and no events', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const runId = persistCollectionCycle(
        repository,
        successCycle({ snapshot: { metrics: [], events: [] } }),
      );

      // §11.1: "Always store a snapshot for every successful collection
      // even if no values changed" — and the §8.4 boundary admits a
      // zero-metric snapshot, so the cycle write must not reject one.
      expect(repository.getCollectionRun(runId)?.outcome).toBe('success');
      expect(repository.getSnapshotByRun(runId)).not.toBe(null);
      expect(repository.getMetricValuesForRun(runId)).toEqual([]);
      expect(repository.listQuotaEvents('work')).toEqual([]);
    });
  });

  it('writes the run row for every unsuccessful outcome and never a snapshot', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const outcomes = [
        'auth_error',
        'rate_limited',
        'network_error',
        'timeout',
        'server_error',
        'parse_error',
      ] as const;

      for (const outcome of outcomes) {
        const runId = persistCollectionCycle(repository, failedCycle(outcome));
        expect(repository.getCollectionRun(runId)?.outcome, outcome).toBe(outcome);
      }
      // §11.1: a run record for every cycle; snapshots only for successful
      // ones — an error cycle cannot create one (structurally too, D-036).
      expect(repository.listCollectionRuns('work')).toHaveLength(6);
      expect(repository.listSnapshots('work')).toEqual([]);
      expect(repository.listQuotaEvents('work')).toEqual([]);
      expect(repository.listRawResponses('work')).toEqual([]);
    });
  });

  it('keeps failure evidence on the run row (message, status, retry-after)', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const runId = persistCollectionCycle(
        repository,
        otherFailureCycle('rate_limited', {
          httpStatus: 429,
          errorMessage: 'provider rate limit',
          retryAfterSeconds: 30,
        }),
      );

      const run = repository.getCollectionRun(runId);
      expect(run?.httpStatus).toBe(429);
      expect(run?.errorMessage).toBe('provider rate limit');
      expect(run?.retryAfterSeconds).toBe(30);
    });
  });

  it('stores the sanitized parse-failure payload beside its run', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const runId = persistCollectionCycle(
        repository,
        parseErrorCycle({ rawResponse: rawResponseInput({ body: '{"code": 4}' }) }),
      );

      expect(repository.getCollectionRun(runId)?.outcome).toBe('parse_error');
      expect(repository.getRawResponseByRun(runId)?.body).toBe('{"code": 4}');
      expect(repository.getRawResponseByRun(runId)?.runId).toBe(runId);
    });
  });
});

describe('collection-cycle persistence — injected failures leave no partial snapshot (§11.1, §17.1)', () => {
  it('a run-insert failure (unknown account) leaves nothing behind', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(repository, successCycle({ accountId: 'ghost' })),
      ).toThrow(/FOREIGN KEY constraint failed/);
      // The fault can only ever leak a run row under the ghost account —
      // residue must be asserted there, where the check can actually fail.
      expectEmptyHistory(repository, 'ghost');
      expectEmptyHistory(repository);
    });
  });

  it('a snapshot-insert failure rolls the run row back with it', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      // A blank plan name violates snapshots_plan_nonempty at the snapshot
      // insert — after the run row already went in.
      expect(() =>
        persistCollectionCycle(repository, successCycle({ snapshot: { planName: '' } })),
      ).toThrow(/CHECK constraint failed: snapshots_plan_nonempty/);
      // No run row without its snapshot (§11.1).
      expectEmptyHistory(repository);
    });
  });

  it('an invalid metric row riding a valid snapshot fails the whole cycle', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(
          repository,
          successCycle({
            snapshot: {
              metrics: [
                metricInput({
                  metricKey: 'empty-valid',
                  used: undefined,
                  remaining: undefined,
                  limit: undefined,
                  percentUsed: undefined,
                  percentRemaining: undefined,
                }),
              ],
            },
          }),
        ),
      ).toThrow(/CHECK constraint failed: metric_values_valid_has_value/);
      expectEmptyHistory(repository);
    });
  });

  it('a mid-batch duplicate metric key takes the earlier rows down with it', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(
          repository,
          successCycle({
            snapshot: {
              metrics: [
                metricInput({ metricKey: 'alpha' }),
                metricInput({ metricKey: 'beta' }),
                // The third row duplicates the first key: the statement
                // fails after two metric rows already landed in the
                // transaction — §11.1 leaves no snapshot without its
                // metrics, and no metrics without their snapshot.
                metricInput({ metricKey: 'alpha' }),
              ],
            },
          }),
        ),
      ).toThrow(/UNIQUE constraint failed: metric_values.run_id, metric_values.metric_key/);
      expectEmptyHistory(repository);
    });
  });

  it('an event-insert failure after the snapshot rolls everything back', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(
          repository,
          successCycle({
            snapshot: {
              metrics: [metricInput()],
              events: [
                eventInput({ metricKey: 'monthly-credits' }),
                // The second event's blank reason violates the D-046
                // evidence CHECK — after the first event already landed.
                eventInput({
                  metricKey: 'weekly-requests',
                  details: { reason: '', previous: {}, current: {} },
                }),
              ],
            },
          }),
        ),
      ).toThrow(/CHECK constraint failed: quota_events_details_reason/);
      expectEmptyHistory(repository);
    });
  });

  it('a raw-payload failure rolls the parse-error run back with it', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(
          repository,
          parseErrorCycle({
            rawResponse: rawResponseInput({ body: 'x'.repeat(65_537) }),
          }),
        ),
      ).toThrow(/CHECK constraint failed: raw_responses_body_size/);
      expectEmptyHistory(repository);
    });
  });

  it('a driver-level throw mid-cycle rolls back and rethrows the cause', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());

      const metricFailure = new Error('injected driver failure at the metric insert');
      expect(() =>
        persistCollectionCycle(
          withFailingMethod(repository, 'insertMetricValues', metricFailure),
          successCycle(),
        ),
      ).toThrow(metricFailure);
      expectEmptyHistory(repository);

      const eventFailure = new Error('injected driver failure at the event insert');
      expect(() =>
        persistCollectionCycle(
          withFailingMethod(repository, 'insertQuotaEvent', eventFailure),
          successCycle({ snapshot: { events: [eventInput()] } }),
        ),
      ).toThrow(eventFailure);
      expectEmptyHistory(repository);
    });
  });

  it('keeps the connection usable after a rolled-back cycle', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        persistCollectionCycle(
          repository,
          successCycle({ snapshot: { metrics: [metricInput(), metricInput()] } }),
        ),
      ).toThrow(/UNIQUE constraint failed/);

      // The aborted transaction left no residue and no open transaction:
      // the next cycle commits normally (§11.1).
      const runId = persistCollectionCycle(repository, successCycle());
      expect(repository.getSnapshotByRun(runId)).not.toBe(null);
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
    });
  });
});
