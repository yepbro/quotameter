import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStorageConnection, type StorageConnection } from '../../src/storage/connection';
import {
  persistCollectionCycle,
  type CycleEventInput,
  type CycleMetricInput,
  type ParseFailureCollectionCycle,
  type SuccessfulCollectionCycle,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  historyCutoff,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RAW_RESPONSE_MAX_AGE_DAYS,
  RETENTION_APPLIED_DAYS_KEY,
  RETENTION_LAST_RUN_KEY,
  runRetentionCleanup,
} from '../../src/storage/retention-cleanup';
import {
  createQuotaRepository,
  type NewAccount,
  type QuotaRepository,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 091's done-condition (spec §11.3): "startup and daily cleanup are
 * safe to repeat" — verified by running the cleanup twice over the same
 * seeded history (identical input: the second run removes nothing and
 * changes nothing), then at a later `now` (the daily cadence: only the
 * newly expired go), then at an earlier one (clock skew back: a no-op).
 * Around that core the suite pins every §11.3 boundary per its table's own
 * time column (all the facade's deletes are strictly-before), the run as
 * the retention unit (cascades take snapshot/metrics/linked rows of
 * expired runs), §7.4's independent 30-day raw window (retention 90: a
 * 40-day-old payload dies while its run survives), §15.2's session expiry
 * (independent of the history window), the 7–3650 bounds rejected **before
 * any delete runs**, the §11.3 "do not delete" protections (accounts,
 * unrelated meta), the cleanup metadata markers (§11.2 — the
 * reduce-retention warning hook's data), the composed WAL checkpoint
 * (observable as a zero-byte `-wal` file), and the deletes-and-markers
 * transaction (an injected marker-write failure rolls everything back).
 *
 * Conventions follow `test/integration/collection-cycles.spec.ts` — fresh
 * disposable databases, the canonical migrations, deterministic §11.1
 * timestamps, history seeded through the 089 atomic-cycle seam — with one
 * deliberate upgrade: the connection comes from `openStorageConnection`
 * (task 079), the production-faithful handle whose readback-verified WAL
 * and foreign-key pragmas the cleanup's cascades and checkpoint run
 * against. The `node:sqlite` ExperimentalWarning is expected here, as in
 * every storage test (docs/agents/gotchas.md).
 */

/** §11.1 epoch milliseconds per day — the cutoff arithmetic's unit. */
const MS_PER_DAY = 86_400_000;

/** Deterministic §11.1 epoch-millisecond base for the factories. */
const T0 = 1_761_000_000_000;

/** The cleanup's writer-supplied "now" — 400 days after the seed base. */
const NOW = T0 + 400 * MS_PER_DAY;

/** A session digest in the D-056 shape — SHA-256 hex, never the token. */
const sessionHash = (name: string): string => createHash('sha256').update(name).digest('hex');

/**
 * Runs `body` against a fresh repository over the production connection
 * (task 079: WAL, foreign keys, busy timeout — all readback-verified) and
 * the canonical migrations.
 */
async function withCleanup(
  body: (
    repository: QuotaRepository,
    database: DatabaseSync,
    connection: StorageConnection,
  ) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const connection = openStorageConnection({ dataDir: dir.path });
    try {
      await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
      const repository = createQuotaRepository({ database: connection.database });
      await body(repository, connection.database, connection);
    } finally {
      connection.close();
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
    resetsAt: T0 + MS_PER_DAY,
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
    eventAt: T0,
    details: {
      reason: 'used decreased beyond tolerance',
      previous: { collectedAt: T0, used: 80 },
      current: { collectedAt: T0 + 300_000, used: 5 },
    },
    ...overrides,
  };
}

/** A successful cycle whose snapshot is written with the run (`collectedAt` overrideable). */
function successCycle(
  overrides: Partial<SuccessfulCollectionCycle> = {},
): SuccessfulCollectionCycle {
  const startedAt = overrides.startedAt ?? T0;
  return {
    accountId: 'work',
    startedAt,
    endedAt: startedAt + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: startedAt + 1_200,
      planName: 'Pro',
      metrics: [metricInput()],
      events: [],
    },
    ...overrides,
  };
}

/** A parse-failure cycle carrying a §7.4 payload captured at its start. */
function parseCycle(
  overrides: Partial<ParseFailureCollectionCycle> = {},
): ParseFailureCollectionCycle {
  const startedAt = overrides.startedAt ?? T0;
  return {
    accountId: 'work',
    startedAt,
    endedAt: startedAt + 800,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    errorMessage: 'envelope mismatch',
    retryAfterSeconds: null,
    outcome: 'parse_error',
    rawResponse: {
      capturedAt: startedAt,
      httpStatus: 200,
      contentType: 'application/json',
      body: '{"limits": [1, 2]}',
    },
    ...overrides,
  };
}

/* ── The cleanup call, bound to a test's collaborators ─────────────────── */

function cleanup(
  repository: QuotaRepository,
  database: DatabaseSync,
  input: { now: number; retentionDays: number },
) {
  return runRetentionCleanup({ repository, database }, input);
}

/* ── Retention window: what expires per each table's time column ──────── */

describe('retention cleanup — the §11.3 window deletes exactly the expired rows (task 091)', () => {
  it('deletes expired runs/events/raw payloads/sessions, keeps every exactly-at-cutoff row', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      repository.insertAccount(account({ id: 'personal', label: 'Personal plan' }));
      // work: 33-day-old success cycle (snapshot + metric + linked event),
      // a 33-day-old parse cycle (payload), a run exactly at the cutoff
      // (kept — the facade deletes strictly before), that kept run's
      // §12.1-dated older event (deleted on its own event_at), run-free
      // events exactly at and 1 ms before the cutoff, a parse cycle exactly
      // at the cutoff (run and payload both kept), and a fresh run.
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      const oldRunId = persistCollectionCycle(
        repository,
        successCycle({
          startedAt: cutoff - 2 * MS_PER_DAY,
          snapshot: {
            collectedAt: cutoff - 2 * MS_PER_DAY + 1_200,
            planName: 'Pro',
            metrics: [metricInput()],
            events: [eventInput({ eventAt: cutoff - 2 * MS_PER_DAY + 1_200 })],
          },
        }),
      );
      const oldParseRunId = persistCollectionCycle(
        repository,
        parseCycle({ startedAt: cutoff - 3 * MS_PER_DAY }),
      );
      const boundaryRunId = persistCollectionCycle(repository, successCycle({ startedAt: cutoff }));
      repository.insertQuotaEvent({
        ...eventInput({ eventAt: cutoff - 5 * MS_PER_DAY }),
        accountId: 'work',
        runId: boundaryRunId,
      });
      repository.insertQuotaEvent({
        ...eventInput({ eventAt: cutoff }),
        accountId: 'work',
        runId: null,
        details: {
          reason: 'boundary run-free event',
          previous: { collectedAt: T0, used: 90 },
          current: { collectedAt: cutoff, used: 10 },
        },
      });
      repository.insertQuotaEvent({
        ...eventInput({ eventAt: cutoff - 1 }),
        accountId: 'work',
        runId: null,
        details: {
          reason: 'expired run-free event',
          previous: { collectedAt: T0, used: 90 },
          current: { collectedAt: cutoff - 1, used: 10 },
        },
      });
      persistCollectionCycle(repository, parseCycle({ startedAt: cutoff }));
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));
      // personal: an expired run — cleanup is global, not per account.
      persistCollectionCycle(
        repository,
        successCycle({ accountId: 'personal', startedAt: cutoff - 10 * MS_PER_DAY }),
      );
      // sessions: expired 1 ms ago, exactly at now, and live.
      repository.insertSession({
        tokenHash: sessionHash('expired'),
        createdAt: NOW - 30 * MS_PER_DAY,
        lastSeenAt: NOW - 1 - 7 * MS_PER_DAY,
        expiresAt: NOW - 1,
      });
      repository.insertSession({
        tokenHash: sessionHash('boundary'),
        createdAt: NOW - 30 * MS_PER_DAY,
        lastSeenAt: NOW - 7 * MS_PER_DAY,
        expiresAt: NOW,
      });
      repository.insertSession({
        tokenHash: sessionHash('live'),
        createdAt: NOW - MS_PER_DAY,
        lastSeenAt: NOW,
        expiresAt: NOW + 6 * MS_PER_DAY,
      });
      repository.setMetaValue('ui:theme', 'dark');

      const report = cleanup(repository, database, { now: NOW, retentionDays });

      // Runs and their cascades: the 32-day and 33-day-old work cycles plus
      // personal's 40-day-old one. The old payloads went with their runs
      // (cascade), so the explicit raw count is zero — the kept boundary
      // payload is exactly at the §7.4 cutoff, not before it.
      expect(report.historyCutoff).toBe(cutoff);
      expect(report.rawResponseCutoff).toBe(NOW - RAW_RESPONSE_MAX_AGE_DAYS * MS_PER_DAY);
      expect(report.removed).toEqual({
        collectionRuns: 3,
        quotaEvents: 2,
        rawResponses: 0,
        sessions: 1,
      });
      expect(report.maintenance.autoVacuumMode).toBe('none');

      // Per-table post-state: everything expired is gone through its read
      // path, everything at-or-after its cutoff survives.
      expect(repository.listCollectionRuns('work')).toHaveLength(3);
      expect(repository.listCollectionRuns('personal')).toEqual([]);
      expect(repository.getSnapshotByRun(oldRunId)).toBe(null);
      expect(repository.getMetricValuesForRun(oldRunId)).toEqual([]);
      expect(repository.getRawResponseByRun(oldParseRunId)).toBe(null);
      expect(repository.getSnapshotByRun(boundaryRunId)).not.toBe(null);
      expect(repository.getMetricValuesForRun(boundaryRunId)).toHaveLength(1);
      // The kept run's §12.1-dated event expired on its own event_at; the
      // exactly-at-cutoff run-free event survives.
      expect(repository.listQuotaEvents('work')).toHaveLength(1);
      expect(repository.listQuotaEvents('work')[0]?.eventAt).toBe(cutoff);
      expect(repository.listRawResponses('work')).toHaveLength(1);
      expect(repository.getSession(sessionHash('expired'))).toBe(null);
      expect(repository.getSession(sessionHash('boundary'))).not.toBe(null);
      expect(repository.getSession(sessionHash('live'))).not.toBe(null);
      expect(repository.getMetaValue('ui:theme')).toBe('dark');
    });
  });

  it('treats the run as the retention unit: cascades take rows the run carries, whatever their own timestamps', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      // A run that started 1 ms before the cutoff and collected its
      // snapshot after it: expired by started_at, so its snapshot (collected
      // after the cutoff), metric, and linked event (event_at after the
      // cutoff) cascade away with it.
      const spanningRunId = persistCollectionCycle(
        repository,
        successCycle({
          startedAt: cutoff - 60_000,
          endedAt: cutoff + 60_000,
          snapshot: {
            collectedAt: cutoff + 60_000,
            planName: 'Pro',
            metrics: [metricInput()],
            events: [eventInput({ eventAt: cutoff + 120_000 })],
          },
        }),
      );
      // A parse cycle expired by age whose payload is young (5 days): the
      // run's cascade takes the payload even though the §7.4 window would
      // keep it — a payload cannot outlive its run.
      const youngPayloadRunId = persistCollectionCycle(
        repository,
        parseCycle({
          startedAt: cutoff - 5 * MS_PER_DAY,
          rawResponse: {
            capturedAt: NOW - 5 * MS_PER_DAY,
            httpStatus: 200,
            contentType: null,
            body: '',
          },
        }),
      );
      // Control: a run exactly at the cutoff keeps everything.
      const keptRunId = persistCollectionCycle(repository, successCycle({ startedAt: cutoff }));

      const report = cleanup(repository, database, { now: NOW, retentionDays });

      // Both expired runs went; the explicit event and raw counts are zero
      // because the cascades removed those rows before their own cutoff
      // deletes ran — the delete order this report documents.
      expect(report.removed).toEqual({
        collectionRuns: 2,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(repository.getSnapshotByRun(spanningRunId)).toBe(null);
      expect(repository.getMetricValuesForRun(spanningRunId)).toEqual([]);
      expect(repository.listQuotaEvents('work')).toEqual([]);
      expect(repository.getRawResponseByRun(youngPayloadRunId)).toBe(null);
      expect(repository.listRawResponses('work')).toEqual([]);
      expect(repository.getSnapshotByRun(keptRunId)).not.toBe(null);
    });
  });
});

