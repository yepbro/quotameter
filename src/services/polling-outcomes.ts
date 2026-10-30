/**
 * Provider error classification (spec §7.2, §7.3, §11.2; task 105, decision
 * D-048).
 *
 * The pure seam between task 104's transport taxonomy and the polling
 * pipeline: {@link classifyTransportError} turns a `TransportError` (the
 * `kind` discriminant D-042 defined as this task's input, plus the raw
 * status/`Retry-After` fields it carries) into a {@link CycleOutcome} whose
 * `outcome` is one of the seven §11.2 collection-outcome values the
 * `collection_runs` CHECK accepts (D-034); {@link classifyParseFailure} and
 * {@link classifySuccess} do the same for adapter parse outcomes. Every
 * downstream §7.2/§7.3 decision travels as data, so the tasks that own the
 * policies consume it instead of re-deriving it:
 *
 * - `retryable` — §7.2's within-cycle retry eligibility (network failure,
 *   timeout, 5xx retry; 429 and 401/403 "do not retry within the current
 *   cycle"; parse failures are deterministic). The 2/4/8 s schedule itself
 *   is task 106's.
 * - `retryAfterRaw`/`retryAfterEligible` — the raw `Retry-After` value and
 *   whether §7.2 sanctions honoring it (only a 429 defers the next poll).
 *   Parsing and the one-hour cap are task 107's.
 * - `statusContribution` — the §7.3 account-status input: which of the three
 *   failure-defined statuses the outcome contributes, in the precedence
 *   order {@link FAILURE_STATUS_PRECEDENCE} pins. The full state machine
 *   (the time-derived `Stale`/`Collecting`/`Fresh` states) is task 111's.
 * - `httpStatus` — §11.2's `http_status` retention: kept whenever a
 *   response arrived, `undefined` otherwise.
 * - `errorMessage` — §11.2's sanitized `error_message`: transport errors are
 *   static-English-and-scrubbed by construction (D-042), adapter reasons are
 *   the adapter's static English; `undefined` on a clean success.
 *
 * A caller abort (task 104's `aborted` kind) is service lifecycle, not a
 * provider failure: it classifies as the pseudo-outcome `'cancelled'` —
 * never retried, no status contribution, and deliberately outside the
 * persisted enum so no writer can store it by accident (the integration
 * spec pins that SQLite's CHECK rejects it). How a cancelled cycle is
 * recorded — or skipped — is the run writer's call (task 110); this module
 * only guarantees it can never be mistaken for a provider outcome.
 */

import { TransportError, TransportStatusError } from '../providers/transport';

/* ── Outcome vocabulary (spec §11.2, D-034) ────────────────────────────── */

/**
 * The closed collection-outcome enum — exactly the values the §11.2
 * `collection_runs` CHECK accepts (decision D-034, task 082's migration
 * `0002-collection-runs`). Order mirrors the SQL constraint for easy
 * cross-reading; membership, not order, is the contract. Adding a value is
 * a code change plus a schema migration.
 */
export const COLLECTION_OUTCOMES = Object.freeze([
  'success',
  'auth_error',
  'rate_limited',
  'network_error',
  'timeout',
  'server_error',
  'parse_error',
] as const);

/** One §7.2 collection outcome (spec §11.2, decision D-034). */
export type CollectionOutcome = (typeof COLLECTION_OUTCOMES)[number];

/** The outcome values as a plain string list, for membership checks. */
const outcomeValues: readonly string[] = COLLECTION_OUTCOMES;

/**
 * Narrows an unknown value (or the wide `CollectionOutcome | 'cancelled'`)
 * to the persisted enum — the discriminant a {@link CycleOutcome} consumer
 * uses to separate provider outcomes from the `'cancelled'` pseudo-outcome
 * before consulting `RETRYABLE_OUTCOMES` or `STATUS_CONTRIBUTION_BY_OUTCOME`.
 */
export function isCollectionOutcome(value: unknown): value is CollectionOutcome {
  return typeof value === 'string' && outcomeValues.includes(value);
}

/* ── Status priority (spec §7.3) ───────────────────────────────────────── */

/**
 * The §7.3 failure-defined account statuses in precedence order — ranks 1–3
 * of the spec's primary-status list, ahead of the time-derived
 * `Stale`/`Collecting`/`Fresh` states task 111 derives from snapshot age.
 * `Auth rejected` outranks `Format changed`, which outranks `Unreachable`.
 */
export const FAILURE_STATUS_PRECEDENCE = Object.freeze([
  'auth-rejected',
  'format-changed',
  'unreachable',
] as const);

/** A §7.3 primary account status a collection outcome can contribute to. */
export type FailureStatus = (typeof FAILURE_STATUS_PRECEDENCE)[number];

/**
 * The §7.3 status input of one outcome: a {@link FailureStatus}, or
 * `'none'` when the outcome contributes no failure status.
 */
export type StatusContribution = FailureStatus | 'none';

