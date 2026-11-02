/**
 * The §13 status and quota endpoint contracts (task 160, spec §13, §7.3,
 * §8.4; decision D-130).
 *
 * TypeBox definitions for the two §7.3-facts routes — `GET /api/status`
 * (service state plus every account's §7.3 status, last success, and last
 * error) and `GET /api/quota` (the last valid metric values of one account)
 * — the schemas the routes validate through and serialize through, and the
 * ones task 163 generates OpenAPI from (§13: "Define every request and
 * response through TypeBox/JSON Schema"). Placement follows the layer rule
 * of `src/schemas/README.md`: pure contract data; the behavior lives in
 * `src/server/api/status.ts`.
 *
 * Timestamps are epoch-millisecond integers — the vocabulary the landed
 * accounts surface established (`createdAt`/`archivedAt`, D-128); §10's
 * ISO-8601 sentence governs the §13 range *parameters* (history/events
 * `from`/`to`), and D-130 records the reading so the surface stays
 * single-format (see the endpoint module).
 *
 * Every response object is closed (`additionalProperties: false`), so the
 * compiled serializer emits exactly the declared keys — a handler bug that
 * returned a secret could not put it on the wire (the D-111 health
 * precedent, generalized across the whole §13 surface since D-128).
 */

import { type Static, Type } from '@sinclair/typebox';
import { DERIVED_METRIC_FIELDS, LIMIT_TYPES, METRIC_UNITS } from '../metrics';
import { ID_PATTERN } from '../config';

/* ── The §7.3 status vocabulary on the wire ─────────────────────────────── */

/**
 * Every account status token spec §7.3/§14.6 distinguishes, as the wire
 * literals of {@link StatusAccountViewSchema}. Membership, not order, is the
 * contract; a `test/unit/api-status-schema.spec.ts` drift row pins this list
 * against `ACCOUNT_STATUSES` (the derivation's own vocabulary in
 * `src/services/polling-status.ts`) so the two cannot fork.
 */
export const ACCOUNT_STATUS_TOKENS = Object.freeze([
  'auth-rejected',
  'format-changed',
  'unreachable',
  'stale',
  'collecting',
  'fresh',
  'disabled',
  'not-configured',
] as const);

/** One status token (§7.3/§14.6). */
export type AccountStatusToken = (typeof ACCOUNT_STATUS_TOKENS)[number];

const AccountStatusTokenSchema = Type.Union(
  ACCOUNT_STATUS_TOKENS.map((token) => Type.Literal(token)),
  { description: 'The §7.3 primary displayed status.' },
);

/* ── The last-error view (§7.2's "most recent error") ───────────────────── */

/**
 * The six §11.2 failure outcomes — the wire vocabulary of a status row's
 * `lastError.outcome`. Pinned against the repository's `RunOutcome` union
 * (every member except `success`) by a schema-suite drift row: the endpoint
 * scans exactly these outcome classes for the newest non-success run.
 */
export const ACCOUNT_ERROR_OUTCOMES = Object.freeze([
  'auth_error',
  'rate_limited',
  'network_error',
  'timeout',
  'server_error',
  'parse_error',
] as const);

/** One failure outcome token (§11.2, the non-success half). */
export type AccountErrorOutcome = (typeof ACCOUNT_ERROR_OUTCOMES)[number];

/**
 * An account's most recent collection error (§7.2): the newest non-success
 * run's outcome class, its sanitized-by-construction message (D-048), and
 * the run's start. The message additionally passes the endpoint's
 * exact-occurrence secret redaction (D-130, the D-114 CLI precedent), so a
 * contract-violating provider's residual cannot ride the response.
 */
export const AccountErrorViewSchema = Type.Object(
  {
    outcome: Type.Union(
      ACCOUNT_ERROR_OUTCOMES.map((outcome) => Type.Literal(outcome)),
      {
        description: 'The run outcome class of the latest error.',
      },
    ),
    message: Type.String({ description: 'Sanitized error message (§7.2).' }),
    at: Type.Integer({ description: 'Error run start (epoch ms).' }),
  },
  { additionalProperties: false },
);

/** The shape of one account's `lastError`. */
export type AccountErrorView = Static<typeof AccountErrorViewSchema>;

/* ── GET /api/status — service state and per-account statuses ───────────── */

/**
 * One account's §7.3 status row: the derived primary status, §7.2's two
 * most-recents (last successful collection, last error), keyed by the
 * account id the rest of the §13 surface uses.
 */
export const StatusAccountViewSchema = Type.Object(
  {
    /** Stable account identifier (the §6.2 charset). */
    id: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    /** The §7.3 derivation's verdict for this account. */
    status: AccountStatusTokenSchema,
    /** The latest successful collection's epoch-ms stamp; `null` when none exists. */
    lastSuccessAt: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Last successful collection (epoch ms) or null.',
    }),
    /** The newest non-success run; `null` when every recorded run succeeded. */
    lastError: Type.Union([AccountErrorViewSchema, Type.Null()], {
      description: 'Most recent collection error or null.',
    }),
  },
  { additionalProperties: false },
);

/** The shape of one `GET /api/status` account row. */
export type StatusAccountView = Static<typeof StatusAccountViewSchema>;

/**
 * The `GET /api/status` response — §13's "Service state and each account's
 * status, last success, and last error". Service state today is the honest
 * minimum: the answering service is `ok` and the effective §7.1 polling
 * interval (the freshness window's yardstick, re-read per request so §6.4
 * live reloads hold); accounts are id-ascending for deterministic
 * responses.
 */
