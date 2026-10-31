/**
 * Conservative quota-reset-event detection (spec §12.1; task 117, decision
 * D-074).
 *
 * A pure service: consecutive valid §8.4 metric points in, detected `RESET`
 * events out — no storage, no clock (every timestamp is data on the points).
 * Task 118 persists the output: `ResetEvent` is structurally identical to
 * `CycleEventInput` (`Omit<NewQuotaEvent, 'accountId' | 'runId'>` in
 * `src/storage/collection-cycles.ts`), so the success write of
 * `polling-persist.ts` can carry the events as-is, and `details` speaks the
 * D-046 writer vocabulary (`reason`, `previous`, `current`, `tolerance`,
 * `eventTimeSource`) the `quota_events` CHECKs and the repository encode.
 *
 * ## The algorithm
 *
 * `detectResetEvent(previous, current)` compares one new valid point against
 * the previous **valid** point of the same account and metric series
 * (§12.1) and returns at most one event ("record a RESET event when either
 * condition is met" — one comparison, one event, whichever conditions
 * fired):
 *
 * 1. **Value condition.** The reset hypothesis predicts a movement direction
 *    for every quota field — usage (`used`, `percentUsed`) falls, remaining
 *    (`remaining`, `percentRemaining`) rises. The condition fires when at
 *    least one carried field moved beyond its rounding tolerance in the
 *    predicted direction **and no carried field moved beyond its tolerance
 *    against the prediction**: one field contradicting the hypothesis — its
 *    own signal's pair or the other signal's, e.g. `remaining` falling while
 *    `used` falls, which is a limit re-statement, not a replenishment —
 *    makes the evidence ambiguous, and ambiguous evidence records nothing.
 *    Which predicted movements were observed becomes the reason's
 *    `usage_decreased` / `remaining_increased` codes. Absent fields and
 *    `NaN` comparisons do not participate.
 * 2. **Declaration condition.** The previous point's declared `resetsAt` has
 *    passed (`previous.resetsAt <= current.collectedAt`) and the new point
 *    reports a strictly later `resetsAt`. Equal, earlier, missing, or
 *    not-yet-passed declarations do not fire.
 *
 * **Event time.** When the previous point's `resetsAt` lies between the two
 * snapshots (`previous.collectedAt < resetsAt <= current.collectedAt`) the
 * event is stamped with it (`eventTimeSource: 'previous_resets_at'`);
 * otherwise with the new snapshot's collection time
 * (`'current_collected_at'` — covering absent declarations and stale ones
 * that had already passed before the previous snapshot).
 *
 * ## The conservative approach (rolling windows)
 *
 * A rolling window's quota replenishes gradually, so between two samples the
 * reported usage can drop — and remaining rise — by any amount, down to a
 * full drop when a burst exits the window, with no reset having occurred.
 * Value evidence is therefore **inadmissible on its own** for
 * `ROLLING_WINDOW` metrics: condition 1 never fires for them, and only the
 * declaration condition (the provider's own statement that the previous
 * window expired and a new one exists) records an event, with
 * `rolling_window_conservative` appended to the reason so the exception is
 * visible in the stored evidence. This is the task's done-condition:
 * ambiguous rolling-window transitions generate no events.
 *
 * Fixed-period quotas (`DAILY`, `WEEKLY`, `MONTHLY`, `OTHER`) do not
 * replenish, so either condition fires independently.
 *
 * ## Suppressions and failure modes
 *
 * Caller-contract violations fail fast with a `TypeError` (the D-048 rule):
 * an invalid point reaching the pair comparison, or two points of different
 * accounts or metric keys. Data ambiguity — not caller bugs — records
 * nothing: an out-of-order pair (`previous.collectedAt >
 * current.collectedAt`), and a series redefinition between the points
 * (`limitType` or `unit` changed — the values are not comparable across
 * accounting regimes).
 *
 * Inputs are §8.4-invariant by contract (the boundary check in
 * `src/schemas/metrics.ts` and the storage columns already exclude non-finite
 * values), so finiteness is not re-checked; a `NaN` that somehow arrives
 * compares false everywhere and stays conservative silence.
 *
 * `detectSeriesResetEvents` folds a flat, interleaved list of points (any
 * accounts, metrics, validity): each (account, metric) pair is its own
 * series, and invalid points are skipped entirely — neither compared nor
 * made the comparison base (§12.1 "invalid points do not participate").
 * Points of one series are processed in input order; chronology within a
 * series is the caller's contract (both real sources — history reads and
 * snapshot arrival — are chronological), so disorder degrades to a missing
 * event, never a false one.
 */

