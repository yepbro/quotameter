import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MUTATION_HEADERS,
  expectApiError,
  expectNoStore,
  expectSecurityHeaders,
  paddedJsonOfExactLength,
  readConfigJson,
  startComposedApi,
  type ComposedApi,
  type StartedComposedApi,
} from '../helpers/composedApi';
import { HTTP_BODY_LIMIT_BYTES } from '../../src/server/http';

/**
 * Task 164's cross-endpoint §15 security sweep: the spec's request-security
 * defenses proven ACROSS the endpoint surface — every §13 route through the
 * production composition (`composeApplication`, D-140) over a real temp
 * SQLite database, driven by `fastify.inject`. The per-guard suites
 * (api-origin, api-custom-header, api-host, api-auth-mode) pin each guard's
 * verdict table against the scope catch-all and test routes, and the
 * per-family suites bind their own family's endpoints; this suite closes
 * the cross-endpoint gap they leave — the systematic matrix:
 *
 * - §15.1 (D-121): every protected endpoint answers the UNAUTHENTICATED
 *   envelope under `required` mode as it behaves TODAY (the sessions-backed
 *   `isAuthenticated` is absent from the composition by design — the login
 *   endpoints are the U-041/D-125/D-126 plan gap, so nothing can satisfy
 *   the demand), §15.1's own 403-with-instructions for the proxied
 *   passwordless shape on every endpoint, and the public health exemption.
 * - §15.3 (D-115/D-117/D-120): every state-changing route rejects the
 *   missing custom header, the cross-origin Origin, the hostile
 *   Sec-Fetch-Site, and (bodied routes) the non-JSON content type; the
 *   Host allowlist rejects a rebinding Host on every endpoint; the guard
 *   ORDER (Host → Origin → header → auth) is pinned on a real mutation
 *   with no-state-change evidence.
 * - §15.5 (D-127/D-109): the exact security-header set on error responses
 *   of every class, and the 64 KiB body limit on the real endpoints —
 *   413 over the bound, the at-bound body admitted by the transport.
 */

/** The §15.4 marker key (never a wire body, never a log line). */
const MARKER_KEY = 'sk-sweep-security-9a2e41';

/**
 * A marker-shaped scrypt hash for the `required`-mode composition: the
 * §15.1 guard reads only its PRESENCE (verification meets a password at
 * the login endpoint — U-041), so a well-shaped non-secret placeholder
 * configures the demanding cell without inventing a credential.
 */
const REQUIRED_PASSWORD_HASH =
  'scrypt$N=65536,r=8,p=1,keylen=64$c3dlZXAtc2FsdA$placeholder-hash-for-mode-tests';

/** The pass-through app: `auto`, loopback bind, no password (§15.1's default). */
let pass: ComposedApi;
let passTeardown: StartedComposedApi | undefined;

/** The demanding app: `auth.mode: 'required'` with a configured hash. */
let required: ComposedApi;
let requiredTeardown: StartedComposedApi | undefined;

function seededConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: { timezone: 'UTC' },
    accounts: [
      { id: 'seed', providerId: 'zai-coding-plan', label: 'Seed account', apiKey: MARKER_KEY },
      { id: 'target-a', providerId: 'zai-coding-plan', label: 'Patch target' },
      { id: 'target-del', providerId: 'zai-coding-plan', label: 'Delete target' },
    ],
    ...extra,
  };
}

beforeAll(async () => {
  passTeardown = await startComposedApi({ config: seededConfig() });
  pass = passTeardown;
  requiredTeardown = await startComposedApi({
    config: seededConfig({ auth: { mode: 'required', passwordHash: REQUIRED_PASSWORD_HASH } }),
  });
  required = requiredTeardown!;
}, 60_000);

afterAll(async () => {
  await passTeardown?.stop();
  await requiredTeardown?.stop();
});

/** One §13 endpoint of the inventory, addressed at its real route. */
interface EndpointCall {
  readonly label: string;
  readonly method: string;
  readonly url: string;
  /** A body for state-changing routes (the bodied guard legs need one). */
  readonly payload?: Record<string, unknown>;
}

