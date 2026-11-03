/**
 * The composition-level D-064 suspension holder (spec §7.2, §7.3; task U-040,
 * decision D-140).
 *
 * D-064 built the auth-rejection suspension as a pure state machine whose
 * state "is a value the caller holds"; the polling scheduler (task 109) was
 * its named holder for polled accounts. Until the polling engine joins the
 * composition, the runtime still needs one holder: `/api/status` derives the
 * §7.3 `Auth rejected` token from a per-account
 * {@link AuthSuspensionState} (D-130's `suspensionOf` seam), and §7.2's
 * manual-test release must land somewhere server-side. This module is that
 * holder: a per-account map over the landed transitions, nothing more — the
 * state machine itself stays the single authority (every entry point here
 * delegates to `polling-suspension`).
 *
 * The transitions fed here are exactly the ones the composition can observe
 * today: the manual connection test (`POST /api/accounts/:id/test`). D-064's
 * own reading is applied verbatim — the *request* releases unconditionally
 * ("until … a manual test is requested"), the attempt then runs, and its
 * 401/403 immediately re-enters suspension with a fresh 60-minute window —
 * so the observable end state is the task's done-condition: a *successful*
 * manual test lifts the pause, a rejected one keeps it. When the polling
 * engine lands it becomes the holding side for polled cycles (feeding
 * `applyCycleOutcome` per normal poll); this holder remains the composition's
 * seam for manual tests and status reads, so the two cannot disagree about
 * whether an account is suspended.
 */

import type { Clock } from '../util/clock';
import type { AuthSuspensionState } from './polling-suspension';
import {
  INITIAL_SUSPENSION_STATE,
  applyCycleOutcome,
  applyKeyIdentity,
  applyManualTestRequest,
} from './polling-suspension';
import type { CycleOutcome } from './polling-outcomes';
import { STATUS_CONTRIBUTION_BY_OUTCOME } from './polling-outcomes';
import { createHash } from 'node:crypto';

/**
 * The auth-rejection classification of a manual test whose provider refused
 * the key (D-052's `credentials-rejected` kind). Built from the landed
 * outcome tables so the §7.2 flags cannot drift from the polling side's
 * classification of the same HTTP verdict.
 */
const AUTH_ERROR_OUTCOME: CycleOutcome = Object.freeze({
  outcome: 'auth_error',
  httpStatus: undefined,
  retryAfterRaw: undefined,
  retryAfterEligible: false,
  retryable: false,
  statusContribution: STATUS_CONTRIBUTION_BY_OUTCOME.auth_error,
  errorMessage: undefined,
}) as CycleOutcome;

/** The per-account suspension holder the composition wires (D-130's seam). */
export interface AccountSuspensions {
  /**
   * The account's D-064 state — the `suspensionOf` reader the status routes
   * derive §7.3's `Auth rejected` from. Unknown accounts read unsuspended
   * (the D-070 restart-view default).
   */
  suspensionOf(accountId: string): AuthSuspensionState;
  /**
   * A manual test was requested for the account (§7.2's release condition):
   * applies D-064's unconditional release. Idempotent — a healthy account's
   * test is just a cycle.
   */
  manualTestRequested(accountId: string): void;
  /**
   * The manual attempt ran and the provider refused the key (401/403): feeds
   * D-064's outcome seam, which re-enters (or re-arms) suspension with a
   * fresh 60-minute window. `keyIdentity` is the opaque identity of the
   * tested key — key material never reaches the state machine.
   */
  manualTestRejected(accountId: string, keyIdentity: string): void;
  /**
   * §7.2's other release condition: the account's currently configured key
   * identity, reported on every configuration observation (a reload whose
   * `applied` includes `accounts`) — D-064's `applyKeyIdentity` releases an
   * episode that began under a different key and is idempotent otherwise,
   * so unconditional reporting cannot miss or duplicate a release.
   */
  reportKeyIdentity(accountId: string, keyIdentity: string): void;
}

/**
 * The opaque D-064 key identity of one resolved secret: the hex SHA-256 of
 * the value — stable per key, non-reversible, and never the key material
 * itself (D-064's own rule). One site for the vocabulary so the manual-test
 * observation and the configuration observation derive identical identities
 * for the same key.
 */
export function keyIdentityOfSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Options of {@link createAccountSuspensions}. */
export interface AccountSuspensionsOptions {
  /** The shared clock (D-021) — every transition stamps from it. */
  readonly clock: Clock;
}

/** Creates the holder. Pure in-memory; no timers, no I/O. */
export function createAccountSuspensions(options: AccountSuspensionsOptions): AccountSuspensions {
  const states = new Map<string, AuthSuspensionState>();

  /** Applies one landed transition over the account's held (or initial) state. */
  const transition = (
    accountId: string,
    apply: (state: AuthSuspensionState) => AuthSuspensionState,
  ): void => {
    // An absent entry holds the initial state by construction; storing the
    // unchanged initial value after a no-op transition is observationally
    // identical, so the map may materialize entries freely.
    states.set(accountId, apply(states.get(accountId) ?? INITIAL_SUSPENSION_STATE));
  };

  return {
    suspensionOf(accountId) {
      return states.get(accountId) ?? INITIAL_SUSPENSION_STATE;
    },
    manualTestRequested(accountId) {
      const now = options.clock.now();
      transition(accountId, (state) => applyManualTestRequest(state, now).state);
    },
    manualTestRejected(accountId, keyIdentity) {
      const now = options.clock.now();
      transition(
        accountId,
        (state) => applyCycleOutcome(state, AUTH_ERROR_OUTCOME, keyIdentity, now).state,
      );
    },
    reportKeyIdentity(accountId, keyIdentity) {
      const now = options.clock.now();
      transition(accountId, (state) => applyKeyIdentity(state, keyIdentity, now).state);
    },
  };
}
