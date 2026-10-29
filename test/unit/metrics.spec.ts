import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DERIVED_METRIC_FIELDS,
  LIMIT_TYPES,
  METRIC_UNITS,
  findNormalizedMetricProblems,
  findProviderSnapshotProblems,
  isDerivedMetricField,
  isLimitType,
  isMetricUnit,
} from '../../src/schemas/metrics';
import type {
  DerivedMetricField,
  LimitType,
  MetricUnit,
  NormalizedMetric,
  ProviderSnapshot,
} from '../../src/schemas/metrics';

/**
 * Locks the normalized snapshot and metric model (spec §8.4): closed enums
 * (value sets, guards, compile-time pins) and the cross-field invariants the
 * spec states as prose (invalid metrics carry no numerics, valid metrics
 * carry at least one, derived fields must exist and be set).
 */

/** A fully populated, valid metric (rolling 5-hour quota, spec §8.3). */
function validMetric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'zai-five-hour',
    label: 'Rolling 5-hour quota',
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 40,
    remaining: 60,
    limit: 100,
    percentUsed: 40,
    percentRemaining: 60,
    resetsAt: Date.UTC(2026, 9, 29, 12, 0, 0),
    isValid: true,
    ...overrides,
  };
}

/** Percent-only metric: `unit: 'PERCENT'`, absolute fields empty (spec §8.4). */
const percentOnlyMetric: NormalizedMetric = {
  key: 'zai-weekly-percent',
  label: 'Weekly quota',
  limitType: 'WEEKLY',
  unit: 'PERCENT',
  percentUsed: 73,
  percentRemaining: 27,
  isValid: true,
};

/** An invalid metric stored the way spec §8.4 demands: reason, no numerics. */
const invalidMetric: NormalizedMetric = {
  key: 'zai-monthly-mcp',
  label: 'Monthly MCP calls',
  limitType: 'MONTHLY',
  unit: 'REQUESTS',
  isValid: false,
  invalidReason: 'provider returned no quota fields for this plan',
};

function validSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: 'zai-coding-plan',
    collectedAt: Date.UTC(2026, 9, 29, 11, 55, 0),
    planName: 'Max plan',
    metrics: [validMetric()],
    ...overrides,
  };
}

describe('closed enums (spec §8.4)', () => {
  it('holds exactly the spec value sets', () => {
    expect([...LIMIT_TYPES]).toEqual(['ROLLING_WINDOW', 'DAILY', 'WEEKLY', 'MONTHLY', 'OTHER']);
    expect([...METRIC_UNITS]).toEqual(['TOKENS', 'CREDITS', 'REQUESTS', 'PERCENT']);
    expect([...DERIVED_METRIC_FIELDS]).toEqual([
      'used',
      'remaining',
      'limit',
      'percentUsed',
      'percentRemaining',
    ]);
  });

  it('freezes the value sets', () => {
    expect(Object.isFrozen(LIMIT_TYPES)).toBe(true);
    expect(Object.isFrozen(METRIC_UNITS)).toBe(true);
    expect(Object.isFrozen(DERIVED_METRIC_FIELDS)).toBe(true);
  });

  it('accepts every member in the guards', () => {
    for (const value of LIMIT_TYPES) {
      expect(isLimitType(value)).toBe(true);
    }
    for (const value of METRIC_UNITS) {
      expect(isMetricUnit(value)).toBe(true);
    }
    for (const value of DERIVED_METRIC_FIELDS) {
      expect(isDerivedMetricField(value)).toBe(true);
    }
  });

  it('rejects values outside each closed set', () => {
    // Each list includes members of the sibling enums on purpose: belonging
    // to one closed set must not satisfy another guard.
    const notALimitType: unknown[] = [
      '',
      'daily',
      'Daily',
      'DAILY ',
      'HOURLY',
      'TOKENS',
      'used',
      0,
      null,
      undefined,
      true,
      {},
      ['DAILY'],
    ];
    const notAMetricUnit: unknown[] = [
      '',
      'token',
      'TOKENS ',
      'PERCENTAGE',
      'REQUEST',
      'DAILY',
      'used',
      0,
      null,
      undefined,
      true,
      {},
      ['TOKENS'],
    ];
    const notADerivedField: unknown[] = [
      '',
      'Used',
      'used ',
      'resetsAt',
      'windowSeconds',
      'key',
      'DAILY',
      'TOKENS',
      0,
      null,
      undefined,
      true,
      {},
      ['used'],
    ];
    for (const value of notALimitType) {
      expect(isLimitType(value), `isLimitType(${JSON.stringify(value)})`).toBe(false);
    }
    for (const value of notAMetricUnit) {
      expect(isMetricUnit(value), `isMetricUnit(${JSON.stringify(value)})`).toBe(false);
    }
    for (const value of notADerivedField) {
      expect(isDerivedMetricField(value), `isDerivedMetricField(${JSON.stringify(value)})`).toBe(
        false,
      );
    }
  });
});

