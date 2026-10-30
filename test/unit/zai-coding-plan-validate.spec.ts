import { describe, expect, it } from 'vitest';
import {
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
  classifyCredentialCheckFailure,
  CredentialCheckError,
  CredentialsRejectedError,
  ProviderUnavailableError,
  validateZaiCredentials,
} from '../../src/providers/zai-coding-plan/validate';
import { createAccountContext } from '../../src/providers/registry';

/**
 * Locks the credential-check classification (spec §8.1, §8.3; task 098,
 * decision D-052): the pure seam over D-042's transport taxonomy and the
 * two-error vocabulary `validateCredentials` rejects with. The three
 * distinct results of the task's done-condition are pinned here at the
 * classification level; the end-to-end paths through the mock provider
 * server live in test/integration/zai-coding-plan-validate.spec.ts.
 */

describe('classifyCredentialCheckFailure', () => {
  describe('HTTP 401/403 reject the credentials (dossier assumption A3)', () => {
    for (const status of [401, 403] as const) {
      it(`classifies HTTP ${status} as credentials-rejected`, () => {
        const result = classifyCredentialCheckFailure(
          new TransportStatusError(status, 'Unauthorized', undefined),
        );

        expect(result).toBeInstanceOf(CredentialsRejectedError);
        expect(result).toBeInstanceOf(CredentialCheckError);
        expect(result.kind).toBe('credentials-rejected');
        expect(result).toMatchObject({ httpStatus: status });
        expect(result.message).toBe(
          `the provider rejected the account credentials (HTTP ${status})`,
        );
      });
    }
  });

  describe('every other transport failure is unavailability, not a rejection', () => {
    it('classifies non-401/403 statuses as provider-unavailable and retains the status', () => {
      // 429 is the A3 boundary that matters most: rate limiting is a
      // "try later" answer, not a verdict on the key.
      for (const status of [400, 404, 429, 500, 503]) {
        const result = classifyCredentialCheckFailure(
          new TransportStatusError(status, 'No', undefined),
        );

        expect(result).toBeInstanceOf(ProviderUnavailableError);
        expect(result.kind).toBe('provider-unavailable');
        expect(result).toMatchObject({ httpStatus: status, transportKind: 'http-status' });
      }
    });

    it('classifies each response-less transport kind as provider-unavailable', () => {
      const cases: readonly [TransportError, string][] = [
        [new TransportTimeoutError(15_000), 'timeout'],
        [new TransportDnsError('ENOTFOUND'), 'dns'],
        [new TransportConnectionError('ECONNREFUSED'), 'connection'],
        [new TransportSocketError('UND_ERR_SOCKET'), 'socket'],
        [new TransportNetworkError(undefined), 'network'],
        [new TransportResponseTooLargeError(65_536), 'response-too-large'],
        [new TransportContentTypeError('text/plain'), 'content-type'],
      ];

      for (const [error, kind] of cases) {
        const result = classifyCredentialCheckFailure(error);

        expect(result).toBeInstanceOf(ProviderUnavailableError);
        expect(result.kind).toBe('provider-unavailable');
        expect(result).toMatchObject({ transportKind: kind, httpStatus: undefined });
        expect(result.message).toBe(
          `the credential check could not be completed: ${error.message}`,
        );
      }
    });

    it('stays total on a base-class http-status error (no status to read)', () => {
      // classifyTransportError (task 105) fails fast on this shape; the
      // credential check has no per-kind switch, so the same shape simply
      // reads unavailability with the kind retained.
      const result = classifyCredentialCheckFailure(
        new TransportError('http-status', 'provider responded oddly'),
      );

      expect(result).toBeInstanceOf(ProviderUnavailableError);
      expect(result).toMatchObject({ transportKind: 'http-status', httpStatus: undefined });
    });
  });
});

describe('credential-check errors', () => {
  it('carry provider-neutral names and the structural kind discriminant', () => {
    const rejected = new CredentialsRejectedError(401);
    const unavailable = new ProviderUnavailableError(new TransportTimeoutError(50));

    for (const error of [rejected, unavailable]) {
      expect(error).toBeInstanceOf(CredentialCheckError);
      expect(error).toBeInstanceOf(Error);
      expect(error.kind).toBe(error === rejected ? 'credentials-rejected' : 'provider-unavailable');
    }
    expect(rejected.name).toBe('CredentialsRejectedError');
    expect(unavailable.name).toBe('ProviderUnavailableError');
  });

  it('compose messages only from static English and the transport error text', () => {
    const cause = new TransportStatusError(503, 'Service Unavailable', undefined);
    const error = new ProviderUnavailableError(cause);

    expect(error.message).toBe(
      'the credential check could not be completed: provider responded with HTTP 503 Service Unavailable',
    );
    expect(error.cause).toBeUndefined();
  });
});

describe('validateZaiCredentials', () => {
  it('lets non-transport failures (wiring bugs) through undressed, loud', async () => {
    // An invalid URL fails providerFetch's own input validation before any
    // network is touched — the TypeError must stay a TypeError, not be
    // dressed up as a credential-check outcome (review finding P2).
    const account = createAccountContext('acc-1', 'Work plan', 'sk-test');

    const error = await validateZaiCredentials(account, {
      url: 'not a url',
      timeoutMs: 1_000,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(CredentialCheckError);
  });
});