import type { LimitType, MetricUnit } from '../schemas/metrics';

/* ── Condition-1 tolerances ────────────────────────────────────────────── */

/**
 * The rounding tolerance applied to the absolute fields (`used`,
 * `remaining`), in `unit`. Zero: every monotonic quantization (floor, ceil,
 * nearest) preserves ordering, so an apparent absolute decrease always
 * implies a real one — there is no rounding noise to allow for.
 */
export const ABSOLUTE_TOLERANCE = 0;

/**
 * The rounding tolerance applied to the percentage fields (`percentUsed`,
 * `percentRemaining`), in percentage points. One: the provider reports
 * integer percentages (D-047), and a one-point move is the documented
 * rounding noise class — only a move of more than one point is evidence.
 */
export const PERCENT_TOLERANCE = 1;

/* ── Reason vocabulary ─────────────────────────────────────────────────── */

/**
 * The condition codes a `RESET` event's reason is built from, in canonical
 * order (decision D-074; D-046 made the reason a free non-empty string and
 * this module owns its vocabulary). Codes join with `'+'`; a rolling-window
 * event additionally carries {@link ROLLING_WINDOW_NOTE}.
 */
export const RESET_SIGNAL_CODES = Object.freeze([
  'usage_decreased',
  'remaining_increased',
  'resets_at_advanced',
] as const);

/** A single condition code from {@link RESET_SIGNAL_CODES}. */
export type ResetSignalCode = (typeof RESET_SIGNAL_CODES)[number];

/**
 * The conservative-approach exception note appended to every rolling-window
 * event's reason: value evidence is inadmissible for a replenishing quota,
 * so the event rests on the declaration condition alone.
 */
export const ROLLING_WINDOW_NOTE = 'rolling_window_conservative';

/* ── Input and output types ────────────────────────────────────────────── */

/**
 * One point of a metric series positioned in time — the §8.4 fields the
 * detector reads plus the series' position data. Both producers map onto it
 * trivially: a snapshot's `NormalizedMetric` plus its account and
 * `collectedAt`, and a `metric_values` row from history (`null`s become
 * absent fields).
 */
export interface ResetPointInput {
  /** The account the point belongs to — half of the series identity (§12.1). */
  readonly accountId: string;
  /** The metric half of the series identity (§8.4 `key`). */
  readonly metricKey: string;
  /** Collection time of the snapshot the point came from, UTC epoch ms. */
  readonly collectedAt: number;
  /** Quota accounting regime — the rolling-window rule's input. */
  readonly limitType: LimitType;
  /** Unit of the absolute fields — the comparability guard. */
  readonly unit: MetricUnit;
  /** Per-metric validity (§8.4); invalid points never reach a comparison. */
  readonly isValid: boolean;
  /** The run that produced this point, when known (history reads); evidence passthrough. */
  readonly runId?: number;
  /** Consumed amount (§8.4). */
  readonly used?: number;
  /** Remaining amount (§8.4). */
  readonly remaining?: number;
  /** Percentage of the allowance consumed (§8.4). */
  readonly percentUsed?: number;
  /** Percentage of the allowance remaining (§8.4). */
  readonly percentRemaining?: number;
  /** Declared next quota reset, UTC epoch ms (§8.4). */
  readonly resetsAt?: number;
}

/** Where a `RESET` event's time came from (§12.1; the D-046 vocabulary). */
export type ResetEventTimeSource = 'previous_resets_at' | 'current_collected_at';

/**
 * One compared point as stored evidence — the D-046 camelCase point
 * vocabulary, carrying only the fields the input point actually carried.
 */
export type ResetPointEvidence = {
  readonly runId?: number;
  readonly collectedAt: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly percentUsed?: number;
  readonly percentRemaining?: number;
  readonly resetsAt?: number;
  readonly [field: string]: unknown;
};

/**
 * The §12.1 detection evidence a `RESET` event carries — structurally the
 * `QuotaEventDetails` of `src/storage/repository.ts` (a non-empty `reason`
 * and the compared `previous`/`current` objects, plus this detector's
 * `tolerance` and `eventTimeSource`).
 */
export interface ResetEventEvidence {
  /** Which §12.1 conditions fired, and the conservative exception if any. */
  readonly reason: string;
  /** The previous valid point the new point was compared against. */
  readonly previous: ResetPointEvidence;
  /** The new point whose evidence triggered the event. */
  readonly current: ResetPointEvidence;
  /** The tolerances condition 1 applied (D-074). */
  readonly tolerance: { readonly absolute: number; readonly percent: number };
  /** Which of the two §12.1 timestamps became `eventAt`. */
  readonly eventTimeSource: ResetEventTimeSource;
  readonly [evidence: string]: unknown;
}

