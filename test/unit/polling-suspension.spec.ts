import { describe, expect, it } from 'vitest';
import {
  TransportAbortError,
  TransportDnsError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import {
  classifyParseFailure,
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import {
  AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
  INITIAL_SUSPENSION_STATE,
  applyCycleOutcome,
  applyKeyIdentity,
  applyManualTestRequest,
  admitVerification,
  isSuspended,
  isVerificationDue,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';

/**
 * Table-driven coverage of the §7.2 401/403 suspension rules (task 108,
 * decision D-064): entering suspension on a classified auth rejection,
 * the 60-minute verification cadence with its exact boundary, re-arming
 * on every further rejection, both release events (key replacement,
 * manual test), the pinned no-effect of non-auth outcomes, and the
 * monotone admission floor that keeps a regressed clock from pulling the
 * gate open early. Time is data (D-021): every case is a pure call
 * against fixed clock readings; no timers, no network.
 */

/**
 * The fixed clock reading every case runs against: 2026-10-31T12:00:00Z.
 * Times are expressed as minute/second offsets for readability.
 */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/** `m` minutes (plus `s` seconds) after {@link T0}, in epoch ms. */
function at(m: number, s = 0): number {
  return T0 + (m * 60 + s) * 1000;
}

/** A classified 401/403 rejection of the given status, as 109 will feed it. */
function authRejected(status: 401 | 403): CycleOutcome {
  return classifyTransportError(
    new TransportStatusError(status, status === 401 ? 'Unauthorized' : 'Forbidden', undefined),
  );
}

/** The account's key identity in most scenarios (the "current" key). */
const KEY_A = 'key-generation-7';
/** A replacement key's identity. */
const KEY_B = 'key-generation-8';

/** Suspends the account under KEY_A at T0; returns the suspended state. */
function suspendedAtT0(status: 401 | 403 = 401): Extract<AuthSuspensionState, { suspended: true }> {
  const result = applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected(status), KEY_A, T0);
  if (!result.changed || result.state.suspended !== true) {
    throw new Error('suspendedAtT0: expected entry into suspension');
  }
  return result.state;
}

describe('the §7.2 verification cadence constant', () => {
  it('pins the interval at exactly 60 minutes', () => {
    expect(AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS).toBe(3_600_000);
  });
});

describe('applyCycleOutcome: entering suspension on 401/403', () => {
  it.each([401, 403] as const)(
    'HTTP %i from the initial state suspends for a full window',
    (status) => {
      const result = applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected(status), KEY_A, T0);
      expect(result.changed).toBe(true);
      expect(result).toMatchObject({ changed: true, effect: 'suspended' });
      expect(result.state).toEqual({
        suspended: true,
        keyIdentity: KEY_A,
        suspendedAtEpochMs: T0,
        // The rejected cycle itself was this window's attempt: the first
        // verification probe is armed one full window ahead.
        nextVerificationAtEpochMs: at(60),
      });
    },
  );

  it('freezes the states it produces (an armed instant cannot be mutated open)', () => {
    const result = applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected(401), KEY_A, T0);
    expect(Object.isFrozen(INITIAL_SUSPENSION_STATE)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(isSuspended(result.state)).toBe(true);
  });
});

describe('applyCycleOutcome: re-arming on further rejections of the same key', () => {
  it('pushes the armed instant to the rejection time + 60 min, keeping the episode start', () => {
    const result = applyCycleOutcome(suspendedAtT0(), authRejected(401), KEY_A, at(2));
    expect(result).toMatchObject({ changed: true, effect: 'rearmed' });
    expect(result.state).toEqual({
      suspended: true,
      keyIdentity: KEY_A,
      suspendedAtEpochMs: T0,
      nextVerificationAtEpochMs: at(62),
    });
  });

  it('reports no change when a regressed clock would pull the armed instant earlier', () => {
    // Entry armed at(60). A rejection stamped at the entry instant itself
    // (a duplicate outcome delivery) would re-arm to exactly at(60), and
    // one stamped before T0 would re-arm earlier still; the monotone
    // guard keeps the armed instant and reports no change.
    const state = suspendedAtT0();
    const duplicate = applyCycleOutcome(state, authRejected(401), KEY_A, T0);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.state).toBe(state);
    const regressed = applyCycleOutcome(state, authRejected(401), KEY_A, T0 - 1);
    expect(regressed.changed).toBe(false);
    expect(regressed.state).toBe(state);
  });

  it('re-arms when the rejection lands exactly on the armed instant', () => {
    const result = applyCycleOutcome(suspendedAtT0(), authRejected(403), KEY_A, at(60));
    expect(result).toMatchObject({ changed: true, effect: 'rearmed' });
    expect(result.state.suspended && result.state.nextVerificationAtEpochMs).toBe(at(120));
  });
});

