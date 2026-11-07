import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProviderServer, type MockProviderServer } from '../helpers/mockProviderServer';
import { createAccountContext, type AccountContext } from '../../src/providers/registry';
import type { QuotaProvider } from '../../src/providers/registry';
import { TransportError } from '../../src/providers/transport';
import { ProviderUnavailableError } from '../../src/providers/zai-coding-plan';
import { createConfiguredZaiProvider, observingManualTests } from '../../src/server/providers';
import {
  createAccountSuspensions,
  keyIdentityOfSecret,
} from '../../src/services/account-suspensions';
import { isSuspended } from '../../src/services/polling-suspension';
import { createFixedClock, type Clock, type FixedClock } from '../../src/util/clock';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import type { Config, PeakHoursConfig, ProvidersConfig } from '../../src/schemas/config';

/**
 * The U-054 done-condition over real sockets: the composition root's
 * production provider factory — `createConfiguredZaiProvider`, the registry
 * default `composeApplication` registers — derives the §7.2 transport
 * deadline from the LIVE effective configuration (§6.4-live, D-026) and
 * rides the shared clock (D-021) and the shared redacting logger. The
 * factory's own base-URL test seams point the adapter at the loopback mock
 * (the adapter's own injectable-seam precedent); production omits them and
 * the composition passes none.
 *
 * **Deadline margins (D-087).** Delivered-response cells run at
 * `requestTimeoutSeconds: 5` — §7.2's minimum legal value and the house
 * deadline for loopback round-trips. Expiry cells (the deadline is the
 * subject) inject `0.12` through the factory's reader seam: the factory
 * multiplies whatever the effective configuration supplies — the 5–60 s
 * range is enforced where configuration enters (the schema and the load
 * pipeline, D-042's stance), pinned by the config suites — and the mock's
 * delay timer arms at request arrival, strictly after the deadline starts,
 * at 10× the deadline, so parallel load only moves a response further past
 * the deadline, never before it.
 */

/** The dossier endpoint paths, as the adapter composes them. */
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const RESET_PATH = '/api/biz/customer-package-reset/list?targetType=PERSONAL';
const CREDENTIALS_PATH = '/models';

/** §7.2's minimum legal configured deadline (the D-087 house value), seconds. */
const LEGAL_SECONDS = 5;

/** The injected expiry-case deadline, seconds (120 ms; see the header). */
const EXPIRY_SECONDS = 0.12;

/** The shared clock's fixed reading — `collectedAt` must be exactly this. */
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** The §15.4 marker secret — carried by the context, never leaked. */
const MARKER_KEY = 'sk-marker-configured-provider-b41c';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const SANITIZED_QUOTA = fixture('sanitized/zai-quota-limit.json');
const SANITIZED_SUBSCRIPTION = fixture('sanitized/zai-subscription-list.json');
const SANITIZED_RESET = fixture('sanitized/zai-customer-package-reset-list.json');

/** An empty §9.2 schedule — the shape the config type requires. */
const peakHours = (): PeakHoursConfig => ({ timezone: 'UTC', windows: [] });

/** The zai provider entry as the load pipeline materializes it. */
const zaiEntry = (requestTimeoutSeconds: number): ProvidersConfig[string] => ({
  peakHours: peakHours(),
  requestTimeoutSeconds,
});

/** A minimal effective configuration over one providers record. */
const configOf = (providers?: ProvidersConfig): Config => ({
  app: { timezone: 'UTC' },
  ...(providers === undefined ? {} : { providers }),
});

