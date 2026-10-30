/**
 * Z.ai Coding Plan snapshot collection (spec §7.2, §7.4, §8.1, §8.3; task
 * 099, decision D-053).
 *
 * The collection cycle behind `fetchSnapshot`: three sequential GETs
 * through the shared transport (D-042 — timeout, response cap, and
 * content-type gate are the transport's, never re-implemented here), all
 * carrying the same `Authorization: Bearer <key>` header and the caller's
 * §8.1 abort signal:
 *
 * | # | Endpoint                          | Policy (D-047)                                              |
 * | - | --------------------------------- | ----------------------------------------------------------- |
 * | 1 | `/api/monitor/usage/quota/limit`  | primary — transport or parse failure fails the cycle         |
 * | 2 | `/api/biz/subscription/list`      | soft — plan-name fallback context (A9 selection)             |
 * | 3 | `/api/biz/customer-package-reset/list?targetType=PERSONAL` | soft — body never parsed (maps nothing in v1) |
 *
 * Failure surfaces: an endpoint-1 transport failure re-throws the D-042
 * error unchanged — the polling layer classifies it via task 105's
 * `classifyTransportError`, and re-wrapping would collapse the 429/5xx
 * distinctions that classifier consumes. An endpoint-1 parse failure throws
 * {@link SnapshotParseError}: `reason` is static English feeding 105's
 * `classifyParseFailure`, and `sanitizedPayload` is the §7.4 hand-off —
 * task 102's sanitizer run over the raw body with the account secret, so
 * storage (086/103) can retain it without any secret surviving. Nothing
 * here persists anything. Every endpoints-2/3 failure — transport, parse,
 * or caller abort mid-cycle — is soft: logged (when a logger was injected)
 * and degraded, never cycle-fatal (D-047: metric values originate only on
 * endpoint 1).
 */

import type { Clock } from '../../util/clock';
import type { Logger } from '../../util/logger';
import type { NormalizedMetric, ProviderSnapshot } from '../../schemas/metrics';
import type { AccountContext } from '../registry';
import { sanitizeRawResponse } from '../sanitize';
import { TransportError, providerFetch } from '../transport';
import { mapQuotaLimitData } from './mapping';

/* ── Logger surface ────────────────────────────────────────────────────── */

/**
 * The logging the collection cycle needs: skip reports and soft-failure
 * warnings. A structural `Pick` of the D-025 logger so the composition root
 * passes the application logger while tests capture calls; absent means
 * silent (the adapter never creates output sinks itself).
 */
export type SnapshotLogger = Pick<Logger, 'warn'>;

/* ── Request configuration ─────────────────────────────────────────────── */

/** The three GET URLs of one collection cycle (see [`provider.ts`](provider.ts)). */
export interface ZaiSnapshotUrls {
  /** Dossier endpoint 1 — the primary quota-metrics source. */
  readonly quotaLimit: string;
  /** Dossier endpoint 2 — subscription records (plan-name fallback). */
  readonly subscriptionList: string;
  /** Dossier endpoint 3 — reset cards (`targetType=PERSONAL`); context only. */
  readonly resetCards: string;
}

/** Everything the collector needs besides the account and the signal. */
export interface ZaiSnapshotRequest {
  readonly urls: ZaiSnapshotUrls;
  /**
   * The §7.2 total request deadline. One deadline per request: a cycle
   * makes up to three sequential requests, each with its own (D-047).
   */
  readonly timeoutMs: number;
  /** Skip/soft-failure logger; absent means silent. */
  readonly logger?: SnapshotLogger;
  /** Stamps `collectedAt` at cycle end (spec §10: time through a clock). */
  readonly clock: Clock;
}

/**
 * A snapshot minus its `providerId` — the identity is the provider class's
 * single source of truth ([`provider.ts`](provider.ts)), which wraps this
 * result. Keeps the module graph acyclic: provider → snapshot, never back.
 */
export type ZaiCollectedSnapshot = Omit<ProviderSnapshot, 'providerId'>;

/* ── Parse errors (§7.2 "Format changed", §7.4 hand-off) ───────────────── */

/**
 * A delivered endpoint-1 response failed envelope/container validation —
 * §7.2's "Invalid JSON, unexpected response schema, or missing required
 * fields". Single meaning, so no `kind` discriminant or subclass split
 * (D-052's credential taxonomy needed two meanings; this needs one): the
 * polling layer picks its entry point by catching `TransportError` first
 * and this second.
 *
 * All fields are non-secret by construction: `reason` is static English
 * (never payload text — D-048 pins `errorMessage` that way), and both
 * payload-derived fields were passed through task 102's sanitizer with the
 * account secret, so a provider echoing the key back cannot smuggle it
 * into an error (§15.4).
 */