describe('applyCycleOutcome: a different key rejected while suspended', () => {
  it('begins a fresh episode that still cannot open the gate before the armed instant', () => {
    // Unreachable through the intended wiring (a key change releases via
    // applyKeyIdentity first) but pinned as total: the arm was pushed to
    // at(120) by the 60-minute admission, and the different key's
    // rejection arrives stamped at(30) — 30 minutes *before* that
    // admission. Its own arm (at(90)) would open the gate early, so the
    // old episode's armed instant stands.
    const admitted = admitVerification(suspendedAtT0(), at(60));
    if (!admitted.admitted) throw new Error('expected admission');
    const result = applyCycleOutcome(admitted.state, authRejected(401), KEY_B, at(30));
    expect(result).toMatchObject({ changed: true, effect: 'suspended' });
    expect(result.state).toEqual({
      suspended: true,
      keyIdentity: KEY_B,
      suspendedAtEpochMs: at(30),
      nextVerificationAtEpochMs: at(120), // max(at(30) + 60 min, at(120))
    });
  });

  it('uses the rejection time + 60 min when that lies beyond the old armed instant', () => {
    const result = applyCycleOutcome(suspendedAtT0(), authRejected(401), KEY_B, at(70));
    expect(result.state.suspended && result.state.nextVerificationAtEpochMs).toBe(at(130));
  });
});

describe('applyCycleOutcome: release and no-effect outcomes', () => {
  it('a success while suspended releases, carrying the armed instant as the admission floor', () => {
    const state = suspendedAtT0();
    const result = applyCycleOutcome(state, classifySuccess(200), KEY_A, at(3));
    expect(result).toMatchObject({ changed: true, effect: 'released' });
    expect(result.state).toEqual({ suspended: false, admissionFloorEpochMs: at(60) });
    expect(isSuspended(result.state)).toBe(false);
  });

  it('a success while not suspended changes nothing', () => {
    const result = applyCycleOutcome(INITIAL_SUSPENSION_STATE, classifySuccess(200), KEY_A, T0);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(INITIAL_SUSPENSION_STATE);
  });

  it.each([
    [
      'a rate-limited cycle (its §7.2 machinery is 107/109, not this gate)',
      classifyTransportError(new TransportStatusError(429, 'Too Many Requests', '37')),
    ],
    ['a network failure', classifyTransportError(new TransportDnsError())],
    ['a timeout', classifyTransportError(new TransportTimeoutError(15_000))],
    [
      'a 5xx server error',
      classifyTransportError(new TransportStatusError(503, 'Service Unavailable', undefined)),
    ],
    ['a parse failure', classifyParseFailure({ reason: 'envelope was not the expected object' })],
    [
      'a caller abort (lifecycle, not a provider verdict)',
      classifyTransportError(new TransportAbortError()),
    ],
  ])(
    '%s while suspended leaves the suspension and its timer untouched',
    (_label, outcome: CycleOutcome) => {
      const state = suspendedAtT0();
      const result = applyCycleOutcome(state, outcome, KEY_A, at(1));
      expect(result.changed).toBe(false);
      expect(result.state).toBe(state);
    },
  );

  it.each([
    ['a network failure', classifyTransportError(new TransportDnsError())],
    ['a parse failure', classifyParseFailure({ reason: 'envelope was not the expected object' })],
  ])('%s while not suspended changes nothing', (_label, outcome: CycleOutcome) => {
    const result = applyCycleOutcome(INITIAL_SUSPENSION_STATE, outcome, KEY_A, T0);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(INITIAL_SUSPENSION_STATE);
  });
});

