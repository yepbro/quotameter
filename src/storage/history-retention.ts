/**
 * Retention-aware history queries — §13's range sentence over the query side
 * of §11.3 (task 123, decision D-082).
 *
 * Spec §13: "`from` and `to` are required ISO 8601 UTC values for history,
 * events, and peak-hours. Reject or explicitly truncate requested ranges
 * beyond retention and state that in the response." This module is that rule
 * at the storage boundary: given a requested epoch-ms range and a retention
 * window, it computes the **effective** range retention leaves queryable and
 * reports what happened to the request, then serves the history reads §13's
 * range-bearing endpoints draw from — already clamped. The deletion side of
 * §11.3 is task 091's `retention-cleanup.ts` (D-063); this is its query-side
 * twin, and with the same window the two describe the same retained set.
 *
 * Pinned interpretations (D-082):
 *
 * - **A sibling storage module, not facade methods** — the fifth application
 *   of the D-060/D-061/D-063/D-067 pattern. D-058's facade is the
 *   config-agnostic per-table surface; retention bounds are configuration
 *   policy (`app.historyRetentionDays`, D-014/D-022) that would force a
 *   window argument onto every `getMetricSeries` caller — including the
 *   consumers that legitimately read raw series (118's reset detection,
 *   119's gap detection, 091's cleanup). The existing reads stay unclamped
 *   (pinned by test); no new SQL exists — the wrappers delegate to facade
 *   methods whose index service is already query-plan-proven (D-058/D-077).
 * - **The window is caller-supplied and validated before any read** (the
 *   D-021/D-063 discipline): `now` and `retentionDays` arrive as explicit
 *   arguments — the future API layer derives them from the injectable clock
 *   and the loaded configuration — and §11.3's 7–3650 bounds are enforced
 *   here (reusing D-063's constants), because a range about a query
 *   parameter is policy no schema CHECK can express. A rejected input reads
 *   nothing.
 * - **Three outcomes, `rejected` among them is data, not a throw** — a range
 *   entirely older than the horizon cannot match any row the next cleanup
 *   will leave, so the read returns empty rows with the outcome and bounds
 *   the §13 layer states in its response; whether that becomes an HTTP
 *   error or an empty-series notice is the API layer's choice, kept open by
 *   the spec's own "reject **or** explicitly truncate". A partially older
 *   range is truncated to `[horizon, to]` with the requested `from`
 *   reported; a range inside retention passes through unchanged.
 * - **Only the lower bound clamps** — retention is a rule about old data;
 *   `to` passes through untouched (a future `to` is not retention's
 *   concern, and §10's rolling ranges legitimately end at `now`).
 * - **The bounds share the landed reads' closed-interval convention**
 *   (`collected_at >= from AND … <= to`, D-068) — not the half-open
 *   intervals of D-073's peak-hours timeline, a different surface. The
 *   horizon arithmetic is identical to D-063's `historyCutoff`
 *   (`now − retentionDays` days), and the deletes there are strict-before,
 *   so `[horizon, ∞)` is exactly the set of timestamps cleanup leaves —
 *   the effective range returns precisely what retention retains within
 *   the request, down to a row collected exactly at the horizon. Each read
 *   bounds **its own** time column (series `collected_at`, events
 *   `event_at`, runs `started_at`); the one shape where that diverges from
 *   the delete side — a run started before the horizon whose snapshot
 *   collected at or after it — is a divergence bounded by one run's
 *   duration around the horizon, served until the cleanup deletes its run
 *   (pinned by test, not papered over with a join the D-039
 *   denormalization exists to avoid).
 * - **Enforcement is independent of cleanup timing** — rows older than the
 *   horizon are never returned through this seam even while they still sit
 *   in the database between daily cleanups; out-of-policy data is not
 *   queryable through history reads, it is merely not yet deleted.
 */

import { DAY_MS } from '../util/rolling-ranges';
import type {
  CollectionRunRecord,
  MetricValueRecord,
  QuotaEventRecord,
  QuotaRepository,
  RunOutcome,
} from './repository';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from './retention-cleanup';

/* ── Inputs ────────────────────────────────────────────────────────────── */

/**
 * The retention window a range is bounded by — the query-side twin of D-063's
 * `RetentionCleanupInput`. `now` and `retentionDays` are writer-supplied
 * (D-021): the caller derives them from the injectable clock and the loaded
 * configuration's `app.historyRetentionDays`; storage stays config-agnostic.
 */
export interface RetentionWindow {
  /** §11.1 epoch milliseconds the horizon is computed from. */
  readonly now: number;
  /** The history retention window in days, 7–3650 (spec §11.3). */
  readonly retentionDays: number;
}

/**
 * A requested history range: §13's `from`/`to` as inclusive epoch-millisecond
 * bounds — the closed-interval convention of the landed reads (D-068), which
 * the effective bounds keep.
 */
export interface RequestedHistoryRange {
  /** Inclusive lower bound. */
  readonly from: number;
  /** Inclusive upper bound. */
  readonly to: number;
}

/* ── The bounded-range report ──────────────────────────────────────────── */

/**
 * What retention did to a requested history range — a discriminated union on
 * `outcome` so each variant carries exactly what its consumer states in a
 * §13 response and nonsense states (a rejected range with effective bounds,
 * an untruncated range echoing its request) are unrepresentable.
 */