/** Every protected §13 endpoint, exercised through the production routes. */
const PROTECTED_ENDPOINTS: readonly EndpointCall[] = [
  { label: 'GET /api/status', method: 'GET', url: '/api/status' },
  { label: 'GET /api/providers', method: 'GET', url: '/api/providers' },
  { label: 'GET /api/accounts', method: 'GET', url: '/api/accounts' },
  { label: 'GET /api/quota', method: 'GET', url: '/api/quota?accountId=seed' },
  { label: 'GET /api/settings', method: 'GET', url: '/api/settings' },
  {
    label: 'POST /api/accounts',
    method: 'POST',
    url: '/api/accounts',
    payload: { providerId: 'zai-coding-plan', label: 'Never created' },
  },
  {
    label: 'PATCH /api/accounts/:id',
    method: 'PATCH',
    url: '/api/accounts/seed',
    payload: { label: 'Never renamed' },
  },
  { label: 'DELETE /api/accounts/:id', method: 'DELETE', url: '/api/accounts/seed' },
  { label: 'POST /api/accounts/:id/test', method: 'POST', url: '/api/accounts/seed/test' },
  {
    label: 'PUT /api/settings',
    method: 'PUT',
    url: '/api/settings',
    payload: { app: { pollingIntervalSeconds: 600 } },
  },
];

/** One §13 range-bearing endpoint (the range family shares one param shape). */
const RANGE_URL = `/api/history?accountId=seed&metric=sweep-monthly&from=2026-11-01T00:00:00.000Z&to=2026-11-04T00:00:00.000Z`;

const RANGE_ENDPOINTS: readonly EndpointCall[] = [
  { label: 'GET /api/history', method: 'GET', url: RANGE_URL },
  {
    label: 'GET /api/events',
    method: 'GET',
    url: '/api/events?accountId=seed&from=2026-11-01T00:00:00.000Z&to=2026-11-04T00:00:00.000Z',
  },
  {
    label: 'GET /api/peak-hours',
    method: 'GET',
    url: '/api/peak-hours?accountId=seed&from=2026-11-01T00:00:00.000Z&to=2026-11-04T00:00:00.000Z',
  },
];

/** Every state-changing §13 route — §15.3's own definition (D-115/D-117). */
const STATE_CHANGING_ROUTES: readonly EndpointCall[] = [
  {
    label: 'POST /api/accounts',
    method: 'POST',
    url: '/api/accounts',
    payload: { providerId: 'zai-coding-plan', label: 'Guard probe' },
  },
  {
    label: 'PATCH /api/accounts/:id',
    method: 'PATCH',
    url: '/api/accounts/target-a',
    payload: { label: 'Renamed by sweep' },
  },
  { label: 'DELETE /api/accounts/:id', method: 'DELETE', url: '/api/accounts/target-del' },
  { label: 'POST /api/accounts/:id/test', method: 'POST', url: '/api/accounts/seed/test' },
  {
    label: 'PUT /api/settings',
    method: 'PUT',
    url: '/api/settings',
    payload: { app: { pollingIntervalSeconds: 600 } },
  },
];

/** The bodied subset — §15.3's content-type leg applies to these only. */
const BODIED_ROUTES = STATE_CHANGING_ROUTES.filter((route) => route.payload !== undefined);

/** The full legitimate client headers for one endpoint call. */
function legitHeaders(route: EndpointCall): Record<string, string> {
  return route.payload === undefined
    ? { ...MUTATION_HEADERS }
    : { ...MUTATION_HEADERS, 'content-type': 'application/json' };
}