export class SnapshotParseError extends Error {
  /** Static-English cause; feeds `classifyParseFailure` verbatim. */
  readonly reason: string;
  /** The delivered response's HTTP status (2xx in practice — the transport gate). */
  readonly httpStatus: number | undefined;
  /**
   * The §7.4 hand-off: the raw response body after `sanitizeRawResponse`
   * (exact secrets replaced, sensitive named fields emptied, 64 KiB cap).
   * Carried, never stored here — retention belongs to tasks 086/103.
   */
  readonly sanitizedPayload: string;
  /**
   * The envelope's `msg` when the response carried a present-but-non-success
   * `code` (dossier A2: "a present `msg` is retained … as the diagnostic
   * string"), sanitized the same way; `undefined` for every other cause —
   * a malformed envelope's `msg` is noise, not a diagnostic.
   */
  readonly envelopeMessage: string | undefined;

  constructor(
    reason: string,
    httpStatus: number | undefined,
    sanitizedPayload: string,
    envelopeMessage?: string,
  ) {
    super(reason);
    this.name = new.target.name;
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.sanitizedPayload = sanitizedPayload;
    this.envelopeMessage = envelopeMessage;
  }
}

/* ── Envelope rules (D-047) ────────────────────────────────────────────── */

/**
 * The envelope success set: `code` of `0` or `200` in number **or** string
 * spelling (prototype-verified tolerance; the capture observed the number
 * `200`). `success` and `msg` are never interpreted.
 */