/**
 * §7.2's within-cycle retry eligibility: network failure, timeout, and HTTP
 * 5xx retry ("up to three retries … within the current cycle"); 429 and
 * 401/403 do not ("do not retry within the current cycle"), and neither does
 * a parse failure — §7.2's retry row covers no deterministic response
 * defect. The 2/4/8-second delays and jitter are task 106's.
 */
export const RETRYABLE_OUTCOMES: ReadonlySet<CollectionOutcome> = new Set([
  'network_error',
  'timeout',
  'server_error',
]);

/**
 * The §7.3 status contribution of every outcome — the mapping task 111
 * consumes instead of re-deciding (decision D-048):
 *
 * - `auth_error` → `Auth rejected` (§7.3 rank 1),
 * - `parse_error` → `Format changed` (rank 2),
 * - `network_error`/`timeout`/`server_error` → `Unreachable` (rank 3 —
 *   §7.3 defines it as "network issue, timeout, or 5xx", exactly these
 *   three outcomes),
 * - `rate_limited` → none: §7.3's list has no rate-limit status and
 *   `Unreachable` cannot absorb one; a 429 cycle simply was not a success,
 *   so the age-based states govern (task 111),
 * - `success` → none: a success clears failure status; freshness is
 *   time-derived, not outcome-derived.
 */
export const STATUS_CONTRIBUTION_BY_OUTCOME: Readonly<
  Record<CollectionOutcome, StatusContribution>
> = Object.freeze({
  success: 'none',
  auth_error: 'auth-rejected',
  rate_limited: 'none',
  network_error: 'unreachable',
  timeout: 'unreachable',
  server_error: 'unreachable',
  parse_error: 'format-changed',
});

/* ── Classification result ─────────────────────────────────────────────── */

/**
 * The value a caller-cancelled cycle carries in {@link CycleOutcome.outcome}
 * — deliberately outside {@link COLLECTION_OUTCOMES} so it cannot be
 * persisted as a collection outcome by accident: SQLite's CHECK rejects it
 * (pinned in `test/integration/polling-outcomes.spec.ts`).
 */
export type CancelledOutcome = 'cancelled';

/**
 * One classified collection cycle — everything §7.2/§7.3/§11.2 ask the
 * outcome to carry. Produced only by the `classify*` entry points.
 */
export interface CycleOutcome {
  /**
   * The §11.2 collection outcome, or `'cancelled'` when the caller — not
   * the provider — aborted the request (task 104's `aborted` kind).
   */
  readonly outcome: CollectionOutcome | CancelledOutcome;
  /** The HTTP status, retained whenever a response arrived (§11.2). */
  readonly httpStatus: number | undefined;
  /**
   * The raw `Retry-After` header exactly as the transport received it
   * (already scrubbed against the request's credentials, D-042); parsing
   * and the one-hour cap are task 107's.
   */
  readonly retryAfterRaw: string | undefined;
  /**
   * Whether §7.2 sanctions honoring `Retry-After` for this outcome: only a
   * 429 defers the next poll, so this is true only for `rate_limited`
   * (decision D-048). Independent of whether a header actually arrived — a
   * 429 without `Retry-After` is legal (D-034).
   */
  readonly retryAfterEligible: boolean;
  /** §7.2's within-cycle retry eligibility ({@link RETRYABLE_OUTCOMES}). */
  readonly retryable: boolean;
  /** The §7.3 status contribution ({@link STATUS_CONTRIBUTION_BY_OUTCOME}). */
  readonly statusContribution: StatusContribution;
  /**
   * Sanitized error text for §11.2's `error_message`, or `undefined` on a
   * clean success (`collection_runs_success_clean`).
   */
  readonly errorMessage: string | undefined;
}

/**
 * What an adapter reports when a delivered response fails to parse or
 * validate — §7.2's "Invalid JSON, unexpected response schema, or missing
 * required fields". `reason` is the adapter's static English, never payload
 * text: the payload's own path to storage is §7.4's sanitization pipeline
 * (task 102), not this field (§15.4).
 */
export interface ParseFailureInput {
  /** The delivered response's status (2xx in practice), when the adapter knows it. */
  readonly httpStatus?: number;
  /** Non-blank static English describing what failed. */
  readonly reason: string;
}

/* ── Internal helpers ──────────────────────────────────────────────────── */

/**
 * Validates an optional retained status against §11.2's `http_status` range
 * — the same 100–599 the `collection_runs` CHECK enforces (D-034) — so a
 * wiring bug in an adapter fails loudly here instead of at the database.
 */
function expectValidHttpStatus(value: number | undefined, caller: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new TypeError(`${caller}: httpStatus must be an integer in [100, 599]`);
  }
}

/** The evidence fields a failed classification can retain. */
interface FailureEvidence {
  readonly httpStatus?: number;
  readonly retryAfterRaw?: string;
  readonly errorMessage?: string;
}

/** Builds a failure classification from the pinned tables. */
function failedOutcome(
  outcome: Exclude<CollectionOutcome, 'success'>,
  evidence: FailureEvidence = {},
): CycleOutcome {
  return {
    outcome,
    httpStatus: evidence.httpStatus,
    retryAfterRaw: evidence.retryAfterRaw,
    retryAfterEligible: outcome === 'rate_limited',
    retryable: RETRYABLE_OUTCOMES.has(outcome),
    statusContribution: STATUS_CONTRIBUTION_BY_OUTCOME[outcome],
    errorMessage: evidence.errorMessage,
  };
}

