/**
 * HTTP API route registration seam (task 146, spec §13).
 *
 * The construction in `src/server/http.ts` registers this plugin under the
 * `/api` prefix — the single scope where Stage 12 wires routes into the
 * server. Task 147 adds the public health response (`./health`), task 148
 * the shared error envelope, tasks 149–152 the request-security checks,
 * tasks 153–155 the auth/session endpoints, and tasks 159–162 the remaining
 * API endpoints; each registers inside this scope, so the
 * server construction itself never changes shape again.
 */

import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health';

/**
 * The `/api` route scope. Each endpoint plugin registers here in its own
 * task, so requests under `/api` resolve inside this scope and reach the
 * shared 404 shape, never the static-file fallback.
 */
export const apiRoutes: FastifyPluginAsync = async (fastify) => {
  // Task 147: the public health response (§13) — the one endpoint that
  // stays unauthenticated in every auth mode (§15.1).
  await fastify.register(healthRoutes);
};
