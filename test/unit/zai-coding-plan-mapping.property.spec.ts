import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { mapQuotaLimitData } from '../../src/providers/zai-coding-plan/mapping';
import {
  DERIVED_METRIC_FIELDS,
  findProviderSnapshotProblems,
  isDerivedMetricField,
  type DerivedMetricField,
  type NormalizedMetric,
  type ProviderSnapshot,
} from '../../src/schemas/metrics';

/**
 * Property-based proof of the §8.4 derivation rules in the Z.ai metric
 * mapping (spec §8.4, §17.1; tasks 099/100/101, decisions
 * D-047/D-053/D-057). Task 101's done-condition — percentages are never
 * used to invent token counts — is the first property below; the others
 * hold every derivation path to its exact firing condition over arbitrary
 * finite payloads, IEEE-754 extremes included (the D-057 overflow guards).
 * The oracle mirrors the *rules*, not the code shape: field presence,
 * exact values, `derivedFields` content, and the shared snapshot
 * invariants are asserted per generated entry. Reproduce a failure with
 * `FC_SEED=<printed seed>`.
 */

/* ── Generators and shared helpers ─────────────────────────────────────── */

/** Every recognized (type, unit) identity (D-047 recognition table). */
const IDENTITIES = [
  { type: 'TIME_LIMIT', unit: 5, key: 'mcp-monthly', fixedUnit: 'REQUESTS', window: false },
  { type: 'TOKENS_LIMIT', unit: 3, key: 'tokens-5h', fixedUnit: undefined, window: true },
  { type: 'TIME_LIMIT', unit: 6, key: 'weekly-quota', fixedUnit: undefined, window: false },
  { type: 'TOKENS_LIMIT', unit: 6, key: 'weekly-quota', fixedUnit: undefined, window: false },
] as const;

type Identity = (typeof IDENTITIES)[number];

/**
 * Arbitrary finite doubles with the IEEE-754 extremes always in play —
 * `Number.MAX_VALUE` pairs are what provoke the D-057 overflow guards, and
 * subnormals keep quotients honest. Both spellings (generated range and
 * constant extremes) stay finite; wrong-typed values are covered by the
 * example suite.
 */
const anyFinite = fc.oneof(
  fc.double({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE, noNaN: true }),
  fc.constantFrom(
    0,
    1,
    -1,
    100,
    -100,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
  ),
);

/** An optional field: `undefined` counts as absent (fc.option's null does not). */
const optional = (arb: fc.Arbitrary<number>) => fc.option(arb, { nil: undefined });

/** Which value fields a generated limits entry carries. */
interface FieldsSpec {
  readonly usage: number | undefined;
  readonly currentValue: number | undefined;
  readonly remaining: number | undefined;
  readonly percentage: number | undefined;
  readonly number: number | undefined;
  readonly nextResetTime: number | undefined;
}

/** The all-absent skeleton the properties overlay values onto. */
const emptyFields: FieldsSpec = {
  usage: undefined,
  currentValue: undefined,
  remaining: undefined,
  percentage: undefined,
  number: undefined,
  nextResetTime: undefined,
};

/**
 * Generates field sets in three shapes: `exact` triples (the identity
 * `used + remaining = limit` holds by construction — the oracle and the
 * mapping evaluate the same float operation), `violated` triples (the
 * allowance is provably not the sum), and fully `arbitrary` field
 * presence (the identity is violated by default, exact only by chance).
 * An overflowing sum cannot be spelled as a finite `usage`, so those
 * triples degrade to a pair with a missing allowance — the case the
 * D-057 guard on `limit = used + remaining` exists for.
 */
const fieldsSpec: fc.Arbitrary<FieldsSpec> = fc
  .record({
    mode: fc.constantFrom('exact', 'violated', 'arbitrary'),
    a: anyFinite,
    b: anyFinite,
    fields: fc.record({
      usage: optional(anyFinite),
      currentValue: optional(anyFinite),
      remaining: optional(anyFinite),
      percentage: optional(anyFinite),
      number: optional(anyFinite),
      nextResetTime: optional(anyFinite),
    }),
  })
  .map(({ mode, a, b, fields }) => {
    const sum = a + b;
    if (mode === 'arbitrary') return fields;
    if (mode === 'violated' && Number.isFinite(sum)) {
      // A value provably different from the sum (also when it is zero).
      return { ...fields, currentValue: a, remaining: b, usage: sum === 0 ? 1 : -sum };
    }
    // The sum itself when it is a finite number, absent when it overflows.
    return {
      ...fields,
      currentValue: a,
      remaining: b,
      usage: Number.isFinite(sum) ? sum : undefined,
    };
  });

