/**
 * Within-cycle retry/backoff for provider collection (spec §7.2; task 106,
 * decision D-059).
 *
 * The seam the polling service (task 109) wraps around every collection
 * cycle — one `fetchSnapshot` call, the §7.2 "current cycle": network
 * failures, timeouts, and HTTP 5xx are retried up to three times with the
 * exponential delays 2, 4, and 8 seconds plus bounded jitter; every other
 * §7.2 failure — 429, 401/403, a parse defect — is reported immediately.
 * Retry eligibility is not re-decided here: it is task 105's
 * `classifyTransportError(error).retryable` (D-048's `RETRYABLE_OUTCOMES`,
 * exactly the three §7.2 retryable outcomes), which is why this module
 * lives in `services` next to it — `providers:core` cannot import services
 * (D-009), and a transport-level loop would need a divergent twin.
 *
 * {@link runCycleWithRetries} is total: provider failures return a result
 * object instead of throwing, with `attempts` counting every cycle attempt
 * (1–4) — the value §7.2's "one collection-run record with the total
 * attempt count" persists (task 110). Only programming mistakes (invalid
 * options, a malformed `TransportError`, a broken seam) throw, so one
 * account's failed cycle cannot take down the polling loop (§7.2: "a
 * failure for one account/provider must not stop other accounts").
 *
 * The per-attempt §7.2 request timeout stays with the transport (D-042):
 * this loop owns only the waits between attempts. A caller abort (§8.1
 * signal) interrupts the backoff and surfaces as `TransportAbortError` —
 * task 105 classifies it as the unpersistable `'cancelled'` pseudo-outcome,
 * never a provider failure.
 */

import { TransportAbortError, TransportError } from '../providers/transport';
import { classifyTransportError } from './polling-outcomes';

/* ── The §7.2 schedule ─────────────────────────────────────────────────── */

/**
 * The §7.2 retry schedule: the base delay before each of the three retries,
 * 2 s → 4 s → 8 s. Jitter is added on top ({@link RETRY_JITTER_MAX_MS});
 * the base is the floor, so a delay is never below the spec's figure.
 */
export const RETRY_BASE_DELAYS_MS: readonly [number, number, number] = Object.freeze([
  2_000, 4_000, 8_000,
] as const);

/**
 * The jitter bound (decision D-059): a uniform integer 0–500 ms added to
 * each retry delay. §7.2 mandates jitter without pinning its magnitude;
 * 500 ms decorrelates accounts sharing a schedule while keeping it
 * recognizable — the worst single wait is 8.5 s and the worst total
 * backoff 15.5 s against the 14 s the bases alone sum to.
 */
export const RETRY_JITTER_MAX_MS = 500;

/** §7.2's "up to three retries": one initial attempt plus three retries. */
export const MAX_CYCLE_ATTEMPTS = RETRY_BASE_DELAYS_MS.length + 1;

/**
 * One retry delay: the {@link RETRY_BASE_DELAYS_MS} base plus bounded
 * jitter. `random` is the injectable randomness seam; each call must return
 * a finite number in `[0, 1)` — a roll outside that range would break the
 * delay bound, so it fails fast instead of being clamped silently.
 */
export function retryDelayMs(retryIndex: number, random: () => number): number {
  if (
    !Number.isInteger(retryIndex) ||
    retryIndex < 0 ||
    retryIndex >= RETRY_BASE_DELAYS_MS.length
  ) {
    throw new RangeError(
      `retryDelayMs: retryIndex must be an integer in [0, ${RETRY_BASE_DELAYS_MS.length - 1}]`,
    );
  }
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new TypeError('retryDelayMs: random() must return a finite number in [0, 1)');
  }
  // floor(roll × 501) is uniform over the integers 0–500, both ends included.
  const jitterMs = Math.floor(roll * (RETRY_JITTER_MAX_MS + 1));
  return RETRY_BASE_DELAYS_MS[retryIndex]! + jitterMs;
}

/* ── Options and result ────────────────────────────────────────────────── */

/**
 * The backoff wait between attempts. The default is a real abortable
 * timer; injectable so integration tests can pin retry counts without
 * waiting real seconds (delay bounds are proven by the fake-timer unit
 * suite, which drives the default).
 */
export type CycleBackoffSleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

