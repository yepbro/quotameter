import { describe, expect, it } from 'vitest';
import { TransportDnsError, TransportStatusError } from '../../src/providers/transport';
import {
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import {
  AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
  INITIAL_SUSPENSION_STATE,
  admitVerification,
  applyCycleOutcome,
  applyKeyIdentity,
  applyManualTestRequest,
  isVerificationDue,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';
import { fc } from '../helpers/property';

/**
 * The standing proof of task 108's done-condition — "no rapid retry loop
 * is possible" (spec §7.2, decision D-064): over generated event
 * sequences (every admission followed adversarially by an auth
 * rejection, releases, key changes, manual tests, lost outcomes, and
 * clock readings that jump backwards), the machine never admits two
 * automatic attempts closer than the 60-minute verification cadence, the
 * armed instant never contradicts the episode invariant, and admission
 * agrees with the armed instant at every probe time. Time is data
 * (D-021); no timers, no network.
 */

const INTERVAL = AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS;

/** Walks start at a fixed reading; deltas move the cursor, sometimes backwards. */
const BASE = Date.UTC(2026, 9, 31, 12, 0, 0);

/** Two key identities, so key-change and fresh-episode paths are reachable. */
const KEYS = ['generation-7', 'generation-8'] as const;

/** One classified 401 (the adversarial provider's only answer). */
const authRejected: CycleOutcome = classifyTransportError(
  new TransportStatusError(401, 'Unauthorized', undefined),
);

/** One classified non-auth failure. */
const networkFailure: CycleOutcome = classifyTransportError(new TransportDnsError());

/** One classified success. */
const success: CycleOutcome = classifySuccess();

/**
 * Deltas biased to the interesting places: full-window and 1 ms
 * regressions, standing still, the ±1 ms around a boundary, and uniform
 * spans up to two windows in either direction.
 */
const deltas = fc.oneof(
  fc.constant(-INTERVAL),
  fc.constant(-1),
  fc.constant(0),
  fc.constant(1),
  fc.constant(INTERVAL - 1),
  fc.constant(INTERVAL),
  fc.constant(INTERVAL + 1),
  fc.integer({ min: -INTERVAL, max: 2 * INTERVAL }),
);

/** Every way the caller can touch the machine. */
type StepKind = 'auth-failure' | 'success' | 'other' | 'key-change' | 'manual' | 'admit';

interface Step {
  readonly kind: StepKind;
  readonly delta: number;
  readonly keyIdx: 0 | 1;
  readonly recordOutcome: boolean;
  readonly outcomeIsSuccess: boolean;
  readonly outcomeDelayMs: number;
}

const steps = fc.array(
  fc.record({
    // 'admit' is weighted: the paced attempt is the event under proof, so
    // the walk must actually produce admissions (the tripwires below
    // assert it).
    kind: fc.constantFrom<StepKind>(
      'admit',
      'admit',
      'admit',
      'auth-failure',
      'auth-failure',
      'success',
      'other',
      'key-change',
      'manual',
    ),
    delta: deltas,
    keyIdx: fc.constantFrom<0 | 1>(0, 1),
    recordOutcome: fc.boolean(),
    outcomeIsSuccess: fc.boolean(),
    outcomeDelayMs: fc.integer({ min: 0, max: 5 * 60_000 }),
  }),
  { minLength: 1, maxLength: 50 },
);

/** The adversarial sequence the done-condition names: auth failures only. */
const adversarialSteps = fc.array(
  fc.record({
    kind: fc.constantFrom<StepKind>(
      'admit',
      'admit',
      'admit',
      'manual',
      'auth-failure',
      'auth-failure',
      'key-change',
    ),
    delta: deltas,
    keyIdx: fc.constantFrom<0 | 1>(0, 1),
    recordOutcome: fc.constant(true),
    outcomeIsSuccess: fc.constant(false),
    outcomeDelayMs: fc.integer({ min: 0, max: 5 * 60_000 }),
  }),
  { minLength: 1, maxLength: 50 },
);

/** The state invariants that must hold after every single transition. */
function checkInvariants(state: AuthSuspensionState): void {
  expect(Object.isFrozen(state)).toBe(true);
  if (state.suspended) {
    expect(state.keyIdentity.trim()).not.toBe('');
    // The gate never opens inside the window that began this episode.
    expect(state.nextVerificationAtEpochMs).toBeGreaterThanOrEqual(
      state.suspendedAtEpochMs + INTERVAL,
    );
  } else {
    expect(typeof state.admissionFloorEpochMs).toBe('number');
  }
}

/**
 * Runs a sequence against a fresh machine. An admitted attempt is
 * immediately spent: its outcome (when recorded) arrives
 * `outcomeDelayMs` later, auth-rejected or successful per the step.
 * Returns the admitted attempt times — the automatic attempts the
 * machine paced — and the final state.
 */
function drive(sequence: readonly Step[]): { admissions: number[]; state: AuthSuspensionState } {
  let state: AuthSuspensionState = INITIAL_SUSPENSION_STATE;
  const admissions: number[] = [];
  let cursor = BASE;
  for (const step of sequence) {
    cursor += step.delta;
    switch (step.kind) {
      case 'auth-failure':
        state = applyCycleOutcome(state, authRejected, KEYS[step.keyIdx], cursor).state;
        break;
      case 'success':
        state = applyCycleOutcome(state, success, KEYS[step.keyIdx], cursor).state;
        break;
      case 'other':
        state = applyCycleOutcome(state, networkFailure, KEYS[step.keyIdx], cursor).state;
        break;
      case 'key-change':
        state = applyKeyIdentity(state, KEYS[step.keyIdx], cursor).state;
        break;
      case 'manual':
        state = applyManualTestRequest(state, cursor).state;
        break;
      case 'admit': {
        const decision = admitVerification(state, cursor);
        if (decision.admitted) {
          admissions.push(cursor);
          state = decision.state;
          if (step.recordOutcome) {
            state = applyCycleOutcome(
              state,
              step.outcomeIsSuccess ? success : authRejected,
              KEYS[step.keyIdx],
              cursor + step.outcomeDelayMs,
            ).state;
          }
        }
        break;
      }
    }
    checkInvariants(state);
  }
  return { admissions, state };
}

describe('the done-condition: no rapid retry loop is possible (property)', () => {
  it('never admits two automatic attempts closer than the 60-minute cadence', () => {
    let totalAdmissions = 0;
    fc.assert(
      fc.property(steps, (sequence) => {
        const { admissions } = drive(sequence);
        totalAdmissions += admissions.length;
        for (let i = 1; i < admissions.length; i++) {
          expect(
            admissions[i]! - admissions[i - 1]!,
            `admissions ${i - 1}→${i}`,
          ).toBeGreaterThanOrEqual(INTERVAL);
        }
      }),
    );
    // Vacuity tripwire (review finding): the walk must actually produce
    // admissions, or the property proves nothing. (Adjacent-pair spacing
    // is proven deterministically by the directed property below; a walk
    // producing two admissions in one sequence is legitimate but too rare
    // to trip on.)
    expect(totalAdmissions).toBeGreaterThan(0);
  });

  it('holds under consecutive auth failures with releases, key changes, and lost outcomes', () => {
    let totalAdmissions = 0;
    fc.assert(
      fc.property(adversarialSteps, (sequence) => {
        const { admissions } = drive(sequence);
        totalAdmissions += admissions.length;
        for (let i = 1; i < admissions.length; i++) {
          expect(
            admissions[i]! - admissions[i - 1]!,
            `admissions ${i - 1}→${i}`,
          ).toBeGreaterThanOrEqual(INTERVAL);
        }
      }),
    );
    expect(totalAdmissions).toBeGreaterThan(0);
  });

  it('a release followed by a regressed rejection cannot speed the next admission', () => {
    // The directed attack on the admission floor (review finding): each
    // round admits exactly at the armed instant (the scheduler's
    // wake-up), releases through one of the two release events, and then
    // records the release attempt's 401 stamped BELOW the admission it
    // follows — the wall clock jumped backwards. Without the floor, the
    // re-entry's own arm (rejection + 60 min) would open the gate before
    // a full window has passed since the last admission; with it, the
    // gate stays shut until then.
    const backOffsets = fc.oneof(
      fc.constant(0),
      fc.constant(1),
      fc.constant(60_000),
      fc.integer({ min: 0, max: 2 * INTERVAL }),
    );
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        fc.array(backOffsets, { minLength: 1, maxLength: 10 }),
        (releaseByManual, backs) => {
          const rounds = Math.min(releaseByManual.length, backs.length);
          let state: AuthSuspensionState = applyCycleOutcome(
            INITIAL_SUSPENSION_STATE,
            authRejected,
            KEYS[0],
            BASE,
          ).state;
          let lastAdmission = Number.NEGATIVE_INFINITY;
          for (let i = 0; i < rounds; i++) {
            if (!state.suspended) throw new Error('expected suspension at round start');
            // The scheduler wakes exactly at the armed instant: the
            // admission must be granted, and no earlier than one full
            // window after the previous one.
            const wakeAt = state.nextVerificationAtEpochMs;
            const decision = admitVerification(state, wakeAt);
            if (!decision.admitted) throw new Error('expected admission at the armed instant');
            expect(wakeAt - lastAdmission, `round ${i}`).toBeGreaterThanOrEqual(INTERVAL);
            lastAdmission = wakeAt;
            state = decision.state;
            // The attack: release, then a rejection of the key now in use
            // stamped below the admission just granted.
            state = (
              releaseByManual[i]
                ? applyManualTestRequest(state, wakeAt)
                : applyKeyIdentity(state, KEYS[1], wakeAt)
            ).state;
            const regressedAt = wakeAt - backs[i]!;
            state = applyCycleOutcome(
              state,
              authRejected,
              releaseByManual[i] ? KEYS[0] : KEYS[1],
              regressedAt,
            ).state;
            checkInvariants(state);
            // Re-suspended by the regressed rejection; the gate must stay
            // shut for the rest of the window the admission bought.
            if (!state.suspended) throw new Error('expected re-suspension after 401');
            expect(admitVerification(state, lastAdmission + INTERVAL - 1).admitted).toBe(false);
            expect(admitVerification(state, lastAdmission + INTERVAL).admitted).toBe(true);
          }
        },
      ),
    );
  });
});

