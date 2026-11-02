/**
 * The public health route (task 147, spec §13, §15.1, §15.5; decision D-111).
 *
 * `GET /api/health` is the one §13 endpoint that answers without
 * authentication in every auth mode (§15.1): since task 152 the route
 * declares that through its `config` object
 * ({@link PUBLIC_AUTH_ROUTE_CONFIG} from `./auth`) — the auth-mode
 * guard's opt-out contract, read from `request.routeOptions` before the
 * verdict — so the exemption is the route's own, explicit and
 * method-scoped (the auto-generated HEAD twin inherits it), never an
 * accident of hook registration order. Nothing here consults
 * credentials, and §13's "except the public health response" binds the
 * request-security tasks (149–152) to keep the route reachable unauthenticated.
 * The response is the literal `{"status":"ok"}` — pinned byte-exactly by the
 * schema-compiled serializer, which drops every key the schema does not
 * declare, so no system diagnostic can leak through this route even if a
 * future handler edit returns one.
 */

import type { FastifyPluginAsync } from 'fastify';
import { PUBLIC_AUTH_ROUTE_CONFIG } from './auth';
import { HealthResponseSchema, type HealthResponse } from '../../schemas/api/health';

/**
 * Spec §13's literal response — the whole public contract: one frozen key.
 */
export const HEALTH_RESPONSE: HealthResponse = Object.freeze({ status: 'ok' });

/**
 * Registers `GET /health` inside the `/api` scope (`./index.ts`, task 146's
 * route seam). GET-only: other methods find no route and answer the §13
 * error envelope (task 148, D-113); Fastify's default `exposeHeadRoute`
 * twin answers HEAD with the same headers and no body (nothing can leak
 * through it).
 */
export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/health',
    {
      // §13: the response is defined by schema. The compiled serializer
      // emits exactly `{"status":"ok"}` and structurally drops any other
      // key (`additionalProperties: false` in the schema) — the
      // done-condition enforced at serialization, not by handler discipline.
      schema: { response: { 200: HealthResponseSchema } },
      // §13/§15.1 (task 152, D-121): the auth-mode guard's public opt-out
      // — the one §13 endpoint that answers unauthenticated in every
      // auth mode and every proxy/password state.
      config: PUBLIC_AUTH_ROUTE_CONFIG,
    },
    async () => {
      // §15.5's `Cache-Control: no-store` for API responses is the
      // construction's root-scope rule since task 158 (D-127) — the
      // route-scoped header this handler carried between tasks 147 and
      // 158 is gone, generalized.
      return HEALTH_RESPONSE;
    },
  );
};