describe('§15.1 auth-mode selection across every endpoint (D-121, as it behaves today)', () => {
  it('answers the UNAUTHENTICATED envelope on every protected endpoint under required mode', async () => {
    for (const endpoint of [...PROTECTED_ENDPOINTS, ...RANGE_ENDPOINTS]) {
      const response = await required.probe(
        endpoint.method,
        endpoint.url,
        endpoint.payload,
        legitHeaders(endpoint),
      );
      expectApiError(
        response,
        { status: 401, code: 'UNAUTHENTICATED', reason: 'authentication-required' },
        [MARKER_KEY],
        endpoint.label,
      );
    }
  });

  it('keeps the public health route answering in required mode (§13 exemption)', async () => {
    const response = await required.probe('GET', '/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it("answers §15.1's 403-with-instructions on every endpoint for a proxied passwordless request", async () => {
    for (const endpoint of [...PROTECTED_ENDPOINTS, ...RANGE_ENDPOINTS]) {
      const response = await pass.probe(endpoint.method, endpoint.url, endpoint.payload, {
        ...legitHeaders(endpoint),
        'x-forwarded-for': '203.0.113.9',
      });
      expectApiError(
        response,
        { status: 403, code: 'FORBIDDEN', reason: 'proxy-without-password' },
        [MARKER_KEY],
        endpoint.label,
      );
    }
  });

  it('keeps the public health route answering through the proxy hop (proxy-blind)', async () => {
    const response = await pass.probe('GET', '/api/health', undefined, {
      'x-forwarded-for': '203.0.113.9',
    });
    expect(response.statusCode).toBe(200);
  });

  it('stacks the §15.1 triggers: a proxied request under required mode answers 401, not the 403 cell', async () => {
    const response = await required.probe('GET', '/api/status', undefined, {
      'x-forwarded-for': '203.0.113.9',
    });
    expectApiError(response, {
      status: 401,
      code: 'UNAUTHENTICATED',
      reason: 'authentication-required',
    });
  });

  it('passes the direct loopback request of auto mode through to the handlers (the default cell)', async () => {
    const response = await pass.probe('GET', '/api/status');
    expect(response.statusCode).toBe(200);
  });
});

describe('§15.3 mutation guards bound to every state-changing route (D-115/D-117)', () => {
  it('rejects the missing custom header on all five routes (FORBIDDEN/missing-custom-header)', async () => {
    for (const route of STATE_CHANGING_ROUTES) {
      // A bodied route still types its body JSON — only the §15.3 header
      // is absent, so the verdict names exactly that leg.
      const headers: Record<string, string> =
        route.payload === undefined ? {} : { 'content-type': 'application/json' };
      const response = await pass.probe(route.method, route.url, route.payload, headers);
      expectApiError(
        response,
        { status: 403, code: 'FORBIDDEN', reason: 'missing-custom-header' },
        [MARKER_KEY],
      );
    }
  });

  it('rejects a cross-origin Origin on all five routes (FORBIDDEN/origin-mismatch)', async () => {
    for (const route of STATE_CHANGING_ROUTES) {
      const response = await pass.probe(route.method, route.url, route.payload, {
        ...legitHeaders(route),
        origin: 'https://attacker.example',
      });
      expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'origin-mismatch' }, [
        MARKER_KEY,
      ]);
    }
  });

  it('rejects the hostile Fetch-Metadata token on all five routes (FORBIDDEN/cross-site-fetch)', async () => {
    for (const route of STATE_CHANGING_ROUTES) {
      const response = await pass.probe(route.method, route.url, route.payload, {
        ...legitHeaders(route),
        'sec-fetch-site': 'cross-site',
      });
      expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'cross-site-fetch' }, [
        MARKER_KEY,
      ]);
    }
  });

  it('rejects the non-JSON content type on the bodied routes (415, the native-identical class)', async () => {
    for (const route of BODIED_ROUTES) {
      const response = await pass.probe(route.method, route.url, JSON.stringify(route.payload), {
        ...MUTATION_HEADERS,
        'content-type': 'text/plain',
      });
      expectApiError(response, { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }, [MARKER_KEY]);
    }
  });

  it("passes the legitimate client shape on to every handler — the rejections were the guards', §15.5 headers included", async () => {
    const expected = new Map<string, number>([
      ['POST /api/accounts', 201],
      ['PATCH /api/accounts/:id', 200],
      ['DELETE /api/accounts/:id', 200],
      ['POST /api/accounts/:id/test', 200],
      ['PUT /api/settings', 200],
    ]);
    for (const route of STATE_CHANGING_ROUTES) {
      const response = await pass.call(route.method, route.url, route.payload);
      expect(response.statusCode, route.label).toBe(expected.get(route.label));
      // The mutation successes carry the §15.5 set like every read does
      // (D-127: helmet binds every route the server answers).
      expectSecurityHeaders(response, route.label);
      expectNoStore(response, route.label);
    }
  });
});

