import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type NewAccount,
  type NewCollectionRun,
  type NewMetricValue,
  type NewRawResponse,
  type NewSession,
  type NewSnapshot,
  type QuotaEventDetails,
  type QuotaRepository,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 088's done-condition (spec §8.1, §11): the typed repository is the
 * only sanctioned data path — every method round-trips through the canonical
 * schema (migrations 0001–0007) against disposable databases, the structural
 * constraints tasks 081–087 pinned (success-only snapshots, parse-error-only
 * raw payloads, denormalization pinning, validity invariants) surface
 * through the facade as loud failures, and `withTransaction` exhibits the
 * §11.1 all-or-nothing behavior task 089 will compose into the atomic cycle
 * write. Sessions use the §15.2 digest shape (D-056). Rows run with
 * `PRAGMA foreign_keys = ON`, matching the §11.1 connection production uses
 * (task 079); raw `DatabaseSync` handles default to SQLite's off (D-034's
 * pinned note for storage tests). The `node:sqlite` ExperimentalWarning is
 * expected here, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the row factories. */
const T0 = 1_761_000_000_000;

/** A §15.2 digest — exactly what the session layer stores. */
const TOKEN_HASH = createHash('sha256').update('fixture-session-token').digest('hex');

/** Another digest, for multi-session rows. */
const OTHER_TOKEN_HASH = createHash('sha256').update('fixture-other-token').digest('hex');

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

function eventDetails(overrides: Partial<QuotaEventDetails> = {}): QuotaEventDetails {
  return {
    reason: 'used decreased beyond tolerance',
    previous: { collectedAt: T0, used: 80, resetsAt: T0 + 86_400_000 },
    current: { collectedAt: T0 + 300_000, used: 5, resetsAt: T0 + 172_800_000 },
    tolerance: 0.5,
    eventTimeSource: 'previous-resets-at',
    ...overrides,
  };
}

function rawResponse(runId: number, overrides: Partial<NewRawResponse> = {}): NewRawResponse {
  return {
    accountId: 'work',
    runId,
    capturedAt: T0,
    httpStatus: 200,
    contentType: 'application/json',
    body: '{"limits": [1, 2]}',
    ...overrides,
  };
}

function session(overrides: Partial<NewSession> = {}): NewSession {
  return {
    tokenHash: TOKEN_HASH,
    createdAt: T0,
    lastSeenAt: T0,
    // The effective expiry: min(created + 7 d, created + 30 d) — the
    // inactivity bound is the tighter one at creation (D-056).
    expiresAt: T0 + 7 * 86_400_000,
    ...overrides,
  };
}

/**
 * One full successful cycle — account, run, snapshot — the base most tests
 * spread; returns the run id.
 */
function insertCycle(
  repository: QuotaRepository,
  overrides: { collectedAt?: number } = {},
): number {
  repository.insertAccount(account());
  const runId = repository.insertCollectionRun(run());
  repository.insertSnapshot(snapshot(runId, { collectedAt: overrides.collectedAt ?? T0 }));
  return runId;
}