describe('applyKeyIdentity: the key-change release event', () => {
  it('a different identity releases the pause', () => {
    const result = applyKeyIdentity(suspendedAtT0(), KEY_B, at(30));
    expect(result).toMatchObject({ changed: true, effect: 'released' });
    expect(result.state).toEqual({ suspended: false, admissionFloorEpochMs: at(60) });
  });

  it('the same identity changes nothing (same reference)', () => {
    const state = suspendedAtT0();
    const result = applyKeyIdentity(state, KEY_A, at(30));
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it('a not-suspended state changes nothing', () => {
    const result = applyKeyIdentity(INITIAL_SUSPENSION_STATE, KEY_B, at(30));
    expect(result.changed).toBe(false);
    expect(result.state).toBe(INITIAL_SUSPENSION_STATE);
  });

  it('is idempotent: reporting the new identity again after release is a no-op', () => {
    const released = applyKeyIdentity(suspendedAtT0(), KEY_B, at(30));
    const again = applyKeyIdentity(released.state, KEY_B, at(31));
    expect(again.changed).toBe(false);
    expect(again.state).toBe(released.state);
  });
});

describe('applyManualTestRequest: the manual-test release event', () => {
  it('releases a suspended account', () => {
    const result = applyManualTestRequest(suspendedAtT0(), at(5));
    expect(result).toMatchObject({ changed: true, effect: 'released' });
    expect(result.state).toEqual({ suspended: false, admissionFloorEpochMs: at(60) });
  });

  it('is a no-op on a not-suspended account', () => {
    const result = applyManualTestRequest(INITIAL_SUSPENSION_STATE, at(5));
    expect(result.changed).toBe(false);
    expect(result.state).toBe(INITIAL_SUSPENSION_STATE);
  });
});

describe('admitVerification and isVerificationDue: the 60-minute gate', () => {
  it('never admits a not-suspended account', () => {
    expect(admitVerification(INITIAL_SUSPENSION_STATE, T0)).toEqual({
      admitted: false,
      reason: 'not-suspended',
    });
  });

  it('denies 1 ms before the boundary and echoes the armed instant', () => {
    expect(admitVerification(suspendedAtT0(), at(60) - 1)).toEqual({
      admitted: false,
      reason: 'too-early',
      nextVerificationAtEpochMs: at(60),
    });
  });

  it('admits exactly at the boundary and re-arms a full window from admission', () => {
    const decision = admitVerification(suspendedAtT0(), at(60));
    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.state.nextVerificationAtEpochMs).toBe(at(120));
      expect(decision.state.suspendedAtEpochMs).toBe(T0);
    }
  });

  it('admits after the boundary, re-arming from the admission time', () => {
    const decision = admitVerification(suspendedAtT0(), at(61));
    expect(decision.admitted).toBe(true);
    if (decision.admitted) expect(decision.state.nextVerificationAtEpochMs).toBe(at(121));
  });

  it('denies an immediate second admission — the no-rapid-retry pin', () => {
    const first = admitVerification(suspendedAtT0(), at(60));
    if (!first.admitted) throw new Error('expected admission');
    // The caller retries admission in the same millisecond, or having
    // lost the attempt's outcome entirely — either way the gate is shut.
    expect(admitVerification(first.state, at(60))).toEqual({
      admitted: false,
      reason: 'too-early',
      nextVerificationAtEpochMs: at(120),
    });
  });

  it.each([
    ['long before the boundary', suspendedAtT0(), at(1), false],
    ['1 ms before the boundary', suspendedAtT0(), at(60) - 1, false],
    ['exactly at the boundary', suspendedAtT0(), at(60), true],
    ['after the boundary', suspendedAtT0(), at(90), true],
    ['not suspended', INITIAL_SUSPENSION_STATE, at(90), false],
  ])(
    'isVerificationDue is true %s',
    (_label, state: AuthSuspensionState, now: number, due: boolean) => {
      expect(isVerificationDue(state, now)).toBe(due);
    },
  );
});

