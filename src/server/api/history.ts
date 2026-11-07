/**
 * The §13 history and events endpoints (task 161, spec §12, §13, §11.3;
 * decision D-139).
 *
 * Two range-bearing read routes inside the `/api` scope: `GET /history`
 * (one account/metric series over a requested time range, retention-clamped,
 * downsampled to the `maxPoints` budget with §12.2's collection gaps spliced
 * in as explicit empty points) and `GET /events` (the unified §12.2
 * timeline: quota-reset events, collection gaps, failed collection cycles,
 * and stopped-service regions, one kind-discriminated time-ordered array).
 * Both are pure composition over the landed Stage-10/11 services — task
 * 119's `detectCollectionGaps` (D-075), task 120's
 * `buildTimelineIndicators` (D-080), task 121's `downsampleHistorySeries`
 * (D-081/D-090), and task 123's retention-aware reads (D-082) — nothing here
 * re-derives a gap, a reset, a bucket, or a retention bound.
 *
 * The timestamp rule (D-139, closing D-130's recorded loose end): §13's own
 * sentence makes the **request** `from`/`to` ISO 8601 UTC values, parsed
 * through `epochMsFromIso` so an explicit offset or `Z` is mandatory
 * (§10 — an offset-less string is exactly where an implicit zone would creep
 * in), while every **response** timestamp stays the epoch-millisecond
 * integer of the landed §13 vocabulary (D-128/D-130). Requested and
 * effective ranges echo as epoch-ms; one format per direction, never a
 * mixed clock inside one body.
 *
 * Retention beyond the horizon (§13/§11.3): a range entirely older than the
 * horizon answers `200` with the empty series plus the `rejected` report
 * (the horizon named), a partially older range is served truncated — the
 * D-082 open choice closed as "state that in the response" = the body
 * report, not the error envelope, so both arms share one response contract.
 *
 * The gap/stopped-service cadence evidence comes from one margin-widened
 * raw read of the account's collection runs (`EVIDENCE_MARGIN_MS` below):
 * the runs bounding the range edges anchor the edge silences (task 120's
 * documented consumption), every series point's own run stamps its cadence
 * (§12.2's "interval_s in effect", D-069's per-run column), and pre-horizon
 * rows are evidence only — the timeline module clamps regions to the range
 * and filters markers, so nothing out-of-policy is ever served. The raw
 * facade read is the sanctioned pattern: D-082 keeps the un-retentioned
 * reads for exactly these internal consumers.
 *
 * Error vocabulary stays inside D-113's registry (no new codes): malformed
 * or offset-less timestamps and `from > to` answer VALIDATION with stable
 * `details.reason` values (`invalid-timestamp` + the offending `param`,
 * `inverted-range`); an account unknown to both the configuration store and
 * the storage is NOT_FOUND (the D-128 both-halves verdict — an archived
 * account's retained history stays readable, §8.2); an unknown `metric` key
 * is an honest empty series, never an error (the metric vocabulary is
 * adapter-owned and served through `GET /api/providers`).
 *
 * Clock-skew tolerance (D-185): the schema deliberately permits skewed rows
 * (D-034 rejected an `ended_at >= started_at` CHECK — a rejected INSERT
 * would lose the run record), so these routes must not assume ordering the
 * database never promised. Both routes pass their raw evidence through
 * `history-skew.ts`'s rules before the fail-fast services see it: inverted
 * runs are projected to zero duration at their trusted `startedAt` for the
 * timeline-indicator walk (the record still bounds §12.2's record-based
 * stopped silence — dropping it could merge two legal neighbor silences
 * into a fabricated outage — and a failed cycle still marks), points
 * preceding the interval timeline's coverage are left unjudgeable by the
 * gap detector, and a skewed interval change is anchored at
 * `min(startedAt, endedAt)` inside `intervalTimelineFromRuns` so a
 * late-biased start stamp cannot tighten a straddling pair's judgment into
 * a false gap. The tolerances surface as one aggregated sanitized §16
 * `warn` per rule per account — never in the response body (the wire
 * contracts are unchanged).
 */