describe('createConfiguredZaiProvider over real sockets (U-054, D-179)', () => {
  let server: MockProviderServer;
  let account: AccountContext;
  let clock: FixedClock;
  let sink: MemoryLogSink;

  beforeAll(async () => {
    server = await startMockProviderServer();
    account = createAccountContext('configured', 'Configured plan', MARKER_KEY);
    clock = createFixedClock(T0);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.clearPathBehaviors();
    server.setBehavior({ kind: 'respond', status: 200, body: '{}' });
    // A fresh sink per cell: the logger assertion stays non-vacuous no
    // matter what earlier cells emitted.
    sink = createMemoryLogSink();
  });

  /** The factory over one reader, pointed at the mock through its test seams. */
  const factory = (config: () => Config, clockOverride?: Clock): QuotaProvider =>
    createConfiguredZaiProvider({
      config,
      clock: clockOverride ?? clock,
      logger: createLogger({ level: 'debug', destination: sink, secrets: [MARKER_KEY] }),
      codingBaseUrl: server.url,
      apiBaseUrl: server.url,
    });

  /** Routes the healthy dossier trio (the sanitized fixtures) on the mock. */
  const routeHealthy = (): void => {
    server.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 200, body: SANITIZED_QUOTA });
    server.setPathBehavior(SUBSCRIPTION_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_SUBSCRIPTION,
    });
    server.setPathBehavior(RESET_PATH, { kind: 'respond', status: 200, body: SANITIZED_RESET });
  };

  it('times the collection cycle out at the configured deadline (§7.2)', async () => {
    server.setPathBehavior(QUOTA_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_QUOTA,
      delayMs: 1_200,
    });
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(EXPIRY_SECONDS) }));

    // Endpoint 1's transport failure re-throws the D-042 error unchanged —
    // the kind is the polling classifier's own vocabulary.
    const error = await provider.fetchSnapshot(account, new AbortController().signal).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error, 'the configured 120 ms deadline expires the cycle').toBeInstanceOf(
      TransportError,
    );
    expect((error as TransportError).kind).toBe('timeout');
  });

  it('times the credential check out at the configured deadline (D-052 surface)', async () => {
    server.setPathBehavior(CREDENTIALS_PATH, {
      kind: 'respond',
      status: 200,
      body: '{}',
      delayMs: 1_200,
    });
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(EXPIRY_SECONDS) }));

    // The check itself is inconclusive (D-052): the deadline is the
    // transport's, and the taxonomy carries it as `transportKind`.
    await expect(provider.validateCredentials(account)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(provider.validateCredentials(account)).rejects.toMatchObject({
      kind: 'provider-unavailable',
      transportKind: 'timeout',
    });
  });

  it('delivers at a schema-legal configured deadline (§7.2 minimum, D-087)', async () => {
    routeHealthy();
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(LEGAL_SECONDS) }));

    const snapshot = await provider.fetchSnapshot(account, new AbortController().signal);

    expect(snapshot.providerId).toBe('zai-coding-plan');
    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.metrics.map((metric) => metric.key).sort()).toEqual([
      'mcp-monthly',
      'tokens-5h',
    ]);
  });

  it('stamps collectedAt from the injected shared clock (D-021)', async () => {
    routeHealthy();
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(LEGAL_SECONDS) }));

    const snapshot = await provider.fetchSnapshot(account, new AbortController().signal);

    // The fixed clock never advances: an adapter-constructed system clock
    // would answer a real reading instead of T0 — the D-021 single-clock
    // discipline made executable.
    expect(snapshot.collectedAt).toBe(T0);
  });

  it('applies a reloaded timeout on the next request, without any rebuild (§6.4/D-026)', async () => {
    let seconds = LEGAL_SECONDS;
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(seconds) }));
    const signal = (): AbortSignal => new AbortController().signal;

    // Under the first effective deadline (5 s) a 1.5 s delayed cycle
    // delivers — the wrapper's request resolves through the adapter built
    // for that value.
    server.setPathBehavior(QUOTA_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_QUOTA,
      delayMs: 1_500,
    });
    server.setPathBehavior(SUBSCRIPTION_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_SUBSCRIPTION,
    });
    server.setPathBehavior(RESET_PATH, { kind: 'respond', status: 200, body: SANITIZED_RESET });
    const delivered = await provider.fetchSnapshot(account, signal());
    expect(delivered.providerId).toBe('zai-coding-plan');

    // A reload lowers the effective seconds. The SAME wrapper — the same
    // registry entry the recorders captured — must apply the new deadline
    // on the very next request: an adapter pinned at construction would
    // still hold 5 s and deliver this cycle.
    seconds = EXPIRY_SECONDS;
    server.setPathBehavior(QUOTA_PATH, {
      kind: 'respond',
      status: 200,
      body: SANITIZED_QUOTA,
      delayMs: 1_200,
    });
    const error = await provider.fetchSnapshot(account, signal()).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error, 'the reloaded 120 ms deadline expires the next cycle').toBeInstanceOf(
      TransportError,
    );
    expect((error as TransportError).kind).toBe('timeout');
  }, 10_000);

  it('falls back to the §7.2 default deadline when no zai entry exists', async () => {
    routeHealthy();
    // Both optional-chain arms of the derivation. The fallback VALUE is
    // CONFIG_DEFAULTS.provider.requestTimeoutSeconds (15, pinned by the
    // config suites — the factory reads that exact constant), so the
    // behavioral pin here is the delivered response, not a >5 s delay
    // cell distinguishing 15 from 5. The absent-section arm is a
    // contract-shape cell: the load pipeline always materializes
    // `providers` (`src/config/load.ts`), so production reaches only the
    // missing-entry arm — the `Config` type keeps the section optional,
    // and this cell pins that the type's optional arm degrades to the
    // default rather than throwing.
    const sectionAbsent = factory(() => configOf());
    const foreignEntry = factory(() => configOf({ beta: zaiEntry(LEGAL_SECONDS) }));

    for (const provider of [sectionAbsent, foreignEntry]) {
      const snapshot = await provider.fetchSnapshot(account, new AbortController().signal);
      expect(snapshot.providerId).toBe('zai-coding-plan');
    }
  });

  it('keeps the manual-test observation intact over the live wrapper (the composition nesting)', async () => {
    server.setPathBehavior(CREDENTIALS_PATH, { kind: 'respond', status: 200, body: '{"data":[]}' });
    const suspensions = createAccountSuspensions({ clock });
    const observed = observingManualTests(
      factory(() => configOf({ 'zai-coding-plan': zaiEntry(LEGAL_SECONDS) })),
      { suspensions },
    );
    // §7.2's release target: the account is suspended under this key.
    suspensions.manualTestRejected(account.accountId, keyIdentityOfSecret(MARKER_KEY));
    expect(isSuspended(suspensions.suspensionOf(account.accountId))).toBe(true);

    // The composition registers exactly this nesting — the observation
    // wraps the LIVE wrapper — and a successful test lifts the pause.
    const before = server.requests.length;
    await expect(observed.validateCredentials(account)).resolves.toBeUndefined();
    expect(isSuspended(suspensions.suspensionOf(account.accountId))).toBe(false);
    expect(server.requests.length).toBe(before + 1);
    expect(server.requests.at(-1)?.url).toBe(CREDENTIALS_PATH);
  });

  it('wires the shared logger into the adapter’s soft-failure warnings (§16)', async () => {
    // Endpoint 1 healthy, endpoint 2 soft-failing: the cycle still delivers
    // (D-047 fail-soft) and the degradation becomes visible in the shared
    // logger instead of staying silent.
    server.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 200, body: SANITIZED_QUOTA });
    server.setPathBehavior(SUBSCRIPTION_PATH, { kind: 'abort' });
    server.setPathBehavior(RESET_PATH, { kind: 'respond', status: 200, body: SANITIZED_RESET });
    const provider = factory(() => configOf({ 'zai-coding-plan': zaiEntry(LEGAL_SECONDS) }));

    const snapshot = await provider.fetchSnapshot(account, new AbortController().signal);

    expect(snapshot.providerId).toBe('zai-coding-plan');
    const logs = sink.lines().join('\n');
    expect(logs, 'the soft failure reaches the shared logger').toContain(
      'subscription context fetch failed',
    );
    expect(logs, '§15.4: the marker key never reaches a log line').not.toContain(MARKER_KEY);
  });
});
