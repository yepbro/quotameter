/**
 * Cycle persistence — the run writer behind the settle seam (spec §7.2, §11.1;
 * task 110, decision D-069).
 *
 * Spec §11.1: "Store a run record for every collection cycle, successful or
 * unsuccessful. Write the snapshot, its metric rows, and associated events in
 * one transaction." Task 089 built that transaction
 * (`persistCollectionCycle`, D-060); task 109 built the engine that runs the
 * cycles (D-066); this module is the seam between them —
 * {@link createCycleRecorder} produces one account's D-066 closure pair:
 *
 * - `attempt(signal)` is the raw §8.1 cycle attempt — the single
 *   `fetchSnapshot` call D-059's wrapper needs unwrapped (retry eligibility
 *   reads the thrown `TransportError`) — and stamps the cycle's wall-clock
 *   start (§7.1's "store actual wall-clock collection timestamps": the run
 *   row's `started_at` is a real reading at the cycle's first attempt, not a
 *   settle-time reconstruction, and later retries of the same cycle do not
 *   move it);
 * - `settleCycle(result)` receives the retried cycle's final result, classifies
 *   it with task 105 (D-048), maps it into D-060's `CollectionCycleWrite`, and
 *   hands it to the transactional writer — one `collection_runs` row per
 *   cycle, a snapshot (with its metric rows) only for a successful one. The
 *   classification is the return value the engine gates on (suspension
 *   transitions, `Retry-After` deferral, the next schedule); nothing here
 *   re-decides any of their policies.
 *
 * Pinned interpretations (D-069):
 *
 * - **A cancelled cycle is deliberately unpersisted.** D-048 kept the caller
 *   abort outside the seven-value outcome enum precisely so no writer could
 *   store it by accident, and left the record-or-skip call to this task: a
 *   `stop()` abort is service lifecycle, not a provider failure — §12.2's
 *   timeline already distinguishes "failed collection cycles" (non-success
 *   run rows) from "periods with no collection-run records" (the service was
 *   stopped), and a shutdown abort belongs to the second class. The
 *   classification is still returned (the engine consumes it), the database
 *   is not touched.
 * - **An error outside both taxonomies throws.** A non-`TransportError`
 *   rejection that does not carry the adapter parse-failure fields is a
 *   programming mistake (a wiring bug, a broken adapter); fabricating one of
 *   the seven provider outcomes for it would lie in the audit trail, so it
 *   fails fast (`TypeError`) and is contained by the engine's §7.2 isolation
 *   — the same fail-fast D-059 applies to a broken seam.
 * - **A provider-level success that fails §8.4 validation is a
 *   `parse_error` run without a snapshot.** D-066 types the settled value
 *   `unknown`, so the seam must narrow it; a value that is not a valid
 *   `ProviderSnapshot` (or whose `providerId` is not the collecting
 *   adapter's) never becomes rows — §11.1's "a run record for every cycle"
 *   still holds, the account surfaces `Format changed`, and no snapshot can
 *   exist for it (D-036 keeps that structural in SQL as well).
 * - **The §7.4 payload hand-off is consumed structurally.** Services may not
 *   import a concrete adapter (the layout's adapter-island rule), so the
 *   parse failure is recognized by its public field shape — `reason`
 *   (non-blank static English), `sanitizedPayload` (the already-sanitized
 *   §7.4 body), `httpStatus` (absent or 100–599) — mirroring the Z.ai
 *   adapter's `SnapshotParseError`; the unit spec pins the narrowing against
 *   that real class.
 * - **`retry_after_seconds` is D-062's decision at the settle reading.**
 *   `deferNextPoll(classified, endedAt)` is the single canonical eligibility
 *   and cap rule; `seconds` is persisted when deferred, `NULL` otherwise (an
 *   ineligible, absent, or malformed header stores nothing). The engine
 *   re-derives its gate from a marginally later wall reading — both derive
 *   from the same header under the same one-hour cap; the stored value is
 *   evidence, not the gate.
 * - **Timestamps are readings, never computed** (§7.1, D-021):
 *   `started_at` is read at the attempt, `ended_at` and the §7.4
 *   `captured_at` at the settle (a parse failure is un-retried, so the
 *   settle reading is milliseconds from the response's arrival), and the
 *   snapshot's `collected_at` is the adapter's own §8.4 stamp. Durations stay
 *   monotonic in the engine; this module stores wall readings only.
 * - **`intervalSeconds` is read at settle** — §11.2's "interval in effect" at
 *   the cycle, not at recorder construction; the composition root wires the
 *   closure to the live configuration.
 * - **`events` arrives empty for now.** §12.1 reset detection (tasks 117/118)
 *   produces its events as data before D-060's writer is called; this
 *   recorder is where that detector will plug in, so the success write
 *   already carries the (empty) array through the same transaction.
 */

