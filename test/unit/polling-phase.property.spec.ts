import { describe, expect, it } from 'vitest';
import { TransportStatusError } from '../../src/providers/transport';
import type { Clock } from '../../src/util/clock';
import { fc } from '../helpers/property';
import {
  createAccountSuspensions,
  type AccountSuspensions,
} from '../../src/services/account-suspensions';
import {
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import {
  nextPlan,
  pollPhaseOf,
  type PhaseFlight,
  type PhaseView,
  type PollPlan,
} from '../../src/services/polling-phase';
import { type AuthSuspensionState } from '../../src/services/polling-suspension';
import {
  createPollingScheduler,
  type PollingAccount,
  type PollingScheduler,
} from '../../src/services/polling-scheduler';
import { withFakeTimers } from '../helpers/isolation';

/**
 * The FSM-1 invariant properties (TZ-fsm §3.5, decision D-190): the four
 * pinning requirements, over the pure phase model and over the real engine.
 *
 * - (a) overlap is impossible under any event sequence — the engine property
 *   drives the production scheduler through generated command scripts
 *   (advances, manual tests and rejections, interval changes, account-set
 *   rebuilds, random classified outcomes) while every attempt parks until
 *   the next command, so real overlap windows exist; per-account in-flight
 *   must never exceed one (§7.1/§17.1).
 * - (b) the owed manual attempt survives settles, containment, interval
 *   changes, and key releases — only `dispatched`/`manual-test-rejected`
 *   consume it.
 * - (c) the D-062 `Retry-After` gate binds all three attempt kinds — a shut
 *   gate never yields a dispatchable phase for any plan/suspension combo.
 * - (d) a flying or hung account is never dispatchable — for any inputs.
 */

const OPEN = Number.NEGATIVE_INFINITY;

/* ── Shared generators ─────────────────────────────────────────────────── */

const gateArb: fc.Arbitrary<number> = fc.oneof(fc.constant(OPEN), fc.nat(10_000_000));

const planArb: fc.Arbitrary<PollPlan> = fc
  .record({
    kind: fc.constantFrom('scheduled', 'manual-owed'),
    nextPollMonotonicMs: fc.nat(10_000_000),
    notBeforeEpochMs: gateArb,
  })
  .map((plan) =>
    plan.kind === 'scheduled'
      ? ({ ...plan, kind: 'scheduled' } as PollPlan)
      : ({ ...plan, kind: 'manual-owed' } as PollPlan),
  );

const suspensionArb: fc.Arbitrary<AuthSuspensionState> = fc.oneof(
  fc.record({
    suspended: fc.constant(false),
    admissionFloorEpochMs: fc.oneof(fc.constant(OPEN), fc.nat(10_000_000)),
  }),
  fc.record({
    suspended: fc.constant(true),
    keyIdentity: fc.constant('key:a'),
    suspendedAtEpochMs: fc.nat(10_000_000),
    nextVerificationAtEpochMs: fc.nat(20_000_000),
  }),
);

/** Events that must never consume an owed attempt. */
const survivalEventArb = fc.oneof(
  fc.record({
    kind: fc.constant('key-released' as const),
    nowMonotonicMs: fc.nat(10_000_000),
  }),
  fc.record({
    kind: fc.constant('cycle-settled' as const),
    suspended: fc.boolean(),
    notBeforeEpochMs: gateArb,
    nowMonotonicMs: fc.nat(10_000_000),
    nextDelayMs: fc.nat(3_600_000),
  }),
  fc.record({
    kind: fc.constant('contained-failure' as const),
    suspended: fc.boolean(),
    nowMonotonicMs: fc.nat(10_000_000),
    intervalMs: fc.constantFrom(60_000, 300_000, 3_600_000),
  }),
  fc.record({
    kind: fc.constant('interval-changed' as const),
    suspended: fc.boolean(),
    nowMonotonicMs: fc.nat(10_000_000),
    nextDelayMs: fc.nat(3_600_000),
  }),
);

/* ── (b) The owed attempt survives everything but the two consume events ── */

describe('property: the owed manual attempt survives (TZ-fsm §3.3-7)', () => {
  it('stays manual-owed across any sequence of surviving events', () => {
    const property = fc.property(
      planArb,
      fc.array(survivalEventArb, { minLength: 0, maxLength: 24 }),
      (plan, events) => {
        let current = nextPlan(plan, { kind: 'manual-test-requested' });
        expect(current.kind).toBe('manual-owed');
        for (const event of events) current = nextPlan(current, event);
        expect(current.kind).toBe('manual-owed');
      },
    );
    fc.assert(property);
  });

  it('is consumed exactly by dispatch (and stays consumed through survivors)', () => {
    const property = fc.property(
      planArb,
      fc.array(survivalEventArb, { minLength: 0, maxLength: 24 }),
      (plan, events) => {
        let current = nextPlan(nextPlan(plan, { kind: 'manual-test-requested' }), {
          kind: 'dispatched',
        });
        expect(current.kind).toBe('scheduled');
        for (const event of events) current = nextPlan(current, event);
        expect(current.kind).toBe('scheduled');
      },
    );
    fc.assert(property);
  });
});

/* ── (c) The D-062 gate binds all three attempt kinds (U-028) ──────────── */

describe('property: the Retry-After gate is unconditional (TZ-fsm §3.3-4)', () => {
  it('never derives a dispatchable phase while the gate is shut', () => {
    const property = fc.property(
      planArb,
      suspensionArb,
      fc.nat(10_000_000), // the wall reading
      fc.integer({ min: 1, max: 3_600_000 }), // how long the gate stays shut
      fc.nat(10_000_000), // the monotonic reading
      (plan, suspension, wallEpochMs, shutMs, monotonicMs) => {
        const phase = pollPhaseOf({
          plan: { ...plan, notBeforeEpochMs: wallEpochMs + shutMs },
          flight: 'none',
          suspension,
          wallEpochMs,
          monotonicMs,
        });
        // None of the three dispatchable shapes — manual attempt, probe,
        // normal poll — may appear; only gated/waiting projections remain.
        expect(['manual-gated', 'probe-gated', 'waiting', 'probe-waiting']).toContain(phase.kind);
      },
    );
    fc.assert(property);
  });

  it('never derives a gated phase at or past the gate instant (equality admits)', () => {
    const property = fc.property(
      planArb,
      suspensionArb,
      fc.nat(10_000_000),
      fc.nat(10_000_000),
      (plan, suspension, wallEpochMs, monotonicMs) => {
        const phase = pollPhaseOf({
          plan: { ...plan, notBeforeEpochMs: wallEpochMs },
          flight: 'none',
          suspension,
          wallEpochMs,
          monotonicMs,
        });
        expect(phase.kind).not.toBe('manual-gated');
        expect(phase.kind).not.toBe('probe-gated');
      },
    );
    fc.assert(property);
  });
});

/* ── (d) A flying or hung account is never dispatchable (TZ-fsm §3.3-2/6) ─ */

describe('property: a live flight blocks its own account, always', () => {
  it('projects in-flight/hung for any plan, suspension, and readings', () => {
    const property = fc.property(
      planArb,
      suspensionArb,
      fc.constantFrom('flying', 'hung'),
      fc.nat(10_000_000),
      fc.nat(10_000_000),
      (plan, suspension, flight, wallEpochMs, monotonicMs) => {
        const phase = pollPhaseOf({
          plan,
          flight,
          suspension,
          wallEpochMs,
          monotonicMs,
        });
        expect(['in-flight', 'hung']).toContain(phase.kind);
      },
    );
    fc.assert(property);
  });
});

/* ── (a) Overlap is impossible under any event sequence (the engine) ───── */

/** One classified outcome a scripted settle may return. */
type ScriptedOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'rate'; readonly seconds: number }
  | { readonly kind: 'auth' };