describe('type-level guarantees', () => {
  it('pins the enum unions to the spec value sets', () => {
    expectTypeOf<LimitType>().toEqualTypeOf<
      'ROLLING_WINDOW' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'OTHER'
    >();
    expectTypeOf<MetricUnit>().toEqualTypeOf<'TOKENS' | 'CREDITS' | 'REQUESTS' | 'PERCENT'>();
    expectTypeOf<DerivedMetricField>().toEqualTypeOf<
      'used' | 'remaining' | 'limit' | 'percentUsed' | 'percentRemaining'
    >();
  });

  it('keeps NormalizedMetric shaped exactly as spec §8.4 defines it', () => {
    expectTypeOf<NormalizedMetric['key']>().toEqualTypeOf<string>();
    expectTypeOf<NormalizedMetric['label']>().toEqualTypeOf<string>();
    expectTypeOf<NormalizedMetric['limitType']>().toEqualTypeOf<LimitType>();
    expectTypeOf<NormalizedMetric['unit']>().toEqualTypeOf<MetricUnit>();
    expectTypeOf<NormalizedMetric['windowSeconds']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['used']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['remaining']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['limit']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['percentUsed']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['percentRemaining']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['resetsAt']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NormalizedMetric['isValid']>().toEqualTypeOf<boolean>();
    expectTypeOf<NormalizedMetric['invalidReason']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NormalizedMetric['derivedFields']>().toEqualTypeOf<
      DerivedMetricField[] | undefined
    >();
  });

  it('keeps ProviderSnapshot shaped exactly as spec §8.4 defines it', () => {
    expectTypeOf<ProviderSnapshot['providerId']>().toEqualTypeOf<string>();
    expectTypeOf<ProviderSnapshot['collectedAt']>().toEqualTypeOf<number>();
    expectTypeOf<ProviderSnapshot['planName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ProviderSnapshot['metrics']>().toEqualTypeOf<NormalizedMetric[]>();
  });

  it('rejects out-of-enum and missing required values at compile time', () => {
    const base = validMetric();
    // @ts-expect-error limitType is closed: 'HOURLY' is not a LimitType
    const wrongLimitType: NormalizedMetric = { ...base, limitType: 'HOURLY' };
    // @ts-expect-error unit is closed: 'TOKENS_PER_SECOND' is not a MetricUnit
    const wrongUnit: NormalizedMetric = { ...base, unit: 'TOKENS_PER_SECOND' };
    // @ts-expect-error derivedFields is closed: 'resetsAt' is not a derivable field
    const wrongDerived: NormalizedMetric = { ...base, derivedFields: ['resetsAt'] };
    // @ts-expect-error isValid is a required boolean
    const missingValidity: NormalizedMetric = { ...base, isValid: undefined };
    expect([wrongLimitType, wrongUnit, wrongDerived, missingValidity]).toHaveLength(4);
  });
});

describe('findNormalizedMetricProblems', () => {
  it('accepts every happy path the spec describes', () => {
    expect(findNormalizedMetricProblems(validMetric())).toEqual([]);
    expect(findNormalizedMetricProblems(percentOnlyMetric)).toEqual([]);
    expect(findNormalizedMetricProblems(invalidMetric)).toEqual([]);
  });

  it('accepts derived fields when the derived values are actually set', () => {
    const derived = validMetric({
      derivedFields: ['remaining', 'percentUsed', 'percentRemaining'],
    });
    expect(findNormalizedMetricProblems(derived)).toEqual([]);
  });

  it('lets invalid metrics keep their window and reset metadata (D-010)', () => {
    // "Stored without numeric values" (spec §8.4) covers the quota-value
    // fields; windowSeconds/resetsAt are metadata a failed reading may keep.
    const metric: NormalizedMetric = {
      ...invalidMetric,
      windowSeconds: 18_000,
      resetsAt: Date.UTC(2026, 9, 29, 18, 0, 0),
    };
    expect(findNormalizedMetricProblems(metric)).toEqual([]);
  });

  it('rejects a valid metric without any numeric value (spec §11.2)', () => {
    const metric = validMetric({
      used: undefined,
      remaining: undefined,
      limit: undefined,
      percentUsed: undefined,
      percentRemaining: undefined,
    });
    expect(findNormalizedMetricProblems(metric)).toEqual([
      'metric: a valid metric must supply at least one numeric value',
    ]);
  });

  it('rejects an invalid metric that still carries numeric values (spec §8.4)', () => {
    const metric: NormalizedMetric = { ...invalidMetric, used: 0, percentUsed: 0 };
    expect(findNormalizedMetricProblems(metric)).toEqual([
      'used, percentUsed: an invalid metric must not carry numeric values',
    ]);
  });

  it('rejects an invalid metric without a usable invalidReason (spec §8.4)', () => {
    expect(findNormalizedMetricProblems({ ...invalidMetric, invalidReason: undefined })).toEqual([
      'invalidReason: required when the metric is invalid',
    ]);
    expect(findNormalizedMetricProblems({ ...invalidMetric, invalidReason: '   ' })).toEqual([
      'invalidReason: required when the metric is invalid',
    ]);
    expect(
      findNormalizedMetricProblems({
        ...invalidMetric,
        invalidReason: 42,
      } as unknown as NormalizedMetric),
    ).toEqual(['invalidReason: required when the metric is invalid']);
  });

  it('rejects non-finite numeric values', () => {
    const metric = validMetric({ used: Number.NaN, resetsAt: Number.POSITIVE_INFINITY });
    expect(findNormalizedMetricProblems(metric)).toEqual([
      'used: must be a finite number',
      'resetsAt: must be a finite number',
    ]);
  });

  it('rejects derived field names that are unknown or unset', () => {
    const unknownName = validMetric({
      derivedFields: ['windowSeconds' as unknown as DerivedMetricField],
    });
    expect(findNormalizedMetricProblems(unknownName)).toEqual([
      "derivedFields[0]: 'windowSeconds' is not a derivable field name",
    ]);

    const unsetField = validMetric({ used: undefined, derivedFields: ['used'] });
    expect(findNormalizedMetricProblems(unsetField)).toEqual([
      "derivedFields[0]: 'used' is marked as derived but the field is not set",
    ]);

    const duplicated = validMetric({ derivedFields: ['used', 'used'] });
    expect(findNormalizedMetricProblems(duplicated)).toEqual([
      "derivedFields[1]: 'used' is listed more than once",
    ]);
  });

  it('reports every problem of a malformed metric', () => {
    const garbage = {
      key: '',
      label: 5,
      limitType: 'HOUR',
      unit: 'token',
      windowSeconds: 'x',
      used: Number.NaN,
      isValid: 'yes',
      derivedFields: 'nope',
    } as unknown as NormalizedMetric;
    expect(findNormalizedMetricProblems(garbage)).toEqual([
      'key: must be a non-empty string',
      'label: must be a non-empty string',
      'limitType: must be one of ROLLING_WINDOW, DAILY, WEEKLY, MONTHLY, OTHER',
      'unit: must be one of TOKENS, CREDITS, REQUESTS, PERCENT',
      'used: must be a finite number',
      'windowSeconds: must be a finite number',
      'isValid: must be a boolean',
      'derivedFields: must be an array of field names',
    ]);
  });
});

describe('findProviderSnapshotProblems', () => {
  it('accepts a snapshot with several valid metrics', () => {
    const snapshot = validSnapshot({ metrics: [validMetric(), percentOnlyMetric, invalidMetric] });
    expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
  });

  it('reports metric problems addressed by position', () => {
    const snapshot = validSnapshot({ metrics: [validMetric(), validMetric({ key: '' })] });
    expect(findProviderSnapshotProblems(snapshot)).toEqual([
      'metrics[1].key: must be a non-empty string',
    ]);
  });

  it('rejects duplicate metric keys within one snapshot (spec §11.2 series identity)', () => {
    const snapshot = validSnapshot({ metrics: [validMetric(), validMetric()] });
    expect(findProviderSnapshotProblems(snapshot)).toEqual([
      "metrics[1].key: duplicate metric key 'zai-five-hour'",
    ]);
  });

  it('rejects a broken provider id and collection time', () => {
    expect(findProviderSnapshotProblems(validSnapshot({ providerId: '  ' }))).toEqual([
      'providerId: must be a non-empty string',
    ]);
    expect(findProviderSnapshotProblems(validSnapshot({ collectedAt: Number.NaN }))).toEqual([
      'collectedAt: must be a finite UTC epoch-milliseconds timestamp',
    ]);
  });

  it('rejects a planName that is not a non-empty string', () => {
    expect(findProviderSnapshotProblems(validSnapshot({ planName: '' }))).toEqual([
      'planName: must be a non-empty string when present',
    ]);
    expect(
      findProviderSnapshotProblems(validSnapshot({ planName: 42 } as unknown as ProviderSnapshot)),
    ).toEqual(['planName: must be a non-empty string when present']);
  });

  it('rejects a non-array metrics field outright', () => {
    const snapshot = validSnapshot({ metrics: undefined as unknown as NormalizedMetric[] });
    expect(findProviderSnapshotProblems(snapshot)).toEqual([
      'metrics: must be an array of normalized metrics',
    ]);
  });

  it('rejects entries that are not metric objects', () => {
    const snapshot = validSnapshot({ metrics: [null] as unknown as NormalizedMetric[] });
    expect(findProviderSnapshotProblems(snapshot)).toEqual(['metrics[0]: must be a metric object']);
  });
});
