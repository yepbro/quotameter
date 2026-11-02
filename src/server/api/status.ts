/**
 * The §13 status and quota endpoints (task 160, spec §13, §7.2, §7.3,
 * §8.4; decision D-130).
 *
 * Two read-only routes inside the `/api` scope: `GET /status` (service
 * state plus every account's §7.3 status, last success, and last error)
 * and `GET /quota?accountId=` (one account's last valid metric values).
 * Both are pure composition over the landed modules — {@link
 * deriveAccountStatus} and {@link readPollingRunEvidence} (task 111, the
 * single §7.3 derivation; nothing here re-derives a status), task 122's
 * last-valid-value query `getLatestValidMetricValues` (D-077), and
 * `getLatestSnapshot` for the header facts. The accounts the views cover
 * come from the same two halves the accounts surface merges (D-128): the
 * configuration store's entries (enabled, secret state) and the storage
 * rows (lifecycle, history) — an archived account, whose entry the archive
 * removed, stays visible with `enabled: false` and derives §7.3's
 * `Disabled`, its history still honest beside it (§8.2).
 *
 * Two seams this module adds beside 159's precedent ({@link
 * StatusRouteOptions}): `pollingIntervalSeconds` is read **per request** —
 * the interval is §6.4-live, and a construction-time constant would freeze
 * the freshness window against reloads — and `suspensionOf` hands over the
 * D-064 in-memory suspension the scheduler owns; a composition without a
 * scheduler passes the unsuspended constant, which D-070 already records
 * as the honest post-restart view (the `auth_error`-run branch keeps `Auth
 * rejected` truthful for exactly that consumer). `configured` resolves
 * through the store seam's `secretOf` — the same resolution the connection
 * test uses — and the resolved value never rides the response: beyond the
 * closed serializer contracts, it feeds the lastError redaction below.
 *
 * §7.2's "most recent error" is the newest **non-success** run, selected
 * by six bounded, indexed outcome-filtered probes over the facade (the
 * D-114 CLI method — no unbounded history scan, no facade change). The
 * stored message is sanitized by construction (D-048); it is additionally
 * passed through an exact-occurrence redaction of the account's resolved
 * secret (§7.4's rule, the D-114 precedent made server-side): a
 * contract-violating provider that embedded key material in an error
 * cannot put it on this wire either.
 *
 * Error vocabulary stays inside D-113's registry (no new codes): an
 * account unknown to both halves is NOT_FOUND (404); malformed query
 * parameters answer the VALIDATION envelope through the scope-local
 * strict Ajv (D-128 — `removeAdditional: false`, so a smuggled extra field
 * is rejected, not trimmed).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { AccountConfigStore } from './accounts';
import { strictValidatorCompiler } from './validation';
import type { QuotaRepository, CollectionRunRecord } from '../../storage/repository';
import type { MetricValueRecord } from '../../storage/repository';
import type { AuthSuspensionState } from '../../services/polling-suspension';
import type { PollingRunEvidence } from '../../services/polling-status';
import { deriveAccountStatus, readPollingRunEvidence } from '../../services/polling-status';
import {
  ACCOUNT_ERROR_OUTCOMES,
  QuotaQuerySchema,
  QuotaResponseSchema,
  StatusResponseSchema,
  type AccountErrorView,
  type AccountStatusToken,
  type MetricView,
  type QuotaResponse,
  type StatusAccountView,
  type StatusResponse,
} from '../../schemas/api/status';
import { ApiError } from './error';

/* ── The injected seams (D-121: define at the consumer) ─────────────────── */

/** What the `/api` scope passes to {@link statusRoutes}. */
export interface StatusRouteOptions {
  /** The configuration-side account store — 159's seam, the same instance. */
  readonly store: AccountConfigStore;
  /** The storage facade — run/snapshot/metric reads (D-058). */
  readonly repository: QuotaRepository;
  /**
   * The effective §7.1 polling interval in seconds, read per request: the
   * interval is §6.4-live (a reload changes the freshness window), so the
   * composition hands over its live-config reader, not a startup constant.
   */
  readonly pollingIntervalSeconds: () => number;
  /**
   * The account's D-064 suspension state — §7.2's 401/403 pause, held by
   * the polling scheduler. A composition without a running scheduler
   * passes the unsuspended constant (D-070's recorded restart view).
   */
  readonly suspensionOf: (accountId: string) => AuthSuspensionState;
  /** The clock for the §7.3 derivation (§11.1, the D-021 seam). */
  readonly now: () => number;
}

