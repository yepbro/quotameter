/**
 * The common API error machinery (task 148, spec §13, §15.4, §15.5, §16;
 * decision D-113).
 *
 * Everything the server answers an error with funnels through here and lands
 * on the §13 envelope: `{ "error": { "code", "message", "details" } }` with a
 * stable, machine-readable code from the registry
 * (`src/schemas/api/error.ts`). Three pieces:
 *
 * - **`ApiError`** — the throw-side extension point. Later tasks plug their
 *   rejections in by throwing it (auth-mode selection 152, Origin/header
 *   checks 149/150, endpoint handlers 159+; §15.2's rate limiting never
 *   joins this list — D-125 pins increasing delays, not rejections, so
 *   it throws nothing); the class
 *   carries the registry's status and default message, so a thrown error
 *   is already the envelope's classification.
 * - **`classifyApiError`** — the trust boundary between "anything thrown" and
 *   the wire. Recognized shapes: `ApiError`, fastify's schema-validation
 *   errors (`error.validation`, projected to client-derived `where`/`path`/
 *   `message` triples), and the native fastify transport codes verified on
 *   the pinned runtime (5.12.7). Everything else — any unknown error, any
 *   foreign `statusCode`, any non-Error throwable — resolves to `INTERNAL`
 *   with the generic message: an unknown-provenance message never reaches the
 *   wire (§13/§15.4), and the real cause is logged server-side instead.
 * - **`apiErrorHandler`** — the Fastify error handler the construction
 *   (`src/server/http.ts`) registers at root scope AND wires as the
 *   `frameworkErrors` callback (fastify's router-level failures — a
 *   malformed percent-escape — bypass `setErrorHandler` entirely without
 *   it, answering a hardcoded non-envelope body; review fix), plus
 *   {@link notFoundClassification} for the 404 arm, which lives in the
 *   not-found handler (an unmatched route is not an error in fastify),
 *   {@link unmatchedApiClassification} for the `/api` scope's catch-all
 *   route (the mode-independent 404/414 arm — see its docblock), and
 *   {@link staticServingErrorHandler}, the containment handler of the
 *   static-serving scope.
 *
 * §16 logging discipline: only the `INTERNAL` class logs (`request.log.error`
 * with the error under `err` — the redacting logger's Layer-A serializer
 * carries type/message/stack safely); 4xx classes log nothing, because at
 * `info` the spec allows lifecycle events only and request logging stays at
 * `debug`.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  API_ERROR_DEFINITIONS,
  isApiErrorCode,
  type ApiErrorBody,
  type ApiErrorCode,
} from '../../schemas/api/error';

/**
 * The native fastify error codes normalized into the registry (each verified
 * on the pinned runtime, fastify 5.12.7): the §15.5 body limit, unregistered
 * content types, the three body-parse failures, and the two router-level
 * request-URI bounds that reach the `frameworkErrors` callback the
 * construction wires to the same handler (a malformed percent-escape is a
 * malformed request, hence `VALIDATION`; an over-long route parameter is the
 * 414 class). Precision (post-verification fix): the 414 code fires only
 * when the failed parameter match leaves the router no other candidate —
 * any registered catch-all rescues the request first, which is why the
 * `/api` scope carries its own catch-all route classifying those requests
 * via {@link unmatchedApiClassification}, mode-independently; this mapping
 * remains the dead-end mechanism for param routes outside that scope. One
 * further precision point (review-verified): the body-limit and
 * body-parse classes reach the error handler even for unmatched routes
 * (body parsing precedes routing), while the 415 content-type class needs a
 * matched route — an unmatched one answers the 404 envelope first, because
 * no parser runs. Fastify's schema-validation code needs no entry here — it
 * is recognized by the richer `code` + `error.validation` shape below.
 */
const NATIVE_FASTIFY_ERROR_CODES: Readonly<Record<string, ApiErrorCode>> = Object.freeze({
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_CTP_INVALID_JSON_BODY: 'VALIDATION',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'VALIDATION',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'VALIDATION',
  FST_ERR_BAD_URL: 'VALIDATION',
  FST_ERR_MAX_PARAM_LENGTH: 'URI_TOO_LONG',
});

/** What {@link ApiError} accepts beside the mandatory code. */
export interface ApiErrorOptions {
  /**
   * Overrides the registry's default message (§15.1's "403 with
   * instructions" shape). The writer owns §13/§15.4 discipline: no secrets,
   * no internal paths, no framework jargon.
   */
  readonly message?: string;
  /** Structured, JSON-serializable context for the client; `null` when omitted. */
  readonly details?: unknown;
}