/** A field set with no absolute sources — a percentage at most, plus metadata. */
const percentOnlySpec: fc.Arbitrary<FieldsSpec> = fc
  .record({
    percentage: optional(anyFinite),
    number: optional(anyFinite),
    nextResetTime: optional(anyFinite),
  })
  .map((fields) => ({ ...emptyFields, ...fields }));

/** Builds the payload entry of a spec: only present fields become keys. */
function entryOf(identity: Identity, spec: FieldsSpec): Record<string, unknown> {
  return {
    type: identity.type,
    unit: identity.unit,
    ...(spec.usage !== undefined ? { usage: spec.usage } : {}),
    ...(spec.currentValue !== undefined ? { currentValue: spec.currentValue } : {}),
    ...(spec.remaining !== undefined ? { remaining: spec.remaining } : {}),
    ...(spec.percentage !== undefined ? { percentage: spec.percentage } : {}),
    ...(spec.number !== undefined ? { number: spec.number } : {}),
    ...(spec.nextResetTime !== undefined ? { nextResetTime: spec.nextResetTime } : {}),
  };
}

/** Wraps metrics as a snapshot for the shared invariant check. */
const asSnapshot = (metrics: NormalizedMetric[]): ProviderSnapshot => ({
  providerId: 'zai-coding-plan',
  collectedAt: 0,
  metrics,
});

/** Maps one recognized entry; a recognized entry always yields its metric. */
function metricOf(identity: Identity, spec: FieldsSpec): NormalizedMetric {
  const metric = mapQuotaLimitData([entryOf(identity, spec)], undefined).metrics.at(0);
  if (metric === undefined) {
    throw new Error(`entry for identity ${identity.key} produced no metric`);
  }
  return metric;
}

/** The expected `windowSeconds`: rolling identities scale a finite number. */
function expectedWindow(identity: Identity, spec: FieldsSpec): number | undefined {
  if (!identity.window || spec.number === undefined) return undefined;
  const value = spec.number * 3600;
  return Number.isFinite(value) ? value : undefined;
}

/** Mirrors the D-057 guard for exact-value expectations. */
function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/** Sorts field names into the closed enum's canonical order. */
const inEnumOrder = (names: readonly string[]): string[] =>
  DERIVED_METRIC_FIELDS.filter((name) => names.includes(name));

/* ── The oracle: the §8.4 rules as declarative expectations ────────────── */

/** What the rules say one generated entry must map to. */
interface Expected {
  readonly valid: boolean;
  readonly invalidReason: string | undefined;
  readonly used: number | undefined;
  readonly remaining: number | undefined;
  readonly limit: number | undefined;
  readonly percentUsed: number | undefined;
  readonly percentRemaining: number | undefined;
  readonly derived: readonly DerivedMetricField[];
}

/**
 * Applies the derivation contract to a spec (§8.4; D-047.2; D-053.4;
 * D-057). Written from the rules, not from `buildMetric`'s branches: a
 * field is present exactly when supplied, or derived from two supplied
 * originals by finite arithmetic; percentages derive from absolutes only
 * via `100 · used / limit` on *supplied* inputs; nothing ever derives
 * from a percentage alone.
 */
