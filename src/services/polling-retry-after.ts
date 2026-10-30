/**
 * `Retry-After` scheduling (spec §7.2; task 107, decision D-062).
 *
 * The §7.2 HTTP 429 row's second half: after a rate-limited cycle — which
 * task 106's wrapper already reports immediately, "do not retry within the
 * current cycle" — the account's **next** poll is deferred to the time the
 * provider indicated, capped at one hour: "Respect `Retry-After` up to one
 * hour and do not poll before that time". This module turns the raw header
 * value (already traveling on the classification, D-042 → D-048) plus a
 * clock reading into that deferral decision; the polling scheduler (task
 * 109) consumes it and the run writer (task 110) persists its
 * `seconds` as `collection_runs.retry_after_seconds` (D-034's CHECK admits
 * exactly `NULL` or 0–3600, the same one-hour cap).
 *
 * Parsing follows RFC 9110: the value is `delay-seconds` (one or more ASCII
 * digits) or an `HTTP-date` (IMF-fixdate, plus the two legacy `obs-date`
 * forms recipients SHOULD accept), surrounded by optional HTTP whitespace.
 * RFC 850 two-digit years follow §5.6.7's sliding 50-year rule. The
 * §7.2 failure modes are handled safely, never fatally:
 *
 * - **malformed** — no deferral: the account keeps its normal polling
 *   interval and nothing is persisted (`NULL`); a broken header must not
 *   wedge the account (no crash, no `NaN`, no infinite wait);
 * - **past** — an HTTP-date already elapsed is a *valid* parse whose
 *   effective wait is zero: `seconds: 0`, the boundary value D-034's CHECK
 *   anticipated, so the record stays truthful while the schedule is
 *   unchanged;
 * - **excessive** — any value over one hour (including magnitudes no IEEE
 *   double can represent) is capped at 3600 s with `capped: true`; the cap
 *   deliberately overrides the provider — "up to one hour" is the spec's
 *   own bound on how long a 429 may silence an account.
 *
 * Time never comes from the machine clock (D-021): every entry point takes
 * the current epoch as an argument, so tests are plain table-driven calls
 * and the polling scheduler passes its injected `Clock`'s reading.
 */

import { DateTime } from 'luxon';
import type { CycleOutcome } from './polling-outcomes';

/* ── The §7.2 cap ─────────────────────────────────────────────────────── */

/**
 * The §7.2 one-hour cap on honoring `Retry-After` — the same bound the
 * `collection_runs_retry_after_range` CHECK enforces for the persisted
 * `retry_after_seconds` (D-034). A deferral never exceeds this, whatever
 * the provider sent.
 */
export const RETRY_AFTER_MAX_SECONDS = 3600;

/** {@link RETRY_AFTER_MAX_SECONDS} in milliseconds. */
export const RETRY_AFTER_MAX_MS = RETRY_AFTER_MAX_SECONDS * 1000;

/* ── The decision vocabulary ──────────────────────────────────────────── */

/**
 * Why a cycle's `Retry-After` produced no deferral:
 *
 * - `'ineligible'` — §7.2 honors `Retry-After` only for a 429; a 503 that
 *   carries the header gets within-cycle retries (task 106) and must not
 *   also silence the account's next poll;
 * - `'absent'` — no header arrived (a 429 without `Retry-After` is legal,
 *   D-034);
 * - `'malformed'` — the value is neither `delay-seconds` nor an
 *   `HTTP-date`; the normal polling interval applies.
 */
export type RetryAfterIgnoreReason = 'ineligible' | 'absent' | 'malformed';

/**
 * The effective deferral for an account's next poll: either the whole-second
 * wait with its not-before instant, or a reason no deferral applies. The
 * run writer (task 110) persists `seconds` when `deferred`, `NULL`
 * otherwise.
 */
export type RetryAfterDefer =
  | {
      readonly deferred: true;
      /**
       * The effective whole seconds to wait — always within
       * `[0, RETRY_AFTER_MAX_SECONDS]`, the range D-034's CHECK admits.
       */
      readonly seconds: number;
      /** True when the provider's value exceeded the cap and was reduced. */
      readonly capped: boolean;
      /**
       * The UTC epoch milliseconds before which the account must not be
       * polled — `nowEpochMs + seconds * 1000`, the input task 109's
       * scheduler gates the next poll on.
       */
      readonly notBeforeEpochMs: number;
    }
  | { readonly deferred: false; readonly reason: RetryAfterIgnoreReason };

/* ── Parsing (RFC 9110 §10.1.3, §5.6.7) ───────────────────────────────── */

/**
 * `delay-seconds` per RFC 9110: `1*DIGIT` — ASCII digits only, so no sign,
 * decimal point, exponent, or non-ASCII digit forms can slip through
 * (`Number()` alone would accept several of those).
 */
const DELAY_SECONDS = /^[0-9]+$/u;

/**
 * The RFC 850 `obs-date` shape — the one HTTP-date form whose year is two
 * digits (`dd-Mon-yy`; the dashes separate it from IMF-fixdate and the
 * comma-less asctime form). Used only over values Luxon already accepted,
 * to decide whether the sliding 50-year rule applies.
 */
const RFC_850_TWO_DIGIT_YEAR =
  /^[A-Za-z]+, [0-9]{2}-[A-Za-z]{3}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u;

/**
 * RFC 9110 §5.6.7's sliding 50-year rule for RFC 850 two-digit years:
 * "interpret a timestamp that appears to be more than 50 years in the
 * future as representing the most recent year in the past that had the
 * same last two digits". Luxon instead applies a fixed 1950/2050 pivot
 * (verified on the pinned runtime, luxon 3.7.2), so the century is
 * corrected here, over Luxon's accepted instant: the two legal readings of
 * a two-digit year sit exactly 100 years apart, so the RFC reading is the
 * one that is not more than 50 years ahead of `nowEpochMs`.
 *
 * One corner stays with Luxon: a weekday name written for the RFC-correct
 * century may fail Luxon's day-name cross-check against its own pivot
 * reading, and such a value is then reported malformed — no deferral, the
 * fail-safe direction.
 */
