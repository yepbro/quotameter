import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockProviderServer, type MockProviderServer } from '../helpers/mockProviderServer';
import { createAccountContext, type AccountContext } from '../../src/providers/registry';
import {
  CredentialCheckError,
  CredentialsRejectedError,
  ProviderUnavailableError,
  ZaiCodingPlanProvider,
} from '../../src/providers/zai-coding-plan';

/**
 * End-to-end credential validation against the loopback mock provider
 * server (spec §8.1, §8.3, §17.1; task 098, decision D-052; no-network
 * guard satisfied — everything stays on 127.0.0.1). Pins the task's
 * done-condition: valid, rejected, and unavailable credentials map to three
 * distinct outcomes, and the account key never appears in any of them —
 * proven with a marker secret at every failure while the recorded requests
 * show the key genuinely traveled to the provider.
 */

/** The marker key (§15.4, §17.1): sent as the Bearer credential, must never survive in an error. */
const MARKER_KEY = 'qm-marker-key-t098';

/** A short deadline so the timeout scenario stays fast. */
const TIMEOUT_MS = 120;

/** The never-captured `/models` body fixture (D-49: a stand-in, never parsed). */
const MODELS_BODY = readFileSync(
  new URL('../fixtures/synthetic/zai-models.json', import.meta.url),
  'utf8',
);

/** An invented failure envelope (A2): a 200 + this body must still read "valid". */
const ENVELOPE_ERROR_BODY = readFileSync(
  new URL('../fixtures/synthetic/zai-envelope-error.json', import.meta.url),
  'utf8',
);

/** A malformed envelope (missing `code`/`data`): same status-based rule. */
const ENVELOPE_MALFORMED_BODY = readFileSync(
  new URL('../fixtures/synthetic/zai-envelope-malformed.json', import.meta.url),
  'utf8',
);

/** Renders every string an error could leak a secret through. */
function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

/** Asserts the marker key never survived into a thrown error's surface. */
function expectMarkerFree(error: unknown): void {
  expect(errorSurface(error)).not.toContain(MARKER_KEY);
}