/**
 * The application error every later Stage-12 task rejects through: throwing
 * it from a handler or hook (auth checks run pre-handler) is the whole
 * integration — the registered handler classifies it by construction.
 */
export class ApiError extends Error {
  /** The stable machine-readable code (spec §13). */
  readonly code: ApiErrorCode;
  /** The registry's status for {@link code} — the single source, callers cannot set it. */
  readonly statusCode: number;
  /** Client-facing context; `null` when the class carries none (key always present on the wire). */
  readonly details: unknown;

  constructor(code: ApiErrorCode, options: ApiErrorOptions = {}) {
    if (!isApiErrorCode(code)) {
      // The registry style of D-013: wiring mistakes fail fast, loudly.
      throw new TypeError(
        `unknown API error code '${String(code)}'; add it to API_ERROR_DEFINITIONS in ` +
          'src/schemas/api/error.ts first (decision D-113)',
      );
    }
    if (code === 'INTERNAL' && (options.message !== undefined || options.details !== undefined)) {
      // The INTERNAL wire shape is generic by contract (§15.4): overrides
      // exist for the client-actionable 4xx shapes, never for this class —
      // a hand-written INTERNAL message is exactly the leak the strict
      // classifier exists to prevent. Fail at the throw site, not on the
      // wire. The real cause belongs in the log: throw the original error
      // and let the handler do the logging.
      throw new TypeError(
        'ApiError code INTERNAL cannot carry a message or details — the response is the generic ' +
          'envelope and the cause is logged server-side (decision D-113)',
      );
    }
    const definition = API_ERROR_DEFINITIONS[code];
    super(options.message ?? definition.message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.details = options.details ?? null;
  }
}

/** One resolved error response: everything {@link sendApiError} sends. */
export interface ApiErrorClassification {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: unknown;
}

/** Narrows an arbitrary throwable to its record view (`null` for non-objects). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A field read from an arbitrary throwable: text or the empty fallback. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A classification straight from a registry code: the default shape, `details: null`. */
function classificationFor(code: ApiErrorCode): ApiErrorClassification {
  return {
    statusCode: API_ERROR_DEFINITIONS[code].statusCode,
    code,
    message: API_ERROR_DEFINITIONS[code].message,
    details: null,
  };
}

/**
 * Maps any thrown value onto the registry — the pure half of the error
 * handler, total over `unknown` (a route can throw a non-Error; the handler
 * receives it verbatim).
 */
export function classifyApiError(error: unknown): ApiErrorClassification {
  if (error instanceof ApiError) {
    if (error.code === 'INTERNAL') {
      // The constructor refuses overrides, so this arm only fires for a
      // mutated instance (message is writable on Error) — the generic wire
      // shape survives the mutation (§15.4, review fix).
      return classificationFor('INTERNAL');
    }
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  const thrown = asRecord(error);
  if (thrown !== null) {
    // Fastify's schema-validation error is recognized by its code AND its
    // `validation` array (both set on the pinned runtime): requiring both
    // keeps a foreign throwable that merely carries a `validation` property
    // from being projected onto the wire (review fix). `validation` holds
    // Ajv error objects, `validationContext` names where (body/querystring/
    // params/headers); the projection keeps client- and schema-derived
    // text only.
    const validation = thrown.validation;
    if (
      asText(thrown.code) === 'FST_ERR_VALIDATION' &&
      Array.isArray(validation) &&
      validation.length > 0
    ) {
      return {
        statusCode: API_ERROR_DEFINITIONS.VALIDATION.statusCode,
        code: 'VALIDATION',
        message: API_ERROR_DEFINITIONS.VALIDATION.message,
        details: {
          validation: validation.map((item) => {
            const record = asRecord(item) ?? {};
            return {
              where: typeof thrown.validationContext === 'string' ? thrown.validationContext : null,
              path: asText(record.instancePath),
              message: asText(record.message),
            };
          }),
        },
      };
    }
    const nativeCode = asText(thrown.code);
    if (Object.hasOwn(NATIVE_FASTIFY_ERROR_CODES, nativeCode)) {
      return classificationFor(NATIVE_FASTIFY_ERROR_CODES[nativeCode]!);
    }
  }

  // Unknown provenance — a generic 500, never the error's own words on the
  // wire (§13/§15.4); a foreign `statusCode` does not buy trust either.
  return classificationFor('INTERNAL');
}

/**
 * Sends one classification as the §13 envelope — the single site composing
 * the body (key order = the spec's: code, message, details; typed against
 * the schema contract so the composition cannot drift from it), the status,
 * and §15.5's `no-store` (an error response is an API response; task 158's
 * global header pass generalizes later, the D-111 route-scoped precedent).
 */
export function sendApiError(reply: FastifyReply, classification: ApiErrorClassification): void {
  const body: ApiErrorBody = {
    error: {
      code: classification.code,
      message: classification.message,
      details: classification.details,
    },
  };
  reply.code(classification.statusCode).header('cache-control', 'no-store').send(body);
}

/**
 * The 404 classification for the not-found handler: the client's own method
 * and path as details (nothing internal — routing failed on their request),
 * a fixed message (§13 discipline over the old route-echoing default).
 */
export function notFoundClassification(method: string, path: string): ApiErrorClassification {
  return {
    ...classificationFor('NOT_FOUND'),
    details: { method, path },
  };
}

/**
 * The router's parameter bound (find-my-way's `maxParamLength`, default
 * 100 — the value the construction passes explicitly, so this constant
 * and the router's actual bound are one and the same). A path segment
 * longer than this can never fill a route parameter, so the request is
 * un-routable however it arrived.
 */
export const API_MAX_PARAM_LENGTH = 100;

/**
 * Whether any path segment exceeds {@link API_MAX_PARAM_LENGTH},
 * measured on the decoded segment — the same yardstick find-my-way
 * uses when it validates parameter values (a percent-encoded segment
 * that decodes inside the bound routes fine; see the unit suite).
 * An undecodable segment falls back to its raw length (defensive only:
 * malformed escapes are rejected before routing as `FST_ERR_BAD_URL`).
 */
function routerParamOverflow(path: string): boolean {
  return path.split('/').some((segment) => {
    let value = segment;
    try {
      value = decodeURIComponent(segment);
    } catch {
      // Malformed escape: keep the raw segment (see docblock).
    }
    return value.length > API_MAX_PARAM_LENGTH;
  });
}

/**
 * The classification for a request that matched no API route but landed
 * in the `/api` scope's own catch-all route (decision D-113,
 * post-verification fix): find-my-way reports an over-long parameter
 * (`FST_ERR_MAX_PARAM_LENGTH`) only when the failed match leaves no
 * other candidate — any registered catch-all rescues the request
 * first, so in static-serving mode the SPA wildcard was swallowing the
 * over-long-parameter error and answering a plain 404 (mode-dependent
 * §13 class). The scope's catch-all outranks that wildcard for `/api`
 * paths and re-derives the class from the path itself, making the
 * `URI_TOO_LONG` arm identical in every mode; the native-code mapping
 * stays as the dead-end mechanism for param routes outside the scope.
 */
export function unmatchedApiClassification(method: string, path: string): ApiErrorClassification {
  return routerParamOverflow(path)
    ? classificationFor('URI_TOO_LONG')
    : notFoundClassification(method, path);
}

/**
 * The Fastify error handler (registered at root scope by `buildHttpServer`
 * and wired as its `frameworkErrors` callback, decision D-113): classify,
 * log internals server-side (§16), send the envelope.
 */
export function apiErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const classification = classifyApiError(error);
  if (classification.code === 'INTERNAL') {
    // The one class that logs: the real cause, server-side only, through
    // the redacting logger's `err` serializer (D-025 Layer A).
    request.log.error({ err: error }, 'request failed with an internal error');
  }
  sendApiError(reply, classification);
}

/**
 * The error handler of the static-serving scope (decision D-113, review
 * fix): `@fastify/static`'s wildcard delegates to the `send` library, whose
 * client rejections — a `%00` byte or traversal shape in the path, a missing
 * file — carry only a foreign `statusCode` (403/404, no framework code) and
 * so would fall to the strict rule's `INTERNAL`: a client typo answered as a
 * server fault **plus** an error-level log record per request. Inside this
 * one scope the provenance is known (our static stack), so the two 4xx
 * statuses map onto the envelope's `FORBIDDEN`/`NOT_FOUND` with generic
 * messages — never `err.message` — and anything else escalates to the root
 * handler unchanged. No record is logged for either contained class.
 */
export function staticServingErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const status = asRecord(error)?.statusCode;
  if (status === 403) {
    sendApiError(reply, classificationFor('FORBIDDEN'));
    return;
  }
  if (status === 404) {
    sendApiError(reply, notFoundClassification(request.method, request.url.split('?')[0]!));
    return;
  }
  apiErrorHandler(error, request, reply);
}
