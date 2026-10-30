/**
 * Raw-response retention — §7.4's per-account cap (task 103, decision D-067).
 *
 * Spec §7.4: "retain no more than 20 responses per account and no more than
 * 30 days". The 30-day half is time-based and landed with task 091
 * (`deleteRawResponsesBefore` inside `retention-cleanup.ts`, D-063 — that
 * module "never counts records, it only expires age"). This module is the
 * count-based half: {@link enforceRawResponseCap} keeps an account's newest
 * {@link RAW_RESPONSE_MAX_PER_ACCOUNT} payloads and deletes the rest,
 * composing exactly the two primitives D-058 designed for it —
 * `listRawResponses` (newest first, deterministic `captured_at`/`run_id`
 * order) and `deleteRawResponsesByRunIds` (identity delete; no global cutoff
 * can express a per-account cap).
 *
 * Pinned interpretations (D-067):
 *
 * - **A sibling storage module, not facade methods** — the fourth application
 *   of the D-060/D-061/D-063 growth rule; the cap vocabulary and §7.4 policy
 *   constant stay out of the per-table facade contract, and no new SQL
 *   exists — only public facade calls.
 * - **The cap is fixed policy, not configuration** — §7.4 names one number
 *   (20), exactly as its 30-day window is fixed (`RAW_RESPONSE_MAX_AGE_DAYS`,
 *   D-063); changing either is a successor decision, never a setting.
 * - **Enforcement runs at the write moment, not on a schedule or on read.**
 *   `persistCollectionCycle` calls this function inside the cycle's own
 *   transaction (spec §11.1) whenever it stores a §7.4 payload, so after any
 *   committed parse-failure cycle the account holds at most 20 payloads —
 *   continuously true, not eventually true. A daily-pass cap would let a
 *   format-change failure storm retain hundreds of rows between cleanups
 *   (§7.1's 60 s floor alone allows ~1 400 cycles/day); capping on the CLI
 *   read would be cosmetic — the rows would still be retained. Task 110
 *   drives every cycle through the 089 seam (D-060), so no sanctioned write
 *   path can bypass the cap.
 * - **One pass repairs any overshoot.** The listing is unbounded on purpose:
 *   a state seeded through the facade directly (tests, a future import
 *   tool), or a successor decision that lowers the cap, is cut back to the
 *   newest 20 by a single call — overshoot is never unreachable garbage.
 *   One safe ceiling is accepted and documented rather than chunked: the
 *   eviction is one `IN (…)` statement, so a pathological facade-seeded
 *   state with more rows past the cap than SQLite's variable ceiling
 *   (~32 766 on the pinned runtime) fails that statement loudly — nothing
 *   is partially deleted, and inside the write path the whole cycle rolls
 *   back — a state the sanctioned write path cannot produce (it evicts at
 *   most one row per cycle).
 * - **Eviction deletes payloads only.** The dropped rows' `collection_runs`
 *   records survive (the run is the §11.1 history unit; §7.4 caps the
 *   payload, not the run), and every other account is untouched — the
 *   listing is account-scoped by construction.
 *
 * Exposure is not this module's concern — §7.4's "only through
 * `quotameter doctor --raw <account>` (never over HTTP or in the web UI)" is
 * enforced structurally by `test/unit/raw-response-gate.spec.ts`, which
 * confines raw-payload identifiers to `src/storage/` and the CLI diagnostic
 * read path (`src/cli/raw-diagnostics.ts`).
 */

import type { QuotaRepository } from './repository';

/** §7.4's raw-payload record cap per account — fixed policy, not configuration. */
export const RAW_RESPONSE_MAX_PER_ACCOUNT = 20;

/** What one enforcement pass did. */
export interface RawResponseCapResult {
  /** Payloads the account retains after the pass — at most the cap. */
  readonly retained: number;
  /** Payloads beyond the cap this pass deleted. */
  readonly evicted: number;
}

/**
 * Enforces §7.4's per-account cap: keeps the account's newest
 * {@link RAW_RESPONSE_MAX_PER_ACCOUNT} raw payloads (the facade's
 * `captured_at DESC, run_id DESC` ordering — the run-id tiebreak makes
 * same-instant eviction deterministic) and deletes the rest by run id.
 * Returns what the pass did; a no-op pass (`retained <= 20`) deletes
 * nothing. Throws before touching any row when `accountId` is blank — a
 * wiring bug, not a data state (the D-063 policy-input fail-fast).
 */
export function enforceRawResponseCap(
  repository: QuotaRepository,
  accountId: string,
): RawResponseCapResult {
  if (accountId.trim().length === 0) {
    throw new Error('enforceRawResponseCap: accountId must be a non-blank string (spec §7.4)');
  }
  const retainedRows = repository.listRawResponses(accountId);
  // Newest first, so the tail is the eviction set — oldest first within it.
  const evictedRunIds = retainedRows.slice(RAW_RESPONSE_MAX_PER_ACCOUNT).map((row) => row.runId);
  repository.deleteRawResponsesByRunIds(evictedRunIds);
  return { retained: retainedRows.length - evictedRunIds.length, evicted: evictedRunIds.length };
}
