/**
 * Shared HTTP transport for provider adapters (spec §7.2, §8.1; task 104,
 * decision D-042).
 *
 * Every adapter (099 builds the Z.ai one on this seam) fetches through
 * {@link providerFetch}: one GET-only function that owns the cross-cutting
 * request concerns — the §7.2 timeout as a single total deadline over the
 * whole exchange, `AbortSignal` composition with the caller's §8.1 signal,
 * a bounded response-body read, the `application/json` content-type gate,
 * and a sanitized transport-error taxonomy. The taxonomy stops here:
 * retries/backoff (106), `Retry-After` parsing (107), and outcome mapping
 * (105) consume the {@link TransportError.kind} discriminant downstream.
 *
 * Secret discipline (spec §15.4) is structural, not conventional: transport
 * errors never carry the URL, the request headers, or the raw underlying
 * error — Node/undici failure messages embed `host:port` and future runtimes
 * may embed more, so only the machine error *code* (`causeCode`) survives.
 * Messages are static English; the few retained server strings (status
 * text, `Retry-After`, the observed content type) are scrubbed against the
 * request's own credential material, so a provider echoing a key back
 * cannot smuggle it into an error. Marker-secret tests pin the whole
 * surface.
 *
 * Failure shapes were verified against the pinned runtime (Node 22.13.0,
 * D-042): refused = `TypeError: fetch failed` + cause `ECONNREFUSED`;
 * name resolution = same + `ENOTFOUND`; socket destroyed before or during
 * the body = `fetch failed`/`terminated` + cause `UND_ERR_SOCKET`; a
 * deadline firing mid-body rejects with the timeout signal's own
 * `TimeoutError` DOMException — which is why the signal state, not the
 * rejection shape, is the classification authority. That authority is
 * consulted on the success returns as well (D-072): undici can lose the
 * abort-vs-read race and close an aborted body as `done`, so a `done`
 * read or a bodiless 2xx is delivered only while both signals are quiet —
 * while delivered non-2xx/content-type/over-cap observations stay
 * observations, the arrived fact being more actionable than the race it
 * lost.
 */

import { SENSITIVE_KEY_NAMES } from '../util/logger';

/* ── Constants ─────────────────────────────────────────────────────────── */

/** The spec §7.2 default HTTP request timeout (15 s), a total deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The response-body read cap (64 KiB), aligned with the §7.4 sanitized-
 * response cap (task 102's precedent): what the adapter received is exactly
 * what §7.4 can store. The spec names no other response size, and an
 * unbounded read would let a hostile or broken provider exhaust memory.
 */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/* ── Error taxonomy ────────────────────────────────────────────────────── */

/** Discriminant consumed by the outcome mapping of task 105 (D-042). */
export type TransportErrorKind =
  | 'timeout'
  | 'aborted'
  | 'dns'
  | 'connection'
  | 'socket'
  | 'network'
  | 'http-status'
  | 'response-too-large'
  | 'content-type';

/**
 * Base of every failure {@link providerFetch} throws. Self-contained and
 * sanitized by construction: `message` is static English (plus non-secret
 * facts), `cause` is never set, and `causeCode` carries at most a machine
 * error code such as `ECONNRESET` (§15.4; see the module comment).
 */
export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  /** The underlying machine error code, when the runtime exposed one. */
  readonly causeCode?: string;

  constructor(kind: TransportErrorKind, message: string, causeCode?: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.causeCode = causeCode;
  }
}

/** The total §7.2 deadline expired before the exchange completed. */
export class TransportTimeoutError extends TransportError {
  constructor(timeoutMs: number) {
    super('timeout', `provider request timed out after ${timeoutMs} ms`);
  }
}

/** The caller's abort signal (§8.1) fired while the request was in flight. */
export class TransportAbortError extends TransportError {
  constructor() {
    super('aborted', 'provider request was aborted by the caller');
  }
}

/** Name resolution failed (`ENOTFOUND`, `EAI_AGAIN`). */
export class TransportDnsError extends TransportError {
  constructor(causeCode?: string) {
    super('dns', `provider hostname could not be resolved${suffix(causeCode)}`, causeCode);
  }
}

/** The connection could not be established (refused, unreachable). */
export class TransportConnectionError extends TransportError {
  constructor(causeCode?: string) {
    super('connection', `connection to the provider failed${suffix(causeCode)}`, causeCode);
  }
}

/** The peer reset or destroyed the connection mid-exchange. */
export class TransportSocketError extends TransportError {
  constructor(causeCode?: string) {
    super('socket', `provider connection was reset or terminated${suffix(causeCode)}`, causeCode);
  }
}

