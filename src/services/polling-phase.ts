/**
 * The polling dispatcher's explicit phase model (spec §7.1, §7.2; task FSM-1,
 * decision D-190 — the D-066 successor TZ-fsm §3 demanded).
 *
 * Before FSM-1 the "may this account be polled now?" decision was scattered
 * across three mutable fields of the scheduler's account entry (the monotonic
 * due, the D-062 `Retry-After` gate, the owed-manual-attempt flag) plus two
 * out-of-entry facts (live-flight membership, the sticky hang flag) plus the
 * D-064 suspension in the shared store — with a critical, type-unprotected
 * check order the history had already bitten twice (U-028's probe bypassing
 * the gate; P2-3's owed attempt overwritten by a settle). This module makes
 * the state machine explicit in two layers:
 *
 * - **{@link PollPlan}** — the *held* state, the one value an account entry
 *   stores between events. Its variants say what the dispatcher OWES the
 *   account next: the normal schedule (a monotonic due behind the wall-clock
 *   `Retry-After` gate), or one operator-requested attempt (which carries the
 *   dormant normal schedule beside the owed marker — exactly the fields the
 *   flag model kept, so every row of the transition table is a field-for-
 *   field mirror of the D-066 mutations it replaces). Transitions are pure
 *   functions over an explicit event union, {@link nextPlan} — time arrives
 *   as an argument on every reading (D-021), and the jittered delay is an
 *   argument too: the engine owns the `random` seam and draws a roll only
 *   when the consuming row will read it, preserving D-066's roll-consumption
 *   order bit for bit.
 *
 * - **{@link PollPhase}** — the *observed* phase, a transient per-pass
 *   projection the dispatcher switches over exhaustively. It folds in the
 *   two facts that must stay out of the held state: live-flight membership
 *   (with the sticky D-066 hang flag) and the D-064 suspension, which is
 *   **referenced, never copied** — the armed instant enters as the store's
 *   own value on the same dispatch pass and is gone again, so there is no
 *   second copy to drift (the FSM-3/D-189 single-holder guarantee; the pure
 *   machine in `polling-suspension.ts` stays the only suspension authority).
 *
 * The dispatcher (`polling-scheduler.ts`) builds a {@link PhaseView} per
 * account per scheduling pass, applies {@link pollPhaseOf}, and switches over
 * the result — adding a phase variant without handling it is a compile error
 * there (the `classifyTransportError` totality pattern). All ten parity
 * invariants of TZ-fsm §3.3 are structural here: the immediate first poll is
 * {@link initialPlan}; overlap is impossible because a live flight observes
 * as `in-flight`/`hung` and those never dispatch; the `Retry-After` gate
 * binds all three attempt kinds because every dispatchable shape derives
 * through the same `notBeforeEpochMs`; the owed attempt survives settles,
 * containment, and interval changes because those rows keep the owed variant;
 * and the probe is admitted only through the store's `admitVerification`
 * (D-189), never through phase data.
 */

import type { AuthSuspensionState } from './polling-suspension';
import { isSuspended, isVerificationDue } from './polling-suspension';

/* ── The held plan ─────────────────────────────────────────────────────── */

/** The plan variant owed a normal poll: the §7.1 schedule plus the D-062 gate. */
export interface ScheduledPlan {
  readonly kind: 'scheduled';
  /** When the next normal poll is due, on the monotonic clock (§7.1). */
  readonly nextPollMonotonicMs: number;
  /**
   * The D-062 `Retry-After` gate in epoch ms (`-Infinity` = open). Replaced
   * by every completed cycle's own decision; dispatch of ANY attempt kind —
   * normal, owed manual, verification probe — waits while it is shut
   * (§7.2's "do not poll before that time" is unconditional, U-028).
   */
  readonly notBeforeEpochMs: number;
}

/**
 * The plan variant owing one operator-requested attempt (§7.2's manual
 * test): due immediately behind the same D-062 gate, bypassing the D-064
 * suspension (the request itself releases the store). The dormant normal
 * schedule rides along untouched — the owed attempt survives an in-flight
 * cycle's settle (review P2-3), a contained failure, and an interval change,
 * and is consumed only by the dispatcher (`dispatched`).
 */
export interface ManualOwedPlan {
  readonly kind: 'manual-owed';
  /** The dormant schedule, kept exactly as the flag model kept it. */
  readonly nextPollMonotonicMs: number;
  /** The gate the owed attempt itself still respects (U-028). */
  readonly notBeforeEpochMs: number;
}