function expectFromSpec(spec: FieldsSpec): Expected {
  const noValues =
    spec.usage === undefined &&
    spec.currentValue === undefined &&
    spec.remaining === undefined &&
    spec.percentage === undefined;
  const tripleViolated =
    spec.usage !== undefined &&
    spec.currentValue !== undefined &&
    spec.remaining !== undefined &&
    spec.currentValue + spec.remaining !== spec.usage;
  if (noValues || tripleViolated) {
    return {
      valid: false,
      invalidReason: noValues
        ? 'no quota values present on limits entry'
        : 'currentValue + remaining does not equal usage',
      used: undefined,
      remaining: undefined,
      limit: undefined,
      percentUsed: undefined,
      percentRemaining: undefined,
      derived: [],
    };
  }

  const derived: DerivedMetricField[] = [];
  let used = spec.currentValue;
  let remaining = spec.remaining;
  let limit = spec.usage;
  if (used !== undefined && limit !== undefined && remaining === undefined) {
    const value = limit - used;
    if (Number.isFinite(value)) {
      remaining = value;
      derived.push('remaining');
    }
  } else if (used !== undefined && remaining !== undefined && limit === undefined) {
    const value = used + remaining;
    if (Number.isFinite(value)) {
      limit = value;
      derived.push('limit');
    }
  } else if (limit !== undefined && remaining !== undefined && used === undefined) {
    const value = limit - remaining;
    if (Number.isFinite(value)) {
      used = value;
      derived.push('used');
    }
  }

  // Absolute→percentage only, never the reverse, and never chained: a
  // derived `limit` does not qualify (D-053.4).
  let percentUsed = spec.percentage;
  if (percentUsed === undefined && spec.currentValue !== undefined && spec.usage !== undefined) {
    const value = (100 * spec.currentValue) / spec.usage;
    if (Number.isFinite(value)) {
      percentUsed = value;
      derived.push('percentUsed');
    }
  }
  let percentRemaining: number | undefined;
  if (percentUsed !== undefined) {
    percentRemaining = 100 - percentUsed;
    derived.push('percentRemaining');
  }

  return {
    valid: true,
    invalidReason: undefined,
    used,
    remaining,
    limit,
    percentUsed,
    percentRemaining,
    derived,
  };
}

/* ── The done-condition: percentages never invent counts ───────────────── */

describe('percentages never invent absolute counts (§8.4, task 101)', () => {
  it('a percentage-only entry maps to a percentage-only metric, every identity', () => {
    fc.assert(
      fc.property(fc.constantFrom(...IDENTITIES), percentOnlySpec, (identity, spec) => {
        const metric = metricOf(identity, spec);
        if (spec.percentage === undefined) {
          // Percentage and absolutes all absent: the invalid branch —
          // no numeric values at all, never invented ones (§8.4).
          expect(metric.isValid).toBe(false);
          expect(metric.used).toBeUndefined();
          expect(metric.remaining).toBeUndefined();
          expect(metric.limit).toBeUndefined();
          expect(metric.percentUsed).toBeUndefined();
        } else {
          // The done-condition, literally: no token/credit/request
          // count may appear — the absolute fields stay empty (§8.4).
          expect(metric.isValid).toBe(true);
          expect(metric.used).toBeUndefined();
          expect(metric.remaining).toBeUndefined();
          expect(metric.limit).toBeUndefined();
          expect(metric.percentUsed).toBe(spec.percentage);
          expect(metric.percentRemaining).toBe(100 - spec.percentage);
          expect(metric.derivedFields).toEqual(['percentRemaining']);
          // Percentage-only readings carry unit PERCENT — except the
          // monthly MCP quota, whose REQUESTS unit is fixed (D-047.3).
          expect(metric.unit).toBe(identity.fixedUnit ?? 'PERCENT');
        }
        expect(metric.windowSeconds).toBe(expectedWindow(identity, spec));
        expect(metric.resetsAt).toBe(spec.nextResetTime);
        expect(findProviderSnapshotProblems(asSnapshot([metric]))).toEqual([]);
      }),
    );
  });

  it('no absolute field ever appears unless absolute sources were supplied', () => {
    fc.assert(
      fc.property(fc.constantFrom(...IDENTITIES), percentOnlySpec, (identity, spec) => {
        // Entries with zero absolute source fields — a percentage at
        // most — can never produce a count, whatever the metadata.
        const metric = metricOf(identity, spec);
        expect(metric.used).toBeUndefined();
        expect(metric.remaining).toBeUndefined();
        expect(metric.limit).toBeUndefined();
        expect(findProviderSnapshotProblems(asSnapshot([metric]))).toEqual([]);
      }),
    );
  });
});

/* ── Every derivation path, held to its exact firing condition ─────────── */