describe('repository accounts (task 088, spec §11.2, §8.2)', () => {
  it('round-trips an account with and without a plan', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      repository.insertAccount(account({ id: 'personal', planName: null, label: 'Personal' }));

      expect(repository.getAccount('work')).toEqual({
        id: 'work',
        providerId: 'zai-coding-plan',
        label: 'Work plan',
        planName: 'Pro',
        status: 'active',
        createdAt: T0,
        archivedAt: null,
      });
      const personal = repository.getAccount('personal');
      expect(personal?.planName).toBe(null);
      expect(personal?.label).toBe('Personal');
      expect(repository.getAccount('missing')).toBe(null);
    });
  });

  it('lists accounts id-ascending', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      repository.insertAccount(account({ id: 'a-first' }));
      repository.insertAccount(account({ id: 'z-last' }));
      expect(repository.listAccounts().map((row) => row.id)).toEqual(['a-first', 'work', 'z-last']);
    });
  });

  it('fails loudly on duplicate ids and charset violations', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() => repository.insertAccount(account({ label: 'Other' }))).toThrow(
        /UNIQUE constraint failed: accounts.id/,
      );
      expect(() => repository.insertAccount(account({ id: 'bad id!' }))).toThrow(
        /CHECK constraint failed: accounts_id_charset/,
      );
    });
  });

  it('updates label and plan, and clears the plan with null', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(repository.updateAccountDetails('work', { label: 'Renamed' })).toBe(true);
      expect(repository.updateAccountDetails('work', { planName: 'Max' })).toBe(true);
      const renamed = repository.getAccount('work');
      expect(renamed?.label).toBe('Renamed');
      expect(renamed?.planName).toBe('Max');

      expect(repository.updateAccountDetails('work', { planName: null })).toBe(true);
      expect(repository.getAccount('work')?.planName).toBe(null);

      expect(repository.updateAccountDetails('missing', { label: 'X' })).toBe(false);
      expect(() => repository.updateAccountDetails('work', {})).toThrow(
        /changes must set label or planName/,
      );
    });
  });

  it('archives once, keeping the original timestamp and all history', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      const archivedAt = T0 + 5 * 86_400_000;

      expect(repository.archiveAccount('work', archivedAt)).toBe(true);
      expect(repository.getAccount('work')).toEqual({
        id: 'work',
        providerId: 'zai-coding-plan',
        label: 'Work plan',
        planName: 'Pro',
        status: 'archived',
        createdAt: T0,
        archivedAt,
      });
      // §8.2 archive-not-delete: history stays queryable.
      expect(repository.getCollectionRun(runId)).not.toBe(null);
      expect(repository.getSnapshotByRun(runId)).not.toBe(null);

      // A second archive cannot rewrite the lifecycle timestamp.
      expect(repository.archiveAccount('work', archivedAt + 1)).toBe(false);
      expect(repository.getAccount('work')?.archivedAt).toBe(archivedAt);
      expect(repository.archiveAccount('missing', archivedAt)).toBe(false);
    });
  });

  it('deletes an account and cascades its history (the §8.2 purge path)', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      const failedId = repository.insertCollectionRun(
        run({ outcome: 'parse_error', httpStatus: null, errorMessage: 'envelope mismatch' }),
      );
      repository.insertRawResponse(rawResponse(failedId));

      expect(repository.deleteAccount('work')).toBe(true);
      expect(repository.deleteAccount('work')).toBe(false);
      expect(repository.getAccount('work')).toBe(null);
      expect(repository.listCollectionRuns('work')).toEqual([]);
      expect(repository.getSnapshotByRun(runId)).toBe(null);
      expect(repository.getMetricValuesForRun(runId)).toEqual([]);
      expect(repository.getRawResponseByRun(failedId)).toBe(null);
    });
  });
});