import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { AccountConfigStore, ManagedAccountConfig } from './accounts';
import { strictValidatorCompiler } from './validation';
import { ApiError } from './error';
import { redactSecretOccurrences } from './status';
import type {
  CollectionRunRecord,
  MetricValueRecord,
  QuotaEventRecord,
  QuotaRepository,
} from '../../storage/repository';
import {
  getMetricSeriesWithRetention,
  listQuotaEventsWithRetention,
  type RequestedHistoryRange,
  type RetentionBoundedRange,
  type RetentionWindow,
} from '../../storage/history-retention';
import type { CollectionGap, IntervalChange } from '../../services/history-gaps';
import { detectCollectionGaps } from '../../services/history-gaps';
import type { SkewDiagnostic } from '../../services/history-skew';
import {
  dropUnjudgeablePoints,
  mergeSkewDiagnostics,
  projectInvertedRuns,
} from '../../services/history-skew';
import type {
  CollectionErrorIndicator,
  CollectionRunInput,
  StoppedServiceIndicator,
  TimelineIndicator,
} from '../../services/history-timeline';
import { buildTimelineIndicators } from '../../services/history-timeline';
import type { BucketExtrema, MetricBucket } from '../../services/history-downsample';
import { downsampleHistorySeries } from '../../services/history-downsample';
import { epochMsFromIso } from '../../util/clock';
import {
  EventsQuerySchema,
  EventsResponseSchema,
  HistoryQuerySchema,
  HistoryResponseSchema,
  type EventsQuery,
  type EventsResponse,
  type EventItem,
  type CollectionErrorEventItem,
  type GapEventItem,
  type HistoryBucket,
  type HistoryEmptyPoint,
  type HistoryPoint,
  type HistoryPointItem,
  type HistoryQuery,
  type HistoryRangeReport,
  type HistoryResponse,
  type ResetEventItem,
  type StoppedServiceEventItem,
} from '../../schemas/api/history';

/* ── The injected seams (D-121: define at the consumer) ─────────────────── */

/** What the `/api` scope passes to {@link historyRoutes}. */
export interface HistoryRouteOptions {
  /** The configuration-side account store — 159's seam, the same instance. */
  readonly store: AccountConfigStore;
  /** The storage facade — series/event/run reads (D-058). */
  readonly repository: QuotaRepository;
  /**
   * The effective `app.historyRetentionDays` (§11.3's 7–3650 window), read
   * per request: the retention bound is §6.4-live (restart-requirement
   * false), so the composition hands over its live-config reader, not a
   * startup constant — the `pollingIntervalSeconds` precedent (D-130).
   */
  readonly historyRetentionDays: () => number;
  /** The clock the retention horizon is computed from (§11.1, D-021). */
  readonly now: () => number;
}

/* ── §13 range parsing (the ISO-param half of the D-139 rule) ──────────── */

/**
 * Parses one §13 range parameter into epoch ms. Anything `epochMsFromIso`
 * rejects — a missing offset, a bare date, a non-timestamp — answers the
 * VALIDATION envelope naming the offending parameter.
 */
export function parseEpochMsParam(raw: string, param: string): number {
  try {
    return epochMsFromIso(raw);
  } catch {
    throw new ApiError('VALIDATION', {
      message: `The '${param}' parameter must be an ISO 8601 UTC timestamp with an explicit offset or 'Z'`,
      details: { reason: 'invalid-timestamp', param },
    });
  }
}

/**
 * Parses and orders the §13 `from`/`to` pair. An inverted range is bad
 * input, not a retention outcome (the D-082 discipline), and answers
 * VALIDATION with the stable `inverted-range` reason; `from === to` is the
 * degenerate-but-ordered range and passes.
 */
export function parseRequestedRange(from: string, to: string): RequestedHistoryRange {
  const fromMs = parseEpochMsParam(from, 'from');
  const toMs = parseEpochMsParam(to, 'to');
  if (fromMs > toMs) {
    throw new ApiError('VALIDATION', {
      message: "The 'from' parameter must not be later than 'to'",
      details: { reason: 'inverted-range' },
    });
  }
  return { from: fromMs, to: toMs };
}

/**
 * The D-128 both-halves account verdict: an account known to neither the
 * configuration store nor the storage is the 404; an archived account (a
 * row without an entry) stays readable — §8.2 retains its history. Returns
 * the configured entry (null for storage-only accounts) so the caller can
 * resolve the redaction secret.
 */
async function requireKnownAccount(
  store: AccountConfigStore,
  repository: QuotaRepository,
  accountId: string,
): Promise<ManagedAccountConfig | null> {
  const managed = await store.find(accountId);
  if (managed === null && repository.getAccount(accountId) === null) {
    throw new ApiError('NOT_FOUND', { message: 'Account not found' });
  }
  return managed;
}

/* ── The runs-evidence read (§12.2 cadence stamps and edge anchors) ─────── */

