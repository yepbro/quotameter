/**
 * The §13 history and events endpoint contracts (task 161, spec §12, §13;
 * decision D-139).
 *
 * TypeBox definitions for the two range-bearing §13 routes — `GET
 * /api/history` (one account/metric series over a requested time range,
 * downsampled to the `maxPoints` budget with §12.2's gaps as explicit empty
 * points) and `GET /api/events` (the unified §12.2 timeline: reset events,
 * collection gaps, failed cycles, and stopped-service regions) — the schemas
 * the routes validate through and serialize through, and the ones task 163
 * generates OpenAPI from. Placement follows the layer rule of
 * `src/schemas/README.md`: pure contract data; the behavior lives in
 * `src/server/api/history.ts`.
 *
 * The timestamp rule (D-139, closing D-130's recorded loose end): §13's own
 * sentence makes the **request** `from`/`to` ISO 8601 UTC values — parsed by
 * the endpoint through `epochMsFromIso`, so an explicit offset or `Z` is
 * mandatory and offset-less strings are rejected — while every **response**
 * timestamp stays the epoch-millisecond integer of the landed §13 vocabulary
 * (D-128 accounts, D-130 status/quota). The response echoes the requested
 * and effective ranges as epoch-ms too: one format per direction, never a
 * mixed clock inside one body.
 *
 * Every response object is closed (`additionalProperties: false`), so the
 * compiled serializer emits exactly the declared keys (the D-111 health
 * guard, generalized across the §13 surface since D-128).
 */

import { type Static, Type } from '@sinclair/typebox';
import { LIMIT_TYPES, METRIC_UNITS } from '../metrics';
import { ID_PATTERN } from '../config';
import { ACCOUNT_ERROR_OUTCOMES } from './status';

/* ── Drift-pinned contract constants ────────────────────────────────────── */

/**
 * The wire kinds of one `GET /api/history` points-array entry: a raw series
 * point, an aggregated downsampling bucket (§13's max-points contract), or
 * the explicit empty point §12.2/§13 place between gap edges. Pinned by a
 * schema-suite row; the behavior module switches on the same literals.
 */
export const HISTORY_POINT_KINDS = Object.freeze(['point', 'bucket', 'empty'] as const);

/**
 * The wire kinds of one `GET /api/events` entry — §12.2's reset events and
 * collection gaps beside task 120's two indicator classes. Pinned by a
 * schema-suite row.
 */
export const EVENT_ITEM_KINDS = Object.freeze([
  'reset',
  'gap',
  'collection_error',
  'stopped_service',
] as const);

/**
 * The retention outcomes a range report can carry — task 123's
 * `RetentionBoundedRange` vocabulary on the wire (a schema-suite drift row
 * pins the two lists together).
 */
export const RETENTION_RANGE_OUTCOMES = Object.freeze(['ok', 'truncated', 'rejected'] as const);

/**
 * §13's `maxPoints` default for `GET /api/history`. Declared here as the
 * spec's own number (the schema layer is a leaf and cannot import the
 * services layer); a schema-suite drift row pins these three constants
 * against `src/services/history-downsample.ts`'s exported budget constants.
 */
export const HISTORY_MAX_POINTS_DEFAULT = 1500;

/** §13's smallest accepted `maxPoints`. */
export const HISTORY_MAX_POINTS_MIN = 100;

/** §13's largest accepted `maxPoints`. */
export const HISTORY_MAX_POINTS_MAX = 5000;

/* ── The retention range report (§13/§11.3, task 123's vocabulary) ─────── */

/**
 * What retention did to the requested range (§13: "Reject or explicitly
 * truncate requested ranges beyond retention and state that in the
 * response"). `outcome: 'rejected'` carries null effective bounds — nothing
 * is queryable — and the horizon that displaced them; `'truncated'` carries
 * the clamped bounds plus the horizon as the effective lower edge; `'ok'`
 * passes the request through with a null horizon. All timestamps are epoch-ms
 * integers (the parsed request included — the body never mixes formats).
 */
