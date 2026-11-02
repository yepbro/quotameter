import { describe, expect, it, vi } from 'vitest';
import {
  createLoginRateLimiter,
  LOGIN_RATE_LIMIT_BASE_DELAY_MS,
  LOGIN_RATE_LIMIT_MAX_DELAY_MS,
  LOGIN_RATE_LIMIT_MAX_FAILURES,
  LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES,
  LOGIN_RATE_LIMIT_WINDOW_MS,
} from '../../src/services/login-rate-limit';

/**
 * Task 156's suite (spec §15.2; decision D-125): the login rate-limit
 * primitive over a fake clock — the module takes `now` as an explicit
 * argument (D-021) and owns no timers (delays are returned as numbers;
 * the future login endpoint owns the sleep), so every §15.2 rule is a
 * deterministic table: the five-failure budget with undelayed attempts
 * 1–5, the increasing (doubling, capped) delays from the sixth attempt,
 * the sliding half-open 15-minute window incl. the ±1 ms edge, the
 * per-source isolation, the success reset, the bounded-memory retention
 * (pinned exact against the raw formula), the sweep drives, the D-021
 * fail-fast/regressed-clock discipline, and the zero-console pin — the
 * executable half of "the module holds no logger": §15.2's "log failed
 * attempts at `warn` without logging passwords" is the endpoint layer's
 * contract, and a module that cannot log cannot leak a credential
 * through one. There is no integration half: the primitive holds no
 * storage, sockets, or timers, so unit scope is the whole surface.
 */

/** A deterministic §11.1-style epoch-millisecond anchor. */
const T0 = 1_761_000_000_000;

/** One minute in epoch milliseconds — readable window-table deltas. */
const MINUTE_MS = 60_000;

/** Records `count` failed attempts for `source`, 1 ms apart from `from`. */
function recordFailures(
  limiter: ReturnType<typeof createLoginRateLimiter>,
  source: string,
  count: number,
  from: number,
): void {
  for (let index = 0; index < count; index += 1) {
    limiter.recordAttempt(source, 'failure', from + index);
  }
}

/** The §15.2 delay for `n` in-window failures — the raw, unbounded formula. */
function rawFormulaDelay(n: number): number {
  if (n < LOGIN_RATE_LIMIT_MAX_FAILURES) {
    return 0;
  }
  return Math.min(
    LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2 ** (n - LOGIN_RATE_LIMIT_MAX_FAILURES),
    LOGIN_RATE_LIMIT_MAX_DELAY_MS,
  );
}

describe('constants (the §15.2 budget)', () => {
  it('pins the spec numbers: five failures, fifteen minutes, one-second base', () => {
    expect(LOGIN_RATE_LIMIT_MAX_FAILURES).toBe(5);
    expect(LOGIN_RATE_LIMIT_WINDOW_MS).toBe(15 * MINUTE_MS);
    expect(LOGIN_RATE_LIMIT_BASE_DELAY_MS).toBe(1_000);
  });

  it('caps the delay at the window length and can actually grow to the cap', () => {
    expect(LOGIN_RATE_LIMIT_MAX_DELAY_MS).toBe(LOGIN_RATE_LIMIT_WINDOW_MS);
    // The formula must be able to reach the cap from the base by
    // doubling alone — otherwise the cap would be dead vocabulary.
    let reached = false;
    for (let n = LOGIN_RATE_LIMIT_MAX_FAILURES; n <= 64; n += 1) {
      reached = reached || rawFormulaDelay(n) === LOGIN_RATE_LIMIT_MAX_DELAY_MS;
    }
    expect(reached).toBe(true);
  });

  it('retains at least the formula’s saturation count — bounded memory is exact', () => {
    // The saturation count: the smallest failure count whose raw delay
    // equals the cap. Counts at or above it all answer the capped delay,
    // so retaining only that many newest timestamps cannot change any
    // answer — the retention bound must sit at or above it. The search
    // is bounded like the reachability test above: a future constant
    // change that makes the cap unreachable must fail this suite, not
    // hang the worker in an open loop.
    let saturation: number | undefined;
    for (let n = LOGIN_RATE_LIMIT_MAX_FAILURES; n <= 64; n += 1) {
      if (rawFormulaDelay(n) === LOGIN_RATE_LIMIT_MAX_DELAY_MS) {
        saturation = n;
        break;
      }
    }
    expect(saturation).toBeDefined();
    expect(LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES).toBeGreaterThanOrEqual(saturation!);
  });
});

