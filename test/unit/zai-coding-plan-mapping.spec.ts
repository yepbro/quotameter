import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapQuotaLimitData } from '../../src/providers/zai-coding-plan/mapping';
import {
  parseQuotaLimitBody,
  parseSubscriptionContext,
  SnapshotParseError,
} from '../../src/providers/zai-coding-plan/snapshot';
import { findProviderSnapshotProblems, type ProviderSnapshot } from '../../src/schemas/metrics';

/**
 * Pure-parse matrix of the Z.ai quota-limit contract (spec §8.3, §8.4, §17.1;
 * task 099, decisions D-047/D-049/D-053): every sanitized and synthetic
 * fixture body drives the strict parse (envelope + containers) and the
 * tolerant mapping, plus the in-test mutations the fixture README records
 * as deliberately unfixtured. Sanitized bodies are asserted by shape,
 * vocabulary, and arithmetic — never by value; synthetic values are
 * git-stable and asserted exactly. No HTTP here: the fetch path is covered
 * by test/integration/zai-coding-plan-snapshot.spec.ts.
 */

const SECRETS = ['qm-mapping-marker'] as const;

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const quotaFixture = (name: string): string => fixture(`synthetic/${name}`);

/** Parses a fixture body and applies one mutation, in-test per D-049. */
const mutated = (name: string, mutate: (value: Record<string, unknown>) => void): string => {
  const parsed = JSON.parse(quotaFixture(name)) as Record<string, unknown>;
  mutate(parsed);
  return JSON.stringify(parsed);
};

/** The static reason every parse violation is expected to carry. */
function parseErrorOf(body: string): SnapshotParseError {
  try {
    parseQuotaLimitBody(body, 200, SECRETS);
  } catch (error) {
    if (error instanceof SnapshotParseError) return error;
    throw new Error(`expected SnapshotParseError, got: ${String(error)}`, { cause: error });
  }
  throw new Error('expected parseQuotaLimitBody to throw, but it resolved');
}

/** Wraps a mapping result as a snapshot for the invariant check. */
const asSnapshot = (metrics: ProviderSnapshot['metrics']): ProviderSnapshot => ({
  providerId: 'zai-coding-plan',
  collectedAt: 0,
  metrics,
});

