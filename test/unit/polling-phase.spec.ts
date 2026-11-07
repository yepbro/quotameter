import { describe, expect, it } from 'vitest';
import {
  initialPlan,
  nextPlan,
  pollPhaseOf,
  type PhaseView,
  type PollPlan,
} from '../../src/services/polling-phase';
import {
  INITIAL_SUSPENSION_STATE,
  type AuthSuspensionState,
} from '../../src/services/polling-suspension';

/**
 * Table-driven pins of the phase model's transition table and observed-phase
 * derivation (FSM-1, D-190): every "event × plan → plan" row is asserted
 * field for field against the D-066 mutations it mirrors, and the
 * derivation's boundaries (the D-062 gate and the D-064 armed instant, both
 * inclusive-admitting) are pinned at ±1 ms. The behavior-parity contract of
 * the golden suite covers the engine end to end; this spec pins the pure
 * module itself.
 */

const OPEN = Number.NEGATIVE_INFINITY;

/** A not-suspended store state (the reference machine's initial value). */
const FREE: AuthSuspensionState = INITIAL_SUSPENSION_STATE;

/** A suspended store state armed at the given epoch ms. */
const suspendedAt = (armedEpochMs: number): AuthSuspensionState =>
  Object.freeze({
    suspended: true,
    keyIdentity: 'key:a',
    suspendedAtEpochMs: armedEpochMs - 3_600_000,
    nextVerificationAtEpochMs: armedEpochMs,
  });

/** The derivation over a scheduled plan, defaults elided per case. */
function phaseOf(partial: Partial<PhaseView> & { plan: PhaseView['plan'] }) {
  return pollPhaseOf({
    flight: 'none',
    suspension: FREE,
    wallEpochMs: 10_000,
    monotonicMs: 20_000,
    ...partial,
  });
}

/* ── initialPlan: §7.1's immediate first poll ──────────────────────────── */

describe('initialPlan (§7.1)', () => {
  it('is due immediately with the gate open, and frozen', () => {
    const plan = initialPlan(1_234);
    expect(plan).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 1_234, notBeforeEpochMs: OPEN });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('rejects a non-finite anchor', () => {
    expect(() => initialPlan(Number.NaN)).toThrow(/nowMonotonicMs/u);
    expect(() => initialPlan(Number.POSITIVE_INFINITY)).toThrow(/nowMonotonicMs/u);
  });
});

/* ── nextPlan: the explicit event × plan table ─────────────────────────── */

describe('nextPlan: key-released', () => {
  it('re-anchors the schedule to now, gate kept, from both kinds', () => {
    const scheduled = nextPlan(
      { kind: 'scheduled', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 },
      { kind: 'key-released', nowMonotonicMs: 7_000 },
    );
    expect(scheduled).toEqual({
      kind: 'scheduled',
      nextPollMonotonicMs: 7_000,
      notBeforeEpochMs: 50_000,
    });
    const owed = nextPlan(
      { kind: 'manual-owed', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 },
      { kind: 'key-released', nowMonotonicMs: 7_000 },
    );
    expect(owed).toEqual({
      kind: 'manual-owed',
      nextPollMonotonicMs: 7_000,
      notBeforeEpochMs: 50_000,
    });
  });
});

describe('nextPlan: cycle-settled', () => {
  const scheduled: PollPlan = {
    kind: 'scheduled',
    nextPollMonotonicMs: 90_000,
    notBeforeEpochMs: OPEN,
  };

  it('schedules the next poll at now + the drawn delay on the open path', () => {
    expect(
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nowMonotonicMs: 20_000,
        nextDelayMs: 66_000,
      }),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 86_000, notBeforeEpochMs: OPEN });
  });

  it('replaces the gate with the cycle’s own 429 decision', () => {
    expect(
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: 500_000,
        nowMonotonicMs: 20_000,
        nextDelayMs: 66_000,
      }),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 86_000, notBeforeEpochMs: 500_000 });
  });

  it('keeps the stale due while suspended — the probe cadence governs (D-066 skip)', () => {
    // No re-anchor data is supplied at all: the suspended row consumes no
    // clock reading (the read-parity pin — the old scheduleNextPoll skipped
    // before its monotonicNow()).
    expect(
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: true,
        notBeforeEpochMs: OPEN,
      }),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 90_000, notBeforeEpochMs: OPEN });
  });

  it('keeps the owed attempt surviving the settle (P2-3), gate updated, schedule dormant', () => {
    const owed: PollPlan = {
      kind: 'manual-owed',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: OPEN,
    };
    expect(
      nextPlan(owed, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nowMonotonicMs: 20_000,
        nextDelayMs: 66_000,
      }),
    ).toEqual({ kind: 'manual-owed', nextPollMonotonicMs: 86_000, notBeforeEpochMs: OPEN });
    expect(
      nextPlan(owed, {
        kind: 'cycle-settled',
        suspended: true,
        notBeforeEpochMs: 500_000,
      }),
    ).toEqual({ kind: 'manual-owed', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 500_000 });
  });

  it('fails fast when the open path lacks the re-anchor pair', () => {
    expect(() =>
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nowMonotonicMs: 20_000,
      }),
    ).toThrow(/nextDelayMs/u);
    expect(() =>
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nextDelayMs: 66_000,
      }),
    ).toThrow(/nowMonotonicMs/u);
    expect(() =>
      nextPlan(scheduled, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nowMonotonicMs: Number.NaN,
        nextDelayMs: 66_000,
      }),
    ).toThrow(/nowMonotonicMs/u);
  });
});