import type { AccountContext, QuotaProvider } from '../providers/registry';
import { TransportError } from '../providers/transport';
import {
  findProviderSnapshotProblems,
  type NormalizedMetric,
  type ProviderSnapshot,
} from '../schemas/metrics';
import type { QuotaRepository } from '../storage/repository';
import {
  persistCollectionCycle,
  type CollectionCycleWrite,
  type CycleMetricInput,
  type CycleRawResponseInput,
} from '../storage/collection-cycles';
import type { Clock } from '../util/clock';
import {
  classifyParseFailure,
  classifySuccess,
  classifyTransportError,
  type CollectionOutcome,
  type CycleOutcome,
} from './polling-outcomes';
import type { CycleRetryResult } from './polling-retry';
import { deferNextPoll } from './polling-retry-after';

/* ── Options and the recorder ──────────────────────────────────────────── */

/** Options adjusting {@link createCycleRecorder}. */
export interface CycleRecorderOptions {
  /** The account being polled (D-013's branded context — the secret stops at the adapter). */
  readonly account: AccountContext;
  /** The §8.1 provider adapter that collects this account's snapshots. */
  readonly provider: QuotaProvider;
  /** The storage facade — every cycle write goes through D-060's transaction. */
  readonly repository: QuotaRepository;
  /** The injected clock (D-021): wall readings for the run row and the §7.4 payload. */
  readonly clock: Clock;
  /**
   * The §7.1 polling interval in effect, in seconds, read once per cycle at
   * settle time — the composition root wires this to the live configuration
   * so a runtime interval change (§6.4) is reflected from the next cycle on.
   */
  readonly intervalSeconds: () => number;
}

/**
 * One account's cycle wiring — D-066's closure pair, shaped to spread into a
 * {@link import('./polling-scheduler').PollingAccount} beside its
 * `accountId`/`keyIdentity`. The pair shares one per-cycle timing cell, safe
 * because the engine's per-account serialization is structural (an account
 * with a live flight is never dispatchable).
 */
export interface CycleRecorder {
  /**
   * The raw cycle attempt: stamps the cycle's wall-clock start (the first
   * attempt's reading — the wrapper may invoke this closure up to four times
   * per cycle), then makes the single `fetchSnapshot` call. Transport and
   * parse failures reject unchanged — D-059's wrapper and this module's
   * classification read them.
   */
  readonly attempt: (signal: AbortSignal) => Promise<ProviderSnapshot>;
  /**
   * Classifies the retried cycle (105), persists it through D-060's
   * transactional writer (one run row always; the snapshot, its metric rows,
   * and — for a parse failure — the §7.4 payload per the outcome), and
   * returns the classification the engine gates on. Throws only on
   * programming mistakes (no recorded attempt, an error outside both
   * taxonomies, a broken clock or storage seam); the engine contains a throw
   * per §7.2 isolation.
   */
  readonly settleCycle: (result: CycleRetryResult<unknown>) => CycleOutcome;
}

/* ── Internal helpers ──────────────────────────────────────────────────── */

/** A guarded wall reading — the same guard the scheduler applies to its own. */
function wallNow(clock: Clock): number {
  const value = clock.now();
  if (!Number.isFinite(value)) {
    throw new TypeError('cycle recorder: clock.now() must be finite');
  }
  return value;
}

/**
 * The §8.4 problems of a settled value plus this seam's own cross-check: the
 * snapshot must claim the adapter that collected it. `unknown` is the seam's
 * input type (D-066), so the narrowing is mandatory, not re-validation — a
 * non-object value cannot even enter `findProviderSnapshotProblems`.
 */
function findSnapshotProblems(value: unknown, providerId: string): string[] {
  if (typeof value !== 'object' || value === null) {
    return ['the settled value is not a snapshot object'];
  }
  const snapshot = value as ProviderSnapshot;
  const problems = findProviderSnapshotProblems(snapshot);
  if (problems.length === 0 && snapshot.providerId !== providerId) {
    // Value-free on the distrusted side: the settled `providerId` is exactly
    // the kind of adapter-controlled string this branch exists to distrust,
    // so only the trusted collecting adapter's id is quoted (review P3).
    problems.push(`providerId: does not match the collecting adapter '${providerId}'`);
  }
  return problems;
}