describe('parseQuotaLimitBody — envelope and container strictness', () => {
  it('accepts every envelope success spelling and unwraps data', () => {
    for (const name of [
      'zai-envelope-code-string.json',
      'zai-envelope-code-zero.json',
      'zai-quota-limit-empty-limits.json',
    ]) {
      const result = parseQuotaLimitBody(quotaFixture(name), 200, SECRETS);
      expect(result.metrics).toEqual([]);
      expect(result.planName).toBe('pro');
      expect(result.skips).toEqual([]);
    }
  });

  it('accepts the number-200 spelling on the sanitized capture body (A6 body, shapes only)', () => {
    const result = parseQuotaLimitBody(fixture('sanitized/zai-quota-limit.json'), 200, SECRETS);
    // Shape, vocabulary, and arithmetic — sanitized values may be re-invented.
    expect(result.planName).toBe('pro');
    expect(result.skips).toEqual([]);
    expect(result.metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
    for (const metric of result.metrics) {
      expect(metric.isValid).toBe(true);
      if (
        metric.used !== undefined &&
        metric.remaining !== undefined &&
        metric.limit !== undefined
      ) {
        expect(metric.used + metric.remaining).toBe(metric.limit);
      }
      if (metric.percentUsed !== undefined) {
        expect(metric.percentUsed + (metric.percentRemaining ?? 0)).toBe(100);
      }
    }
    expect(findProviderSnapshotProblems(asSnapshot(result.metrics))).toEqual([]);
  });

  it('retains the delivered HTTP status on every failure', () => {
    const error = parseErrorOf(quotaFixture('zai-envelope-error.json'));
    expect(error.httpStatus).toBe(200);
  });

  it('rejects a non-success code envelope with the msg as sanitized diagnostic (A2)', () => {
    const error = parseErrorOf(quotaFixture('zai-envelope-error.json'));
    expect(error.reason).toBe('the response envelope code was not a success value');
    // The fixture's invented diagnostic text travels both raw (in the §7.4
    // payload) and extracted (the A2 envelope diagnostic).
    expect(error.envelopeMessage).toBe(
      'Synthetic diagnostic text for the envelope-failure fixture',
    );
    expect(error.sanitizedPayload).toContain('Synthetic diagnostic text');
  });

  it('rejects a missing code without inventing a diagnostic from the leftover msg', () => {
    const error = parseErrorOf(quotaFixture('zai-envelope-malformed.json'));
    expect(error.reason).toBe('the response envelope code was not a success value');
    expect(error.envelopeMessage).toBeUndefined();
    expect(error.sanitizedPayload).toContain('Operation successful');
  });

  it('scrubs the account secret from the §7.4 payload hand-off', () => {
    const body = `{"code":"${SECRETS[0]}","msg":"boom","data":null}`;
    const error = parseErrorOf(body);
    expect(error.sanitizedPayload).not.toContain(SECRETS[0]);
    expect(error.sanitizedPayload).toContain('[REDACTED]');
    expect(error.reason).not.toContain(SECRETS[0]);
    // The code is present (a wrong secret-shaped value, not a missing code),
    // so the msg is retained as the sanitized envelope diagnostic.
    expect(error.envelopeMessage).toBe('boom');
  });

  it('scrubs a secret embedded in the retained envelope msg', () => {
    const body = `{"code":7,"msg":"key ${SECRETS[0]} rejected"}`;
    const error = parseErrorOf(body);
    expect(error.envelopeMessage).not.toContain(SECRETS[0]);
    expect(error.envelopeMessage).toContain('[REDACTED]');
  });

  it('rejects invalid JSON as raw-text-sanitized payload', () => {
    const body = `not json, key ${SECRETS[0]}`;
    const error = parseErrorOf(body);
    expect(error.reason).toBe('the response body was not valid JSON');
    expect(error.sanitizedPayload).not.toContain(SECRETS[0]);
    expect(error.sanitizedPayload).toContain('[REDACTED]');
  });

  it('rejects bodies whose JSON is not an object envelope', () => {
    for (const body of ['[]', '"text"', 'null', '42']) {
      const error = parseErrorOf(body);
      expect(error.reason).toBe('the response envelope was not a JSON object');
    }
    // An empty body never reaches the envelope: it is not JSON at all.
    expect(parseErrorOf('').reason).toBe('the response body was not valid JSON');
  });

  it('rejects wrong-typed data and limits containers', () => {
    const dataNotObject = parseErrorOf(quotaFixture('zai-quota-limit-data-not-object.json'));
    expect(dataNotObject.reason).toBe('the response data was not an object');

    const limitsNotArray = parseErrorOf(quotaFixture('zai-quota-limit-limits-not-array.json'));
    expect(limitsNotArray.reason).toBe('the response limits field was not an array');
  });

  it('covers the deliberately unfixtured envelope cross-cells (D-049)', () => {
    // code: "0" — the string spelling of the other success value.
    const codeZeroString = parseQuotaLimitBody(
      mutated('zai-envelope-code-zero.json', (value) => {
        value.code = '0';
      }),
      200,
      SECRETS,
    );
    expect(codeZeroString.metrics).toEqual([]);

    // Wrong-typed code values parse-fail on the same reason as any
    // non-success code.
    for (const code of [null, true, 200.5]) {
      const error = parseErrorOf(
        mutated('zai-envelope-code-zero.json', (value) => {
          value.code = code;
        }),
      );
      expect(error.reason).toBe('the response envelope code was not a success value');
    }

    // success: false is not interpreted (the prototype keys on code alone).
    const successFalse = parseQuotaLimitBody(
      mutated('zai-envelope-code-zero.json', (value) => {
        value.success = false;
      }),
      200,
      SECRETS,
    );
    expect(successFalse.metrics).toEqual([]);

    // data: null and an absent limits key are wrong-typed containers.
    expect(
      parseErrorOf(
        mutated('zai-envelope-code-zero.json', (value) => {
          value.data = null;
        }),
      ).reason,
    ).toBe('the response data was not an object');
    expect(
      parseErrorOf(
        mutated('zai-envelope-code-zero.json', (value) => {
          value.data = {};
        }),
      ).reason,
    ).toBe('the response limits field was not an array');
  });
});

describe('parseQuotaLimitBody — mapping of the synthetic matrix', () => {
  it('maps the weekly entry (A1) with absolutes as CREDITS (A5)', () => {
    const { metrics, planName } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-weekly.json'),
      200,
      SECRETS,
    );
    expect(planName).toBe('pro');
    const weekly = metrics.find((metric) => metric.key === 'weekly-quota');
    expect(weekly).toMatchObject({
      label: 'Weekly quota',
      limitType: 'WEEKLY',
      unit: 'CREDITS',
      used: 12_000,
      remaining: 48_000,
      limit: 60_000,
      percentUsed: 20,
      percentRemaining: 80,
      resetsAt: 1_800_021_600_000,
      isValid: true,
      derivedFields: ['percentRemaining'],
    });
    const tokens = metrics.find((metric) => metric.key === 'tokens-5h');
    expect(tokens).toMatchObject({
      limitType: 'ROLLING_WINDOW',
      unit: 'PERCENT',
      percentUsed: 34,
      windowSeconds: 18_000,
    });
    expect(tokens?.used).toBeUndefined();
    expect(findProviderSnapshotProblems(asSnapshot(metrics))).toEqual([]);
  });

  it('derives the missing triple member and percentUsed from supplied absolutes (A5)', () => {
    const { metrics } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-tokens-absolute.json'),
      200,
      SECRETS,
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      key: 'tokens-5h',
      unit: 'CREDITS',
      used: 2500,
      limit: 12_000,
      remaining: 9500,
      windowSeconds: 18_000,
      isValid: true,
    });
    // The only permitted absolute→percentage direction, mirrored float math.
    expect(metrics[0]?.percentUsed).toBe((100 * 2500) / 12_000);
    expect(metrics[0]?.percentRemaining).toBe(100 - (100 * 2500) / 12_000);
    expect(metrics[0]?.derivedFields).toEqual(['remaining', 'percentUsed', 'percentRemaining']);
    // The absent nextResetTime case: resetsAt omitted, entry survives.
    expect(metrics[0]?.resetsAt).toBeUndefined();
    expect(findProviderSnapshotProblems(asSnapshot(metrics))).toEqual([]);
  });

  it('maps a partial payload: only the monthly entry present', () => {
    const { metrics, planName } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-partial.json'),
      200,
      SECRETS,
    );
    expect(planName).toBe('pro');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      key: 'mcp-monthly',
      limitType: 'MONTHLY',
      unit: 'REQUESTS',
      used: 60,
      remaining: 1140,
      limit: 1200,
      percentUsed: 5,
      resetsAt: 1_799_486_400_000,
      derivedFields: ['percentRemaining'],
    });
  });

  it('keeps the plan tier verbatim for a different plan', () => {
    const { planName } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-different-plan.json'),
      200,
      SECRETS,
    );
    expect(planName).toBe('lite');
  });

  it('ignores unknown fields at every level', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-extra-fields.json'),
      200,
      SECRETS,
    );
    expect(skips).toEqual([]);
    expect(metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
    expect(metrics[0]).toMatchObject({ used: 60, limit: 1200 });
  });

  it('skips unknown (type, unit) shapes and reports the pair', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-unknown-type.json'),
      200,
      SECRETS,
    );
    expect(metrics).toEqual([]);
    expect(skips).toEqual(["skipped unrecognized limits entry (type 'CONCURRENCY_LIMIT', unit 3)"]);
    // Envelope-valid emptiness is a valid zero-metric snapshot (§8.3).
    expect(findProviderSnapshotProblems(asSnapshot(metrics))).toEqual([]);
  });

  it('skips a known type under an unseen unit (§17.1 different-unit)', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-different-unit.json'),
      200,
      SECRETS,
    );
    expect(metrics).toEqual([]);
    expect(skips).toEqual(["skipped unrecognized limits entry (type 'TIME_LIMIT', unit 2)"]);
  });

  it('skips non-object limits entries as unrecognized shapes', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      mutated('zai-quota-limit-empty-limits.json', (value) => {
        const data = value.data as Record<string, unknown>;
        data.limits = [42, null, 'TIME_LIMIT'];
      }),
      200,
      SECRETS,
    );
    expect(metrics).toEqual([]);
    expect(skips).toEqual([
      'skipped limits entry that was not an object',
      'skipped limits entry that was not an object',
      'skipped limits entry that was not an object',
    ]);
  });

  it('resolves key collisions first-wins and reports the loser', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-duplicate-keys.json'),
      200,
      SECRETS,
    );
    expect(metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'weekly-quota']);
    // The first monthly entry (60/1140) and the TIME_LIMIT weekly spelling
    // (12000/48000) survive; the TOKENS_LIMIT weekly variant and the
    // repeated monthly pair are skipped.
    expect(metrics[0]).toMatchObject({ used: 60, remaining: 1140 });
    expect(metrics[1]).toMatchObject({ used: 12_000, remaining: 48_000 });
    expect(skips).toEqual([
      "skipped duplicate limits entry for metric key 'weekly-quota' (first entry wins)",
      "skipped duplicate limits entry for metric key 'mcp-monthly' (first entry wins)",
    ]);
  });

  it('emits invalid metrics — never zero — for unusable entries', () => {
    const { metrics, skips } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-invalid-entries.json'),
      200,
      SECRETS,
    );
    expect(skips).toEqual([]);
    const [tokens, monthly, weekly] = metrics;
    // No usable values at all: invalid, metadata retained.
    expect(tokens).toMatchObject({
      key: 'tokens-5h',
      isValid: false,
      invalidReason: 'no quota values present on limits entry',
      resetsAt: 1_798_968_000_000,
      windowSeconds: 18_000,
      unit: 'PERCENT',
    });
    // The arithmetic identity is violated: numeric values dropped.
    expect(monthly).toMatchObject({
      key: 'mcp-monthly',
      isValid: false,
      invalidReason: 'currentValue + remaining does not equal usage',
      resetsAt: 1_799_486_400_000,
      unit: 'REQUESTS',
    });
    expect(monthly?.used).toBeUndefined();
    expect(monthly?.percentUsed).toBeUndefined();
    // A string percentage is a wrong-typed value field.
    expect(weekly).toMatchObject({
      key: 'weekly-quota',
      isValid: false,
      invalidReason: 'percentage is not a number',
      unit: 'CREDITS',
    });
    expect(weekly?.percentUsed).toBeUndefined();
    expect(findProviderSnapshotProblems(asSnapshot(metrics))).toEqual([]);
  });

  it('omits resetsAt on a wrong-typed nextResetTime but keeps the entry valid', () => {
    const { metrics } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-reset-time-string.json'),
      200,
      SECRETS,
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      key: 'mcp-monthly',
      isValid: true,
      used: 60,
      limit: 1200,
      percentUsed: 5,
    });
    expect(metrics[0]?.resetsAt).toBeUndefined();
  });

  it('treats renamed value fields as absent and renamed level as no plan name', () => {
    const { metrics, planName } = parseQuotaLimitBody(
      quotaFixture('zai-quota-limit-renamed-fields.json'),
      200,
      SECRETS,
    );
    expect(planName).toBeUndefined();
    expect(metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
    for (const metric of metrics) {
      expect(metric.isValid).toBe(false);
      expect(metric.invalidReason).toBe('no quota values present on limits entry');
    }
  });
});