describe('derivation exactness over arbitrary finite payloads', () => {
  it('each field is present, with its exact value, exactly when the rules derive it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...IDENTITIES), fieldsSpec, (identity, spec) => {
        const metric = metricOf(identity, spec);
        const expected = expectFromSpec(spec);

        expect(metric.key).toBe(identity.key);
        expect(metric.isValid).toBe(expected.valid);
        if (!expected.valid) {
          expect(metric.invalidReason).toBe(expected.invalidReason);
          // An invalid metric carries no numeric values (§8.4/D-010).
          expect(metric.used).toBeUndefined();
          expect(metric.remaining).toBeUndefined();
          expect(metric.limit).toBeUndefined();
          expect(metric.percentUsed).toBeUndefined();
          expect(metric.percentRemaining).toBeUndefined();
          expect(metric.derivedFields).toBeUndefined();
        } else {
          expect(metric.invalidReason).toBeUndefined();
          expect(metric.used).toBe(expected.used);
          expect(metric.remaining).toBe(expected.remaining);
          expect(metric.limit).toBe(expected.limit);
          expect(metric.percentUsed).toBe(expected.percentUsed);
          expect(metric.percentRemaining).toBe(expected.percentRemaining);
          // derivedFields lists exactly the computed fields, from the
          // closed set, without duplicates (D-010).
          expect(inEnumOrder(metric.derivedFields ?? [])).toEqual(inEnumOrder(expected.derived));
          for (const name of metric.derivedFields ?? []) {
            expect(isDerivedMetricField(name)).toBe(true);
            expect(metric[name]).not.toBeUndefined();
          }
          for (const name of expected.derived) {
            expect(metric.derivedFields).toContain(name);
          }
          // No chaining (D-053.4): a derived limit never feeds percentUsed,
          // so with the allowance derived, percentages survive exactly when
          // the provider supplied one.
          if (expected.derived.includes('limit')) {
            expect(metric.percentUsed !== undefined).toBe(spec.percentage !== undefined);
            if (metric.percentUsed !== undefined) {
              expect(metric.percentUsed).toBe(spec.percentage);
            }
          }
        }
        // Unit discipline (§8.4/D-047.3): fixed units stay fixed;
        // by-fields units follow the absolutes.
        if (identity.fixedUnit === undefined) {
          const hasAbsolutes =
            spec.usage !== undefined ||
            spec.currentValue !== undefined ||
            spec.remaining !== undefined;
          expect(metric.unit).toBe(hasAbsolutes ? 'CREDITS' : 'PERCENT');
        } else {
          expect(metric.unit).toBe(identity.fixedUnit);
        }
        expect(metric.windowSeconds).toBe(expectedWindow(identity, spec));
        expect(metric.resetsAt).toBe(spec.nextResetTime);
        // The exact percent-sum identity holds whenever percentUsed exists.
        if (metric.percentUsed !== undefined) {
          expect(metric.percentRemaining).toBe(100 - metric.percentUsed);
        }
        // Every emitted number is finite — the D-057 guarantee.
        for (const value of [
          metric.used,
          metric.remaining,
          metric.limit,
          metric.percentUsed,
          metric.percentRemaining,
          metric.windowSeconds,
          metric.resetsAt,
        ]) {
          if (value !== undefined) expect(Number.isFinite(value)).toBe(true);
        }
        // And the whole construction satisfies the shared invariants.
        expect(findProviderSnapshotProblems(asSnapshot([metric]))).toEqual([]);
      }),
    );
  });

  it('extreme pairs derive finite results exactly and skip overflowing ones', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          Number.MAX_VALUE,
          -Number.MAX_VALUE,
          Number.MIN_VALUE,
          -Number.MIN_VALUE,
          0,
          1,
          -1,
        ),
        fc.constantFrom(
          Number.MAX_VALUE,
          -Number.MAX_VALUE,
          Number.MIN_VALUE,
          -Number.MIN_VALUE,
          0,
          1,
          -1,
        ),
        (a, b) => {
          const tokens = (fields: Partial<FieldsSpec>): NormalizedMetric =>
            metricOf(
              {
                type: 'TOKENS_LIMIT',
                unit: 3,
                key: 'tokens-5h',
                fixedUnit: undefined,
                window: true,
              },
              { ...emptyFields, ...fields },
            );

          const { remaining } = tokens({ usage: a, currentValue: b });
          expect(remaining).toBe(finiteOrUndefined(a - b));

          const { limit } = tokens({ currentValue: a, remaining: b });
          expect(limit).toBe(finiteOrUndefined(a + b));

          const { used } = tokens({ usage: a, remaining: b });
          expect(used).toBe(finiteOrUndefined(a - b));

          const { percentUsed } = tokens({ usage: a, currentValue: b });
          expect(percentUsed).toBe(finiteOrUndefined((100 * b) / a));

          const { windowSeconds } = tokens({ number: a, percentage: 5 });
          expect(windowSeconds).toBe(finiteOrUndefined(a * 3600));
        },
      ),
    );
  });
});
