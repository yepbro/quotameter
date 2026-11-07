/**
 * The single D-064 suspension holder (spec §7.2, §7.3; task U-040, decision
 * D-140; the single-holder unification FSM-3, decision D-189).
 *
 * D-064 built the auth-rejection suspension as a pure state machine whose
 * state "is a value the caller holds". This module is the one holder of
 * that value per account **in the process**: a per-account map over the
 * landed transitions, nothing more — the state machine itself stays the
 * single authority (every entry point here delegates to
 * `polling-suspension`). Exactly one instance is wired by the composition
 * root and shared by every D-064 consumer:
 *
 * - the polling scheduler (D-066) reads its dispatch gates through it and
 *   writes every polled-cycle outcome, key-identity observation, manual-test
 *   request, admission re-arm, and leave-the-polled-set drop back into it
 *   (`PollingSchedulerOptions.suspensions`);
 * - `/api/status` derives the §7.3 `Auth rejected` token from
 *   `suspensionOf` (D-130's seam);
 * - the manual-connection-test observation (`src/server/providers.ts`)
 *   applies §7.2's manual-test events to it — the request releases
 *   unconditionally ("until … a manual test is requested"), and a refused
 *   key re-enters suspension with a fresh 60-minute window.
 *
 * Before FSM-3 the scheduler held a second, private instance of the same
 * pure machine and the two were kept in lockstep by convention (a settle
 * wrapper re-feeding every outcome, a wiring-epoch staleness rule, and
 * duplicated auth-error constants) — any event source wired into one
 * holder but not the other silently diverged `/api/status` from dispatch
 * gating. One store makes the agreement structural: there is nothing to
 * keep in step. The stale-outcome rule lives where the outcome is
 * consumed: the scheduler's settle path discards an outcome whose flight's
 * wiring was removed or re-keyed mid-flight (its own entry-identity
 * check), so it never reaches this holder.
 */

import type { Clock } from '../util/clock';
import type { AuthSuspensionState } from './polling-suspension';
import {
  INITIAL_SUSPENSION_STATE,
  admitVerification,
  applyCycleOutcome,
  applyKeyIdentity,
  applyManualTestRequest,
  type VerificationAdmission,
} from './polling-suspension';
import type { CycleOutcome } from './polling-outcomes';
import { classifyAuthRejection } from './polling-outcomes';
import { createHash } from 'node:crypto';

/** The per-account suspension store the composition wires (D-130's seam). */
export interface AccountSuspensions {
  /**
   * The account's D-064 state — the one value both the status routes
   * (§7.3's `Auth rejected`) and the scheduler's dispatch gates read.
   * Unknown accounts read unsuspended (the D-070 restart-view default).
   */
  suspensionOf(accountId: string): AuthSuspensionState;
  /**
   * A manual test was requested for the account (§7.2's release condition):
   * applies D-064's unconditional release. Idempotent — a healthy account's
   * test is just a cycle, and the scheduler's `requestManualTest` bridge
   * applies the same transition beside the observation wrapper's (the
   * second application is a no-op on the released state, by D-064's
   * design).
   */
  manualTestRequested(accountId: string): void;
  /**
   * The manual attempt ran and the provider refused the key (401/403): feeds
   * D-064's outcome seam, which re-enters (or re-arms) suspension with a
   * fresh 60-minute window. `keyIdentity` is the opaque identity of the
   * tested key — the key the provider actually refused — and key material
   * never reaches the state machine.
   */
  manualTestRejected(accountId: string, keyIdentity: string): void;
  /**
   * §7.2's other release condition: the account's currently configured key
   * identity, reported on every configuration observation (a reload whose
   * `applied` includes `accounts`, and the scheduler's `setAccounts` —
   * D-064's `applyKeyIdentity` releases an episode that began under a
   * different key and is idempotent otherwise, so unconditional reporting
   * cannot miss or duplicate a release). Returns whether the report changed
   * the state — the scheduler's release re-anchor condition.
   */
  reportKeyIdentity(accountId: string, keyIdentity: string): boolean;
  /**
   * A polled cycle settled with this classification: feeds D-064's outcome
   * seam — the one application the settled outcome gets. `keyIdentity` is
   * the identity of the key the cycle RAN with (the wiring's, snapshotted
   * at dispatch); the scheduler's settle path has already discarded the
   * outcomes of flights whose wiring was removed or re-keyed mid-flight,
   * so an old key's 401 suspends neither a re-keyed account nor a
   * removed-and-re-added one. Non-auth outcomes are D-064 no-ops;
   * reporting them keeps the store's event stream identical to the
   * machine's own contract.
   */
  polledCycleOutcome(accountId: string, outcome: CycleOutcome, keyIdentity: string): void;
  /**
   * Requests admission for one verification attempt on the suspended
   * account — the scheduler's dispatch gate (D-064's pacing mechanism).
   * Granted iff the state is suspended and the armed instant has passed
   * (the boundary admits); a granted admission re-arms the armed instant
   * to `now + 60 min` **in this store** at admission time, so the pacing
   * survives even if the attempt's outcome is never reported.
   */
  admitVerification(accountId: string): VerificationAdmission;
  /**
   * The account left the polled set (removed, disabled, or its secret
   * stopped resolving — the scheduler's `setAccounts` drop): the episode
   * drops. Suspension is process memory — a restart forgets it too
   * (D-064's recorded consequence) — and D-070's run-evidence arm keeps
   * the §7.3 display truthful for the first cycle after a return.
   */
  dropAccount(accountId: string): void;
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
  /**
   * The shared clock (D-021) — every transition stamps from it. The
   * composition injects the one instance the polling scheduler also reads,
   * so the store's stamps and the engine's gates share a time base.
   */
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
        (state) => applyCycleOutcome(state, classifyAuthRejection(), keyIdentity, now).state,
      );
    },
    reportKeyIdentity(accountId, keyIdentity) {
      const now = options.clock.now();
      let changed = false;
      transition(accountId, (state) => {
        const applied = applyKeyIdentity(state, keyIdentity, now);
        changed = applied.changed;
        return applied.state;
      });
      return changed;
    },
    polledCycleOutcome(accountId, outcome, keyIdentity) {
      const now = options.clock.now();
      transition(accountId, (state) => applyCycleOutcome(state, outcome, keyIdentity, now).state);
    },
    admitVerification(accountId) {
      const now = options.clock.now();
      const state = states.get(accountId) ?? INITIAL_SUSPENSION_STATE;
      const admission = admitVerification(state, now);
      if (admission.admitted) states.set(accountId, admission.state);
      return admission;
    },
    dropAccount(accountId) {
      states.delete(accountId);
    },
  };
}