describe('mapQuotaLimitData — derivation and pass-through edges', () => {
  const entry = (fields: Record<string, unknown>): Record<string, unknown> => ({
    type: 'TOKENS_LIMIT',
    unit: 3,
    number: 5,
    ...fields,
  });

  it('derives limit from used + remaining, but never percentUsed from a derived limit', () => {
    const { metrics } = mapQuotaLimitData([entry({ currentValue: 30, remaining: 70 })], 'pro');
    // Derivations never chain (§8.4): limit is derived, so percentUsed —
    // which requires both used and limit *supplied* — is not.
    expect(metrics[0]).toMatchObject({ used: 30, remaining: 70, limit: 100, unit: 'CREDITS' });
    expect(metrics[0]?.percentUsed).toBeUndefined();
    expect(metrics[0]?.percentRemaining).toBeUndefined();
    expect(metrics[0]?.derivedFields).toEqual(['limit']);
  });

  it('derives used from limit + remaining without percent derivation', () => {
    const { metrics } = mapQuotaLimitData([entry({ usage: 100, remaining: 75 })], undefined);
    expect(metrics[0]).toMatchObject({ used: 25, remaining: 75, limit: 100 });
    expect(metrics[0]?.derivedFields).toEqual(['used']);
  });

  it('passes percentage through verbatim, including values beyond 100 (D-047.2)', () => {
    const { metrics } = mapQuotaLimitData([entry({ percentage: 250 })], 'pro');
    expect(metrics[0]).toMatchObject({ percentUsed: 250, percentRemaining: -150, unit: 'PERCENT' });
    expect(metrics[0]?.derivedFields).toEqual(['percentRemaining']);
  });

  it('skips the percent derivation on a zero allowance — never NaN (review P1-1)', () => {
    // A zero-limit triple satisfies the arithmetic identity, so the entry
    // is valid; dividing by the zero allowance must not fabricate
    // non-finite percentages the snapshot invariants would reject.
    const { metrics } = mapQuotaLimitData(
      [
        entry({ usage: 0, currentValue: 0, remaining: 0 }),
        entry({ type: 'TIME_LIMIT', unit: 6, usage: 0, currentValue: 5, remaining: -5 }),
      ],
      'pro',
    );
    const [allZero, negative] = metrics;
    expect(allZero).toMatchObject({
      used: 0,
      remaining: 0,
      limit: 0,
      isValid: true,
      unit: 'CREDITS',
    });
    expect(allZero?.percentUsed).toBeUndefined();
    expect(allZero?.percentRemaining).toBeUndefined();
    expect(allZero?.derivedFields).toBeUndefined();
    // The negative-remainder spelling of the same zero allowance.
    expect(negative).toMatchObject({ used: 5, remaining: -5, limit: 0, isValid: true });
    expect(negative?.percentUsed).toBeUndefined();

    // Both spellings emit an invariant-clean snapshot.
    expect(
      findProviderSnapshotProblems({
        providerId: 'zai-coding-plan',
        collectedAt: 0,
        metrics,
      } satisfies ProviderSnapshot),
    ).toEqual([]);
  });

  it('names the first wrong-typed value field in canonical order', () => {
    const { metrics } = mapQuotaLimitData([entry({ usage: '1200', percentage: '5' })], 'pro');
    expect(metrics[0]?.invalidReason).toBe('usage is not a number');
  });

  it('treats non-finite numbers as wrong-typed values', () => {
    const { metrics } = mapQuotaLimitData([entry({ percentage: Number.NaN })], 'pro');
    expect(metrics[0]?.invalidReason).toBe('percentage is not a number');
  });

  it('drops the windowSeconds metadata only when number is unusable', () => {
    const noNumber = mapQuotaLimitData([entry({ percentage: 5 })], 'pro').metrics[0];
    expect(noNumber?.windowSeconds).toBe(18_000);

    const stringNumber = mapQuotaLimitData([entry({ percentage: 5, number: '5' })], 'pro')
      .metrics[0];
    expect(stringNumber?.windowSeconds).toBeUndefined();
    expect(stringNumber?.isValid).toBe(true);
  });

  it('treats a non-string or empty level as an absent plan name, verbatim otherwise', () => {
    for (const level of [undefined, 42, null, '']) {
      const { planName } = mapQuotaLimitData([], level);
      expect(planName).toBeUndefined();
    }
    // Verbatim pass-through: whitespace and casing are the provider's
    // spelling — never trimmed, never lower-cased.
    expect(mapQuotaLimitData([], '  Pro  ').planName).toBe('  Pro  ');
  });

  it('recognizes both weekly type spellings but collapses them first-wins', () => {
    const { metrics, skips } = mapQuotaLimitData(
      [
        entry({ type: 'TIME_LIMIT', unit: 6, percentage: 30 }),
        entry({ type: 'TOKENS_LIMIT', unit: 6, percentage: 60 }),
      ],
      'pro',
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.percentUsed).toBe(30);
    expect(skips).toEqual([
      "skipped duplicate limits entry for metric key 'weekly-quota' (first entry wins)",
    ]);
  });
});

