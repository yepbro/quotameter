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
 * guard (`./security`, spec §15.3) as this scope's `onRequest` hook — it
 * runs for every route here including the catch-all, so state-changing
 * requests are screened mode-independently before any handler or body
 * parser; tasks 150–152 add the remaining request-security checks, tasks
 * 153–155 the auth/session endpoints, and tasks 159–162 the remaining API
 * endpoints; each registers inside this scope, so the server construction
 * itself never changes shape again.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sendApiError, unmatchedApiClassification } from './error';
import { healthRoutes } from './health';
import { originGuard } from './security';

/**
 * The `/api` route scope. Each endpoint plugin registers here in its own
 * task, so requests under `/api` resolve inside this scope and reach the
 * shared 404 shape, never the static-file fallback.
 */
export const apiRoutes: FastifyPluginAsync = async (fastify) => {
  // Task 149 (spec §15.3, decision D-115): the Origin/Fetch-Metadata
  // guard, first in the scope's lifecycle so a rejected mutation never
  // reaches a handler or its body. Scope registration IS the path
  // predicate: every `/api/…` route (real endpoints, method mismatches,
  // and the catch-all below alike) passes through it identically in every
  // auth mode and both static-serving modes; the bare `/api` (no trailing
  // segment) has no route here at all and stays with the root not-found
  // arm. Task 150's custom-header guard registers beside it.
  fastify.addHook('onRequest', originGuard);
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