describe('delayBeforeAttempt (the §15.2 delay query)', () => {
  it('is zero for a source with no failure history', () => {
    const limiter = createLoginRateLimiter();
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
  });

  it('keeps attempts 1–5 undelayed — the whole budget admits five failures', () => {
    const limiter = createLoginRateLimiter();
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT_MAX_FAILURES; attempt += 1) {
      const now = T0 + attempt * MINUTE_MS;
      expect(limiter.delayBeforeAttempt('192.0.2.10', now)).toBe(0);
      limiter.recordAttempt('192.0.2.10', 'failure', now);
    }
  });

  it('delays the sixth attempt by the base delay and doubles per further failure', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // The sixth attempt (five failures in window) waits one second;
    // every further recorded failure doubles the next wait — the
    // increasing-delays rule, pinned as the exact sequence up to the
    // point the cap takes over.
    for (let extraFailures = 0; extraFailures < 10; extraFailures += 1) {
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 10 * MINUTE_MS)).toBe(
        LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2 ** extraFailures,
      );
      limiter.recordAttempt('192.0.2.10', 'failure', T0 + 10 * MINUTE_MS);
    }
    // The fifteenth failure's raw delay (1024 s) passes the cap: every
    // count beyond it answers the window length, further failures
    // included (the retention bound makes the count saturate here too).
    for (let extra = 0; extra < 3; extra += 1) {
      limiter.recordAttempt('192.0.2.10', 'failure', T0 + 10 * MINUTE_MS);
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 10 * MINUTE_MS)).toBe(
        LOGIN_RATE_LIMIT_MAX_DELAY_MS,
      );
    }
  });

  it('answers identically to the raw formula for every count — retention is exact', () => {
    // A fresh limiter per count: with `n` in-window failures the answer
    // must be the unbounded formula's value for `n`, however far `n`
    // runs past the retention bound (the capped delay makes truncation
    // invisible) — the bounded-memory exactness pin.
    for (let n = 0; n <= 100; n += 1) {
      const limiter = createLoginRateLimiter();
      recordFailures(limiter, '192.0.2.10', n, T0);
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + n)).toBe(rawFormulaDelay(n));
    }
  });

  it('expires failures half-open at the window edge — ±1 ms is the boundary', () => {
    const limiter = createLoginRateLimiter();
    // Five failures at T0..T0+4 ms; at now = T0 + WINDOW − 1 all five
    // are in-window (the oldest is one ms newer than the cutoff), at
    // now = T0 + WINDOW the oldest sits exactly on the cutoff and is
    // out — four remain, the budget is unspent again.
    for (let index = 0; index < LOGIN_RATE_LIMIT_MAX_FAILURES; index += 1) {
      limiter.recordAttempt('192.0.2.10', 'failure', T0 + index);
    }
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + LOGIN_RATE_LIMIT_WINDOW_MS - 1)).toBe(
      LOGIN_RATE_LIMIT_BASE_DELAY_MS,
    );
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + LOGIN_RATE_LIMIT_WINDOW_MS)).toBe(0);
  });

  it('treats the source key as opaque — distinct keys are distinct budgets', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, 'A', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // Case-different and address-shape-different keys are simply
    // different keys: the module never parses the source.
    for (const other of ['a', '192.0.2.11', '2001:db8::1', '']) {
      expect(limiter.delayBeforeAttempt(other, T0)).toBe(0);
    }
    expect(limiter.delayBeforeAttempt('A', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
  });

  it('is observationally pure — repeated reads neither drift nor mutate', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    const expected = LOGIN_RATE_LIMIT_BASE_DELAY_MS;
    for (let index = 0; index < 5; index += 1) {
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 5 * MINUTE_MS)).toBe(expected);
    }
    // A read at a much later clock reading (everything expired) must
    // not disturb what the next record counts: at T0+5m the original
    // five failures are all still in-window, so the recorded failure
    // is the sixth — the doubled delay.
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 10 * LOGIN_RATE_LIMIT_WINDOW_MS)).toBe(0);
    limiter.recordAttempt('192.0.2.10', 'failure', T0 + 5 * MINUTE_MS);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 5 * MINUTE_MS)).toBe(
      LOGIN_RATE_LIMIT_BASE_DELAY_MS * 2,
    );
  });
});

