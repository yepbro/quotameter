/**
 * The UI-side error taxonomy over the §13 surface (task 169, spec §13, §14;
 * decision D-134).
 *
 * Every way an API call can fail collapses onto one class,
 * {@link ApiClientError}, discriminated by {@link ApiClientErrorKind} — the
 * stable vocabulary the presentation component maps onto catalog messages.
 * The kinds follow the failure layers a browser fetch actually has:
 *
 * - `network` — `fetch` itself rejected: the service is unreachable
 *   (connection refused, DNS, a CSP-blocked origin). No HTTP response
 *   exists.
 * - `timeout` — the client's own request deadline fired (the default or
 *   per-client `timeoutMs`): a response may never arrive. Distinguished
 *   from a deliberate cancellation by who aborted.
 * - `aborted` — the CALLER's `AbortSignal` fired: a deliberate
 *   cancellation, not a failure to present.
 * - `unexpected` — an HTTP response arrived whose body is not the §13
 *   envelope and not usable JSON: an HTML error page from a misrouted
 *   proxy, a captive portal's JSON, invalid JSON, or a non-2xx without
 *   the envelope. The response exists (`status` carried); its shape does
 *   not.
 * - `rejected` — the §13 error envelope: `{error: {code, message,
 *   details}}`. `code` is the registry vocabulary of
 *   `src/schemas/api/error.ts` on the wire (D-113); hostile or future
 *   values are admitted as-is, so the field is `string` and the
 *   presentation carries a fallback message for non-registry codes.
 *
 * The leak discipline (§13/§15.4, made client-side): the envelope's
 * `message` and `details` are carried for programmatic use ONLY, on the
 * clearly-named {@link ApiClientError.serverMessage}/
 * {@link ApiClientError.serverDetails} fields — the client cannot vouch
 * for their provenance (a same-origin response is the trusted shape, but
 * the taxonomy must stay total over what the network can deliver), so no
 * presentation surface renders them. `Error.message` itself is a fixed
 * per-kind sentence: nothing response-derived ever enters it.
 */

/** How an API call failed — the presentation's whole decision input. */
export type ApiClientErrorKind = 'network' | 'timeout' | 'aborted' | 'unexpected' | 'rejected';

/**
 * The one error class every client method throws. `kind` drives
 * presentation; the optional fields are facts about the exchange, present
 * exactly when their layer existed.
 */
export class ApiClientError extends Error {
  /** Which failure layer produced this error. */
  readonly kind: ApiClientErrorKind;
  /** The HTTP status, when a response arrived (`unexpected`, `rejected`). */
  readonly status?: number;
  /**
   * The envelope's `error.code`, when `kind === 'rejected'`. The expected
   * vocabulary is the registry (`src/schemas/api/error.ts`, D-113); typed
   * `string` because a hostile or newer server can send anything, and the
   * presentation's fallback branch answers what it does not know.
   */
  readonly code?: string;
  /**
   * The envelope's `error.message` — NEVER rendered. The server's own
   * messages are leak-free by construction (D-113), but the client cannot
   * vouch for what actually answered; presentation uses catalog strings
   * keyed by `kind`/`code` instead. Kept for programmatic consumers
   * (diagnostics, future task-180 handling of `UNAUTHENTICATED`).
   */
  readonly serverMessage?: string;
  /**
   * The envelope's `error.details` (any JSON value) — NEVER rendered, same
   * provenance rule as {@link serverMessage}. Kept for programmatic use.
   */
  readonly serverDetails?: unknown;

  constructor(init: {
    readonly kind: ApiClientErrorKind;
    readonly status?: number;
    readonly code?: string;
    readonly serverMessage?: string;
    readonly serverDetails?: unknown;
    readonly cause?: unknown;
  }) {
    // Fixed per-kind text: `Error.message` is a developer-facing
    // description, and nothing a response carried may enter it (a hostile
    // code or message must not ride it into a log or an accidental
    // `{{ error.message }}` render).
    super(`Quotameter API request failed: ${init.kind}`, { cause: init.cause });
    this.name = 'ApiClientError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.serverMessage = init.serverMessage;
    this.serverDetails = init.serverDetails;
  }
}

/** Narrows an unknown catch to the client's error class. */
export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/** The §13 envelope as parsed JSON — the shape `rejected` is built from. */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Recognizes the §13 envelope in a parsed body — total over `unknown` and
 * deliberately loose: `code`/`message` must be strings (the two fields the
 * contract always carries, D-113), `details` is any JSON value and optional
 * on the reader (the server always sends the key, but a hostile or future
 * shape that omits it is still an envelope worth classifying, not junk).
 * A body recognized here classifies as `rejected` regardless of the HTTP
 * status — the envelope says what it says.
 */
export function parseApiErrorEnvelope(parsed: unknown): ApiErrorEnvelope | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const error = (parsed as { readonly error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, details } = error as { readonly [key: string]: unknown };
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return { error: { code, message, details } };
}
