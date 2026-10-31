import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  ABSOLUTE_TOLERANCE,
  detectResetEvent,
  detectSeriesResetEvents,
  PERCENT_TOLERANCE,
  RESET_SIGNAL_CODES,
  ROLLING_WINDOW_NOTE,
  type ResetEvent,
  type ResetPointInput,
} from '../../src/services/events-detection';

/**
 * Standing properties over the §12.1 detector (task 117, decision D-074).
 * The heart is the done-condition as a proof: no rolling-window value
 * transition — however drastic — records an event without the declaration
 * condition, while a fixed-period quota records exactly the spec's event
 * for genuine usage drops and never for monotone usage. The fold property
 * checks grouping, validity skipping, and ordering against an independent
 * group-first oracle. Task 124 extended the suite with the condition-1 and
 * event-time biconditionals, tolerance-edge tripwires, and generator
 * growth; the cross-module downsampling and gap rules live in
 * history-cross.property.spec.ts.
 */

/** A collection time; the series under test is otherwise arbitrary. */
const T0 = 1_700_000_000_000;

/** An absolute quota value the provider could report. */
const absolute = fc.integer({ min: 0, max: 1_000_000 });

/** A percentage the provider could report (integers, D-047). */
const percent = fc.integer({ min: 0, max: 100 });

/** An optional-field generator that yields `undefined` for absence. */
const maybe = (arb: fc.Arbitrary<number>) => fc.option(arb, { nil: undefined });

/** A valid fixed-period point with exactly the supplied value fields. */
function fixedPoint(values: {
  collectedAt: number;
  used?: number;
  remaining?: number;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: number;
}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'mcp-monthly',
    limitType: 'MONTHLY',
    unit: 'REQUESTS',
    isValid: true,
    ...values,
  };
}

/** A valid rolling-window point with exactly the supplied value fields. */
function rollingPoint(values: {
  collectedAt: number;
  used?: number;
  remaining?: number;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: number;
}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'tokens-5h',
    limitType: 'ROLLING_WINDOW',
    unit: 'PERCENT',
    isValid: true,
    ...values,
  };
}

describe('fixed-period quotas (property)', () => {
  it('never records an event while usage is monotone', () => {
    fc.assert(
      fc.property(
        absolute,
        absolute,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }),
        (used, remaining, percentUsed, gap) => {
          const previous = fixedPoint({
            collectedAt: T0,
            used,
            remaining,
            percentUsed,
            percentRemaining: 100 - percentUsed,
          });
          const current = fixedPoint({
            collectedAt: T0 + gap,
            used: used + 1, // usage only grows…
            remaining: Math.max(0, remaining - 1), // …and remaining only shrinks
            percentUsed: Math.min(100, percentUsed + 1),
            percentRemaining: Math.max(0, 100 - percentUsed - 1),
          });
          expect(detectResetEvent(previous, current)).toBeUndefined();
        },
      ),
    );
  });

  it('records exactly one event for every strict usage decrease', () => {
    const usedAndSmaller = absolute
      .filter((used) => used >= 1)
      .chain((used) => fc.tuple(fc.constant(used), fc.integer({ min: 0, max: used - 1 })));
    fc.assert(
      fc.property(
        usedAndSmaller,
        fc.integer({ min: 1, max: 3_600_000 }),
        ([used, currentUsed], gap) => {
          const previous = fixedPoint({ collectedAt: T0, used });
          const current = fixedPoint({ collectedAt: T0 + gap, used: currentUsed });
          const event = detectResetEvent(previous, current);
          expect(event).toBeDefined();
          expect(event?.metricKey).toBe('mcp-monthly');
          expect(event?.eventType).toBe('RESET');
          expect(event?.details.reason).toBe('usage_decreased');
          expect(event?.eventAt).toBe(T0 + gap);
          expect(event?.details.eventTimeSource).toBe('current_collected_at');
          // Deterministic: the same comparison yields the same event.
          expect(detectResetEvent(previous, current)).toEqual(event);
        },
      ),
    );
  });
});