/* ── The done-condition: startup and daily cleanup are safe to repeat ──── */

describe('retention cleanup — safe to repeat (task 091 done-condition, spec §11.3)', () => {
  it('an identical second run removes nothing and changes nothing', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      persistCollectionCycle(repository, successCycle({ startedAt: cutoff - 1 }));
      persistCollectionCycle(repository, successCycle({ startedAt: cutoff }));
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));
      repository.insertSession({
        tokenHash: sessionHash('live'),
        createdAt: NOW - MS_PER_DAY,
        lastSeenAt: NOW,
        expiresAt: NOW + 6 * MS_PER_DAY,
      });

      const first = cleanup(repository, database, { now: NOW, retentionDays });
      expect(first.removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });

      // The startup-and-daily repeat: same input, same connection, run
      // immediately again — zero removals, no error, identical state.
      const second = cleanup(repository, database, { now: NOW, retentionDays });
      expect(second.removed).toEqual({
        collectionRuns: 0,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(second.historyCutoff).toBe(first.historyCutoff);
      expect(repository.listCollectionRuns('work')).toHaveLength(2);
      expect(repository.getSession(sessionHash('live'))).not.toBe(null);
      // The cleanup metadata still describes the one cleanup that did work;
      // the repeat rewrote the same values.
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(String(NOW));
      expect(repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY)).toBe(String(retentionDays));
    });
  });

  it('a later run (the daily cadence) removes only the newly expired', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      const boundaryRunId = persistCollectionCycle(repository, successCycle({ startedAt: cutoff }));
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));

      cleanup(repository, database, { now: NOW, retentionDays });
      const nextDay = NOW + MS_PER_DAY;
      const second = cleanup(repository, database, { now: nextDay, retentionDays });

      // The boundary run is 31 days old now — expired at the daily run;
      // the 2-day-old run survives.
      expect(second.removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(second.historyCutoff).toBe(nextDay - retentionDays * MS_PER_DAY);
      expect(repository.getCollectionRun(boundaryRunId)).toBe(null);
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(String(nextDay));
    });
  });

  it('an earlier now (clock skew back) is a harmless no-op', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));

      const skewed = cleanup(repository, database, {
        now: NOW - 10 * MS_PER_DAY,
        retentionDays,
      });

      // The cutoff moved earlier than every row: nothing expires, nothing
      // throws, and the markers record exactly what was supplied.
      expect(skewed.removed).toEqual({
        collectionRuns: 0,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(String(NOW - 10 * MS_PER_DAY));
    });
  });
});

