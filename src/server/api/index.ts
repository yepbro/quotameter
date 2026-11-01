/**
 * HTTP API route registration seam (task 146, spec §13).
 *
 * The construction in `src/server/http.ts` registers this plugin under the
 * `/api` prefix — the single scope where Stage 12 wires routes into the
 * server. Task 147 adds the public health response, task 148 the shared
 * error envelope, tasks 149–152 the request-security checks, and tasks
 * 159–162 the API endpoints; each registers inside this scope, so the
 * server construction itself never changes shape again.
 */

import type { FastifyPluginAsync } from 'fastify';

/**
 * The `/api` route scope. Deliberately empty at the construction stage:
 * registering it now pins the seam — requests under `/api` resolve inside
 * this scope and reach the shared 404 shape, never the static-file fallback
 * — while every endpoint lands with its own task.
 */
export const apiRoutes: FastifyPluginAsync = async () => {
  // Route handlers land here starting with task 147 (`GET /api/health`).
};