describe('the §7.2 edge scenarios (the done-condition, pinned)', () => {
  it('a rejection at minute 59:59 re-arms: no admission at 60:00, one at 119:59', () => {
    const rearmed = applyCycleOutcome(suspendedAtT0(), authRejected(401), KEY_A, at(59, 59));
    expect(admitVerification(rearmed.state, at(60, 0))).toEqual({
      admitted: false,
      reason: 'too-early',
      nextVerificationAtEpochMs: at(119, 59),
    });
    expect(admitVerification(rearmed.state, at(119, 58) + 999).admitted).toBe(false);
    expect(admitVerification(rearmed.state, at(119, 59)).admitted).toBe(true);
  });

  it('a failed verification re-arms the timer past its own admission arm', () => {
    const admitted = admitVerification(suspendedAtT0(), at(60));
    if (!admitted.admitted) throw new Error('expected admission');
    // The probe ran at 60:00 and its rejection was recorded at 60:02.
    const failed = applyCycleOutcome(admitted.state, authRejected(401), KEY_A, at(60, 2));
    expect(failed).toMatchObject({ changed: true, effect: 'rearmed' });
    expect(admitVerification(failed.state, at(120, 0)).admitted).toBe(false);
    expect(admitVerification(failed.state, at(120, 2)).admitted).toBe(true);
  });

  it('a key change mid-window releases; a rejection of the new key starts a fresh window', () => {
    const released = applyKeyIdentity(suspendedAtT0(), KEY_B, at(30));
    expect(released.changed).toBe(true);
    const resuspended = applyCycleOutcome(released.state, authRejected(401), KEY_B, at(31));
    expect(resuspended).toMatchObject({ changed: true, effect: 'suspended' });
    expect(resuspended.state.suspended && resuspended.state.nextVerificationAtEpochMs).toBe(at(91));
    expect(admitVerification(resuspended.state, at(90, 59)).admitted).toBe(false);
    expect(admitVerification(resuspended.state, at(91)).admitted).toBe(true);
  });

  it('a manual test mid-window releases; its rejection re-arms a full window', () => {
    const released = applyManualTestRequest(suspendedAtT0(), at(5));
    expect(released.changed).toBe(true);
    // The manual attempt ran immediately and failed auth one second later.
    const resuspended = applyCycleOutcome(released.state, authRejected(401), KEY_A, at(5, 1));
    expect(resuspended.state.suspended && resuspended.state.nextVerificationAtEpochMs).toBe(
      at(65, 1),
    );
    expect(admitVerification(resuspended.state, at(65, 0)).admitted).toBe(false);
  });

  it('a lost outcome keeps the gate shut: admission re-arms by itself', () => {
    const admitted = admitVerification(suspendedAtT0(), at(60));
    if (!admitted.admitted) throw new Error('expected admission');
    // The caller never reports the attempt's outcome; nothing re-opens
    // before the admission-anchored arm.
    expect(admitVerification(admitted.state, at(119, 59) + 999).admitted).toBe(false);
    expect(admitVerification(admitted.state, at(120)).admitted).toBe(true);
  });

  it('a clock regression across a release cannot pull the gate open early', () => {
    // Admitted at 60:00 (arm 120:00), released by a manual test, and the
    // manual attempt's rejection is then stamped 30 minutes after T0 —
    // 30 minutes *before* the last admission. The admission floor keeps
    // the next automatic attempt a full window after the last one.
    const admitted = admitVerification(suspendedAtT0(), at(60));
    if (!admitted.admitted) throw new Error('expected admission');
    const released = applyManualTestRequest(admitted.state, at(61));
    const resuspended = applyCycleOutcome(released.state, authRejected(401), KEY_A, at(30));
    expect(resuspended.state.suspended && resuspended.state.nextVerificationAtEpochMs).toBe(
      at(120),
    );
    expect(admitVerification(resuspended.state, at(119, 59)).admitted).toBe(false);
    expect(admitVerification(resuspended.state, at(120)).admitted).toBe(true);
  });
});