export const StatusResponseSchema = Type.Object(
  {
    /** The service-level state: the answering process is up. */
    status: Type.Literal('ok', { description: 'Service state.' }),
    /** The §7.1 interval in effect, 60–3600 seconds. */
    pollingIntervalSeconds: Type.Integer({
      minimum: 60,
      maximum: 3600,
      description: 'Effective polling interval in seconds (spec §7.1).',
    }),
    /** Every account's §7.3 row, id-ascending. */
    accounts: Type.Array(StatusAccountViewSchema, { description: 'Per-account statuses.' }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/status` serializes to. */
export type StatusResponse = Static<typeof StatusResponseSchema>;

/* ── GET /api/quota — the last valid values of one account ──────────────── */

/** The required `accountId` query parameter, validated like every id. */
export const QuotaQuerySchema = Type.Object(
  {
    accountId: Type.String({
      pattern: ID_PATTERN,
      minLength: 1,
      description: 'Stable account id.',
    }),
  },
  { additionalProperties: false },
);

/**
 * One metric of the quota view — a `metric_values` row (§11.2) rendered in
 * the §8.4 vocabulary: the closed `limitType`/`unit`/`derivedFields` enums
 * are derived from the model's own frozen lists (`src/schemas/metrics.ts`)
 * so the wire contract cannot drift from the storage contract, per-metric
 * validity and its reason ride verbatim (§8.4), and each row carries its
 * own collection stamp — task 122's last-valid-value query (D-077) may
 * assemble rows from different snapshots.
 *
 * §8.4's `label` is deliberately absent: the storage row omits it (D-039,
 * adapter-owned parse-time data) and no metric catalog exists on the
 * provider contract yet — D-130 records the gap for the §14.3 overview.
 */
export const MetricViewSchema = Type.Object(
  {
    /** Stable, adapter-defined metric identifier. */
    metricKey: Type.String({ minLength: 1, description: 'Stable metric key.' }),
    limitType: Type.Union(
      LIMIT_TYPES.map((type) => Type.Literal(type)),
      {
        description: 'Quota accounting regime (spec §8.4).',
      },
    ),
    unit: Type.Union(
      METRIC_UNITS.map((unit) => Type.Literal(unit)),
      {
        description: 'Unit of the absolute values (spec §8.4).',
      },
    ),
    /** Rolling-window length in seconds; `null` outside rolling windows. */
    windowSeconds: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Rolling window seconds or null.',
    }),
    used: Type.Union([Type.Number(), Type.Null()], { description: 'Consumed amount or null.' }),
    remaining: Type.Union([Type.Number(), Type.Null()], {
      description: 'Remaining amount or null.',
    }),
    limit: Type.Union([Type.Number(), Type.Null()], { description: 'Total allowance or null.' }),
    percentUsed: Type.Union([Type.Number(), Type.Null()], {
      description: 'Percentage consumed or null.',
    }),
    percentRemaining: Type.Union([Type.Number(), Type.Null()], {
      description: 'Percentage remaining or null.',
    }),
    /** Next quota reset, epoch ms; `null` when the metric declares none. */
    resetsAt: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Next reset (epoch ms) or null.',
    }),
    /** §8.4 per-metric validity — the rows this view serves are the last valid ones. */
    isValid: Type.Boolean({ description: 'Whether the reading is valid.' }),
    invalidReason: Type.Union([Type.String(), Type.Null()], {
      description: 'Why the metric is invalid, or null.',
    }),
    /** Fields computed from other supplied fields (§8.4); `null` stores no mask. */
    derivedFields: Type.Union(
      [
        Type.Array(Type.Union(DERIVED_METRIC_FIELDS.map((field) => Type.Literal(field)))),
        Type.Null(),
      ],
      { description: 'Derived field names or null.' },
    ),
    /** This row's snapshot stamp (D-077: rows may come from different snapshots). */
    collectedAt: Type.Integer({ description: 'Row collection time (epoch ms).' }),
  },
  { additionalProperties: false },
);

/** The shape of one quota metric row. */
export type MetricView = Static<typeof MetricViewSchema>;

/**
 * The `GET /api/quota` response — §13's "Latest successful snapshot for
 * `accountId`" in task 122's reading (D-077/D-130): the header facts come
 * from the latest successful snapshot, the metric rows from the
 * last-valid-value query, and the §7.3 status rides along as the freshness
 * context the overview renders beside the numbers. Absence is honest
 * (`metrics: []`, null header facts), never zero (§7.2).
 */
export const QuotaResponseSchema = Type.Object(
  {
    /** The requested account. */
    accountId: Type.String({ pattern: ID_PATTERN, description: 'Stable account id.' }),
    /** The account's current §7.3 status. */
    status: AccountStatusTokenSchema,
    /** The latest successful snapshot's stamp; `null` when none exists. */
    collectedAt: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Latest snapshot time (epoch ms) or null.',
    }),
    /** The latest snapshot's plan name; `null` when none exists or it carried none. */
    planName: Type.Union([Type.String(), Type.Null()], { description: 'Plan name or null.' }),
    /** The last valid value per metric key, `metric_key`-ascending. */
    metrics: Type.Array(MetricViewSchema, { description: 'Last valid metric values.' }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/quota` serializes to. */
export type QuotaResponse = Static<typeof QuotaResponseSchema>;
