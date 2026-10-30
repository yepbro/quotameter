/**
 * Authorization-rejection suspension (spec §7.2, §7.3; task 108, decision
 * D-064).
 *
 * The §7.2 HTTP 401/403 row's pause half: after an auth-rejected cycle —
 * which task 106's wrapper already leaves at a single attempt, "do not
 * retry within the current cycle" — normal polling for that account is
 * paused "until the key changes or a manual test is requested", with "a
 * verification attempt once every 60 minutes" as the only automatic probe.
 * This module is the pure state machine behind that sentence: it converts
 * `(state, event, clock reading)` into `(next state, what happened)` and
 * owns exactly one decision — **when an automatic attempt on a suspended
 * account is admissible**. Everything else stays with its own task: the
 * polling scheduler (109) runs the attempts and holds the state object,
 * the run writer (110) persists each cycle, and the account-status
 * derivation (111) consumes the `Auth rejected` contribution task 105
 * already attaches to the outcome (§7.3 rank 1 — the highest-precedence
 * status, which is why suspension must gate polling, not merely label it).
 *
 * The two release conditions are input events, by design: key-change
 * detection is the caller's observation (it passes an opaque key identity
 * — a generation counter or hash — and the machine compares identities,
 * never key material), and a manual-test request is the caller's command.
 * Neither touches configuration or the filesystem here.
 *
 * The done-condition — no rapid retry loop is possible — is structural:
 * an admission requires `now >= nextVerificationAtEpochMs` and re-arms
 * that instant to `now + 60 min`, and the armed instant is **monotone**
 * within a suspension episode (every re-arm takes the maximum) and
 * **survives release** as an admission floor on the not-suspended state.
 * Two automatic attempts can therefore never be closer than 60 minutes,
 * whatever the caller does — including losing an outcome, hammering auth
 * failures, or feeding a wall clock that jumps backwards (D-021's
 * fixed-clock double models exactly such jumps; the floor makes them
 * fail-safe). The standing proof is the property spec,
 * `test/unit/polling-suspension.property.spec.ts`.
 *
 * Time never comes from the machine clock (D-021): every entry point
 * takes the current epoch as an argument and validates it finite, even on
 * paths that would not use it — task 107's convention.
 */

import type { CycleOutcome } from './polling-outcomes';

/* ── The §7.2 verification cadence ─────────────────────────────────────── */

/**
 * The §7.2 401/403 row's verification cadence: while an account is
 * suspended, exactly one verification attempt per 60 minutes. The rejected
 * cycle itself was an attempt, so entry arms the first probe one full
 * window ahead; every admission and every subsequent auth rejection re-arms
 * by the same amount.
 */
export const AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS = 3_600_000;

/* ── State ─────────────────────────────────────────────────────────────── */

/**
 * The state of an account that is not suspended: normal polling runs on
 * the configured interval (task 109's schedule, not this machine's).
 *
 * `admissionFloorEpochMs` is the high-water mark of every verification
 * instant this machine has ever armed — `-Infinity` before the first
 * suspension, the last armed `nextVerificationAtEpochMs` after a release.
 * A later episode's gate never opens before it, so a regressed clock
 * reading after a release cannot pull the cadence forward; under a
 * forward-moving clock it is inert (any fresh entry's `now + 60 min`
 * already lies above it).
 */
export interface NotSuspended {
  readonly suspended: false;
  readonly admissionFloorEpochMs: number;
}

/**
 * The state of an account whose key was auth-rejected: normal polling is
 * gated off (`suspended` is the gate task 109 checks) and the only
 * admissible automatic attempt is a verification probe at or after
 * `nextVerificationAtEpochMs`.
 */
export interface Suspended {
  readonly suspended: true;
  /**
   * The opaque identity (generation counter, hash — caller's choice) of
   * the key whose rejection started this episode. Releasing on key
   * replacement is an identity comparison; key material never reaches
   * this module.
   */
  readonly keyIdentity: string;
  /** When this episode began — its first 401/403. Diagnostic only. */
  readonly suspendedAtEpochMs: number;
  /**
   * The earliest instant a verification attempt may be admitted. Monotone
   * within the episode: transitions only ever move it later.
   */
  readonly nextVerificationAtEpochMs: number;
}