/**
 * How far beyond the effective range the raw runs read extends, in ms: the
 * widest §12.2 silence judgment — `gapThresholdMs(3600)` = 3 × 1.1 ×
 * 3_600_000 = 11_880_000 — plus 300_000 for the §7.2 worst-case cycle span
 * (the scheduler's 255.5 s hang bound; a snapshot's `collectedAt` trails its
 * run's `startedAt` by at most one cycle). Within this margin: the runs
 * bounding the range edges decide the leading/trailing stopped-service
 * silences exactly (task 120's documented bounding-record consumption), and
 * every in-range series point's own run is present to stamp its cadence.
 */
export const EVIDENCE_MARGIN_MS = 12_180_000;

/**
 * The account's runs around the effective range — the raw facade read
 * (D-082 keeps the un-retentioned reads for internal consumers). Pre-horizon
 * rows never reach a response: the timeline module clamps its regions to
 * the range and filters its markers, and the gap detector consumes only the
 * in-policy series rows passed beside them.
 *
 * The review round's P1 fold: when the margin read finds nothing, the range
 * sits entirely inside a silence longer than the margin (an overnight
 * outage, a query into a months-old gap) — and §12.2's hatched region must
 * still render. Two bounded probes recover the bounding records wherever
 * they are: the nearest run at/after `effectiveTo` (`listCollectionRuns` is
 * `started_at`-ascending, so `{from, limit: 1}` is exactly the nearest),
 * and the account's latest run when it started at/before `effectiveFrom`
 * (then it IS the nearest before). Either bound alone expresses the
 * full-range downtime — the timeline module clamps the silence to the range
 * and judges it by the bounding record's own cadence.
 */
function evidenceRuns(
  repository: QuotaRepository,
  accountId: string,
  effectiveFrom: number,
  effectiveTo: number,
): ReadonlyArray<CollectionRunRecord> {
  const withinMargin = repository.listCollectionRuns(accountId, {
    from: effectiveFrom - EVIDENCE_MARGIN_MS,
    to: effectiveTo + EVIDENCE_MARGIN_MS,
  });
  if (withinMargin.length > 0) return withinMargin;
  const nearestAfter = repository.listCollectionRuns(accountId, { from: effectiveTo, limit: 1 });
  const latest = repository.getLatestCollectionRun(accountId);
  const nearestBefore = latest !== null && latest.startedAt <= effectiveFrom ? [latest] : [];
  return [...nearestBefore, ...nearestAfter];
}

/**
 * The §12.2 interval timeline from the run stamps: one change wherever the
 * per-run `interval_seconds` (D-069) shifts, effective from the shifting
 * run's start. Runs arrive in `started_at` order from the facade; the sort
 * makes the function order-independent. Equal start stamps keep the first
 * run's cadence — §7.1 never overlaps one account's cycles, and the guard
 * upholds the detector's unique-stamp contract on degenerate data.
 *
 * Clock-skewed change stamps (D-185): an inverted run's `startedAt` is the
 * pre-correction read and can sit later than the first snapshot collected
 * under the new cadence — trusting it would judge the straddling pairs by
 * the old, tighter cadence and mint false gaps (a 60→3600 grow with a
 * late-biased start is the mirror of the seeding case the gate rejects). A
 * change entry is therefore stamped at `min(startedAt, endedAt)`: for a
 * sound run that is exactly its start, and for an inverted one the
 * post-correction end read, which anchors the change no later than the
 * first new-cadence snapshot — the fail-safe direction of D-075's
 * span-widening (an earlier stamp only widens more pairs, never tightens).
 * The first entry keeps the raw `startedAt` even when inverted: it doubles
 * as the coverage bound Rule 2 drops pre-coverage points by, and moving it
 * earlier would seed judgment for points the evidence does not cover. The
 * output is sorted ascending — an extreme step-back can stamp a change
 * below an earlier entry's stamp — keeping the ascending-timeline contract
 * the gate and the detector rely on.
 */
export function intervalTimelineFromRuns(
  runs: ReadonlyArray<CollectionRunRecord>,
): IntervalChange[] {
  const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  const changes: IntervalChange[] = [];
  for (const run of ordered) {
    const previous = changes[changes.length - 1];
    if (previous === undefined) {
      changes.push({ effectiveFromEpochMs: run.startedAt, intervalSeconds: run.intervalSeconds });
      continue;
    }
    // The change's effective stamp: the fail-safe earlier bound (D-185).
    const effectiveFromEpochMs = Math.min(run.startedAt, run.endedAt);
    if (previous.effectiveFromEpochMs === effectiveFromEpochMs) continue;
    if (previous.intervalSeconds === run.intervalSeconds) continue;
    changes.push({ effectiveFromEpochMs, intervalSeconds: run.intervalSeconds });
  }
  return changes.sort((a, b) => a.effectiveFromEpochMs - b.effectiveFromEpochMs);
}

