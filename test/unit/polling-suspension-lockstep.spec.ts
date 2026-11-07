import { describe, expect, it } from 'vitest';
import {
  ProviderRegistry,
  createAccountContext,
  type QuotaProvider,
} from '../../src/providers/registry';
import type { ProviderSnapshot } from '../../src/schemas/metrics';
import {
  createAccountSuspensions,
  keyIdentityOfSecret,
  type AccountSuspensions,
} from '../../src/services/account-suspensions';
import {
  INITIAL_SUSPENSION_STATE,
  admitVerification,
  applyCycleOutcome,
  applyKeyIdentity,
  applyManualTestRequest,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';
import {
  classifyAuthRejection,
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import { createPollingScheduler } from '../../src/services/polling-scheduler';
import type { CycleRecorder, CycleRecorderOptions } from '../../src/services/polling-persist';
import { createPollingEngine } from '../../src/server/polling';
import { observingManualTests } from '../../src/server/providers';
import type { ReloadSuccess } from '../../src/config/reload';
import type { Validated } from '../../src/schemas/boundary';
import type { Config } from '../../src/schemas/config';
import type { QuotaRepository } from '../../src/storage/repository';
import { TransportStatusError } from '../../src/providers/transport';
import type { Clock } from '../../src/util/clock';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';
import { withFakeTimers } from '../helpers/isolation';

/**
 * The R5 lockstep suite (FSM-3, D-189): scripted event sequences run through
 * the REAL polling composition — `createPollingEngine` with the production
 * scheduler (a zero-jitter wrapper), double recorders, and the production
 * manual-test observation (`observingManualTests`) bridging into the engine
 * — while a reference machine (the D-064 module itself, driven by the same
 * script) computes what the one suspension store must hold. After every
 * event and at every decisive clock reading (each armed instant's −1/+1
 * boundary) two things must agree:
 *
 * - `suspensions.suspensionOf(id)` equals the reference state (a missing,
 *   extra, or wrongly-stamped feed diverges the store), and
 * - the dispatcher's probe-admission decisions equal the reference's: a
 *   probe attempt starts exactly at the admitted readings — never before
 *   the armed instant — and no normal poll runs while the reference is
 *   suspended.
 *
 * Before FSM-3 these two faces were two machines kept in step by
 * convention; the suite is the standing proof that the unified wiring feeds
 * the ONE store every event with its exact semantics: polled outcomes
 * (epoch/keyIdentity staleness included), manual test requested/rejected,
 * the reload key-identity report, and leaving the polled set.
 */

/** A classification of a polled HTTP verdict. */
const outcomeOf = (status: number): CycleOutcome =>
  classifyTransportError(new TransportStatusError(status, '', undefined));
const AUTH_ERROR = outcomeOf(401);
const NETWORK_ERROR = outcomeOf(503);

/** One configured account literal over a secret value. */
const accountOf = (
  id: string,
  secret: string,
  enabled = true,
): NonNullable<Config['accounts']>[number] => ({
  id,
  providerId: 'known-provider',
  label: `Account ${id}`,
  apiKey: secret,
  ...(enabled ? {} : { enabled: false }),
});

/** A minimal configuration carrying an optional accounts array. */
const configOf = (accounts: Config['accounts']): Config =>
  ({ app: { timezone: 'UTC', pollingIntervalSeconds: 60 }, accounts }) as Config;

/** A successful reload literal over a configuration (§6.4's vocabulary). */
const reloadOf = (config: Config): ReloadSuccess => ({
  ok: true,
  outcome: 'applied',
  effective: {
    config: config as unknown as Validated<Config>,
    sources: { fields: [], accountSecrets: [] },
    fileAbsent: false,
  },
  applied: ['accounts'],
  restartRequired: [],
});

/**
 * The reference machine: the D-064 module driven by the same scripted
 * events, stamped with the same clock readings the wiring feeds with.
 */
class Oracle {
  state: AuthSuspensionState = INITIAL_SUSPENSION_STATE;

  outcome(outcome: CycleOutcome, identity: string, at: number): void {
    this.state = applyCycleOutcome(this.state, outcome, identity, at).state;
  }

  manualRequest(at: number): void {
    this.state = applyManualTestRequest(this.state, at).state;
  }

  manualRejected(identity: string, at: number): void {
    this.state = applyCycleOutcome(this.state, classifyAuthRejection(), identity, at).state;
  }

  keyIdentity(identity: string, at: number): void {
    this.state = applyKeyIdentity(this.state, identity, at).state;
  }

  admit(at: number): void {
    const admission = admitVerification(this.state, at);
    if (admission.admitted) this.state = admission.state;
  }

  drop(): void {
    this.state = INITIAL_SUSPENSION_STATE;
  }
}

/** One parked attempt — `holdNext` parks the next start on it. */
interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
}

function makeGate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** How the scenario wants the next `validateCredentials` to answer. */
type ManualTestScript = () => void | Promise<void>;

/**
 * The lockstep harness: the engine composition with the production
 * scheduler and manual-test observation over recorder doubles.
 */
function lockstepHarness(initial: Config) {
  const clock: Clock = { now: () => Date.now(), monotonicMs: () => Date.now() };
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'debug', destination: sink });
  const suspensions: AccountSuspensions = createAccountSuspensions({ clock });
  const registry = new ProviderRegistry();

  const starts = new Map<string, number[]>();
  const settleScripts = new Map<string, (call: number) => CycleOutcome>();
  const settleCalls = new Map<string, number>();
  const pendingGates = new Map<string, Gate[]>();
  const activeGate = new Map<string, Gate>();
  let manualTestScript: ManualTestScript = () => {};

  const baseProvider: QuotaProvider = {
    id: 'known-provider',
    name: 'Known provider (lockstep double)',
    async validateCredentials(): Promise<void> {
      await manualTestScript();
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test');
    },
  };

  let current: Config = initial;
  const engine = createPollingEngine({
    clock,
    logger,
    env: {},
    registry,
    suspensions,
    repository: { withTransaction: () => {} } as unknown as QuotaRepository,
    config: () => current,
    inFlight: { begin: () => ({ done: () => {} }), whenIdle: () => Promise.resolve(), count: 0 },
    schedulerFactory: (options) => createPollingScheduler({ ...options, random: () => 0 }),
    recorderFactory: (options: CycleRecorderOptions): CycleRecorder => {
      const id = options.account.accountId;
      return {
        attempt: async () => {
          const timings = starts.get(id) ?? starts.set(id, []).get(id)!;
          timings.push(Date.now());
          const gate = pendingGates.get(id)?.shift();
          if (gate !== undefined) {
            activeGate.set(id, gate);
            await gate.promise;
          }
          // The settle scripts classify without reading the value; the
          // snapshot shape never matters here.
          return { providerId: id } as unknown as ProviderSnapshot;
        },
        settleCycle: () => {
          const call = (settleCalls.get(id) ?? 0) + 1;
          settleCalls.set(id, call);
          return settleScripts.get(id)?.(call) ?? classifySuccess(200);
        },
        abandonCycle: () => {},
      };
    },
  });

  // The composition's registration shape: the adapter wrapped for
  // manual-test observation, bridging into the engine (D-176/D-189).
  registry.register(
    observingManualTests(baseProvider, {
      suspensions,
      onManualTestRequested: (accountId) => engine.requestManualTest(accountId),
      onManualTestRejected: (accountId) => engine.manualTestRejected(accountId),
    }),
  );

  return {
    engine,
    suspensions,
    starts: (id: string): number[] => starts.get(id) ?? [],
    attempts: (id: string): number => (starts.get(id) ?? []).length,
    /** Scripts the account's settle outcomes per call (default: success). */
    script(id: string, settle: (call: number) => CycleOutcome): void {
      settleScripts.set(id, settle);
    },
    /** Parks the account's next started attempt until `releaseFlight`. */
    holdNext(id: string): void {
      pendingGates.set(id, [...(pendingGates.get(id) ?? []), makeGate()]);
    },
    releaseFlight(id: string): void {
      const gate = activeGate.get(id);
      if (gate === undefined) return;
      activeGate.delete(id);
      gate.resolve();
    },
    /** Scripts the wrapped provider's next `validateCredentials` answer. */
    manualTestAnswersWith(script: ManualTestScript): void {
      manualTestScript = script;
    },
    /** Runs a manual connection test through the wrapped provider. */
    async manualTest(id: string, secret: string): Promise<unknown> {
      const provider = registry.get('known-provider');
      return provider.validateCredentials(createAccountContext(id, `Account ${id}`, secret));
    },
    /**
     * The composition's reload follow-ups in their wired order: the engine
     * feed first (its `setAccounts` applies key identities through the
     * store), then the key-identity report loop.
     */
    applyReload(next: Config): void {
      current = next;
      engine.applyReloadChanges(reloadOf(next));
      for (const account of next.accounts ?? []) {
        suspensions.reportKeyIdentity(account.id, resolvedIdentityOf(account));
      }
    },
    async start(): Promise<void> {
      await engine.component.start();
    },
    async stop(): Promise<void> {
      await engine.component.stop();
    },
  };
}

