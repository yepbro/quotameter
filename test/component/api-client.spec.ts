import { describe, expect, it, vi } from 'vitest';
import {
  API_DEFAULT_TIMEOUT_MS,
  API_MUTATION_HEADER,
  createApiClient,
  type ApiFetchResponse,
} from '../../ui/src/api/client';
import { isApiClientError, parseApiErrorEnvelope } from '../../ui/src/api/error';
import { API_MUTATION_HEADER_NAME } from '../../src/server/api/security';
import type { AccountView } from '../../src/schemas/api/accounts';
import {
  FakeFetch,
  jsonResponse,
  networkFailure,
  neverRespond,
  stalledBodyResponse,
  textResponse,
  type RecordedCall,
} from '../helpers/api';

/**
 * The typed API client (task 169, spec §13, §14; decision D-134): the
 * request pipeline every page's data flows through, driven entirely
 * through the injectable fetch seam — success shapes per endpoint
 * family, the §15.3 mutation-header contract, and the complete error
 * taxonomy (envelope, non-envelope, network, abort, timeout). No
 * network, no browser globals beyond the platform pieces the client
 * itself uses (AbortController, URLSearchParams).
 */

/** A client over one handler, with wire-form access to every dispatch. */
function clientWith(
  handler: (call: RecordedCall) => Promise<ApiFetchResponse>,
  options: { timeoutMs?: number; baseUrl?: string } = {},
) {
  const fake = new FakeFetch(handler);
  const client = createApiClient({
    fetchImpl: fake.impl,
    timeoutMs: options.timeoutMs,
    baseUrl: options.baseUrl,
  });
  return {
    client,
    calls: fake.calls,
    lastCall(): RecordedCall {
      const call = fake.calls.at(-1);
      expect(call, 'the client dispatched a request').toBeDefined();
      return call!;
    },
  };
}

/** Collects the promise rejection as the taxonomy error it must be. */
async function rejectionOf(promise: Promise<unknown>) {
  const caught = await promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error,
  );
  expect(isApiClientError(caught), `an ApiClientError, got ${String(caught)}`).toBe(true);
  return caught as import('../../ui/src/api/error').ApiClientError;
}

const ACCOUNT: AccountView = {
  id: 'acc-main',
  providerId: 'zai-coding-plan',
  label: 'Main',
  enabled: true,
  status: 'active',
  hasKey: true,
  keySource: 'file',
  keyMask: '********',
  planName: 'Max',
  createdAt: 1_730_000_000_000,
  archivedAt: null,
};