describe('recordAttempt (the §15.2 counting and reset)', () => {
  it('counts only failures — successes never consume the budget', () => {
    const limiter = createLoginRateLimiter();
    for (let index = 0; index < 10; index += 1) {
      limiter.recordAttempt('192.0.2.10', 'success', T0 + index);
    }
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
  });

  it('resets the budget on a successful login — the guessing ended', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
    limiter.recordAttempt('192.0.2.10', 'success', T0);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
    // The history is empty, not softened: one new failure is failure
    // number one, and the budget is five again.
    limiter.recordAttempt('192.0.2.10', 'failure', T0);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES - 2, T0 + 1);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 2)).toBe(0);
  });

  it('resets a partially spent budget the same way', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', 3, T0);
    limiter.recordAttempt('192.0.2.10', 'success', T0);
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES - 1, T0 + 1);
    // Without the reset this would be the seventh failure (a 4 s
    // delay); with it, it is the fourth — still undelayed.
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 2)).toBe(0);
  });

  it('accepts a success for an unknown source as a no-op', () => {
    const limiter = createLoginRateLimiter();
    limiter.recordAttempt('192.0.2.10', 'success', T0);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
  });

  it('isolates budgets per source in both directions', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    recordFailures(limiter, '192.0.2.11', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // Each source sits at exactly its own five failures: the base
    // delay, not the doubled one the combined count would give.
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
    expect(limiter.delayBeforeAttempt('192.0.2.11', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
    // And one source's success reset leaves the other's budget spent.
    limiter.recordAttempt('192.0.2.10', 'success', T0);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
    expect(limiter.delayBeforeAttempt('192.0.2.11', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
  });

  it('prunes what the window expired when recording — the budget slides', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // Past the window edge (the 1 ms stamp spread included) the five
    // failures are all expired; the newly recorded failure starts a
    // fresh history of one and the next attempt is undelayed.
    const later = T0 + LOGIN_RATE_LIMIT_WINDOW_MS + 10;
    limiter.recordAttempt('192.0.2.10', 'failure', later);
    expect(limiter.delayBeforeAttempt('192.0.2.10', later)).toBe(0);
  });

  it('re-throttles a recovered source as new failures arrive', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // Age out entirely, then spend the budget again: the delay sequence
    // restarts from the base, not from wherever the old history was.
    const later = T0 + 2 * LOGIN_RATE_LIMIT_WINDOW_MS;
    expect(limiter.delayBeforeAttempt('192.0.2.10', later)).toBe(0);
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, later);
    expect(limiter.delayBeforeAttempt('192.0.2.10', later)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
  });

  it('slides partially: failures expire one by one inside the window', () => {
    const limiter = createLoginRateLimiter();
    // Five failures spread over fourteen minutes; at T0+15m the first
    // (recorded at T0) has left the window while the other four remain.
    const stamps = [0, 5, 10, 12, 14].map((minute) => T0 + minute * MINUTE_MS);
    for (const stamp of stamps) {
      limiter.recordAttempt('192.0.2.10', 'failure', stamp);
    }
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 14 * MINUTE_MS)).toBe(
      LOGIN_RATE_LIMIT_BASE_DELAY_MS,
    );
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 15 * MINUTE_MS)).toBe(0);
    // The four survivors are still live budget: one new failure spends
    // them again — five in-window failures, the base delay back.
    limiter.recordAttempt('192.0.2.10', 'failure', T0 + 15 * MINUTE_MS + 1);
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 + 15 * MINUTE_MS + 1)).toBe(
      LOGIN_RATE_LIMIT_BASE_DELAY_MS,
    );
  });
});