describe('repository collection runs (task 088, spec §11.2, §7.2)', () => {
  it('inserts one row per cycle and returns the assigned identity', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const first = repository.insertCollectionRun(run());
      const second = repository.insertCollectionRun(
        run({
          outcome: 'rate_limited',
          startedAt: T0 + 300_000,
          endedAt: T0 + 300_500,
          httpStatus: 429,
          errorMessage: 'provider rate limit',
          attempts: 2,
          retryAfterSeconds: 30,
        }),
      );
      expect(second).toBeGreaterThan(first);

      expect(repository.getCollectionRun(first)).toEqual({
        id: first,
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
      const limited = repository.getCollectionRun(second);
      expect(limited?.outcome).toBe('rate_limited');
      expect(limited?.retryAfterSeconds).toBe(30);
      expect(repository.getCollectionRun(9_999)).toBe(null);
    });
  });

  it('requires the account to exist (cascading foreign key)', async () => {
    await withRepository((repository) => {
      expect(() => repository.insertCollectionRun(run({ accountId: 'ghost' }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });
  });

  it('lists runs ascending with outcome/window/limit filters', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const cycles = [
        { outcome: 'success', startedAt: T0 },
        { outcome: 'auth_error', startedAt: T0 + 300_000 },
        { outcome: 'success', startedAt: T0 + 600_000 },
        { outcome: 'timeout', startedAt: T0 + 900_000 },
      ] as const;
      for (const cycle of cycles) {
        repository.insertCollectionRun(run({ ...cycle, endedAt: cycle.startedAt + 1 }));
      }

      expect(repository.listCollectionRuns('work').map((row) => row.outcome)).toEqual([
        'success',
        'auth_error',
        'success',
        'timeout',
      ]);
      expect(
        repository.listCollectionRuns('work', { outcome: 'success' }).map((row) => row.startedAt),
      ).toEqual([T0, T0 + 600_000]);
      expect(
        repository.listCollectionRuns('work', { from: T0 + 300_000, to: T0 + 600_000 }),
      ).toHaveLength(2);
      // Ascending order + limit keeps the oldest rows.
      expect(
        repository.listCollectionRuns('work', { limit: 2 }).map((row) => row.startedAt),
      ).toEqual([T0, T0 + 300_000]);
      expect(repository.listCollectionRuns('ghost')).toEqual([]);
    });
  });

  it('answers the §7.3 status rows (latest, latest success, latest failure)', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      repository.insertCollectionRun(run());
      repository.insertCollectionRun(
        run({
          outcome: 'server_error',
          startedAt: T0 + 300_000,
          endedAt: T0 + 300_001,
          httpStatus: 502,
        }),
      );

      expect(repository.getLatestCollectionRun('work')?.outcome).toBe('server_error');
      expect(repository.getLatestCollectionRun('work', 'success')?.outcome).toBe('success');
      expect(repository.getLatestCollectionRun('work', 'parse_error')).toBe(null);
      expect(repository.getLatestCollectionRun('ghost')).toBe(null);
    });
  });

  it('deletes runs started before the cutoff and reports the count', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const old = repository.insertCollectionRun(run({ startedAt: T0, endedAt: T0 + 1 }));
      const kept = repository.insertCollectionRun(
        run({ startedAt: T0 + 600_000, endedAt: T0 + 600_001 }),
      );

      expect(repository.deleteCollectionRunsBefore(T0 + 300_000)).toBe(1);
      expect(repository.deleteCollectionRunsBefore(T0 + 300_000)).toBe(0);
      expect(repository.getCollectionRun(old)).toBe(null);
      expect(repository.getCollectionRun(kept)).not.toBe(null);
    });
  });
});

describe('repository snapshots (task 088, spec §11.2, D-036)', () => {
  it('round-trips the header and answers latest/window/limit queries', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const first = repository.insertCollectionRun(run());
      repository.insertSnapshot(snapshot(first, { collectedAt: T0 }));
      const second = repository.insertCollectionRun(
        run({ startedAt: T0 + 300_000, endedAt: T0 + 300_001 }),
      );
      repository.insertSnapshot(snapshot(second, { collectedAt: T0 + 300_000, planName: null }));

      expect(repository.getSnapshotByRun(first)).toEqual({
        runId: first,
        accountId: 'work',
        collectedAt: T0,
        planName: 'Pro',
      });
      expect(repository.getSnapshotByRun(9_999)).toBe(null);

      expect(repository.getLatestSnapshot('work')?.runId).toBe(second);
      expect(repository.getLatestSnapshot('ghost')).toBe(null);

      expect(
        repository
          .listSnapshots('work', { from: T0 + 1, to: T0 + 600_000 })
          .map((row) => row.runId),
      ).toEqual([second]);
      expect(repository.listSnapshots('work', { limit: 1 }).map((row) => row.runId)).toEqual([
        first,
      ]);
    });
  });

  it('rejects a snapshot for any non-success run — an error cycle cannot create one', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      for (const outcome of [
        'auth_error',
        'rate_limited',
        'network_error',
        'timeout',
        'server_error',
        'parse_error',
      ] as const) {
        const failed = repository.insertCollectionRun(run({ outcome }));
        expect(() => repository.insertSnapshot(snapshot(failed)), outcome).toThrow(
          /FOREIGN KEY constraint failed/,
        );
      }
    });
  });

  it('allows at most one snapshot per run', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      // SQLite may report either the plain run_id UNIQUE or the D-039
      // composite parent key (account_id, run_id, collected_at) — both are
      // schema-level one-snapshot-per-run guarantees.
      expect(() => repository.insertSnapshot(snapshot(runId))).toThrow(
        /UNIQUE constraint failed: snapshots\./,
      );
    });
  });
});