/** Any other network-level fetch or body-read rejection. */
export class TransportNetworkError extends TransportError {
  constructor(causeCode?: string) {
    super('network', `provider network request failed${suffix(causeCode)}`, causeCode);
  }
}

/**
 * A non-2xx response, recorded as an observation only: retry policy is
 * task 106, `Retry-After` parsing task 107 — the raw header value travels
 * with the error so those layers can decide without re-fetching.
 */
export class TransportStatusError extends TransportError {
  readonly status: number;
  readonly statusText: string;
  readonly retryAfter: string | undefined;

  constructor(status: number, statusText: string, retryAfter: string | undefined) {
    super(
      'http-status',
      `provider responded with HTTP ${status}${statusText === '' ? '' : ` ${statusText}`}`,
    );
    this.status = status;
    this.statusText = statusText;
    this.retryAfter = retryAfter;
  }
}

/** The response body exceeded the configured byte cap mid-read. */
export class TransportResponseTooLargeError extends TransportError {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super('response-too-large', `provider response exceeded the ${limitBytes}-byte limit`);
    this.limitBytes = limitBytes;
  }
}

/** A 2xx response whose content type is not `application/json`. */
export class TransportContentTypeError extends TransportError {
  readonly observedContentType: string;

  constructor(observedContentType: string) {
    super(
      'content-type',
      `provider response content type was not application/json (observed: ${observedContentType === '' ? 'none' : observedContentType})`,
    );
    this.observedContentType = observedContentType;
  }
}

function suffix(causeCode: string | undefined): string {
  return causeCode === undefined ? '' : ` (${causeCode})`;
}

/* ── Request/response shapes ───────────────────────────────────────────── */

/** One provider request (spec §8.1): the URL, the headers, the caller signal. */
export interface ProviderHttpRequest {
  /** Absolute `http(s)` URL; validated before anything is sent. */
  readonly url: string;
  /**
   * Request headers, including the credential header. The values never
   * appear in any error or log line produced by this module (§15.4).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The polling service's signal (§8.1): when it fires, an in-flight
   * request stops and rejects with {@link TransportAbortError}.
   */
  readonly signal?: AbortSignal;
}

/** The delivered response: a 2xx, `application/json`, size-bounded body. */
export interface ProviderHttpResponse {
  readonly status: number;
  /** The raw `Content-Type` header of the delivered body. */
  readonly contentType: string;
  /** The decoded UTF-8 body text; adapters parse it adapter-locally. */
  readonly body: string;
  /** The exact number of body bytes received. */
  readonly bytes: number;
}

/** Options adjusting {@link providerFetch}; all optional. */
export interface ProviderHttpOptions {
  /**
   * Total deadline for DNS, connect, TLS, headers, and the full body read,
   * in milliseconds. Any positive finite value is accepted (the §7.2
   * 5–60 s *configuration* range is enforced where configuration enters,
   * task 062; tests need short deadlines). Defaults to §7.2's 15 s.
   */
  readonly timeoutMs?: number;
  /**
   * The response-body cap in bytes; a body one byte over rejects. Defaults
   * to {@link MAX_RESPONSE_BODY_BYTES}.
   */
  readonly maxResponseBytes?: number;
  /**
   * The fetch implementation (Node 22's global by default). Injectable so
   * tests exercise classification against exact runtime failure shapes
   * without patching process globals (the logger-destination pattern).
   */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/* ── Sanitization helpers ──────────────────────────────────────────────── */

/** The logger's normalized-key rule (D-025), applied to HTTP header names. */
const sensitiveHeaderNames = new Set<string>(SENSITIVE_KEY_NAMES);

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    sensitiveHeaderNames.has(normalized) ||
    // The HTTP extension-prefix convention: `X-Api-Key` normalizes to
    // `xapikey`, a spelling the D-025 vocabulary does not carry. Stripping
    // one leading `x` keeps credential headers of that form inside the
    // scrub set (review finding, task 104).
    (normalized.startsWith('x') && sensitiveHeaderNames.has(normalized.slice(1)))
  );
}

