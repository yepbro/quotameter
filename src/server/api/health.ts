/**
 * The public health route (task 147, spec §13, §15.1, §15.5; decisions
 * D-111 and D-192 — the latter's authenticated diagnostics).
 *
 * `GET /api/health` is the one §13 endpoint that answers without
 * authentication in every auth mode (§15.1): since task 152 the route
 * declares that through its `config` object
 * ({@link PUBLIC_AUTH_ROUTE_CONFIG} from `./auth`) — the auth-mode
 * guard's opt-out contract, read from `request.routeOptions` before the
 * verdict — so the exemption is the route's own, explicit and
 * method-scoped (the auto-generated HEAD twin inherits it), never an
 * accident of hook registration order. Nothing here consults credentials
 * to decide REACHABILITY, and §13's "except the public health response"
 * binds the request-security tasks (149–152) to keep the route reachable
 * unauthenticated. The unauthenticated response is the literal
 * `{"status":"ok"}` — pinned byte-exactly by the schema-compiled
 * serializer, which drops every key the schema does not declare and
 * omits the absent optional `polling` block entirely, so no system
 * diagnostic can leak through this route even if a future handler edit
 * returns one.
 *
 * The authenticated half of §13's row (D-180's amendment naming the
 * polling engine; D-192's landing): a request the §15.1 layer would
 * GRANT — the `not-required` verdict (auto mode, loopback bind, no proxy
 * indication: the local operator's trust cell, the same boundary that
 * serves `/api/status` without a password) or a valid session through
 * the same credential seam the guard consults — additionally receives
 * the `polling.running` diagnostics: whether the scheduler's dispatch
 * loop is alive (a wiring failure kills it with `running=false`, the
 * audit's dead-state finding). Every other shape keeps the literal body:
 * the credential seam is consulted only on the `required` verdict — the
 * guard's own decision table — so the passwordless proxied request
 * (§15.1's 403 class for protected routes, refused without any seam
 * consultation) is answered plainly no matter what a still-valid session
 * row would say, and `required` mode without an accepted session keeps
 * the literal too. A construction that wires no `polling` source
 * answers the literal in EVERY state: the diagnostics surface appears
 * exactly when it is wired to a real engine, never half-wired (the
 * scope's no-half-wired-surface rule).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { AuthModeSource } from './auth-routes';
import {
  classifyAuthMode,
  PUBLIC_AUTH_ROUTE_CONFIG,
  proxyIndicatorPresent,
  type RequestAuthenticator,
} from './auth';
import { isLoopbackHost, type AuthMode } from '../../schemas/config';
import { HealthResponseSchema, type HealthResponse } from '../../schemas/api/health';

/**
 * Spec §13's literal response — the whole public contract: one frozen key.
 */
export const HEALTH_RESPONSE: HealthResponse = Object.freeze({ status: 'ok' });

/**
 * Options of {@link healthRoutes}. Every member is optional: a bare
 * registration (`fastify.register(healthRoutes)`) is the task-147 public
 * route with no diagnostics at all, and the diagnostics branch exists
 * exactly when a `polling` source is wired beside the §15.1 facts that
 * govern its grant rule — the `/api` scope (`./index.ts`) supplies those
 * facts from its own guard options, the same single source the guard and
 * the session reader (D-182) read.
 */
export interface HealthRouteOptions {
  /**
   * The polling engine's liveness reader — the diagnostics source
   * (FSM-4, D-192). Read per request (the scheduler's `running` getter
   * is live), so the value never goes stale behind a cached response.
   */
  readonly polling?: { readonly running: () => boolean };
  /**
   * The §15.1 facts the grant rule derives from ({@link AuthModeSource},
   * the session reader's own injection shape). Required when `polling`
   * is wired — diagnostics without the grant rule would be a wiring bug
   * the registration refuses loudly.
   */
  readonly authMode?: AuthModeSource;
  /**
   * The credential seam ({@link RequestAuthenticator}) — the same
   * instance the §15.1 guard consults (the composition wires
   * `createSessionAuthenticator` once, both consumers share it).
   * Defaults fail-closed to "no request is authenticated", the guard's
   * own default; the `not-required` grant cell needs no credential at
   * all.
   */
  readonly isAuthenticated?: RequestAuthenticator;
}