/** A generated engine command. */
type Command =
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'manual'; readonly id: string }
  | { readonly kind: 'reject'; readonly id: string }
  | { readonly kind: 'interval'; readonly ms: number }
  | { readonly kind: 'rekey'; readonly id: string };

const IDS = ['a', 'b', 'c'] as const;

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('advance' as const), ms: fc.nat(4_000_000) }),
  fc.record({ kind: fc.constant('manual' as const), id: fc.constantFrom(...IDS) }),
  fc.record({ kind: fc.constant('reject' as const), id: fc.constantFrom(...IDS) }),
  fc.record({
    kind: fc.constant('interval' as const),
    ms: fc.constantFrom(60_000, 120_000, 300_000),
  }),
  fc.record({ kind: fc.constant('rekey' as const), id: fc.constantFrom(...IDS) }),
);

const outcomeArb: fc.Arbitrary<ScriptedOutcome> = fc.oneof(
  fc.record({ kind: fc.constant('success' as const) }),
  fc.record({ kind: fc.constant('rate' as const), seconds: fc.nat(3_600) }),
  fc.record({ kind: fc.constant('auth' as const) }),
);

const outcomeOf = (scripted: ScriptedOutcome): CycleOutcome => {
  switch (scripted.kind) {
    case 'success':
      return classifySuccess();
    case 'rate':
      return classifyTransportError(
        new TransportStatusError(429, 'Too Many Requests', String(scripted.seconds)),
      );
    case 'auth':
      return classifyTransportError(new TransportStatusError(401, 'Unauthorized', undefined));
  }
};

