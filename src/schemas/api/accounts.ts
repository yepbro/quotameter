/**
 * The §13 accounts endpoint contracts (task 159, spec §13, §6.3, §8.2;
 * decision D-128).
 *
 * TypeBox definitions for every request and response of the five accounts
 * routes — the schemas the routes validate through and serialize through,
 * and the ones task 163 generates OpenAPI from (§13: "Define every request
 * and response through TypeBox/JSON Schema"). Placement follows the layer
 * rule of `src/schemas/README.md`: pure contract data, leaf within the
 * schemas layer; the behavior lives in `src/server/api/accounts.ts`.
 *
 * The write-only-key discipline (§13/§6.3/§15.4) is structural here: every
 * response object is **closed** (`additionalProperties: false`), so the
 * compiled serializer emits exactly the declared keys and drops any other
 * — a handler bug that returned the secret could not put it on the wire
 * (the D-111 health precedent, generalized to the whole accounts surface).
 * What the views carry instead of the key: `hasKey` (the §13 boolean) and
 * `keyMask` — the constant {@link ACCOUNT_KEY_MASK}, content-free by
 * construction (not even the key's length is derived from it).
 */

import { type Static, Type } from '@sinclair/typebox';
import { ID_PATTERN } from '../config';

/* ── The mask (§13: "Return only a mask and a boolean") ─────────────────── */

/**
 * The mask a configured key renders as — a fixed 8-asterisk literal,
 * deliberately NOT derived from key material (no prefix/suffix echo, no
 * length hint): §15.4's "never return API keys" read strictly, so the
 * response communicates exactly "a key is configured" and nothing else.
 */
export const ACCOUNT_KEY_MASK = '********';

/* ── The account view (GET list, POST/PATCH responses) ──────────────────── */

/**
 * One account as the §13 management API reports it — the merged view of the
 * configuration entry (label/enabled/secret state, §6.2/§6.3) and the
 * storage row (lifecycle status, plan, timestamps, §8.2/§11.2). Nullable
 * fields cover the merge's honest gaps: an account configured but not yet
 * mirrored into storage has no `createdAt`/`planName` (the config-sync is
 * composition wiring), and an archived account removed from the
 * configuration has no key state (`keySource: 'none'`, `hasKey: false`).
 */
export const AccountViewSchema = Type.Object(
  {
    /** Stable account identifier (the §6.2 charset, also the API path parameter). */
    id: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    /** Provider adapter identifier (registry membership). */
    providerId: Type.String({ minLength: 1, description: 'Provider adapter id.' }),
    /** Display label (the configuration's current value wins over the row). */
    label: Type.String({ minLength: 1, description: 'Display label.' }),
    /** Polling on/off — the configuration's `enabled` (§6.2). */
    enabled: Type.Boolean({ description: 'Whether the account is polled.' }),
    /** Lifecycle status of the storage row (§8.2); `'active'` when no row exists yet. */
    status: Type.Union([Type.Literal('active'), Type.Literal('archived')], {
      description: 'Lifecycle status.',
    }),
    /** §13's boolean: whether a secret source is configured. */
    hasKey: Type.Boolean({ description: 'Whether an API key is configured.' }),
    /**
     * Where the secret comes from — `'file'` (config-stored `apiKey`),
     * `'environment'` (`apiKeyEnv`, read-only through the API, §6.3), or
     * `'none'` (no configuration entry: an archived account).
     */
    keySource: Type.Union([
      Type.Literal('file'),
      Type.Literal('environment'),
      Type.Literal('none'),
    ]),
    /** The constant {@link ACCOUNT_KEY_MASK} when `hasKey`, else `null`. */
    keyMask: Type.Union([Type.String(), Type.Null()], { description: 'Key mask or null.' }),
    /** Plan name from the latest snapshot (§8.4); `null` when never collected. */
    planName: Type.Union([Type.String(), Type.Null()], { description: 'Plan name or null.' }),
    /** Row creation time, §11.1 epoch milliseconds; `null` before the row exists. */
    createdAt: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Creation time (epoch ms) or null.',
    }),
    /** Archive time (§8.2); `null` while active. */
    archivedAt: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Archive time (epoch ms) or null.',
    }),
  },
  { additionalProperties: false },
);