/* ── §7.4's raw window and §15.2's session expiry ─────────────────────── */

describe('retention cleanup — raw payloads and sessions follow their own rules (task 091, spec §7.4, §15.2)', () => {
  it('expires raw payloads at 30 days regardless of the history window', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      // Retention 90: the runs below survive the history window, so only
      // the §7.4 30-day window can touch their payloads.
      const retentionDays = 90;
      const oldPayloadRunId = persistCollectionCycle(
        repository,
        parseCycle({ startedAt: NOW - 40 * MS_PER_DAY }),
      );
      const boundaryPayloadRunId = persistCollectionCycle(
        repository,
        parseCycle({ startedAt: NOW - RAW_RESPONSE_MAX_AGE_DAYS * MS_PER_DAY }),
      );

      const report = cleanup(repository, database, { now: NOW, retentionDays });

      // The 40-day run survives (40 < 90) while its 40-day payload expires
      // (40 > 30); the payload captured exactly 30 days ago survives.
      expect(report.historyCutoff).toBe(NOW - 90 * MS_PER_DAY);
      expect(report.rawResponseCutoff).toBe(NOW - 30 * MS_PER_DAY);
      expect(report.removed).toEqual({
        collectionRuns: 0,
        quotaEvents: 0,
        rawResponses: 1,
        sessions: 0,
      });
      expect(repository.getCollectionRun(oldPayloadRunId)).not.toBe(null);
      expect(repository.getRawResponseByRun(oldPayloadRunId)).toBe(null);
      expect(repository.getRawResponseByRun(boundaryPayloadRunId)).not.toBe(null);
    });
  });

  it('expires sessions at their own expiry, independent of the history window', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      // Retention 7 (the §11.3 minimum): a 10-day-old run expires, while
      // sessions live and die by §15.2's expires_at alone.
      const retentionDays = 7;
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - 10 * MS_PER_DAY }));
      repository.insertSession({
        tokenHash: sessionHash('long-expired'),
        createdAt: NOW - 50 * MS_PER_DAY,
        lastSeenAt: NOW - 20 * MS_PER_DAY - 7 * MS_PER_DAY,
        expiresAt: NOW - 20 * MS_PER_DAY,
      });
      repository.insertSession({
        tokenHash: sessionHash('boundary'),
        createdAt: NOW - 30 * MS_PER_DAY,
        lastSeenAt: NOW - 7 * MS_PER_DAY,
        expiresAt: NOW,
      });
      repository.insertSession({
        tokenHash: sessionHash('live'),
        createdAt: NOW - 3_600_000,
        lastSeenAt: NOW,
        expiresAt: NOW + 3_600_000,
      });

      const report = cleanup(repository, database, { now: NOW, retentionDays });

      expect(report.removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 1,
      });
      expect(repository.getSession(sessionHash('long-expired'))).toBe(null);
      expect(repository.getSession(sessionHash('boundary'))).not.toBe(null);
      expect(repository.getSession(sessionHash('live'))).not.toBe(null);
    });
  });
});

