import { describe, expect, it } from 'vitest';
import { TransportAbortError, TransportStatusError } from '../../src/providers/transport';
import type { Clock } from '../../src/util/clock';
import { createAccountSuspensions } from '../../src/services/account-suspensions';
import {
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import {
  createPollingScheduler,
  type PollingAccount,
  type PollingScheduler,
  type PollingSleep,
} from '../../src/services/polling-scheduler';
import { withFakeTimers } from '../helpers/isolation';

/**
 * The FSM-1 golden parity suite (TZ-fsm §3.5, decision D-190): scripted
 * clock readings drive the REAL engine through every dispatcher shape, and
 * the observable decision sequence — attempt starts, settle classifications,
 * and every wake that actually fires — is pinned as literal traces.
 *
 * The literals were captured from the PRE-refactor engine (the field-scatter
 * dispatcher of D-066/D-189) and are never edited afterwards: the phase-model
 * rework must reproduce them byte-for-byte, which is the before/after
 * identity proof the task demands. Everything is deterministic — a zero
 * jitter roll, instant scripted settles except where a scenario parks a
 * flight on purpose, and fake timers — so the traces are pure functions of
 * the scripts.
 */

/* ── Harness ───────────────────────────────────────────────────────────── */

/** One observable decision record, rendered as a compact trace line. */
type TraceLine = string;

interface Gate {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface GoldenHarness {
  readonly scheduler: PollingScheduler;
  /** The decision trace: starts, settles, and fired wakes, in order. */
  readonly trace: TraceLine[];
  account: (id: string, keyIdentity?: string) => PollingAccount;
  script: (id: string, settle: (call: number) => CycleOutcome) => void;
  holdNext: (id: string) => void;
  release: (id: string) => void;
  hang: (id: string) => void;
  unhang: (id: string) => void;
}

interface GoldenOptions {
  readonly ids?: readonly string[];
  readonly intervalMs?: number;
  readonly cycleHangThresholdMs?: number;
}

/**
 * A compact recording engine harness: the module's real sleep seam wrapped
 * so every wake that actually FIRES lands in the trace (a wait aborted by a
 * kick — the transient hang-threshold wait under a momentary flight — never
 * fires and never records, exactly the distinction the wake decisions need).
 */
function golden(options: GoldenOptions = {}): GoldenHarness {
  const ids = options.ids ?? [];
  const clock: Clock = { now: () => Date.now(), monotonicMs: () => Date.now() };
  const suspensions = createAccountSuspensions({ clock });
  const trace: TraceLine[] = [];
  const starts = new Map<string, number>();
  const settles = new Map<string, number>();
  const settleScripts = new Map<string, (call: number) => CycleOutcome>();
  const pendingGates = new Map<string, Gate[]>();
  const activeGate = new Map<string, Gate>();
  const hanging = new Set<string>();
  const hungReleases = new Map<string, Array<() => void>>();

  const sleep: PollingSleep = (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new TransportAbortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new TransportAbortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        trace.push(`${Date.now()} wake`);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  function account(id: string, keyIdentity = `key:${id}`): PollingAccount {
    return {
      accountId: id,
      keyIdentity,
      attempt: async (signal) => {
        const call = (starts.get(id) ?? 0) + 1;
        starts.set(id, call);
        trace.push(`${Date.now()} start ${id}#${call}`);
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
        return { providerId: id, signalAborted: signal.aborted };
      },
      settleCycle: async () => {
        const call = (settles.get(id) ?? 0) + 1;
        settles.set(id, call);
        const outcome = settleScripts.get(id)?.(call) ?? classifySuccess();
        trace.push(`${Date.now()} settle ${id}#${call} ${outcome.outcome}`);
        return outcome;
      },
    };
  }

  const scheduler = createPollingScheduler({
    accounts: ids.map((id) => account(id)),
    intervalMs: options.intervalMs ?? 60_000,
    clock,
    suspensions,
    random: () => 0,
    cycleHangThresholdMs: options.cycleHangThresholdMs,
    sleep,
  });

  return {
    scheduler,
    trace,
    account,
    script: (id, settle) => settleScripts.set(id, settle),
    holdNext: (id) => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      pendingGates.set(id, [...(pendingGates.get(id) ?? []), { promise, resolve }]);
    },
    release: (id) => {
      const gate = activeGate.get(id);
      if (gate === undefined) return;
      activeGate.delete(id);
      gate.resolve();
    },
    hang: (id) => hanging.add(id),
    unhang: (id) => {
      hanging.delete(id);
      for (const release of hungReleases.get(id) ?? []) release();
      hungReleases.delete(id);
    },
  };
}

/** Classifications the scenarios reuse. */
const rejected = (): CycleOutcome =>
  classifyTransportError(new TransportStatusError(401, 'Unauthorized', undefined));
const rateLimited = (retryAfter: string): CycleOutcome =>
  classifyTransportError(new TransportStatusError(429, 'Too Many Requests', retryAfter));

/* ── The golden scenarios (traces captured pre-refactor, never edited) ─── */

describe('golden parity: first polls and interval rounds (§7.1)', () => {
  it('G1 — three accounts, immediate first polls in order, two jitter-zero rounds', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a', 'b', 'c'] });
        engine.scheduler.start();
        await advance.advanceMsAsync(0);
        await advance.advanceMsAsync(59_999);
        await advance.advanceMsAsync(1); // t = 60 000: round two
        await advance.advanceMsAsync(60_000); // t = 120 000: round three
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '0 settle a#1 success',
          '0 start b#1',
          '0 settle b#1 success',
          '0 start c#1',
          '0 settle c#1 success',
          '60000 wake',
          '60000 start a#2',
          '60000 settle a#2 success',
          '60000 start b#2',
          '60000 settle b#2 success',
          '60000 start c#2',
          '60000 settle c#2 success',
          '120000 wake',
          '120000 start a#3',
          '120000 settle a#3 success',
          '120000 start b#3',
          '120000 settle b#3 success',
          '120000 start c#3',
          '120000 settle c#3 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

describe('golden parity: the Retry-After gate over the owed manual attempt (§7.2)', () => {
  it('G2 — a 429 deferral holds the next poll and a manual test behind the gate', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a'] });
        engine.script('a', (call) => (call === 1 ? rateLimited('90') : classifySuccess()));
        engine.scheduler.start();
        await advance.advanceMsAsync(0); // a#1 → 429, gate opens at 90 000
        await advance.advanceMsAsync(1_000);
        engine.scheduler.requestManualTest('a'); // owed, still behind the gate
        await advance.advanceMsAsync(89_000); // t = 90 000: the owed attempt
        await advance.advanceMsAsync(60_000); // t = 150 000: plain interval
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '0 settle a#1 rate_limited',
          '90000 wake',
          '90000 start a#2',
          '90000 settle a#2 success',
          '150000 wake',
          '150000 start a#3',
          '150000 settle a#3 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

describe('golden parity: the gate over the verification probe (§7.2, U-028)', () => {
  it('G3 — 401 → probe → probe 429: the cadence arrives inside the deferral and waits', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a'] });
        engine.script('a', (call) => {
          if (call === 1) return rejected();
          if (call === 2) return rateLimited('3600');
          return classifySuccess();
        });
        engine.scheduler.start();
        await advance.advanceMsAsync(0); // a#1 → 401, suspension armed at 3 600 000
        engine.holdNext('a'); // the probe parks mid-flight
        await advance.advanceMsAsync(3_600_000); // t = 3 600 000: the probe is due
        await advance.advanceMsAsync(30_000); // the probe takes 30 s
        engine.release('a'); // its 429 settles at t = 3 630 000 → gate 7 230 000
        await advance.advanceMsAsync(0);
        await advance.advanceMsAsync(3_570_000); // t = 7 200 000: cadence due, gated
        await advance.advanceMsAsync(30_000); // t = 7 230 000: the gate opens
        await advance.advanceMsAsync(60_000); // t = 7 290 000: released, plain interval
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '0 settle a#1 auth_error',
          '3600000 wake',
          '3600000 start a#2',
          '3630000 settle a#2 rate_limited',
          '7200000 wake',
          '7230000 wake',
          '7230000 start a#3',
          '7230000 settle a#3 success',
          '7290000 wake',
          '7290000 start a#4',
          '7290000 settle a#4 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

describe('golden parity: the sticky hang threshold (§7.1, D-066)', () => {
  it('G4 — a hanging flight holds the queue to the threshold, then others proceed around it', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a', 'b'], cycleHangThresholdMs: 5_000 });
        engine.hang('a');
        engine.scheduler.start();
        await advance.advanceMsAsync(0); // a#1 hangs; the queue holds
        await advance.advanceMsAsync(5_000); // t = 5 000: the threshold passes
        await advance.advanceMsAsync(60_000); // t = 65 000: b round two
        await advance.advanceMsAsync(60_000); // t = 125 000: b round three
        engine.unhang('a'); // the hung cycle settles at t = 125 000
        await advance.advanceMsAsync(0);
        await advance.advanceMsAsync(60_000); // t = 185 000: a resumes
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '5000 wake',
          '5000 start b#1',
          '5000 settle b#1 success',
          '65000 wake',
          '65000 start b#2',
          '65000 settle b#2 success',
          '125000 wake',
          '125000 start b#3',
          '125000 settle b#3 success',
          '125000 settle a#1 success',
          '185000 wake',
          '185000 start a#2',
          '185000 settle a#2 success',
          '185000 start b#4',
          '185000 settle b#4 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

describe('golden parity: the stale-outcome discard (§7.2, D-066 P1-1)', () => {
  it('G5 — a key change mid-flight discards the old key’s outcome and polls the new key now', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a'] });
        engine.script('a', (call) => (call === 1 ? rejected() : classifySuccess()));
        engine.holdNext('a');
        engine.scheduler.start();
        await advance.advanceMsAsync(0); // a#1 (old key) parks mid-flight
        await advance.advanceMsAsync(500);
        engine.scheduler.setAccounts([engine.account('a', 'key:generation-2')]);
        engine.release('a'); // the old key answers 401 — stale, discarded
        await advance.advanceMsAsync(0);
        await advance.advanceMsAsync(60_000); // t = 60 500: the new key's interval
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '500 settle a#1 auth_error',
          '500 start a#2',
          '500 settle a#2 success',
          '60500 wake',
          '60500 start a#3',
          '60500 settle a#3 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});

describe('golden parity: the owed attempt survives a settle and an interval change (P2-3)', () => {
  it('G6 — a manual test owed during an in-flight cycle runs at the settle, on the new interval', async () => {
    await withFakeTimers(
      async (advance) => {
        const engine = golden({ ids: ['a'] });
        engine.holdNext('a');
        engine.scheduler.start();
        await advance.advanceMsAsync(0); // a#1 parks mid-flight
        engine.scheduler.requestManualTest('a'); // the owed attempt
        engine.scheduler.setIntervalMs(120_000); // and an interval change
        engine.release('a'); // a#1 settles; the owed attempt is not overwritten
        await advance.advanceMsAsync(0);
        await advance.advanceMsAsync(120_000); // t = 120 000: the new interval
        await engine.scheduler.stop();
        expect(engine.trace).toEqual([
          '0 start a#1',
          '0 settle a#1 success',
          '0 start a#2',
          '0 settle a#2 success',
          '120000 wake',
          '120000 start a#3',
          '120000 settle a#3 success',
        ]);
      },
      { shouldAdvanceTime: false, now: 0 },
    );
  });
});
