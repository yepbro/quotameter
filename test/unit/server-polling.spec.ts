import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry';
import type { QuotaProvider } from '../../src/providers/registry';
import {
  createAccountSuspensions,
  keyIdentityOfSecret,
} from '../../src/services/account-suspensions';
import type { CycleOutcome } from '../../src/services/polling-outcomes';
import { classifySuccess, classifyTransportError } from '../../src/services/polling-outcomes';
import type { CycleRecorder, CycleRecorderOptions } from '../../src/services/polling-persist';
import type {
  PollingAccount,
  PollingScheduler,
  PollingSchedulerOptions,
} from '../../src/services/polling-scheduler';
import { createPollingEngine } from '../../src/server/polling';
import type { ReloadSuccess } from '../../src/config/reload';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import type { QuotaRepository } from '../../src/storage/repository';
import { TransportStatusError } from '../../src/providers/transport';
import { createFixedClock, type Clock } from '../../src/util/clock';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * The polling engine composition (task U-051, decision D-176; the
 * single-holder unification FSM-3/D-189): the wiring builder's account
 * selection (§7.2 isolation), the lifecycle component's delegation, the
 * §6.4 reload feeds, the manual-test bridge, the settle wrapper's
 * diagnostics, and the structural pin that the ONE suspension store is
 * forwarded to the scheduler — pinned against a spy scheduler and double
 * recorders. The D-064 store's behavioral coverage (every event source,
 * staleness included, against the real scheduler) is
 * `polling-suspension-lockstep.spec.ts`; the end-to-end behavior (real
 * scheduler, real recorder, real adapter on the loopback mock) is
 * `test/integration/composition-polling.spec.ts`'s.
 */

/** The fixed clock reading every case starts from: 2026-11-06T12:00:00Z. */
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** The §15.4 marker secret — resolved into contexts, never into a log line. */
const MARKER_KEY = 'sk-marker-polling-engine-3a6f';

/** The classification of a polled 401 (the §7.2 auth-rejection row). */
const OUTCOME_AUTH_ERROR: CycleOutcome = classifyTransportError(
  new TransportStatusError(401, '', undefined),
);

/** A minimal configuration carrying an optional accounts array. */
const configOf = (accounts: Config['accounts']): Config =>
  ({ app: { timezone: 'UTC' }, accounts }) as Config;

/** A successful reload literal over a configuration (§6.4's vocabulary). */
const reloadOf = (config: Config, applied: ReloadSuccess['applied']): ReloadSuccess => ({
  ok: true,
  outcome: 'applied',
  effective: {
    config: config as unknown as Validated<Config>,
    sources: { fields: [], accountSecrets: [] },
    fileAbsent: false,
  },
  applied,
  restartRequired: [],
});

/* ── The doubles ─────────────────────────────────────────────────────────── */