describe('nextPlan: contained-failure (§7.2 isolation)', () => {
  it('falls back to the plain interval, gate untouched (no jitter)', () => {
    expect(
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 500_000, notBeforeEpochMs: 300_000 },
        { kind: 'contained-failure', suspended: false, nowMonotonicMs: 20_000, intervalMs: 60_000 },
      ),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 80_000, notBeforeEpochMs: 300_000 });
  });

  it('changes nothing while suspended (the armed instant governs) or owed — no clock data read', () => {
    const scheduled: PollPlan = {
      kind: 'scheduled',
      nextPollMonotonicMs: 500_000,
      notBeforeEpochMs: OPEN,
    };
    const owed: PollPlan = {
      kind: 'manual-owed',
      nextPollMonotonicMs: 500_000,
      notBeforeEpochMs: OPEN,
    };
    const suspendedResult = nextPlan(scheduled, {
      kind: 'contained-failure',
      suspended: true,
      intervalMs: 60_000,
    });
    const owedResult = nextPlan(owed, {
      kind: 'contained-failure',
      suspended: false,
      intervalMs: 60_000,
    });
    expect(suspendedResult).toBe(scheduled); // same reference: a no-op row
    expect(owedResult).toBe(owed);
  });

  it('rejects a malformed interval on the consuming row only', () => {
    for (const intervalMs of [0, -60_000, 60_000.5, Number.NaN]) {
      expect(() =>
        nextPlan(
          { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
          {
            kind: 'contained-failure',
            suspended: false,
            intervalMs,
            nowMonotonicMs: 0,
          },
        ),
      ).toThrow(/intervalMs/u);
    }
  });
});

describe('nextPlan: manual-test-requested / manual-test-rejected', () => {
  it('owes one attempt over the dormant schedule, idempotently', () => {
    expect(
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 },
        { kind: 'manual-test-requested' },
      ),
    ).toEqual({ kind: 'manual-owed', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 });
    const owed: PollPlan = {
      kind: 'manual-owed',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: 50_000,
    };
    expect(nextPlan(owed, { kind: 'manual-test-requested' })).toBe(owed);
  });

  it('drops the owed attempt at a rejection, schedule kept verbatim (D-176/D-189)', () => {
    const owed: PollPlan = {
      kind: 'manual-owed',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: 50_000,
    };
    expect(nextPlan(owed, { kind: 'manual-test-rejected' })).toEqual({
      kind: 'scheduled',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: 50_000,
    });
    const scheduled: PollPlan = {
      kind: 'scheduled',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: 50_000,
    };
    expect(nextPlan(scheduled, { kind: 'manual-test-rejected' })).toBe(scheduled);
  });
});

describe('nextPlan: interval-changed (§7.1 re-anchor)', () => {
  it('re-anchors every not-suspended plan, gate kept, both kinds', () => {
    expect(
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 500_000, notBeforeEpochMs: 300_000 },
        {
          kind: 'interval-changed',
          suspended: false,
          nowMonotonicMs: 20_000,
          nextDelayMs: 66_000,
        },
      ),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 86_000, notBeforeEpochMs: 300_000 });
    expect(
      nextPlan(
        { kind: 'manual-owed', nextPollMonotonicMs: 500_000, notBeforeEpochMs: OPEN },
        {
          kind: 'interval-changed',
          suspended: false,
          nowMonotonicMs: 20_000,
          nextDelayMs: 66_000,
        },
      ),
    ).toEqual({ kind: 'manual-owed', nextPollMonotonicMs: 86_000, notBeforeEpochMs: OPEN });
  });

  it('changes nothing while suspended — §7.2’s fixed cadence (no clock data read)', () => {
    const plan: PollPlan = {
      kind: 'scheduled',
      nextPollMonotonicMs: 500_000,
      notBeforeEpochMs: OPEN,
    };
    expect(nextPlan(plan, { kind: 'interval-changed', suspended: true })).toBe(plan);
  });

  it('fails fast when the re-anchoring path lacks the pair', () => {
    expect(() =>
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
        { kind: 'interval-changed', suspended: false, nowMonotonicMs: 20_000 },
      ),
    ).toThrow(/nextDelayMs/u);
    expect(() =>
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
        { kind: 'interval-changed', suspended: false, nextDelayMs: 66_000 },
      ),
    ).toThrow(/nowMonotonicMs/u);
  });
});