describe('parseSubscriptionContext — endpoint 2 soft parsing (A9)', () => {
  it('selects the inCurrentPeriod record when the rules coincide (sanitized)', () => {
    const context = parseSubscriptionContext(fixture('sanitized/zai-subscription-list.json'));
    expect(context).toEqual({ outcome: 'parsed', planName: 'GLM Coding Pro' });
  });

  it('prefers inCurrentPeriod over the first VALID record when they diverge', () => {
    const context = parseSubscriptionContext(quotaFixture('zai-subscription-list-divergent.json'));
    expect(context).toEqual({ outcome: 'parsed', planName: 'GLM Coding Max' });
  });

  it('falls back to the first VALID record when none is in the current period', () => {
    const body = JSON.stringify({
      code: 200,
      data: [
        { productName: 'First Valid', status: 'VALID', inCurrentPeriod: false },
        { productName: 'Later', status: 'VALID', inCurrentPeriod: false },
      ],
    });
    expect(parseSubscriptionContext(body)).toEqual({
      outcome: 'parsed',
      planName: 'First Valid',
    });
  });

  it('reports no plan name when no record qualifies or the name is not a string', () => {
    const none = JSON.stringify({ code: 200, data: [{ productName: 'X', status: 'EXPIRED' }] });
    expect(parseSubscriptionContext(none)).toEqual({ outcome: 'parsed', planName: undefined });

    const notAString = JSON.stringify({
      code: 200,
      data: [{ productName: 7, status: 'VALID' }],
    });
    expect(parseSubscriptionContext(notAString)).toEqual({
      outcome: 'parsed',
      planName: undefined,
    });
  });

  it('degrades softly on wrong-typed containers and bad envelopes', () => {
    expect(
      parseSubscriptionContext(quotaFixture('zai-subscription-list-data-not-array.json')),
    ).toEqual({ outcome: 'violated', reason: 'the response data was not an array' });
    expect(parseSubscriptionContext(quotaFixture('zai-envelope-error.json'))).toEqual({
      outcome: 'violated',
      reason: 'the response envelope code was not a success value',
    });
    expect(parseSubscriptionContext('not json')).toEqual({
      outcome: 'violated',
      reason: 'the response body was not valid JSON',
    });
    expect(parseSubscriptionContext('[]')).toEqual({
      outcome: 'violated',
      reason: 'the response envelope was not a JSON object',
    });
  });
});