export const HistoryRangeReportSchema = Type.Object(
  {
    outcome: Type.Union(
      RETENTION_RANGE_OUTCOMES.map((outcome) => Type.Literal(outcome)),
      {
        description: 'What retention did to the requested range.',
      },
    ),
    /** The parsed `from` parameter, epoch ms. */
    requestedFrom: Type.Integer({ description: 'Requested range start (epoch ms).' }),
    /** The parsed `to` parameter, epoch ms. */
    requestedTo: Type.Integer({ description: 'Requested range end (epoch ms).' }),
    /** The lower bound actually queried; `null` when the range was rejected. */
    effectiveFrom: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Effective range start (epoch ms) or null when rejected.',
    }),
    /** The upper bound actually queried (retention never clamps `to`); null when rejected. */
    effectiveTo: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Effective range end (epoch ms) or null when rejected.',
    }),
    /** The retention horizon, epoch ms; `null` when the request needed no clamping. */
    retentionHorizon: Type.Union([Type.Integer(), Type.Null()], {
      description: 'The retention cutoff (epoch ms) or null when not binding.',
    }),
  },
  { additionalProperties: false },
);

/** The shape of both responses' `range` report. */
export type HistoryRangeReport = Static<typeof HistoryRangeReportSchema>;

/* ── GET /api/history — the series contract ────────────────────────────── */

/** The required `accountId`/`metric`/`from`/`to` plus the optional budget. */
export const HistoryQuerySchema = Type.Object(
  {
    accountId: Type.String({
      pattern: ID_PATTERN,
      minLength: 1,
      description: 'Stable account id.',
    }),
    metric: Type.String({ minLength: 1, description: 'Stable metric key.' }),
    /**
     * ISO 8601 UTC with an explicit offset or `Z` (§13); the strict parse
     * happens in the endpoint, which answers the VALIDATION envelope with a
     * `invalid-timestamp` reason and the offending parameter name.
     */
    from: Type.String({ minLength: 1, description: 'Range start, ISO 8601 UTC.' }),
    to: Type.String({ minLength: 1, description: 'Range end, ISO 8601 UTC.' }),
    /** §13's point budget; the default is applied by the validator. */
    maxPoints: Type.Integer({
      minimum: HISTORY_MAX_POINTS_MIN,
      maximum: HISTORY_MAX_POINTS_MAX,
      default: HISTORY_MAX_POINTS_DEFAULT,
      description: 'Downsampling budget (spec §13).',
    }),
  },
  { additionalProperties: false },
);

/** The parsed `GET /api/history` query (post-validation, defaults applied). */
export type HistoryQuery = Static<typeof HistoryQuerySchema>;

/**
 * The value vocabulary a point or a bucket endpoint carries: the §8.4
 * numeric fields as honest nulls (invalid rows store no values, D-010 —
 * never zero placeholders), the row's own reset declaration, and §8.4
 * per-point validity. `windowSeconds` and `derivedFields` stay off the
 * history wire: both are snapshot facts the §14.4 chart does not plot, and
 * the quota surface (`GET /api/quota`) already serves them per row. Declared
 * once and spread into the closed object schemas below, so a raw point and a
 * bucket's `first`/`last` endpoints cannot drift apart.
 */
const POINT_VALUE_FIELDS = {
  collectedAt: Type.Integer({ description: 'Collection time (epoch ms).' }),
  used: Type.Union([Type.Number(), Type.Null()], { description: 'Consumed amount or null.' }),
  remaining: Type.Union([Type.Number(), Type.Null()], {
    description: 'Remaining amount or null.',
  }),
  limit: Type.Union([Type.Number(), Type.Null()], { description: 'Total allowance or null.' }),
  percentUsed: Type.Union([Type.Number(), Type.Null()], {
    description: 'Percentage consumed or null.',
  }),
  percentRemaining: Type.Union([Type.Number(), Type.Null()], {
    description: 'Percentage remaining or null.',
  }),
  resetsAt: Type.Union([Type.Integer(), Type.Null()], {
    description: 'Next reset (epoch ms) or null.',
  }),
  isValid: Type.Boolean({ description: 'Whether the reading is valid.' }),
  invalidReason: Type.Union([Type.String(), Type.Null()], {
    description: 'Why the metric is invalid, or null.',
  }),
} as const;

/** A bucket's `first`/`last` endpoint — one observed point's full vocabulary. */
const PointValuesSchema = Type.Object({ ...POINT_VALUE_FIELDS }, { additionalProperties: false });