/** Options adjusting {@link runCycleWithRetries}; all optional. */
export interface CycleRetryOptions {
  /**
   * The caller's §8.1 abort signal, validated at entry (a bogus signal
   * reaching the default backoff would otherwise surface as a failed
   * cycle). An abort during backoff ends the cycle with a
   * `TransportAbortError`; the attempts made so far stay reported.
   */
  readonly signal?: AbortSignal;
  /**
   * The jitter randomness source (default `Math.random`). Each call must
   * return a finite number in `[0, 1)` (see {@link retryDelayMs}).
   */
  readonly random?: () => number;
  /**
   * The backoff wait (default: a real abortable timer). Only a rejection
   * with `TransportAbortError` becomes a cycle result; anything else is a
   * broken seam and propagates.
   */
  readonly sleep?: CycleBackoffSleep;
}

/**
 * The outcome of one retried collection cycle: either the attempt's value
 * or its final failure, with `attempts` — the total cycle attempt count
 * §11.2's `collection_runs.attempts` persists (task 110).
 */
export type CycleRetryResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number };

/* ── Internals ─────────────────────────────────────────────────────────── */

/**
 * §7.2 retry eligibility, delegated in full to task 105's classifier:
 * true only for `network_error`/`timeout`/`server_error` (D-048). A
 * non-`TransportError` (an adapter parse failure, a wiring bug) is never
 * retried. The classifier's fail-fast `TypeError` on a malformed
 * `http-status` construction propagates deliberately.
 */
function isRetryableTransportFailure(error: unknown): boolean {
  return error instanceof TransportError && classifyTransportError(error).retryable;
}

/**
 * The default backoff wait: one real timer, abortable through the caller's
 * signal. Unlike the transport's deadline the timer keeps the event loop
 * alive — a mid-backoff cycle is in-flight collection work, and shutdown
 * reaches it through the signal (the graceful drain, D-020), not through
 * process liveness.
 */
function defaultBackoffSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
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
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ── The retry loop ────────────────────────────────────────────────────── */

/**
 * Runs one collection cycle under the §7.2 retry rules: `attempt` is
 * called up to {@link MAX_CYCLE_ATTEMPTS} times; a retryable failure
 * (network, timeout, 5xx) is followed by a backoff of
 * `RETRY_BASE_DELAYS_MS[retryIndex]` plus jitter before the next attempt.
 *
 * Never throws for a provider failure — the result object carries the
 * final value or error and the total attempt count. Programming mistakes
 * (invalid options, a malformed `TransportError`, a broken seam —
 * including a backoff wait rejecting with anything but
 * `TransportAbortError`) throw instead, per the fail-fast precedent. The
 * intended wiring (task 109/110): the polling service passes its cycle
 * closure, and the final outcome is classified with task 105 from
 * `result.ok`/`result.error` while `result.attempts` feeds the run record.
 */
export async function runCycleWithRetries<T>(
  attempt: () => Promise<T>,
  options: CycleRetryOptions = {},
): Promise<CycleRetryResult<T>> {
  if (typeof attempt !== 'function') {
    throw new TypeError('runCycleWithRetries: attempt must be a function');
  }
  const signal = options.signal;
  if (
    signal !== undefined &&
    (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('runCycleWithRetries: signal must be an AbortSignal');
  }
  const random = options.random ?? Math.random;
  if (typeof random !== 'function') {
    throw new TypeError('runCycleWithRetries: random must be a function');
  }
  const sleep = options.sleep ?? defaultBackoffSleep;
  if (typeof sleep !== 'function') {
    throw new TypeError('runCycleWithRetries: sleep must be a function');
  }

  let attempts = 0;
  for (let retryIndex = 0; ; retryIndex++) {
    attempts++;
    try {
      const value = await attempt();
      return { ok: true, value, attempts };
    } catch (error) {
      const retriesLeft = retryIndex < RETRY_BASE_DELAYS_MS.length;
      if (!retriesLeft || !isRetryableTransportFailure(error)) {
        return { ok: false, error, attempts };
      }
      // Computed outside the sleep guard: a bad roll is a programming
      // mistake and must propagate, not become a failed cycle (review P3).
      const delayMs = retryDelayMs(retryIndex, random);
      try {
        await sleep(delayMs, signal);
      } catch (sleepError) {
        // The default backoff rejects only with the abort signal's own
        // error; any other rejection is a broken seam and propagates.
        if (!(sleepError instanceof TransportAbortError)) throw sleepError;
        return { ok: false, error: sleepError, attempts };
      }
    }
  }
}