/** The resolved-key identity the composition's report loop derives. */
function resolvedIdentityOf(account: NonNullable<Config['accounts']>[number]): string {
  return account.apiKey !== undefined
    ? keyIdentityOfSecret(account.apiKey)
    : keyIdentityOfSecret('unresolved:none');
}

describe('polling suspension lockstep (FSM-3, D-189, spec §7.2)', () => {
  it('polled 401 → inconclusive probe → manual test → success (the R5 script)', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-one';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        // The settled outcomes: the entering 401, then an inconclusive
        // probe (503), then the manual attempt's success.
        harness.script('work', (call) =>
          call === 1 ? AUTH_ERROR : call === 2 ? NETWORK_ERROR : classifySuccess(200),
        );

        await harness.start();
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(1); // the immediate first poll
        oracle.outcome(AUTH_ERROR, identity, Date.now()); // t = 0
        lockstep(); // suspended, armed at t = 3 600 000

        // Not one attempt before the armed instant — at every reading.
        await fake.advanceMsAsync(3_599_999);
        expect(harness.attempts('work')).toBe(1);
        lockstep();
        await fake.advanceMsAsync(1); // t = 3 600 000: the probe admits
        expect(harness.attempts('work')).toBe(2);
        expect(harness.starts('work')[1]).toBe(3_600_000);
        oracle.admit(3_600_000); // admission re-arms to t = 7 200 000
        oracle.outcome(NETWORK_ERROR, identity, Date.now()); // inconclusive: no-op
        lockstep();

        // The manual test (t = 3 720 000): the request releases, the owed
        // attempt runs now (bypassing the gate), and its success ends
        // released — the §7.2 lift.
        harness.manualTestAnswersWith(() => {});
        await fake.advanceMsAsync(120_000);
        await harness.manualTest('work', KEY);
        await fake.advanceMsAsync(0);
        oracle.manualRequest(Date.now());
        oracle.outcome(classifySuccess(200), identity, Date.now());
        lockstep(); // released; the admission floor is 7 200 000
        expect(harness.attempts('work')).toBe(3); // the manual attempt ran now
        expect(harness.starts('work')[2]).toBe(3_720_000);

        // Normal cadence resumed: the next poll one interval out.
        await fake.advanceMsAsync(59_999);
        expect(harness.attempts('work')).toBe(3);
        await fake.advanceMsAsync(1); // t = 3 780 000
        expect(harness.attempts('work')).toBe(4);
        oracle.outcome(classifySuccess(200), identity, Date.now());
        lockstep();
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('polled 401 → reload with a key change → immediate release poll', async () => {
    await withFakeTimers(
      async (fake) => {
        const identityOne = keyIdentityOfSecret('sk-lockstep-a');
        const identityTwo = keyIdentityOfSecret('sk-lockstep-b');
        const harness = lockstepHarness(configOf([accountOf('work', 'sk-lockstep-a')]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', (call) => (call === 1 ? AUTH_ERROR : classifySuccess(200)));

        await harness.start();
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identityOne, Date.now());
        lockstep(); // suspended under the old key

        await fake.advanceMsAsync(120_000); // t = 120 000
        harness.applyReload(configOf([accountOf('work', 'sk-lockstep-b')]));
        await fake.advanceMsAsync(0);
        // The engine's setAccounts observation released through the store;
        // the report loop's application after it is the idempotent no-op.
        oracle.keyIdentity(identityTwo, Date.now());
        lockstep(); // released
        expect(harness.attempts('work')).toBe(2); // the release poll, now
        expect(harness.starts('work')[1]).toBe(120_000);
        oracle.outcome(classifySuccess(200), identityTwo, Date.now());
        lockstep();
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('a manual-test rejection during an in-flight probe stays legal and coherent (the risk note)', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-three';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', (call) => (call === 1 ? AUTH_ERROR : classifySuccess(200)));

        await harness.start();
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identity, Date.now()); // suspended, armed 3 600 000
        lockstep();

        // The due probe is held in flight (t = 3 600 000) while the
        // operator's manual test is refused.
        harness.holdNext('work');
        await fake.advanceMsAsync(3_600_000);
        expect(harness.attempts('work')).toBe(2); // the probe, admitted
        oracle.admit(3_600_000); // the store re-arms at admission
        lockstep();
        harness.manualTestAnswersWith(() => {
          throw Object.assign(new Error('the provider refused the key'), {
            kind: 'credentials-rejected',
          });
        });
        await expect(harness.manualTest('work', KEY)).rejects.toThrow(
          'the provider refused the key',
        );
        // The wrapper's single application under the tested key's identity:
        // request → release, refusal → re-enter with the admission floor.
        oracle.manualRequest(Date.now());
        oracle.manualRejected(identity, Date.now());
        lockstep(); // suspended again, armed at 7 200 000
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(true);

        // The in-flight probe settles AFTER the rejection (the transition
        // order the risk note demands stays legal): its success releases.
        harness.releaseFlight('work');
        await fake.advanceMsAsync(0);
        oracle.outcome(classifySuccess(200), identity, Date.now());
        lockstep(); // released
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(false);

        // Normal polling resumed one interval after the release settle.
        await fake.advanceMsAsync(60_000);
        expect(harness.attempts('work')).toBe(3);
        oracle.outcome(classifySuccess(200), identity, Date.now());
        lockstep();
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('discards a re-keyed flight outcome: an old key 401 suspends neither', async () => {
    await withFakeTimers(
      async (fake) => {
        const identityTwo = keyIdentityOfSecret('sk-lockstep-new');
        const harness = lockstepHarness(configOf([accountOf('work', 'sk-lockstep-old')]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        // Every settle classifies the OLD key's 401; only the current
        // wiring's outcome may apply.
        harness.script('work', () => AUTH_ERROR);

        // The first flight is parked from the start: the loop's first pass
        // dispatches synchronously inside start(), so the gate must be
        // queued before it.
        harness.holdNext('work');
        await harness.start();
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(1); // the old key's flight, held

        // The reload re-keys the account while the old flight is parked.
        // The store is still initial: the identity report is a no-op on it.
        await fake.advanceMsAsync(30_000); // t = 30 000
        harness.applyReload(configOf([accountOf('work', 'sk-lockstep-new')]));
        oracle.keyIdentity(identityTwo, Date.now()); // not suspended: a no-op
        lockstep();
        // The old flight settles with its 401 — stale (the entry was
        // re-keyed): discarded. The entry's due is past, so the new key's
        // poll runs now and ITS 401 opens the episode under the new key.
        harness.releaseFlight('work');
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(2);
        expect(harness.starts('work')[1]).toBe(30_000);
        oracle.outcome(AUTH_ERROR, identityTwo, Date.now());
        lockstep(); // suspended under the NEW key only
        const state = harness.suspensions.suspensionOf('work');
        expect(state.suspended).toBe(true);
        if (state.suspended) expect(state.keyIdentity).toBe(identityTwo);
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('discards a removed-and-re-added account stale outcome under the SAME key', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-same';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', () => AUTH_ERROR);

        await harness.start();
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identity, Date.now()); // suspended
        lockstep();

        // The due probe (t = 3 600 000) is held in flight across a
        // remove-and-re-add pair under the SAME key: the engine's diff
        // drops the episode with the leaving entry and starts a fresh
        // entry on the return (which cannot dispatch while the probe is
        // live — the overlap prohibition).
        harness.holdNext('work');
        await fake.advanceMsAsync(3_600_000);
        expect(harness.attempts('work')).toBe(2); // the probe, admitted
        oracle.admit(3_600_000);
        lockstep();
        harness.applyReload(configOf([])); // removed
        oracle.drop();
        lockstep(); // the episode dropped with the entry
        harness.applyReload(configOf([accountOf('work', KEY)])); // re-added
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(2); // still live: no dispatch

        // The held probe settles with a 401 — stale for the fresh entry
        // (entry identity, not key identity): discarded, and the fresh
        // entry's own immediate poll opens a FRESH episode.
        harness.releaseFlight('work');
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(3);
        expect(harness.starts('work')[2]).toBe(3_600_000);
        oracle.outcome(AUTH_ERROR, identity, Date.now());
        lockstep(); // a fresh episode, untouched by the stale outcome
        const state = harness.suspensions.suspensionOf('work');
        expect(state.suspended).toBe(true);
        if (state.suspended) expect(state.suspendedAtEpochMs).toBe(3_600_000);
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('keeps feeding across a mere rebuild: a kept account, same key, new label', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-kept';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', () => AUTH_ERROR);

        // A label change rebuilds the wiring but KEEPS the account and its
        // key: the entry survives the diff and the identity matches, so a
        // settle that raced the rebuild still applies (the kept-rebuild arm
        // of the staleness matrix).
        harness.holdNext('work');
        await harness.start();
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(1); // the flight, held
        await fake.advanceMsAsync(30_000);
        harness.applyReload(configOf([{ ...accountOf('work', KEY), label: 'Renamed' }]));
        lockstep(); // the identity report is a no-op on the initial state
        harness.releaseFlight('work');
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identity, Date.now()); // applied, not stale
        lockstep(); // suspended: the kept rebuild kept feeding
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(true);
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('applies a re-key-away-and-back flight outcome (the entry-identity rule, D-189)', async () => {
    await withFakeTimers(
      async (fake) => {
        const identityA = keyIdentityOfSecret('sk-lockstep-key-a');
        const identityB = keyIdentityOfSecret('sk-lockstep-key-b');
        const harness = lockstepHarness(configOf([accountOf('work', 'sk-lockstep-key-a')]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', () => AUTH_ERROR);

        // A flight under key A whose account is re-keyed A→B→A mid-flight:
        // the CURRENT wiring's identity equals the flight's snapshot, so
        // the entry-identity rule APPLIES the outcome (the deleted epoch
        // rule bumped on every consecutive identity change and would have
        // treated it as stale for the old holder — but the old ENGINE
        // applied it too, so this preserves the dispatch semantics; the
        // corner is recorded in D-189).
        harness.holdNext('work');
        await harness.start();
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(1); // the key-A flight, held
        await fake.advanceMsAsync(10_000);
        harness.applyReload(configOf([accountOf('work', 'sk-lockstep-key-b')]));
        oracle.keyIdentity(identityB, Date.now()); // initial state: a no-op
        await fake.advanceMsAsync(10_000);
        harness.applyReload(configOf([accountOf('work', 'sk-lockstep-key-a')]));
        oracle.keyIdentity(identityA, Date.now());
        lockstep();
        harness.releaseFlight('work');
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identityA, Date.now()); // applied: A === A
        lockstep(); // suspended under key A — the outcome was NOT stale
        const state = harness.suspensions.suspensionOf('work');
        expect(state.suspended).toBe(true);
        if (state.suspended) expect(state.keyIdentity).toBe(identityA);
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('drops the episode when the account leaves the polled set, and re-enters fresh on return', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-drop';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        harness.script('work', () => AUTH_ERROR);

        await harness.start();
        await fake.advanceMsAsync(0);
        oracle.outcome(AUTH_ERROR, identity, Date.now());
        lockstep(); // suspended

        harness.applyReload(configOf([accountOf('work', KEY, false)])); // disabled
        oracle.drop();
        lockstep(); // dropped with the engine entry (the store's initial)
        expect(harness.suspensions.suspensionOf('work')).toEqual(INITIAL_SUSPENSION_STATE);

        harness.applyReload(configOf([accountOf('work', KEY)])); // re-enabled
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(2); // fresh start: immediate poll
        oracle.outcome(AUTH_ERROR, identity, Date.now()); // a fresh episode
        lockstep();
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(true);
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('honors a manual-test episode planted while the account was unpolled (the D-189 corner)', async () => {
    await withFakeTimers(
      async (fake) => {
        const KEY = 'sk-lockstep-disabled';
        const identity = keyIdentityOfSecret(KEY);
        const harness = lockstepHarness(configOf([accountOf('work', KEY, false)]));
        const oracle = new Oracle();
        const lockstep = (): void => {
          expect(harness.suspensions.suspensionOf('work')).toEqual(oracle.state);
        };
        // The probe (the account's FIRST cycle) verifies the key: success.
        harness.script('work', () => classifySuccess(200));

        await harness.start();
        await fake.advanceMsAsync(0);
        expect(harness.attempts('work')).toBe(0); // disabled: never polled

        // The operator tests the disabled account's key; the provider
        // refuses it. The wrapper feeds the store (the engine bridge
        // returns false — no entry), so the episode exists while unpolled.
        harness.manualTestAnswersWith(() => {
          throw Object.assign(new Error('the provider refused the key'), {
            kind: 'credentials-rejected',
          });
        });
        await expect(harness.manualTest('work', KEY)).rejects.toThrow(
          'the provider refused the key',
        );
        oracle.manualRequest(Date.now());
        oracle.manualRejected(identity, Date.now());
        lockstep(); // suspended, armed at t = 3 600 000
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(true);

        // Enabling joins the polled set WITH the surviving episode: the
        // pause holds (§7.2's pause is about the key, not polled-ness) and
        // the probe cadence — not a normal poll — verifies the key.
        harness.applyReload(configOf([accountOf('work', KEY)]));
        await fake.advanceMsAsync(3_599_999);
        expect(harness.attempts('work')).toBe(0); // gated, not even the first poll
        lockstep();
        await fake.advanceMsAsync(1); // t = 3 600 000: the probe admits
        expect(harness.attempts('work')).toBe(1);
        expect(harness.starts('work')[0]).toBe(3_600_000);
        oracle.admit(3_600_000);
        oracle.outcome(classifySuccess(200), identity, Date.now()); // release
        lockstep();
        expect(harness.suspensions.suspensionOf('work').suspended).toBe(false);

        // Released: the normal cadence follows.
        await fake.advanceMsAsync(60_000);
        expect(harness.attempts('work')).toBe(2);
        oracle.outcome(classifySuccess(200), identity, Date.now());
        lockstep();
        await harness.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});