/**
 * The engine property: three accounts, every attempt parked until the next
 * command (real overlap windows the dispatcher must refuse), scripted
 * classifications cycling a generated sequence, and a small hang threshold
 * so hung flights exercise the skip-around path too. Per-account in-flight
 * must never exceed one — whatever the script does.
 */
describe('property: no per-account overlap under generated command scripts (TZ-fsm §3.3-2)', () => {
  it(
    'keeps per-account in-flight at most one across every generated script',
    { timeout: 20_000 },
    async () => {
      const property = fc.asyncProperty(
        fc.array(outcomeArb, { minLength: 1, maxLength: 64 }),
        fc.array(commandArb, { minLength: 1, maxLength: 24 }),
        fc.constantFrom(5_000, 255_500),
        async (outcomes, commands, hangThresholdMs) => {
          await withFakeTimers(
            async (advance) => {
              const clock: Clock = { now: () => Date.now(), monotonicMs: () => Date.now() };
              const suspensions: AccountSuspensions = createAccountSuspensions({ clock });
              let outcomeIndex = 0;
              const parked: Array<() => void> = [];
              const inFlight = new Map<string, number>(IDS.map((id) => [id, 0]));
              const maxInFlight = new Map<string, number>(IDS.map((id) => [id, 0]));

              const account = (id: string, keyIdentity = `key:${id}`): PollingAccount => ({
                accountId: id,
                keyIdentity,
                attempt: async () => {
                  const live = (inFlight.get(id) ?? 0) + 1;
                  inFlight.set(id, live);
                  maxInFlight.set(id, Math.max(maxInFlight.get(id) ?? 0, live));
                  try {
                    // Parked until the runner releases: the flight spans at
                    // least one whole command, the exact window a second
                    // concurrent dispatch would need to sneak into.
                    await new Promise<void>((resolve) => {
                      parked.push(resolve);
                    });
                    return { providerId: id };
                  } finally {
                    inFlight.set(id, (inFlight.get(id) ?? 1) - 1);
                  }
                },
                settleCycle: async () => {
                  const scripted = outcomes[outcomeIndex++ % outcomes.length]!;
                  return outcomeOf(scripted);
                },
              });

              const scheduler: PollingScheduler = createPollingScheduler({
                accounts: IDS.map((id) => account(id)),
                intervalMs: 60_000,
                clock,
                suspensions,
                random: () => 0,
                cycleHangThresholdMs: hangThresholdMs,
              });
              scheduler.start();
              await advance.advanceMsAsync(0);

              const releaseParked = (): void => {
                const release = [...parked];
                parked.length = 0;
                for (const resolve of release) resolve();
              };
              for (const command of commands) {
                releaseParked();
                switch (command.kind) {
                  case 'advance':
                    await advance.advanceMsAsync(command.ms);
                    break;
                  case 'manual':
                    scheduler.requestManualTest(command.id);
                    await advance.advanceMsAsync(0);
                    break;
                  case 'reject':
                    suspensions.manualTestRejected(command.id, `key:${command.id}`);
                    scheduler.manualTestRejected(command.id);
                    await advance.advanceMsAsync(0);
                    break;
                  case 'interval':
                    scheduler.setIntervalMs(command.ms);
                    await advance.advanceMsAsync(0);
                    break;
                  case 'rekey':
                    scheduler.setAccounts(
                      IDS.map((id) =>
                        id === command.id ? account(id, `key:${id}:g2`) : account(id),
                      ),
                    );
                    await advance.advanceMsAsync(0);
                    break;
                }
              }
              releaseParked();
              await advance.advanceMsAsync(0);
              await scheduler.stop();

              for (const id of IDS) {
                expect(maxInFlight.get(id)).toBeLessThanOrEqual(1);
              }
            },
            { shouldAdvanceTime: false, now: 0 },
          );
        },
      );
      await fc.assert(property, { numRuns: 60 });
    },
  );
});