/** The adapter parse failure as this layer may see it (the §7.4 hand-off). */
interface AdapterParseFailure {
  readonly reason: string;
  readonly httpStatus: number | undefined;
  readonly sanitizedPayload: string;
}

/**
 * Recognizes an adapter parse failure structurally: an `Error` carrying the
 * non-blank static-English `reason`, the sanitized §7.4 `sanitizedPayload`,
 * and — when present — an HTTP status in §11.2's 100–599 retention range.
 * Services may not import a concrete adapter, so the field shape (pinned on
 * the Z.ai `SnapshotParseError`) is the contract; anything else returns
 * `undefined` and falls through to the fail-fast branch.
 */
function adapterParseFailure(error: unknown): AdapterParseFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const { reason, httpStatus, sanitizedPayload } = error as unknown as Record<string, unknown>;
  if (typeof reason !== 'string' || reason.trim() === '') return undefined;
  if (typeof sanitizedPayload !== 'string') return undefined;
  if (httpStatus !== undefined) {
    if (
      typeof httpStatus !== 'number' ||
      !Number.isInteger(httpStatus) ||
      httpStatus < 100 ||
      httpStatus > 599
    ) {
      return undefined;
    }
  }
  return { reason, httpStatus: httpStatus as number | undefined, sanitizedPayload };
}

/**
 * Maps one §8.4 metric to its row input: `key` becomes `metricKey`, the
 * display `label` is dropped (§11.2's row omits it, D-039), and the optional
 * numeric fields are made explicitly null — the named CHECKs remain the
 * write gate (D-060), nothing is re-validated here.
 */
function toMetricInput(metric: NormalizedMetric): CycleMetricInput {
  return {
    metricKey: metric.key,
    limitType: metric.limitType,
    unit: metric.unit,
    windowSeconds: metric.windowSeconds ?? null,
    used: metric.used ?? null,
    remaining: metric.remaining ?? null,
    limit: metric.limit ?? null,
    percentUsed: metric.percentUsed ?? null,
    percentRemaining: metric.percentRemaining ?? null,
    resetsAt: metric.resetsAt ?? null,
    isValid: metric.isValid,
    invalidReason: metric.invalidReason ?? null,
    derivedFields: metric.derivedFields ?? null,
  };
}

/** The run identity and timing every persisted cycle shares (§11.2). */
interface CycleEvidence {
  readonly accountId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly intervalSeconds: number;
  readonly attempts: number;
}

/**
 * The write for any failed cycle — every outcome except `'success'` (only the
 * ok-branch classifies it) and `'cancelled'` (returned unpersisted); the
 * callers exclude both by construction, so the assertion is the one place the
 * vocabulary is narrowed. `retryAfterSeconds` is D-062's decision at the
 * settle reading; the parse-failure payload rides the same transaction.
 */
function failureCycleWrite(
  classified: CycleOutcome,
  evidence: CycleEvidence,
  rawResponse: CycleRawResponseInput | null,
): CollectionCycleWrite {
  const failure = classified as CycleOutcome & {
    readonly outcome: Exclude<CollectionOutcome, 'success'>;
  };
  const defer = deferNextPoll(failure, evidence.endedAt);
  const base = {
    accountId: evidence.accountId,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    intervalSeconds: evidence.intervalSeconds,
    attempts: evidence.attempts,
    httpStatus: failure.httpStatus ?? null,
    errorMessage: failure.errorMessage ?? null,
    retryAfterSeconds: defer.deferred ? defer.seconds : null,
  };
  if (failure.outcome === 'parse_error') {
    return rawResponse === null
      ? { ...base, outcome: 'parse_error' }
      : { ...base, outcome: 'parse_error', rawResponse };
  }
  return { ...base, outcome: failure.outcome };
}

/* ── The factory ───────────────────────────────────────────────────────── */

/**
 * Creates one account's cycle recorder. The returned pair is complete wiring
 * for D-066's engine: register it beside the account's `accountId` and
 * `keyIdentity`, and every cycle the engine runs for that account lands in
 * `collection_runs` (with its snapshot exactly when the provider cycle
 * succeeded at §8.4 validation).
 */