/** The held per-account state; the account entry stores exactly one plan. */
export type PollPlan = ScheduledPlan | ManualOwedPlan;

/* ── The transition events ─────────────────────────────────────────────── */

/**
 * One scheduler event that may move an account's plan. Every field is data
 * the engine already held or read at the site the event mirrors — the
 * re-anchor arguments (`nowMonotonicMs` with its delay/interval) are
 * supplied only when a consuming row will read them, so the engine takes
 * exactly the clock readings (and jitter rolls) the D-066 code took.
 */
export type PollPlanEvent =
  /** The D-064 store released the account through a `setAccounts` re-key. */
  | { readonly kind: 'key-released'; readonly nowMonotonicMs: number }
  /**
   * A cycle settled (non-stale): its classified outcome already fed the
   * suspension store; `suspended` is the post-outcome store read;
   * `notBeforeEpochMs` is the cycle's own D-062 decision (`-Infinity` when
   * not deferred). While `suspended` the plan keeps its due (the probe
   * cadence governs), so the re-anchor pair is absent; otherwise
   * `nowMonotonicMs` + `nextDelayMs` (the §7.1 interval + jitter draw) are
   * required — the consuming row fail-fasts if they are missing.
   */
  | {
      readonly kind: 'cycle-settled';
      readonly suspended: boolean;
      readonly notBeforeEpochMs: number;
      readonly nowMonotonicMs?: number;
      readonly nextDelayMs?: number;
    }
  /**
   * A contained failure (a throwing settle/wrapper seam, §7.2 isolation):
   * the account reschedules on the plain interval — no jitter draw, gate
   * untouched — unless owed (the attempt dispatches anyway) or suspended
   * (the D-064 armed instant governs); on those rows the plan stands and no
   * re-anchor data is supplied or read.
   */
  | {
      readonly kind: 'contained-failure';
      readonly suspended: boolean;
      readonly intervalMs: number;
      readonly nowMonotonicMs?: number;
    }
  /** An operator requested a manual test (§7.2's release-and-owe). */
  | { readonly kind: 'manual-test-requested' }
  /**
   * A manual connection test refused the key (§7.2, D-176/D-189): the
   * engine-side half drops the owed attempt; the D-064 re-entry is the
   * observation wrapper's own application to the shared store.
   */
  | { readonly kind: 'manual-test-rejected' }
  /**
   * The configured interval changed (§7.1): every not-suspended account is
   * re-anchored to `now + draw` (the pair is required unless `suspended` —
   * §7.2's fixed cadence keeps the schedule).
   */
  | {
      readonly kind: 'interval-changed';
      readonly suspended: boolean;
      readonly nowMonotonicMs?: number;
      readonly nextDelayMs?: number;
    }
  /**
   * The dispatcher started the account's cycle: the single consume site of
   * an owed attempt. The dormant schedule becomes live again unchanged —
   * the cycle's own settle (or containment fallback) rewrites it.
   */
  | { readonly kind: 'dispatched' };

/* ── Validation (fail-fast, the D-059/D-064 convention) ────────────────── */