/** One `collection_runs` row as task 120's timeline input (§11.2 vocabulary). */
function timelineRunInput(run: CollectionRunRecord): CollectionRunInput {
  return {
    accountId: run.accountId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    intervalSeconds: run.intervalSeconds,
    outcome: run.outcome,
    attempts: run.attempts,
    httpStatus: run.httpStatus ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    retryAfterSeconds: run.retryAfterSeconds ?? undefined,
  };
}

/** The stable §16 message of every skew-tolerance diagnostic (D-185). */
const SKEW_TOLERATED_MESSAGE = 'clock-skewed history evidence tolerated';

/**
 * Emits the gate's §16 diagnostics as one aggregated `warn` per rule per
 * account — the level the default configuration surfaces (a skewed row is
 * a data-quality anomaly the operator should see; §16's request-logging
 * debug carve-out is about access logging, not data-quality reports). The
 * diagnostic objects are sanitized by construction (kind, account, count,
 * epoch-ms bounds), and the merge keeps a multi-metric skew from logging
 * one report per metric.
 */
function warnSkewDiagnostics(log: FastifyBaseLogger, diagnostics: readonly SkewDiagnostic[]): void {
  for (const diagnostic of mergeSkewDiagnostics(diagnostics)) {
    log.warn(diagnostic, SKEW_TOLERATED_MESSAGE);
  }
}

/* ── History wire views (§13 series, §12.2 empty points, D-081 buckets) ─── */

/**
 * One series row as the downsampler-facing point: the §8.4 numeric fields
 * ride as absent (not null) when the row stored none — D-090 validates a
 * carried field as a finite number — while the chart-irrelevant storage
 * keys drop away. Everything else (`limit`, `resetsAt`, validity) rides
 * along untouched: the downsampler returns the caller's own objects as
 * bucket `first`/`last`, so those fields survive aggregation for free.
 */
export interface HistoryPointInput {
  readonly collectedAt: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly percentUsed?: number;
  readonly percentRemaining?: number;
  readonly limit: number | null;
  readonly resetsAt: number | null;
  readonly isValid: boolean;
  readonly invalidReason: string | null;
}

/** Maps one `metric_values` row (§11.2) into the downsampler-facing point. */
export function historyPointInput(row: MetricValueRecord): HistoryPointInput {
  return {
    collectedAt: row.collectedAt,
    used: row.used ?? undefined,
    remaining: row.remaining ?? undefined,
    percentUsed: row.percentUsed ?? undefined,
    percentRemaining: row.percentRemaining ?? undefined,
    limit: row.limit,
    resetsAt: row.resetsAt,
    isValid: row.isValid,
    invalidReason: row.invalidReason,
  };
}

/**
 * The wire view of one point's value vocabulary — absent fields restore
 * their honest nulls (§7.2/§8.4: invalid rows carry no values, never zero
 * placeholders). Doubles as a bucket's `first`/`last` endpoint view (no
 * `kind`: the endpoint is not itself a points-array entry).
 */
function pointValuesView(point: HistoryPointInput): HistoryBucket['first'] {
  return {
    collectedAt: point.collectedAt,
    used: point.used ?? null,
    remaining: point.remaining ?? null,
    limit: point.limit,
    percentUsed: point.percentUsed ?? null,
    percentRemaining: point.percentRemaining ?? null,
    resetsAt: point.resetsAt,
    isValid: point.isValid,
    invalidReason: point.invalidReason,
  };
}

/** The wire view of one raw points-array entry: the discriminator plus the values. */
export function historyPointView(point: HistoryPointInput): HistoryPoint {
  return { kind: 'point', ...pointValuesView(point) };
}

/** The wire view of one bucket's per-field extrema (absent field → null). */
function bucketExtremaView(extrema: BucketExtrema): HistoryBucket['min'] {
  return {
    used: extrema.used ?? null,
    remaining: extrema.remaining ?? null,
    percentUsed: extrema.percentUsed ?? null,
    percentRemaining: extrema.percentRemaining ?? null,
  };
}

/** The wire view of one aggregated bucket (§13, D-081's preservation rules). */
export function historyBucketView(bucket: MetricBucket): HistoryBucket {
  return {
    kind: 'bucket',
    fromEpochMs: bucket.fromEpochMs,
    toEpochMs: bucket.toEpochMs,
    count: bucket.count,
    min: bucketExtremaView(bucket.min),
    max: bucketExtremaView(bucket.max),
    // The downsampler's `first`/`last` are this call's own HistoryPointInput
    // objects (D-081 returns the caller's references); the cast recovers the
    // type the generic DownsamplePoint signature erases.
    first: pointValuesView(bucket.first as HistoryPointInput),
    last: pointValuesView(bucket.last as HistoryPointInput),
  };
}

