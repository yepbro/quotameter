import { describe, expect, it } from 'vitest';
import { createFixedClock } from '../../src/util/clock';
import {
  AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
  INITIAL_SUSPENSION_STATE,
  isSuspended,
} from '../../src/services/polling-suspension';
import { createAccountSuspensions } from '../../src/services/account-suspensions';

/**
 * The composition-level D-064 holder (task U-040, decision D-140): the
 * per-account default, the manual-test release, the rejection re-entry with
 * a fresh 60-minute window, and per-account isolation — every expectation
 * is D-064's own, observed through the holder the composition wires into
 * `suspensionOf`. Time is data (D-021): a fixed clock, no timers.
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
});