function rfc850SlidingCentury(instant: DateTime, nowEpochMs: number): DateTime {
  const fiftyYearsAhead = DateTime.fromMillis(nowEpochMs, { zone: 'utc' })
    .plus({ years: 50 })
    .toMillis();
  if (instant.toMillis() > fiftyYearsAhead) {
    return instant.minus({ years: 100 });
  }
  if (instant.plus({ years: 100 }).toMillis() <= fiftyYearsAhead) {
    return instant.plus({ years: 100 });
  }
  return instant;
}

/** Validates the injected clock reading; every entry point shares it. */
function requireFiniteNow(nowEpochMs: number, caller: string): void {
  if (!Number.isFinite(nowEpochMs)) {
    throw new TypeError(`${caller}: nowEpochMs must be a finite number`);
  }
}

/**
 * Builds the deferred decision from an unclamped, non-negative second
 * count, applying the one-hour cap. Integer seconds keep one source of
 * truth: the persisted value and the not-before instant derive from the
 * same number.
 */
function deferSeconds(seconds: number, nowEpochMs: number): RetryAfterDefer {
  const capped = seconds > RETRY_AFTER_MAX_SECONDS;
  const effective = capped ? RETRY_AFTER_MAX_SECONDS : seconds;
  return {
    deferred: true,
    seconds: effective,
    capped,
    notBeforeEpochMs: nowEpochMs + effective * 1000,
  };
}

/**
 * Parses a raw `Retry-After` header value against a clock reading and
 * returns the effective deferral decision. Pure: `nowEpochMs` is data, not
 * a clock read (D-021). Total over header garbage — malformed values are
 * reported as `{ deferred: false, reason: 'malformed' }` — and throws only
 * on programming mistakes (a non-string value, a non-finite `nowEpochMs`).
 *
 * Dates are quantized with `ceil`: whole seconds must never end the wait
 * before the indicated instant ("do not poll before that time"), so a date
 * 500 ms ahead defers a full second, and an elapsed date clamps to `0`
 * rather than going negative.
 */
export function parseRetryAfter(
  retryAfter: string | undefined,
  nowEpochMs: number,
): RetryAfterDefer {
  if (retryAfter !== undefined && typeof retryAfter !== 'string') {
    throw new TypeError('parseRetryAfter: retryAfter must be a string or undefined');
  }
  requireFiniteNow(nowEpochMs, 'parseRetryAfter');
  if (retryAfter === undefined) {
    return { deferred: false, reason: 'absent' };
  }
  // Optional HTTP whitespace padding (RFC 9110 §5.6.3 OWS, plus the CR/LF
  // the fetch header reader normalizes) is stripped before parsing — the
  // exact byte set that reader strips. Wider Unicode whitespace (e.g. NBSP)
  // is not OWS and survives the strip, so such a value is reported
  // malformed rather than liberally guessed (review finding).
  const trimmed = retryAfter.replace(/^[ \t\r\n]+/u, '').replace(/[ \t\r\n]+$/u, '');
  if (DELAY_SECONDS.test(trimmed)) {
    // A syntactically valid digit string may still overflow IEEE-754 to
    // Infinity — that is an excessive delay, not a malformed one.
    return deferSeconds(Number(trimmed), nowEpochMs);
  }
  // HTTP-date, always GMT: parsed in UTC so no machine-local reading can
  // enter (the same discipline as D-021's clock helpers). Accepts
  // IMF-fixdate and the two legacy obs-date forms; anything else is invalid
  // and reported as malformed, never guessed.
  const parsed = DateTime.fromHTTP(trimmed, { zone: 'utc' });
  if (!parsed.isValid) {
    return { deferred: false, reason: 'malformed' };
  }
  const httpDate = RFC_850_TWO_DIGIT_YEAR.test(trimmed)
    ? rfc850SlidingCentury(parsed, nowEpochMs)
    : parsed;
  const deltaMs = httpDate.toMillis() - nowEpochMs;
  return deferSeconds(Math.max(0, Math.ceil(deltaMs / 1000)), nowEpochMs);
}

/* ── The classification entry point ───────────────────────────────────── */

/**
 * The single canonical `Retry-After` decision for a classified cycle — the
 * function task 109 schedules the account's next poll through, so the
 * eligibility rule cannot be re-derived (or forgotten) at a call site:
 * §7.2 sanctions honoring `Retry-After` only for a 429, which task 105
 * already carries as `retryAfterEligible` (D-048). A non-429 outcome — even
 * one whose transport error retained the raw header — is `'ineligible'`;
 * an eligible outcome delegates to {@link parseRetryAfter}.
 *
 * Task 110 persists `decision.deferred ? decision.seconds : null` as
 * `retry_after_seconds`.
 */
export function deferNextPoll(classified: CycleOutcome, nowEpochMs: number): RetryAfterDefer {
  if (
    typeof classified !== 'object' ||
    classified === null ||
    typeof classified.retryAfterEligible !== 'boolean' ||
    (classified.retryAfterRaw !== undefined && typeof classified.retryAfterRaw !== 'string')
  ) {
    throw new TypeError('deferNextPoll: classified must be a CycleOutcome');
  }
  requireFiniteNow(nowEpochMs, 'deferNextPoll');
  if (!classified.retryAfterEligible) {
    return { deferred: false, reason: 'ineligible' };
  }
  return parseRetryAfter(classified.retryAfterRaw, nowEpochMs);
}