/* ── The last-error selection (§7.2, the D-114 method) ──────────────────── */

/**
 * The account's most recent non-success run as the §7.2 error view — the
 * newest row across the six failure outcome classes (equal start stamps
 * resolve to the later run, the D-077 discipline). `message` carries the
 * stored sanitized text verbatim; the caller redacts it against the
 * account's resolved secret.
 */
export function lastErrorOf(
  repository: QuotaRepository,
  accountId: string,
): AccountErrorView | null {
  let latest: CollectionRunRecord | null = null;
  for (const outcome of ACCOUNT_ERROR_OUTCOMES) {
    const run = repository.getLatestCollectionRun(accountId, outcome);
    if (run === null) continue;
    if (
      latest === null ||
      run.startedAt > latest.startedAt ||
      (run.startedAt === latest.startedAt && run.id > latest.id)
    ) {
      latest = run;
    }
  }
  if (latest === null) return null;
  return {
    outcome: latest.outcome as AccountErrorView['outcome'],
    message: latest.errorMessage ?? '',
    at: latest.startedAt,
  };
}

/**
 * Replaces every exact occurrence of `secret` in `text` with
 * `[REDACTED]` — §7.4's rule applied to the §7.2 error message
 * (defense-in-depth over D-048's sanitized-by-construction transport
 * errors; the D-114 CLI precedent, server-side). A null/empty secret (no
 * configured source, an unresolved environment name) leaves the text
 * untouched: there is no secret material to catch.
 */
export function redactSecretOccurrences(text: string, secret: string | null): string {
  if (secret === null || secret === '') return text;
  return text.split(secret).join('[REDACTED]');
}

/* ── Pure view composition ─────────────────────────────────────────────── */

/** Everything one status row derives from, besides the error view. */
export interface StatusAccountInput {
  readonly id: string;
  /** Whether the account is enabled in the live configuration (§6.2). */
  readonly enabled: boolean;
  /** Whether a usable secret resolves for the account (§7.3's gate). */
  readonly configured: boolean;
  readonly suspension: AuthSuspensionState;
  readonly runs: PollingRunEvidence;
  readonly intervalSeconds: number;
}

/**
 * Builds one {@link StatusAccountView}: the §7.3 derivation (the single
 * owner of the precedence — this function adds nothing to it) beside
 * §7.2's last success (the evidence's own snapshot stamp). Pure; the
 * handler owns gathering the halves.
 */
export function statusAccountView(
  input: StatusAccountInput,
  lastError: AccountErrorView | null,
  nowEpochMs: number,
): StatusAccountView {
  return {
    id: input.id,
    status: deriveAccountStatus(input, nowEpochMs) as AccountStatusToken,
    lastSuccessAt: input.runs.lastSuccessAt,
    lastError,
  };
}

/**
 * Renders one `metric_values` row (§11.2) as the §8.4 quota view: every
 * stored field rides verbatim — validity and its reason, the derived-field
 * mask, the row's own collection stamp — and the storage-only keys
 * (`accountId`, `runId`) drop away; the response object names the account
 * once, at the top.
 */
export function metricView(row: MetricValueRecord): MetricView {
  return {
    metricKey: row.metricKey,
    limitType: row.limitType,
    unit: row.unit,
    windowSeconds: row.windowSeconds,
    used: row.used,
    remaining: row.remaining,
    limit: row.limit,
    percentUsed: row.percentUsed,
    percentRemaining: row.percentRemaining,
    resetsAt: row.resetsAt,
    isValid: row.isValid,
    invalidReason: row.invalidReason,
    derivedFields: row.derivedFields === null ? null : [...row.derivedFields],
    collectedAt: row.collectedAt,
  };
}

/** The merged account list the status view iterates: union by id, id-ascending. */
function statusAccountIds(
  managed: ReadonlyArray<{ readonly id: string }>,
  records: ReadonlyArray<{ readonly id: string }>,
): string[] {
  const ids = new Set<string>([...managed.map((entry) => entry.id), ...records.map((r) => r.id)]);
  // Ids are unique in the set; the two-valued comparator is a total order.
  return [...ids].sort((a, b) => (a < b ? -1 : 1));
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers the two §13 status-family routes inside the `/api` scope. The
 * scope's three guards (Origin, custom-header/content-type, §15.1
 * auth-mode) apply to everything here by fastify's hook encapsulation —
 * neither route is public (no `PUBLIC_AUTH_ROUTE_CONFIG`; only health is,
 * §13), and the PUT-family header rules bind nothing here because both
 * routes are GETs.
 */
