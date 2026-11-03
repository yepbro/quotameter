import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MUTATION_HEADERS,
  expectApiError,
  paddedJsonOfExactLength,
  startComposedApi,
  sweepIso,
  withComposedApi,
  DAY_MS,
  SWEEP_NOW,
  type ComposedApi,
  type StartedComposedApi,
  type SweepResponse,
} from '../helpers/composedApi';
import type { ApiErrorCode } from '../../src/schemas/api/error';
import { HTTP_BODY_LIMIT_BYTES } from '../../src/server/http';

/**
 * Task 164's error-envelope conformity sweep (§13, decision D-113): every
 * error class the REAL endpoints can produce — through the production
 * composition over a real temp `node:sqlite` database — answers the one
 * common `{error: {code, message, details}}` envelope with a registry
 * code, a non-empty message, and no secret or internal path anywhere in
 * the body. The api-errors suite pins the envelope's native-shape
 * normalization against test routes; the per-family suites pin their own
 * rejections' semantics; this sweep proves the CLASSES across the
 * surface: VALIDATION (query, body, and range arms), NOT_FOUND (unknown
 * account and unmatched route), the four FORBIDDEN reasons of the §15
 * layers, UNAUTHENTICATED (the D-121 fail-closed arm as it behaves
 * today), UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE, and URI_TOO_LONG.
 *
 * Every case also asserts the two §13/§15.4 message disciplines against
 * the live markers: no API key on the wire, no temp-directory path in
 * the message (the sweep knows the exact temp root the composition
 * created).
 */

/** The §15.4 marker key the seed account stores. */
const MARKER_KEY = 'sk-sweep-errors-c47d10';

/** A range pair the §13 range endpoints accept. */
const FROM = sweepIso(SWEEP_NOW - 2 * DAY_MS);
const TO = sweepIso(SWEEP_NOW);

let api: ComposedApi;
let teardown: StartedComposedApi | undefined;

beforeAll(async () => {
  teardown = await startComposedApi({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        { id: 'seed', providerId: 'zai-coding-plan', label: 'Seed account', apiKey: MARKER_KEY },
      ],
      // A configured schedule is what makes the peak-hours range grammar
      // reach the calculator — the span-cap arm needs it (D-142: the
      // no-schedule arm computes nothing and answers 200).
      providers: {
        'zai-coding-plan': {
          peakHours: {
            timezone: 'UTC',
            offPeakMultiplier: 0.5,
            windows: [],
          },
        },
      },
    },
  });
  api = teardown;
}, 30_000);

afterAll(async () => {
  await teardown?.stop();
});

/** One error-class case: a request shape and the envelope it must answer. */
interface ErrorCase {
  readonly label: string;
  readonly run: () => Promise<SweepResponse>;
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly reason?: string;
}

/** The forbidden substrings every error body is asserted free of. */
function forbidden(): string[] {
  return [MARKER_KEY, api.tempRoot];
}