/** Replaces every occurrence of every known secret inside `value`. */
function scrub(value: string, secrets: readonly string[]): string {
  let scrubbed = value;
  for (const secret of secrets) {
    // Equivalent mutant (U-006 triage): the 'true' variant is equivalent —
    // split/join over an absent needle is the identity transform. The
    // co-excluded 'false' variant (scrubbing disabled, secrets leak) is
    // killable and stays pinned by the '[REDACTED]' tests.
    // Stryker disable next-line ConditionalExpression
    if (scrubbed.includes(secret)) {
      // split/join instead of RegExp: secrets are arbitrary strings whose
      // regex metacharacters must be matched literally.
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  return scrubbed;
}

/**
 * The credential material of the request's sensitive headers — the strings
 * this module treats as secrets when retaining server-provided text. For
 * scheme-qualified `Authorization`-style values (`Bearer <key>`,
 * `Basic <credentials>`) the credential after the scheme is extracted as
 * well, because a provider echoing the credential back echoes it alone.
 */
function sensitiveHeaderValues(headers: Readonly<Record<string, string>> | undefined): string[] {
  // Equivalent mutants (U-006 triage): both empty-array seeds, if pre-filled,
  // only add a needle no scrubbed text ever contains.
  // Stryker disable next-line ArrayDeclaration
  if (headers === undefined) return [];
  // Stryker disable next-line ArrayDeclaration
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === '' || !isSensitiveHeaderName(name)) continue;
    values.push(value);
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'authorization' || normalized === 'proxyauthorization') {
      const parts = value.trim().split(/\s+/u);
      if (parts.length >= 2) values.push(parts.slice(1).join(' '));
    }
  }
  return values;
}

/* ── Failure classification ────────────────────────────────────────────── */

/** Machine error codes that mean name resolution failed. */
const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN']);
/** Machine error codes that mean the connection could not be established. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
/** Machine error codes that mean the peer reset or dropped the connection. */
const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
]);

/** Extracts a machine error code from the error or its cause chain head. */
function causeCodeOf(error: unknown): string | undefined {
  const candidates = [(error as { cause?: unknown } | null)?.cause, error];
  for (const candidate of candidates) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Maps a fetch or body-read rejection to the network family of the taxonomy
 * (D-042). Verified shapes on the pinned runtime: undici rejects with
 * `TypeError: fetch failed` carrying the real error in `cause`, and the
 * codeless `TypeError: terminated` covers a body interrupted by teardown.
 */
function classifyNetworkFailure(error: unknown): TransportError {
  const causeCode = causeCodeOf(error);
  // The `?? ''` fallbacks below are equivalent mutants (U-006 triage): the
  // sets never contain the fallback string, so its exact spelling is
  // unobservable when no cause code exists.
  // Stryker disable next-line StringLiteral
  if (DNS_CODES.has(causeCode ?? '')) return new TransportDnsError(causeCode);
  // Stryker disable next-line StringLiteral
  if (CONNECTION_CODES.has(causeCode ?? '')) return new TransportConnectionError(causeCode);
  // Stryker disable next-line StringLiteral
  if (SOCKET_CODES.has(causeCode ?? '')) return new TransportSocketError(causeCode);
  // Equivalent mutant (U-006 triage): the fallback fires only for a missing
  // message, and neither '' nor any marker string contains "terminated".
  // Stryker disable next-line StringLiteral
  if (/terminated/iu.test(String((error as Error | null)?.message ?? ''))) {
    return new TransportSocketError(causeCode);
  }
  return new TransportNetworkError(causeCode);
}

/**
 * The signal-state classification authority (D-042, D-072): consulted by
 * every point that must decide an exchange whose signals may have fired —
 * the failure mapper below and both success returns. When both signals
 * fired in the same window, the deadline wins: a timed-out request is the
 * actionable §7.2 diagnosis for the poller. Returns `undefined` only while
 * neither signal has fired.
 */
function classifyAbortedExchange(
  deadline: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): TransportTimeoutError | TransportAbortError | undefined {
  if (deadline.aborted) return new TransportTimeoutError(timeoutMs);
  if (callerSignal?.aborted === true) return new TransportAbortError();
  return undefined;
}

/**
 * The classification authority for exchange failures: signal state first —
 * a mid-body deadline fires as the timeout signal's own DOMException, and
 * caller aborts arrive as `AbortError` — then the network taxonomy.
 */
function mapExchangeFailure(
  error: unknown,
  deadline: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): TransportError {
  const aborted = classifyAbortedExchange(deadline, callerSignal, timeoutMs);
  if (aborted !== undefined) return aborted;
  return classifyNetworkFailure(error);
}

/**
 * Guards a success return (D-072): a `done` body read or a bodiless
 * response is not by itself proof the exchange completed — under a lost
 * abort-vs-read race undici closes an aborted stream as `done`, possibly
 * truncated. If either signal has fired by the time success is about to be
 * declared, the exchange is classified from the signal state instead.
 */
function throwIfExchangeAborted(
  deadline: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): void {
  const aborted = classifyAbortedExchange(deadline, callerSignal, timeoutMs);
  if (aborted !== undefined) throw aborted;
}

/* ── Input validation ──────────────────────────────────────────────────── */

/** Parses and validates the request URL without echoing it (§15.4). */
function parseRequestUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('providerFetch: url must be a valid absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('providerFetch: url must be a valid absolute http(s) URL');
  }
  return parsed;
}