/**
 * One detected quota reset (§12.1). Structurally identical to
 * `CycleEventInput`, the event half of a successful cycle's transactional
 * write (task 118's seam): `metricKey`, `eventType`, `eventAt`, `details`.
 */
export interface ResetEvent {
  readonly metricKey: string;
  readonly eventType: 'RESET';
  /** §12.1 event time — the previous `resetsAt` between snapshots, else the new collection time. */
  readonly eventAt: number;
  readonly details: ResetEventEvidence;
}

/* ── Condition 1: value movement beyond tolerance ──────────────────────── */

/** The quota fields condition 1 judges, in §8.4 order. */
type ConditionField = 'used' | 'remaining' | 'percentUsed' | 'percentRemaining';

/**
 * The movement direction the reset hypothesis predicts for each field:
 * consumption falls, remaining allowance rises.
 */
const PREDICTED_DIRECTIONS: Readonly<Record<ConditionField, 'down' | 'up'>> = Object.freeze({
  used: 'down',
  remaining: 'up',
  percentUsed: 'down',
  percentRemaining: 'up',
});

/** The rounding tolerance each field's movement is judged against. */
const FIELD_TOLERANCES: Readonly<Record<ConditionField, number>> = Object.freeze({
  used: ABSOLUTE_TOLERANCE,
  remaining: ABSOLUTE_TOLERANCE,
  percentUsed: PERCENT_TOLERANCE,
  percentRemaining: PERCENT_TOLERANCE,
});

const CONDITION_FIELDS: readonly ConditionField[] = Object.freeze([
  'used',
  'percentUsed',
  'remaining',
  'percentRemaining',
] as const);

/** Which condition-1 reason code a field's predicted movement evidences. */
function codeForField(field: ConditionField): Exclude<ResetSignalCode, 'resets_at_advanced'> {
  return field === 'used' || field === 'percentUsed' ? 'usage_decreased' : 'remaining_increased';
}

/**
 * Condition 1, judged jointly across every field pair both points carry:
 * a predicted beyond-tolerance movement on some field is evidence, and a
 * beyond-tolerance movement **against** the prediction on any carried field
 * vetoes the whole condition (its own signal's pair or the other signal's —
 * a contradiction makes the evidence ambiguous, and §12.1 records nothing
 * ambiguous).
 */
function valueCondition(previous: ResetPointInput, current: ResetPointInput): ResetSignalCode[] {
  const evidence = new Set<Exclude<ResetSignalCode, 'resets_at_advanced'>>();
  for (const field of CONDITION_FIELDS) {
    const before = previous[field];
    const after = current[field];
    if (before === undefined || after === undefined) continue;
    // Signed so that positive is always the predicted direction.
    const movement = PREDICTED_DIRECTIONS[field] === 'down' ? before - after : after - before;
    const tolerance = FIELD_TOLERANCES[field];
    if (movement > tolerance) evidence.add(codeForField(field));
    else if (movement < -tolerance) return [];
  }
  // The field order above keeps the codes in RESET_SIGNAL_CODES' canonical order.
  return [...evidence];
}

/* ── Condition 2 and the event time ────────────────────────────────────── */

/**
 * Whether the previous point's declared `resetsAt` has passed at the new
 * snapshot and the new point declares a strictly later one (§12.1
 * condition 2).
 */
function declaredResetAdvanced(previous: ResetPointInput, current: ResetPointInput): boolean {
  return (
    previous.resetsAt !== undefined &&
    current.resetsAt !== undefined &&
    previous.resetsAt <= current.collectedAt &&
    current.resetsAt > previous.resetsAt
  );
}

/** The §12.1 event time: the previous `resetsAt` when it lies between the snapshots, else the new collection time. */
function resolveEventTime(
  previous: ResetPointInput,
  current: ResetPointInput,
): { readonly eventAt: number; readonly eventTimeSource: ResetEventTimeSource } {
  const declared = previous.resetsAt;
  if (
    declared !== undefined &&
    previous.collectedAt < declared &&
    declared <= current.collectedAt
  ) {
    return { eventAt: declared, eventTimeSource: 'previous_resets_at' };
  }
  return { eventAt: current.collectedAt, eventTimeSource: 'current_collected_at' };
}

/* ── Evidence ──────────────────────────────────────────────────────────── */