/** Reserves a loopback port and releases it, leaving a refused port behind. */
async function freedLoopbackPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('ZaiCodingPlanProvider.validateCredentials over real sockets', () => {
  let server: MockProviderServer;
  let account: AccountContext;

  /** A provider pointed at the mock server's coding base. */
  const provider = (codingBaseUrl?: string): ZaiCodingPlanProvider =>
    new ZaiCodingPlanProvider({
      codingBaseUrl: codingBaseUrl ?? `${server.url}/api/coding/paas/v4`,
      timeoutMs: TIMEOUT_MS,
    });

  /** How many requests the server had seen, for the no-retry pin. */
  const requestCount = (): number => server.requests.length;

  beforeAll(async () => {
    server = await startMockProviderServer();
    account = createAccountContext('acc-t098', 'Marker plan', MARKER_KEY);
  });

  afterAll(async () => {
    await server.close();
  });

  describe('valid — any delivered 2xx resolves (status-based, body never parsed)', () => {
    it('resolves on 200 with the /models stand-in body', async () => {
      server.setBehavior({ kind: 'respond', status: 200, body: MODELS_BODY });

      await expect(provider().validateCredentials(account)).resolves.toBeUndefined();

      const request = server.requests.at(-1);
      // The dossier's endpoint-4 request shape: one Bearer GET, and nothing
      // else the prototype used to send (A7 — Authorization only).
      expect(request).toMatchObject({
        method: 'GET',
        url: '/api/coding/paas/v4/models',
      });
      expect(request?.headers.authorization).toBe(`Bearer ${MARKER_KEY}`);
      // A7: the adapter sends no header but the credential — notably not the
      // prototype's `Content-Type` (undici adds `accept-language: *` itself,
      // which is runtime behavior, not the adapter's header set).
      expect(request?.headers['content-type']).toBeUndefined();
    });

    it('resolves on envelope surprises: a 200 error-envelope body is not parsed (A2/A3)', async () => {
      for (const body of [ENVELOPE_ERROR_BODY, ENVELOPE_MALFORMED_BODY, 'not json at all']) {
        server.setBehavior({ kind: 'respond', status: 200, body });

        await expect(provider().validateCredentials(account)).resolves.toBeUndefined();
      }
    });

    it('normalizes a trailing slash on the injected coding base', async () => {
      server.setBehavior({ kind: 'respond', status: 200, body: MODELS_BODY });

      await expect(
        provider(`${server.url}/api/coding/paas/v4/`).validateCredentials(account),
      ).resolves.toBeUndefined();

      expect(server.requests.at(-1)?.url).toBe('/api/coding/paas/v4/models');
    });
  });

  describe('rejected — HTTP 401/403 refuse the key (dossier assumption A3)', () => {
    for (const status of [401, 403] as const) {
      it(`throws CredentialsRejectedError on HTTP ${status} without leaking the key`, async () => {
        server.setBehavior({ kind: 'respond', status, body: '{}' });
        const before = requestCount();

        const error = await provider()
          .validateCredentials(account)
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(CredentialsRejectedError);
        expect(error).toBeInstanceOf(CredentialCheckError);
        expect((error as CredentialsRejectedError).kind).toBe('credentials-rejected');
        expect((error as CredentialsRejectedError).httpStatus).toBe(status);
        expectMarkerFree(error);
        // The key genuinely traveled — the leak assertion is not vacuous —
        // and exactly one request was made: retrying is task 106's layer.
        expect(server.requests.at(-1)?.headers.authorization).toBe(`Bearer ${MARKER_KEY}`);
        expect(requestCount()).toBe(before + 1);
      });
    }
  });

  describe('unavailable — every other transport failure is inconclusive, not a rejection', () => {
    it('maps HTTP 5xx to ProviderUnavailableError', async () => {
      server.setBehavior({ kind: 'respond', status: 500, body: '{}' });
      const before = requestCount();

      const error = await provider()
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error).not.toBeInstanceOf(CredentialsRejectedError);
      expect((error as ProviderUnavailableError).kind).toBe('provider-unavailable');
      expect((error as ProviderUnavailableError).transportKind).toBe('http-status');
      expect((error as ProviderUnavailableError).httpStatus).toBe(500);
      expectMarkerFree(error);
      // No-retry applies to unavailability too: exactly one GET (review P3).
      expect(requestCount()).toBe(before + 1);
    });

    it('maps HTTP 429 to unavailable — rate limiting is no verdict on the key (A3 boundary)', async () => {
      server.setBehavior({
        kind: 'respond',
        status: 429,
        body: '{}',
        headers: { 'retry-after': '60' },
      });

      const error = await provider()
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).httpStatus).toBe(429);
      expectMarkerFree(error);
    });

    it('maps a deadline expiry to unavailable (timeout kind)', async () => {
      server.setBehavior({
        kind: 'respond',
        status: 200,
        body: MODELS_BODY,
        delayMs: 10 * TIMEOUT_MS,
      });

      const error = await provider()
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).transportKind).toBe('timeout');
      expect((error as ProviderUnavailableError).httpStatus).toBeUndefined();
      expectMarkerFree(error);
    });

    it('maps a refused connection to unavailable (connection kind)', async () => {
      const port = await freedLoopbackPort();

      const error = await new ZaiCodingPlanProvider({
        codingBaseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: TIMEOUT_MS,
      })
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).transportKind).toBe('connection');
      expectMarkerFree(error);
    });

    it('maps a 2xx with a non-JSON content type to unavailable (content-type kind)', async () => {
      server.setBehavior({
        kind: 'respond',
        status: 200,
        body: '<html/>',
        headers: { 'content-type': 'text/html' },
      });

      const error = await provider()
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).transportKind).toBe('content-type');
      expectMarkerFree(error);
    });

    it('maps an over-cap 2xx body to unavailable (response-too-large kind)', async () => {
      server.setBehavior({
        kind: 'respond',
        status: 200,
        body: `{"pad":"${'x'.repeat(70_000)}"}`,
      });

      const error = await provider()
        .validateCredentials(account)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).transportKind).toBe('response-too-large');
      expectMarkerFree(error);
    });
  });
});
