/**
 * Account lifecycle operations — the §8.2 archive/purge split (task 090,
 * decision D-061).
 *
 * Spec §8.2: "Deleting an account archives it while retaining history;
 * purging history requires a separate explicit action with confirmation."
 * Spec §11.2: "Use cascading deletion consistently for purged account
 * history." This module is that split as code — two operations composed
 * over the repository facade (D-058), one per path, with nothing in
 * between: retiring an account never removes a row, and purging one never
 * leaves history behind.
 *
 * - {@link retireAccount} — the default retirement. Archives the account;
 * the row and every history row stay queryable. The facade primitive is
 * archive-once (the original timestamp is immutable, D-058); this
 * operation resolves the primitive's boolean into the outcome the §13 API
 * (task 159) answers with — unknown, archived, or already-archived
 * (idempotent success).
 * - {@link purgeAccount} — the explicit destructive action. Deletes the
 * account row and lets the schema's cascading foreign keys take every
 * history table with it: collection runs, snapshots, metric values, quota
 * events, raw payloads. `sessions` and `meta` are service state, not
 * account history, and survive (D-056).
 *
 * Pinned interpretations (D-061):
 *
 * - **A sibling storage module, not facade methods** — D-058's growth
 *   rule; its reasons section listed this task's archive/purge split among
 *   the consumers that "compose from the surface without extending it".
 *   The lifecycle-outcome vocabulary stays out of the per-table facade
 *   contract, exactly as D-060 kept the classified cycle out of it.
 * - **Purge works regardless of account status** — §8.2's "separate
 *   explicit action" states no archive-first requirement; a mandatory
 *   two-step dance would be policy the spec does not carry.
 * - **The purge reports what it removed** — per-table counts captured
 *   synchronously before the single-statement delete (atomic alone,
 *   D-058). No transaction wrapping: nothing can interleave between the
 *   reads and the delete on one synchronous connection, so the counts
 *   describe exactly the rows the cascade removes.
 * - **The purge self-verifies its post-condition** — §11.2's
 *   cascading-deletion sentence enforced at runtime: after the delete, a
 *   residue sweep through the facade reads throws loudly if any history
 *   row survived. The defense targets the foreign-keys-off connection
 *   class (raw `node:sqlite` handles default the pragma off — D-056's
 *   pinned note): without the sweep, a wiring bug on the destructive path
 *   would silently orphan history rows no account query can reach.
 * - **Retirement verifies nothing at runtime** — archiving is an UPDATE on
 *   the account row and cannot endanger history; "archive keeps history"
 *   is pinned by tests, not by redundant reads.
 * - **Reactivation is out of scope** — §8.2 names no archived-to-active
 *   transition and the facade has no primitive for it; the config-sync
 *   tasks extend the surface when they need one.
 *
 * Timestamps are writer-supplied (D-021/D-058): the caller owns
 * `archivedAt`. The consumers are task 159's `DELETE /api/accounts/:id`
 * (archive by default, `?purgeHistory=true` for this purge) and the
 * configuration sync — an account removed from the configuration is
 * retired, its history retained by default.
 */

import type { AccountRecord, QuotaRepository } from './repository';

/* ── Retirement (the §8.2 default: archive, keep history) ─────────────── */

/** Input for {@link retireAccount}. */
export interface RetireAccountInput {
  readonly accountId: string;
  /** §11.1 epoch milliseconds, supplied by the writer (D-021). */
  readonly archivedAt: number;
}

/**
 * The retirement outcome. `already-archived` is a success, not an error:
 * the account is retired either way and the original archive timestamp
 * stands (D-058's archive-once semantic) — the distinction exists so the
 * API can answer idempotently instead of guessing.
 */
export type AccountRetirementOutcome =
  | { readonly result: 'unknown' }
  | { readonly result: 'archived'; readonly account: AccountRecord }
  | { readonly result: 'already-archived'; readonly account: AccountRecord };

/**
 * Retires an account the §8.2 default way: archives it, keeping the
 * account row and every history row queryable. Only an active account
 * transitions — retiring an already-archived account is a no-op that keeps
 * the original timestamp, and an unknown account reports `unknown`.
 */
export function retireAccount(
  repository: QuotaRepository,
  input: RetireAccountInput,
): AccountRetirementOutcome {
  // The facade primitive's boolean cannot distinguish unknown from
  // already-archived; the follow-up read resolves the ambiguity.
  const changed = repository.archiveAccount(input.accountId, input.archivedAt);
  const account = repository.getAccount(input.accountId);
  if (account === null) return { result: 'unknown' };
  return changed ? { result: 'archived', account } : { result: 'already-archived', account };
}

/* ── Purge (the §8.2 explicit action: cascade everything away) ────────── */

/** What a purge removed — one count per §11.2 account-history table. */
export interface PurgedHistoryCounts {
  readonly collectionRuns: number;
  readonly snapshots: number;
  readonly metricValues: number;
  readonly quotaEvents: number;
  readonly rawResponses: number;
}

/**
 * The purge outcome: the unknown-account answer, or the evidence report —
 * the account row as it stood before the purge plus what the cascade
 * removed, the confirmation flow's data.
 */
export type AccountPurgeOutcome =
  | { readonly result: 'unknown' }
  | {
      readonly result: 'purged';
      readonly account: AccountRecord;
      readonly removed: PurgedHistoryCounts;
    };

/**
 * Purges an account — §8.2's separate explicit action. Deletes the account
 * row (active or archived alike) and lets the schema's cascading foreign
 * keys remove its entire history: runs, snapshots, metric values, events,
 * and raw payloads; sessions and meta survive (D-056). Returns what was
 * removed, and throws loudly if the cascade left any history row behind —
 * see the module header for the foreign-keys-off defense (D-061).
 */
export function purgeAccount(repository: QuotaRepository, accountId: string): AccountPurgeOutcome {
  const account = repository.getAccount(accountId);
  if (account === null) return { result: 'unknown' };

  // Captured synchronously before the delete: the report's counts and the
  // residue sweep's run identities. `metric_values` has no account-level
  // facade read, so its count rides the captured run ids — every metric
  // row carries one.
  const runs = repository.listCollectionRuns(accountId);
  const removed: PurgedHistoryCounts = {
    collectionRuns: runs.length,
    snapshots: repository.listSnapshots(accountId).length,
    metricValues: runs.reduce(
      (total, run) => total + repository.getMetricValuesForRun(run.id).length,
      0,
    ),
    quotaEvents: repository.listQuotaEvents(accountId).length,
    rawResponses: repository.listRawResponses(accountId).length,
  };

  repository.deleteAccount(accountId);

  // The post-condition sweep — §11.2's cascading deletion enforced. Any
  // surviving row means the cascade never fired (a foreign-keys-off
  // connection), and a destructive action must fail loudly instead of
  // reporting success over orphaned history.
  const survived: string[] = [];
  if (repository.listCollectionRuns(accountId).length > 0) survived.push('collection runs');
  if (repository.listSnapshots(accountId).length > 0) survived.push('snapshots');
  if (runs.some((run) => repository.getMetricValuesForRun(run.id).length > 0)) {
    survived.push('metric values');
  }
  if (repository.listQuotaEvents(accountId).length > 0) survived.push('quota events');
  if (repository.listRawResponses(accountId).length > 0) survived.push('raw responses');
  if (survived.length > 0) {
    throw new Error(
      `purgeAccount: history survived the cascade delete of account '${accountId}' ` +
        `(${survived.join(', ')}); is foreign_keys disabled on this connection?`,
    );
  }
  return { result: 'purged', account, removed };
}