/* ── (a′) A hung flight never starves the others (TZ-fsm §3.3-6) ───────── */

/**
 * The no-starvation half of the hang invariant: one account's flight hangs
 * permanently past the threshold; the healthy accounts must keep cycling at
 * their configured cadence regardless of how time advances. With zero
 * jitter and instant settles, account `b`'s k-th attempt starts by
 * `hangThreshold + (k − 1) · interval` (its first poll may be held behind
 * the strict-sequential phase up to the threshold, never longer), so the
 * observed attempt count at total time T must be at least
 * `floor((T − threshold) / interval)` — a starving dispatcher (one that
 * lets the hung flight hold the queue) fails this bound immediately.
 */
describe('property: a hung flight never starves the other accounts (TZ-fsm §3.3-6)', () => {
  it(
    'keeps the healthy accounts cycling past the hang threshold under any advance script',
    { timeout: 20_000 },
    async () => {
      const INTERVAL_MS = 60_000;
      const property = fc.asyncProperty(
        fc.constantFrom(5_000, 255_500),
        fc.array(fc.nat(4_000_000), { minLength: 1, maxLength: 16 }),
        fc.boolean(), // whether the hung account existed from startup or hung later
        async (hangThresholdMs, advances, hungFromStart) => {
          await withFakeTimers(
            async (advance) => {
              const clock: Clock = { now: () => Date.now(), monotonicMs: () => Date.now() };
              const suspensions = createAccountSuspensions({ clock });
              const hungReleases: Array<() => void> = [];
              const started = new Map<string, number>([
                ['a', 0],
                ['b', 0],
              ]);
              let hanging = hungFromStart;
              const account = (id: string): PollingAccount => ({
                accountId: id,
                keyIdentity: `key:${id}`,
                attempt: async () => {
                  started.set(id, (started.get(id) ?? 0) + 1);
                  if (id === 'a' && hanging) {
                    // Hang until the run's end: a flight that never settles.
                    await new Promise<void>((resolve) => {
                      hungReleases.push(resolve);
                    });
                  }
                  return { providerId: id };
                },
                settleCycle: async () => classifySuccess(),
              });
              const scheduler = createPollingScheduler({
                accounts: ['a', 'b'].map((id) => account(id)),
                intervalMs: INTERVAL_MS,
                clock,
                suspensions,
                random: () => 0,
                cycleHangThresholdMs: hangThresholdMs,
              });
              scheduler.start();
              if (!hungFromStart) {
                // A first healthy round for a, then its next attempt hangs.
                await advance.advanceMsAsync(0);
                hanging = true;
              }
              let totalMs = 0;
              for (const ms of advances) {
                await advance.advanceMsAsync(ms);
                totalMs += ms;
              }
              // Release the hung flight so stop() settles cleanly.
              hanging = false;
              for (const release of hungReleases.splice(0)) release();
              await advance.advanceMsAsync(0);
              await scheduler.stop();
              const minimumAttempts = Math.max(
                0,
                Math.floor((totalMs - hangThresholdMs) / INTERVAL_MS),
              );
              expect(started.get('b') ?? 0).toBeGreaterThanOrEqual(minimumAttempts);
            },
            { shouldAdvanceTime: false, now: 0 },
          );
        },
      );
      await fc.assert(property, { numRuns: 40 });
    },
  );
});

/* ── A PhaseView helper sanity pin (the property inputs stay well-formed) ─ */

describe('property harness sanity', () => {
  it('the suspended generator feeds valid states to the derivation', () => {
    const property = fc.property(suspensionArb, (suspension) => {
      const view: PhaseView = {
        plan: undefined,
        flight: 'none' as PhaseFlight,
        suspension,
        wallEpochMs: 0,
        monotonicMs: 0,
      };
      expect(pollPhaseOf(view).kind).toBe('absent'); // no plan ⇒ absent, any state
    });
    fc.assert(property);
  });
});