describe('rolling windows (property — the done-condition)', () => {
  it('records nothing for arbitrary value transitions without declaration evidence', () => {
    fc.assert(
      fc.property(
        absolute,
        absolute,
        percent,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.constantFrom(
          'both-absent' as const,
          'previous-absent' as const,
          'current-absent' as const,
          'equal' as const,
          'earlier' as const,
          'not-passed' as const,
        ),
        (used, remaining, percentUsed, percentRemaining, gap, resetsAtShape) => {
          const t1 = T0 + gap;
          let previousResetsAt: number | undefined;
          let currentResetsAt: number | undefined;
          switch (resetsAtShape) {
            case 'both-absent':
              break;
            case 'previous-absent':
              currentResetsAt = t1 + 60_000;
              break;
            case 'current-absent':
              previousResetsAt = T0 + 60_000;
              break;
            case 'equal':
              previousResetsAt = T0 + 60_000;
              currentResetsAt = previousResetsAt;
              break;
            case 'earlier':
              previousResetsAt = t1 + 60_000;
              currentResetsAt = previousResetsAt - 1;
              break;
            case 'not-passed':
              previousResetsAt = t1 + 1; // still ahead of the new snapshot
              currentResetsAt = previousResetsAt + 3_600_000;
              break;
          }
          // Any value movement — down to a full drop to zero — is ambiguous
          // for a replenishing window and must not record an event.
          expect(
            detectResetEvent(
              rollingPoint({
                collectedAt: T0,
                used,
                remaining,
                percentUsed,
                percentRemaining,
                resetsAt: previousResetsAt,
              }),
              rollingPoint({
                collectedAt: t1,
                used: 0,
                remaining,
                percentUsed: 0,
                percentRemaining,
                resetsAt: currentResetsAt,
              }),
            ),
          ).toBeUndefined();
        },
      ),
    );
  });

  it('records the declaration event whenever condition 2 holds, with the spec event time', () => {
    fc.assert(
      fc.property(
        absolute,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }), // gap between the snapshots
        fc.integer({ min: 1, max: 3_600_000 }), // where the declaration sits inside the gap
        fc.integer({ min: 1, max: 3_600_000 }), // how much later the new declaration is
        (used, percentUsed, gap, offset, later) => {
          const t1 = T0 + gap;
          const resetsAt = T0 + ((offset - 1) % gap) + 1; // strictly inside (T0, t1]
          const previous = rollingPoint({ collectedAt: T0, used, percentUsed, resetsAt });
          const current = rollingPoint({
            collectedAt: t1,
            used: 0, // value evidence exists but is inadmissible
            percentUsed: 0,
            resetsAt: resetsAt + later,
          });
          const event = detectResetEvent(previous, current);
          expect(event?.details.reason).toBe(`resets_at_advanced+${ROLLING_WINDOW_NOTE}`);
          expect(event?.eventAt).toBe(resetsAt);
          expect(event?.details.eventTimeSource).toBe('previous_resets_at');
        },
      ),
    );
  });

  it('stamps a stale declaration (passed before the previous snapshot) with the new collection time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        (gap, stale, later) => {
          const t1 = T0 + gap;
          const previous = rollingPoint({
            collectedAt: T0,
            resetsAt: T0 - stale, // already passed at the previous snapshot
          });
          const current = rollingPoint({
            collectedAt: t1,
            resetsAt: T0 - stale + later,
          });
          const event = detectResetEvent(previous, current);
          expect(event?.details.reason).toBe(`resets_at_advanced+${ROLLING_WINDOW_NOTE}`);
          expect(event?.eventAt).toBe(t1);
          expect(event?.details.eventTimeSource).toBe('current_collected_at');
        },
      ),
    );
  });
});