describe('§15.3 guard order and no-state-change evidence on real routes', () => {
  it('answers the Host verdict before every scope guard (root-scope, outermost)', async () => {
    const response = await pass.probe(
      'POST',
      '/api/accounts',
      { providerId: 'zai-coding-plan', label: 'Rebind probe' },
      {
        // Every later layer also fails: only the outermost verdict may show.
        host: 'rebind.attacker.example',
        origin: 'https://attacker.example',
      },
    );
    expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'disallowed-host' });
  });

  it('answers the Origin verdict before the custom-header verdict', async () => {
    const response = await pass.probe(
      'POST',
      '/api/accounts',
      { providerId: 'zai-coding-plan', label: 'Order probe' },
      { origin: 'https://attacker.example' }, // no custom header either
    );
    expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'origin-mismatch' });
  });

  it('answers the custom-header verdict before the auth verdict (required mode)', async () => {
    // Same-origin (no Origin/Sec-Fetch-Site headers), JSON-typed body, but
    // no dedicated header: §15.3's second leg outranks §15.1's demand.
    const rejected = await required.probe(
      'POST',
      '/api/accounts',
      {
        providerId: 'zai-coding-plan',
        label: 'Order probe',
      },
      { 'content-type': 'application/json' },
    );
    expectApiError(rejected, { status: 403, code: 'FORBIDDEN', reason: 'missing-custom-header' });

    // The same request with the full client shape reaches the auth verdict.
    const authenticated = await required.call('POST', '/api/accounts', {
      providerId: 'zai-coding-plan',
      label: 'Order probe',
    });
    expectApiError(authenticated, {
      status: 401,
      code: 'UNAUTHENTICATED',
      reason: 'authentication-required',
    });
  });

  it('leaves no state behind: a rejected mutation never creates the account', async () => {
    const before = await pass.call('GET', '/api/accounts');
    const beforeIds = (before.json() as { accounts: Array<{ id: string }> }).accounts.map(
      (a) => a.id,
    );
    const response = await pass.probe(
      'POST',
      '/api/accounts',
      { providerId: 'zai-coding-plan', label: 'Never created', id: 'never-created' },
      {
        ...MUTATION_HEADERS,
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
    );
    expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'origin-mismatch' });
    const after = await pass.call('GET', '/api/accounts');
    const afterIds = (after.json() as { accounts: Array<{ id: string }> }).accounts.map(
      (a) => a.id,
    );
    expect(afterIds).toEqual(beforeIds);
    expect(afterIds).not.toContain('never-created');
    const file = await readConfigJson(pass.configPath);
    expect(JSON.stringify(file)).not.toContain('never-created');
  });
});

describe('§15.3 Host allowlist across every endpoint (D-120)', () => {
  it('rejects a rebinding Host on every endpoint — the public health route and the mutations too', async () => {
    // `/api/health` is §13's public AUTH exemption, not a Host exemption:
    // the root-scope guard binds it exactly like every protected route
    // (D-120), so it leads the inventory here.
    for (const endpoint of [
      { label: 'GET /api/health', method: 'GET', url: '/api/health' } as EndpointCall,
      ...PROTECTED_ENDPOINTS,
      ...RANGE_ENDPOINTS,
    ]) {
      const response = await pass.probe(endpoint.method, endpoint.url, endpoint.payload, {
        ...legitHeaders(endpoint),
        host: 'rebind.attacker.example',
      });
      expectApiError(
        response,
        { status: 403, code: 'FORBIDDEN', reason: 'disallowed-host' },
        [MARKER_KEY],
        endpoint.label,
      );
    }
  });

  it('admits the allowlisted names with any port (§15.6 tunnels remap ports)', async () => {
    for (const host of ['localhost:9999', '127.0.0.1:8787', '[::1]:3000']) {
      const response = await pass.probe('GET', '/api/health', undefined, { host });
      expect(response.statusCode, host).toBe(200);
    }
  });
});