/* ── §11.3 bounds: rejected before any delete runs ────────────────────── */

describe('retention cleanup — bounds and input validation (task 091, spec §11.3)', () => {
  it('rejects a retention window outside 7–3650 before deleting anything', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - 40 * MS_PER_DAY }));

      for (const retentionDays of [6, 3651, 180.5, Number.NaN]) {
        expect(() => cleanup(repository, database, { now: NOW, retentionDays })).toThrow(
          new RegExp(
            `runRetentionCleanup: retentionDays must be an integer between ` +
              `${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days \\(spec §11\\.3\\), got '${retentionDays}'`,
          ),
        );
      }
      expect(() => cleanup(repository, database, { now: Number.NaN, retentionDays: 30 })).toThrow(
        /runRetentionCleanup: now must be a finite epoch-milliseconds value, got 'NaN'/,
      );

      // Fail-fast means it: the 40-day-old run survived every rejected call,
      // and no cleanup metadata was written.
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(null);
      expect(repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY)).toBe(null);
    });
  });

  it('accepts the window bounds themselves', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const minimumRunId = persistCollectionCycle(
        repository,
        successCycle({ startedAt: NOW - 8 * MS_PER_DAY }),
      );

      // 7: legal — the 8-day-old run expires under the minimum window.
      expect(cleanup(repository, database, { now: NOW, retentionDays: 7 }).removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(repository.getCollectionRun(minimumRunId)).toBe(null);

      // 3650: legal, and a no-op on the rows that remain.
      expect(cleanup(repository, database, { now: NOW, retentionDays: 3650 }).removed).toEqual({
        collectionRuns: 0,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY)).toBe('3650');
    });
  });
});

