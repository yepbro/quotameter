import { describe, expect, it, vi } from 'vitest';
import { withFakeTimers } from '../helpers/isolation';
import {
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportDnsError,
  TransportError,
  TransportNetworkError,
  TransportResponseTooLargeError,
  TransportSocketError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import {
  MAX_CYCLE_ATTEMPTS,
  RETRY_BASE_DELAYS_MS,
  RETRY_JITTER_MAX_MS,
  retryDelayMs,
  runCycleWithRetries,
  type CycleBackoffSleep,
} from '../../src/services/polling-retry';

/**
 * Fake-timer coverage of the §7.2 retry/backoff rules (task 106, decision
 * D-059): retry counts (three retries ⇒ at most four attempts), the exact
 * 2/4/8 s delay floors with the 0–500 ms jitter bounds on top, no retry for
 * 429/401/403/parse/abort within the cycle, attempt-count reporting for the
 * collection-run record (§11.2 `attempts`, persisted by task 110), abort
 * cancellation mid-backoff, and the interaction with the transport's
 * per-attempt §7.2 timeout (a timed-out attempt is just another retryable
 * failure). The fake-timer suites drive the module's own default sleep;
 * the eligibility matrix uses the injected seam to stay synchronous.
 */

describe('retry schedule constants (spec §7.2)', () => {
  it('pins the exponential bases, the jitter bound, and the attempt ceiling', () => {
    expect(RETRY_BASE_DELAYS_MS).toEqual([2_000, 4_000, 8_000]);
    expect(RETRY_JITTER_MAX_MS).toBe(500);
    expect(MAX_CYCLE_ATTEMPTS).toBe(4);
  });
});

describe('retryDelayMs bounds', () => {
  it('returns the bare base at a zero roll', () => {
    expect(retryDelayMs(0, () => 0)).toBe(2_000);
    expect(retryDelayMs(1, () => 0)).toBe(4_000);
    expect(retryDelayMs(2, () => 0)).toBe(8_000);
  });

  it('adds the midpoint jitter at roll 0.5', () => {
    // floor(0.5 × 501) = 250 — the uniform-integer quantization.
    expect(retryDelayMs(0, () => 0.5)).toBe(2_250);
    expect(retryDelayMs(1, () => 0.5)).toBe(4_250);
    expect(retryDelayMs(2, () => 0.5)).toBe(8_250);
  });

  it('caps the jitter at RETRY_JITTER_MAX_MS as the roll approaches 1', () => {
    expect(retryDelayMs(0, () => 0.999_999)).toBe(2_000 + RETRY_JITTER_MAX_MS);
    expect(retryDelayMs(1, () => 0.999_999)).toBe(4_000 + RETRY_JITTER_MAX_MS);
    expect(retryDelayMs(2, () => 0.999_999)).toBe(8_000 + RETRY_JITTER_MAX_MS);
  });

  it('rejects a retry index outside the schedule', () => {
    for (const retryIndex of [-1, 3, 1.5, Number.NaN]) {
      expect(() => retryDelayMs(retryIndex, () => 0)).toThrow(RangeError);
    }
  });

  it('rejects a roll outside [0, 1) instead of breaking the bound', () => {
    for (const roll of [1, 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 'x'] as const) {
      expect(() => retryDelayMs(0, () => roll as number)).toThrow(/must return a finite number/u);
    }
  });
});

describe('runCycleWithRetries eligibility (§7.2, via the injected sleep seam)', () => {
  /** Runs `attempt` under an instant, delay-recording backoff. */
  async function run(
    attempt: () => Promise<string>,
    roll = 0,
  ): Promise<{
    delays: number[];
    result: Awaited<ReturnType<typeof runCycleWithRetries<string>>>;
  }> {
    const delays: number[] = [];
    const sleep: CycleBackoffSleep = async (ms) => {
      delays.push(ms);
    };
    const result = await runCycleWithRetries(attempt, { random: () => roll, sleep });
    return { delays, result };
  }

  it('retries network failures, timeouts, and 5xx — nothing else', async () => {
    const retryable: readonly unknown[] = [
      new TransportConnectionError('ECONNREFUSED'),
      new TransportDnsError('ENOTFOUND'),
      new TransportSocketError('UND_ERR_SOCKET'),
      new TransportNetworkError(),
      new TransportTimeoutError(15_000),
      new TransportStatusError(500, '', undefined),
      new TransportStatusError(503, 'Service Unavailable', undefined),
      new TransportStatusError(599, '', undefined),
    ];
    for (const error of retryable) {
      const { delays, result } = await run(async () => {
        throw error;
      });
      expect(result.ok, String(error)).toBe(false);
      expect(result.attempts, String(error)).toBe(4);
      expect(delays, String(error)).toEqual([2_000, 4_000, 8_000]);
    }
  });

  it('does not retry 429, 401, 403, parse defects, or a caller abort', async () => {
    const notRetryable: readonly unknown[] = [
      new TransportStatusError(429, '', '37'),
      new TransportStatusError(401, 'Unauthorized', undefined),
      new TransportStatusError(403, 'Forbidden', undefined),
      new TransportContentTypeError('text/plain'),
      new TransportResponseTooLargeError(64 * 1024),
      new TransportAbortError(),
      // An adapter parse failure (task 099's SnapshotParseError shape):
      // not a TransportError at all, and deterministic (D-048).
      new Error('snapshot envelope was not the expected object'),
    ];
    for (const error of notRetryable) {
      const { delays, result } = await run(async () => {
        throw error;
      });
      expect(result.ok, String(error)).toBe(false);
      expect(result.attempts, String(error)).toBe(1);
      expect(delays, String(error)).toEqual([]);
      if (!result.ok) expect(result.error).toBe(error);
    }
  });

  it('reports the total attempt count for the run record (task 110)', async () => {
    for (const failuresBeforeSuccess of [0, 1, 2, 3]) {
      let calls = 0;
      const { result } = await run(async () => {
        calls++;
        if (calls <= failuresBeforeSuccess) throw new TransportNetworkError();
        return 'snapshot';
      });
      expect(result, `failures=${failuresBeforeSuccess}`).toEqual({
        ok: true,
        value: 'snapshot',
        attempts: failuresBeforeSuccess + 1,
      });
    }
  });

  it('passes the schedule with jitter to the sleep seam and the caller signal through', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let seenSignal: AbortSignal | undefined;
    const sleep: CycleBackoffSleep = async (ms, signal) => {
      delays.push(ms);
      seenSignal = signal;
    };
    const result = await runCycleWithRetries(
      async () => {
        throw new TransportTimeoutError(15_000);
      },
      { random: () => 0.999_999, signal: controller.signal, sleep },
    );
    expect(result).toEqual({ ok: false, error: new TransportTimeoutError(15_000), attempts: 4 });
    expect(delays).toEqual([2_500, 4_500, 8_500]);
    expect(seenSignal).toBe(controller.signal);
  });

  it('ends the cycle with the abort when the sleep seam rejects with one', async () => {
    const abort = new TransportAbortError();
    const result = await runCycleWithRetries(
      async () => {
        throw new TransportConnectionError();
      },
      {
        random: () => 0,
        sleep: () => Promise.reject(abort),
      },
    );
    expect(result).toEqual({ ok: false, error: abort, attempts: 1 });
  });

  it('propagates a broken sleep seam instead of converting it into a failed cycle', async () => {
    const sentinel = new Error('sleep broke');
    await expect(
      runCycleWithRetries(
        async () => {
          throw new TransportConnectionError();
        },
        {
          random: () => 0,
          sleep: () => Promise.reject(sentinel),
        },
      ),
    ).rejects.toBe(sentinel);
  });

  it('propagates a bad mid-loop roll instead of converting it into a failed cycle', async () => {
    // The delay is computed inside the loop; its fail-fast contract must
    // survive there (review P3), not only at the pure-function boundary.
    let calls = 0;
    await expect(
      runCycleWithRetries(
        async () => {
          calls++;
          throw new TransportNetworkError();
        },
        { random: () => 1.2, sleep: async () => {} },
      ),
    ).rejects.toThrow(/must return a finite number/u);
    expect(calls).toBe(1);
  });

  it('validates its seams fail-fast', async () => {
    await expect(runCycleWithRetries(undefined as unknown as () => Promise<never>)).rejects.toThrow(
      /attempt must be a function/u,
    );
    await expect(
      runCycleWithRetries(async () => 'x', { signal: {} as AbortSignal }),
    ).rejects.toThrow(/signal must be an AbortSignal/u);
    await expect(
      runCycleWithRetries(async () => 'x', { random: 5 as unknown as () => number }),
    ).rejects.toThrow(/random must be a function/u);
    await expect(
      runCycleWithRetries(async () => 'x', { sleep: 'no' as unknown as CycleBackoffSleep }),
    ).rejects.toThrow(/sleep must be a function/u);
  });

  it('propagates the classifier fail-fast on a malformed http-status error', async () => {
    // A base TransportError carrying kind http-status without a status is a
    // wiring bug (D-048); it must surface, not be guessed retryable.
    const bogus = new TransportError('http-status', 'wiring bug');
    await expect(
      runCycleWithRetries(async () => {
        throw bogus;
      }),
    ).rejects.toThrow(/requires a TransportStatusError/u);
  });
});