/** The no-op used to release a body stream nobody will read. */
async function ignoreReleaseFailure(): Promise<void> {}

/* ── The transport ─────────────────────────────────────────────────────── */

/**
 * Performs one bounded GET against a provider endpoint (spec §7.2, §8.1).
 *
 * Resolves only for a 2xx `application/json` response within the byte cap;
 * every other outcome rejects with a {@link TransportError}. GET-only and
 * `redirect: 'error'` are pinned by D-042: the verified Z.ai endpoints are
 * stable GETs, and refusing redirects removes any cross-origin credential
 * forwarding reasoning entirely.
 */
export async function providerFetch(
  request: ProviderHttpRequest,
  options: ProviderHttpOptions = {},
): Promise<ProviderHttpResponse> {
  const url = parseRequestUrl(request.url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('providerFetch: timeoutMs must be a positive finite number');
  }
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BODY_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('providerFetch: maxResponseBytes must be a positive integer');
  }
  const secrets = sensitiveHeaderValues(request.headers);

  // One timer for the whole exchange: DNS, connect, TLS, headers, and the
  // full body read share §7.2's single timeout value (D-042). The timer
  // does not keep the event loop alive, and composing leaves the caller's
  // signal unmodified.
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal === undefined ? deadline : AbortSignal.any([request.signal, deadline]);
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { ...request.headers },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw mapExchangeFailure(error, deadline, request.signal, timeoutMs);
  }

  if (!response.ok) {
    // The error body is never consumed downstream; cancel releases the
    // socket immediately instead of buffering a page we would discard.
    await response.body?.cancel().catch(ignoreReleaseFailure);
    const statusText = scrub(response.statusText, secrets);
    const retryAfterHeader = response.headers.get('retry-after');
    throw new TransportStatusError(
      response.status,
      statusText,
      retryAfterHeader === null ? undefined : scrub(retryAfterHeader, secrets),
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  // `split` never returns an empty array, so element 0 always exists; the
  // non-null assertion states that invariant instead of an unreachable
  // fallback a mutant could hide in.
  const mediaType = contentType.split(';', 1)[0]!;
  if (mediaType.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(ignoreReleaseFailure);
    throw new TransportContentTypeError(scrub(contentType, secrets));
  }

  // A 2xx without a body (e.g. 204) is delivered as an empty body. Even
  // here the exchange can have lost the abort race: undici may resolve the
  // fetch after the deadline or caller signal fired, so success is declared
  // only after the signal state says the exchange is clean (D-072).
  if (response.body === null) {
    throwIfExchangeAborted(deadline, request.signal, timeoutMs);
    return { status: response.status, contentType, body: '', bytes: 0 };
  }

  const reader = response.body.getReader();
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isInteger(declaredLength) && declaredLength > maxResponseBytes) {
    // Fast path: a declared length already over the cap fails before a
    // single body byte is transferred.
    await reader.cancel().catch(ignoreReleaseFailure);
    throw new TransportResponseTooLargeError(maxResponseBytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // The result type is derived from the reader itself: no DOM-lib global
    // names are available under `types: ["node"]`.
    let read: Awaited<ReturnType<typeof reader.read>>;
    try {
      read = await reader.read();
    } catch (error) {
      throw mapExchangeFailure(error, deadline, request.signal, timeoutMs);
    }
    if (read.done) {
      // A `done` resolution is not by itself success (U-007): under a lost
      // abort-vs-read race the runtime closes an aborted stream as `done`,
      // possibly truncated, and the CI-observed failure mode is exactly a
      // deadline-exceeded exchange resolving as a 200. The signal state is
      // the classification authority (D-042), so it is consulted here too.
      // Everything between this check and the return is synchronous, so no
      // timer can change the answer in between.
      throwIfExchangeAborted(deadline, request.signal, timeoutMs);
      break;
    }
    chunks.push(read.value);
    total += read.value.byteLength;
    if (total > maxResponseBytes) {
      // Enforced mid-read: memory is bounded by the cap plus one chunk, no
      // matter how large the response would have been.
      await reader.cancel().catch(ignoreReleaseFailure);
      throw new TransportResponseTooLargeError(maxResponseBytes);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decode only after all bytes arrived, so multi-byte characters split
  // across chunks survive. Invalid UTF-8 becomes U+FFFD here and fails
  // adapter-side parsing (§7.2's `Format changed`), not transport.
  return {
    status: response.status,
    contentType,
    body: new TextDecoder().decode(merged),
    bytes: total,
  };
}