describe('nextPlan: dispatched (the single consume site)', () => {
  it('consumes the owed attempt over the dormant schedule', () => {
    expect(
      nextPlan(
        { kind: 'manual-owed', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 },
        { kind: 'dispatched' },
      ),
    ).toEqual({ kind: 'scheduled', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 50_000 });
  });

  it('leaves a scheduled plan untouched', () => {
    const plan: PollPlan = {
      kind: 'scheduled',
      nextPollMonotonicMs: 90_000,
      notBeforeEpochMs: OPEN,
    };
    expect(nextPlan(plan, { kind: 'dispatched' })).toBe(plan);
  });
});

describe('nextPlan: validation', () => {
  it('rejects malformed plans, times, and gates', () => {
    const plan: PollPlan = { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN };
    expect(() => nextPlan(null as never, { kind: 'dispatched' })).toThrow(/PollPlan/u);
    expect(() => nextPlan({ kind: 'other' } as never, { kind: 'dispatched' })).toThrow(/PollPlan/u);
    expect(() =>
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: Number.NaN, notBeforeEpochMs: OPEN },
        {
          kind: 'dispatched',
        },
      ),
    ).toThrow(/nextPollMonotonicMs/u);
    expect(() =>
      nextPlan(
        { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: Number.POSITIVE_INFINITY },
        { kind: 'dispatched' },
      ),
    ).toThrow(/notBeforeEpochMs/u);
    expect(() => nextPlan(plan, { kind: 'key-released', nowMonotonicMs: Number.NaN })).toThrow(
      /nowMonotonicMs/u,
    );
    expect(() =>
      nextPlan(plan, {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: Number.NaN,
        nowMonotonicMs: 0,
        nextDelayMs: 1,
      }),
    ).toThrow(/notBeforeEpochMs/u);
  });

  it('returns frozen plans from every constructing row', () => {
    const sources: PollPlan[] = [
      initialPlan(0),
      nextPlan(initialPlan(0), { kind: 'key-released', nowMonotonicMs: 1 }),
      nextPlan(initialPlan(0), {
        kind: 'cycle-settled',
        suspended: false,
        notBeforeEpochMs: OPEN,
        nowMonotonicMs: 1,
        nextDelayMs: 1,
      }),
      nextPlan(initialPlan(0), {
        kind: 'contained-failure',
        suspended: false,
        nowMonotonicMs: 1,
        intervalMs: 60_000,
      }),
      nextPlan(initialPlan(0), { kind: 'manual-test-requested' }),
      nextPlan(initialPlan(0), { kind: 'manual-test-requested' }).kind === 'manual-owed'
        ? nextPlan(
            { kind: 'manual-owed', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
            { kind: 'manual-test-rejected' },
          )
        : initialPlan(0),
      nextPlan(
        { kind: 'manual-owed', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
        { kind: 'dispatched' },
      ),
      nextPlan(initialPlan(0), {
        kind: 'interval-changed',
        suspended: false,
        nowMonotonicMs: 1,
        nextDelayMs: 1,
      }),
    ];
    for (const plan of sources) expect(Object.isFrozen(plan)).toBe(true);
  });
});

/* ── pollPhaseOf: the observed derivation and its boundaries ───────────── */

describe('pollPhaseOf: absence and flights', () => {
  it('derives absent for a missing plan', () => {
    expect(phaseOf({ plan: undefined }).kind).toBe('absent');
  });

  it('a live flight outranks every other fact — the overlap prohibition', () => {
    const plan = initialPlan(0); // due now, gate open
    expect(phaseOf({ plan, flight: 'flying' }).kind).toBe('in-flight');
    expect(phaseOf({ plan, flight: 'hung' }).kind).toBe('hung');
    expect(
      phaseOf({
        plan: { kind: 'manual-owed', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN },
        flight: 'flying',
      }).kind,
    ).toBe('in-flight');
    expect(phaseOf({ plan, flight: 'hung', suspension: suspendedAt(0) }).kind).toBe('hung'); // even a due probe behind a hung flight
  });
});