/** A registry with one known provider ('known-provider'). */
function registryWithKnown(): ProviderRegistry {
  const provider: QuotaProvider = {
    id: 'known-provider',
    name: 'Known provider (test double)',
    async validateCredentials(): Promise<void> {},
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test');
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

/** Records every scheduler call the engine's contracts care about. */
function spyScheduler(): PollingScheduler & {
  accountsCalls: PollingAccount[][];
  intervalCalls: number[];
  manualTestCalls: string[];
  manualRejectionCalls: string[];
  readonly started: boolean;
  readonly stopped: boolean;
} {
  const accountsCalls: PollingAccount[][] = [];
  const intervalCalls: number[] = [];
  const manualTestCalls: string[] = [];
  const manualRejectionCalls: string[] = [];
  let started = false;
  let stopped = false;
  return {
    accountsCalls,
    intervalCalls,
    manualTestCalls,
    manualRejectionCalls,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    start() {
      started = true;
    },
    setAccounts(accounts) {
      accountsCalls.push([...accounts]);
    },
    setIntervalMs(intervalMs) {
      intervalCalls.push(intervalMs);
    },
    requestManualTest(accountId) {
      manualTestCalls.push(accountId);
      return true;
    },
    manualTestRejected(accountId) {
      manualRejectionCalls.push(accountId);
      return true;
    },
    async stop() {
      stopped = true;
    },
    get running() {
      return started && !stopped;
    },
  };
}

/**
 * Double recorders: each build is recorded with its options, an `ok` result
 * of the MARKER-keyed account classifies `success` while any other key
 * classifies the polled 401, and a failed result throws — the wrapper's
 * failure arm.
 */
function recorderSpy() {
  const built: CycleRecorderOptions[] = [];
  const factory = (options: CycleRecorderOptions): CycleRecorder => {
    built.push(options);
    return {
      attempt: () => {
        throw new Error('attempt is not under test');
      },
      settleCycle: (result) => {
        if (!result.ok) {
          // A bare string rejects the settlement too — the wrapper's
          // non-Error log arm.
          if (typeof result.error === 'string') throw result.error;
          throw new Error('recorder double failed to settle');
        }
        return options.account.secret === MARKER_KEY ? classifySuccess(200) : OUTCOME_AUTH_ERROR;
      },
      abandonCycle: () => {},
    };
  };
  return { built, factory };
}

/** The repository double: only the recorder factory's shape check matters. */
const repositoryDouble = {
  withTransaction: () => {},
  insertCollectionRun: () => 1,
} as unknown as QuotaRepository;

/** Everything {@link createPollingEngine} needs, with the spies installed. */
function engineHarness(config: Config, env: NodeJS.ProcessEnv = {}) {
  const clock: Clock = createFixedClock(T0);
  const sink: MemoryLogSink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'debug', destination: sink });
  const suspensions = createAccountSuspensions({ clock });
  const scheduler = spyScheduler();
  const recorders = recorderSpy();
  let schedulerOptions: PollingSchedulerOptions | undefined;
  let current: Config = config;
  const engine = createPollingEngine({
    clock,
    logger,
    env,
    registry: registryWithKnown(),
    suspensions,
    repository: repositoryDouble,
    config: () => current,
    inFlight: { begin: () => ({ done: () => {} }), whenIdle: () => Promise.resolve(), count: 0 },
    schedulerFactory: (options: PollingSchedulerOptions) => {
      // The §7.1 interval the engine derived from the configuration — the
      // seconds/milliseconds fail-fast seam, pinned at the factory.
      expect(options.intervalMs).toBe(300_000);
      schedulerOptions = options;
      return scheduler;
    },
    recorderFactory: recorders.factory,
  });
  return {
    engine,
    scheduler,
    recorders,
    suspensions,
    sink,
    /** The options the engine handed the scheduler factory (last call). */
    schedulerOptions: (): PollingSchedulerOptions | undefined => schedulerOptions,
    setConfig(next: Config): void {
      current = next;
    },
  };
}

/* ── The wiring builder ──────────────────────────────────────────────────── */