/** One point reduced to the evidence fields it actually carries (D-046). */
function pointEvidence(point: ResetPointInput): ResetPointEvidence {
  return {
    ...(point.runId !== undefined ? { runId: point.runId } : {}),
    collectedAt: point.collectedAt,
    ...(point.used !== undefined ? { used: point.used } : {}),
    ...(point.remaining !== undefined ? { remaining: point.remaining } : {}),
    ...(point.percentUsed !== undefined ? { percentUsed: point.percentUsed } : {}),
    ...(point.percentRemaining !== undefined ? { percentRemaining: point.percentRemaining } : {}),
    ...(point.resetsAt !== undefined ? { resetsAt: point.resetsAt } : {}),
  };
}

/* ── Detection ─────────────────────────────────────────────────────────── */

/** Asserts the pair-comparison contract; violations are wiring bugs (D-048). */
function assertComparable(previous: ResetPointInput, current: ResetPointInput): void {
  if (!previous.isValid || !current.isValid) {
    throw new TypeError(
      `detectResetEvent: invalid points do not participate in comparisons (spec §12.1), got isValid previous=${previous.isValid} current=${current.isValid} for account '${current.accountId}' metric '${current.metricKey}'`,
    );
  }
  if (previous.accountId !== current.accountId || previous.metricKey !== current.metricKey) {
    throw new TypeError(
      `detectResetEvent: cannot compare points of different series '${previous.accountId}/${previous.metricKey}' and '${current.accountId}/${current.metricKey}'`,
    );
  }
}

/**
 * Compares one new valid point against the previous valid point of its
 * account-and-metric series and returns the §12.1 `RESET` event, or
 * `undefined` when no unambiguous condition fired (`previous === undefined`
 * is the series' first point: nothing to compare).
 *
 * Caller-contract violations throw (`TypeError`): an invalid point, or two
 * points of different accounts or metric keys. Data ambiguity — an
 * out-of-order pair, a `limitType`/`unit` redefinition between the points,
 * or contradictory value fields — returns `undefined` (conservative
 * silence, never a false event).
 */
export function detectResetEvent(
  previous: ResetPointInput | undefined,
  current: ResetPointInput,
): ResetEvent | undefined {
  if (previous === undefined) return undefined;
  assertComparable(previous, current);

  // Ambiguity guards — data, not wiring: record nothing.
  if (previous.collectedAt > current.collectedAt) return undefined;
  if (previous.limitType !== current.limitType || previous.unit !== current.unit) {
    return undefined;
  }

  // The conservative approach: a rolling window replenishes gradually, so
  // value movement is not reset evidence for it — only a declared
  // reset-time advancement is (see the module header; D-074).
  const rolling = current.limitType === 'ROLLING_WINDOW';
  const signals: ResetSignalCode[] = rolling ? [] : valueCondition(previous, current);
  if (declaredResetAdvanced(previous, current)) {
    signals.push('resets_at_advanced');
  }
  if (signals.length === 0) return undefined;

  const reasonParts: string[] = [...signals];
  if (rolling) reasonParts.push(ROLLING_WINDOW_NOTE);
  const { eventAt, eventTimeSource } = resolveEventTime(previous, current);

  return {
    metricKey: current.metricKey,
    eventType: 'RESET',
    eventAt,
    details: {
      reason: reasonParts.join('+'),
      previous: pointEvidence(previous),
      current: pointEvidence(current),
      tolerance: { absolute: ABSOLUTE_TOLERANCE, percent: PERCENT_TOLERANCE },
      eventTimeSource,
    },
  };
}

/**
 * Folds a flat list of points — any accounts and metrics interleaved, any
 * validity — into the series' reset events, in input order. Each (account,
 * metric) pair is its own series; invalid points are skipped entirely
 * (neither compared nor made the comparison base); within a series, points
 * are processed in input order (chronology is the caller's contract —
 * disorder costs a missed event, never a false one).
 */
export function detectSeriesResetEvents(points: ReadonlyArray<ResetPointInput>): ResetEvent[] {
  const events: ResetEvent[] = [];
  // Two levels so no separator-string key can ever collide with field data.
  const lastValidByMetric = new Map<string, Map<string, ResetPointInput>>();
  for (const point of points) {
    if (!point.isValid) continue;
    const series = lastValidByMetric.get(point.accountId) ?? new Map<string, ResetPointInput>();
    const event = detectResetEvent(series.get(point.metricKey), point);
    if (event !== undefined) events.push(event);
    series.set(point.metricKey, point);
    lastValidByMetric.set(point.accountId, series);
  }
  return events;
}
