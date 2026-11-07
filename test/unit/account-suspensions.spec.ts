import { describe, expect, it } from 'vitest';
import { createFixedClock } from '../../src/util/clock';
import {
  AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
  INITIAL_SUSPENSION_STATE,
  isSuspended,
} from '../../src/services/polling-suspension';
import { createAccountSuspensions } from '../../src/services/account-suspensions';
import { classifySuccess, classifyTransportError } from '../../src/services/polling-outcomes';
import { TransportStatusError } from '../../src/providers/transport';

/**
 * The composition-level D-064 holder (task U-040, decision D-140; the
 * polled-cycle feed since U-051/D-176): the per-account default, the
 * manual-test release, the rejection re-entry with a fresh 60-minute
 * window, the polled-outcome feed that keeps the holder in lockstep with
 * the polling engine's own machine, and per-account isolation — every
 * expectation is D-064's own, observed through the holder the composition
 * wires into `suspensionOf`. Time is data (D-021): a fixed clock, no
 * timers.
 */

/** The fixed clock reading every case starts from: 2026-11-03T10:00:00Z. */
const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);

/** Creates the holder over a fixed clock, exposed for time manipulation. */
function holder() {
  const clock = createFixedClock(T0);
  return { clock, suspensions: createAccountSuspensions({ clock }) };
}

/** The opaque key identity of a (fake) key — D-064's shape, not its material. */
const KEY_A = 'identity-of-key-a';
const KEY_B = 'identity-of-key-b';