describe('createPollingEngine wiring', () => {
  it('builds wiring only for enabled, secret-resolvable, registered accounts', async () => {
    const harness = engineHarness(
      configOf([
        { id: 'healthy', providerId: 'known-provider', label: 'Healthy', apiKey: MARKER_KEY },
        { id: 'off', providerId: 'known-provider', label: 'Off', enabled: false, apiKey: 'k-off' },
        { id: 'keyless', providerId: 'known-provider', label: 'Keyless (§5.3 skip)' },
        {
          id: 'env-unset',
          providerId: 'known-provider',
          label: 'Env unset',
          apiKeyEnv: 'QM_POLLING_UNSET',
        },
        { id: 'foreign', providerId: 'no-such-adapter', label: 'Foreign', apiKey: 'k-foreign' },
      ]),
    );

    await harness.engine.component.start();

    expect(harness.scheduler.accountsCalls).toHaveLength(1);
    const wiring = harness.scheduler.accountsCalls[0] as PollingAccount[];
    expect(wiring.map((account) => account.accountId)).toEqual(['healthy']);
    // The wiring's key identity is the holder's vocabulary (D-064).
    expect(wiring[0]!.keyIdentity).toBe(keyIdentityOfSecret(MARKER_KEY));

    expect(harness.recorders.built).toHaveLength(1);
    const { account, provider, intervalSeconds } = harness.recorders.built[0]!;
    expect(account.accountId).toBe('healthy');
    expect(account.label).toBe('Healthy');
    // The resolved secret reaches the adapter context (§8.1) — and nothing
    // else: serialization cannot carry the non-enumerable value.
    expect(account.secret).toBe(MARKER_KEY);
    expect(JSON.stringify(account)).not.toContain(MARKER_KEY);
    expect(provider.id).toBe('known-provider');
    expect(intervalSeconds()).toBe(300);
  });

  it('resolves apiKeyEnv against the startup environment snapshot', async () => {
    const harness = engineHarness(
      configOf([{ id: 'envy', providerId: 'known-provider', label: 'Env', apiKeyEnv: 'QM_KEY' }]),
      { QM_KEY: MARKER_KEY },
    );
    await harness.engine.component.start();
    expect(harness.recorders.built[0]!.account.secret).toBe(MARKER_KEY);
  });

  it('skips schema-valid but trim-blank labels and secrets instead of aborting startup', async () => {
    const harness = engineHarness(
      configOf([
        // All three are `minLength: 1` strings the configuration contract
        // accepts; the context gate rejects them trim-blank, and the
        // never-throw selection skips the account (the review round's P1:
        // startup must not abort over a whitespace-only value).
        { id: 'blank-key', providerId: 'known-provider', label: 'Fine', apiKey: '   ' },
        { id: 'blank-env', providerId: 'known-provider', label: 'Fine', apiKeyEnv: 'QM_BLANK' },
        { id: 'blank-env-value', providerId: 'known-provider', label: 'Fine', apiKeyEnv: 'QM_SP' },
        { id: 'blank-label', providerId: 'known-provider', label: '   ', apiKey: 'k' },
      ]),
      { QM_BLANK: '   ', QM_SP: ' ' },
    );
    await expect(harness.engine.component.start()).resolves.toBeUndefined();
    expect(harness.scheduler.accountsCalls[0]).toEqual([]);
    const text = harness.sink.lines().join('\n');
    expect(text).toContain("polling: account 'blank-key' is not polled (no resolved secret)");
    expect(text).toContain("polling: account 'blank-env' is not polled (no resolved secret)");
    expect(text).toContain("polling: account 'blank-env-value' is not polled (no resolved secret)");
    expect(text).toContain("polling: account 'blank-label' is not polled (blank label)");
  });

  it('reads the interval live: a config change flows through the reader', async () => {
    const harness = engineHarness(
      configOf([{ id: 'healthy', providerId: 'known-provider', label: 'H', apiKey: MARKER_KEY }]),
    );
    await harness.engine.component.start();
    const { intervalSeconds } = harness.recorders.built[0]!;
    expect(intervalSeconds()).toBe(300);
    harness.setConfig({ app: { timezone: 'UTC', pollingIntervalSeconds: 90 } } as Config);
    expect(intervalSeconds()).toBe(90); // §6.4: the reader, not a copy
  });

  it('logs the skip reasons without ever logging the secret', async () => {
    const harness = engineHarness(
      configOf([
        { id: 'off', providerId: 'known-provider', label: 'Off', enabled: false, apiKey: 'k2' },
        { id: 'keyless', providerId: 'known-provider', label: 'Keyless' },
        { id: 'foreign', providerId: 'no-such-adapter', label: 'Foreign', apiKey: 'k3' },
      ]),
    );
    await harness.engine.component.start();

    const text = harness.sink.lines().join('\n');
    expect(text).toContain("polling: account 'off' is not polled (disabled)");
    expect(text).toContain("polling: account 'keyless' is not polled (no resolved secret)");
    // The unknown-provider skip is the operator-facing warn…
    expect(text).toContain(
      "polling: account 'foreign' is not polled (unknown provider 'no-such-adapter')",
    );
    // …and no skip line carries key material.
    expect(text).not.toContain('k2');
    expect(text).not.toContain('k3');
  });

  it('warns for an unknown provider and starts anyway (§7.2 isolation)', async () => {
    const harness = engineHarness(
      configOf([{ id: 'foreign', providerId: 'no-such-adapter', label: 'F', apiKey: 'k' }]),
    );
    await expect(harness.engine.component.start()).resolves.toBeUndefined();
    expect(harness.scheduler.accountsCalls[0]).toEqual([]);
    expect(harness.scheduler.started).toBe(true);
  });
});

/* ── The lifecycle and the feeds ─────────────────────────────────────────── */

