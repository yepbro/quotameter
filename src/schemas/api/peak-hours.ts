/**
 * The §13 peak-hours endpoint contracts (task 162, spec §9.3, §13; decision
 * D-142).
 *
 * TypeBox definitions for `GET /api/peak-hours` — §13's "UTC peak/off-peak
 * intervals for `accountId`, `from`, `to`": the timeline task 114's
 * `PeakHoursService` calculation half produces (D-073), served over the
 * wire. The schemas the route validates through and serializes through, and
 * the ones task 163 generates OpenAPI from. Placement follows the layer rule
 * of `src/schemas/README.md`: pure contract data; the behavior lives in
 * `src/server/api/peak-hours.ts`.
 *
 * The timestamp rule (D-139, inherited as §13's third named consumer): the
 * **request** `from`/`to` are ISO 8601 UTC values — parsed by the endpoint
 * through `epochMsFromIso`, so an explicit offset or `Z` is mandatory — while
 * every **response** timestamp is the epoch-millisecond integer of the landed
 * §13 vocabulary. The interval boundaries' local times are the
 * `yyyy-MM-ddTHH:mm` strings D-073's timeline already renders in the schedule
 * zone (§9.3: "local time in the schedule time zone"); the browser renders
 * them verbatim and never calculates windows independently.
 *
 * Every response object is closed (`additionalProperties: false`), so the
 * compiled serializer emits exactly the declared keys (the D-111 health
 * guard, generalized across the §13 surface since D-128).
 */

import { type Static, Type } from '@sinclair/typebox';
import { ID_PATTERN } from '../config';
import { HistoryRangeReportSchema } from './history';

/* ── Drift-pinned contract constants ────────────────────────────────────── */

/**
 * The wire kinds of one `GET /api/peak-hours` intervals entry: a peak window
 * occurrence or the off-peak complement between them (D-073's partition —
 * the two kinds cover the whole effective range, adjacent and disjoint).
 * Pinned by a schema-suite row; the behavior module switches on the same
 * literals.
 */
export const PEAK_HOURS_INTERVAL_KINDS = Object.freeze(['peak', 'off-peak'] as const);

/**
 * D-073's local-time rendering: both interval boundaries as
 * `yyyy-MM-ddTHH:mm` in the schedule zone (the day belongs in the string
 * because off-peak stretches span days). The year allows more than four
 * digits so the pattern never rejects a rendering the timeline can legally
 * produce; the retention and span bounds keep practical years four-digit.
 */
export const LOCAL_TIME_PATTERN = '^\\d{4,}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$';

/* ── GET /api/peak-hours — the timeline contract ───────────────────────── */

/** The required `accountId`/`from`/`to` query (§13's route row). */
export const PeakHoursQuerySchema = Type.Object(
  {
    accountId: Type.String({
      pattern: ID_PATTERN,
      minLength: 1,
      description: 'Stable account id.',
    }),
    /**
     * ISO 8601 UTC with an explicit offset or `Z` (§13); the strict parse
     * happens in the endpoint, which answers the VALIDATION envelope with a
     * `invalid-timestamp` reason and the offending parameter name (D-139).
     */
    from: Type.String({ minLength: 1, description: 'Range start, ISO 8601 UTC.' }),
    to: Type.String({ minLength: 1, description: 'Range end, ISO 8601 UTC.' }),
  },
  { additionalProperties: false },
);

/** The parsed `GET /api/peak-hours` query. */
export type PeakHoursQuery = Static<typeof PeakHoursQuerySchema>;

/**
 * One peak interval: a window occurrence clipped to the effective range
 * (D-073/D-079), carrying §9.3's output requirements — the exact UTC
 * boundaries as epoch-ms integers, the window's id/name and multiplier, and
 * both boundaries read back in the schedule zone.
 */