/** The suspension state machine's value; the caller owns holding it. */
export type AuthSuspensionState = NotSuspended | Suspended;

/**
 * The initial state: never suspended, nothing ever armed. Frozen like
 * every state this module produces, so a caller cannot accidentally open
 * the gate by mutating an armed instant.
 */
export const INITIAL_SUSPENSION_STATE: NotSuspended = Object.freeze({
  suspended: false,
  admissionFloorEpochMs: Number.NEGATIVE_INFINITY,
});

/**
 * Narrows to the suspended state — the normal-polling gate. While this
 * holds, the only admissible automatic attempt is a verification probe
 * through {@link admitVerification}.
 */
export function isSuspended(state: AuthSuspensionState): state is Suspended {
  return state.suspended;
}

/* ── Transition results ────────────────────────────────────────────────── */

/** What a transition did to the state. */
export type SuspensionEffect =
  /** A suspension episode began (first rejection, or a different key's). */
  | 'suspended'
  /** A subsequent auth rejection pushed the armed instant later. */
  | 'rearmed'
  /** The pause ended (successful probe, key replacement, manual test). */
  | 'released';

/**
 * The result of every `apply*` transition: the next state plus what
 * happened, so callers can log the effect without diffing states.
 * `changed: false` returns the input state unchanged (same reference).
 */
export type SuspensionTransition =
  | { readonly state: AuthSuspensionState; readonly changed: false }
  | {
      readonly state: AuthSuspensionState;
      readonly changed: true;
      readonly effect: SuspensionEffect;
    };

/**
 * The admission decision for a verification attempt: granted (with the
 * re-armed state — the caller runs the attempt and reports its classified
 * outcome back through {@link applyCycleOutcome}), or denied with why.
 */
export type VerificationAdmission =
  | { readonly admitted: true; readonly state: Suspended }
  | { readonly admitted: false; readonly reason: 'not-suspended' }
  | {
      readonly admitted: false;
      readonly reason: 'too-early';
      readonly nextVerificationAtEpochMs: number;
    };

/* ── Input validation (fail-fast, task 107's convention) ───────────────── */

/** Validates the injected clock reading; every entry point shares it. */
function requireFiniteNow(nowEpochMs: number, caller: string): void {
  if (!Number.isFinite(nowEpochMs)) {
    throw new TypeError(`${caller}: nowEpochMs must be a finite number`);
  }
}

/**
 * Validates the key identity: a non-blank string. The caller always has a
 * key in hand for the cycle that produced an outcome (or the current
 * configuration observation), so a blank identity is a wiring bug, not an
 * input state — and it would collapse all keys into one identity.
 */
function requireKeyIdentity(keyIdentity: string, caller: string): void {
  if (typeof keyIdentity !== 'string' || keyIdentity.trim() === '') {
    throw new TypeError(`${caller}: keyIdentity must be a non-blank string`);
  }
}

/** Structural validation of a state value against the two branches. */
function requireState(state: AuthSuspensionState, caller: string): void {
  if (typeof state !== 'object' || state === null) {
    throw new TypeError(`${caller}: state must be an AuthSuspensionState`);
  }
  if (state.suspended === false) {
    // The floor is either a finite instant or the initial "nothing armed
    // yet" marker; anything else would let a hand-crafted state mint an
    // armed instant the suspended branch itself would reject (NaN) or
    // wedge the gate forever (+Infinity) — fail fast instead.
    if (
      typeof state.admissionFloorEpochMs !== 'number' ||
      (!Number.isFinite(state.admissionFloorEpochMs) &&
        state.admissionFloorEpochMs !== Number.NEGATIVE_INFINITY)
    ) {
      throw new TypeError(`${caller}: state must be an AuthSuspensionState`);
    }
    return;
  }
  if (
    typeof state.keyIdentity !== 'string' ||
    !Number.isFinite(state.suspendedAtEpochMs) ||
    !Number.isFinite(state.nextVerificationAtEpochMs)
  ) {
    throw new TypeError(`${caller}: state must be an AuthSuspensionState`);
  }
}