function isSuccessCode(code: unknown): boolean {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

/** Narrows a parsed JSON value to a plain object record, else `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * A usable string value, else `undefined`: non-strings and blanks (including
 * whitespace-only, which the snapshot invariants reject) count as absent;
 * usable values pass through verbatim.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Type-guard form of {@link nonEmptyString}. */
function isNonEmptyString(value: unknown): value is string {
  return nonEmptyString(value) !== undefined;
}

/** The result of mapping a parsed endpoint-1 body. */
export interface QuotaLimitParseResult {
  readonly metrics: NormalizedMetric[];
  readonly planName: string | undefined;
  readonly skips: readonly string[];
}

/**
 * Parses and maps an endpoint-1 response body (strict tier, D-047.5):
 * valid JSON → envelope object → success `code` → `data` object → `limits`
 * array, each violation throwing {@link SnapshotParseError} with the §7.4
 * hand-off; then the tolerant mapping of [`mapping.ts`](mapping.ts).
 * Exported as a pure seam so the fixture matrix drives it without HTTP.
 */
export function parseQuotaLimitBody(
  body: string,
  httpStatus: number,
  secrets: readonly string[],
): QuotaLimitParseResult {
  const fail = (reason: string, envelopeMessage?: string): SnapshotParseError =>
    new SnapshotParseError(reason, httpStatus, sanitizeRawResponse(body, secrets), envelopeMessage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail('the response body was not valid JSON');
  }
  const envelope = asRecord(parsed);
  if (envelope === undefined) {
    throw fail('the response envelope was not a JSON object');
  }
  if (!isSuccessCode(envelope.code)) {
    const envelopeMessage =
      envelope.code !== undefined && isNonEmptyString(envelope.msg)
        ? sanitizeRawResponse(envelope.msg, secrets)
        : undefined;
    throw fail('the response envelope code was not a success value', envelopeMessage);
  }
  const data = asRecord(envelope.data);
  if (data === undefined) {
    throw fail('the response data was not an object');
  }
  if (!Array.isArray(data.limits)) {
    throw fail('the response limits field was not an array');
  }
  return mapQuotaLimitData(data.limits, data.level);
}

/* ── Endpoint 2 — subscription context (A9, soft) ──────────────────────── */

/** The soft outcome of parsing an endpoint-2 body: mapped, or violated. */
export type SubscriptionContext =
  | { readonly outcome: 'parsed'; readonly planName: string | undefined }
  | { readonly outcome: 'violated'; readonly reason: string };

/**
 * Selects the plan-defining subscription record (assumption A9): the record
 * with `inCurrentPeriod === true`, else the first with `status === 'VALID'`
 * (the prototype's rule), else none. The single capture made both rules
 * coincide; `zai-subscription-list-divergent.json` exercises the divergence.
 * Only `productName` maps (the plan-name fallback); everything else stays
 * out — account-linked and monetary values must not travel into snapshots.
 */
function selectSubscriptionRecord(
  records: readonly unknown[],
): Record<string, unknown> | undefined {
  let firstValid: Record<string, unknown> | undefined;
  for (const candidate of records) {
    const record = asRecord(candidate);
    if (record === undefined) continue;
    if (record.inCurrentPeriod === true) return record;
    if (firstValid === undefined && record.status === 'VALID') firstValid = record;
  }
  return firstValid;
}

/**
 * Soft-parses an endpoint-2 body: the same envelope rules as endpoint 1,
 * but `data` must be an array, and every violation — including invalid
 * JSON — is a *reported* degradation, never a thrown error (D-047: the
 * endpoint supplies context only). No §7.4 payload is attached: retention
 * is tied to parse failures that produce no snapshot, and this one does not.
 */
export function parseSubscriptionContext(body: string): SubscriptionContext {
  const violated = (reason: string): SubscriptionContext => ({ outcome: 'violated', reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return violated('the response body was not valid JSON');
  }
  const envelope = asRecord(parsed);
  if (envelope === undefined) return violated('the response envelope was not a JSON object');
  if (!isSuccessCode(envelope.code)) {
    return violated('the response envelope code was not a success value');
  }
  if (!Array.isArray(envelope.data)) return violated('the response data was not an array');
  const record = selectSubscriptionRecord(envelope.data);
  return {
    outcome: 'parsed',
    planName: record === undefined ? undefined : nonEmptyString(record.productName),
  };
}

/* ── The collection cycle ──────────────────────────────────────────────── */

/**
 * Fetches the plan-name fallback from endpoint 2, soft: any transport
 * failure or parse violation is logged and degrades to `undefined`.
 */
async function fetchSubscriptionPlanName(
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  request: ZaiSnapshotRequest,
): Promise<string | undefined> {
  try {
    const response = await providerFetch(
      { url: request.urls.subscriptionList, headers, signal },
      { timeoutMs: request.timeoutMs },
    );
    const context = parseSubscriptionContext(response.body);
    if (context.outcome === 'violated') {
      request.logger?.warn('zai-coding-plan: subscription context degraded', {
        reason: context.reason,
      });
      return undefined;
    }
    return context.planName;
  } catch (error) {
    if (error instanceof TransportError) {
      request.logger?.warn('zai-coding-plan: subscription context fetch failed', {
        transportKind: error.kind,
        transportMessage: error.message,
      });
      return undefined;
    }
    throw error;
  }
}

/**
 * Fetches endpoint 3, soft: reset-card context that maps nothing in v1
 * (D-047.6), so the delivered body is deliberately not parsed — the fetch
 * stays because dropping it would itself be a contract change. Any
 * transport failure is logged and degrades.
 */
async function fetchResetCardContext(
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  request: ZaiSnapshotRequest,
): Promise<void> {
  try {
    await providerFetch(
      { url: request.urls.resetCards, headers, signal },
      { timeoutMs: request.timeoutMs },
    );
  } catch (error) {
    if (error instanceof TransportError) {
      request.logger?.warn('zai-coding-plan: reset-card context fetch failed', {
        transportKind: error.kind,
        transportMessage: error.message,
      });
      return;
    }
    throw error;
  }
}

/**
 * Runs one collection cycle for `account` (spec §8.1): endpoint 1 strictly,
 * endpoints 2 and 3 softly, sequentially, each GET carrying the Bearer
 * credential and the caller's abort signal (D-042 composes it into the
 * exchange). Resolves with the normalized snapshot body — `providerId` is
 * added by the provider class. Rejects with the re-thrown D-042
 * `TransportError` (endpoint 1 transport failure — 105 classifies it) or
 * {@link SnapshotParseError} (endpoint 1 parse failure — the §7.4 payload
 * travels on the error). The secret is read only inside this function —
 * into the shared header and the sanitizer's known-secrets list, both
 * in-memory and never logged; `planName` is endpoint 1's `level` verbatim,
 * with the endpoint-2 `productName` as fallback (096 mapping table).
 */
export async function collectZaiSnapshot(
  account: AccountContext,
  signal: AbortSignal,
  request: ZaiSnapshotRequest,
): Promise<ZaiCollectedSnapshot> {
  const headers = { authorization: `Bearer ${account.secret}` };
  const secrets = [account.secret];

  // Endpoint 1 — primary: its failure fails the cycle, and no further
  // endpoint is fetched (fail fast; there is no snapshot without it).
  const quotaResponse = await providerFetch(
    { url: request.urls.quotaLimit, headers, signal },
    { timeoutMs: request.timeoutMs },
  );
  const parsed = parseQuotaLimitBody(quotaResponse.body, quotaResponse.status, secrets);
  for (const skip of parsed.skips) {
    // The skip report interpolates payload values (the unrecognized
    // type/unit pair); it passes through the sanitizer's raw-text path
    // before logging so the by-construction guarantee the rest of this
    // cycle maintains applies here too — a provider echoing the account
    // key inside an unknown field cannot land it in a log line (§15.4,
    // review finding P2-2).
    request.logger?.warn(`zai-coding-plan: ${sanitizeRawResponse(skip, secrets)}`);
  }

  // Endpoints 2 and 3 — soft context, every failure degrades (D-047).
  const subscriptionPlanName = await fetchSubscriptionPlanName(headers, signal, request);
  await fetchResetCardContext(headers, signal, request);

  const planName = parsed.planName ?? subscriptionPlanName;
  const snapshot: ZaiCollectedSnapshot = {
    collectedAt: request.clock.now(),
    metrics: parsed.metrics,
  };
  if (planName !== undefined) snapshot.planName = planName;
  return snapshot;
}