/* ── §11.3 protections: accounts, configuration state, unrelated meta ─── */

describe('retention cleanup — protected data stays (task 091, spec §11.3)', () => {
  it('keeps account rows (active and archived) and unrelated meta, expires history regardless of account status', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      repository.insertAccount(account({ id: 'legacy', label: 'Legacy plan', planName: null }));
      repository.archiveAccount('legacy', T0 + MS_PER_DAY);
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      // Both accounts carry one expired and one fresh run: retention is a
      // history rule and applies to archived accounts' expired history too.
      persistCollectionCycle(repository, successCycle({ startedAt: cutoff - MS_PER_DAY }));
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));
      persistCollectionCycle(
        repository,
        successCycle({ accountId: 'legacy', startedAt: cutoff - MS_PER_DAY }),
      );
      persistCollectionCycle(
        repository,
        successCycle({ accountId: 'legacy', startedAt: NOW - MS_PER_DAY }),
      );
      repository.setMetaValue('service:unrelated', 'untouched');

      const accountsBefore = repository.listAccounts();
      cleanup(repository, database, { now: NOW, retentionDays });

      // The §7.3 current-state sources — account metadata — are identical,
      // and the §11.2 service state (meta) keeps every foreign key.
      expect(repository.listAccounts()).toEqual(accountsBefore);
      expect(repository.getAccount('work')?.status).toBe('active');
      expect(repository.getAccount('legacy')?.status).toBe('archived');
      expect(repository.getMetaValue('service:unrelated')).toBe('untouched');
      // History expired for both accounts alike; fresh history stays.
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
      expect(repository.listCollectionRuns('legacy')).toHaveLength(1);
    });
  });
});

/* ── The composed maintenance step (spec §11.3: "Then checkpoint WAL…") ── */

describe('retention cleanup — the post-cleanup maintenance step (task 091, spec §11.3)', () => {
  it('checkpoints the WAL through the composed maintenance call', async () => {
    await withCleanup((repository, database, connection) => {
      repository.insertAccount(account());
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - 40 * MS_PER_DAY }));
      persistCollectionCycle(repository, successCycle({ startedAt: NOW - MS_PER_DAY }));
      const walPath = `${connection.path}-wal`;
      expect(statSync(walPath).size).toBeGreaterThan(0);

      const report = cleanup(repository, database, { now: NOW, retentionDays: 30 });

      // The observable effect of the composed checkpoint: the WAL file the
      // cleanup's transaction grew was reset to zero bytes.
      expect(statSync(walPath).size).toBe(0);
      expect(report.maintenance.walCheckpoint.busy).toBe(false);
      expect(report.maintenance.autoVacuumMode).toBe('none');
    });
  });
});

