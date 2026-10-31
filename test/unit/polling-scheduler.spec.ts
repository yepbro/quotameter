import { describe, expect, it, vi } from 'vitest';
import {
  TransportAbortError,
  TransportConnectionError,
  TransportStatusError,
} from '../../src/providers/transport';
import type { Clock } from '../../src/util/clock';
import { AppConfigSchema } from '../../src/schemas/config';
import {
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import type { CycleRetryResult } from '../../src/services/polling-retry';
import {
  DEFAULT_CYCLE_HANG_THRESHOLD_MS,
  MAX_POLLING_INTERVAL_MS,
  MAX_WAKE_MS,
  MIN_POLLING_INTERVAL_MS,
  POLLING_JITTER_FRACTION,
  createPollingScheduler,
  pollingDelayMs,
  type PollingAccount,
  type PollingScheduler,
} from '../../src/services/polling-scheduler';
import { withFakeTimers } from '../helpers/isolation';

/**
 * Fake-timer and concurrency coverage of the §7.1 polling loop (task 109,
 * decision D-066): the immediate first poll, sequential dispatch with the
 * ≤10% jitter bounds, structural per-account non-overlap (including a
 * hanging closure), the §7.2 gates (Retry-After deferral, auth suspension
 * with hourly verification admissions, key-change and manual-test
 * releases), per-account failure isolation, mid-run account/interval
 * changes, and §5.6 stop-scheduling. The suites drive the module's own
 * default sleep and a clock whose readings both come from the faked
 * `Date.now()`; the account closures are fakes (no network, no storage).
 */

/* ── Harness ───────────────────────────────────────────────────────────── */

/** A settle script: turns a retried cycle into a classification. */
type SettleScript = (
  result: CycleRetryResult<unknown>,
  call: number,
) => CycleOutcome | Promise<CycleOutcome>;

/** An attempt script: returns a value or throws, per attempt number. */
type AttemptScript = (call: number, signal: AbortSignal) => Promise<unknown> | unknown;

/** The single-flight gate `holdNext` parks an attempt on. */
interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function makeGate(): Gate {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  readonly scheduler: PollingScheduler;
  /** `id` → attempt-start timestamps (the faked clock's ms). */
  readonly starts: Map<string, number[]>;
  /** Max in-flight attempts observed across all accounts (live reader). */
  readonly maxGlobalInFlight: () => number;
  /** Max in-flight attempts observed per account (the overlap bound). */
  readonly maxPerAccountInFlight: Map<string, number>;
  /** Builds a recorded account for initial and `setAccounts` use alike. */
  account: (id: string, keyIdentity?: string) => PollingAccount;
  attempts: (id: string) => number;
  settles: (id: string) => number;
  /** Scripts the settle seam per account (default: success). */
  script: (id: string, settle: SettleScript) => void;
  /** Scripts the raw attempt per account (default: an instant value). */
  onAttempt: (id: string, attempt: AttemptScript) => void;
  /** Parks the account's next started attempt until `release` (one at a time). */
  holdNext: (id: string) => void;
  /** Releases the held attempt with a value, or rejects it with an error. */
  release: (id: string, error?: Error) => void;
  /** Makes every attempt of the account hang until `unhang`. */
  hang: (id: string) => void;
  unhang: (id: string) => void;
}

interface HarnessOptions {
  readonly ids?: readonly string[];
  readonly intervalMs?: number;
  readonly random?: () => number;
  readonly cycleHangThresholdMs?: number;
  /** Overrides the clock (default: both readings from the faked Date.now()). */
  readonly clock?: Clock;
  readonly inFlight?: { begin(): { done(): void } };
}

/**
 * A clock whose two readings both come from the faked `Date.now()` — under
 * `withFakeTimers` both advance together with `advanceMsAsync`, which is
 * exactly the §10 assumption (a synchronized clock) the engine builds on.
 */
function timersClock(): Clock {
  return { now: () => Date.now(), monotonicMs: () => Date.now() };
}

function harness(options: HarnessOptions = {}): Harness {
  const ids = options.ids ?? [];
  const starts = new Map<string, number[]>(ids.map((id) => [id, []]));
  const settleCalls = new Map<string, number>(ids.map((id) => [id, 0]));
  const attemptCalls = new Map<string, number>(ids.map((id) => [id, 0]));
  const settleScripts = new Map<string, SettleScript>();
  const attemptScripts = new Map<string, AttemptScript>();
  const maxPerAccountInFlight = new Map<string, number>(ids.map((id) => [id, 0]));
  const perAccountInFlight = new Map<string, number>(ids.map((id) => [id, 0]));
  const pendingGates = new Map<string, Gate[]>();
  const activeGate = new Map<string, Gate>();
  const hanging = new Set<string>();
  const hungReleases = new Map<string, Array<() => void>>();
  let globalInFlight = 0;
  let maxGlobal = 0;

  /** A recorded account — the same closures for initial and replacement use. */
  function account(id: string, keyIdentity = `key:${id}`): PollingAccount {
    return {
      accountId: id,
      keyIdentity,
      attempt: async (signal) => {
        const call = (attemptCalls.get(id) ?? 0) + 1;
        attemptCalls.set(id, call);
        const timings = starts.get(id) ?? starts.set(id, []).get(id)!;
        timings.push(Date.now());
        globalInFlight++;
        maxGlobal = Math.max(maxGlobal, globalInFlight);
        const perAccount = (perAccountInFlight.get(id) ?? 0) + 1;
        perAccountInFlight.set(id, perAccount);
        maxPerAccountInFlight.set(id, Math.max(maxPerAccountInFlight.get(id) ?? 0, perAccount));
        try {
          const gate = pendingGates.get(id)?.shift();
          if (gate !== undefined) {
            activeGate.set(id, gate);
            await gate.promise;
          }
          if (hanging.has(id)) {
            return await new Promise<unknown>((resolve) => {
              hungReleases.set(id, [
                ...(hungReleases.get(id) ?? []),
                () => resolve({ providerId: id }),
              ]);
            });
          }
          const script = attemptScripts.get(id);
          if (script !== undefined) return await script(call, signal);
          return { providerId: id, signalAborted: signal.aborted };
        } finally {
          globalInFlight--;
          perAccountInFlight.set(id, (perAccountInFlight.get(id) ?? 1) - 1);
        }
      },
      settleCycle: async (result) => {
        const call = (settleCalls.get(id) ?? 0) + 1;
        settleCalls.set(id, call);
        const script = settleScripts.get(id);
        return script ? script(result, call) : classifySuccess();
      },
    };
  }

  const scheduler = createPollingScheduler({
    accounts: ids.map((id) => account(id)),
    intervalMs: options.intervalMs ?? 60_000,
    clock: options.clock ?? timersClock(),
    random: options.random ?? (() => 0),
    cycleHangThresholdMs: options.cycleHangThresholdMs,
    inFlight: options.inFlight,
  });

  return {
    scheduler,
    starts,
    maxGlobalInFlight: () => maxGlobal,
    maxPerAccountInFlight,
    account,
    attempts: (id) => attemptCalls.get(id) ?? 0,
    settles: (id) => settleCalls.get(id) ?? 0,
    script: (id, settle) => settleScripts.set(id, settle),
    onAttempt: (id, attempt) => attemptScripts.set(id, attempt),
    holdNext: (id) => pendingGates.set(id, [...(pendingGates.get(id) ?? []), makeGate()]),
    release: (id, error) => {
      const gate = activeGate.get(id);
      if (gate === undefined) return;
      activeGate.delete(id);
      if (error !== undefined) gate.reject(error);
      else gate.resolve();
    },
    hang: (id) => hanging.add(id),
    unhang: (id) => {
      hanging.delete(id);
      for (const release of hungReleases.get(id) ?? []) release();
      hungReleases.delete(id);
    },
  };
}

/** Classifications the scripts below reuse. */
const rejected = (): CycleOutcome =>
  classifyTransportError(new TransportStatusError(401, 'Unauthorized', undefined));
const rateLimited = (retryAfter: string): CycleOutcome =>
  classifyTransportError(new TransportStatusError(429, 'Too Many Requests', retryAfter));

/* ── The §7.1 interval contract and the jitter function ───────────────── */

describe('polling scheduler constants (spec §7.1)', () => {
  it('pins the interval bounds against the configuration contract', () => {
    expect(MIN_POLLING_INTERVAL_MS).toBe(60_000);
    expect(MAX_POLLING_INTERVAL_MS).toBe(3_600_000);
    expect(POLLING_JITTER_FRACTION).toBe(0.1);
    // The config schema validates the same range; this drift test keeps the
    // engine's re-validation from disagreeing with the loaded contract.
    const schema = AppConfigSchema.properties as unknown as Record<
      string,
      { minimum: number; maximum: number }
    >;
    expect(schema.pollingIntervalSeconds!.minimum * 1000).toBe(MIN_POLLING_INTERVAL_MS);
    expect(schema.pollingIntervalSeconds!.maximum * 1000).toBe(MAX_POLLING_INTERVAL_MS);
  });

  it('derives the default hang threshold from the §7.2 worst-case cycle', () => {
    expect(DEFAULT_CYCLE_HANG_THRESHOLD_MS).toBe(4 * 60_000 + 15_500);
  });

  it('pins the wake slice: one hour, below Node’s 1 ms clamp ceiling', () => {
    expect(MAX_WAKE_MS).toBe(3_600_000);
  });
});

describe('pollingDelayMs bounds', () => {
  it('returns the bare interval at a zero roll', () => {
    expect(pollingDelayMs(60_000, () => 0)).toBe(60_000);
    expect(pollingDelayMs(300_000, () => 0)).toBe(300_000);
    expect(pollingDelayMs(3_600_000, () => 0)).toBe(3_600_000);
  });

  it('adds exactly 10% at the top of the roll', () => {
    expect(pollingDelayMs(60_000, () => 0.999_999)).toBe(66_000);
    expect(pollingDelayMs(300_000, () => 0.999_999)).toBe(330_000);
  });

  it('adds the midpoint jitter at roll 0.5', () => {
    // floor(0.5 × 6001) = 3000 — the uniform-integer quantization.
    expect(pollingDelayMs(60_000, () => 0.5)).toBe(63_000);
  });

  it('rejects a non-positive-integer interval', () => {
    for (const intervalMs of [0, -60_000, 60_000.5, Number.NaN]) {
      expect(() => pollingDelayMs(intervalMs, () => 0)).toThrow(RangeError);
    }
  });

  it('rejects a roll outside [0, 1) instead of breaking the bound', () => {
    for (const roll of [1, 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pollingDelayMs(60_000, () => roll)).toThrow(/must return a finite number/u);
    }
  });
});

/* ── §7.1: immediate first poll, sequencing, jitter, monotonic schedule ── */

describe('first poll and sequential dispatch (spec §7.1)', () => {
  it('runs every account immediately at startup, in order, one at a time', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b', 'c'] });
        engine.scheduler.start();
        // The first dispatch is synchronous with start(); the rest follow
        // as each cycle settles (sequential, §7.1).
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.attempts('b')).toBe(1);
        expect(engine.attempts('c')).toBe(1);
        expect(engine.starts.get('a')![0]).toBe(0);
        expect(engine.starts.get('b')![0]).toBe(0);
        expect(engine.starts.get('c')![0]).toBe(0);
        // Accounts are non-concurrent in normal operation (D-066 pin).
        expect(engine.maxGlobalInFlight()).toBe(1);
        // Quiescent: exactly one pending wake — the next interval round.
        expect(vi.getTimerCount()).toBe(1);

        // Round two at exactly the configured interval (zero jitter).
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.attempts('b')).toBe(2);
        expect(engine.attempts('c')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(60_000);
        expect(engine.maxGlobalInFlight()).toBe(1);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('schedules the next poll at interval + jitter on the monotonic clock', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'], random: () => 0.999_999 });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        // Max jitter every round: gaps are exactly interval × 1.1.
        await clock.advanceMsAsync(65_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(65_999);
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(3);
        expect(engine.starts.get('a')).toEqual([0, 66_000, 132_000]);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('never leaves the [interval, interval × 1.1] window across varied rolls', async () => {
    await withFakeTimers(
      async (clock) => {
        const rolls = [0, 0.25, 0.5, 0.75, 0.999_999, 0.1, 0.33];
        let index = 0;
        const engine = harness({ ids: ['a'], random: () => rolls[index++ % rolls.length]! });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        for (let round = 1; round <= rolls.length; round++) {
          // One 66 001 ms window always covers exactly one next poll: the
          // minimum gap is the interval, the maximum interval × 1.1.
          await clock.advanceMsAsync(66_001);
          expect(engine.attempts('a')).toBe(round + 1);
          const gap = engine.starts.get('a')![round]! - engine.starts.get('a')![round - 1]!;
          expect(gap).toBeGreaterThanOrEqual(60_000);
          expect(gap).toBeLessThanOrEqual(66_000);
        }
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('anchors the next interval at cycle completion, after in-cycle retries', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        // The raw attempt fails twice with a retryable transport error, so
        // D-059's wrapper spends 2 s + 4 s backing off before success; the
        // §7.1 interval must anchor at the completed cycle, not its start.
        engine.onAttempt('a', (call) => {
          if (call <= 2) throw new TransportConnectionError('ECONNREFUSED');
          return { providerId: 'a' };
        });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(2_000 - 1);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1); // first retry at +2 s (zero jitter)
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(4_000);
        expect(engine.attempts('a')).toBe(3); // second retry at +6 s
        // Cycle settles at t = 6 000 → next poll at 66 000.
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(3);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(4);
        expect(engine.starts.get('a')![3]).toBe(66_000);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── §7.1/§17.1: no per-account overlap, the hanging closure ───────────── */

describe('no per-account overlap (spec §7.1, §17.1)', () => {
  it('holds the queue strictly sequential below the hang threshold, then skips the hung account', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b'], cycleHangThresholdMs: 5_000 });
        engine.hang('a');
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1); // hanging
        expect(engine.attempts('b')).toBe(0); // strict sequential: the queue waits
        await clock.advanceMsAsync(4_999);
        expect(engine.attempts('b')).toBe(0); // one millisecond short
        await clock.advanceMsAsync(1); // t = 5 000: the threshold passes
        expect(engine.attempts('b')).toBe(1);
        // The hung account is never re-dispatched (overlap impossible)…
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('b')).toBe(2);
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('b')).toBe(3);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.maxPerAccountInFlight.get('a')).toBe(1);
        expect(engine.maxPerAccountInFlight.get('b')).toBe(1);
        // …while other accounts proceed around it: global in-flight ≤ 2,
        // and only because one flight is declared hung (D-066).
        expect(engine.maxGlobalInFlight()).toBe(2);

        // When the hung cycle finally settles, the account resumes on the
        // plain schedule and the strict sequence returns.
        engine.unhang('a');
        await clock.advanceMsAsync(0);
        expect(engine.settles('a')).toBe(1);
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1); // settled at t = 125 000 → due 185 000
        expect(engine.attempts('a')).toBe(2);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('proves per-account overlap impossible even when the interval elapses many times', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b'], cycleHangThresholdMs: 5_000 });
        engine.hang('a');
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        for (let round = 0; round < 6; round++) {
          await clock.advanceMsAsync(60_000);
        }
        // b polled every interval throughout (b#1 was held to t = 5 000 by
        // the strict-sequential phase, so its dues run :05 past each round);
        // a attempted exactly once, forever the only flight it has.
        expect(engine.attempts('a')).toBe(1);
        expect(engine.maxPerAccountInFlight.get('a')).toBe(1);
        expect(engine.attempts('b')).toBe(6);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── §7.2: the Retry-After gate (D-062) ────────────────────────────────── */

describe('Retry-After deferral gating (spec §7.2)', () => {
  it('defers the next poll to notBeforeEpochMs when it exceeds the interval', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) => (call === 1 ? rateLimited('90') : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(89_999);
        expect(engine.attempts('a')).toBe(1); // gated: not before 90 s
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(90_000);
        // A non-deferred follow-up falls back to the plain interval.
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(3);
        expect(engine.starts.get('a')![2]).toBe(150_000);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('caps an excessive Retry-After at one hour', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) =>
          call === 1 ? rateLimited('7200') : classifySuccess(),
        );
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(3_600_000 - 1);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(3_600_000);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('keeps the plain interval for absent, malformed, and ineligible headers', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b', 'c'] });
        engine.script('a', (_result, call) =>
          call === 1 ? rateLimited('soon') : classifySuccess(),
        );
        engine.script('b', (_result, call) =>
          call === 1
            ? // A 503 carrying a Retry-After: retried in-cycle by D-059,
              // ineligible for deferral by D-062.
              classifyTransportError(new TransportStatusError(503, 'Service Unavailable', '999'))
            : classifySuccess(),
        );
        engine.script('c', (_result, call) => (call === 1 ? rateLimited('30') : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        // 'soon' is malformed → no deferral; 503 → ineligible; 30 s < the
        // 60 s interval → the interval governs all three.
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.attempts('b')).toBe(1);
        expect(engine.attempts('c')).toBe(1);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.attempts('b')).toBe(2);
        expect(engine.attempts('c')).toBe(2);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('holds even a manual test behind an active deferral', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) => (call === 1 ? rateLimited('90') : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        engine.scheduler.requestManualTest('a');
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1); // "do not poll before that time"
        await clock.advanceMsAsync(90_000);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(90_000);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── §7.2: auth suspension and the hourly verification cadence (D-064) ─── */

describe('auth-rejection suspension gating (spec §7.2)', () => {
  it('pauses normal polling and admits exactly one probe per 60 minutes', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) =>
          call === 1 || call === 2 // the entering 401 and the failed probe
            ? rejected()
            : classifySuccess(),
        );
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        // Normal interval rounds pass without a single attempt.
        await clock.advanceMsAsync(3_599_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1); // t = 3 600 000: the probe is due
        expect(engine.attempts('a')).toBe(2);
        // The failed probe re-arms: the next is a full window out.
        await clock.advanceMsAsync(3_599_999);
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(1); // t = 7 200 000
        expect(engine.attempts('a')).toBe(3);
        // The successful probe releases; the next normal poll is a full
        // interval out (the probe just collected, D-066).
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(3);
        await clock.advanceMsAsync(1); // t = 7 260 000
        expect(engine.attempts('a')).toBe(4);
        expect(engine.starts.get('a')![3]).toBe(7_260_000);
        // Normal cadence resumed.
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(5);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('releases on a key change reported through setAccounts and polls immediately', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) => (call === 1 ? rejected() : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1); // suspended at t = 0
        // The account set is rebuilt with a replaced key at t = 120 000.
        await clock.advanceMsAsync(120_000);
        engine.scheduler.setAccounts([engine.account('a', 'key:generation-2')]);
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(120_000);
        // Released: the normal interval resumed from the release poll.
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(3);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('runs a manual test immediately, on suspended and healthy accounts alike', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) => (call === 1 ? rejected() : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(120_000);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.scheduler.requestManualTest('a')).toBe(true);
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(2); // the manual attempt, now
        expect(engine.starts.get('a')![1]).toBe(120_000);
        // Its success released the account; normal cadence follows.
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(3);
        // On a healthy account a manual test is just a cycle, run now.
        await clock.advanceMsAsync(20_000); // t = 200 000
        engine.scheduler.requestManualTest('a');
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(4);
        expect(engine.starts.get('a')![3]).toBe(200_000);
        expect(engine.scheduler.requestManualTest('nobody')).toBe(false);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('keeps the probe cadence across a runtime interval change', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'], intervalMs: 300_000 });
        engine.script('a', (_result, call) => (call === 1 ? rejected() : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        engine.scheduler.setIntervalMs(60_000); // §7.2 fixes the probe window
        await clock.advanceMsAsync(3_599_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1);
        expect(engine.attempts('a')).toBe(2); // probe at exactly 60 min
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── §7.2: one account's failure never stops the others ────────────────── */

describe('failure isolation (spec §7.2)', () => {
  it('contains a throwing settle seam and keeps every account polling', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b'] });
        engine.script('a', () => {
          throw new Error('persist seam broke');
        });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.attempts('b')).toBe(1);
        // The broken account fell back to the plain interval and cycles on.
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.attempts('b')).toBe(2);
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(3);
        expect(engine.attempts('b')).toBe(3);
        expect(engine.scheduler.running).toBe(true);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('settles non-transport attempt failures through the seam without stopping', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b'] });
        engine.onAttempt('a', () => {
          throw new Error('adapter parse failure');
        });
        let sawError = false;
        engine.script('a', (result) => {
          sawError = !result.ok;
          return classifySuccess();
        });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        // The wrapper reported the non-transport failure un-retried
        // (D-059) and the seam classified it — the engine kept serving b.
        expect(sawError).toBe(true);
        expect(engine.settles('a')).toBe(1);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.attempts('b')).toBe(1);
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.attempts('b')).toBe(2);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── Mid-run changes and the empty set ─────────────────────────────────── */

describe('account-set and interval changes at runtime', () => {
  it('idles cleanly with an empty account set', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: [] });
        engine.scheduler.start();
        await clock.advanceMsAsync(1_000);
        expect(vi.getTimerCount()).toBe(0); // nothing to wake for
        await engine.scheduler.stop();
        expect(engine.scheduler.running).toBe(false);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('polls a newly added account immediately and keeps the existing schedule', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(5_000);
        engine.scheduler.setAccounts([engine.account('a'), engine.account('b')]);
        await clock.advanceMsAsync(0);
        expect(engine.attempts('b')).toBe(1); // added mid-run: first poll now
        expect(engine.starts.get('b')![0]).toBe(5_000);
        expect(engine.attempts('a')).toBe(1); // kept its 60 s schedule
        await clock.advanceMsAsync(55_000); // t = 60 000: a's own schedule
        expect(engine.attempts('a')).toBe(2);
        expect(engine.attempts('b')).toBe(1); // b's next due is 60 s after 5 000
        await clock.advanceMsAsync(5_000); // t = 65 000
        expect(engine.attempts('b')).toBe(2);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('discards the outcome of a cycle whose account was removed mid-flight', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a', 'b'] });
        engine.script('b', (_result, call) => (call === 1 ? rejected() : classifySuccess()));
        engine.holdNext('b'); // b's first cycle parks mid-flight
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('b')).toBe(1);
        await clock.advanceMsAsync(500);
        // Remove b while its cycle is in flight, then let the cycle finish
        // with a 401 classification.
        engine.scheduler.setAccounts([engine.account('a')]);
        engine.release('b');
        await clock.advanceMsAsync(0);
        expect(engine.settles('b')).toBe(1); // the seam still ran (110's)
        // Re-adding b starts fresh: the discarded suspension must not gate
        // its first poll (the state it would update was dropped, D-066).
        await clock.advanceMsAsync(1_000);
        engine.scheduler.setAccounts([engine.account('a'), engine.account('b')]);
        await clock.advanceMsAsync(0);
        expect(engine.attempts('b')).toBe(2);
        expect(engine.starts.get('b')![1]).toBe(1_500);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('re-anchors every account when the interval changes at runtime', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'], intervalMs: 300_000 });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(10_000);
        engine.scheduler.setIntervalMs(60_000);
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(1);
        await clock.advanceMsAsync(1); // t = 70 000, not 300 000
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(70_000);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('rejects duplicate account ids and malformed entries', () => {
    const engine = harness({ ids: ['a'] });
    engine.scheduler.start();
    const account = engine.account('a');
    expect(() => engine.scheduler.setAccounts([account, { ...account }])).toThrow(/duplicate/u);
    expect(() => engine.scheduler.setAccounts([{ ...account, accountId: ' ' }])).toThrow(
      /accountId/u,
    );
    expect(() => engine.scheduler.setAccounts([{ ...account, attempt: 5 as never }])).toThrow(
      /attempt/u,
    );
    expect(() =>
      engine.scheduler.setAccounts([{ ...account, settleCycle: null as never }]),
    ).toThrow(/settleCycle/u);
    expect(() => engine.scheduler.setAccounts([{ ...account, keyIdentity: '' }])).toThrow(
      /keyIdentity/u,
    );
  });
});

/* ── §5.6: stop scheduling ─────────────────────────────────────────────── */

describe('stop (spec §5.6, D-020)', () => {
  it('aborts an in-flight cycle, resolves promptly, and schedules nothing after', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.holdNext('a');
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1); // held mid-flight
        await engine.scheduler.stop();
        expect(vi.getTimerCount()).toBe(0); // the wake was cleared
        expect(engine.scheduler.running).toBe(false);
        // Let the aborted cycle settle the way a cooperating transport does.
        engine.release('a', new TransportAbortError());
        await clock.advanceMsAsync(0);
        expect(engine.settles('a')).toBe(1); // 110's seam still recorded it
        await clock.advanceMsAsync(600_000);
        expect(engine.attempts('a')).toBe(1); // nothing new is scheduled
        // Idempotent: the second stop resolves too.
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('resolves stop before start and rejects lifecycle misuse', async () => {
    await withFakeTimers(async () => {
      const engine = harness({ ids: ['a'] });
      await engine.scheduler.stop(); // never started: still clean
      expect(() => engine.scheduler.start()).toThrow(/stopped/u);
      const running = harness({ ids: ['a'] });
      running.scheduler.start();
      expect(() => running.scheduler.start()).toThrow(/already started/u);
      await running.scheduler.stop();
      expect(() => running.scheduler.setIntervalMs(60_000)).toThrow(/stopped/u);
      expect(() => running.scheduler.setAccounts([])).toThrow(/stopped/u);
      expect(() => running.scheduler.requestManualTest('a')).toThrow(/stopped/u);
    });
  });

  it('tracks cycles in the injected in-flight tracker (D-020)', async () => {
    await withFakeTimers(
      async (clock) => {
        let active = 0;
        let max = 0;
        let total = 0;
        const inFlight = {
          begin() {
            total++;
            active++;
            max = Math.max(max, active);
            return {
              done() {
                active--;
              },
            };
          },
        };
        const engine = harness({ ids: ['a', 'b'], inFlight });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(total).toBe(2);
        expect(max).toBe(1); // sequential: one cycle in flight at a time
        expect(active).toBe(0);
        await clock.advanceMsAsync(60_000);
        expect(total).toBe(4);
        expect(active).toBe(0);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── Review-round regression pins (D-066) ──────────────────────────────── */

describe('review-round regression pins', () => {
  it('discards a stale outcome when the key changed mid-flight (P1-1)', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.script('a', (_result, call) => (call === 1 ? rejected() : classifySuccess()));
        engine.holdNext('a'); // a's first cycle parks mid-flight
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        // The operator replaces the rejected key while the old key's probe
        // is still in flight.
        await clock.advanceMsAsync(500);
        engine.scheduler.setAccounts([engine.account('a', 'key:generation-2')]);
        engine.release('a'); // the old key's cycle answers 401
        await clock.advanceMsAsync(0);
        // The stale run was still recorded by 110's seam (settle #1), and
        // the new key's immediately-dispatched cycle has settled too (#2).
        expect(engine.settles('a')).toBe(2);
        // The stale 401 must not suspend the new key: the engine treats the
        // outcome as discarded, and the new key gets tried immediately.
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(500);
        // And it is not suspended — the normal interval follows (anchored
        // at the new key's first cycle, t = 500 + 60 000).
        await clock.advanceMsAsync(59_999);
        expect(engine.attempts('a')).toBe(2);
        await clock.advanceMsAsync(1_001);
        expect(engine.attempts('a')).toBe(3);
        expect(engine.starts.get('a')![2]).toBe(60_500);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('runs a requested manual test as soon as the in-flight cycle settles (P2-3)', async () => {
    await withFakeTimers(
      async (clock) => {
        const engine = harness({ ids: ['a'] });
        engine.holdNext('a'); // a's cycle parks mid-flight
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        expect(engine.scheduler.requestManualTest('a')).toBe(true);
        engine.release('a'); // the in-flight cycle succeeds and reschedules
        await clock.advanceMsAsync(0);
        // The owed attempt is not overwritten by the settle rescheduling:
        // it dispatches immediately, one cycle at a time (§7.1).
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(0);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('reports running=false and re-surfaces the error when the loop dies (P2-2)', async () => {
    await withFakeTimers(
      async (clock) => {
        let monotonicHealthy = true;
        const clockSeam: Clock = {
          now: () => Date.now(),
          monotonicMs: () => (monotonicHealthy ? Date.now() : Number.NaN),
        };
        const engine = harness({ ids: ['a'], clock: clockSeam });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.scheduler.running).toBe(true);
        // Break the clock's monotonic reading; the next scheduling pass
        // dies — visibly, not silently.
        monotonicHealthy = false;
        engine.scheduler.requestManualTest('a');
        await clock.advanceMsAsync(0);
        expect(engine.scheduler.running).toBe(false);
        await expect(engine.scheduler.stop()).rejects.toThrow(/monotonicMs/u);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('survives a large wall-clock regression during a deferral, resuming at the gate (P2-1)', async () => {
    await withFakeTimers(
      async (clock) => {
        // Wall and monotonic readings diverge: the test drags the wall 40
        // days backwards mid-deferral — the shape of an RTC reset or a VM
        // snapshot restore (D-021 assumes it away in production, the
        // scheduler still must not spin or duplicate).
        let wallOffset = 0;
        const clockSeam: Clock = {
          now: () => Date.now() + wallOffset,
          monotonicMs: () => Date.now(),
        };
        const engine = harness({ ids: ['a'], clock: clockSeam });
        engine.script('a', (_result, call) => (call === 1 ? rateLimited('90') : classifySuccess()));
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1); // deferred to wall-time 90 000
        await clock.advanceMsAsync(1_000);
        wallOffset = -40 * 24 * 3_600_000;
        // The gate wait is now weeks long: sliced (never a 1 ms spin), one
        // pending wake at a time, and the account stays gated.
        await clock.advanceMsAsync(500_000);
        expect(engine.attempts('a')).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        // The wall reading recovers as the (faked) clock advances; the
        // poll resumes exactly when the gate opens — and the advance stops
        // there, so exactly one deferred poll has run.
        const wallRecoveryMs = 40 * 24 * 3_600_000;
        await clock.advanceMsAsync(90_000 + wallRecoveryMs - 501_000);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.starts.get('a')![1]).toBe(90_000 + wallRecoveryMs);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it('fails loudly on a sleep seam that rejects with a non-abort error (P3-2)', async () => {
    await withFakeTimers(
      async (clock) => {
        const account: PollingAccount = {
          accountId: 'b',
          keyIdentity: 'key:b',
          attempt: async () => ({ providerId: 'b' }),
          settleCycle: async () => classifySuccess(),
        };
        const broken = createPollingScheduler({
          accounts: [account],
          intervalMs: 60_000,
          clock: timersClock(),
          random: () => 0,
          sleep: () => Promise.reject(new Error('broken sleep seam')),
        });
        broken.start();
        await clock.advanceMsAsync(0);
        // b's immediate first poll runs (no wait yet); the next scheduling
        // pass needs a wake — the broken seam kills the loop, visibly.
        expect(broken.running).toBe(false);
        await expect(broken.stop()).rejects.toThrow(/broken sleep seam/u);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });

  it("keeps scheduling when the in-flight tracker's done() throws (P3-1)", async () => {
    await withFakeTimers(
      async (clock) => {
        const inFlight = {
          begin() {
            return {
              done() {
                throw new Error('tracker done() broke');
              },
            };
          },
        };
        const engine = harness({ ids: ['a'], inFlight });
        engine.scheduler.start();
        await clock.advanceMsAsync(0);
        expect(engine.attempts('a')).toBe(1);
        // The flight's cleanup runs before the tracker call, so the
        // account is not bricked and polling continues.
        await clock.advanceMsAsync(60_000);
        expect(engine.attempts('a')).toBe(2);
        expect(engine.scheduler.running).toBe(true);
        await engine.scheduler.stop();
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

/* ── Constructor validation ────────────────────────────────────────────── */

describe('createPollingScheduler validation', () => {
  const clock: Clock = { now: () => 0, monotonicMs: () => 0 };

  it('rejects an interval outside §7.1', () => {
    for (const intervalMs of [59_999, 3_600_001, 300_000.5, 0, -1]) {
      expect(() => createPollingScheduler({ intervalMs, clock })).toThrow(RangeError);
    }
  });

  it('accepts the §7.1 boundaries', () => {
    expect(() => createPollingScheduler({ intervalMs: 60_000, clock })).not.toThrow();
    expect(() => createPollingScheduler({ intervalMs: 3_600_000, clock })).not.toThrow();
  });

  it('rejects broken seams and options', () => {
    expect(() => createPollingScheduler({ intervalMs: 60_000, clock: {} as Clock })).toThrow(
      /clock/u,
    );
    expect(() => createPollingScheduler({ intervalMs: 60_000, clock, random: 5 as never })).toThrow(
      /random/u,
    );
    expect(() =>
      createPollingScheduler({ intervalMs: 60_000, clock, sleep: 'x' as never }),
    ).toThrow(/sleep/u);
    expect(() =>
      createPollingScheduler({ intervalMs: 60_000, clock, cycleHangThresholdMs: 0 }),
    ).toThrow(/cycleHangThresholdMs/u);
    expect(() =>
      createPollingScheduler({ intervalMs: 60_000, clock, inFlight: {} as never }),
    ).toThrow(/inFlight/u);
    expect(() =>
      createPollingScheduler({ intervalMs: 60_000, clock, accounts: 'x' as never }),
    ).toThrow(/accounts/u);
  });
});