export function createCycleRecorder(options: CycleRecorderOptions): CycleRecorder {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createCycleRecorder: options must be a CycleRecorderOptions');
  }
  const { account, provider, repository, clock, intervalSeconds } = options;
  if (
    typeof account !== 'object' ||
    account === null ||
    typeof account.accountId !== 'string' ||
    account.accountId.trim() === ''
  ) {
    throw new TypeError('createCycleRecorder: account must be an AccountContext');
  }
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.id !== 'string' ||
    provider.id.trim() === '' ||
    typeof provider.fetchSnapshot !== 'function'
  ) {
    throw new TypeError('createCycleRecorder: provider must be a QuotaProvider');
  }
  if (
    typeof repository !== 'object' ||
    repository === null ||
    typeof repository.withTransaction !== 'function' ||
    typeof repository.insertCollectionRun !== 'function'
  ) {
    throw new TypeError('createCycleRecorder: repository must be a QuotaRepository');
  }
  if (typeof clock !== 'object' || clock === null || typeof clock.now !== 'function') {
    throw new TypeError('createCycleRecorder: clock must be a Clock (D-021)');
  }
  if (typeof intervalSeconds !== 'function') {
    throw new TypeError('createCycleRecorder: intervalSeconds must be a function');
  }

  // One cell per recorder: the engine never runs a second cycle for an
  // account while one is in flight (D-066), so attempt→settle pairs cannot
  // interleave. Cleared at settle, so a settle without a preceding attempt —
  // or a second settle for one cycle — is a loud wiring bug.
  let cycleStartedAtEpochMs: number | undefined;

  const attempt = (signal: AbortSignal): Promise<ProviderSnapshot> => {
    // The cycle's start is the FIRST attempt's: D-059's wrapper invokes this
    // closure up to four times per cycle, and §11.2's run row spans them all
    // (attempts 4 with a 60 s started_at→ended_at span would understate a
    // worst-case cycle by ~195 s). Taken once and kept; cleared at settle.
    cycleStartedAtEpochMs ??= wallNow(clock);
    return provider.fetchSnapshot(account, signal);
  };

  const settleCycle = (result: CycleRetryResult<unknown>): CycleOutcome => {
    const startedAt = cycleStartedAtEpochMs;
    if (startedAt === undefined) {
      throw new TypeError('settleCycle: no cycle attempt was recorded for this account');
    }
    cycleStartedAtEpochMs = undefined;
    const endedAt = wallNow(clock);
    const evidence: CycleEvidence = {
      accountId: account.accountId,
      startedAt,
      endedAt,
      intervalSeconds: intervalSeconds(),
      attempts: result.attempts,
    };

    if (result.ok) {
      const problems = findSnapshotProblems(result.value, provider.id);
      if (problems.length === 0) {
        // Sound: the problem finder has verified every §8.4 field of value.
        const snapshot = result.value as ProviderSnapshot;
        const classified = classifySuccess();
        persistCollectionCycle(repository, {
          ...evidence,
          httpStatus: classified.httpStatus,
          outcome: 'success',
          snapshot: {
            collectedAt: snapshot.collectedAt,
            planName: snapshot.planName,
            metrics: snapshot.metrics.map(toMetricInput),
            // §12.1 detection (117/118) plugs in here; until then a
            // successful cycle carries its snapshot with no events.
            events: [],
          },
        });
        return classified;
      }
      const classified = classifyParseFailure({
        reason: `adapter returned an invalid snapshot: ${problems.join('; ')}`,
      });
      persistCollectionCycle(repository, failureCycleWrite(classified, evidence, null));
      return classified;
    }

    const error = result.error;
    if (error instanceof TransportError) {
      const classified = classifyTransportError(error);
      if (classified.outcome === 'cancelled') {
        // Caller lifecycle (D-048): deliberately unpersisted (D-069).
        return classified;
      }
      persistCollectionCycle(repository, failureCycleWrite(classified, evidence, null));
      return classified;
    }

    const parseFailure = adapterParseFailure(error);
    if (parseFailure !== undefined) {
      const classified = classifyParseFailure({
        httpStatus: parseFailure.httpStatus,
        reason: parseFailure.reason,
      });
      const rawResponse: CycleRawResponseInput = {
        capturedAt: endedAt,
        httpStatus: parseFailure.httpStatus ?? null,
        contentType: null,
        body: parseFailure.sanitizedPayload,
      };
      persistCollectionCycle(repository, failureCycleWrite(classified, evidence, rawResponse));
      return classified;
    }

    throw new TypeError(
      `settleCycle: cycle error is neither a TransportError nor an adapter parse failure (${
        error instanceof Error ? error.constructor.name : typeof error
      })`,
    );
  };

  return { attempt, settleCycle };
}