export const PeakIntervalSchema = Type.Object(
  {
    kind: Type.Literal('peak', { description: 'A peak window occurrence.' }),
    /** Interval start, UTC epoch milliseconds; inclusive (half-open, D-073). */
    start: Type.Integer({ description: 'Interval start (epoch ms).' }),
    /** Interval end, UTC epoch milliseconds; exclusive. */
    end: Type.Integer({ description: 'Interval end (epoch ms).' }),
    /** The window's credit-rate multiplier (§9.1). */
    multiplier: Type.Number({ exclusiveMinimum: 0, description: 'Window multiplier.' }),
    /** The window's stable id (§9.2). */
    windowId: Type.String({ minLength: 1, description: 'Window id.' }),
    /** The window's human-readable name (§9.3). */
    name: Type.String({ description: 'Window name.' }),
    /** `start` read in the schedule zone (D-073's format). */
    localStart: Type.String({ pattern: LOCAL_TIME_PATTERN, description: 'Local start time.' }),
    /** `end` read in the schedule zone. */
    localEnd: Type.String({ pattern: LOCAL_TIME_PATTERN, description: 'Local end time.' }),
  },
  { additionalProperties: false },
);

/** The shape of one peak entry. */
export type PeakIntervalItem = Static<typeof PeakIntervalSchema>;

/**
 * One off-peak interval: a stretch of the effective range covered by no
 * window — the complement of the peak occurrences (D-073's partition).
 */
export const OffPeakIntervalSchema = Type.Object(
  {
    kind: Type.Literal('off-peak', { description: 'The off-peak complement.' }),
    start: Type.Integer({ description: 'Interval start (epoch ms).' }),
    end: Type.Integer({ description: 'Interval end (epoch ms).' }),
    /** The schedule's `offPeakMultiplier` (§9.2). */
    multiplier: Type.Number({ exclusiveMinimum: 0, description: 'Off-peak multiplier.' }),
    localStart: Type.String({ pattern: LOCAL_TIME_PATTERN, description: 'Local start time.' }),
    localEnd: Type.String({ pattern: LOCAL_TIME_PATTERN, description: 'Local end time.' }),
  },
  { additionalProperties: false },
);

/** The shape of one off-peak entry. */
export type OffPeakIntervalItem = Static<typeof OffPeakIntervalSchema>;

/** One entry of the intervals array — the `kind` discriminates (D-073). */
export const PeakHoursIntervalSchema = Type.Union([PeakIntervalSchema, OffPeakIntervalSchema], {
  description: 'One peak or off-peak interval.',
});

/** The shape of one `intervals` array entry. */
export type PeakHoursIntervalItem = Static<typeof PeakHoursIntervalSchema>;

/**
 * The `GET /api/peak-hours` response: the account and the provider whose
 * schedule answered, the schedule's own facts, the retention range report
 * (the D-139 200-with-report, shared verbatim with the history/events
 * family), and the intervals partitioning the effective range.
 *
 * The no-schedule arm (§9.2, never an invented schedule): an account whose
 * provider has no `providers.<id>` entry answers `timezone: null` /
 * `offPeakMultiplier: null` with empty intervals — the same "not configured"
 * fact `/api/providers` states as `peakHours: null`. A configured schedule
 * with empty windows is NOT this arm: it computes normally (the whole range
 * one off-peak interval, §9.2's own shape for an unverified schedule).
 */
export const PeakHoursResponseSchema = Type.Object(
  {
    accountId: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    /** The provider whose schedule answered (the account's own provider). */
    providerId: Type.String({ minLength: 1, description: 'Provider adapter id.' }),
    /** The schedule zone, or null when no schedule is configured. */
    timezone: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: 'Schedule IANA time zone or null.',
    }),
    /** The off-peak multiplier, or null when no schedule is configured. */
    offPeakMultiplier: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()], {
      description: 'Off-peak multiplier or null.',
    }),
    /** What retention did to the requested range (D-139's shared report). */
    range: HistoryRangeReportSchema,
    /**
     * The intervals of the effective range, chronological — empty when the
     * range was rejected (nothing is computable out of retention) or when
     * no schedule is configured.
     */
    intervals: Type.Array(PeakHoursIntervalSchema, { description: 'The §9.3 timeline.' }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/peak-hours` serializes to. */
export type PeakHoursResponse = Static<typeof PeakHoursResponseSchema>;