/** The shape every single-account response serializes to. */
export type AccountView = Static<typeof AccountViewSchema>;

/** `GET /api/accounts` — the management list, id-ascending (deterministic). */
export const AccountsListResponseSchema = Type.Object(
  { accounts: Type.Array(AccountViewSchema) },
  { additionalProperties: false },
);

/** The shape `GET /api/accounts` answers with. */
export type AccountsListResponse = Static<typeof AccountsListResponseSchema>;

/* ── POST /api/accounts — create (§13: "key is write-only") ─────────────── */

/**
 * The create body. `id` is optional — the endpoint generates a stable id
 * when absent (D-128); when supplied it must fit the configuration's
 * charset so the persisted entry and the API path agree. `apiKey` is the
 * §6.3 file-stored secret source, write-only: accepted here, never
 * echoed in any response, and optional per §5.3's "skip the key, add it
 * later in the UI". `apiKeyEnv` is deliberately absent — binding an
 * account to an environment variable is a configuration-file concern
 * (§6.3), not something a request body can set.
 */
export const CreateAccountBodySchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        pattern: ID_PATTERN,
        description: 'Stable account id; generated when absent.',
      }),
    ),
    providerId: Type.String({ minLength: 1, description: 'Provider adapter id.' }),
    label: Type.String({ minLength: 1, description: 'Display label.' }),
    apiKey: Type.Optional(
      Type.String({ minLength: 1, description: 'API key (write-only, never echoed).' }),
    ),
    /** Polling on/off; defaults to enabled at the endpoint (D-128). */
    enabled: Type.Optional(Type.Boolean({ description: 'Polling on/off; default true.' })),
  },
  { additionalProperties: false },
);

/** The shape `POST /api/accounts` accepts. */
export type CreateAccountBody = Static<typeof CreateAccountBodySchema>;

/* ── PATCH /api/accounts/:id — update (§13: "label, enable state, or key") ─ */

/**
 * The update body — §13's exact three mutable fields, at least one of them
 * (`minProperties: 1`): an empty patch is a client error, not a no-op.
 * Closed like every body, so `id`/`providerId`/`apiKeyEnv` are rejected
 * (identity and secret source are create-time or configuration-file
 * concerns).
 */
