/**
 * HTTP API route registration seam (task 146, spec §13).
 *
 * The construction in `src/server/http.ts` registers this plugin under the
 * `/api` prefix — the single scope where Stage 12 wires routes into the
 * server. Task 147 added the public health response (`./health`), task 148
 * the shared error envelope (`./error`, registered by the construction at
 * root scope so every error answers it) and this scope's own catch-all
 * route — the `/api` unmatched arm as a ROUTE, not just the not-found
 * handler, so no other catch-all (static serving's SPA wildcard) can ever
 * outrank the envelope for `/api` paths; task 149 the Origin/Fetch-Metadata
 * guard and task 150 the custom-header/JSON-content-type guard
 * (`./security`, spec §15.3) as this scope's `onRequest` hooks — they run
 * for every route here including the catch-all, in registration order
 * (the Origin verdict first), so state-changing requests are screened
 * mode-independently before any handler or body parser; task 151's Host
 * allowlist (`./security`, D-120) deliberately registers OUTSIDE this
 * scope, at root scope in the construction (`../http.ts`) — it must bind
 * frontend routes too, and fastify's hook chain runs it ahead of both
 * guards here (outermost-first), so a hostile-Host request answers the
 * Host verdict before any Origin/header class; task 152 the §15.1
 * auth-mode selection (`./auth`, D-121) as the scope's THIRD hook, after
 * the two §15.3 guards — per request it decides whether authentication
 * is required (mode × bind × password presence × proxy indication) and
 * rejects through the envelope's 403-with-instructions and 401 classes,
 * with the health route opting out via its public route config; tasks
 * 153–155 the auth/session endpoints, and tasks 159–162 the remaining API
 * endpoints; each registers inside this scope, so the server construction
 * itself never changes shape again.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createAuthModeGuard, type AuthModeGuardOptions } from './auth';
import { sendApiError, unmatchedApiClassification } from './error';
import { healthRoutes } from './health';
import { customHeaderGuard, originGuard } from './security';

/**
 * What the construction passes beside the prefix when registering this
 * scope. `auth` is required — a security layer whose facts (mode, bind)
 * default silently would mis-derive for exactly the remote deployments
 * it exists to protect, so the construction (`../http.ts`) always
 * derives and passes them explicitly.
 */
export interface ApiRoutesOptions {
  /** The §15.1 auth-mode guard inputs (task 152, D-121). */
  readonly auth: AuthModeGuardOptions;
}

/**
 * The `/api` route scope. Each endpoint plugin registers here in its own
 * task, so requests under `/api` resolve inside this scope and reach the
 * shared 404 shape, never the static-file fallback.
 */
export const apiRoutes: FastifyPluginAsync<ApiRoutesOptions> = async (fastify, options) => {
  // Task 149 (spec §15.3, decision D-115): the Origin/Fetch-Metadata
  // guard, first in the scope's lifecycle so a rejected mutation never
  // reaches a handler or its body. Scope registration IS the path
  // predicate: every `/api/…` route (real endpoints, method mismatches,
  // and the catch-all below alike) passes through it identically in every
  // auth mode and both static-serving modes; the bare `/api` (no trailing
  // segment) has no route here at all and stays with the root not-found
  // arm. Task 150 (D-117): the custom-header/JSON-content-type guard
  // registers beside it, strictly after — a cross-origin mutation is the
  // origin guard's verdict (nothing downstream is consulted), and only a
  // request that passed the Origin check answers the header/content-type
  // classes.
  fastify.addHook('onRequest', originGuard);
  fastify.addHook('onRequest', customHeaderGuard);
  // Task 152 (spec §15.1, decision D-121): the auth-mode selection, third
  // and last of the scope's hooks — a request an earlier guard rejected
  // never reaches the auth question, and the auth guard itself is
  // method-blind (reading is protected like writing: §15.1 speaks of the
  // web interface, not its mutations). Like the guards above it runs for
  // every route here including the catch-all, so an unmatched `/api` path
  // under a demanding verdict answers 401/403 instead of leaking the
  // route table's shape; `GET /api/health` opts out through its public
  // route config (`./auth`, task 147's §13 pin).
  fastify.addHook('onRequest', createAuthModeGuard(options.auth));
  // Task 147: the public health response (§13) — the one endpoint that
  // stays unauthenticated in every auth mode (§15.1).
  await fastify.register(healthRoutes);

  // Task 148 (D-113, post-verification fix): the scope's catch-all route,
  // last in priority (real routes always win) but ahead of any catch-all
  // outside the scope — find-my-way reports an over-long route parameter
  // (`FST_ERR_MAX_PARAM_LENGTH`, the 414 class) only when a failed match
  // leaves no other candidate, so with static serving active the SPA
  // wildcard rescued those requests into a plain 404. As a route inside
  // the scope it answers unmatched `/api` paths in every mode with the
  // same envelope — `unmatchedApiClassification` re-derives the 414 class
  // from the path when a segment exceeds the router's parameter bound.
  // Registered for every method: an unmatched POST/DELETE/PATCH must not
  // fall through to the not-found handler here either (mode-dependence
  // again — the wildcard is GET-only). The not-found handler keeps the
  // bare-`/api` and non-API arms.
  fastify.all('/*', (request, reply) => {
    // `split` never returns an empty array — the first element always exists.
    sendApiError(reply, unmatchedApiClassification(request.method, request.url.split('?')[0]!));
  });
};
