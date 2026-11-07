import type { AccountView } from '../../src/schemas/api/accounts';
import type { StatusAccountView } from '../../src/schemas/api/status';

/**
 * The selected account's attention classification (task 173, spec
 * §14.3/§14.6; decision D-138; the unified lifecycle verdict is D-191,
 * task FSM-2): which account-level fact keeps collection from running,
 * as one precedence-ordered token the overview renders beside the quota
 * surface — the notice component presents it, the view re-reads it for
 * the metrics region's blocked-vs-waiting wording, and this module is
 * the single source.
 *
 * The precedence is the server classifier's own, received over the wire
 * (R3, TZ-fsm §4): the §7.3 status row's token already decides archived
 * → disabled → not-configured ahead of the working statuses, so the
 * archived/disabled branches below consult the row's verdict first and
 * fall back to the accounts surface's raw facts (the storage lifecycle
 * field and the enable switch — the very inputs the server feeds the
 * same ranks) only while the status row is absent or the two loads race.
 * The notice and the badge agree whenever both loads are current; across
 * a stale load the lifecycle truth wins from whichever half is fresher
 * (the raw archived fact outranks any verdict, a verdict's archived or
 * disabled token outranks a stale raw flag). An archived account derives
 * `archived` and shows the archived notice (its fuller story), a disabled
 * account shows the disabled notice whether or not its key resolves, and
 * only an enabled account can show a keyless one.
 *
 * The keyless branches read the two wire halves for what each is worth
 * (the review round's P1): `hasKey` on the §13 accounts surface is
 * DECLARATION-level — a source is configured (§6.3's exactly-one rule)
 * — so an unresolved-`apiKeyEnv` account reads `hasKey: true` and the
 * unusable-key signal is the status row's `not-configured` (the status
 * endpoint resolves the secret through the store seam). A status row
 * that is absent (load in flight or failed) vouches for nothing: no
 * keyless notice renders beside it.
 */

/** One attention kind, most-precedent first. */
export type AccountAttention = 'archived' | 'disabled' | 'keyless-environment' | 'keyless';

/**
 * Classifies the account: `null` when nothing blocks collection.
 *
 * `statusRow` is the account's §7.3 row (`null` before that load
 * completes). The wire facts behind the branches: the reachable
 * `not-configured` account is the unresolved-`apiKeyEnv` shape —
 * declared (`hasKey: true`, `keySource: 'environment'`) but
 * unresolvable — so the environment branch keys on the status row and
 * names the server-side remedy; `hasKey: false` on an ACTIVE account is
 * the schema-total fallback no current composition produces (the config
 * contract rejects sourceless accounts, and archived accounts — the one
 * wire shape that reads `keySource: 'none'` — are classified by the
 * terminal lifecycle above), kept honest with the fix-here wording
 * rather than dropped. The storage lifecycle is the authoritative
 * archive fact even in the transient window after a partial archive
 * (the row retired, the entry removal retried): the row IS retired, so
 * the notice states the truth.
 */
export function accountAttentionOf(
  account: AccountView,
  statusRow: StatusAccountView | null,
): AccountAttention | null {
  // Ranks 0–1 over the wire first, the raw storage/enable facts beside
  // them: the row-absent window still classifies, and a stale list load
  // cannot outvote a fresher verdict (or the reverse).
  if (account.status === 'archived' || statusRow?.status === 'archived') return 'archived';
  if (!account.enabled || statusRow?.status === 'disabled') return 'disabled';
  // An environment-sourced key is read-only through the API (§6.3) —
  // only the status row can say the declared source does not resolve.
  if (account.keySource === 'environment' && statusRow?.status === 'not-configured') {
    return 'keyless-environment';
  }
  if (!account.hasKey) return 'keyless';
  return null;
}