/** The VALIDATION arms of the surface (§13's schema and range grammar). */
function validationCases(): ErrorCase[] {
  return [
    {
      label: 'missing required query param (GET /api/quota without accountId)',
      run: () => api.probe('GET', '/api/quota'),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'smuggled query field (GET /api/quota)',
      run: () => api.probe('GET', '/api/quota?accountId=seed&extra=1'),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'malformed range timestamp (GET /api/history from)',
      run: () =>
        api.probe(
          'GET',
          `/api/history?accountId=seed&metric=sweep-monthly&from=yesterday&to=${TO}`,
        ),
      status: 400,
      code: 'VALIDATION',
      reason: 'invalid-timestamp',
    },
    {
      label: 'inverted range (GET /api/events)',
      run: () => api.probe('GET', `/api/events?accountId=seed&from=${TO}&to=${FROM}`),
      status: 400,
      code: 'VALIDATION',
      reason: 'inverted-range',
    },
    {
      label: 'offset-less timestamp (GET /api/peak-hours)',
      run: () =>
        api.probe('GET', `/api/peak-hours?accountId=seed&from=2026-11-01T00:00:00&to=${TO}`),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'span over the calculator cap (GET /api/peak-hours)',
      // Retention clamps `from`, never `to` (D-082) — the far-fUTURE end
      // is the only reachable span-cap shape (D-142's interpretation 5).
      run: () =>
        api.probe(
          'GET',
          `/api/peak-hours?accountId=seed&from=${TO}&to=${sweepIso(SWEEP_NOW + 4000 * DAY_MS)}`,
        ),
      status: 400,
      code: 'VALIDATION',
      reason: 'range-too-wide',
    },
    {
      label: 'schema-rejected body (POST /api/accounts without providerId)',
      run: () =>
        api.probe(
          'POST',
          '/api/accounts',
          { label: 'No provider' },
          { ...MUTATION_HEADERS, 'content-type': 'application/json' },
        ),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'blank credential (POST /api/accounts with an empty key)',
      run: () =>
        api.probe(
          'POST',
          '/api/accounts',
          { providerId: 'zai-coding-plan', label: 'Blank key', apiKey: '' },
          { ...MUTATION_HEADERS, 'content-type': 'application/json' },
        ),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'empty patch body (PATCH /api/accounts/:id)',
      run: () =>
        api.probe(
          'PATCH',
          '/api/accounts/seed',
          {},
          { ...MUTATION_HEADERS, 'content-type': 'application/json' },
        ),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'malformed purge flag (DELETE /api/accounts/:id?purgeHistory=banana)',
      run: () =>
        api.probe('DELETE', '/api/accounts/seed?purgeHistory=banana', undefined, {
          ...MUTATION_HEADERS,
        }),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'out-of-range value (PUT /api/settings interval below §7.1)',
      run: () =>
        api.probe(
          'PUT',
          '/api/settings',
          { app: { pollingIntervalSeconds: 5 } },
          { ...MUTATION_HEADERS, 'content-type': 'application/json' },
        ),
      status: 400,
      code: 'VALIDATION',
    },
    {
      label: 'unparseable JSON body (PUT /api/settings)',
      run: () =>
        api.probe('PUT', '/api/settings', '{not json', {
          ...MUTATION_HEADERS,
          'content-type': 'application/json',
        }),
      status: 400,
      code: 'VALIDATION',
    },
  ];
}

/** The NOT_FOUND arms: unknown resources and unmatched routes alike. */
function notFoundCases(): ErrorCase[] {
  return [
    {
      label: 'unknown account (GET /api/quota)',
      run: () => api.probe('GET', '/api/quota?accountId=ghost'),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (GET /api/history)',
      run: () =>
        api.probe('GET', `/api/history?accountId=ghost&metric=sweep-monthly&from=${FROM}&to=${TO}`),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (GET /api/events)',
      run: () => api.probe('GET', `/api/events?accountId=ghost&from=${FROM}&to=${TO}`),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (GET /api/peak-hours)',
      run: () => api.probe('GET', `/api/peak-hours?accountId=ghost&from=${FROM}&to=${TO}`),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (PATCH /api/accounts/:id)',
      run: () =>
        api.probe(
          'PATCH',
          '/api/accounts/ghost',
          { label: 'No such' },
          { ...MUTATION_HEADERS, 'content-type': 'application/json' },
        ),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (DELETE /api/accounts/:id)',
      run: () => api.probe('DELETE', '/api/accounts/ghost', undefined, { ...MUTATION_HEADERS }),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unknown account (POST /api/accounts/:id/test)',
      run: () => api.probe('POST', '/api/accounts/ghost/test', undefined, { ...MUTATION_HEADERS }),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unmatched route (GET /api/no-such-route)',
      run: () => api.probe('GET', '/api/no-such-route'),
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      label: 'unmatched mutation route (POST /api/no-such-route)',
      run: () => api.probe('POST', '/api/no-such-route', undefined, { ...MUTATION_HEADERS }),
      status: 404,
      code: 'NOT_FOUND',
    },
  ];
}

/** The FORBIDDEN arms of the §15 layers — one stable reason each. */
function forbiddenCases(): ErrorCase[] {
  return [
    {
      label: 'Host allowlist (disallowed-host)',
      run: () => api.probe('GET', '/api/status', undefined, { host: 'rebind.attacker.example' }),
      status: 403,
      code: 'FORBIDDEN',
      reason: 'disallowed-host',
    },
    {
      label: 'Origin guard (origin-mismatch)',
      run: () =>
        api.probe(
          'POST',
          '/api/accounts',
          { providerId: 'zai-coding-plan', label: 'Cross-origin' },
          {
            ...MUTATION_HEADERS,
            'content-type': 'application/json',
            origin: 'https://attacker.example',
          },
        ),
      status: 403,
      code: 'FORBIDDEN',
      reason: 'origin-mismatch',
    },
    {
      label: 'custom-header guard (missing-custom-header)',
      run: () =>
        api.probe(
          'PUT',
          '/api/settings',
          { app: { pollingIntervalSeconds: 600 } },
          { 'content-type': 'application/json' },
        ),
      status: 403,
      code: 'FORBIDDEN',
      reason: 'missing-custom-header',
    },
    {
      label: '§15.1 proxy cell (proxy-without-password)',
      run: () => api.probe('GET', '/api/status', undefined, { 'x-forwarded-for': '203.0.113.9' }),
      status: 403,
      code: 'FORBIDDEN',
      reason: 'proxy-without-password',
    },
  ];
}

