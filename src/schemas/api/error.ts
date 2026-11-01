/**
 * The common error-response contract (task 148, spec §13, §15.4).
 *
 * §13: "Use a common error envelope: `{ "error": { "code": "...", "message":
 * "...", "details": ... } }`. `code` is stable and machine-readable. Messages
 * must not reveal secrets or internal filesystem paths." The spec names no
 * codes, so this module is the resolved table: one registry holding every
 * error class the API can answer with — its stable code, HTTP status, and the
 * default (leak-free) message — plus the closed TypeBox envelope schema that
 * pins the wire shape. Task 163 generates OpenAPI from the same definition.
 *
 * The registry is the sanctioned vocabulary (decision D-113): a new error
 * class is a coordinated addition here (registry entry + schema literal +
 * tests); anything the running server cannot classify resolves to `INTERNAL`
 * with the generic message, so an unknown-provenance message never reaches
 * the wire.
 *
 * Placement follows the schemas layer rule (leaf, no `src/` imports): the
 * code vocabulary, status mapping, default messages, and envelope shape are
 * pure data — the throwing/classifying machinery lives in
 * `src/server/api/error.ts`, which imports this module the way the health
 * route imports `./health.ts`.
 */

import { type Static, Type } from '@sinclair/typebox';

/**
 * Every error class the API answers with (decision D-113): the stable
 * machine-readable code, the HTTP status it maps to, and the default message
 * — English, actionable, and free of secrets, internal paths, and framework
 * jargon by construction (the overrides `ApiError` accepts must keep that
 * discipline; §15.4 binds whoever writes them).
 */
export const API_ERROR_DEFINITIONS = Object.freeze({
  /** A request body/query/params/headers value failed its schema, the body could not be parsed, or the request path was malformed. */
  VALIDATION: Object.freeze({ statusCode: 400, message: 'Request validation failed' }),
  /** Authentication is required and absent/invalid — §15.1's modes land in task 152. */
  UNAUTHENTICATED: Object.freeze({ statusCode: 401, message: 'Authentication required' }),
  /** The request is understood but refused (§15.1's proxy-without-password 403, CSRF rejections, rejected file paths). */
  FORBIDDEN: Object.freeze({ statusCode: 403, message: 'Forbidden' }),
  /** No route or resource matches the request. */
  NOT_FOUND: Object.freeze({ statusCode: 404, message: 'Not found' }),
  /** The body exceeded the §15.5 64 KiB request-body limit. */
  PAYLOAD_TOO_LARGE: Object.freeze({
    statusCode: 413,
    message: 'Request body exceeds the 64 KiB limit',
  }),
  /** A router-level bound on the request URI (a route parameter exceeding fastify's max param length). */
  URI_TOO_LONG: Object.freeze({
    statusCode: 414,
    message: 'The request URI is too long',
  }),
  /** The request's Content-Type has no parser (§13 speaks JSON). */
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({
    statusCode: 415,
    message: 'Content-Type is not supported',
  }),
  /** An unexpected server-side failure — the wire message is generic by design; the cause is logged (§16). */
  INTERNAL: Object.freeze({ statusCode: 500, message: 'Internal server error' }),
} as const);

/** One code of {@link API_ERROR_DEFINITIONS}. */
export type ApiErrorCode = keyof typeof API_ERROR_DEFINITIONS;

/** Type guard for {@link ApiErrorCode} (construction-time validation). */
export function isApiErrorCode(code: string): code is ApiErrorCode {
  return Object.hasOwn(API_ERROR_DEFINITIONS, code);
}

/**
 * The §13 envelope, closed at both levels: `code` is exactly the registry's
 * literal union (the unit suite pins the literals against the registry keys,
 * so the two cannot drift), `message` a string, `details` any JSON value —
 * `null` when a class carries none, so the key is always present and the
 * body byte-stable.
 */
export const ApiErrorBodySchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal('VALIDATION'),
          Type.Literal('UNAUTHENTICATED'),
          Type.Literal('FORBIDDEN'),
          Type.Literal('NOT_FOUND'),
          Type.Literal('PAYLOAD_TOO_LARGE'),
          Type.Literal('URI_TOO_LONG'),
          Type.Literal('UNSUPPORTED_MEDIA_TYPE'),
          Type.Literal('INTERNAL'),
        ]),
        message: Type.String(),
        details: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** The shape every error response serializes to (spec §13). */
export type ApiErrorBody = Static<typeof ApiErrorBodySchema>;
