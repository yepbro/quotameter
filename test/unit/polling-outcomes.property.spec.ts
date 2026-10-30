import { describe, expect, it } from 'vitest';
import { TransportStatusError } from '../../src/providers/transport';
import {
  classifyTransportError,
  isCollectionOutcome,
  RETRYABLE_OUTCOMES,
  STATUS_CONTRIBUTION_BY_OUTCOME,
} from '../../src/services/polling-outcomes';
import { fc } from '../helpers/property';

/**
 * Property pins over the one open-ended input: the HTTP status (task 105,
 * spec §7.2). For every status the §11.2 `http_status` column can hold
 * (100–599, D-034's CHECK range), the classifier must be total, deterministic,
 * spec-coherent, and must always retain the status.
 */

/** The §7.2 class rule for a status, expressed independently of the module. */
function expectedOutcomeClass(
  status: number,
): 'auth_error' | 'rate_limited' | 'server_error' | 'parse_error' {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  return 'parse_error';
}

const httpStatus = fc.integer({ min: 100, max: 599 });

describe('classifyTransportError over the status space (property)', () => {
  it('classifies every status 100–599 into the §7.2 class and keeps the status', () => {
    fc.assert(
      fc.property(
        httpStatus,
        fc.option(fc.string({ minLength: 0, maxLength: 24 })),
        (status, retryAfter) => {
          const error = new TransportStatusError(
            status,
            'Status',
            retryAfter === null ? undefined : retryAfter,
          );
          const result = classifyTransportError(error);
          expect(result.outcome).toBe(expectedOutcomeClass(status));
          expect(result.httpStatus).toBe(status);
          expect(result.retryAfterRaw).toBe(retryAfter === null ? undefined : retryAfter);
          // The §7.2/§7.3 metadata always agrees with the pinned tables.
          if (!isCollectionOutcome(result.outcome)) {
            throw new Error(`a status error classified as '${result.outcome}'`);
          }
          expect(result.retryable).toBe(RETRYABLE_OUTCOMES.has(result.outcome));
          expect(result.statusContribution).toBe(STATUS_CONTRIBUTION_BY_OUTCOME[result.outcome]);
          expect(result.retryAfterEligible).toBe(result.outcome === 'rate_limited');
          expect(result.errorMessage).toBe(error.message);
        },
      ),
    );
  });

  it('emits only members of the §11.2 enum', () => {
    fc.assert(
      fc.property(httpStatus, (status) => {
        const classified = classifyTransportError(new TransportStatusError(status, '', undefined));
        expect(isCollectionOutcome(classified.outcome)).toBe(true);
      }),
    );
  });

  it('is deterministic: identical errors classify identically', () => {
    fc.assert(
      fc.property(httpStatus, (status) => {
        const make = () => classifyTransportError(new TransportStatusError(status, 'S', '1'));
        expect(make()).toEqual(make());
      }),
    );
  });
});