/**
 * §7.2's status classes: 401/403 → `auth_error`, 429 → `rate_limited`,
 * 5xx → `server_error`. Every other status is a response-contract break,
 * not a provider malfunction, and classifies as `parse_error` (decision
 * D-048): the Z.ai quota endpoints are undocumented (D-038), so their drift
 * must surface as `Format changed` rather than be guessed at — and
 * `server_error` must stay 5xx-only because §7.3 equates it with
 * `Unreachable`'s "5xx". Redirects and other odd statuses cannot arrive
 * from `providerFetch` (D-042 rejects redirects at the fetch level and
 * delivers 2xx directly); classifying them anyway keeps the function total.
 */
function outcomeForHttpStatus(status: number): Exclude<CollectionOutcome, 'success'> {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  return 'parse_error';
}

/* ── Classification entry points ───────────────────────────────────────── */

/**
 * Classifies a transport failure (task 104's `TransportError`) into the
 * §7.2 collection outcome with its §7.2/§7.3/§11.2 metadata. Total over the
 * D-042 taxonomy:
 *
 * | `kind` | outcome |
 * | --- | --- |
 * | `timeout` | `timeout` |
 * | `dns`, `connection`, `socket`, `network` | `network_error` |
 * | `http-status` | by status class — see {@link outcomeForHttpStatus} |
 * | `response-too-large`, `content-type` | `parse_error` — the response was not the expected JSON contract; task 104's error classes for these carry no status to retain |
 * | `aborted` | `'cancelled'` — caller lifecycle, not a provider outcome |
 *
 * The `http-status` kind is classified only from a `TransportStatusError`
 * instance (the sole carrier of the status, D-042); a base-class
 * construction without one fails fast rather than being guessed into the
 * network family. The exhaustive switch makes any future transport kind a
 * compile error here, not a silent misclassification.
 */
export function classifyTransportError(error: TransportError): CycleOutcome {
  if (error instanceof TransportStatusError) {
    expectValidHttpStatus(error.status, 'classifyTransportError');
    return failedOutcome(outcomeForHttpStatus(error.status), {
      httpStatus: error.status,
      retryAfterRaw: error.retryAfter,
      errorMessage: error.message,
    });
  }
  switch (error.kind) {
    case 'aborted':
      return {
        outcome: 'cancelled',
        httpStatus: undefined,
        retryAfterRaw: undefined,
        retryAfterEligible: false,
        retryable: false,
        statusContribution: 'none',
        errorMessage: error.message,
      };
    case 'timeout':
      return failedOutcome('timeout', { errorMessage: error.message });
    case 'response-too-large':
    case 'content-type':
      return failedOutcome('parse_error', { errorMessage: error.message });
    case 'dns':
    case 'connection':
    case 'socket':
    case 'network':
      // The network family of D-042's taxonomy: every way the exchange
      // failed without a provider response.
      return failedOutcome('network_error', { errorMessage: error.message });
    case 'http-status':
      // Only TransportStatusError carries this kind (D-042), handled by
      // the instanceof branch above; a base-class construction has no
      // status to classify; fail fast (D-013) instead of guessing. The
      // exhaustive switch also makes a future transport kind a compile
      // error here rather than a silent network_error (review finding).
      throw new TypeError(
        'classifyTransportError: kind http-status requires a TransportStatusError',
      );
  }
}

/**
 * Classifies an adapter parse failure (§7.2's "Invalid JSON, unexpected
 * response schema, or missing required fields") as `parse_error` — the
 * `Format changed` of §7.3 — retaining the delivered response's status when
 * the adapter knows it. Not retryable: §7.2's retry row covers only network
 * failure, timeout, and 5xx, and re-reading a deterministic payload defect
 * within the cycle cannot fix it.
 */
export function classifyParseFailure(failure: ParseFailureInput): CycleOutcome {
  if (typeof failure.reason !== 'string' || failure.reason.trim() === '') {
    throw new TypeError('classifyParseFailure: reason must be a non-empty string');
  }
  expectValidHttpStatus(failure.httpStatus, 'classifyParseFailure');
  return failedOutcome('parse_error', {
    httpStatus: failure.httpStatus,
    errorMessage: failure.reason,
  });
}

/**
 * The classification of a successful cycle: outcome `success`, no error
 * message (§11.2's `collection_runs_success_clean`), no retry deferral, no
 * failure status — freshness is task 111's, derived from the snapshot's
 * collection time, not from the outcome. The 2xx status is retained when
 * the caller supplies it.
 */
export function classifySuccess(httpStatus?: number): CycleOutcome {
  expectValidHttpStatus(httpStatus, 'classifySuccess');
  return {
    outcome: 'success',
    httpStatus,
    retryAfterRaw: undefined,
    retryAfterEligible: false,
    retryable: false,
    statusContribution: 'none',
    errorMessage: undefined,
  };
}