/** One gap's edges — the D-075 `CollectionGap` satisfies this verbatim. */
interface GapEdges {
  readonly fromEpochMs: number;
  readonly toEpochMs: number;
}

/**
 * §12.2/§13's explicit empty point for one gap: positioned at the interval
 * midpoint — strictly between the edges — so the chart breaks its line
 * (`connectNulls: false`) without interpolating values.
 */
export function emptyPointView(gap: GapEdges): HistoryEmptyPoint {
  return {
    kind: 'empty',
    collectedAt: gap.fromEpochMs + Math.floor((gap.toEpochMs - gap.fromEpochMs) / 2),
  };
}

/**
 * Splices the empty points into a chronological entry list. The flush rule
 * (the review round's P1 fold): an empty point rides at its gap's midpoint
 * and is emitted before the first entry that starts at or after it AND
 * strictly after the gap's start — the midpoint ordering keeps the array
 * timestamp-ascending even when invalid point entries sit inside the gap's
 * interval (their timestamps may exceed the midpoint), and the strict
 * gap-start guard keeps the degenerate 1 ms gap (midpoint == start edge)
 * from emitting its empty point ahead of the pre-edge entry itself. A
 * passthrough point or a bucket whose observed edges are the gap's own edge
 * points (D-081 never aggregates across a gap) anchors each side; gaps with
 * no post-edge entry cannot occur inside the effective range (the detector
 * emits gaps only between observed points), so the walk needs no trailing
 * flush.
 */
export function mergeEmptyPoints(
  items: ReadonlyArray<HistoryPoint | HistoryBucket>,
  gaps: ReadonlyArray<GapEdges>,
): HistoryPointItem[] {
  const merged: HistoryPointItem[] = [];
  let gapIndex = 0;
  for (const item of items) {
    const itemAt = item.kind === 'point' ? item.collectedAt : item.fromEpochMs;
    while (gapIndex < gaps.length) {
      const empty = emptyPointView(gaps[gapIndex]!);
      if (empty.collectedAt > itemAt || gaps[gapIndex]!.fromEpochMs >= itemAt) break;
      merged.push(empty);
      gapIndex++;
    }
    merged.push(item);
  }
  return merged;
}

/**
 * Re-inserts the invalid rows' point entries into a bucketed series,
 * chronologically by entry start (the review round's P1 fold): invalid rows
 * are never downsampler members (§13 aggregates values, and a null-valued
 * row contributes none — D-081's precondition that gap edges be adjacent
 * input points holds only without them), but they are real series data and
 * render as their own point entries. Each lands before the first bucket
 * that starts strictly after it; a bucket spanning the entry's timestamp
 * keeps its position (the entry rides beside it at its own instant).
 */
export function insertInvalidPointItems(
  items: ReadonlyArray<HistoryPoint | HistoryBucket>,
  invalidPoints: ReadonlyArray<HistoryPoint>,
): Array<HistoryPoint | HistoryBucket> {
  const out: Array<HistoryPoint | HistoryBucket> = [];
  let index = 0;
  for (const extra of invalidPoints) {
    // Invalid points arrive `collected_at`-ascending from the facade read.
    while (index < items.length) {
      const item = items[index]!;
      const itemAt = item.kind === 'point' ? item.collectedAt : item.fromEpochMs;
      if (itemAt > extra.collectedAt) break;
      out.push(item);
      index++;
    }
    out.push(extra);
  }
  out.push(...items.slice(index));
  return out;
}

/** The wire report of one retention verdict (task 123's vocabulary, §13). */
export function rangeReportOf(bounded: RetentionBoundedRange): HistoryRangeReport {
  if (bounded.outcome === 'rejected') {
    return {
      outcome: 'rejected',
      requestedFrom: bounded.requestedFrom,
      requestedTo: bounded.requestedTo,
      effectiveFrom: null,
      effectiveTo: null,
      retentionHorizon: bounded.horizon,
    };
  }
  if (bounded.outcome === 'truncated') {
    return {
      outcome: 'truncated',
      // Retention never clamps `to` (D-082): the requested and effective
      // upper bounds are the same instant.
      requestedFrom: bounded.requestedFrom,
      requestedTo: bounded.effectiveTo,
      effectiveFrom: bounded.effectiveFrom,
      effectiveTo: bounded.effectiveTo,
      retentionHorizon: bounded.effectiveFrom,
    };
  }
  // The 'ok' variant carries no separate request echo — the effective bounds
  // ARE the request (D-082: "the effective bounds are the requested bounds").
  return {
    outcome: 'ok',
    requestedFrom: bounded.effectiveFrom,
    requestedTo: bounded.effectiveTo,
    effectiveFrom: bounded.effectiveFrom,
    effectiveTo: bounded.effectiveTo,
    retentionHorizon: null,
  };
}