/** One unaggregated series point. */
export const HistoryPointSchema = Type.Object(
  {
    kind: Type.Literal('point', { description: 'A raw series point.' }),
    ...POINT_VALUE_FIELDS,
  },
  { additionalProperties: false },
);

/** The shape of one raw point entry. */
export type HistoryPoint = Static<typeof HistoryPointSchema>;

/**
 * The per-field extrema of one downsampling bucket (§13: "preserving each
 * bucket's minimum, maximum, first, and last points") — a field absent from
 * every member (invalid rows carry no values) reads as `null`.
 */
const BucketExtremaSchema = Type.Object(
  {
    used: Type.Union([Type.Number(), Type.Null()], { description: 'Member minimum or null.' }),
    remaining: Type.Union([Type.Number(), Type.Null()], {
      description: 'Member minimum or null.',
    }),
    percentUsed: Type.Union([Type.Number(), Type.Null()], {
      description: 'Member minimum or null.',
    }),
    percentRemaining: Type.Union([Type.Number(), Type.Null()], {
      description: 'Member minimum or null.',
    }),
  },
  { additionalProperties: false },
);

/** One aggregated time bucket of a downsampled series (§13, D-081). */
export const HistoryBucketSchema = Type.Object(
  {
    kind: Type.Literal('bucket', { description: 'An aggregated downsampling bucket.' }),
    /** The earliest member's `collectedAt` — an observed timestamp. */
    fromEpochMs: Type.Integer({ description: 'Bucket start (epoch ms).' }),
    /** The latest member's `collectedAt` — an observed timestamp. */
    toEpochMs: Type.Integer({ description: 'Bucket end (epoch ms).' }),
    /**
     * How many VALID series points the bucket aggregates (invalid rows
     * carry no values and are never members — they ride the downsampled
     * response as their own point entries between the buckets).
     */
    count: Type.Integer({ minimum: 1, description: 'Aggregated valid member count.' }),
    min: BucketExtremaSchema,
    max: BucketExtremaSchema,
    first: PointValuesSchema,
    last: PointValuesSchema,
  },
  { additionalProperties: false },
);

/** The shape of one bucket entry. */
export type HistoryBucket = Static<typeof HistoryBucketSchema>;

/**
 * §12.2/§13's explicit empty point: positioned between a gap's edges (the
 * interval midpoint) so the chart can break its line (`connectNulls: false`)
 * without interpolating values. Structurally distinct from an invalid
 * reading — an invalid point is real data, an empty point marks missing
 * collection.
 */
export const HistoryEmptyPointSchema = Type.Object(
  {
    kind: Type.Literal('empty', { description: 'An explicit empty point at a collection gap.' }),
    collectedAt: Type.Integer({ description: 'Gap midpoint (epoch ms).' }),
  },
  { additionalProperties: false },
);

/** The shape of one empty-point entry. */
export type HistoryEmptyPoint = Static<typeof HistoryEmptyPointSchema>;

/** One entry of the history `points` array — the `kind` discriminates. */
export const HistoryPointItemSchema = Type.Union(
  [HistoryPointSchema, HistoryBucketSchema, HistoryEmptyPointSchema],
  { description: 'A series point, bucket, or gap empty point.' },
);

/** The shape of one `points` array entry. */
export type HistoryPointItem = Static<typeof HistoryPointItemSchema>;

/**
 * The `GET /api/history` response: §13's series with unit, limit type, and
 * validity; the retention report; and the effective resolution of the
 * downsampling pass (§13: "Include the effective resolution in the
 * response"). `unit`/`limitType` are series-level — a metric key's identity
 * is adapter-owned and stable (§8.4) — taken from the newest in-range row
 * and honestly `null` for an empty series; an unknown metric key is an empty
 * series, not an error (the vocabulary lives with the provider, served
 * through `GET /api/providers`).
 */