/* ── Atomicity: deletes and markers commit together or not at all ─────── */

describe('retention cleanup — deletes and markers are one transaction (task 091, spec §11.3)', () => {
  it('rolls every delete back when the marker write fails, and the next run redoes it whole', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      const cutoff = NOW - retentionDays * MS_PER_DAY;
      persistCollectionCycle(repository, successCycle({ startedAt: cutoff - MS_PER_DAY }));
      repository.insertSession({
        tokenHash: sessionHash('expired'),
        createdAt: NOW - 30 * MS_PER_DAY,
        lastSeenAt: NOW - 1 - 7 * MS_PER_DAY,
        expiresAt: NOW - 1,
      });

      // A delegating proxy whose setMetaValue throws — the driver-level
      // fault injection pattern of test/integration/collection-cycles.spec.ts;
      // withTransaction is wrapped so the repository the callback receives
      // is proxied too.
      const failure = new Error('injected marker-write failure');
      const inject = (target: QuotaRepository): QuotaRepository =>
        new Proxy(target, {
          get(target, property) {
            if (property === 'setMetaValue') {
              return () => {
                throw failure;
              };
            }
            if (property === 'withTransaction') {
              return (work: (tx: QuotaRepository) => unknown) =>
                target.withTransaction((tx) => work(inject(tx)));
            }
            return Reflect.get(target, property, target);
          },
        });

      expect(() =>
        runRetentionCleanup(
          { repository: inject(repository), database },
          { now: NOW, retentionDays },
        ),
      ).toThrow('injected marker-write failure');

      // Nothing half-happened: the expired run and session survived, and no
      // marker claims a cleanup. The repeat (the next startup/daily run)
      // then does the whole cleanup in one go.
      expect(repository.listCollectionRuns('work')).toHaveLength(1);
      expect(repository.getSession(sessionHash('expired'))).not.toBe(null);
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(null);

      const retried = cleanup(repository, database, { now: NOW, retentionDays });
      expect(retried.removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 1,
      });
      expect(repository.getMetaValue(RETENTION_LAST_RUN_KEY)).toBe(String(NOW));
    });
  });
});

/* ── The exported horizon: one definition both sides consume (U-014) ──── */

describe('historyCutoff — the single §11.3 horizon definition (task U-014, decision D-091)', () => {
  it('is now minus retentionDays days, at the window bounds themselves', () => {
    // This spec's own MS_PER_DAY literal is an oracle independent of the
    // shared definition, so a corrupted DAY_MS or helper cannot pass
    // unnoticed — the test-side twin of D-091's single-siting.
    for (const retentionDays of [MIN_RETENTION_DAYS, 30, 180, MAX_RETENTION_DAYS]) {
      expect(historyCutoff(NOW, retentionDays)).toBe(NOW - retentionDays * MS_PER_DAY);
    }
  });

  it('drives the cleanup: the report cutoff is its value and the delete boundary is exactly there', async () => {
    await withCleanup((repository, database) => {
      repository.insertAccount(account());
      const retentionDays = 30;
      const cutoff = historyCutoff(NOW, retentionDays);
      // One run 1 ms before the helper's cutoff and one exactly at it: the
      // deletes are strict-before, so the boundary row survives — the same
      // day-boundary semantics the D-063/D-082 alignment tests prove.
      const expiredRunId = persistCollectionCycle(
        repository,
        successCycle({ startedAt: cutoff - 1 }),
      );
      const boundaryRunId = persistCollectionCycle(repository, successCycle({ startedAt: cutoff }));

      const report = cleanup(repository, database, { now: NOW, retentionDays });

      expect(report.historyCutoff).toBe(cutoff);
      expect(report.removed).toEqual({
        collectionRuns: 1,
        quotaEvents: 0,
        rawResponses: 0,
        sessions: 0,
      });
      expect(repository.getCollectionRun(expiredRunId)).toBe(null);
      expect(repository.getCollectionRun(boundaryRunId)).not.toBe(null);
    });
  });
});