export const UpdateAccountBodySchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, description: 'New display label.' })),
    enabled: Type.Optional(Type.Boolean({ description: 'New polling state.' })),
    apiKey: Type.Optional(
      Type.String({ minLength: 1, description: 'Replacement API key (write-only).' }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** The shape `PATCH /api/accounts/:id` accepts. */
export type UpdateAccountBody = Static<typeof UpdateAccountBodySchema>;

/* ── DELETE /api/accounts/:id — archive / purge (§13, §8.2) ─────────────── */

/**
 * The delete query: `purgeHistory` — §13's own explicit-action spelling
 * ("`?purgeHistory=true` explicitly purges history"). A boolean, so
 * `?purgeHistory=false` stays the honest archive request and only the
 * literal truthy spelling arms the destructive path (§8.2's "separate
 * explicit action"; the UI's confirmation dialog on top is task 170's
 * deliverable). Any other value fails schema validation — the §13 envelope.
 */
export const DeleteAccountQuerySchema = Type.Object(
  {
    purgeHistory: Type.Optional(
      Type.Boolean({ description: 'Purge history instead of archiving.' }),
    ),
  },
  { additionalProperties: false },
);

/** The shape `DELETE /api/accounts/:id` accepts in its query string. */
export type DeleteAccountQuery = Static<typeof DeleteAccountQuerySchema>;

/* ── Shared route parameters ────────────────────────────────────────────── */

/** The `:id` parameter of the per-account routes, validated like every id. */
export const AccountIdParamsSchema = Type.Object(
  { id: Type.String({ pattern: ID_PATTERN, minLength: 1, description: 'Account id.' }) },
  { additionalProperties: false },
);

/* ── DELETE response — the lifecycle outcome with the purge evidence ────── */

/**
 * What one history purge removed — D-061's per-table counts, carried in the
 * response so the confirmation flow sees exactly what the cascade deleted
 * (§8.2/§11.2). `null` on both archive outcomes (nothing was purged).
 */
export const PurgedHistoryCountsSchema = Type.Object(
  {
    collectionRuns: Type.Integer({ description: 'Removed collection runs.' }),
    snapshots: Type.Integer({ description: 'Removed snapshots.' }),
    metricValues: Type.Integer({ description: 'Removed metric values.' }),
    quotaEvents: Type.Integer({ description: 'Removed quota events.' }),
    rawResponses: Type.Integer({ description: 'Removed raw responses.' }),
  },
  { additionalProperties: false },
);

/** The shape `DELETE /api/accounts/:id` answers with. */
export const AccountMutationResultSchema = Type.Object(
  {
    /**
     * The lifecycle outcome: `archived` (§8.2's default, history kept),
     * `already-archived` (idempotent re-archive, D-061), or `purged`
     * (the explicit `?purgeHistory=true` action).
     */
    result: Type.Union([
      Type.Literal('archived'),
      Type.Literal('already-archived'),
      Type.Literal('purged'),
    ]),
    /** The account as it stood at the outcome (the archived/purged view). */
    account: AccountViewSchema,
    /** The purge evidence — non-null exactly when `result` is `'purged'`. */
    removed: Type.Union([PurgedHistoryCountsSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** The shape `DELETE /api/accounts/:id` serializes to. */
export type AccountMutationResult = Static<typeof AccountMutationResultSchema>;

/** One purge's per-table evidence (D-061). */
export type PurgedHistoryCounts = Static<typeof PurgedHistoryCountsSchema>;

/**
 * The all-zero evidence report — what a purge answers when the account had
 * no storage rows (an entry-only account, D-128's both-halves verdict).
 * Exported so the endpoint composes the zero case without naming the
 * per-table fields itself — the §7.4 access gate keeps the raw-payload
 * vocabulary confined to this contract module (D-128/D-067).
 */
export const EMPTY_PURGED_HISTORY_COUNTS: PurgedHistoryCounts = Object.freeze({
  collectionRuns: 0,
  snapshots: 0,
  metricValues: 0,
  quotaEvents: 0,
  rawResponses: 0,
});

/* ── POST /api/accounts/:id/test — the connection test result ───────────── */

/**
 * The test outcome — D-052's credential-check vocabulary as §13 response
 * data: the request always answers `200` when the test RAN (a failed
 * credential is a successful test with a negative result, not a request
 * error), with `outcome` discriminating:
 *
 * - `'ok'` — the provider accepted the credentials;
 * - `'rejected'` — the provider refused the key (HTTP 401/403): the key is
 *   wrong or revoked;
 * - `'unavailable'` — the check was inconclusive (network/timeout/5xx, or
 *   the account names a provider this build does not carry); not a verdict
 *   on the key (§7.2 keeps the two apart, and the check inherits it).
 *
 * `message` is the provider's own sanitized-by-construction English (static
 * text plus non-secret transport facts, D-042/D-052) — present exactly on
 * the non-ok outcomes, where the UI shows it immediately (§14.2).
 */
export const AccountTestResponseSchema = Type.Union([
  Type.Object({ outcome: Type.Literal('ok') }, { additionalProperties: false }),
  Type.Object(
    {
      outcome: Type.Union([Type.Literal('rejected'), Type.Literal('unavailable')]),
      message: Type.String({ description: 'Failure detail; required on failure.' }),
    },
    { additionalProperties: false },
  ),
]);

/** The shape `POST /api/accounts/:id/test` serializes to. */
export type AccountTestResponse = Static<typeof AccountTestResponseSchema>;