export const HistoryResponseSchema = Type.Object(
  {
    accountId: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    metric: Type.String({ minLength: 1, description: 'Stable metric key.' }),
    /** The metric's unit (§8.4), or null when the series is empty. */
    unit: Type.Union([Type.Union(METRIC_UNITS.map((unit) => Type.Literal(unit))), Type.Null()], {
      description: 'Unit of the absolute values (spec §8.4) or null.',
    }),
    /** The metric's quota accounting regime (§8.4), or null when empty. */
    limitType: Type.Union(
      [Type.Union(LIMIT_TYPES.map((type) => Type.Literal(type))), Type.Null()],
      { description: 'Quota accounting regime (spec §8.4) or null.' },
    ),
    range: HistoryRangeReportSchema,
    /** Whether the series exceeded the `maxPoints` budget and was bucketed. */
    downsampled: Type.Boolean({ description: 'Whether the points are aggregated buckets.' }),
    /** The effective resolution (the widest allocated slice width), or null. */
    resolutionMs: Type.Union([Type.Number(), Type.Null()], {
      description:
        'Effective bucket resolution in ms (the widest allocated slice width — fractional by construction), or null when not downsampled.',
    }),
    /** How many series points the effective range holds (pre-aggregation). */
    sourcePointCount: Type.Integer({
      minimum: 0,
      description: 'Series points inside the effective range.',
    }),
    /** The series, chronological, with gap empty points spliced in. */
    points: Type.Array(HistoryPointItemSchema, { description: 'The series entries.' }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/history` serializes to. */
export type HistoryResponse = Static<typeof HistoryResponseSchema>;

/* ── GET /api/events — the unified §12.2 timeline ──────────────────────── */

/** The events query: `metric` optionally narrows the per-metric kinds. */
export const EventsQuerySchema = Type.Object(
  {
    accountId: Type.String({
      pattern: ID_PATTERN,
      minLength: 1,
      description: 'Stable account id.',
    }),
    from: Type.String({ minLength: 1, description: 'Range start, ISO 8601 UTC.' }),
    to: Type.String({ minLength: 1, description: 'Range end, ISO 8601 UTC.' }),
    /** When present, only this metric's resets and gaps are served. */
    metric: Type.Optional(
      Type.String({ minLength: 1, description: 'Optional metric key filter.' }),
    ),
  },
  { additionalProperties: false },
);

/** The parsed `GET /api/events` query. */
export type EventsQuery = Static<typeof EventsQuerySchema>;

/**
 * One §12.1 quota-reset event, served from the `quota_events` table with its
 * detection evidence verbatim (the D-046/D-074 `details` vocabulary — reason,
 * compared points, tolerances; metric data only, never secrets).
 */
export const ResetEventItemSchema = Type.Object(
  {
    kind: Type.Literal('reset', { description: 'A detected quota reset (spec §12.1).' }),
    metricKey: Type.String({ minLength: 1, description: 'The metric that reset.' }),
    eventAt: Type.Integer({ description: 'Event time (epoch ms).' }),
    /** The cycle whose snapshot evidenced the event, when stored; else null. */
    runId: Type.Union([Type.Integer(), Type.Null()], { description: 'Evidencing run id or null.' }),
    /** The D-046/D-074 evidence object, verbatim. */
    details: Type.Record(Type.String(), Type.Unknown(), {
      description: 'Detection evidence (spec §12.1).',
    }),
  },
  { additionalProperties: false },
);

/** The shape of one reset entry. */
export type ResetEventItem = Static<typeof ResetEventItemSchema>;

/** One §12.2 collection gap (task 119's `CollectionGap`, verbatim fields). */
export const GapEventItemSchema = Type.Object(
  {
    kind: Type.Literal('gap', { description: 'A collection gap (spec §12.2).' }),
    metricKey: Type.String({ minLength: 1, description: 'The gapped metric.' }),
    fromEpochMs: Type.Integer({ description: 'The earlier edge point (epoch ms).' }),
    toEpochMs: Type.Integer({ description: 'The later edge point (epoch ms).' }),
    elapsedMs: Type.Integer({ description: 'Edge-to-edge elapsed time.' }),
    /** The cadence the gap was judged by (D-075's span rule). */
    intervalSeconds: Type.Integer({ description: 'Effective polling interval in seconds.' }),
    /** The three-effective-interval threshold the elapsed time exceeded. */
    thresholdMs: Type.Integer({ description: 'The gap threshold in ms.' }),
  },
  { additionalProperties: false },
);

/** The shape of one gap entry. */
export type GapEventItem = Static<typeof GapEventItemSchema>;

/**
 * One failed collection cycle (task 120's `collection_error` indicator): the
 * §11.2 outcome class drives the distinct chart symbol, the evidence fills
 * the tooltip. `message` is the stored sanitized text (D-048) additionally
 * passed through the endpoint's exact-occurrence secret redaction (§7.4, the
 * D-130 `lastError` precedent).
 */
export const CollectionErrorEventItemSchema = Type.Object(
  {
    kind: Type.Literal('collection_error', {
      description: 'A failed collection cycle (spec §12.2).',
    }),
    outcome: Type.Union(
      ACCOUNT_ERROR_OUTCOMES.map((outcome) => Type.Literal(outcome)),
      {
        description: 'The run outcome class.',
      },
    ),
    /** The cycle's start — the marker position. */
    fromEpochMs: Type.Integer({ description: 'Cycle start (epoch ms).' }),
    toEpochMs: Type.Integer({ description: 'Cycle end (epoch ms).' }),
    durationMs: Type.Integer({ description: 'Cycle wall-clock duration.' }),
    /** The retained HTTP status, or null when no response arrived. */
    httpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()], {
      description: 'HTTP status or null.',
    }),
    /** The sanitized (and secret-redacted) error message; empty when none. */
    message: Type.String({ description: 'Sanitized error message.' }),
    /** §7.2's total attempt count for the cycle. */
    attempts: Type.Integer({ minimum: 1, description: 'Total attempts.' }),
    /** The deferred 429's `Retry-After` seconds, or null outside one. */
    retryAfterSeconds: Type.Union([Type.Integer({ minimum: 0, maximum: 3600 }), Type.Null()], {
      description: 'Retry-After seconds or null.',
    }),
  },
  { additionalProperties: false },
);

/** The shape of one failed-cycle entry. */
export type CollectionErrorEventItem = Static<typeof CollectionErrorEventItemSchema>;

/**
 * One maximal interval with no collection-run record at all — the hatched
 * "service was stopped" region (§12.2, task 120's `stopped_service`
 * indicator). Carries no outcome: nothing was collected here.
 */
export const StoppedServiceEventItemSchema = Type.Object(
  {
    kind: Type.Literal('stopped_service', {
      description: 'A no-collection-records region (spec §12.2).',
    }),
    fromEpochMs: Type.Integer({ description: 'Region start (epoch ms), clamped to the range.' }),
    toEpochMs: Type.Integer({ description: 'Region end (epoch ms), clamped to the range.' }),
    elapsedMs: Type.Integer({ description: 'Region duration.' }),
    /** The cadence the silence was judged by (D-080's boundary widening). */
    intervalSeconds: Type.Integer({ description: 'Effective polling interval in seconds.' }),
    /** The three-effective-interval threshold the silence exceeded. */
    thresholdMs: Type.Integer({ description: 'The stopped threshold in ms.' }),
  },
  { additionalProperties: false },
);

/** The shape of one stopped-service entry. */
export type StoppedServiceEventItem = Static<typeof StoppedServiceEventItemSchema>;

/** One entry of the events array — the `kind` discriminates the §12.2 classes. */
export const EventItemSchema = Type.Union(
  [
    ResetEventItemSchema,
    GapEventItemSchema,
    CollectionErrorEventItemSchema,
    StoppedServiceEventItemSchema,
  ],
  { description: 'One unified timeline entry.' },
);

/** The shape of one `events` array entry. */
export type EventItem = Static<typeof EventItemSchema>;

/**
 * The `GET /api/events` response: §13's "resets, gaps, and collection
 * failures by account/time/metric" as one time-ordered array (ascending by
 * each entry's instant, then kind, then metric key — deterministic), beside
 * the same retention report the history route states. `metric` echoes the
 * narrowing parameter (`null` = every metric).
 */
export const EventsResponseSchema = Type.Object(
  {
    accountId: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    /** The requested metric filter, or null when the response covers all. */
    metric: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: 'The metric filter or null.',
    }),
    range: HistoryRangeReportSchema,
    /** The unified timeline, time-ascending. */
    events: Type.Array(EventItemSchema, { description: 'The §12.2 timeline entries.' }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/events` serializes to. */
export type EventsResponse = Static<typeof EventsResponseSchema>;