export type RetentionBoundedRange =
  /**
   * The requested range lies entirely at or after the horizon: the effective
   * bounds are the requested bounds, nothing to report.
   */
  | {
      readonly outcome: 'ok';
      readonly effectiveFrom: number;
      readonly effectiveTo: number;
    }
  /**
   * The range's older part precedes the horizon: queries run over
   * `[effectiveFrom, effectiveTo]` — `effectiveFrom` **is** the horizon —
   * and `requestedFrom` names what was cut, so the response can state both.
   */
  | {
      readonly outcome: 'truncated';
      readonly effectiveFrom: number;
      readonly effectiveTo: number;
      readonly requestedFrom: number;
    }
  /**
   * The entire range precedes the horizon: nothing is queryable (the rows
   * there, if any remain undeleted, are out of policy). Carries the horizon
   * and the requested bounds so the response can say why and what retention
   * would cover.
   */
  | {
      readonly outcome: 'rejected';
      readonly horizon: number;
      readonly requestedFrom: number;
      readonly requestedTo: number;
    };

/* ── The clamp ─────────────────────────────────────────────────────────── */

/**
 * Bounds a requested history range to the retention window and reports the
 * outcome (§13). Pure epoch-ms arithmetic on caller-supplied time (D-021) —
 * no database access, no clock. Throws before anything is read when the
 * window violates §11.3 (a non-integer day count or one outside 7–3650) or
 * the request is malformed (a non-finite `now`/`from`/`to`, or `from > to` —
 * an inverted range is bad input, not a retention outcome).
 */
export function boundHistoryRange(
  requested: RequestedHistoryRange,
  window: RetentionWindow,
): RetentionBoundedRange {
  const { from, to } = requested;
  const { now, retentionDays } = window;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new Error(
      `boundHistoryRange: retentionDays must be an integer between ` +
        `${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days (spec §11.3), got '${retentionDays}'`,
    );
  }
  if (!Number.isFinite(now)) {
    throw new Error(
      `boundHistoryRange: now must be a finite epoch-milliseconds value, got '${now}'`,
    );
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error(
      `boundHistoryRange: from and to must be finite epoch-milliseconds values, ` +
        `got from '${from}', to '${to}'`,
    );
  }
  if (from > to) {
    throw new Error(
      `boundHistoryRange: requested range is inverted (from > to), ` +
        `got from '${from}', to '${to}'`,
    );
  }

  // D-063's historyCutoff arithmetic, exactly: the deletes are strict-before,
  // so every timestamp >= horizon survives cleanup and nothing below does.
  const horizon = now - retentionDays * DAY_MS;

  if (to < horizon) {
    return Object.freeze({
      outcome: 'rejected',
      horizon,
      requestedFrom: from,
      requestedTo: to,
    });
  }
  if (from < horizon) {
    return Object.freeze({
      outcome: 'truncated',
      effectiveFrom: horizon,
      effectiveTo: to,
      requestedFrom: from,
    });
  }
  return Object.freeze({ outcome: 'ok', effectiveFrom: from, effectiveTo: to });
}

/* ── Retention-aware reads ─────────────────────────────────────────────── */

/**
 * One retention-aware history read: the bounded range (the report §13 states
 * in the response) plus the rows inside the effective bounds — an empty
 * array whenever the outcome is `'rejected'`.
 */
export interface RetentionAwareRead<T> {
  readonly range: RetentionBoundedRange;
  readonly rows: ReadonlyArray<T>;
}

/** Serves `read` over the effective bounds; a rejected range reads nothing. */
function readWithinBounds<T>(
  range: RetentionBoundedRange,
  read: (from: number, to: number) => ReadonlyArray<T>,
): RetentionAwareRead<T> {
  // Frozen like the range itself (the D-068 discipline): one policy for
  // every report-shaped object leaving this module.
  if (range.outcome === 'rejected') {
    return Object.freeze({ range, rows: [] });
  }
  return Object.freeze({ range, rows: read(range.effectiveFrom, range.effectiveTo) });
}

/**
 * The §13 `/api/history` series source, retention-aware: one account/metric
 * series read over the effective range (the §11.2 series index serves it,
 * D-058), with the bounded-range report beside the rows.
 */
export function getMetricSeriesWithRetention(
  repository: QuotaRepository,
  accountId: string,
  metricKey: string,
  requested: RequestedHistoryRange,
  window: RetentionWindow,
): RetentionAwareRead<MetricValueRecord> {
  return readWithinBounds(boundHistoryRange(requested, window), (from, to) =>
    repository.getMetricSeries(accountId, metricKey, { from, to }),
  );
}

/**
 * The §13 `/api/events` events source, retention-aware: the account's quota
 * events over the effective range, optionally narrowed to one metric key
 * (the facade filter passes through unchanged).
 */
export function listQuotaEventsWithRetention(
  repository: QuotaRepository,
  accountId: string,
  requested: RequestedHistoryRange,
  window: RetentionWindow,
  metricKey?: string,
): RetentionAwareRead<QuotaEventRecord> {
  return readWithinBounds(boundHistoryRange(requested, window), (from, to) =>
    repository.listQuotaEvents(accountId, { from, to, metricKey }),
  );
}

/**
 * The §12.2 timeline source behind §13 `/api/events`, retention-aware: the
 * account's collection runs over the effective range, optionally narrowed to
 * one outcome (the facade filter passes through unchanged).
 */
export function listCollectionRunsWithRetention(
  repository: QuotaRepository,
  accountId: string,
  requested: RequestedHistoryRange,
  window: RetentionWindow,
  outcome?: RunOutcome,
): RetentionAwareRead<CollectionRunRecord> {
  return readWithinBounds(boundHistoryRange(requested, window), (from, to) =>
    repository.listCollectionRuns(accountId, { from, to, outcome }),
  );
}