/** The transport-class arms: 415, 413, and the 414 router bound. */
function transportCases(): ErrorCase[] {
  return [
    {
      label: 'non-JSON content type (415)',
      run: () =>
        api.probe('POST', '/api/accounts', '{"label":"typed"}', {
          ...MUTATION_HEADERS,
          'content-type': 'text/plain',
        }),
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    },
    {
      label: 'body over the 64 KiB limit (413)',
      run: () =>
        api.probe('POST', '/api/accounts', paddedJsonOfExactLength(HTTP_BODY_LIMIT_BYTES + 1), {
          ...MUTATION_HEADERS,
          'content-type': 'application/json',
        }),
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    },
    {
      label: 'route parameter over the router bound (414)',
      run: () => api.probe('GET', `/api/accounts/${'a'.repeat(101)}`),
      status: 414,
      code: 'URI_TOO_LONG',
    },
  ];
}

describe('the §13 error envelope across every error class on real endpoints (D-113)', () => {
  it('VALIDATION: schema, range grammar, and body-parse arms all answer the envelope', async () => {
    for (const errorCase of validationCases()) {
      const response = await errorCase.run();
      expectApiError(
        response,
        {
          status: 400,
          code: 'VALIDATION',
          ...(errorCase.reason ? { reason: errorCase.reason } : {}),
        },
        forbidden(),
        errorCase.label,
      );
    }
  });

  it('NOT_FOUND: unknown accounts and unmatched routes answer the envelope', async () => {
    for (const errorCase of notFoundCases()) {
      const response = await errorCase.run();
      expectApiError(response, { status: 404, code: 'NOT_FOUND' }, forbidden());
    }
  });

  it('FORBIDDEN: the four §15 rejection reasons answer the envelope', async () => {
    for (const errorCase of forbiddenCases()) {
      const response = await errorCase.run();
      expectApiError(
        response,
        { status: 403, code: 'FORBIDDEN', reason: errorCase.reason },
        forbidden(),
      );
    }
  });

  it(
    'UNAUTHENTICATED: the required-mode arm answers the envelope (as it behaves today)',
    { timeout: 10_000 },
    async () => {
      // A dedicated lifecycle per the demanding cell — the composition's
      // `isAuthenticated` is absent by design (U-041/D-125/D-126), so the
      // 401 is the fail-closed arm every protected endpoint answers.
      await withComposedApi(
        {
          config: {
            app: { timezone: 'UTC' },
            auth: {
              mode: 'required',
              passwordHash:
                'scrypt$N=65536,r=8,p=1,keylen=64$c3dlZXAtc2FsdA$placeholder-hash-for-envelope-sweep',
            },
            accounts: [
              {
                id: 'seed',
                providerId: 'zai-coding-plan',
                label: 'Seed account',
                apiKey: MARKER_KEY,
              },
            ],
          },
        },
        async (required) => {
          const response = await required.probe('GET', '/api/status');
          expectApiError(
            response,
            { status: 401, code: 'UNAUTHENTICATED', reason: 'authentication-required' },
            [MARKER_KEY],
          );
        },
      );
    },
  );

  it('UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE, and URI_TOO_LONG answer the envelope', async () => {
    for (const errorCase of transportCases()) {
      const response = await errorCase.run();
      expectApiError(response, { status: errorCase.status, code: errorCase.code }, forbidden());
    }
  });

  it("keeps the registry's default detail-less classes byte-honest: details is null, never absent", async () => {
    // The 415 class carries no details by design (D-113/D-117: one wire
    // body per class, byte-identical to the native shape).
    const response = await api.probe('POST', '/api/accounts', '{"label":"typed"}', {
      ...MUTATION_HEADERS,
      'content-type': 'text/plain',
    });
    expect((response.json() as { error: { details: unknown } }).error.details).toBeNull();
  });
});