describe('the series fold (property)', () => {
  /** One generated point: series identity, time increment, validity, values. */
  interface PointSpec {
    accountId: 'acct-1' | 'acct-2';
    metricKey: 'a' | 'b' | 'c';
    gapMs: number;
    isValid: boolean;
    used: number | undefined;
    remaining: number | undefined;
    percentUsed: number | undefined;
    percentRemaining: number | undefined;
    resetsAtOffset: number | undefined;
  }

  const pointSpec: fc.Arbitrary<PointSpec> = fc.record({
    accountId: fc.constantFrom('acct-1', 'acct-2'),
    metricKey: fc.constantFrom('a', 'b', 'c'),
    gapMs: fc.integer({ min: 0, max: 600_000 }),
    isValid: fc.boolean(),
    used: maybe(absolute),
    remaining: maybe(absolute),
    percentUsed: maybe(percent),
    percentRemaining: maybe(percent),
    resetsAtOffset: maybe(fc.integer({ min: -3_600_000, max: 3_600_000 })),
  });

  /** Fixed series identities: two fixed-period keys and one rolling key. */
  const SERIES: Readonly<Record<'a' | 'b' | 'c', Pick<ResetPointInput, 'limitType' | 'unit'>>> = {
    a: { limitType: 'MONTHLY', unit: 'REQUESTS' },
    b: { limitType: 'ROLLING_WINDOW', unit: 'PERCENT' },
    c: { limitType: 'WEEKLY', unit: 'CREDITS' },
  };

  /** Materializes generated specs into points with running timestamps. */
  function materialize(specs: ReadonlyArray<PointSpec>): ResetPointInput[] {
    let collectedAt = T0;
    return specs.map((spec) => {
      collectedAt += spec.gapMs;
      const identity = SERIES[spec.metricKey];
      return {
        accountId: spec.accountId,
        metricKey: spec.metricKey,
        collectedAt,
        limitType: identity.limitType,
        unit: identity.unit,
        isValid: spec.isValid,
        used: spec.used,
        remaining: spec.remaining,
        percentUsed: spec.percentUsed,
        percentRemaining: spec.percentRemaining,
        resetsAt: spec.resetsAtOffset === undefined ? undefined : collectedAt + spec.resetsAtOffset,
      };
    });
  }

  /**
   * Event identity for comparison: at most one event per current point, so
   * (current.collectedAt, metricKey) orders the events chronologically per
   * metric. Ties can also occur **across accounts sharing a metricKey**
   * once duplicate stamps exist (gapMs 0 clusters): the implementation
   * orders tied events by input order of the current points, the oracle by
   * series-creation order — orders that can legitimately oppose. The
   * serialized event is therefore the final tie-break, making the key a
   * total order over distinct events (equal keys on identical events are
   * indistinguishable under `toEqual`), so the comparison is exactly
   * multiset equality with the fold's emission order still checked for
   * every distinct key (task 124 review finding: the stability-only sort
   * made the clustered fold flaky on ~20% of seeds).
   */
  function byIdentity(events: ReadonlyArray<ResetEvent>): ResetEvent[] {
    return [...events].sort(
      (left, right) =>
        left.details.current.collectedAt - right.details.current.collectedAt ||
        (left.metricKey < right.metricKey ? -1 : left.metricKey > right.metricKey ? 1 : 0) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }

  /**
   * The group-first oracle: valid points grouped by (account, metric), then
   * consecutive group members compared pairwise — no shared fold state with
   * the implementation's single-pass last-valid-point map. A table-driven
   * restatement of the fold's semantics over the landed pair detector, not
   * an independent re-derivation of §12.1 (that is the biconditional
   * property's job below).
   */
  function groupFirstOracle(points: ReadonlyArray<ResetPointInput>): ResetEvent[] {
    const oracle: ResetEvent[] = [];
    const bySeries = new Map<string, ResetPointInput[]>();
    for (const p of points) {
      if (!p.isValid) continue;
      const key = `${p.accountId}/${p.metricKey}`;
      const series = bySeries.get(key) ?? [];
      series.push(p);
      bySeries.set(key, series);
    }
    for (const series of bySeries.values()) {
      for (let index = 1; index < series.length; index += 1) {
        const event = detectResetEvent(series[index - 1]!, series[index]!);
        if (event !== undefined) oracle.push(event);
      }
    }
    return oracle;
  }

  it('equals a group-first oracle: per account and metric, consecutive valid pairs', () => {
    fc.assert(
      fc.property(fc.array(pointSpec, { minLength: 0, maxLength: 40 }), (specs) => {
        const points = materialize(specs);
        expect(byIdentity(detectSeriesResetEvents(points))).toEqual(
          byIdentity(groupFirstOracle(points)),
        );
      }),
    );
  });

  // Task 124 addition: the same oracle equality under generator growth —
  // twice the series length, with dense equal-timestamp clusters (gapMs
  // reaches 0) and declarations landing on shared stamps (offset reaches 0).
  it('equals the group-first oracle on long, densely clustered interleavings', () => {
    fc.assert(
      fc.property(fc.array(pointSpec, { minLength: 40, maxLength: 80, size: 'max' }), (specs) => {
        const points = materialize(specs);
        const events = detectSeriesResetEvents(points);
        expect(byIdentity(events)).toEqual(byIdentity(groupFirstOracle(points)));
        // Determinism under fold state: a second pass over the same input
        // is bit-identical.
        expect(detectSeriesResetEvents(points)).toEqual(events);
      }),
    );
  });
});

/* ── Task 124 additions: the biconditionals and generator growth ───────── */

/** The §8.4 fields condition 1 judges, with their predicted direction and
 * tolerance — in RESET_SIGNAL_CODES' canonical grouping order (usage fields
 * before remaining fields), so the oracle's reason matches the vocabulary. */
const CONDITION_FIELD_TABLE = [
  { field: 'used', predicted: 'down', tolerance: ABSOLUTE_TOLERANCE },
  { field: 'percentUsed', predicted: 'down', tolerance: PERCENT_TOLERANCE },
  { field: 'remaining', predicted: 'up', tolerance: ABSOLUTE_TOLERANCE },
  { field: 'percentRemaining', predicted: 'up', tolerance: PERCENT_TOLERANCE },
] as const;

type ConditionFieldKey = (typeof CONDITION_FIELD_TABLE)[number]['field'];

/** The oracle's verdict for condition 1 over one field pair. */
interface ValueVerdict {
  readonly fires: boolean;
  /** The reason codes the observed movements evidence, canonical order. */
  readonly codes: Array<'usage_decreased' | 'remaining_increased'>;
}

/**
 * A table-driven restatement of the D-074 condition-1 judgment — evidence
 * plus no contradicting pair, brute force over a declarative table with no
 * shared code path with the detector (it catches sign, tolerance,
 * field-order, and veto mutations; a shared misreading of the spec itself
 * is what the directed suite's spec-derived cases pin). The verdict type
 * for condition 1 over one field pair.
 */
function oracleValueCondition(previous: ResetPointInput, current: ResetPointInput): ValueVerdict {
  const codes = new Set<'usage_decreased' | 'remaining_increased'>();
  let veto = false;
  for (const { field, predicted, tolerance } of CONDITION_FIELD_TABLE) {
    const before = previous[field];
    const after = current[field];
    if (before === undefined || after === undefined) continue;
    const movement = predicted === 'down' ? before - after : after - before;
    if (movement > tolerance) {
      codes.add(predicted === 'down' ? 'usage_decreased' : 'remaining_increased');
    } else if (movement < -tolerance) veto = true;
  }
  return { fires: codes.size > 0 && !veto, codes: [...codes] };
}

/** One carried field's previous value and its movement to the current point. */
type FieldMovement = readonly [before: number, delta: number];

/** Previous value and movement per carried field; absent fields stay absent. */
const valuePairSpecArb = fc.record({
  used: fc.option(
    fc.tuple(
      fc.integer({ min: 1, max: 999_999 }),
      fc.constantFrom(-1, 0, 1),
    ) as fc.Arbitrary<FieldMovement>,
    { nil: undefined },
  ),
  remaining: fc.option(
    fc.tuple(
      fc.integer({ min: 1, max: 999_999 }),
      fc.constantFrom(-1, 0, 1),
    ) as fc.Arbitrary<FieldMovement>,
    { nil: undefined },
  ),
  percentUsed: fc.option(
    fc.tuple(
      fc.integer({ min: 2, max: 98 }),
      fc.constantFrom(-2, -1, 0, 1, 2),
    ) as fc.Arbitrary<FieldMovement>,
    { nil: undefined },
  ),
  percentRemaining: fc.option(
    fc.tuple(
      fc.integer({ min: 2, max: 98 }),
      fc.constantFrom(-2, -1, 0, 1, 2),
    ) as fc.Arbitrary<FieldMovement>,
    { nil: undefined },
  ),
});

interface ValuePairSpec {
  readonly used?: FieldMovement;
  readonly remaining?: FieldMovement;
  readonly percentUsed?: FieldMovement;
  readonly percentRemaining?: FieldMovement;
}

/** Materializes one spec side into the point's carried value fields. */
function specFields(spec: ValuePairSpec, side: 0 | 1): Partial<Record<ConditionFieldKey, number>> {
  const fields: Partial<Record<ConditionFieldKey, number>> = {};
  for (const key of Object.keys(spec) as ConditionFieldKey[]) {
    const pair = spec[key];
    if (pair !== undefined) fields[key] = side === 0 ? pair[0] : pair[0] + pair[1];
  }
  return fields;
}

describe('condition 1 as a biconditional over arbitrary field pairs (property)', () => {
  it('fires exactly when the table oracle fires, with exactly its reason codes', () => {
    let sawFire = 0;
    let sawVetoedEvidence = 0; // evidence existed but a contradicting pair killed it
    let sawPercentToleranceEdge = 0; // |Δ| == 1 percentage point: neither evidence nor veto
    let sawAbsoluteStrictEdge = 0; // |Δ| == 1 unit against tolerance zero: always decisive
    fc.assert(
      fc.property(valuePairSpecArb, fc.integer({ min: 1, max: 3_600_000 }), (spec, gap) => {
        const previous = fixedPoint({ collectedAt: T0, ...specFields(spec, 0) });
        const current = fixedPoint({ collectedAt: T0 + gap, ...specFields(spec, 1) });
        const oracle = oracleValueCondition(previous, current);
        const event = detectResetEvent(previous, current);
        if (oracle.codes.length > 0 && !oracle.fires) sawVetoedEvidence += 1;
        for (const key of ['percentUsed', 'percentRemaining'] as const) {
          const pair = spec[key];
          if (pair !== undefined && Math.abs(pair[1]) === 1) {
            sawPercentToleranceEdge += 1;
          }
        }
        for (const key of ['used', 'remaining'] as const) {
          const pair = spec[key];
          if (pair !== undefined && Math.abs(pair[1]) === 1) {
            sawAbsoluteStrictEdge += 1;
          }
        }
        if (!oracle.fires) {
          expect(event).toBeUndefined();
          return;
        }
        sawFire += 1;
        expect(event).toBeDefined();
        // The reason is exactly the oracle's codes — and those codes are
        // the exported canonical vocabulary, in RESET_SIGNAL_CODES' own
        // order (a subset, never reordered, never renamed).
        expect(event?.details.reason).toBe(oracle.codes.join('+'));
        expect(event?.details.reason.split('+')).toEqual(
          RESET_SIGNAL_CODES.filter((code) => (oracle.codes as readonly string[]).includes(code)),
        );
        expect(event?.details.tolerance).toEqual({
          absolute: ABSOLUTE_TOLERANCE,
          percent: PERCENT_TOLERANCE,
        });
        expect(event?.eventAt).toBe(T0 + gap);
        expect(event?.details.eventTimeSource).toBe('current_collected_at');
      }),
    );
    // Vacuity tripwires: the generator must reach every judgment class.
    expect(sawFire).toBeGreaterThan(0);
    expect(sawVetoedEvidence).toBeGreaterThan(0);
    expect(sawPercentToleranceEdge).toBeGreaterThan(0);
    expect(sawAbsoluteStrictEdge).toBeGreaterThan(0);
  });
});

describe('the event-time biconditional over generated declarations (property)', () => {
  /**
   * Where the previous declaration sits relative to the two snapshots, and
   * what the new point declares — the full condition-2 / event-time matrix.
   */
  /** The generated declaration spec's shape (exemplars below are literals). */
  interface DeclarationSpec {
    readonly previousShape: 'absent' | 'stale' | 'between' | 'after-current';
    readonly currentShape: 'absent' | 'equal' | 'later';
    readonly staleMs: number;
    readonly betweenOffset: number;
    readonly aheadMs: number;
    readonly laterMs: number;
    readonly valuePair: ValuePairSpec;
  }

  const declarationSpecArb: fc.Arbitrary<DeclarationSpec> = fc.record({
    previousShape: fc.constantFrom('absent', 'stale', 'between', 'after-current'),
    currentShape: fc.constantFrom('absent', 'equal', 'later'),
    staleMs: fc.integer({ min: 0, max: 3_600_000 }),
    betweenOffset: fc.integer({ min: 1, max: 3_600_000 }),
    aheadMs: fc.integer({ min: 1, max: 3_600_000 }),
    laterMs: fc.integer({ min: 1, max: 3_600_000 }),
    valuePair: valuePairSpecArb,
  });

  it('stamps previous_resets_at exactly when the declaration lies between, for every firing condition', () => {
    let sawBothConditions = 0; // value evidence and declaration advanced together
    let sawValueStampedWithDeclaration = 0; // a condition-1 event stamped previous_resets_at

    function check(spec: DeclarationSpec, gap: number): void {
      const t1 = T0 + gap;
      const offset = ((spec.betweenOffset - 1) % gap) + 1; // strictly inside (T0, t1]
      let previousResetsAt: number | undefined;
      switch (spec.previousShape) {
        case 'absent':
          break;
        case 'stale':
          previousResetsAt = T0 - spec.staleMs; // passed at or before the previous snapshot
          break;
        case 'between':
          previousResetsAt = T0 + offset;
          break;
        case 'after-current':
          previousResetsAt = t1 + spec.aheadMs;
          break;
      }
      let currentResetsAt: number | undefined;
      switch (spec.currentShape) {
        case 'absent':
          break;
        case 'equal':
          currentResetsAt = previousResetsAt;
          break;
        case 'later':
          currentResetsAt =
            previousResetsAt === undefined ? t1 + spec.laterMs : previousResetsAt + spec.laterMs;
          break;
      }
      const previous = fixedPoint({
        collectedAt: T0,
        resetsAt: previousResetsAt,
        ...specFields(spec.valuePair, 0),
      });
      const current = fixedPoint({
        collectedAt: t1,
        resetsAt: currentResetsAt,
        ...specFields(spec.valuePair, 1),
      });

      const value = oracleValueCondition(previous, current);
      const declarationAdvanced =
        previousResetsAt !== undefined &&
        currentResetsAt !== undefined &&
        previousResetsAt <= t1 &&
        currentResetsAt > previousResetsAt;
      if (value.fires && declarationAdvanced) sawBothConditions += 1;

      const event = detectResetEvent(previous, current);
      if (!value.fires && !declarationAdvanced) {
        expect(event).toBeUndefined();
        return;
      }
      expect(event).toBeDefined();
      // A vetoed value condition contributes no codes even though the
      // oracle observed predicted movements — ambiguity silences them.
      const firedValueCodes = value.fires ? value.codes : [];
      const expectedCodes = declarationAdvanced
        ? [...firedValueCodes, 'resets_at_advanced']
        : firedValueCodes;
      expect(event?.details.reason).toBe(expectedCodes.join('+'));
      // §12.1's unconditional time rule: the previous resetsAt when it
      // lies between the snapshots, else the new collection time — for
      // a pure value event just as much as a declaration event.
      const liesBetween =
        previousResetsAt !== undefined && T0 < previousResetsAt && previousResetsAt <= t1;
      if (liesBetween) {
        expect(event?.eventAt).toBe(previousResetsAt);
        expect(event?.details.eventTimeSource).toBe('previous_resets_at');
        if (value.fires && !declarationAdvanced) sawValueStampedWithDeclaration += 1;
      } else {
        expect(event?.eventAt).toBe(t1);
        expect(event?.details.eventTimeSource).toBe('current_collected_at');
      }
    }

    fc.assert(
      fc.property(declarationSpecArb, fc.integer({ min: 1, max: 3_600_000 }), (spec, gap) => {
        check(spec, gap);
        // Standing exemplars, checked on every run: the two rare
        // combinations the random generator reaches only probabilistically
        // (found in review — on some seeds never within 100 runs, tripping
        // the vacuity counters). Deterministic coverage by construction.
        check(
          {
            previousShape: 'between',
            currentShape: 'later',
            staleMs: 0,
            betweenOffset: 1,
            aheadMs: 1,
            laterMs: 1,
            valuePair: { used: [100, -1] },
          },
          60_000,
        );
        check(
          {
            previousShape: 'between',
            currentShape: 'equal',
            staleMs: 0,
            betweenOffset: 1,
            aheadMs: 1,
            laterMs: 1,
            valuePair: { used: [100, -1] },
          },
          60_000,
        );
      }),
    );
    // Vacuity tripwires, now guaranteed by the exemplars: both conditions
    // together, and a value event stamped with the between-snapshots
    // declaration.
    expect(sawBothConditions).toBeGreaterThanOrEqual(100);
    expect(sawValueStampedWithDeclaration).toBeGreaterThanOrEqual(100);
  });
});
