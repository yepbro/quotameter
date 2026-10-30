import { describe, expect, it } from 'vitest';
import {
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportDnsError,
  TransportError,
  TransportNetworkError,
  TransportResponseTooLargeError,
  TransportSocketError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import {
  classifyParseFailure,
  classifySuccess,
  classifyTransportError,
  COLLECTION_OUTCOMES,
  FAILURE_STATUS_PRECEDENCE,
  isCollectionOutcome,
  RETRYABLE_OUTCOMES,
  STATUS_CONTRIBUTION_BY_OUTCOME,
} from '../../src/services/polling-outcomes';
import type { ParseFailureInput } from '../../src/services/polling-outcomes';

/**
 * Task 105's done-condition (spec §7.2, §7.3): the classifier maps every
 * transport kind and HTTP status class to the §11.2 outcome enum, carries
 * the §7.2 metadata (status retention, raw `Retry-After` passthrough and
 * eligibility, retryability), and exposes the §7.3 status-priority input —
 * the precedence array and the outcome→contribution table task 111
 * consumes. Enum parity with the landed `collection_runs` CHECK is pinned
 * executably in `test/integration/polling-outcomes.spec.ts`.
 */

/** Every `statusContribution` the tables and classifiers can produce. */
const ALL_CONTRIBUTIONS = new Set<string>([...FAILURE_STATUS_PRECEDENCE, 'none']);

/** One network-family error per D-042 kind, with a distinct cause code. */
const NETWORK_FAMILY_ERRORS = [
  new TransportDnsError('ENOTFOUND'),
  new TransportConnectionError('ECONNREFUSED'),
  new TransportSocketError('ECONNRESET'),
  new TransportNetworkError('UND_ERR_CONNECT_TIMEOUT'),
] as const;

describe('polling-outcomes vocabulary (spec §11.2, §7.3)', () => {
  it('COLLECTION_OUTCOMES is exactly the seven §11.2/D-034 values, once each', () => {
    expect([...COLLECTION_OUTCOMES]).toEqual([
      'success',
      'auth_error',
      'rate_limited',
      'network_error',
      'timeout',
      'server_error',
      'parse_error',
    ]);
    // A frozen unique list: no late additions, no duplicates.
    expect(new Set(COLLECTION_OUTCOMES).size).toBe(COLLECTION_OUTCOMES.length);
    expect(Object.isFrozen(COLLECTION_OUTCOMES)).toBe(true);
  });

  it('FAILURE_STATUS_PRECEDENCE is §7.3 ranks 1–3 in order', () => {
    expect([...FAILURE_STATUS_PRECEDENCE]).toEqual([
      'auth-rejected',
      'format-changed',
      'unreachable',
    ]);
    expect(Object.isFrozen(FAILURE_STATUS_PRECEDENCE)).toBe(true);
  });

  it('STATUS_CONTRIBUTION_BY_OUTCOME covers exactly the seven outcomes', () => {
    expect(new Set(Object.keys(STATUS_CONTRIBUTION_BY_OUTCOME))).toEqual(
      new Set(COLLECTION_OUTCOMES),
    );
  });

  it('every contribution is a §7.3 failure status or none', () => {
    for (const contribution of Object.values(STATUS_CONTRIBUTION_BY_OUTCOME)) {
      expect(ALL_CONTRIBUTIONS.has(contribution)).toBe(true);
    }
  });

  it('RETRYABLE_OUTCOMES is §7.2 first row: network, timeout, 5xx only', () => {
    expect([...RETRYABLE_OUTCOMES].sort()).toEqual(['network_error', 'server_error', 'timeout']);
  });
});

describe('classifyTransportError (spec §7.2, task 104 taxonomy)', () => {
  it('maps every network-family kind to network_error, retryable, unreachable', () => {
    for (const error of NETWORK_FAMILY_ERRORS) {
      const result = classifyTransportError(error);
      expect(result).toEqual({
        outcome: 'network_error',
        httpStatus: undefined,
        retryAfterRaw: undefined,
        retryAfterEligible: false,
        retryable: true,
        statusContribution: 'unreachable',
        errorMessage: error.message,
      });
    }
  });

  it('maps the timeout kind to the timeout outcome', () => {
    const error = new TransportTimeoutError(15_000);
    expect(classifyTransportError(error)).toEqual({
      outcome: 'timeout',
      httpStatus: undefined,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: true,
      statusContribution: 'unreachable',
      errorMessage: error.message,
    });
  });

  it.each([401, 403])('maps HTTP %i to auth_error, no retry, auth-rejected', (status) => {
    const error = new TransportStatusError(status, 'Unauthorized', undefined);
    expect(classifyTransportError(error)).toEqual({
      outcome: 'auth_error',
      httpStatus: status,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: false,
      statusContribution: 'auth-rejected',
      errorMessage: error.message,
    });
  });

  it('maps HTTP 429 to rate_limited, no retry, and no status contribution', () => {
    const error = new TransportStatusError(429, 'Too Many Requests', undefined);
    expect(classifyTransportError(error)).toEqual({
      outcome: 'rate_limited',
      httpStatus: 429,
      retryAfterRaw: undefined,
      retryAfterEligible: true,
      retryable: false,
      statusContribution: 'none',
      errorMessage: error.message,
    });
  });

  it.each([500, 502, 503, 599])('maps HTTP %i to server_error, retryable', (status) => {
    const error = new TransportStatusError(status, 'Server Error', undefined);
    expect(classifyTransportError(error)).toEqual({
      outcome: 'server_error',
      httpStatus: status,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: true,
      statusContribution: 'unreachable',
      errorMessage: error.message,
    });
  });

  it.each([400, 402, 404, 405, 410, 418, 422, 428, 451, 499])(
    'maps unexpected HTTP %i to parse_error (Format changed), not retryable',
    (status) => {
      const error = new TransportStatusError(status, 'Not Found', undefined);
      expect(classifyTransportError(error)).toEqual({
        outcome: 'parse_error',
        httpStatus: status,
        retryAfterRaw: undefined,
        retryAfterEligible: false,
        retryable: false,
        statusContribution: 'format-changed',
        errorMessage: error.message,
      });
    },
  );

  it('is total for statuses providerFetch cannot produce (1xx/3xx)', () => {
    for (const status of [100, 204, 301, 308]) {
      const result = classifyTransportError(new TransportStatusError(status, '', undefined));
      expect(result.outcome).toBe('parse_error');
      expect(result.httpStatus).toBe(status);
    }
  });

  it('retains the raw Retry-After and marks only 429 eligible (§7.2)', () => {
    // A 429 with the header: raw passthrough, eligible for task 107.
    expect(
      classifyTransportError(new TransportStatusError(429, 'Too Many Requests', '37')),
    ).toMatchObject({ retryAfterRaw: '37', retryAfterEligible: true });

    // A 5xx may carry Retry-After, but §7.2 sanctions deferral only for 429.
    expect(
      classifyTransportError(new TransportStatusError(503, 'Unavailable', '120')),
    ).toMatchObject({ retryAfterRaw: '120', retryAfterEligible: false });

    // A 401 carries whatever header arrived but is never eligible.
    expect(
      classifyTransportError(new TransportStatusError(401, 'Unauthorized', '5')),
    ).toMatchObject({ retryAfterRaw: '5', retryAfterEligible: false });
  });

  it('retains the transport error message verbatim as sanitized evidence', () => {
    const error = new TransportStatusError(429, 'Too Many Requests', undefined);
    expect(classifyTransportError(error).errorMessage).toBe(error.message);
    expect(classifyTransportError(new TransportNetworkError('ECONNRESET')).errorMessage).toBe(
      'provider network request failed (ECONNRESET)',
    );
  });

  it.each([
    { error: new TransportResponseTooLargeError(65_536), label: 'response-too-large' },
    { error: new TransportContentTypeError('text/html'), label: 'content-type' },
  ])('maps the $label kind to parse_error without a retained status', ({ error }) => {
    expect(classifyTransportError(error)).toEqual({
      outcome: 'parse_error',
      httpStatus: undefined,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: false,
      statusContribution: 'format-changed',
      errorMessage: error.message,
    });
  });

  it('classifies a caller abort as cancelled — not a provider outcome', () => {
    const error = new TransportAbortError();
    expect(classifyTransportError(error)).toEqual({
      outcome: 'cancelled',
      httpStatus: undefined,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: false,
      statusContribution: 'none',
      errorMessage: error.message,
    });
  });

  it('rejects an http-status kind without TransportStatusError evidence', () => {
    // A base-class construction carries no status to classify; guessing a
    // network failure would silently make it retryable (review finding).
    const bare = new TransportError('http-status', 'provider responded');
    expect(() => classifyTransportError(bare)).toThrow(
      'classifyTransportError: kind http-status requires a TransportStatusError',
    );
  });

  it('rejects a TransportStatusError status outside §11.2 range', () => {
    for (const status of [99, 600]) {
      expect(() =>
        classifyTransportError(new TransportStatusError(status, 'Odd', undefined)),
      ).toThrow(TypeError);
    }
  });
});

describe('classifyParseFailure (spec §7.2 Format changed)', () => {
  it('maps a parse failure with its delivered status to parse_error', () => {
    const failure: ParseFailureInput = {
      httpStatus: 200,
      reason: 'payload did not match the expected schema',
    };
    expect(classifyParseFailure(failure)).toEqual({
      outcome: 'parse_error',
      httpStatus: 200,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: false,
      statusContribution: 'format-changed',
      errorMessage: 'payload did not match the expected schema',
    });
  });

  it('accepts a parse failure without a status (§11.2 http_status is nullable)', () => {
    expect(classifyParseFailure({ reason: 'response body was not valid JSON' })).toEqual(
      expect.objectContaining({
        outcome: 'parse_error',
        httpStatus: undefined,
        statusContribution: 'format-changed',
        retryable: false,
      }),
    );
  });

  it('rejects a blank reason (fail-fast wiring check)', () => {
    expect(() => classifyParseFailure({ reason: '' })).toThrow(TypeError);
    expect(() => classifyParseFailure({ reason: '   ' })).toThrow(
      'classifyParseFailure: reason must be a non-empty string',
    );
  });

  it('rejects a status outside §11.2 range', () => {
    for (const httpStatus of [0, 99, 600, 20.5, Number.NaN]) {
      expect(() => classifyParseFailure({ httpStatus, reason: 'x' })).toThrow(TypeError);
    }
  });
});

describe('classifySuccess', () => {
  it('produces a clean success classification with the status retained', () => {
    expect(classifySuccess(200)).toEqual({
      outcome: 'success',
      httpStatus: 200,
      retryAfterRaw: undefined,
      retryAfterEligible: false,
      retryable: false,
      statusContribution: 'none',
      errorMessage: undefined,
    });
  });

  it('accepts an absent status', () => {
    expect(classifySuccess()).toEqual(expect.objectContaining({ outcome: 'success' }));
    expect(classifySuccess().httpStatus).toBeUndefined();
  });

  it('rejects a status outside §11.2 range', () => {
    expect(() => classifySuccess(99)).toThrow(TypeError);
    expect(() => classifySuccess(600)).toThrow('classifySuccess: httpStatus must be');
  });
});

describe('classification coherence with the pinned tables', () => {
  /** One classification per outcome source, for table-wide assertions. */
  const sampleClassifications = [
    classifySuccess(200),
    classifyTransportError(new TransportStatusError(401, 'Unauthorized', undefined)),
    classifyTransportError(new TransportStatusError(429, 'Too Many Requests', '37')),
    ...NETWORK_FAMILY_ERRORS.map((error) => classifyTransportError(error)),
    classifyTransportError(new TransportTimeoutError(15_000)),
    classifyTransportError(new TransportStatusError(503, 'Unavailable', undefined)),
    classifyTransportError(new TransportContentTypeError('text/html')),
    classifyParseFailure({ httpStatus: 200, reason: 'unexpected schema' }),
  ];

  it('every emitted outcome is a member of the §11.2 enum', () => {
    for (const classification of sampleClassifications) {
      expect(isCollectionOutcome(classification.outcome)).toBe(true);
    }
  });

  it('retryable, contribution, and eligibility always agree with the tables', () => {
    for (const classification of sampleClassifications) {
      if (!isCollectionOutcome(classification.outcome)) {
        throw new Error(`sample set must not contain '${classification.outcome}'`);
      }
      expect(classification.retryable).toBe(RETRYABLE_OUTCOMES.has(classification.outcome));
      expect(classification.statusContribution).toBe(
        STATUS_CONTRIBUTION_BY_OUTCOME[classification.outcome],
      );
      expect(classification.retryAfterEligible).toBe(classification.outcome === 'rate_limited');
    }
  });

  it('§7.3 precedence ranks the three failure contributions correctly', () => {
    const rank = (status: string): number =>
      (FAILURE_STATUS_PRECEDENCE as readonly string[]).indexOf(status);
    // §7.3's order 1–3, verbatim, and nothing else ranks.
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.auth_error)).toBe(0);
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.parse_error)).toBe(1);
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.network_error)).toBe(2);
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.timeout)).toBe(2);
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.server_error)).toBe(2);
    // `rate_limited` and `success` contribute no failure status at all.
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.rate_limited)).toBe(-1);
    expect(rank(STATUS_CONTRIBUTION_BY_OUTCOME.success)).toBe(-1);
  });
});