describe('clock discipline (D-021, D-090)', () => {
  it('fails fast on a non-integer now, before any state changes', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    for (const bad of [T0 + 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => limiter.delayBeforeAttempt('192.0.2.10', bad)).toThrowError(
        /login rate limiter timestamp 'now'/,
      );
      expect(() => limiter.recordAttempt('192.0.2.10', 'failure', bad)).toThrowError(
        /login rate limiter timestamp 'now'/,
      );
    }
    // The throwing calls changed nothing: the budget is still exactly
    // the five recorded failures.
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
  });

  it('trusts a regressed clock in the fail-closed direction', () => {
    const limiter = createLoginRateLimiter();
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
    // A wall reading behind the failures shrinks the cutoff, so the
    // counted window only widens — the throttle holds.
    expect(limiter.delayBeforeAttempt('192.0.2.10', T0 - LOGIN_RATE_LIMIT_WINDOW_MS)).toBe(
      LOGIN_RATE_LIMIT_BASE_DELAY_MS,
    );
  });
});

describe('memory bounds (the growth contract, D-125)', () => {
  it('sweeps fully-expired sources at most once per window, keeping live ones', () => {
    const limiter = createLoginRateLimiter();
    // Fifty spent budgets at T0 (the first record also runs the
    // construction-time sweep over an empty map).
    for (let index = 0; index < 50; index += 1) {
      recordFailures(limiter, `192.0.2.${index}`, LOGIN_RATE_LIMIT_MAX_FAILURES, T0);
      expect(limiter.delayBeforeAttempt(`192.0.2.${index}`, T0)).toBe(
        LOGIN_RATE_LIMIT_BASE_DELAY_MS,
      );
    }
    // A source whose failure is still in-window when the next sweep
    // fires — the keep side of the sweep (two minutes in, safely past
    // the sweep's one-minute-past-T0 cutoff).
    limiter.recordAttempt('192.0.2.98', 'failure', T0 + 2 * MINUTE_MS);
    // One window (plus the stamp spread) later, any record trips the
    // sweep: the fifty expired budgets drop, the live entry stays.
    const later = T0 + LOGIN_RATE_LIMIT_WINDOW_MS + MINUTE_MS;
    limiter.recordAttempt('192.0.2.99', 'failure', later);
    // The deletion side is observable through what the next records
    // count: a swept source restarts from an empty history (four more
    // failures = four), the kept one still carries its in-window
    // failure (four more = five, the budget spent again).
    recordFailures(limiter, '192.0.2.0', 4, later);
    expect(limiter.delayBeforeAttempt('192.0.2.0', later)).toBe(0);
    recordFailures(limiter, '192.0.2.98', 4, later);
    expect(limiter.delayBeforeAttempt('192.0.2.98', later)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS);
    // The unrelated new arrival counts from its own history.
    expect(limiter.delayBeforeAttempt('192.0.2.99', later)).toBe(0);
  });

  it('trims by stamp value — a regressed clock cannot skew the retained set', () => {
    // The exactness argument needs the retained stamps to be the
    // largest BY VALUE, not the latest inserted: after a regressed
    // record, an insertion-order trim would keep the small regressed
    // stamp and drop a live larger one. Fifteen high-stamp failures,
    // one regressed low-stamp failure (sixteen stamps — the trim must
    // drop the low one), then a cutoff that expires only the low stamp:
    // the bounded count equals the unbounded history's fifteen — the
    // capped delay — where an insertion-order trim would answer
    // fourteen (512 s). The review round's catch, pinned.
    const limiter = createLoginRateLimiter();
    const high = T0 + LOGIN_RATE_LIMIT_WINDOW_MS;
    recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_RETAINED_FAILURES, high);
    limiter.recordAttempt('192.0.2.10', 'failure', T0);
    const now = high + 10;
    expect(limiter.delayBeforeAttempt('192.0.2.10', now)).toBe(LOGIN_RATE_LIMIT_MAX_DELAY_MS);
  });
});

describe('logger discipline (§15.4/§16)', () => {
  it('writes nothing to the console across query, failure, and reset', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as keyof Console).mockImplementation(() => {}),
    );
    try {
      const limiter = createLoginRateLimiter();
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(0);
      recordFailures(limiter, '192.0.2.10', LOGIN_RATE_LIMIT_MAX_FAILURES + 2, T0);
      expect(limiter.delayBeforeAttempt('192.0.2.10', T0)).toBe(LOGIN_RATE_LIMIT_BASE_DELAY_MS * 4);
      limiter.recordAttempt('192.0.2.10', 'success', T0);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
