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
 * itself never changes shape again. Task 159 (D-128) landed the accounts
 * endpoints (`./accounts`) as the first dependency-carrying plugin here —
 * registered only when `ApiRoutesOptions.accounts` supplies the store
 * seams, so the unwired construction keeps answering the catch-all 404;
 * task 160 (D-130) added the status, providers, quota, and settings
 * endpoints (`./status`, `./providers`, `./settings`) behind the same
 * optional-options rule; task 162 (D-142) the peak-hours endpoint
 * (`./peak-hours`), completing §13's route table.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { AccountsRouteOptions } from './accounts';
import { accountRoutes } from './accounts';
import { createAuthModeGuard, type AuthModeGuardOptions } from './auth';
import { sendApiError, unmatchedApiClassification } from './error';
import { healthRoutes } from './health';
import type { HistoryRouteOptions } from './history';
import { historyRoutes } from './history';
import type { ProvidersRouteOptions } from './providers';
import { providersRoutes } from './providers';
import { customHeaderGuard, originGuard } from './security';
import type { PeakHoursRouteOptions } from './peak-hours';
import { peakHoursRoutes } from './peak-hours';
import type { SettingsRouteOptions } from './settings';
import { settingsRoutes } from './settings';
import type { StatusRouteOptions } from './status';
import { statusRoutes } from './status';

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
  /**
   * The accounts endpoints' dependencies (task 159, D-128) — the
   * configuration-store seam, the storage facade, the provider registry,
   * and the clock. Optional because the accounts routes are the first
   * endpoints needing runtime dependencies the task-146 construction does
   * not hold (the composition root that owns the configuration file and
   * the database is future work): absent, the plugin does not register and
   * `/api/accounts*` answers the scope catch-all's 404 envelope like every
   * other unimplemented §13 route — the surface appears exactly when it is
   * wired to real stores, never half-wired.
   */
  readonly accounts?: AccountsRouteOptions;
  /**
   * The status-family endpoints' dependencies (task 160, D-130) — the
   * configuration-store seam (159's own), the storage facade, the per-
   * request interval reader, the D-064 suspension holder, and the clock;
   * registers `GET /api/status` and `GET /api/quota`. Optional for the
   * same reason as `accounts`: absent, both paths answer the scope
   * catch-all's 404 envelope until the composition wires real stores.
   */
  readonly status?: StatusRouteOptions;
  /**
   * The providers endpoint's dependencies (task 160, D-130) — the registry
   * and the live schedule reader; registers `GET /api/providers`. Absent,
   * the path answers the scope catch-all's 404 envelope.
   */
  readonly providers?: ProvidersRouteOptions;
  /**
   * The settings endpoints' dependencies (task 160, D-130) — the
   * configuration read/write-reload seam (`SettingsStore`, the D-121/D-128
   * pattern at its third consumer); registers `GET /api/settings` and
   * `PUT /api/settings`. Absent, both paths answer the scope catch-all's
   * 404 envelope.
   */
  readonly settings?: SettingsRouteOptions;
  /**
   * The history-family endpoints' dependencies (task 161, D-139) — the
   * configuration-store seam (159's own), the storage facade, the §6.4-live
   * retention reader, and the clock; registers `GET /api/history` and
   * `GET /api/events`. Optional for the same reason as `accounts`: absent,
   * both paths answer the scope catch-all's 404 envelope until the
   * composition wires real stores.
   */
  readonly history?: HistoryRouteOptions;
  /**
   * The peak-hours endpoint's dependencies (task 162, D-142) — the
   * configuration-store seam (159's own), the storage facade, the live
   * providers-section reader (160's own), the §6.4-live retention reader,
   * and the clock; registers `GET /api/peak-hours`. Optional for the same
   * reason as `accounts`: absent, the path answers the scope catch-all's
   * 404 envelope until the composition wires real stores.
   */
  readonly peakHours?: PeakHoursRouteOptions;
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

  // Task 159 (spec §13, §8.2; decision D-128): the accounts endpoints —
  // list/create/update/archive/purge/test with write-only keys. Registered
  // as an encapsulated child of this scope, so the three guards above run
  // for these routes exactly like every other `/api` route (fastify's hook
  // encapsulation cascades onRequest hooks to descendant plugins); the
  // concrete routes outrank the catch-all below by router specificity, not
  // registration order. Registered only when the construction supplies the
  // dependencies — see `ApiRoutesOptions.accounts`.
  if (options.accounts !== undefined) {
    await fastify.register(accountRoutes, options.accounts);
  }

  // Task 160 (spec §13, §7.3, §8.4, §9.2, §6.4; decision D-130): the
  // status, providers, quota, and settings endpoints — read-only §7.3
  // composition over the polling-status derivation and the repository, the
  // registry listing with read-only schedules, and the safe settings
  // view/update behind the injected `SettingsStore` seam. Each registers as
  // an encapsulated child of this scope (the three guards above cascade),
  // and only when the construction supplies its dependencies — the
  // no-half-wired-surface rule of `accounts` above.
  if (options.status !== undefined) {
    await fastify.register(statusRoutes, options.status);
  }
  if (options.providers !== undefined) {
    await fastify.register(providersRoutes, options.providers);
  }
  if (options.settings !== undefined) {
    await fastify.register(settingsRoutes, options.settings);
  }

  // Task 161 (spec §12, §13; decision D-139): the history and events
  // endpoints — the retention-aware series with §13 downsampling and §12.2
  // gap empty points, and the unified §12.2 timeline (resets, gaps, failed
  // cycles, stopped-service regions). Same encapsulated-child registration
  // and no-half-wired rule as the families above.
  if (options.history !== undefined) {
    await fastify.register(historyRoutes, options.history);
  }

  // Task 162 (spec §9.3, §13; decision D-142): the peak-hours endpoint —
  // the account's provider schedule as UTC peak/off-peak intervals over the
  // retention-bounded range, §13's third range-bearing consumer. Same
  // encapsulated-child registration and no-half-wired rule as the families
  // above.
  if (options.peakHours !== undefined) {
    await fastify.register(peakHoursRoutes, options.peakHours);
  }

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