/** Structural validation of a classified cycle outcome. */
function requireClassifiedOutcome(classified: CycleOutcome, caller: string): void {
  if (
    typeof classified !== 'object' ||
    classified === null ||
    typeof classified.outcome !== 'string'
  ) {
    throw new TypeError(`${caller}: classified must be a CycleOutcome`);
  }
}

/* ── Internals ─────────────────────────────────────────────────────────── */

/**
 * Begins a suspension episode: the rejected cycle itself was an attempt,
 * so the first verification probe is armed one full window ahead. The
 * floor — the previous episode's last armed instant, or the current
 * episode's when a *different* key is rejected mid-suspension — never
 * lets the gate open earlier than any instant already armed.
 */
function enterSuspension(keyIdentity: string, nowEpochMs: number, floorEpochMs: number): Suspended {
  const armed = nowEpochMs + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS;
  return Object.freeze({
    suspended: true,
    keyIdentity,
    suspendedAtEpochMs: nowEpochMs,
    nextVerificationAtEpochMs: armed > floorEpochMs ? armed : floorEpochMs,
  });
}

/**
 * The monotone re-arm: the armed instant only ever moves later. A clock
 * reading so far regressed that `now + 60 min` lies before the armed
 * instant changes nothing — fail-safe in the no-rapid-retry direction.
 */
function rearm(state: Suspended, nowEpochMs: number): Suspended {
  const candidate = nowEpochMs + AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS;
  if (candidate <= state.nextVerificationAtEpochMs) return state;
  return Object.freeze({ ...state, nextVerificationAtEpochMs: candidate });
}

/**
 * Ends a suspension episode, carrying the armed instant forward as the
 * admission floor: whatever happens next, no automatic attempt may be
 * admitted before it.
 */
function release(state: Suspended): NotSuspended {
  return Object.freeze({
    suspended: false,
    admissionFloorEpochMs: state.nextVerificationAtEpochMs,
  });
}

/* ── Transitions ───────────────────────────────────────────────────────── */

/**
 * Reports a classified cycle outcome (task 105's {@link CycleOutcome}) to
 * the suspension machine, under the identity of the key the cycle ran
 * with:
 *
 * - `auth_error` from a not-suspended state **begins** an episode (entry
 *   arms the first probe 60 minutes ahead — the rejected cycle was this
 *   window's attempt);
 * - `auth_error` while suspended under the same key **re-arms** the
 *   timer to `now + 60 min` ("a failed verification keeps the suspension
 *   and re-arms the 60-minute timer"), never earlier (monotone);
 * - `auth_error` while suspended under a **different** key begins a
 *   fresh episode for that key — normally unreachable, because a key
 *   change releases through {@link applyKeyIdentity} first, but total:
 *   the fresh episode still cannot open the gate before the armed
 *   instant the old episode left;
 * - `success` while suspended **releases** (a probe or manual test proved
 *   the key works; polling resumes on the normal interval);
 * - every other outcome — including `rate_limited`, whose own §7.2
 *   machinery is task 107's, and `'cancelled'`, which is caller
 *   lifecycle, not a provider verdict — changes nothing: an
 *   inconclusive verification (network, timeout, 5xx, 429, parse) neither
 *   releases the suspension nor moves the timer, because it proves
 *   nothing about the key and the admission-anchored schedule already
 *   paces attempts at least 60 minutes apart.
 */
export function applyCycleOutcome(
  state: AuthSuspensionState,
  classified: CycleOutcome,
  keyIdentity: string,
  nowEpochMs: number,
): SuspensionTransition {
  requireState(state, 'applyCycleOutcome');
  requireClassifiedOutcome(classified, 'applyCycleOutcome');
  requireKeyIdentity(keyIdentity, 'applyCycleOutcome');
  requireFiniteNow(nowEpochMs, 'applyCycleOutcome');

  if (classified.outcome !== 'auth_error') {
    if (classified.outcome === 'success' && state.suspended) {
      return { state: release(state), changed: true, effect: 'released' };
    }
    return { state, changed: false };
  }
  if (!state.suspended) {
    return {
      state: enterSuspension(keyIdentity, nowEpochMs, state.admissionFloorEpochMs),
      changed: true,
      effect: 'suspended',
    };
  }
  if (state.keyIdentity === keyIdentity) {
    const rearmed = rearm(state, nowEpochMs);
    return rearmed === state
      ? { state, changed: false }
      : { state: rearmed, changed: true, effect: 'rearmed' };
  }
  return {
    state: enterSuspension(keyIdentity, nowEpochMs, state.nextVerificationAtEpochMs),
    changed: true,
    effect: 'suspended',
  };
}