/* ── Events wire views (the unified §12.2 timeline) ─────────────────────── */

/** One stored `quota_events` row as the wire reset item (evidence verbatim). */
export function resetEventItemView(record: QuotaEventRecord): ResetEventItem {
  return {
    kind: 'reset',
    metricKey: record.metricKey,
    eventAt: record.eventAt,
    runId: record.runId,
    details: record.details,
  };
}

/** One detected gap (D-075) as the wire gap item. */
export function gapEventItemView(gap: CollectionGap): GapEventItem {
  return {
    kind: 'gap',
    metricKey: gap.metricKey,
    fromEpochMs: gap.fromEpochMs,
    toEpochMs: gap.toEpochMs,
    elapsedMs: gap.elapsedMs,
    intervalSeconds: gap.intervalSeconds,
    thresholdMs: gap.thresholdMs,
  };
}

/**
 * One failed cycle (task 120's class-a indicator) as the wire error item:
 * the sanitized message passes the same §7.4 exact-occurrence redaction as
 * the status surface's `lastError` (D-130 — a contract-violating provider
 * residual renders `[REDACTED]`, never the secret).
 */
export function collectionErrorItemView(
  indicator: CollectionErrorIndicator,
  secret: string | null,
): CollectionErrorEventItem {
  return {
    kind: 'collection_error',
    outcome: indicator.outcome,
    fromEpochMs: indicator.fromEpochMs,
    toEpochMs: indicator.toEpochMs,
    durationMs: indicator.durationMs,
    httpStatus: indicator.httpStatus ?? null,
    message: redactSecretOccurrences(indicator.errorMessage ?? '', secret),
    attempts: indicator.attempts,
    retryAfterSeconds: indicator.retryAfterSeconds ?? null,
  };
}

/** One stopped-service region (task 120's class-b indicator) as the wire item. */
export function stoppedServiceItemView(
  indicator: StoppedServiceIndicator,
): StoppedServiceEventItem {
  return {
    kind: 'stopped_service',
    fromEpochMs: indicator.fromEpochMs,
    toEpochMs: indicator.toEpochMs,
    elapsedMs: indicator.elapsedMs,
    intervalSeconds: indicator.intervalSeconds,
    thresholdMs: indicator.thresholdMs,
  };
}

/** The deterministic tie-break order of same-instant entries (frozen). */
const EVENT_KIND_RANK: Readonly<Record<EventItem['kind'], number>> = Object.freeze({
  reset: 0,
  gap: 1,
  collection_error: 2,
  stopped_service: 3,
});

/** The instant one entry is positioned at on the unified timeline. */
function eventInstant(item: EventItem): number {
  return item.kind === 'reset' ? item.eventAt : item.fromEpochMs;
}

/**
 * Orders the unified timeline: instant-ascending, then the frozen kind rank,
 * then the metric key (reset/gap carry one; the account-level classes tie
 * empty and keep their already-deterministic input order under the stable
 * sort — the timeline module emits indicators chronologically).
 */