describe('admission agrees with the armed instant at every probe (property)', () => {
  const probeOffsets = fc.oneof(
    fc.constant(-1),
    fc.constant(0),
    fc.constant(1),
    fc.integer({ min: -2 * INTERVAL, max: 2 * INTERVAL }),
  );

  it('admits exactly at/after the armed instant, re-arming one window from the probe', () => {
    fc.assert(
      fc.property(steps, probeOffsets, (sequence, offset) => {
        const { state } = drive(sequence);
        const now = state.suspended ? state.nextVerificationAtEpochMs + offset : BASE + offset;
        // The scheduling predicate and the granting transition agree.
        expect(isVerificationDue(state, now)).toBe(
          state.suspended && now >= state.nextVerificationAtEpochMs,
        );
        const decision = admitVerification(state, now);
        if (!state.suspended) {
          expect(decision).toEqual({ admitted: false, reason: 'not-suspended' });
          return;
        }
        const armed = state.nextVerificationAtEpochMs;
        if (now < armed) {
          expect(decision).toEqual({
            admitted: false,
            reason: 'too-early',
            nextVerificationAtEpochMs: armed,
          });
          return;
        }
        if (!decision.admitted) throw new Error('expected admission at/after the boundary');
        expect(decision.state.nextVerificationAtEpochMs).toBe(now + INTERVAL);
        expect(Object.isFrozen(decision.state)).toBe(true);
      }),
    );
  });
});
