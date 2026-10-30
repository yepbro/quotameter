/**
 * Atomic collection-cycle persistence — the §11.1 write path (task 089,
 * decision D-060).
 *
 * Spec §11.1: "Store a run record for every collection cycle, successful or
 * unsuccessful. Write the snapshot, its metric rows, and associated events
 * in one transaction." {@link persistCollectionCycle} is that transaction:
 * one call takes a complete classified cycle (task 105's outcome vocabulary,
 * D-048) and writes every row it implies inside the repository's
 * {@link QuotaRepository.withTransaction} seam (D-058) — the run row always;
 * the snapshot, its metric rows, and its reset events together for a
 * successful cycle; the §7.4 sanitized payload alongside the run for a
 * parse-failure cycle. Any failure — a named CHECK rejecting a row, a UNIQUE
 * collision, or a driver-level throw — rolls the whole cycle back and
 * propagates unchanged: a run row can never survive without its snapshot, a
 * snapshot never without its metric rows, an event never without the
 * snapshot it evidences. That is this task's done-condition ("injected
 * failures leave no partial snapshot"), verified at every insert position by
 * `test/integration/collection-cycles.spec.ts` (§17.1 failure injection).
 *
 * Pinned interpretations (D-060):
 *
 * - **A sibling storage module, not a facade method.** D-058 designed the
 *   repository surface so this orchestration composes it without extension;
 *   the classified-cycle vocabulary (the services-facing hand-off task 110
 *   drives) stays out of the per-table facade contract, and composing the
 *   public methods is also what makes position-targeted failure injection
 *   testable through a delegating proxy — a facade method would call its
 *   sibling closures directly.
 * - **The writer supplies every identity field.** Metric, event, and
 *   raw-payload inputs carry no `accountId`/`runId`/`collectedAt`; this
 *   function injects the cycle's account, the run id the database assigned,
 *   and the snapshot's collection time into each row. Denormalization drift
 *   (D-039) and a wrong-account event (D-046) are unrepresentable in the
 *   input shape — the composite foreign keys stay as the structural
 *   backstop, not the first line of defense.
 * - **No pre-validation, no error wrapping** — the named CHECK constraints
 *   remain the write gate (D-058); nothing is re-checked here and nothing
 *   is swallowed.
 * - **The failure branches own the failure evidence.** `errorMessage` and
 *   `retryAfterSeconds` exist only on non-success cycles, so
 *   `collection_runs_success_clean` is unviolable by construction, and only
 *   a parse-failure cycle can express a raw payload — the sole outcome §7.4
 *   sanctions (the D-051 linkage is structural in SQL as well).
 * - **Timestamps are writer-supplied** (D-021/D-058): the caller owns
 *   `startedAt`/`endedAt`/`collectedAt`/`eventAt`; nothing here reads a
 *   clock. `eventAt` is deliberately not defaulted to the snapshot's time —
 *   §12.1 makes it its own value (D-046).
 *
 * Task 110 (the poller) classifies a cycle and hands it to this seam;
 * reset-event **detection** (§12.1, tasks 117/118) and scheduling happen
 * before the call — the events array arrives as data.
 */

import type {
  NewMetricValue,
  NewQuotaEvent,
  NewRawResponse,
  NewSnapshot,
  QuotaRepository,
  RunOutcome,
} from './repository';

/* ── Identity-free row inputs (the facade rows minus what this writer adds) ── */

/**
 * One metric row of a cycle snapshot: `NewMetricValue` minus the identity
 * fields {@link persistCollectionCycle} supplies — the cycle's account, the
 * assigned run id, and the snapshot's `collectedAt` (the D-039 pinning).
 */
export type CycleMetricInput = Omit<NewMetricValue, 'accountId' | 'runId' | 'collectedAt'>;

/**
 * One reset event riding a cycle snapshot: `NewQuotaEvent` minus the account
 * and run identity. `eventAt` stays writer-supplied — §12.1's rule makes it
 * the previous point's `resetsAt` or the new snapshot's time, its own value
 * (D-046); this writer never defaults it.
 */
export type CycleEventInput = Omit<NewQuotaEvent, 'accountId' | 'runId'>;

/**
 * The §7.4 sanitized parse-failure payload of a cycle: `NewRawResponse`
 * minus the account and run identity.
 */
export type CycleRawResponseInput = Omit<NewRawResponse, 'accountId' | 'runId'>;

/* ── The classified cycle (the task-110 hand-off) ──────────────────────── */

/**
 * The snapshot of a successful cycle: the `NewSnapshot` header fields plus
 * the metric rows and reset events that §11.1 writes with it in one
 * transaction. Either array may be empty — §11.1 stores a snapshot for every
 * successful collection, and the §8.4 boundary admits zero-metric snapshots.
 */