describe('API client (task 169, D-134)', () => {
  describe('success round-trips per endpoint family', () => {
    it('health.get resolves the typed response from GET /api/health', async () => {
      const { client, lastCall } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { status: 'ok' })),
      );
      await expect(client.health.get()).resolves.toEqual({ status: 'ok' });
      expect(lastCall().method).toBe('GET');
      expect(lastCall().input).toBe('/api/health');
    });

    it('status.get and providers.list hit their §13 paths', async () => {
      const statusBody = { status: 'ok', pollingIntervalSeconds: 300, accounts: [] } as const;
      const providersBody = { providers: [] } as const;
      const { client, lastCall } = clientWith((call) =>
        Promise.resolve(
          jsonResponse(200, call.input.endsWith('/status') ? statusBody : providersBody),
        ),
      );
      await expect(client.status.get()).resolves.toEqual(statusBody);
      expect(lastCall().input).toBe('/api/status');
      await expect(client.providers.list()).resolves.toEqual(providersBody);
      expect(lastCall().input).toBe('/api/providers');
    });

    it('quota.get serializes the accountId query parameter', async () => {
      const { client, lastCall } = clientWith(() =>
        Promise.resolve(
          jsonResponse(200, {
            accountId: 'acc-main',
            status: 'fresh',
            collectedAt: null,
            planName: null,
            metrics: [],
          }),
        ),
      );
      await client.quota.get('acc-main');
      expect(lastCall().input).toBe('/api/quota?accountId=acc-main');
    });

    it('history.get serializes the D-139 range query, maxPoints optional (task 174)', async () => {
      const body = {
        accountId: 'acc-main',
        metric: 'tokens-5h',
        unit: null,
        limitType: null,
        range: {
          outcome: 'ok',
          requestedFrom: 0,
          requestedTo: 1,
          effectiveFrom: 0,
          effectiveTo: 1,
          retentionHorizon: null,
        },
        downsampled: false,
        resolutionMs: null,
        sourcePointCount: 0,
        points: [],
      } as const;
      const { client, lastCall, calls } = clientWith(() =>
        Promise.resolve(jsonResponse(200, body)),
      );
      const from = '2026-11-03T12:00:00.000Z';
      const to = '2026-11-04T12:00:00.000Z';
      await expect(
        client.history.get({ accountId: 'acc-main', metric: 'tokens-5h', from, to }),
      ).resolves.toEqual(body);
      expect(lastCall().method).toBe('GET');
      // URLSearchParams percent-encodes the ISO colons — the server's
      // query parser decodes them back; the spelling is pinned so a
      // serialization change cannot drift silently.
      expect(lastCall().input).toBe(
        '/api/history?accountId=acc-main&metric=tokens-5h&from=2026-11-03T12%3A00%3A00.000Z&to=2026-11-04T12%3A00%3A00.000Z',
      );
      // GETs carry neither §15.3 leg.
      expect(lastCall().headers[API_MUTATION_HEADER]).toBeUndefined();
      expect(lastCall().headers['Content-Type']).toBeUndefined();
      // maxPoints rides only when supplied — the server's §13 default
      // applies otherwise.
      await client.history.get({ accountId: 'a', metric: 'm', from, to, maxPoints: 2000 });
      expect(calls.at(-1)?.input).toContain('&maxPoints=2000');
    });

    it('events.list serializes the account timeline query, metric optional (task 174)', async () => {
      const body = {
        accountId: 'acc-main',
        metric: null,
        range: {
          outcome: 'ok',
          requestedFrom: 0,
          requestedTo: 1,
          effectiveFrom: 0,
          effectiveTo: 1,
          retentionHorizon: null,
        },
        events: [],
      } as const;
      const { client, lastCall, calls } = clientWith(() =>
        Promise.resolve(jsonResponse(200, body)),
      );
      const from = '2026-11-03T12:00:00.000Z';
      const to = '2026-11-04T12:00:00.000Z';
      await expect(client.events.list({ accountId: 'acc-main', from, to })).resolves.toEqual(body);
      expect(lastCall().method).toBe('GET');
      expect(lastCall().input).toBe(
        '/api/events?accountId=acc-main&from=2026-11-03T12%3A00%3A00.000Z&to=2026-11-04T12%3A00%3A00.000Z',
      );
      expect(lastCall().headers[API_MUTATION_HEADER]).toBeUndefined();
      // The optional metric filter serializes exactly when present.
      await client.events.list({ accountId: 'acc-main', from, to, metric: 'tokens-5h' });
      expect(calls.at(-1)?.input).toContain('&metric=tokens-5h');
    });

    it('peakHours.get serializes the schedule range query (task 176, D-149)', async () => {
      const body = {
        accountId: 'acc-main',
        providerId: 'zai-coding-plan',
        timezone: null,
        offPeakMultiplier: null,
        range: {
          outcome: 'ok',
          requestedFrom: 0,
          requestedTo: 1,
          effectiveFrom: 0,
          effectiveTo: 1,
          retentionHorizon: null,
        },
        intervals: [],
      } as const;
      const { client, lastCall } = clientWith(() => Promise.resolve(jsonResponse(200, body)));
      const from = '2026-11-03T12:00:00.000Z';
      const to = '2026-11-04T12:00:00.000Z';
      await expect(client.peakHours.get({ accountId: 'acc-main', from, to })).resolves.toEqual(
        body,
      );
      expect(lastCall().method).toBe('GET');
      expect(lastCall().input).toBe(
        '/api/peak-hours?accountId=acc-main&from=2026-11-03T12%3A00%3A00.000Z&to=2026-11-04T12%3A00%3A00.000Z',
      );
      expect(lastCall().headers[API_MUTATION_HEADER]).toBeUndefined();
      expect(lastCall().headers['Content-Type']).toBeUndefined();
    });

    it('accounts.list resolves the accounts array', async () => {
      const { client } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { accounts: [ACCOUNT] })),
      );
      await expect(client.accounts.list()).resolves.toEqual({ accounts: [ACCOUNT] });
    });

    it('accounts.create POSTs the typed body and resolves the created view', async () => {
      const { client, lastCall } = clientWith(() => Promise.resolve(jsonResponse(201, ACCOUNT)));
      const body = { providerId: 'zai-coding-plan', label: 'Main', apiKey: 'secret-value' };
      await expect(client.accounts.create(body)).resolves.toEqual(ACCOUNT);
      const call = lastCall();
      expect(call.method).toBe('POST');
      expect(call.input).toBe('/api/accounts');
      expect(call.body).toBe(JSON.stringify(body));
    });

    it('accounts.update PATCHes to the encoded account path', async () => {
      const { client, lastCall } = clientWith(() => Promise.resolve(jsonResponse(200, ACCOUNT)));
      await client.accounts.update('acc main', { label: 'Renamed' });
      const call = lastCall();
      expect(call.method).toBe('PATCH');
      expect(call.input).toBe('/api/accounts/acc%20main');
      expect(call.body).toBe(JSON.stringify({ label: 'Renamed' }));
    });

    it.each([
      [undefined, '/api/accounts/acc-main'],
      [{}, '/api/accounts/acc-main'],
      [{ purgeHistory: true }, '/api/accounts/acc-main?purgeHistory=true'],
      // A deliberate false must serialize — it is the honest archive
      // request (§13's explicit spelling), not an omitted option.
      [{ purgeHistory: false }, '/api/accounts/acc-main?purgeHistory=false'],
    ] as const)(
      'accounts.remove DELETEs bodiless with query %j → %s',
      async (options, expectedUrl) => {
        const { client, lastCall } = clientWith(() =>
          Promise.resolve(
            jsonResponse(200, { result: 'archived', account: ACCOUNT, removed: null }),
          ),
        );
        await client.accounts.remove('acc-main', options);
        const call = lastCall();
        expect(call.method).toBe('DELETE');
        expect(call.input).toBe(expectedUrl);
        expect(call.body).toBeUndefined();
      },
    );

    it('accounts.test POSTs bodiless to the test path and resolves the outcome', async () => {
      const { client, lastCall } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { outcome: 'ok' })),
      );
      await expect(client.accounts.test('acc-main')).resolves.toEqual({ outcome: 'ok' });
      const call = lastCall();
      expect(call.method).toBe('POST');
      expect(call.input).toBe('/api/accounts/acc-main/test');
      expect(call.body).toBeUndefined();
    });

    it('settings.get / settings.update hit GET and PUT on /api/settings', async () => {
      const { client, lastCall } = clientWith((call) =>
        Promise.resolve(
          call.method === 'GET'
            ? jsonResponse(200, { settings: {}, paths: { configPath: '/x', dataDir: '/d' } })
            : jsonResponse(200, { applied: [], restartRequired: [] }),
        ),
      );
      await client.settings.get();
      expect(lastCall().method).toBe('GET');
      expect(lastCall().input).toBe('/api/settings');
      await expect(client.settings.update({ app: { timezone: 'UTC' } })).resolves.toEqual({
        applied: [],
        restartRequired: [],
      });
      expect(lastCall().method).toBe('PUT');
      expect(lastCall().body).toBe(JSON.stringify({ app: { timezone: 'UTC' } }));
    });

    it('honors a custom baseUrl (tolerating a trailing slash)', async () => {
      const { client, lastCall } = clientWith(
        () => Promise.resolve(jsonResponse(200, { status: 'ok' })),
        { baseUrl: '/otherapi/' },
      );
      await client.health.get();
      expect(lastCall().input).toBe('/otherapi/health');
    });
  });

  describe('the §15.3 mutation-header contract (D-117)', () => {
    it('the UI constant is pinned against the server single source (no drift)', () => {
      expect(API_MUTATION_HEADER).toBe(API_MUTATION_HEADER_NAME);
    });

    it('GETs carry neither the mutation header nor a content type', async () => {
      const { client, lastCall } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { status: 'ok' })),
      );
      await client.health.get();
      const headers = lastCall().headers;
      expect(headers[API_MUTATION_HEADER]).toBeUndefined();
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers.Accept).toBe('application/json');
    });

    it('bodied mutations (POST/PUT/PATCH) carry the mutation header and JSON content type', async () => {
      const { client, calls } = clientWith(() => Promise.resolve(jsonResponse(200, ACCOUNT)));
      await client.accounts.create({ providerId: 'p', label: 'L' });
      await client.accounts.update('acc-main', { enabled: false });
      const { client: settingsClient, calls: settingsCalls } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { applied: [], restartRequired: [] })),
      );
      await settingsClient.settings.update({ logging: { level: 'info' } });

      const bodied = [
        ...calls.filter((call) => call.method !== 'GET'),
        ...settingsCalls.filter((call) => call.method !== 'GET'),
      ];
      expect(bodied.map((call) => call.method)).toEqual(['POST', 'PATCH', 'PUT']);
      for (const call of bodied) {
        expect(
          call.headers[API_MUTATION_HEADER],
          `${call.method} carries the mutation header`,
        ).toBe('1');
        expect(call.headers['Content-Type'], `${call.method} types its body JSON`).toBe(
          'application/json',
        );
      }
    });

    it('bodiless mutations (DELETE, the POST test) carry the header but no content type', async () => {
      const { client, calls } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { result: 'archived', account: ACCOUNT, removed: null })),
      );
      await client.accounts.remove('acc-main');
      const { client: testClient, calls: testCalls } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { outcome: 'ok' })),
      );
      await testClient.accounts.test('acc-main');

      for (const call of [...calls, ...testCalls]) {
        expect(call.headers[API_MUTATION_HEADER]).toBe('1');
        expect(call.headers['Content-Type']).toBeUndefined();
      }
    });

    it('passes a real abort signal into the fetch dispatch', async () => {
      const { client, lastCall } = clientWith(() =>
        Promise.resolve(jsonResponse(200, { status: 'ok' })),
      );
      await client.health.get();
      expect(lastCall().signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('the error taxonomy', () => {
    it('the §13 envelope classifies as rejected with code, status, and the carried facts', async () => {
      const envelope = {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          details: { reason: 'authentication-required' },
        },
      };
      const { client } = clientWith(() => Promise.resolve(jsonResponse(401, envelope)));
      const error = await rejectionOf(client.status.get());
      expect(error.kind).toBe('rejected');
      expect(error.status).toBe(401);
      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.serverMessage).toBe('Authentication required');
      expect(error.serverDetails).toEqual({ reason: 'authentication-required' });
      // The developer-facing Error.message is the fixed per-kind sentence
      // — nothing response-derived entered it.
      expect(error.message).toBe('Quotameter API request failed: rejected');
    });

    it('an envelope-shaped body classifies as rejected even on a 2xx status', async () => {
      const { client } = clientWith(() =>
        Promise.resolve(
          jsonResponse(200, {
            error: { code: 'INTERNAL', message: 'Internal server error', details: null },
          }),
        ),
      );
      const error = await rejectionOf(client.health.get());
      expect(error.kind).toBe('rejected');
      expect(error.status).toBe(200);
      expect(error.code).toBe('INTERNAL');
    });

    it.each([
      ['an HTML error page (502)', textResponse(502, '<html><body>Bad gateway</body></html>')],
      [
        'a proxy JSON shape the contract does not know (503)',
        jsonResponse(503, { status: 'error' }),
      ],
      ['invalid JSON on a 200', textResponse(200, 'not json{')],
    ])('a non-envelope body classifies as unexpected: %s', async (_name, response) => {
      const { client } = clientWith(() => Promise.resolve(response));
      const error = await rejectionOf(client.health.get());
      expect(error.kind).toBe('unexpected');
      expect(error.status).toBe(response.status);
      expect(error.code).toBeUndefined();
      expect(error.serverMessage).toBeUndefined();
    });

    it('a fetch rejection classifies as network', async () => {
      const { client } = clientWith(networkFailure('Failed to fetch'));
      const error = await rejectionOf(client.health.get());
      expect(error.kind).toBe('network');
      expect(error.status).toBeUndefined();
    });

    it('a body read that fails mid-exchange classifies like the transport that died', async () => {
      const response: ApiFetchResponse = {
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('network dropped')),
      };
      const { client } = clientWith(() => Promise.resolve(response));
      const error = await rejectionOf(client.health.get());
      expect(error.kind).toBe('network');
    });

    it("the caller's signal aborting mid-flight classifies as aborted", async () => {
      const { client } = clientWith(neverRespond());
      const controller = new AbortController();
      const pending = client.health.get(controller.signal);
      controller.abort();
      const error = await rejectionOf(pending);
      expect(error.kind).toBe('aborted');
    });

    it('an already-aborted signal answers aborted without dispatching', async () => {
      const { client, calls } = clientWith(neverRespond());
      const controller = new AbortController();
      controller.abort();
      const error = await rejectionOf(client.health.get(controller.signal));
      expect(error.kind).toBe('aborted');
      expect(calls).toHaveLength(0);
    });

    it('the request deadline firing classifies as timeout', async () => {
      vi.useFakeTimers();
      try {
        const { client } = clientWith(neverRespond(), { timeoutMs: 50 });
        const pending = client.health.get();
        const caught = pending.then(
          () => {
            throw new Error('expected the call to reject');
          },
          (error: unknown) => error,
        );
        // Advancing past the deadline fires the abort; the async advance
        // also drains the microtasks so the rejection propagates.
        await vi.advanceTimersByTimeAsync(50);
        const error = await caught;
        expect(isApiClientError(error), `an ApiClientError, got ${String(error)}`).toBe(true);
        const taxonomy = error as import('../../ui/src/api/error').ApiClientError;
        expect(taxonomy.kind).toBe('timeout');
        expect(taxonomy.status).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a stalled body after the headers is bounded by the same deadline (timeout)', async () => {
      // The review round's P1: `fetch` resolves at headers, so the body
      // read must stay inside the deadline — a responder that stalls the
      // body cannot hang the page.
      vi.useFakeTimers();
      try {
        const { client } = clientWith((call) => Promise.resolve(stalledBodyResponse(call.signal)), {
          timeoutMs: 50,
        });
        const pending = client.health.get();
        const caught = pending.then(
          () => {
            throw new Error('expected the call to reject');
          },
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(50);
        const error = await caught;
        expect(isApiClientError(error), `an ApiClientError, got ${String(error)}`).toBe(true);
        expect((error as import('../../ui/src/api/error').ApiClientError).kind).toBe('timeout');
      } finally {
        vi.useRealTimers();
      }
    });

    it('the caller can cancel after the headers arrived (aborted mid-body)', async () => {
      // The P1 fix's second half: the caller's listener stays armed
      // through the body read, so a route change or unmount mid-body
      // answers `aborted` instead of a late success.
      const { client } = clientWith((call) => Promise.resolve(stalledBodyResponse(call.signal)));
      const controller = new AbortController();
      const pending = client.health.get(controller.signal);
      controller.abort();
      const error = await rejectionOf(pending);
      expect(error.kind).toBe('aborted');
    });

    it('cleans up: the deadline timer is cleared and the caller listener removed after success', async () => {
      vi.useFakeTimers();
      try {
        const { client } = clientWith(() => Promise.resolve(jsonResponse(200, { status: 'ok' })));
        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
        await client.health.get(controller.signal);
        expect(vi.getTimerCount()).toBe(0);
        expect(removeSpy).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('exposes the default deadline as a constant', () => {
      expect(API_DEFAULT_TIMEOUT_MS).toBe(15_000);
    });
  });

  describe('the envelope recognizer (hostile shapes)', () => {
    it.each([
      ['null', null],
      ['a non-object', 'x'],
      ['an error that is null', { error: null }],
      ['an error that is a string', { error: 'x' }],
      ['a non-string code', { error: { code: 1, message: 'x' } }],
      ['a missing message', { error: { code: 'VALIDATION' } }],
    ])('does not recognize %s as the envelope', (_name, parsed) => {
      expect(parseApiErrorEnvelope(parsed)).toBeUndefined();
    });

    it('recognizes the minimal envelope without a details key', () => {
      expect(parseApiErrorEnvelope({ error: { code: 'NOT_FOUND', message: 'Not found' } })).toEqual(
        { error: { code: 'NOT_FOUND', message: 'Not found', details: undefined } },
      );
    });
  });
});
