import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixedClock, type FixedClock } from '../../src/util/clock';
import { classifyParseFailure, classifyTransportError } from '../../src/services/polling-outcomes';
import { createAccountContext, type AccountContext } from '../../src/providers/registry';
import {
  TransportAbortError,
  TransportContentTypeError,
  TransportError,
  TransportResponseTooLargeError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import {
  SnapshotParseError,
  ZaiCodingPlanProvider,
  type SnapshotLogger,
} from '../../src/providers/zai-coding-plan';
import { findProviderSnapshotProblems, type ProviderSnapshot } from '../../src/schemas/metrics';
import {
  startMockProviderServer,
  type MockProviderServer,
  type ProviderBehavior,
} from '../helpers/mockProviderServer';

/**
 * End-to-end snapshot collection against the loopback mock provider server
 * (spec §7.2, §8.1, §8.3, §17.1; task 099, decision D-053; no-network guard
 * satisfied — everything stays on 127.0.0.1). Pins the task's
 * done-condition: validated responses produce a normalized snapshot through
 * the dossier's endpoint trio, malformed responses fail safely with the
 * §7.4 sanitized hand-off, transport failures surface the D-042 error that
 * task 105 classifies, the §8.1 abort signal flows into every exchange,
 * endpoints 2/3 fail soft — and the account key never appears in any error
 * while the recorded requests prove it genuinely traveled.
 */

/** The marker key (§15.4, §17.1): sent as the Bearer credential, never in an error. */
const MARKER_KEY = 'qm-marker-key-t099';

/**
 * Deadline for every assertion about a *delivered* response (5 s: the
 * transport suite's value for the same loopback mock round-trip, and §7.2's
 * minimum configured timeout, so these run at a production-legal deadline).
 * The value is justified against the mock round-trip, never runner speed:
 * §7.2's deadline is one total bound that starts before the request is sent
 * (D-042), so a short value here would silently assert "the runner finishes
 * the whole exchange within N ms" and race instrumentation plus parallel
 * load — the coupling D-087 removed from the validate suite (U-012); this
 * suite's former single 2 s deadline was the same latent class, just wider.
 * The abort tests share the value for the same reason: their ~50 ms caller
 * abort must beat the deadline, and a fired deadline wins the D-072
 * precedence, so a starved runner must stall for the full 5 s to invert one.
 */
const DELIVERED_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * The short deadline, used only where the deadline itself is the subject
 * (the expiry case in the transport-failure table): the mock delays the
 * response 10× longer, and that delay timer starts at request arrival —
 * strictly after the deadline — so parallel load can only move the response
 * further past the deadline, never before it (D-087).
 */
const EXPIRY_TIMEOUT_MS = 120;

/** The fixed collection timestamp the injected clock reports. */
const COLLECTED_AT = 1_760_000_000_000;

/** The dossier endpoint paths, as the adapter composes them. */
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const RESET_PATH = '/api/biz/customer-package-reset/list?targetType=PERSONAL';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const SANITIZED_QUOTA = fixture('sanitized/zai-quota-limit.json');
const SANITIZED_SUBSCRIPTION = fixture('sanitized/zai-subscription-list.json');
const SANITIZED_RESET = fixture('sanitized/zai-customer-package-reset-list.json');

/** Renders every string an error could leak a secret through. */
function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

/** Resolves a freed loopback port, leaving a refused port behind. */
async function freedLoopbackPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('ZaiCodingPlanProvider.fetchSnapshot over real sockets', () => {
  let server: MockProviderServer;
  let account: AccountContext;
  let clock: FixedClock;
  let warnings: string[];

  beforeAll(async () => {
    server = await startMockProviderServer();
    account = createAccountContext('acc-t099', 'Marker plan', MARKER_KEY);
    clock = createFixedClock(COLLECTED_AT);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    warnings = [];
    server.clearPathBehaviors();
    server.setBehavior({ kind: 'respond', status: 200, body: '{}' });
  });

  /** A warn-capturing logger (D-025 surface, captured for assertions). */
  const capturingLogger = (): SnapshotLogger => ({
    warn: (message: string, data?: Record<string, unknown>) => {
      warnings.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
    },
  });

  /** A provider pointed at the mock server's quota surface. */
  const provider = (
    options: { apiBaseUrl?: string; timeoutMs?: number; withLogger?: boolean } = {},
  ): ZaiCodingPlanProvider =>
    new ZaiCodingPlanProvider({
      apiBaseUrl: options.apiBaseUrl ?? server.url,
      timeoutMs: options.timeoutMs ?? DELIVERED_RESPONSE_TIMEOUT_MS,
      clock,
      ...(options.withLogger === false ? {} : { logger: capturingLogger() }),
    });

  /** Routes a full healthy cycle; individual paths can be overridden after. */
  const routeCycle = (quotaBody: string): void => {
    server.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 200, body: quotaBody });
    server.setPathBehavior(SUBSCRIPTION_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_SUBSCRIPTION,
    });
    server.setPathBehavior(RESET_PATH, { kind: 'respond', status: 200, body: SANITIZED_RESET });
  };

  /** The request URLs of the current cycle, in arrival order. */
  const cycleRequestUrls = (): string[] => server.requests.map((request) => request.url);

  describe('the healthy cycle (sanitized trio)', () => {
    it('collects a normalized snapshot from the dossier endpoints', async () => {
      routeCycle(SANITIZED_QUOTA);

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.providerId).toBe('zai-coding-plan');
      expect(snapshot.collectedAt).toBe(COLLECTED_AT);
      expect(snapshot.planName).toBe('pro');
      // Shapes, vocabulary, and arithmetic only — sanitized values may be
      // re-invented (test/fixtures/README.md).
      expect(snapshot.metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
      for (const metric of snapshot.metrics) {
        expect(metric.isValid).toBe(true);
        if (
          metric.used !== undefined &&
          metric.remaining !== undefined &&
          metric.limit !== undefined
        ) {
          expect(metric.used + metric.remaining).toBe(metric.limit);
        }
        if (metric.percentUsed !== undefined) {
          expect(metric.percentRemaining).toBe(100 - metric.percentUsed);
        }
      }
      expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
    });

    it('issues exactly the three dossier GETs, sequentially, with only the Bearer header', async () => {
      const before = server.requests.length;
      routeCycle(SANITIZED_QUOTA);

      await provider().fetchSnapshot(account, new AbortController().signal);

      expect(cycleRequestUrls().slice(before)).toEqual([QUOTA_PATH, SUBSCRIPTION_PATH, RESET_PATH]);
      for (const request of server.requests.slice(before)) {
        expect(request.method).toBe('GET');
        expect(request.headers.authorization).toBe(`Bearer ${MARKER_KEY}`);
        // A7: no adapter header besides the credential — notably not the
        // prototype's Content-Type.
        expect(request.headers['content-type']).toBeUndefined();
      }
      // The credential-check endpoint is never part of a cycle (096).
      expect(cycleRequestUrls().some((url) => url.includes('/models'))).toBe(false);
      expect(warnings).toEqual([]);
    });
  });

  describe('the fixture matrix through fetchSnapshot (095/097 bodies)', () => {
    interface Row {
      readonly name: string;
      readonly resolves: boolean;
      /** Metric keys when the cycle resolves. */
      readonly keys?: string[];
      /** Parse-failure reason when it rejects. */
      readonly reason?: string;
    }
    const rows: readonly Row[] = [
      { name: 'zai-envelope-code-string.json', resolves: true, keys: [] },
      { name: 'zai-envelope-code-zero.json', resolves: true, keys: [] },
      { name: 'zai-quota-limit-empty-limits.json', resolves: true, keys: [] },
      { name: 'zai-quota-limit-unknown-type.json', resolves: true, keys: [] },
      { name: 'zai-quota-limit-different-unit.json', resolves: true, keys: [] },
      { name: 'zai-quota-limit-weekly.json', resolves: true, keys: ['weekly-quota', 'tokens-5h'] },
      { name: 'zai-quota-limit-tokens-absolute.json', resolves: true, keys: ['tokens-5h'] },
      { name: 'zai-quota-limit-partial.json', resolves: true, keys: ['mcp-monthly'] },
      {
        name: 'zai-quota-limit-different-plan.json',
        resolves: true,
        keys: ['mcp-monthly', 'tokens-5h'],
      },
      {
        name: 'zai-quota-limit-extra-fields.json',
        resolves: true,
        keys: ['mcp-monthly', 'tokens-5h'],
      },
      {
        name: 'zai-quota-limit-duplicate-keys.json',
        resolves: true,
        keys: ['mcp-monthly', 'weekly-quota'],
      },
      {
        name: 'zai-quota-limit-invalid-entries.json',
        resolves: true,
        keys: ['tokens-5h', 'mcp-monthly', 'weekly-quota'],
      },
      { name: 'zai-quota-limit-reset-time-string.json', resolves: true, keys: ['mcp-monthly'] },
      {
        name: 'zai-quota-limit-renamed-fields.json',
        resolves: true,
        keys: ['mcp-monthly', 'tokens-5h'],
      },
      {
        name: 'zai-envelope-error.json',
        resolves: false,
        reason: 'the response envelope code was not a success value',
      },
      {
        name: 'zai-envelope-malformed.json',
        resolves: false,
        reason: 'the response envelope code was not a success value',
      },
      {
        name: 'zai-quota-limit-data-not-object.json',
        resolves: false,
        reason: 'the response data was not an object',
      },
      {
        name: 'zai-quota-limit-limits-not-array.json',
        resolves: false,
        reason: 'the response limits field was not an array',
      },
    ];

    for (const row of rows) {
      it(`${row.name}: ${row.resolves ? 'resolves' : 'fails the cycle safely'}`, async () => {
        routeCycle(fixture(`synthetic/${row.name}`));
        const outcome = await provider()
          .fetchSnapshot(account, new AbortController().signal)
          .then(
            (snapshot: ProviderSnapshot) => ({ snapshot }),
            (error: unknown) => ({ error }),
          );

        if (row.resolves) {
          if (!('snapshot' in outcome)) {
            throw new Error(`expected resolution: ${String(outcome.error)}`);
          }
          expect(outcome.snapshot.metrics.map((metric) => metric.key)).toEqual(row.keys);
          expect(findProviderSnapshotProblems(outcome.snapshot)).toEqual([]);
        } else {
          if (!('error' in outcome)) throw new Error('expected rejection');
          expect(outcome.error).toBeInstanceOf(SnapshotParseError);
          const parseError = outcome.error as SnapshotParseError;
          expect(parseError.reason).toBe(row.reason);
          expect(parseError.httpStatus).toBe(200);
          expect(parseError.sanitizedPayload.length).toBeGreaterThan(0);
          // The cycle fed 105's parse seam exactly as D-048 fixed it.
          expect(
            classifyParseFailure({
              httpStatus: parseError.httpStatus,
              reason: parseError.reason,
            }).outcome,
          ).toBe('parse_error');
          // Fail fast: no context endpoint was fetched after a primary failure.
          expect(cycleRequestUrls().at(-1)).toBe(QUOTA_PATH);
        }
      });
    }

    it('collects skip reports from the cycle into warn logs', async () => {
      routeCycle(fixture('synthetic/zai-quota-limit-duplicate-keys.json'));

      await provider().fetchSnapshot(account, new AbortController().signal);

      expect(warnings).toEqual([
        expect.stringContaining("skipped duplicate limits entry for metric key 'weekly-quota'"),
        expect.stringContaining("skipped duplicate limits entry for metric key 'mcp-monthly'"),
      ]);
    });

    it('sanitizes skip reports before they reach the log (§15.4, review P2-2)', async () => {
      // An unknown entry whose type field echoes the account key: the skip
      // report must land redacted, by construction, not by sink wiring.
      const body = JSON.stringify({
        code: 200,
        msg: 'Operation successful',
        data: {
          limits: [{ type: MARKER_KEY, unit: 9, number: 1, percentage: 4 }],
          level: 'pro',
        },
      });
      routeCycle(body);

      await provider().fetchSnapshot(account, new AbortController().signal);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain(MARKER_KEY);
      expect(warnings[0]).toContain('[REDACTED]');
    });

    it('leaves the cycle untouched by a non-empty reset-card body (A4, D-047.6)', async () => {
      // The one 095/097 fixture not routable through endpoint 1: the
      // never-parsed endpoint-3 body (assumption shape A4) must have no
      // effect at all — fetched, discarded, no warning.
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(RESET_PATH, {
        kind: 'respond',
        status: 200,
        body: fixture('synthetic/zai-customer-package-reset-cards.json'),
      });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.planName).toBe('pro');
      expect(snapshot.metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
      expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
      expect(warnings).toEqual([]);
      expect(cycleRequestUrls().at(-1)).toBe(RESET_PATH);
    });
  });

  describe('endpoint-1 transport failures surface the D-042 error (105 classifies)', () => {
    interface TransportCase {
      readonly name: string;
      readonly behavior: ProviderBehavior;
      readonly outcome: string;
      readonly errorClass: new (...args: never[]) => TransportError;
      /** Per-case request deadline override, when shorter than the default. */
      readonly timeoutMs?: number;
    }
    const cases: readonly TransportCase[] = [
      {
        name: 'HTTP 500',
        behavior: { kind: 'respond', status: 500, body: '{}' },
        outcome: 'server_error',
        errorClass: TransportStatusError,
      },
      {
        name: 'HTTP 401',
        behavior: { kind: 'respond', status: 401, body: '{}' },
        outcome: 'auth_error',
        errorClass: TransportStatusError,
      },
      {
        name: 'wrong content type',
        behavior: {
          kind: 'respond',
          status: 200,
          body: '<html/>',
          headers: { 'content-type': 'text/html' },
        },
        outcome: 'parse_error',
        errorClass: TransportContentTypeError,
      },
      {
        name: 'over-cap body',
        behavior: { kind: 'respond', status: 200, body: `{"pad":"${'x'.repeat(70_000)}"}` },
        outcome: 'parse_error',
        errorClass: TransportResponseTooLargeError,
      },
      {
        name: 'timeout',
        // The 10× arrival-anchored delay keeps the expiry deterministic
        // under load (see EXPIRY_TIMEOUT_MS above, D-087).
        behavior: {
          kind: 'respond',
          status: 200,
          body: '{}',
          delayMs: 10 * EXPIRY_TIMEOUT_MS,
        },
        outcome: 'timeout',
        errorClass: TransportTimeoutError,
        timeoutMs: EXPIRY_TIMEOUT_MS,
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.name} → rethrown, classified ${testCase.outcome}, fail-fast, key-free`, async () => {
        server.setPathBehavior(QUOTA_PATH, testCase.behavior);
        const before = server.requests.length;

        const error = await provider({ timeoutMs: testCase.timeoutMs })
          .fetchSnapshot(account, new AbortController().signal)
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(testCase.errorClass);
        expect(error).toBeInstanceOf(TransportError);
        expect(classifyTransportError(error as TransportError).outcome).toBe(testCase.outcome);
        expect(errorSurface(error)).not.toContain(MARKER_KEY);
        // Fail fast: the primary failed, so no context endpoint was fetched.
        expect(server.requests.length).toBe(before + 1);
        expect(server.requests.at(-1)?.url).toBe(QUOTA_PATH);
        // The key genuinely traveled — the leak assertion is not vacuous.
        expect(server.requests.at(-1)?.headers.authorization).toBe(`Bearer ${MARKER_KEY}`);
      });
    }

    it('HTTP 429 → rate_limited with the Retry-After passthrough', async () => {
      server.setPathBehavior(QUOTA_PATH, {
        kind: 'respond',
        status: 429,
        body: '{}',
        headers: { 'retry-after': '60' },
      });

      const error = await provider()
        .fetchSnapshot(account, new AbortController().signal)
        .catch((thrown: unknown) => thrown);

      const classified = classifyTransportError(error as TransportStatusError);
      expect(classified.outcome).toBe('rate_limited');
      expect(classified.retryAfterRaw).toBe('60');
      expect(classified.retryAfterEligible).toBe(true);
      expect(errorSurface(error)).not.toContain(MARKER_KEY);
    });

    it('a refused connection → network_error (apiBaseUrl override)', async () => {
      const port = await freedLoopbackPort();

      const error = await provider({ apiBaseUrl: `http://127.0.0.1:${port}` })
        .fetchSnapshot(account, new AbortController().signal)
        .catch((thrown: unknown) => thrown);

      expect(classifyTransportError(error as TransportError).outcome).toBe('network_error');
      expect(errorSurface(error)).not.toContain(MARKER_KEY);
    });

    it('a destroyed socket on endpoint 1 → network_error, fail-fast (review P3-2)', async () => {
      server.setPathBehavior(QUOTA_PATH, { kind: 'abort' });
      const before = server.requests.length;

      const error = await provider()
        .fetchSnapshot(account, new AbortController().signal)
        .catch((thrown: unknown) => thrown);

      expect(classifyTransportError(error as TransportError).outcome).toBe('network_error');
      expect(errorSurface(error)).not.toContain(MARKER_KEY);
      expect(server.requests.length).toBe(before + 1);
    });
  });

  describe('parse failures carry the §7.4 sanitized hand-off', () => {
    it('sanitizes a marker-echoing body before it travels on the error', async () => {
      server.setPathBehavior(QUOTA_PATH, {
        kind: 'respond',
        status: 200,
        body: `{"code":200,"data":{"api_key":"${MARKER_KEY}","limits":"${MARKER_KEY}"}}`,
      });

      const error = await provider()
        .fetchSnapshot(account, new AbortController().signal)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(SnapshotParseError);
      const parseError = error as SnapshotParseError;
      expect(parseError.reason).toBe('the response limits field was not an array');
      expect(parseError.sanitizedPayload).not.toContain(MARKER_KEY);
      expect(parseError.sanitizedPayload).toContain('[REDACTED]');
      expect(errorSurface(error)).not.toContain(MARKER_KEY);
    });

    it('never crashes the process on arbitrary malformed bodies', async () => {
      for (const body of ['', 'not json', '{"code":true}', '[]', '{"code":200,"data":[]}']) {
        server.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 200, body });

        const error = await provider()
          .fetchSnapshot(account, new AbortController().signal)
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(SnapshotParseError);
        expect(errorSurface(error)).not.toContain(MARKER_KEY);
      }
    });
  });

  describe('the §8.1 abort signal flows into the exchanges', () => {
    it('an abort during endpoint 1 rejects with TransportAbortError → cancelled', async () => {
      server.setPathBehavior(QUOTA_PATH, {
        kind: 'respond',
        status: 200,
        body: SANITIZED_QUOTA,
        delayMs: 500,
      });
      const controller = new AbortController();

      const pending = provider().fetchSnapshot(account, controller.signal);
      setTimeout(() => controller.abort(), 50);

      const error = await pending.catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(TransportAbortError);
      expect(classifyTransportError(error as TransportAbortError).outcome).toBe('cancelled');
      expect(errorSurface(error)).not.toContain(MARKER_KEY);
    });

    it('an abort during a soft endpoint degrades the cycle, never fails it', async () => {
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(SUBSCRIPTION_PATH, {
        kind: 'respond',
        status: 200,
        body: SANITIZED_SUBSCRIPTION,
        delayMs: 1_000,
      });
      const controller = new AbortController();
      // The request log accumulates across the file's tests — gate only on
      // this cycle's own records (the spec's established baseline slice).
      const before = server.requests.length;

      const pending = provider().fetchSnapshot(account, controller.signal);
      // Abort only once the endpoint-2 GET is on the wire. The exchanges
      // are strictly sequential (endpoint 1 await -> parse -> endpoint 2),
      // so this cycle's subscription request arriving is causal proof that
      // the primary exchange already completed client-side — the old "first
      // request arrived" gate let the abort land inside the primary's
      // arrival-to-read window under parallel-suite load, where abort
      // propagation is the designed §8.1 behavior (U-010).
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (
            server.requests
              .slice(before)
              .some((recorded) => recorded.url.startsWith(SUBSCRIPTION_PATH))
          ) {
            clearInterval(poll);
            controller.abort();
            resolve();
          }
        }, 5);
        setTimeout(() => {
          clearInterval(poll);
          reject(new Error('endpoint 2 (subscription) request never arrived'));
        }, 2_000).unref();
      });

      const snapshot = await pending;

      expect(snapshot.metrics.map((metric) => metric.key)).toEqual(['mcp-monthly', 'tokens-5h']);
      // planName still present: endpoint 1's level was collected before the abort.
      expect(snapshot.planName).toBe('pro');
      expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining('subscription context fetch failed'),
        expect.stringContaining('reset-card context fetch failed'),
      ]);
    });
  });

  describe('endpoints 2/3 fail soft (their failure never fails the snapshot)', () => {
    it('survives a subscription 500 and keeps the level-based plan name', async () => {
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(SUBSCRIPTION_PATH, { kind: 'respond', status: 500, body: '{}' });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.planName).toBe('pro');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('subscription context fetch failed');
      expect(warnings[0]).toContain('"transportKind":"http-status"');
    });

    it('survives a subscription parse violation without §7.4 retention', async () => {
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(SUBSCRIPTION_PATH, {
        kind: 'respond',
        status: 200,
        body: fixture('synthetic/zai-subscription-list-data-not-array.json'),
      });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.planName).toBe('pro');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('subscription context degraded');
      expect(warnings[0]).toContain('the response data was not an array');
    });

    it('survives a destroyed socket on the reset-cards endpoint', async () => {
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(RESET_PATH, { kind: 'abort' });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.planName).toBe('pro');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('reset-card context fetch failed');
      expect(warnings[0]).toContain('"transportKind":"socket"');
    });

    it('falls back to the endpoint-2 plan name when level is absent (A9)', async () => {
      routeCycle(fixture('synthetic/zai-quota-limit-renamed-fields.json'));
      server.setPathBehavior(SUBSCRIPTION_PATH, {
        kind: 'respond',
        status: 200,
        body: fixture('synthetic/zai-subscription-list-divergent.json'),
      });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      // The inCurrentPeriod record wins over the first VALID one.
      expect(snapshot.planName).toBe('GLM Coding Max');
    });

    it('omits planName when neither source supplies one', async () => {
      routeCycle(fixture('synthetic/zai-quota-limit-renamed-fields.json'));
      server.setPathBehavior(SUBSCRIPTION_PATH, {
        kind: 'respond',
        status: 200,
        body: fixture('synthetic/zai-subscription-list-data-not-array.json'),
      });

      const snapshot = await provider().fetchSnapshot(account, new AbortController().signal);

      expect(snapshot.planName).toBeUndefined();
      expect('planName' in snapshot).toBe(false);
      expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
    });
  });

  describe('without an injected logger', () => {
    it('collects and degrades silently', async () => {
      routeCycle(SANITIZED_QUOTA);
      server.setPathBehavior(RESET_PATH, { kind: 'abort' });

      const snapshot = await provider({ withLogger: false }).fetchSnapshot(
        account,
        new AbortController().signal,
      );

      expect(snapshot.planName).toBe('pro');
    });
  });
});