describe('pollPhaseOf: the owed attempt and the gate (U-028)', () => {
  const owed: PollPlan = { kind: 'manual-owed', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN };

  it('is due now with the gate open — the equality admits', () => {
    expect(phaseOf({ plan: owed }).kind).toBe('manual-owed');
    expect(
      phaseOf({ plan: { ...owed, notBeforeEpochMs: 10_000 } }).kind, // === wall
    ).toBe('manual-owed');
  });

  it('is held one millisecond before the gate opens', () => {
    const gated = phaseOf({ plan: { ...owed, notBeforeEpochMs: 10_001 } });
    expect(gated).toEqual({ kind: 'manual-gated', untilEpochMs: 10_001 });
  });
});

describe('pollPhaseOf: the suspension cadence and its gate (D-064, U-028)', () => {
  const plan: PollPlan = { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: OPEN };

  it('waits for the armed instant — the boundary admits inclusively', () => {
    expect(phaseOf({ plan, suspension: suspendedAt(10_001) })).toEqual({
      kind: 'probe-waiting',
      untilEpochMs: 10_001,
    });
    expect(phaseOf({ plan, suspension: suspendedAt(10_000) }).kind).toBe('probe-due');
  });

  it('holds a cadence-due probe behind a shut gate, admitting at equality', () => {
    const gated = phaseOf({
      plan: { ...plan, notBeforeEpochMs: 15_000 },
      suspension: suspendedAt(10_000),
    });
    expect(gated).toEqual({ kind: 'probe-gated', untilEpochMs: 15_000 });
    expect(
      phaseOf({
        plan: { ...plan, notBeforeEpochMs: 10_000 },
        suspension: suspendedAt(10_000),
      }).kind,
    ).toBe('probe-due');
  });
});

describe('pollPhaseOf: the normal schedule with the gate folded', () => {
  it('is due at or before the monotonic now, waiting otherwise', () => {
    expect(phaseOf({ plan: initialPlan(19_999) }).kind).toBe('due');
    expect(phaseOf({ plan: initialPlan(20_000) }).kind).toBe('due');
    expect(phaseOf({ plan: initialPlan(20_001) })).toEqual({
      kind: 'waiting',
      untilMonotonicMs: 20_001,
    });
  });

  it('folds the wall gate into the monotonic due — D-066’s arithmetic', () => {
    // Gate 5 000 ms ahead of the wall (10 000): the earliest monotonic due
    // is now (20 000) + 5 000 — later than the stale schedule's 0.
    expect(
      phaseOf({
        plan: { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: 15_000 },
      }),
    ).toEqual({ kind: 'waiting', untilMonotonicMs: 25_000 });
    // The schedule ahead of the gate remainder wins.
    expect(
      phaseOf({
        plan: { kind: 'scheduled', nextPollMonotonicMs: 90_000, notBeforeEpochMs: 15_000 },
      }),
    ).toEqual({ kind: 'waiting', untilMonotonicMs: 90_000 });
    // A gate in the past is open.
    expect(
      phaseOf({
        plan: { kind: 'scheduled', nextPollMonotonicMs: 0, notBeforeEpochMs: 9_999 },
      }).kind,
    ).toBe('due');
  });
});

describe('pollPhaseOf: validation', () => {
  it('rejects non-finite readings, a bad flight member, and malformed plans', () => {
    const plan = initialPlan(0);
    expect(() =>
      pollPhaseOf({
        plan,
        flight: 'none',
        suspension: FREE,
        wallEpochMs: Number.NaN,
        monotonicMs: 0,
      }),
    ).toThrow(/wallEpochMs/u);
    expect(() =>
      pollPhaseOf({
        plan,
        flight: 'none',
        suspension: FREE,
        wallEpochMs: 0,
        monotonicMs: Number.NaN,
      }),
    ).toThrow(/monotonicMs/u);
    expect(() =>
      pollPhaseOf({
        plan,
        flight: 'flapping' as never,
        suspension: FREE,
        wallEpochMs: 0,
        monotonicMs: 0,
      }),
    ).toThrow(/flight/u);
    expect(() =>
      pollPhaseOf({
        plan: { kind: 'nope' } as never,
        flight: 'none',
        suspension: FREE,
        wallEpochMs: 0,
        monotonicMs: 0,
      }),
    ).toThrow(/PollPlan/u);
  });
});