export interface SuccessfulCycleSnapshot extends Omit<NewSnapshot, 'accountId' | 'runId'> {
  readonly metrics: ReadonlyArray<CycleMetricInput>;
  readonly events: ReadonlyArray<CycleEventInput>;
}

/** Run identity and timing fields every collection cycle shares (§11.2). */
interface CollectionCycleRunFields {
  readonly accountId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly intervalSeconds: number;
  readonly attempts: number;
  readonly httpStatus?: number | null;
}

/** Evidence fields a failed cycle carries beyond the run identity/timing. */
interface FailedCycleFields extends CollectionCycleRunFields {
  /** Already-sanitized text (§7.2); absent on a success cycle by structure. */
  readonly errorMessage?: string | null;
  /** §7.2's deferral evidence; retained whenever a `Retry-After` applied. */
  readonly retryAfterSeconds?: number | null;
}

/** A successful cycle: the run row plus its snapshot written atomically. */
export interface SuccessfulCollectionCycle extends CollectionCycleRunFields {
  readonly outcome: 'success';
  readonly snapshot: SuccessfulCycleSnapshot;
}

/**
 * A parse-failure cycle: the run row plus, optionally, the §7.4 sanitized
 * payload — the only outcome that may carry one (D-051).
 */
export interface ParseFailureCollectionCycle extends FailedCycleFields {
  readonly outcome: 'parse_error';
  readonly rawResponse?: CycleRawResponseInput | null;
}

/**
 * Any other failed cycle (§7.2's remaining outcome classes): the run row
 * only — no snapshot exists for it, structurally (D-036) and here by code.
 */
export interface NonParseFailureCollectionCycle extends FailedCycleFields {
  readonly outcome: Exclude<RunOutcome, 'success' | 'parse_error'>;
}

/**
 * One complete, classified collection cycle ready to persist — the shape
 * task 110 hands to {@link persistCollectionCycle}. The `outcome` literal
 * discriminates the branches, so a success cycle cannot express an error
 * message and a non-parse failure cannot express a raw payload.
 */
export type CollectionCycleWrite =
  SuccessfulCollectionCycle | ParseFailureCollectionCycle | NonParseFailureCollectionCycle;

/* ── The atomic write ──────────────────────────────────────────────────── */

/**
 * Persists one collection cycle atomically (spec §11.1) and returns the
 * database-assigned run id. Every row of the cycle — the run record, and
 * for a successful cycle the snapshot, its metric rows, and its reset
 * events (for a parse-failure cycle, the §7.4 payload) — commits in one
 * transaction; any throw rolls the whole cycle back and propagates
 * unchanged. The named CHECK constraints are the write gate (D-058): this
 * function validates nothing beforehand and wraps no error.
 */
export function persistCollectionCycle(
  repository: QuotaRepository,
  cycle: CollectionCycleWrite,
): number {
  return repository.withTransaction((tx) => {
    const runId = tx.insertCollectionRun({
      accountId: cycle.accountId,
      startedAt: cycle.startedAt,
      endedAt: cycle.endedAt,
      intervalSeconds: cycle.intervalSeconds,
      outcome: cycle.outcome,
      httpStatus: cycle.httpStatus ?? null,
      // The failure branches are the only ones carrying these fields, so
      // the success-clean and evidence shapes hold by construction.
      errorMessage: cycle.outcome === 'success' ? null : (cycle.errorMessage ?? null),
      attempts: cycle.attempts,
      retryAfterSeconds: cycle.outcome === 'success' ? null : (cycle.retryAfterSeconds ?? null),
    });

    if (cycle.outcome === 'success') {
      const { collectedAt, planName, metrics, events } = cycle.snapshot;
      tx.insertSnapshot({
        accountId: cycle.accountId,
        runId,
        collectedAt,
        planName: planName ?? null,
      });
      // One insert call carries the whole batch — a mid-batch failure (a
      // duplicate key, an invalid row) throws partway and takes the
      // already-written rows down with the transaction.
      tx.insertMetricValues(
        metrics.map((metric) => ({
          ...metric,
          accountId: cycle.accountId,
          runId,
          collectedAt,
        })),
      );
      for (const event of events) {
        tx.insertQuotaEvent({ ...event, accountId: cycle.accountId, runId });
      }
      return runId;
    }

    if (
      cycle.outcome === 'parse_error' &&
      cycle.rawResponse !== undefined &&
      cycle.rawResponse !== null
    ) {
      tx.insertRawResponse({ ...cycle.rawResponse, accountId: cycle.accountId, runId });
    }
    return runId;
  });
}