function requireFiniteMs(value: number, caller: string, field: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${caller}: ${field} must be a finite number`);
  }
}

/**
 * The gate vocabulary: a finite epoch instant, or the open marker. `+Infinity`
 * would wedge the gate shut forever, so it fails fast (D-064's floor rule).
 */
function requireGateEpochMs(value: number, caller: string, field: string): void {
  if (!Number.isFinite(value) && value !== Number.NEGATIVE_INFINITY) {
    throw new TypeError(`${caller}: ${field} must be finite or -Infinity`);
  }
}

/** The monotonic anchor of a re-anchoring row: required and finite. */
function requireAnchorMs(value: number | undefined, caller: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new TypeError(`${caller}: nowMonotonicMs must be a finite number on re-anchoring rows`);
  }
  return value;
}

/** The delay argument of a schedule-building row: required and finite. */
function requireDelayMs(value: number | undefined, caller: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new TypeError(`${caller}: nextDelayMs must be a finite number unless suspended`);
  }
  return value;
}

/** Structural validation of a held plan value. */
function requirePlan(plan: PollPlan, caller: string): void {
  if (typeof plan !== 'object' || plan === null) {
    throw new TypeError(`${caller}: plan must be a PollPlan`);
  }
  if (plan.kind !== 'scheduled' && plan.kind !== 'manual-owed') {
    throw new TypeError(`${caller}: plan must be a PollPlan`);
  }
  requireFiniteMs(plan.nextPollMonotonicMs, caller, 'nextPollMonotonicMs');
  requireGateEpochMs(plan.notBeforeEpochMs, caller, 'notBeforeEpochMs');
}

/* ── Constructors ──────────────────────────────────────────────────────── */

/** Builds the `scheduled` variant (frozen, like every plan this module makes). */
function scheduled(nextPollMonotonicMs: number, notBeforeEpochMs: number): ScheduledPlan {
  return Object.freeze({ kind: 'scheduled', nextPollMonotonicMs, notBeforeEpochMs });
}

/** Builds the `manual-owed` variant over the dormant schedule. */
function manualOwed(nextPollMonotonicMs: number, notBeforeEpochMs: number): ManualOwedPlan {
  return Object.freeze({ kind: 'manual-owed', nextPollMonotonicMs, notBeforeEpochMs });
}

/* ── The transition table ──────────────────────────────────────────────── */

/**
 * §7.1's immediate first poll: a fresh account (startup, or added mid-run —
 * which mirrors a startup for that account, D-066) is due the moment it
 * enters the polled set, with the gate open.
 */
export function initialPlan(nowMonotonicMs: number): ScheduledPlan {
  requireFiniteMs(nowMonotonicMs, 'initialPlan', 'nowMonotonicMs');
  return scheduled(nowMonotonicMs, Number.NEGATIVE_INFINITY);
}

/**
 * The explicit "event × plan → plan" table (TZ-fsm §3.4 R4). Pure: it reads
 * nothing but its arguments and returns a fresh frozen plan; the dispatcher
 * only invokes it. Each row mirrors the D-066 field mutations exactly:
 *
 * | event | `scheduled` | `manual-owed` |
 * | --- | --- | --- |
 * | `key-released` | due := now (the stale schedule was paused mid-air) | due := now, still owed |
 * | `cycle-settled` (suspended) | due kept — the D-064 probe cadence governs; every release path re-anchors | same, still owed (the owed attempt survives the settle, P2-3) |
 * | `cycle-settled` (open) | due := now + draw, gate := the cycle's own | same schedule update, still owed |
 * | `contained-failure` (suspended) | unchanged (the armed instant governs) | unchanged (the attempt dispatches anyway) |
 * | `contained-failure` (open) | due := now + plain interval, gate kept | unchanged, still owed |
 * | `manual-test-requested` | becomes owed, schedule dormant | owed (idempotent) |
 * | `manual-test-rejected` | unchanged (nothing was owed) | becomes `scheduled`, schedule kept |
 * | `interval-changed` (suspended) | unchanged (§7.2's fixed cadence) | unchanged |
 * | `interval-changed` (open) | due := now + draw, gate kept | same schedule update, still owed |
 * | `dispatched` | unchanged | becomes `scheduled` over the dormant schedule — the single consume site |
 */
export function nextPlan(plan: PollPlan, event: PollPlanEvent): PollPlan {
  requirePlan(plan, 'nextPlan');
  switch (event.kind) {
    case 'key-released': {
      requireFiniteMs(event.nowMonotonicMs, 'nextPlan', 'nowMonotonicMs');
      // Normal polling resumes immediately (D-066's release re-anchor).
      return plan.kind === 'scheduled'
        ? scheduled(event.nowMonotonicMs, plan.notBeforeEpochMs)
        : manualOwed(event.nowMonotonicMs, plan.notBeforeEpochMs);
    }
    case 'cycle-settled': {
      requireGateEpochMs(event.notBeforeEpochMs, 'nextPlan', 'notBeforeEpochMs');
      const nextPollMonotonicMs = event.suspended
        ? // Suspended (either arm): the probe cadence owns the next attempt,
          // so the normal due stands unchanged — exactly D-066's
          // scheduleNextPoll skip (no clock data supplied or consumed on
          // this row), unobservable by construction because every release
          // path re-anchors before any normal poll could run.
          plan.nextPollMonotonicMs
        : requireAnchorMs(event.nowMonotonicMs, 'nextPlan') +
          requireDelayMs(event.nextDelayMs, 'nextPlan');
      return plan.kind === 'scheduled'
        ? scheduled(nextPollMonotonicMs, event.notBeforeEpochMs)
        : manualOwed(nextPollMonotonicMs, event.notBeforeEpochMs);
    }
    case 'contained-failure': {
      if (event.suspended || plan.kind === 'manual-owed') {
        // The armed instant governs / the owed attempt dispatches anyway —
        // the plan stands, and no re-anchor data is read.
        return plan;
      }
      if (
        !Number.isInteger(event.intervalMs) ||
        event.intervalMs <= 0 ||
        !Number.isFinite(event.intervalMs)
      ) {
        throw new TypeError('nextPlan: intervalMs must be a finite positive integer');
      }
      // The §7.2 isolation fallback: one plain interval out (no jitter — the
      // seam that just failed may be the random one), gate untouched.
      return scheduled(
        requireAnchorMs(event.nowMonotonicMs, 'nextPlan') + event.intervalMs,
        plan.notBeforeEpochMs,
      );
    }
    case 'manual-test-requested':
      // Owe one attempt; the schedule goes dormant exactly as it stands.
      return plan.kind === 'scheduled'
        ? manualOwed(plan.nextPollMonotonicMs, plan.notBeforeEpochMs)
        : plan;
    case 'manual-test-rejected':
      // The probe cadence owns the next attempt (the store just re-entered
      // suspension under the refused key, D-189); the dormant schedule —
      // kept, never invented — becomes live again.
      return plan.kind === 'manual-owed'
        ? scheduled(plan.nextPollMonotonicMs, plan.notBeforeEpochMs)
        : plan;
    case 'interval-changed': {
      if (event.suspended) {
        // §7.2's fixed 60-minute cadence: a shrunken interval must not pull
        // the probe schedule apart.
        return plan;
      }
      // Re-anchor from now: a shrunken interval never leaves a stale long
      // wait pending, and never fires earlier than one new interval.
      const nextPollMonotonicMs =
        requireAnchorMs(event.nowMonotonicMs, 'nextPlan') +
        requireDelayMs(event.nextDelayMs, 'nextPlan');
      return plan.kind === 'scheduled'
        ? scheduled(nextPollMonotonicMs, plan.notBeforeEpochMs)
        : manualOwed(nextPollMonotonicMs, plan.notBeforeEpochMs);
    }
    case 'dispatched':
      // The dispatcher consumed whatever the account was owed; the settle
      // (or the containment fallback) rewrites the schedule next.
      return plan.kind === 'manual-owed'
        ? scheduled(plan.nextPollMonotonicMs, plan.notBeforeEpochMs)
        : plan;
  }
}

/* ── The observed phase ────────────────────────────────────────────────── */

/** The account's live-flight presence, as the dispatch pass sees it. */
export type PhaseFlight = 'none' | 'flying' | 'hung';

/**
 * The dispatcher's phase vocabulary (TZ-fsm §3.4 R1): one discriminant per
 * decision shape the §7.1/§7.2 semantics produce. This union is the switch
 * domain of the dispatcher — a variant is only useful if the dispatcher
 * handles it, and totality is compile-checked.
 */
export type PollPhase =
  /** No entry: the account is not in the polled set (removed, disabled). */
  | { readonly kind: 'absent' }
  /** The account's own cycle is in flight, within the hang threshold. */
  | { readonly kind: 'in-flight' }
  /**
   * The account's own flight crossed the sticky hang threshold (D-066):
   * never dispatchable (the overlap prohibition holds), but it does not hold
   * the queue — others proceed around it.
   */
  | { readonly kind: 'hung' }
  /** The owed manual attempt is due now (gate open, queue free). */
  | { readonly kind: 'manual-owed' }
  /** The owed attempt is held behind the D-062 gate (unconditional, U-028). */
  | { readonly kind: 'manual-gated'; readonly untilEpochMs: number }
  /**
   * Suspended (D-064), the armed verification instant still ahead. The
   * instant is the store's own value, projected for this pass only — never
   * stored, never a second authority.
   */
  | { readonly kind: 'probe-waiting'; readonly untilEpochMs: number }
  /** Suspended, the armed instant passed, the gate open: admit and probe. */
  | { readonly kind: 'probe-due' }
  /** The probe is cadence-due but held behind the D-062 gate (U-028's order). */
  | { readonly kind: 'probe-gated'; readonly untilEpochMs: number }
  /**
   * The normal schedule is ahead: the monotonic due with the D-062 gate
   * folded in (`max(due, now + gate remainder)`), the not-suspended shape.
   */
  | { readonly kind: 'waiting'; readonly untilMonotonicMs: number }
  /** The normal poll is due now (not suspended, gate open, queue free). */
  | { readonly kind: 'due' };

/** The singletons of the field-less variants, frozen like every phase value. */
const ABSENT: PollPhase = Object.freeze({ kind: 'absent' });
const IN_FLIGHT: PollPhase = Object.freeze({ kind: 'in-flight' });
const HUNG: PollPhase = Object.freeze({ kind: 'hung' });
const MANUAL_OWED: PollPhase = Object.freeze({ kind: 'manual-owed' });
const PROBE_DUE: PollPhase = Object.freeze({ kind: 'probe-due' });
const DUE: PollPhase = Object.freeze({ kind: 'due' });

/** What {@link pollPhaseOf} observes one account through. */
export interface PhaseView {
  /** The held plan; `undefined` when the account has no entry (absent). */
  readonly plan: PollPlan | undefined;
  /** The account's live-flight presence (the sticky hang flag included). */
  readonly flight: PhaseFlight;
  /** The D-064 state from the shared store — referenced, never copied. */
  readonly suspension: AuthSuspensionState;
  /** The wall reading (gates, D-064 boundaries) — an argument, D-021. */
  readonly wallEpochMs: number;
  /** The monotonic reading (dues, §7.1) — an argument, D-021. */
  readonly monotonicMs: number;
}

/**
 * Whether the D-062 gate holds at this reading: §7.2's "do not poll before
 * that time" — the one hold every immediately-due dispatch shape shares (the
 * owed manual attempt and a due verification probe alike, U-028).
 */
function gateShut(notBeforeEpochMs: number, wallEpochMs: number): boolean {
  return notBeforeEpochMs !== Number.NEGATIVE_INFINITY && notBeforeEpochMs > wallEpochMs;
}

/**
 * The effective normal-poll due with the gate folded in — D-066's exact
 * arithmetic: the monotonic due, or when gated, the later of it and the
 * wall-gate remainder expressed on the monotonic clock.
 */
function effectiveDueMs(plan: ScheduledPlan, wallEpochMs: number, monotonicMs: number): number {
  if (plan.notBeforeEpochMs === Number.NEGATIVE_INFINITY) return plan.nextPollMonotonicMs;
  return Math.max(
    plan.nextPollMonotonicMs,
    monotonicMs + Math.max(0, plan.notBeforeEpochMs - wallEpochMs),
  );
}

/**
 * Derives the observed phase — pure over its view. The precedence is the
 * parity contract itself, and every level is structural:
 *
 * 1. no entry → `absent`;
 * 2. a live flight → `in-flight`/`hung` (the §7.1 overlap prohibition — no
 *    other fact is even consulted);
 * 3. an owed attempt → due now unless the D-062 gate shuts (U-028 binds the
 *    manual attempt; the dormant schedule and the suspension are irrelevant:
 *    the request already released the store);
 * 4. suspension (D-064, the store's live value) → the probe cadence, with
 *    the gate checked AFTER the cadence predicate (U-028's order: an
 *    admission consumed behind a shut gate would push the probe a full extra
 *    hour, and a deferral opening before the cadence must not add a wake);
 * 5. otherwise the normal schedule with the gate folded into the due.
 */
export function pollPhaseOf(view: PhaseView): PollPhase {
  requireFiniteMs(view.wallEpochMs, 'pollPhaseOf', 'wallEpochMs');
  requireFiniteMs(view.monotonicMs, 'pollPhaseOf', 'monotonicMs');
  if (view.flight !== 'none' && view.flight !== 'flying' && view.flight !== 'hung') {
    throw new TypeError('pollPhaseOf: flight must be one of none | flying | hung');
  }
  if (view.plan === undefined) return ABSENT;
  requirePlan(view.plan, 'pollPhaseOf');
  if (view.flight === 'hung') return HUNG;
  if (view.flight === 'flying') return IN_FLIGHT;
  if (view.plan.kind === 'manual-owed') {
    if (gateShut(view.plan.notBeforeEpochMs, view.wallEpochMs)) {
      return Object.freeze({ kind: 'manual-gated', untilEpochMs: view.plan.notBeforeEpochMs });
    }
    return MANUAL_OWED;
  }
  if (isSuspended(view.suspension)) {
    if (!isVerificationDue(view.suspension, view.wallEpochMs)) {
      return Object.freeze({
        kind: 'probe-waiting',
        untilEpochMs: view.suspension.nextVerificationAtEpochMs,
      });
    }
    if (gateShut(view.plan.notBeforeEpochMs, view.wallEpochMs)) {
      return Object.freeze({ kind: 'probe-gated', untilEpochMs: view.plan.notBeforeEpochMs });
    }
    return PROBE_DUE;
  }
  const dueMs = effectiveDueMs(view.plan, view.wallEpochMs, view.monotonicMs);
  if (dueMs <= view.monotonicMs) return DUE;
  return Object.freeze({ kind: 'waiting', untilMonotonicMs: dueMs });
}