/**
 * The key-change input event: the caller reports the identity of the key
 * currently configured (a config observation, a reload — its own task).
 * While suspended, an identity different from the episode's **releases**
 * the pause ("until the key changes"); the same identity, or a
 * not-suspended state, changes nothing. Idempotent by construction, so
 * the caller may report the current identity on every observation
 * without risking a missed or duplicated release.
 */
export function applyKeyIdentity(
  state: AuthSuspensionState,
  keyIdentity: string,
  nowEpochMs: number,
): SuspensionTransition {
  requireState(state, 'applyKeyIdentity');
  requireKeyIdentity(keyIdentity, 'applyKeyIdentity');
  requireFiniteNow(nowEpochMs, 'applyKeyIdentity');
  if (state.suspended && state.keyIdentity !== keyIdentity) {
    return { state: release(state), changed: true, effect: 'released' };
  }
  return { state, changed: false };
}

/**
 * The manual-test input event: the operator explicitly requested a test
 * ("until … a manual test is requested"). While suspended it **releases**
 * the pause — the manual attempt then runs immediately on the caller's
 * side, unconstrained by this machine, and its outcome arrives through
 * {@link applyCycleOutcome}: a 401/403 re-enters suspension with a fresh
 * 60-minute window, so even a scripted sequence of manual tests is one
 * operator-initiated attempt per request, never an automatic loop. On a
 * not-suspended state it is a no-op (a manual test of a healthy account
 * is just a cycle).
 */
export function applyManualTestRequest(
  state: AuthSuspensionState,
  nowEpochMs: number,
): SuspensionTransition {
  requireState(state, 'applyManualTestRequest');
  requireFiniteNow(nowEpochMs, 'applyManualTestRequest');
  if (state.suspended) {
    return { state: release(state), changed: true, effect: 'released' };
  }
  return { state, changed: false };
}

/* ── Admission ─────────────────────────────────────────────────────────── */

/**
 * Requests admission for one verification attempt — the mechanism that
 * paces every automatic attempt on a suspended account. Granted iff the
 * account is suspended and `now >= nextVerificationAtEpochMs` (the
 * boundary admits: exactly 60 minutes after the last arm is not too
 * early); a granted admission **re-arms the timer to `now + 60 min` at
 * admission time**, so two admissions are at least 60 minutes apart by
 * construction — even if the caller never reports the attempt's outcome,
 * the gate stays shut until the armed instant.
 *
 * The caller runs the admitted attempt immediately and feeds its
 * classified outcome back through {@link applyCycleOutcome} (a success
 * releases; an auth rejection re-arms further; anything else leaves the
 * armed schedule untouched).
 */
export function admitVerification(
  state: AuthSuspensionState,
  nowEpochMs: number,
): VerificationAdmission {
  requireState(state, 'admitVerification');
  requireFiniteNow(nowEpochMs, 'admitVerification');
  if (!state.suspended) {
    return { admitted: false, reason: 'not-suspended' };
  }
  if (nowEpochMs < state.nextVerificationAtEpochMs) {
    return {
      admitted: false,
      reason: 'too-early',
      nextVerificationAtEpochMs: state.nextVerificationAtEpochMs,
    };
  }
  return { admitted: true, state: rearm(state, nowEpochMs) };
}

/**
 * Whether a verification attempt is due right now — the scheduling
 * predicate ({@link admitVerification} is the granting transition). True
 * exactly when the state is suspended and the armed instant has passed;
 * mirrors the admission boundary inclusively.
 */
export function isVerificationDue(state: AuthSuspensionState, nowEpochMs: number): boolean {
  requireState(state, 'isVerificationDue');
  requireFiniteNow(nowEpochMs, 'isVerificationDue');
  return state.suspended && nowEpochMs >= state.nextVerificationAtEpochMs;
}