describe('§15.5 headers on error responses and the 64 KiB body limit (D-127/D-109)', () => {
  it('carries the §15.5 header set and no-store on every error class a route can answer', async () => {
    const cases: Array<[string, Awaited<ReturnType<ComposedApi['probe']>>]> = [
      ['catch-all 404', await pass.probe('GET', '/api/no-such-route')],
      [
        'host 403',
        await pass.probe('GET', '/api/status', undefined, { host: 'rebind.attacker.example' }),
      ],
      [
        '415',
        await pass.probe('POST', '/api/accounts', '{"label":"x"}', {
          ...MUTATION_HEADERS,
          'content-type': 'text/plain',
        }),
      ],
      [
        '413',
        await pass.probe(
          'POST',
          '/api/accounts',
          paddedJsonOfExactLength(HTTP_BODY_LIMIT_BYTES + 1),
          {
            ...MUTATION_HEADERS,
            'content-type': 'application/json',
          },
        ),
      ],
      ['414 (router param bound)', await pass.probe('GET', `/api/accounts/${'a'.repeat(101)}`)],
      ['validation 400', await pass.probe('GET', '/api/quota')],
      ['401 (required)', await required.probe('GET', '/api/status')],
    ];
    expect(cases.length).toBe(7);
    for (const [label, response] of cases) {
      expectSecurityHeaders(response, label);
      expectNoStore(response, label);
    }
  });

  it('answers 413 PAYLOAD_TOO_LARGE over the 64 KiB bound on the real bodied routes', async () => {
    for (const [label, method, url] of [
      ['POST /api/accounts', 'POST', '/api/accounts'],
      ['PATCH /api/accounts/:id', 'PATCH', '/api/accounts/seed'],
      ['PUT /api/settings', 'PUT', '/api/settings'],
    ] as const) {
      const response = await pass.probe(
        method,
        url,
        paddedJsonOfExactLength(HTTP_BODY_LIMIT_BYTES + 1),
        { ...MUTATION_HEADERS, 'content-type': 'application/json' },
      );
      expectApiError(response, { status: 413, code: 'PAYLOAD_TOO_LARGE' }, [MARKER_KEY], label);
    }
  });

  it('answers the §15.3 header verdict, never 413, for a headerless oversized body (guard outranks parser)', async () => {
    // D-117's ordering on a real route: the custom-header guard runs ahead
    // of the body parser, so an oversized body WITHOUT the dedicated
    // header answers the CSRF verdict — the transport class is never
    // reached (the api-custom-header suite pins the class; this pins it
    // on a real route through the production composition).
    const response = await pass.probe(
      'POST',
      '/api/accounts',
      paddedJsonOfExactLength(HTTP_BODY_LIMIT_BYTES + 1),
      {
        'content-type': 'application/json',
      },
    );
    expectApiError(response, { status: 403, code: 'FORBIDDEN', reason: 'missing-custom-header' });
  });

  it('admits a body of exactly 64 KiB at the transport — the schema, not the limit, answers', async () => {
    const response = await pass.probe(
      'POST',
      '/api/accounts',
      paddedJsonOfExactLength(HTTP_BODY_LIMIT_BYTES),
      {
        ...MUTATION_HEADERS,
        'content-type': 'application/json',
      },
    );
    // The padded unknown field is a schema problem — never a 413.
    expectApiError(response, { status: 400, code: 'VALIDATION' }, [MARKER_KEY]);
  });
});