describe('runCycleWithRetries schedule under fake timers (default sleep)', () => {
  it('succeeds on the first attempt without scheduling any backoff', async () => {
    await withFakeTimers(
      async (clock) => {
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            return 'ok';
          },
          { random: () => 0 },
        );
        await clock.advanceMsAsync(0);
        const result = await promise;
        expect(result).toEqual({ ok: true, value: 'ok', attempts: 1 });
        expect(calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      },
      { shouldAdvanceTime: false },
    );
  });

  it('exhausts exactly three retries: four attempts, 14 s of backoff', async () => {
    await withFakeTimers(
      async (clock) => {
        const startedAt = Date.now();
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            throw new TransportConnectionError('ECONNREFUSED');
          },
          { random: () => 0 },
        );
        const result = await clock.runAllTimersAsync().then(() => promise);
        expect(result).toEqual({
          ok: false,
          error: new TransportConnectionError('ECONNREFUSED'),
          attempts: 4,
        });
        expect(calls).toBe(4);
        // 2 + 4 + 8 s at zero jitter — exactly the §7.2 bases.
        expect(Date.now() - startedAt).toBe(14_000);
      },
      { shouldAdvanceTime: false },
    );
  });

  it.each([
    [1, 2, 2_000],
    [2, 3, 6_000],
    [3, 4, 14_000],
  ])(
    'succeeds after %d failure(s): %d attempts, %d ms elapsed',
    async (failures, expectedAttempts, expectedElapsed) => {
      await withFakeTimers(
        async (clock) => {
          const startedAt = Date.now();
          let calls = 0;
          const promise = runCycleWithRetries(
            async () => {
              calls++;
              if (calls <= failures) throw new TransportTimeoutError(15_000);
              return 'ok';
            },
            { random: () => 0 },
          );
          const result = await clock.runAllTimersAsync().then(() => promise);
          expect(result).toEqual({ ok: true, value: 'ok', attempts: expectedAttempts });
          expect(Date.now() - startedAt).toBe(expectedElapsed);
        },
        { shouldAdvanceTime: false },
      );
    },
  );

  it('waits no less than the 2 s base before the first retry (zero jitter)', async () => {
    await withFakeTimers(
      async (clock) => {
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            if (calls === 1) throw new TransportNetworkError();
            return 'ok';
          },
          { random: () => 0 },
        );
        await clock.advanceMsAsync(0);
        expect(calls).toBe(1);
        await clock.advanceMsAsync(1_999);
        expect(calls).toBe(1); // one millisecond short: still backing off
        await clock.advanceMsAsync(1);
        expect(await promise).toEqual({ ok: true, value: 'ok', attempts: 2 });
      },
      { shouldAdvanceTime: false },
    );
  });

  it('adds the midpoint jitter: the first retry fires at exactly 2 250 ms', async () => {
    await withFakeTimers(
      async (clock) => {
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            if (calls === 1) throw new TransportNetworkError();
            return 'ok';
          },
          { random: () => 0.5 },
        );
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(2_249);
        expect(calls).toBe(1);
        await clock.advanceMsAsync(1);
        expect(await promise).toEqual({ ok: true, value: 'ok', attempts: 2 });
      },
      { shouldAdvanceTime: false },
    );
  });

  it('bounds the jitter above: the first retry fires no later than 2 500 ms', async () => {
    await withFakeTimers(
      async (clock) => {
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            if (calls === 1) throw new TransportNetworkError();
            return 'ok';
          },
          { random: () => 0.999_999 },
        );
        await clock.advanceMsAsync(0);
        await clock.advanceMsAsync(2_499);
        expect(calls).toBe(1);
        await clock.advanceMsAsync(1);
        expect(await promise).toEqual({ ok: true, value: 'ok', attempts: 2 });
      },
      { shouldAdvanceTime: false },
    );
  });

  it('keeps the total backoff within 14 s + 3 × jitter bound', async () => {
    await withFakeTimers(
      async (clock) => {
        const startedAt = Date.now();
        const promise = runCycleWithRetries(
          async () => {
            throw new TransportNetworkError();
          },
          { random: () => 0.999_999 },
        );
        const result = await clock.runAllTimersAsync().then(() => promise);
        expect(result.attempts).toBe(4);
        expect(Date.now() - startedAt).toBe(15_500);
      },
      { shouldAdvanceTime: false },
    );
  });

  it('schedules no timer at all for a non-retryable failure', async () => {
    await withFakeTimers(
      async (clock) => {
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            throw new TransportStatusError(429, '', '37');
          },
          { random: () => 0 },
        );
        await clock.advanceMsAsync(0);
        const result = await promise;
        expect(result.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      },
      { shouldAdvanceTime: false },
    );
  });

  it('cancels the backoff when the caller aborts mid-wait', async () => {
    await withFakeTimers(
      async (clock) => {
        const controller = new AbortController();
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++;
            throw new TransportConnectionError('ECONNREFUSED');
          },
          { random: () => 0, signal: controller.signal },
        );
        await clock.advanceMsAsync(0);
        expect(calls).toBe(1);
        controller.abort(); // mid-backoff: the wait must not outlive the signal
        const result = await promise;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(TransportAbortError);
        expect(result.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0); // the sleep timer was cleared
      },
      { shouldAdvanceTime: false },
    );
  });

  it('rejects the backoff immediately when the signal is already aborted', async () => {
    await withFakeTimers(
      async (clock) => {
        const controller = new AbortController();
        controller.abort();
        let calls = 0;
        const promise = runCycleWithRetries(
          async () => {
            calls++; // the attempt itself ignores the signal here
            throw new TransportConnectionError('ECONNREFUSED');
          },
          { random: () => 0, signal: controller.signal },
        );
        const result = await clock.runAllTimersAsync().then(() => promise);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(TransportAbortError);
        expect(result.attempts).toBe(1);
        expect(calls).toBe(1);
      },
      { shouldAdvanceTime: false },
    );
  });
});
