import { describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../../src/schemas/metrics';
import { detectCycleResetEvents } from '../../src/services/events-cycle';
import type { MetricValueRecord, QuotaRepository } from '../../src/storage/repository';

/**
 * The mapping edges of the §12.1 storage seam (task 118, decision D-078;
 * read swap D-083): how stored rows and snapshot metrics become the
 * detector's points — SQL `NULL`s turn into absent optional fields, the
 * latest-valid read skips invalid rows and resolves recency by collection
 * stamp, invalid metrics of the new snapshot are never read for, and an
 * out-of-order snapshot is suppressed by the detector's own chronology
 * guard rather than crashing the seam. The detection rule itself is task
 * 117's matrix and the end-to-end persistence proof is
 * `test/integration/events-cycle.spec.ts`; this suite pins the seam's own
 * behavior over a recording fake of the one repository read it uses.
 */

/** Deterministic timestamps: snapshots five minutes apart unless stated. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 300_000;

/** A stored `metric_values` row (§11.2) of the default daily series. */
function storedRow(overrides: Partial<MetricValueRecord> = {}): MetricValueRecord {
  return {
    accountId: 'acct',
    runId: 7,
    collectedAt: T0,
    metricKey: 'daily-requests',
    limitType: 'DAILY',
    unit: 'REQUESTS',
    windowSeconds: null,
    used: 90,
    remaining: 10,
    limit: 100,
    percentUsed: 90,
    percentRemaining: 10,
    resetsAt: null,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    ...overrides,
  };
}

/** A snapshot whose single daily metric dropped to near-zero usage. */
function resetSnapshot(collectedAt: number): ProviderSnapshot {
  return {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: 'Pro',
    metrics: [
      {
        key: 'daily-requests',
        label: 'Daily requests',
        limitType: 'DAILY',
        unit: 'REQUESTS',
        used: 5,
        remaining: 95,
        limit: 100,
        percentUsed: 5,
        percentRemaining: 95,
        isValid: true,
      },
    ],
  };
}

/** A facade stand-in serving exactly the read the seam uses. */
function latestValidRepository(rows: ReadonlyArray<MetricValueRecord>): {
  readonly repository: QuotaRepository;
  /** The account-level latest-valid reads performed, in order. */
  readonly reads: string[];
} {
  const reads: string[] = [];
  const repository = {
    // The facade's contract (D-077): per metric key, the valid row with
    // the greatest (collectedAt, runId) — collection stamp first, never
    // arrival order — returned metric_key-ascending.
    getLatestValidMetricValues: (accountId: string): MetricValueRecord[] => {
      reads.push(accountId);
      const newest = new Map<string, MetricValueRecord>();
      for (const row of rows) {
        if (row.accountId !== accountId || !row.isValid) continue;
        const held = newest.get(row.metricKey);
        if (
          held === undefined ||
          row.collectedAt > held.collectedAt ||
          (row.collectedAt === held.collectedAt && row.runId > held.runId)
        ) {
          newest.set(row.metricKey, row);
        }
      }
      return [...newest.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, row]) => row);
    },
  } as unknown as QuotaRepository;
  return { repository, reads };
}