export const statusRoutes: FastifyPluginAsync<StatusRouteOptions> = async (fastify, options) => {
  const { store, repository, pollingIntervalSeconds, suspensionOf, now } = options;

  // Strict schema validation, scoped to these routes (D-128, single
  // construction site in ./validation.ts): unknown or malformed request
  // fields answer the VALIDATION envelope instead of being silently
  // stripped by fastify's shared-Ajv default.
  fastify.setValidatorCompiler(strictValidatorCompiler());

  fastify.get(
    '/status',
    {
      schema: { response: { 200: StatusResponseSchema } },
    },
    async (_request, reply) => {
      const intervalSeconds = pollingIntervalSeconds();
      // One clock reading for the whole response (D-021): the rows of one
      // status view are derived against the same instant, not against N
      // successive reads that could straddle a freshness boundary.
      const nowEpochMs = now();
      const managed = await store.list();
      const managedById = new Map(managed.map((entry) => [entry.id, entry]));
      const records = repository.listAccounts();
      const accounts: StatusAccountView[] = [];
      for (const id of statusAccountIds(managed, records)) {
        const entry = managedById.get(id);
        // `configured` resolves through the store seam — the same source of
        // truth the connection test uses; the resolved value feeds only the
        // comparison and the redaction below, never the response.
        const resolvedKey = entry?.keyConfigured === true ? await store.secretOf(id) : null;
        const lastError = lastErrorOf(repository, id);
        accounts.push(
          statusAccountView(
            {
              id,
              // The configuration owns enablement; a storage-only row (an
              // archived account, D-128's honest gap) reads disabled.
              enabled: entry?.enabled ?? false,
              configured: entry?.keyConfigured === true && resolvedKey !== null,
              suspension: suspensionOf(id),
              runs: readPollingRunEvidence(repository, id),
              intervalSeconds,
            },
            lastError === null
              ? null
              : { ...lastError, message: redactSecretOccurrences(lastError.message, resolvedKey) },
            nowEpochMs,
          ),
        );
      }
      reply.header('cache-control', 'no-store');
      const body: StatusResponse = {
        status: 'ok',
        pollingIntervalSeconds: intervalSeconds,
        accounts,
      };
      return body;
    },
  );

  fastify.get(
    '/quota',
    {
      schema: {
        querystring: QuotaQuerySchema,
        response: { 200: QuotaResponseSchema },
      },
    },
    async (request, reply) => {
      const { accountId } = request.query as { readonly accountId: string };
      const managed = await store.find(accountId);
      const record = repository.getAccount(accountId);
      // The both-halves verdict (D-128): an account known to neither the
      // configuration nor the storage is the 404; an archived account (a
      // row without an entry) stays readable — §8.2 retains its history.
      if (managed === null && record === null) {
        throw new ApiError('NOT_FOUND', { message: 'Account not found' });
      }
      const resolvedKey = managed?.keyConfigured === true ? await store.secretOf(accountId) : null;
      const latestSnapshot = repository.getLatestSnapshot(accountId);
      const body: QuotaResponse = {
        accountId,
        status: deriveAccountStatus(
          {
            enabled: managed?.enabled ?? false,
            configured: managed?.keyConfigured === true && resolvedKey !== null,
            suspension: suspensionOf(accountId),
            runs: readPollingRunEvidence(repository, accountId),
            intervalSeconds: pollingIntervalSeconds(),
          },
          now(),
        ) as AccountStatusToken,
        // Absence is honest data (§7.2): an account with no successful
        // collection yet answers null header facts and an empty metric
        // list, never zero placeholders. The plan name is provider text —
        // unlike the sanitized-by-construction error messages, a data
        // field carries no such guarantee, so it passes the same §7.4
        // exact-occurrence redaction as the last-error message (the
        // review round's P3; the accounts surface's planName shares the
        // exposure and is recorded as its owner's residual in D-130).
        collectedAt: latestSnapshot?.collectedAt ?? null,
        planName:
          latestSnapshot?.planName === undefined || latestSnapshot.planName === null
            ? null
            : redactSecretOccurrences(latestSnapshot.planName, resolvedKey),
        metrics: repository.getLatestValidMetricValues(accountId).map(metricView),
      };
      reply.header('cache-control', 'no-store');
      return body;
    },
  );
};