describe('createPollingEngine lifecycle and feeds', () => {
  it('installs the wiring before starting the loop (§7.1 immediate dues)', async () => {
    const harness = engineHarness(
      configOf([{ id: 'healthy', providerId: 'known-provider', label: 'H', apiKey: MARKER_KEY }]),
    );
    await harness.engine.component.start();
    expect(harness.scheduler.accountsCalls).toHaveLength(1); // wiring first…
    expect(harness.scheduler.started).toBe(true); // …then the loop
    await harness.engine.component.stop();
    expect(harness.scheduler.stopped).toBe(true);
  });

  it('exposes the loop state live through running (FSM-4, D-192)', async () => {
    // A getter, never a snapshot: the health route reads it per request,
    // so the value must track the scheduler at every reading — false
    // before start, true while the loop lives, false again after stop
    // (and false after a wiring death, which the spy's `running` models
    // the same way the real engine does).
    const harness = engineHarness(configOf([]));
    expect(harness.engine.running).toBe(false);
    await harness.engine.component.start();
    expect(harness.engine.running).toBe(true);
    await harness.engine.component.stop();
    expect(harness.engine.running).toBe(false);
  });

  it('applyReloadChanges is a no-op before start and an accounts feed after', async () => {
    const harness = engineHarness(configOf([]));
    const added = reloadOf(
      configOf([{ id: 'added', providerId: 'known-provider', label: 'Added', apiKey: MARKER_KEY }]),
      ['accounts'],
    );
    harness.engine.applyReloadChanges(added);
    expect(harness.scheduler.accountsCalls).toHaveLength(0); // not started

    await harness.engine.component.start();
    harness.engine.applyReloadChanges(added);
    expect(harness.scheduler.accountsCalls).toHaveLength(2); // start + reload
    expect(
      (harness.scheduler.accountsCalls[1] as PollingAccount[]).map((account) => account.accountId),
    ).toEqual(['added']);
  });

  it('feeds an interval change through setIntervalMs and nothing else', async () => {
    // A configuration without an `accounts` key at all (the §6.2 optional
    // array) builds empty wiring — the loop simply waits.
    const harness = engineHarness({ app: { timezone: 'UTC' } } as Config);
    await harness.engine.component.start();
    expect(harness.scheduler.accountsCalls).toEqual([[]]);
    harness.engine.applyReloadChanges(
      reloadOf({ app: { timezone: 'UTC', pollingIntervalSeconds: 90 } } as Config, [
        'app.pollingIntervalSeconds',
      ]),
    );
    expect(harness.scheduler.intervalCalls).toEqual([90_000]);
    expect(harness.scheduler.accountsCalls).toHaveLength(1); // the start wiring only
  });

  it('bridges manual-test requests and rejections into the engine', () => {
    const harness = engineHarness(configOf([]));
    harness.engine.requestManualTest('work');
    harness.engine.manualTestRejected('work');
    expect(harness.scheduler.manualTestCalls).toEqual(['work']);
    expect(harness.scheduler.manualRejectionCalls).toEqual(['work']);
  });
});

/* ── The settle wrapper (diagnostics) and the single-holder pin ─────────── */

describe('createPollingEngine settle wrapper and holder wiring', () => {
  it('forwards THE suspension store to the scheduler — single by construction', async () => {
    // FSM-3/D-189's structural pin: the engine holds no D-064 state of its
    // own; the one `AccountSuspensions` instance the composition creates is
    // the same object the scheduler receives (the dispatch gates), the
    // status routes read (`suspensionOf`), and the manual-test observation
    // feeds. There is no second machine to keep in step.
    const harness = engineHarness(configOf([]));
    await harness.engine.component.start();
    expect(harness.schedulerOptions()?.suspensions).toBe(harness.suspensions);
    await harness.engine.component.stop();
  });

  it('logs and rethrows a failing settlement (contained by the engine)', async () => {
    const harness = engineHarness(
      configOf([{ id: 'broken', providerId: 'known-provider', label: 'B', apiKey: MARKER_KEY }]),
    );
    await harness.engine.component.start();
    const wiring = harness.scheduler.accountsCalls[0] as [PollingAccount];
    // The recorder's settle seam is synchronous (D-069's shape); a broken
    // seam throws through the wrapper, which logs first and rethrows.
    expect(() =>
      wiring[0]!.settleCycle({ ok: false, error: new Error('broken seam'), attempts: 1 }),
    ).toThrow('recorder double failed to settle');
    // A non-Error rejection logs its string form — no `toString` crash path.
    expect(() =>
      wiring[0]!.settleCycle({ ok: false, error: 'plain-string-failure', attempts: 1 }),
    ).toThrow('plain-string-failure');
    const text = harness.sink.lines().join('\n');
    expect(text).toContain('polling: cycle settlement failed; the failure is contained');
    expect(text).toContain('plain-string-failure');
  });
});