describe('repository metric values (task 088, spec §11.2, §8.4, D-039)', () => {
  it('round-trips quota values and the derived-fields bitmask', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      repository.insertMetricValues([
        metric(runId, { metricKey: 'alpha', derivedFields: null }),
        metric(runId, {
          metricKey: 'beta',
          used: 40,
          remaining: undefined,
          limit: undefined,
          percentUsed: undefined,
          percentRemaining: undefined,
          derivedFields: ['used'],
        }),
        metric(runId, {
          metricKey: 'gamma',
          used: undefined,
          remaining: 10,
          limit: 100,
          percentUsed: 91,
          percentRemaining: 9,
          derivedFields: ['remaining', 'limit', 'percentUsed', 'percentRemaining'],
        }),
        metric(runId, {
          metricKey: 'delta',
          used: 5,
          remaining: undefined,
          limit: undefined,
          percentUsed: undefined,
          percentRemaining: undefined,
          derivedFields: [],
        }),
      ]);

      const rows = repository.getMetricValuesForRun(runId);
      // metric_key-ascending under SQLite's BINARY collation.
      expect(rows.map((row) => row.metricKey)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
      expect(rows[0]?.derivedFields).toBe(null);
      expect(rows[1]?.derivedFields).toEqual(['used']);
      expect(rows[2]?.derivedFields).toEqual([]);
      expect(rows[3]?.derivedFields).toEqual([
        'remaining',
        'limit',
        'percentUsed',
        'percentRemaining',
      ]);
      expect(rows[1]?.remaining).toBe(null);
    });
  });

  it('retains window metadata on invalid rows and stores NULL numerics', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      repository.insertMetricValues([
        metric(runId, {
          metricKey: 'broken',
          used: undefined,
          remaining: undefined,
          limit: undefined,
          percentUsed: undefined,
          percentRemaining: undefined,
          windowSeconds: 18_000,
          resetsAt: T0 + 3_600_000,
          isValid: false,
          invalidReason: 'usage missing from response',
        }),
      ]);

      const row = repository.getMetricValuesForRun(runId)[0];
      expect(row?.isValid).toBe(false);
      expect(row?.invalidReason).toBe('usage missing from response');
      expect(row?.used).toBe(null);
      expect(row?.limit).toBe(null);
      expect(row?.windowSeconds).toBe(18_000);
      expect(row?.resetsAt).toBe(T0 + 3_600_000);
    });
  });

  it('serves per-account series ascending, filtered by window', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      for (const index of [0, 1, 2]) {
        const runId = repository.insertCollectionRun(
          run({ startedAt: T0 + index * 300_000, endedAt: T0 + index * 300_000 + 1 }),
        );
        repository.insertSnapshot(snapshot(runId, { collectedAt: T0 + index * 300_000 }));
        repository.insertMetricValues([
          metric(runId, {
            collectedAt: T0 + index * 300_000,
            metricKey: 'monthly-credits',
            used: index,
          }),
          metric(runId, {
            collectedAt: T0 + index * 300_000,
            metricKey: 'weekly-requests',
            unit: 'REQUESTS',
            limitType: 'WEEKLY',
          }),
        ]);
      }

      const series = repository.getMetricSeries('work', 'monthly-credits', {
        from: T0 + 300_000,
        to: T0 + 600_000,
      });
      expect(series.map((row) => row.used)).toEqual([1, 2]);
      expect(repository.getMetricSeries('work', 'weekly-requests')).toHaveLength(3);
      expect(repository.getMetricSeries('work', 'absent')).toEqual([]);
      expect(repository.getMetricSeries('ghost', 'monthly-credits')).toEqual([]);
    });
  });

  it('serves the series from the spec-named series index', async () => {
    await withRepository((repository, database) => {
      const runId = insertCycle(repository);
      repository.insertMetricValues([metric(runId)]);
      // Hand-written mirror of getMetricSeries' filtered shape (the facade
      // deliberately does not expose its SQL); if the method's WHERE or
      // ORDER BY drifts, this fixture must be revisited with it.
      const plan = (
        database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT run_id, account_id, collected_at, metric_key FROM metric_values
             WHERE account_id = ? AND metric_key = ? AND collected_at >= ? AND collected_at <= ?
             ORDER BY collected_at ASC`,
          )
          .all('work', 'monthly-credits', T0, T0 + 1) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toContain('metric_values_series_access');
    });
  });

  it('rejects duplicate keys per snapshot and denormalization drift', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      repository.insertMetricValues([metric(runId)]);
      expect(() => repository.insertMetricValues([metric(runId)])).toThrow(
        /UNIQUE constraint failed: metric_values.run_id, metric_values.metric_key/,
      );
      // The copied account/time cannot drift from the snapshot (D-039).
      expect(() =>
        repository.insertMetricValues([metric(runId, { metricKey: 'other', collectedAt: T0 + 1 })]),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it('propagates the validity invariants as named constraint failures', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      const noValues = {
        used: undefined,
        remaining: undefined,
        limit: undefined,
        percentUsed: undefined,
        percentRemaining: undefined,
      } as const;
      expect(() =>
        repository.insertMetricValues([metric(runId, { metricKey: 'empty-valid', ...noValues })]),
      ).toThrow(/CHECK constraint failed: metric_values_valid_has_value/);
      expect(() =>
        repository.insertMetricValues([
          metric(runId, { metricKey: 'dirty-invalid', isValid: false, invalidReason: 'x' }),
        ]),
      ).toThrow(/CHECK constraint failed: metric_values_invalid_clean/);
      // The encoder's own contract: a derived bit must couple to its
      // column's presence (D-039's metric_values_derived_present).
      expect(() =>
        repository.insertMetricValues([
          metric(runId, {
            metricKey: 'derived-without-value',
            remaining: undefined,
            derivedFields: ['remaining'],
          }),
        ]),
      ).toThrow(/CHECK constraint failed: metric_values_derived_present/);
    });
  });
});

describe('repository quota events (task 088, spec §11.2, §12.1, D-046)', () => {
  it('round-trips evidence JSON, including extra vocabulary', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      repository.insertQuotaEvent({
        accountId: 'work',
        metricKey: 'monthly-credits',
        eventType: 'RESET',
        eventAt: T0 + 86_400_000,
        runId,
        details: eventDetails(),
      });

      const events = repository.listQuotaEvents('work');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventAt).toBe(T0 + 86_400_000);
      expect(events[0]?.runId).toBe(runId);
      expect(events[0]?.details.reason).toBe('used decreased beyond tolerance');
      expect(events[0]?.details.previous).toEqual({
        collectedAt: T0,
        used: 80,
        resetsAt: T0 + 86_400_000,
      });
      // The deeper detector vocabulary passes through verbatim.
      expect(events[0]?.details.eventTimeSource).toBe('previous-resets-at');
    });
  });

  it('admits a NULL snapshot reference and keeps ordering deterministic', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      repository.insertQuotaEvent({
        accountId: 'work',
        metricKey: 'monthly-credits',
        eventType: 'RESET',
        eventAt: T0,
        runId: null,
        details: eventDetails(),
      });
      repository.insertQuotaEvent({
        accountId: 'work',
        metricKey: 'monthly-credits',
        eventType: 'RESET',
        eventAt: T0,
        runId: null,
        details: eventDetails({ reason: 'later row at the same instant' }),
      });
      const events = repository.listQuotaEvents('work');
      expect(events.map((event) => event.details.reason)).toEqual([
        'used decreased beyond tolerance',
        'later row at the same instant',
      ]);
    });
  });

  it('filters by metric and window, and deletes before a cutoff', async () => {
    await withRepository((repository) => {
      const runId = insertCycle(repository);
      repository.insertQuotaEvent({
        accountId: 'work',
        metricKey: 'monthly-credits',
        eventType: 'RESET',
        eventAt: T0,
        runId,
        details: eventDetails(),
      });
      repository.insertQuotaEvent({
        accountId: 'work',
        metricKey: 'weekly-requests',
        eventType: 'RESET',
        eventAt: T0 + 600_000,
        runId,
        details: eventDetails(),
      });

      expect(repository.listQuotaEvents('work', { metricKey: 'weekly-requests' })).toHaveLength(1);
      expect(repository.listQuotaEvents('work', { from: T0 + 1, to: T0 + 700_000 })).toHaveLength(
        1,
      );

      expect(repository.deleteQuotaEventsBefore(T0 + 300_000)).toBe(1);
      expect(repository.deleteQuotaEventsBefore(T0 + 300_000)).toBe(0);
      expect(repository.listQuotaEvents('work')).toHaveLength(1);
    });
  });

  it('enforces the evidence contract and the snapshot link', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        repository.insertQuotaEvent({
          accountId: 'work',
          metricKey: 'monthly-credits',
          eventType: 'RESET',
          eventAt: T0,
          runId: null,
          details: eventDetails({ reason: '' }),
        }),
      ).toThrow(/CHECK constraint failed: quota_events_details_reason/);
      expect(() =>
        repository.insertQuotaEvent({
          accountId: 'ghost',
          metricKey: 'monthly-credits',
          eventType: 'RESET',
          eventAt: T0,
          runId: null,
          details: eventDetails(),
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
      // An event cannot reference another account's snapshot.
      expect(() =>
        repository.insertQuotaEvent({
          accountId: 'work',
          metricKey: 'monthly-credits',
          eventType: 'RESET',
          eventAt: T0,
          runId: 9_999,
          details: eventDetails(),
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });
});

describe('repository raw responses (task 088, spec §7.4, D-051)', () => {
  it('stores only parse-failure payloads, newest first', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const older = repository.insertCollectionRun(
        run({ outcome: 'parse_error', httpStatus: 200, errorMessage: 'envelope mismatch' }),
      );
      const newer = repository.insertCollectionRun(
        run({
          outcome: 'parse_error',
          startedAt: T0 + 300_000,
          endedAt: T0 + 300_001,
          httpStatus: null,
          errorMessage: 'empty body',
        }),
      );
      repository.insertRawResponse(rawResponse(older));
      repository.insertRawResponse(
        rawResponse(newer, {
          capturedAt: T0 + 300_000,
          httpStatus: null,
          contentType: null,
          body: '',
        }),
      );

      expect(repository.getRawResponseByRun(older)?.body).toBe('{"limits": [1, 2]}');
      expect(repository.getRawResponseByRun(newer)?.body).toBe('');
      expect(repository.getRawResponseByRun(9_999)).toBe(null);

      const listed = repository.listRawResponses('work');
      expect(listed.map((row) => row.runId)).toEqual([newer, older]);
      expect(repository.listRawResponses('work', { limit: 1 }).map((row) => row.runId)).toEqual([
        newer,
      ]);
      expect(repository.listRawResponses('ghost')).toEqual([]);

      expect(repository.deleteRawResponsesBefore(T0 + 100_000)).toBe(1);
      expect(repository.listRawResponses('work')).toHaveLength(1);
    });
  });

  it('deletes payloads by run identity — the 103 per-account-cap primitive', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const runIds = [0, 1, 2].map((index) =>
        repository.insertCollectionRun(
          run({
            outcome: 'parse_error',
            startedAt: T0 + index * 300_000,
            endedAt: T0 + index * 300_000 + 1,
          }),
        ),
      );
      for (const [index, runId] of runIds.entries()) {
        repository.insertRawResponse(rawResponse(runId, { capturedAt: T0 + index * 300_000 }));
      }

      // Keep the newest one: delete the identities the policy discards.
      expect(repository.deleteRawResponsesByRunIds(runIds.slice(0, 2))).toBe(2);
      expect(repository.listRawResponses('work').map((row) => row.runId)).toEqual([runIds[2]]);
      expect(repository.deleteRawResponsesByRunIds(runIds.slice(0, 2))).toBe(0);
      expect(repository.deleteRawResponsesByRunIds([])).toBe(0);
    });
  });

  it('rejects payloads for successful and other non-parse runs', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const successRun = repository.insertCollectionRun(run());
      const authRun = repository.insertCollectionRun(run({ outcome: 'auth_error' }));
      for (const runId of [successRun, authRun]) {
        expect(() => repository.insertRawResponse(rawResponse(runId))).toThrow(
          /FOREIGN KEY constraint failed/,
        );
      }
    });
  });
});

describe('repository sessions and meta (task 088, spec §11.2, §15.2, D-056)', () => {
  it('round-trips a session and refreshes sightings atomically per call', async () => {
    await withRepository((repository) => {
      repository.insertSession(session());
      expect(repository.getSession(TOKEN_HASH)).toEqual({
        tokenHash: TOKEN_HASH,
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + 7 * 86_400_000,
      });
      expect(repository.getSession(OTHER_TOKEN_HASH)).toBe(null);

      const refreshedAt = T0 + 86_400_000;
      expect(
        repository.touchSession(TOKEN_HASH, {
          lastSeenAt: refreshedAt,
          expiresAt: refreshedAt + 7 * 86_400_000,
        }),
      ).toBe(true);
      const refreshed = repository.getSession(TOKEN_HASH);
      expect(refreshed?.lastSeenAt).toBe(refreshedAt);
      expect(refreshed?.expiresAt).toBe(refreshedAt + 7 * 86_400_000);
      expect(repository.touchSession(OTHER_TOKEN_HASH, { lastSeenAt: 0, expiresAt: 0 })).toBe(
        false,
      );
    });
  });

  it('deletes one session, all sessions, and expired sessions', async () => {
    await withRepository((repository) => {
      repository.insertSession(session());
      repository.insertSession(session({ tokenHash: OTHER_TOKEN_HASH, expiresAt: T0 + 1 }));

      expect(repository.deleteSessionsExpiredBefore(T0 + 2)).toBe(1);
      expect(repository.getSession(OTHER_TOKEN_HASH)).toBe(null);
      expect(repository.getSession(TOKEN_HASH)).not.toBe(null);

      expect(repository.deleteSession(TOKEN_HASH)).toBe(true);
      expect(repository.deleteSession(TOKEN_HASH)).toBe(false);

      repository.insertSession(session());
      expect(repository.deleteAllSessions()).toBe(1);
      expect(repository.deleteAllSessions()).toBe(0);
    });
  });

  it('leaves sessions and meta untouched when account history is purged', async () => {
    await withRepository((repository) => {
      insertCycle(repository);
      repository.insertSession(session());
      repository.setMetaValue('cleanup:last-run', '2026-10-31T00:00:00Z');

      repository.deleteAccount('work');
      expect(repository.getSession(TOKEN_HASH)).not.toBe(null);
      expect(repository.getMetaValue('cleanup:last-run')).toBe('2026-10-31T00:00:00Z');
    });
  });

  it('upserts meta values, including the empty string', async () => {
    await withRepository((repository) => {
      expect(repository.getMetaValue('k')).toBe(null);
      repository.setMetaValue('k', 'first');
      expect(repository.getMetaValue('k')).toBe('first');
      repository.setMetaValue('k', 'second');
      expect(repository.getMetaValue('k')).toBe('second');
      repository.setMetaValue('empty', '');
      expect(repository.getMetaValue('empty')).toBe('');
    });
  });
});

describe('repository transactions (task 088, spec §11.1 — the 089 seam)', () => {
  it('commits the callback work as one unit', async () => {
    await withRepository((repository) => {
      const runId = repository.withTransaction((tx) => {
        tx.insertAccount(account());
        const id = tx.insertCollectionRun(run());
        tx.insertSnapshot(snapshot(id));
        tx.insertMetricValues([metric(id)]);
        return id;
      });
      expect(repository.getCollectionRun(runId)).not.toBe(null);
      expect(repository.getSnapshotByRun(runId)).not.toBe(null);
      expect(repository.getMetricValuesForRun(runId)).toHaveLength(1);
    });
  });

  it('rolls back every write when the callback throws, rethrowing the cause', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      const failure = new Error('injected failure between writes');
      expect(() =>
        repository.withTransaction((tx) => {
          const id = tx.insertCollectionRun(run());
          tx.insertSnapshot(snapshot(id));
          throw failure;
        }),
      ).toThrow(failure);
      expect(repository.listCollectionRuns('work')).toEqual([]);
      expect(repository.listSnapshots('work')).toEqual([]);
      // The connection left the transaction: later writes commit normally.
      const after = repository.insertCollectionRun(run());
      expect(repository.getCollectionRun(after)).not.toBe(null);
    });
  });

  it('rolls back when a statement fails mid-cycle (§11.1 partial-snapshot ban)', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(() =>
        repository.withTransaction((tx) => {
          const id = tx.insertCollectionRun(run());
          tx.insertSnapshot(snapshot(id));
          // The duplicate metric key must take the run and snapshot down
          // with it — §11.1 leaves no partial snapshot.
          tx.insertMetricValues([metric(id), metric(id)]);
        }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(repository.listCollectionRuns('work')).toEqual([]);
      expect(repository.listSnapshots('work')).toEqual([]);
    });
  });

  it('refuses nesting loudly', async () => {
    await withRepository((repository) => {
      expect(() =>
        repository.withTransaction((outer) => {
          outer.insertAccount(account());
          outer.withTransaction(() => {
            // Never reached: the nested guard fires first.
          });
          return undefined;
        }),
      ).toThrow(/withTransaction cannot be nested/);
      // The aborted outer transaction rolled the account insert back and
      // left the connection usable: later writes commit normally.
      expect(repository.listAccounts()).toEqual([]);
      repository.insertAccount(account());
      expect(repository.listAccounts()).toHaveLength(1);
    });
  });

  it('resets its guard when BEGIN itself fails, so later transactions work', async () => {
    await withRepository((repository, database) => {
      // Occupy the connection's transaction slot so the facade's BEGIN
      // fails — the same failure class a SQLITE_BUSY past the §11.1
      // busy_timeout budget produces (review finding: the guard used to
      // latch on this path and refuse every later transaction).
      database.exec('BEGIN IMMEDIATE');
      expect(() => repository.withTransaction(() => undefined)).toThrow(
        /cannot start a transaction within a transaction/,
      );
      // The guard did not latch, and the cleanup rolled the stale
      // transaction back: the next transaction commits normally.
      repository.withTransaction((tx) => {
        tx.insertAccount(account());
      });
      expect(repository.listAccounts()).toHaveLength(1);
    });
  });

  it('reads see the callback own writes (one connection)', async () => {
    await withRepository((repository) => {
      repository.withTransaction((tx) => {
        tx.insertAccount(account());
        expect(tx.getAccount('work')).not.toBe(null);
        return undefined;
      });
    });
  });
});