describe('createAccountSuspensions', () => {
  it('reads the unsuspended initial state for unknown accounts', () => {
    const { suspensions } = holder();
    expect(suspensions.suspensionOf('unknown')).toEqual(INITIAL_SUSPENSION_STATE);
    expect(isSuspended(suspensions.suspensionOf('unknown'))).toBe(false);
  });

  it('enters suspension with a fresh 60-minute window when a manual test is rejected', () => {
    const { suspensions } = holder();
    suspensions.manualTestRejected('work', KEY_A);
    const state = suspensions.suspensionOf('work');
    expect(isSuspended(state)).toBe(true);
    if (!isSuspended(state)) return;
    expect(state.keyIdentity).toBe(KEY_A);
    expect(state.suspendedAtEpochMs).toBe(T0);
    expect(state.nextVerificationAtEpochMs).toBe(T0 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS);
  });

  it('releases on the manual-test request — the §7.2 lift (the U-040 done-condition)', () => {
    const { suspensions } = holder();
    suspensions.manualTestRejected('work', KEY_A);
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);
    suspensions.manualTestRequested('work');
    expect(suspensions.suspensionOf('work')).toEqual({
      suspended: false,
      admissionFloorEpochMs: T0 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
    });
  });

  it('re-enters with a fresh window when the next manual test rejects again', () => {
    const { clock, suspensions } = holder();
    suspensions.manualTestRejected('work', KEY_A);
    clock.advance(5 * 60_000);
    suspensions.manualTestRequested('work'); // release-on-request …
    suspensions.manualTestRejected('work', KEY_A); // … and the rejection re-enters
    const state = suspensions.suspensionOf('work');
    expect(isSuspended(state)).toBe(true);
    if (!isSuspended(state)) return;
    expect(state.suspendedAtEpochMs).toBe(T0 + 5 * 60_000);
    expect(state.nextVerificationAtEpochMs).toBe(
      T0 + 5 * 60_000 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
    );
  });

  it('keeps a rejection under another key a fresh episode (the key-change rule feeds through)', () => {
    const { suspensions } = holder();
    suspensions.manualTestRejected('work', KEY_A);
    suspensions.manualTestRequested('work');
    suspensions.manualTestRejected('work', KEY_B);
    const state = suspensions.suspensionOf('work');
    expect(isSuspended(state)).toBe(true);
    if (!isSuspended(state)) return;
    expect(state.keyIdentity).toBe(KEY_B);
  });

  it("releases on the key-change report — §7.2's other release condition", () => {
    const { suspensions } = holder();
    suspensions.manualTestRejected('work', KEY_A);
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);
    // The same identity is a no-op (idempotent reporting, D-064)…
    suspensions.reportKeyIdentity('work', KEY_A);
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);
    // …a different identity releases the episode.
    suspensions.reportKeyIdentity('work', KEY_B);
    expect(suspensions.suspensionOf('work').suspended).toBe(false);
  });

  it('is idempotent per event and isolates accounts', () => {
    const { suspensions } = holder();
    suspensions.manualTestRequested('healthy'); // no-op on an unsuspended account
    expect(suspensions.suspensionOf('healthy')).toEqual(INITIAL_SUSPENSION_STATE);
    suspensions.manualTestRejected('a', KEY_A);
    suspensions.manualTestRejected('a', KEY_A); // re-arm, same window shape
    expect(isSuspended(suspensions.suspensionOf('a'))).toBe(true);
    expect(suspensions.suspensionOf('b')).toEqual(INITIAL_SUSPENSION_STATE);
  });

  describe('polledCycleOutcome — the polled-cycle feed (U-051, D-176)', () => {
    /** The §11.2 classification of one polled HTTP verdict. */
    const outcomeOf = (status: number) =>
      classifyTransportError(new TransportStatusError(status, '', undefined));

    it('enters suspension when a polled cycle is auth-rejected (401)', () => {
      const { suspensions } = holder();
      suspensions.polledCycleOutcome('work', outcomeOf(401), KEY_A);
      const state = suspensions.suspensionOf('work');
      expect(isSuspended(state)).toBe(true);
      if (!isSuspended(state)) return;
      expect(state.keyIdentity).toBe(KEY_A);
      expect(state.nextVerificationAtEpochMs).toBe(T0 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS);
    });

    it('releases when a polled cycle succeeds', () => {
      const { suspensions } = holder();
      suspensions.polledCycleOutcome('work', outcomeOf(403), KEY_A);
      expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);
      suspensions.polledCycleOutcome('work', classifySuccess(200), KEY_A);
      expect(suspensions.suspensionOf('work').suspended).toBe(false);
    });

    it('treats an inconclusive polled outcome as a pinned no-op (D-064)', () => {
      const { clock, suspensions } = holder();
      suspensions.polledCycleOutcome('work', outcomeOf(401), KEY_A);
      clock.set(T0 + 90_000);
      // A 429 proves nothing about the key: the episode and its armed
      // instant are untouched — the §7.3 no-downgrade rule's data.
      suspensions.polledCycleOutcome('work', outcomeOf(429), KEY_A);
      const state = suspensions.suspensionOf('work');
      expect(isSuspended(state)).toBe(true);
      if (!isSuspended(state)) return;
      expect(state.suspendedAtEpochMs).toBe(T0);
      expect(state.nextVerificationAtEpochMs).toBe(T0 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS);
    });

    it('keys the episode by the identity the cycle ran with', () => {
      const { suspensions } = holder();
      suspensions.polledCycleOutcome('work', outcomeOf(401), KEY_A);
      // A rejection under a different identity begins a fresh episode that
      // still respects the old armed instant (D-064's monotone floor).
      suspensions.polledCycleOutcome('work', outcomeOf(401), KEY_B);
      const state = suspensions.suspensionOf('work');
      expect(isSuspended(state)).toBe(true);
      if (!isSuspended(state)) return;
      expect(state.keyIdentity).toBe(KEY_B);
      expect(state.suspendedAtEpochMs).toBe(T0);
      expect(state.nextVerificationAtEpochMs).toBe(T0 + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS);
    });

    it('drops the episode with the engine entry when the account leaves the polled set (D-176)', () => {
      const { suspensions } = holder();
      suspensions.polledCycleOutcome('work', outcomeOf(401), KEY_A);
      expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);
      suspensions.dropAccount('work');
      expect(suspensions.suspensionOf('work')).toEqual(INITIAL_SUSPENSION_STATE);
      // Dropping an unknown (or already-dropped) account is a no-op.
      suspensions.dropAccount('nobody');
      expect(suspensions.suspensionOf('nobody')).toEqual(INITIAL_SUSPENSION_STATE);
    });
  });
});