describe('detectCycleResetEvents', () => {
  it('maps SQL NULLs to absent optional fields of the comparison base', () => {
    const { repository } = latestValidRepository([storedRow()]);

    const events = detectCycleResetEvents(repository, 'acct', resetSnapshot(T1));

    expect(events).toHaveLength(1);
    // No declared resetsAt anywhere: §12.1 stamps the new collection time.
    expect(events[0]?.eventAt).toBe(T1);
    expect(events[0]?.details.eventTimeSource).toBe('current_collected_at');
    expect(events[0]?.details.previous).toEqual({
      runId: 7,
      collectedAt: T0,
      used: 90,
      remaining: 10,
      percentUsed: 90,
      percentRemaining: 10,
    });
  });

  it('skips trailing invalid rows — the base is the last valid point', () => {
    const { repository } = latestValidRepository([
      storedRow(),
      storedRow({
        runId: 8,
        collectedAt: T0 + 60_000,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: null,
        percentRemaining: null,
        isValid: false,
        invalidReason: 'provider reported no usage data',
      }),
    ]);

    const events = detectCycleResetEvents(repository, 'acct', resetSnapshot(T1));

    expect(events).toHaveLength(1);
    expect(events[0]?.details.previous).toMatchObject({ runId: 7, collectedAt: T0 });
  });

  it('resolves recency by collection stamp, never by arrival (D-083)', () => {
    // A later-arriving run (higher runId) carrying an OLDER stamp: the
    // latest-valid read's `(collected_at, run_id)` ordering — the same
    // selection D-078's full-series walk-back made — keeps the newer
    // stamp's point as the base, so the ordering reconciliation between
    // D-078's prose and D-077's SQL is pinned where the seam consumes it.
    const { repository } = latestValidRepository([
      storedRow({ runId: 9, collectedAt: T0 - 60_000, used: 42 }),
      storedRow({ runId: 7, collectedAt: T0 }),
    ]);

    const events = detectCycleResetEvents(repository, 'acct', resetSnapshot(T1));

    expect(events).toHaveLength(1);
    expect(events[0]?.details.previous).toMatchObject({ runId: 7, collectedAt: T0 });
  });

  it('suppresses an out-of-order snapshot instead of throwing', () => {
    // The stored tail is NEWER than the incoming snapshot: the detector's
    // chronology guard (D-074) turns that into conservative silence.
    const { repository } = latestValidRepository([storedRow({ collectedAt: T1 + 60_000 })]);

    const events = detectCycleResetEvents(repository, 'acct', resetSnapshot(T1));

    expect(events).toHaveLength(0);
  });

  it('skips invalid metrics of the new snapshot entirely — no read, no event', () => {
    // The series holds a valid point for this very key: an invalid new
    // reading still never reaches the comparison (§12.1) — nor the read.
    const { repository, reads } = latestValidRepository([storedRow()]);

    const events = detectCycleResetEvents(repository, 'acct', {
      ...resetSnapshot(T1),
      metrics: [
        {
          key: 'daily-requests',
          label: 'Daily requests',
          limitType: 'DAILY',
          unit: 'REQUESTS',
          isValid: false,
          invalidReason: 'provider reported no usage data',
        },
      ],
    });

    expect(events).toHaveLength(0);
    expect(reads).toEqual([]); // the invalid metric never reaches the series read
  });

  it('reads nothing for a zero-metric snapshot', () => {
    const { repository, reads } = latestValidRepository([storedRow()]);

    const events = detectCycleResetEvents(repository, 'acct', {
      ...resetSnapshot(T1),
      metrics: [],
    });

    expect(events).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  it('serves every metric of the snapshot from one account-level read (D-083)', () => {
    // Two valid metrics — one with a stored base, one new to the series —
    // must share a single latest-valid read: one read per cycle is the
    // documented contract, not one per metric (the cost this task removed).
    const { repository, reads } = latestValidRepository([storedRow()]);

    const events = detectCycleResetEvents(repository, 'acct', {
      ...resetSnapshot(T1),
      metrics: [
        ...resetSnapshot(T1).metrics,
        {
          key: 'five-hour-credits',
          label: 'Five-hour credits',
          limitType: 'ROLLING_WINDOW',
          unit: 'CREDITS',
          windowSeconds: 18_000,
          percentUsed: 80,
          percentRemaining: 20,
          isValid: true,
        },
      ],
    });

    expect(reads).toEqual(['acct']);
    // Only the metric with a stored base fired — the map-less sibling is a
    // first point and yields nothing, from the same shared read.
    expect(events).toHaveLength(1);
    expect(events[0]?.metricKey).toBe('daily-requests');
  });
});