/** The diagnostics branch's grant facts, assembled once at registration. */
interface GrantFacts {
  /** The liveness reader (the wired `polling.running`). */
  readonly running: () => boolean;
  /** The configured `auth.mode` (§15.1). */
  readonly mode: AuthMode;
  /** The §15.1 bind fact, reduced once with `isLoopbackHost`. */
  readonly bindIsLoopback: boolean;
  /** Whether a password is configured — the live §6.4/D-026 thunk. */
  readonly passwordConfigured: () => boolean;
}

/**
 * Registers `GET /health` inside the `/api` scope (`./index.ts`, task 146's
 * route seam). GET-only: other methods find no route and answer the §13
 * error envelope (task 148, D-113); Fastify's default `exposeHeadRoute`
 * twin answers HEAD with the same headers and no body (nothing can leak
 * through it).
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, options) => {
  /**
   * The grant facts: the diagnostics source plus the §15.1 halves (mode
   * and bind decided here — §6.4 restart-requiring, the guard factory's
   * own precedent — and the live password thunk). `undefined` when no
   * `polling` source is wired: the route then answers the literal in
   * every state (the task-147 contract). A wired source without the
   * facts is a wiring bug the registration refuses loudly.
   */
  const { polling, authMode } = options;
  let grant: GrantFacts | undefined;
  if (polling !== undefined) {
    if (typeof polling.running !== 'function') {
      throw new TypeError('healthRoutes: polling.running must be a function');
    }
    if (authMode === undefined) {
      throw new TypeError(
        'healthRoutes: polling diagnostics require the authMode facts (the §15.1 grant rule)',
      );
    }
    grant = {
      running: polling.running,
      mode: authMode.mode,
      bindIsLoopback: isLoopbackHost(authMode.bindHost),
      passwordConfigured: authMode.passwordConfigured ?? (() => false),
    };
  }
  // The credential seam, fail-closed like the guard's own default.
  const isAuthenticated = options.isAuthenticated ?? (() => false);

  fastify.get(
    '/health',
    {
      // §13: the response is defined by schema. The compiled serializer
      // emits exactly `{"status":"ok"}` for the unauthenticated payload
      // (an absent optional property serializes to nothing) and
      // structurally drops any other key (`additionalProperties: false`)
      // — the done-condition enforced at serialization, not by handler
      // discipline.
      schema: { response: { 200: HealthResponseSchema } },
      // §13/§15.1 (task 152, D-121): the auth-mode guard's public opt-out
      // — the one §13 endpoint that answers unauthenticated in every
      // auth mode and every proxy/password state.
      config: PUBLIC_AUTH_ROUTE_CONFIG,
    },
    async (request) => {
      // §15.5's `Cache-Control: no-store` for API responses is the
      // construction's root-scope rule since task 158 (D-127) — the
      // route-scoped header this handler carried between tasks 147 and
      // 158 is gone, generalized. The handler below decides only the
      // body: the literal, or the literal plus the granted diagnostics.
      if (grant === undefined) {
        return HEALTH_RESPONSE;
      }
      // The grant rule (D-192): diagnostics for exactly the requests the
      // §15.1 layer would grant any protected route — the `not-required`
      // verdict first (the local operator's cell; short-circuits before
      // the credential seam, so a direct loopback probe never touches
      // session storage), then the seam ONLY on the `required` verdict,
      // exactly as the guard consults it. The `proxy-without-password`
      // cell is refused STRUCTURALLY — the guard 403s it without ever
      // consulting the seam (a session the seam might still accept — the
      // hash is a live fact, and removing it does not revoke existing
      // rows — buys nothing on a route the §15.1 layer refuses), so the
      // literal body is that cell's answer regardless of seam state.
      const verdict = classifyAuthMode({
        mode: grant.mode,
        bindIsLoopback: grant.bindIsLoopback,
        passwordConfigured: grant.passwordConfigured(),
        proxyIndicated: proxyIndicatorPresent(Object.keys(request.headers)),
      });
      const granted =
        verdict.authentication === 'not-required' ||
        (verdict.authentication === 'required' && (await isAuthenticated(request)));
      if (!granted) {
        return HEALTH_RESPONSE;
      }
      const response: HealthResponse = {
        status: 'ok',
        polling: { running: grant.running() },
      };
      return response;
    },
  );
};
