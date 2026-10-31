import { describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../../src/schemas/metrics';
import { detectCycleResetEvents } from '../../src/services/events-cycle';
import type { MetricValueRecord, QuotaRepository } from '../../src/storage/repository';

/**
 * The mapping edges of the §12.1 storage seam (task 118, decision D-078):
 * how stored rows and snapshot metrics become the detector's points — SQL
 * `NULL`s turn into absent optional fields, trailing invalid rows are
 * walked back past, invalid metrics of the new snapshot are never read
 * for, and an out-of-order snapshot is suppressed by the detector's own
 * chronology guard rather than crashing the seam. The detection rule
 * itself is task 117's matrix and the end-to-end persistence proof is
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
function seriesRepository(rows: ReadonlyArray<MetricValueRecord>): {
  readonly repository: QuotaRepository;
  /** The `${accountId}/${metricKey}` lookups performed, in order. */
  readonly reads: string[];
} {
  const reads: string[] = [];
  const repository = {
    getMetricSeries: (accountId: string, metricKey: string): MetricValueRecord[] => {
      reads.push(`${accountId}/${metricKey}`);
      return rows
        .filter((row) => row.accountId === accountId && row.metricKey === metricKey)
        .sort((a, b) => a.collectedAt - b.collectedAt || a.runId - b.runId); // the facade's contract
    },
  } as unknown as QuotaRepository;
  return { repository, reads };
}

describe('detectCycleResetEvents', () => {
  it('maps SQL NULLs to absent optional fields of the comparison base', () => {
    const { repository } = seriesRepository([storedRow()]);

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

  it('walks back past trailing invalid rows to the last valid point', () => {
    const { repository } = seriesRepository([
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

  it('suppresses an out-of-order snapshot instead of throwing', () => {
    // The stored tail is NEWER than the incoming snapshot: the detector's
    // chronology guard (D-074) turns that into conservative silence.
    const { repository } = seriesRepository([storedRow({ collectedAt: T1 + 60_000 })]);

    const events = detectCycleResetEvents(repository, 'acct', resetSnapshot(T1));

    expect(events).toHaveLength(0);
  });

  it('skips invalid metrics of the new snapshot entirely — no read, no event', () => {
    // The series holds a valid point for this very key: an invalid new
    // reading still never reaches the comparison (§12.1) — nor the read.
    const { repository, reads } = seriesRepository([storedRow()]);

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
    const { repository, reads } = seriesRepository([storedRow()]);

    const events = detectCycleResetEvents(repository, 'acct', {
      ...resetSnapshot(T1),
      metrics: [],
    });

    expect(events).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});