describe('fail-fast input validation (task 107 convention)', () => {
  it.each([
    [
      'applyCycleOutcome: non-finite now',
      () => applyCycleOutcome(suspendedAtT0(), authRejected(401), KEY_A, Number.NaN),
    ],
    [
      'applyCycleOutcome: positive-infinite now',
      () =>
        applyCycleOutcome(
          INITIAL_SUSPENSION_STATE,
          authRejected(401),
          KEY_A,
          Number.POSITIVE_INFINITY,
        ),
    ],
    [
      'applyCycleOutcome: blank key identity',
      () => applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected(401), '', T0),
    ],
    [
      'applyCycleOutcome: whitespace key identity',
      () => applyCycleOutcome(INITIAL_SUSPENSION_STATE, authRejected(401), '   ', T0),
    ],
    [
      'applyCycleOutcome: non-object outcome',
      () => applyCycleOutcome(INITIAL_SUSPENSION_STATE, null as unknown as CycleOutcome, KEY_A, T0),
    ],
    [
      'applyCycleOutcome: outcome without a string outcome field',
      () => applyCycleOutcome(INITIAL_SUSPENSION_STATE, {} as CycleOutcome, KEY_A, T0),
    ],
    [
      'applyCycleOutcome: null state',
      () => applyCycleOutcome(null as unknown as AuthSuspensionState, authRejected(401), KEY_A, T0),
    ],
    [
      'applyCycleOutcome: suspended state missing its fields',
      () =>
        applyCycleOutcome({ suspended: true } as AuthSuspensionState, authRejected(401), KEY_A, T0),
    ],
    [
      'applyCycleOutcome: not-suspended state missing its floor',
      () =>
        applyCycleOutcome(
          { suspended: false } as AuthSuspensionState,
          authRejected(401),
          KEY_A,
          T0,
        ),
    ],
    [
      'applyCycleOutcome: not-suspended state with a NaN floor',
      () =>
        applyCycleOutcome(
          { suspended: false, admissionFloorEpochMs: Number.NaN } as AuthSuspensionState,
          authRejected(401),
          KEY_A,
          T0,
        ),
    ],
    [
      'applyCycleOutcome: not-suspended state with a +Infinity floor',
      () =>
        applyCycleOutcome(
          {
            suspended: false,
            admissionFloorEpochMs: Number.POSITIVE_INFINITY,
          } as AuthSuspensionState,
          authRejected(401),
          KEY_A,
          T0,
        ),
    ],
    ['applyKeyIdentity: blank identity', () => applyKeyIdentity(suspendedAtT0(), '', T0)],
    [
      'applyKeyIdentity: non-finite now, validated even on the no-op path',
      () => applyKeyIdentity(INITIAL_SUSPENSION_STATE, KEY_A, Number.NaN),
    ],
    [
      'applyManualTestRequest: non-finite now',
      () => applyManualTestRequest(INITIAL_SUSPENSION_STATE, Number.NaN),
    ],
    [
      'admitVerification: non-finite now',
      () => admitVerification(INITIAL_SUSPENSION_STATE, Number.NaN),
    ],
    [
      'isVerificationDue: non-finite now',
      () => isVerificationDue(INITIAL_SUSPENSION_STATE, Number.NaN),
    ],
  ])('%s throws TypeError', (_label, call: () => unknown) => {
    expect(call).toThrow(TypeError);
  });

  it('error messages name the entry point and the violated argument', () => {
    expect(() => applyCycleOutcome(suspendedAtT0(), authRejected(401), KEY_A, Number.NaN)).toThrow(
      /applyCycleOutcome: nowEpochMs must be a finite number/u,
    );
    expect(() => applyKeyIdentity(suspendedAtT0(), '', T0)).toThrow(
      /applyKeyIdentity: keyIdentity must be a non-blank string/u,
    );
  });
});