export function sortEventItems(items: EventItem[]): EventItem[] {
  return items.sort((a, b) => {
    const byInstant = eventInstant(a) - eventInstant(b);
    if (byInstant !== 0) return byInstant;
    const byKind = EVENT_KIND_RANK[a.kind] - EVENT_KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    const aKey = a.kind === 'reset' || a.kind === 'gap' ? a.metricKey : '';
    const bKey = b.kind === 'reset' || b.kind === 'gap' ? b.metricKey : '';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return 0;
  });
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers the two §13 history-family routes inside the `/api` scope. The
 * scope's three guards (Origin, custom-header/content-type, §15.1 auth-mode)
 * apply to everything here by fastify's hook encapsulation — neither route
 * is public, and both are GETs, so the mutation-header rules bind nothing.
 */
export const historyRoutes: FastifyPluginAsync<HistoryRouteOptions> = async (fastify, options) => {
  const { store, repository, historyRetentionDays, now } = options;

  // Strict schema validation, scoped to these routes (D-128's single
  // construction site in ./validation.ts): unknown or malformed request
  // fields answer the VALIDATION envelope instead of being silently
  // stripped, and the query's `maxPoints` default is applied here.
  fastify.setValidatorCompiler(strictValidatorCompiler());

  fastify.get(
    '/history',
    {
      schema: {
        querystring: HistoryQuerySchema,
        response: { 200: HistoryResponseSchema },
      },
    },
    async (request, reply) => {
      const query = request.query as HistoryQuery;
      // The §13 parameters first (cheap, no I/O): a malformed or inverted
      // range is a client mistake whatever it targets.
      const requested = parseRequestedRange(query.from, query.to);
      await requireKnownAccount(store, repository, query.accountId);
      const window: RetentionWindow = { now: now(), retentionDays: historyRetentionDays() };

      const read = getMetricSeriesWithRetention(
        repository,
        query.accountId,
        query.metric,
        requested,
        window,
      );
      const range = rangeReportOf(read.range);
      if (read.range.outcome === 'rejected') {
        // D-139: the out-of-retention arm is the 200-with-report — nothing
        // is queryable, and the response says so with the horizon.
        reply.header('cache-control', 'no-store');
        const body: HistoryResponse = {
          accountId: query.accountId,
          metric: query.metric,
          unit: null,
          limitType: null,
          range,
          downsampled: false,
          resolutionMs: null,
          sourcePointCount: 0,
          points: [],
        };
        return body;
      }

      const runs = evidenceRuns(
        repository,
        query.accountId,
        read.range.effectiveFrom,
        read.range.effectiveTo,
      );
      const timeline = intervalTimelineFromRuns(runs);
      // §12.2 gaps live between adjacent successful snapshots' VALID points
      // (D-075's caller contract). D-185 first leaves pre-coverage points
      // unjudgeable — a skewed snapshot stamped before its own run's start
      // has no cadence in effect to be judged by, and a pointless detector
      // call on an empty judgeable set (no points, all unjudgeable, or an
      // empty interval timeline) would trip the detector's tripwires for
      // nothing.
      const validRows = read.rows.filter((row) => row.isValid);
      const validPoints = validRows.map((row) => ({
        accountId: row.accountId,
        metricKey: row.metricKey,
        collectedAt: row.collectedAt,
      }));
      const judged = dropUnjudgeablePoints(validPoints, timeline, query.accountId);
      warnSkewDiagnostics(request.log, judged.diagnostics);
      const gaps = judged.points.length === 0 ? [] : detectCollectionGaps(judged.points, timeline);

      // The reset boundaries ride as data (D-081's contract — never
      // recomputed): the stored §12.1 events of this series in range.
      const resetEvents = listQuotaEventsWithRetention(
        repository,
        query.accountId,
        requested,
        window,
        query.metric,
      )
        .rows.filter((event) => event.eventType === 'RESET')
        .map((event) => ({ eventAt: event.eventAt }));

      // The downsampler aggregates the VALID points only (the review round's
      // P1 fold): invalid rows carry no values, and D-081's gap-boundary
      // split presupposes the detector's adjacent-points precondition — an
      // invalid row inside a gap would glue the edges into one segment and
      // aggregate across the silence §13 forbids losing. The invalid rows
      // re-enter the downsampled response as their own point entries
      // (`insertInvalidPointItems`); the at-or-under-budget passthrough
      // renders every row directly.
      const result = downsampleHistorySeries(validRows.map(historyPointInput), query.maxPoints, {
        resetEvents,
        gaps,
      });
      let seriesItems: Array<HistoryPoint | HistoryBucket>;
      if (result.kind === 'passthrough') {
        seriesItems = read.rows.map((row) => historyPointView(historyPointInput(row)));
      } else {
        const invalidPointItems = read.rows
          .filter((row) => !row.isValid)
          .map((row) => historyPointView(historyPointInput(row)));
        seriesItems = insertInvalidPointItems(
          result.buckets.map(historyBucketView),
          invalidPointItems,
        );
      }

      // Series identity from the newest in-range row (rows arrive
      // `collected_at`-ascending); an empty series answers honest nulls.
      const newest = read.rows[read.rows.length - 1];
      reply.header('cache-control', 'no-store');
      const body: HistoryResponse = {
        accountId: query.accountId,
        metric: query.metric,
        unit: newest?.unit ?? null,
        limitType: newest?.limitType ?? null,
        range,
        downsampled: result.kind === 'downsampled',
        resolutionMs: result.resolutionMs,
        sourcePointCount: read.rows.length,
        points: mergeEmptyPoints(seriesItems, gaps),
      };
      return body;
    },
  );

  fastify.get(
    '/events',
    {
      schema: {
        querystring: EventsQuerySchema,
        response: { 200: EventsResponseSchema },
      },
    },
    async (request, reply) => {
      const query = request.query as EventsQuery;
      const requested = parseRequestedRange(query.from, query.to);
      const managed = await requireKnownAccount(store, repository, query.accountId);
      const window: RetentionWindow = { now: now(), retentionDays: historyRetentionDays() };

      const eventsRead = listQuotaEventsWithRetention(
        repository,
        query.accountId,
        requested,
        window,
        query.metric,
      );
      const range = rangeReportOf(eventsRead.range);
      if (eventsRead.range.outcome === 'rejected') {
        reply.header('cache-control', 'no-store');
        const body: EventsResponse = {
          accountId: query.accountId,
          metric: query.metric ?? null,
          range,
          events: [],
        };
        return body;
      }

      // One margin-widened runs read feeds both §12.2 halves: the timeline
      // indicators (edge silences anchored by the bounding records) and the
      // interval timeline the gap detector judges by. D-185: the interval
      // timeline keeps every run (an inverted row's cadence stamp is
      // evidence, its change anchored at the fail-safe earlier bound), while
      // the indicator walk projects inverted runs to zero duration at their
      // trusted start — the record still bounds §12.2's record-based
      // stopped silence and a failed cycle still marks, but the unreliable
      // `endedAt` read never positions anything.
      const runs = evidenceRuns(
        repository,
        query.accountId,
        eventsRead.range.effectiveFrom,
        eventsRead.range.effectiveTo,
      );
      const timeline = intervalTimelineFromRuns(runs);
      const tolerated = projectInvertedRuns(runs, query.accountId);
      const indicators: ReadonlyArray<TimelineIndicator> = buildTimelineIndicators(
        tolerated.runs.map(timelineRunInput),
        { from: eventsRead.range.effectiveFrom, to: eventsRead.range.effectiveTo },
      );

      const items: EventItem[] = eventsRead.rows
        .filter((event) => event.eventType === 'RESET')
        .map(resetEventItemView);

      // The per-metric gap half: without a `metric` filter, the metric keys
      // with any valid reading (the last-valid query's key set — a metric
      // with valid points in range necessarily has one) enumerate exactly
      // the series that can hold gaps. The D-185 diagnostics of every
      // metric accumulate into ONE merged §16 warn per rule per account
      // after the loop (a skewed snapshot under a three-metric account logs
      // one report, not three).
      const skewDiagnostics: SkewDiagnostic[] = [...tolerated.diagnostics];
      const metricKeys =
        query.metric !== undefined
          ? [query.metric]
          : [
              ...new Set(
                repository.getLatestValidMetricValues(query.accountId).map((row) => row.metricKey),
              ),
            ];
      for (const metricKey of metricKeys) {
        const seriesRead = getMetricSeriesWithRetention(
          repository,
          query.accountId,
          metricKey,
          requested,
          window,
        );
        const validPoints = seriesRead.rows
          .filter((row) => row.isValid)
          .map((row) => ({
            accountId: row.accountId,
            metricKey: row.metricKey,
            collectedAt: row.collectedAt,
          }));
        // D-185: pre-coverage points are unjudgeable (no cadence in effect
        // to judge by) — dropped from detection with a diagnostic, never a
        // throw; the judgeable rest is exactly what the detector sees.
        const judged = dropUnjudgeablePoints(validPoints, timeline, query.accountId);
        skewDiagnostics.push(...judged.diagnostics);
        if (judged.points.length === 0) continue;
        for (const gap of detectCollectionGaps(judged.points, timeline)) {
          items.push(gapEventItemView(gap));
        }
      }
      warnSkewDiagnostics(request.log, skewDiagnostics);

      // The failed-cycle messages get the status surface's §7.4 redaction
      // (D-130): the resolved secret feeds the comparison, never the wire.
      const resolvedKey =
        managed?.keyConfigured === true ? await store.secretOf(query.accountId) : null;
      for (const indicator of indicators) {
        items.push(
          indicator.kind === 'collection_error'
            ? collectionErrorItemView(indicator, resolvedKey)
            : stoppedServiceItemView(indicator),
        );
      }

      reply.header('cache-control', 'no-store');
      const body: EventsResponse = {
        accountId: query.accountId,
        metric: query.metric ?? null,
        range,
        events: sortEventItems(items),
      };
      return body;
    },
  );
};
