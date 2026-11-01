/**
 * Fastify server construction (task 146, spec §3, §13, §15.5, §16; decision
 * D-109).
 *
 * The server shell: one factory builds the Fastify instance with everything
 * §13/§15.5 prescribe at construction time — the §3 plugin set that
 * construction owns, the 64 KiB request-body limit, the connection/request
 * timeouts, static file serving with the SPA fallback, and the `/api` route
 * seam (`./api`) — and a second factory wraps it as a `LifecycleComponent`
 * the application shell (task 060) can start and stop. The remaining
 * routes (153+) and request-security layers (150–152, 156, 158) are later
 * Stage-12 tasks; task 149's Origin/Fetch-Metadata guard registers inside
 * the `/api` scope itself (`./api`), so nothing in this module implements
 * an endpoint or a security check. The §13 error envelope
 * (task 148, D-113) is the one error surface: the root-scope
 * `apiErrorHandler` from `./api/error` behind every thrown error, and the
 * not-found handler resolving 404s onto the same envelope.
 *
 * Split of §3's plugin list (decision D-109): `@fastify/static` and
 * `@fastify/cookie` are construction — serving the built UI and parsing
 * cookies have no configuration of their own. `@fastify/helmet` and
 * `@fastify/rate-limit` are declared dependencies but are registered by
 * their owning tasks (158: security headers/CSP; 156: login rate limiting),
 * because their §15.5/§15.2 behavior IS that task's deliverable —
 * registering them with defaults here would pre-empt it.
 *
 * Timeouts (§15.5): three explicit bounds. `connectionTimeout` is the
 * socket-inactivity bound (Fastify applies it through `server.setTimeout`,
 * observable as `server.timeout` — it is NOT dead, and it destroys sockets
 * with no onTimeout hook registered, so it must comfortably exceed the
 * longest legitimate silent handler: a §7.2 provider exchange of the 15 s
 * deadline times retries and backoff stays far below five minutes);
 * `requestTimeout` bounds receiving an entire request — headers and body —
 * and is the slow-client bound; `keepAliveTimeout` bounds an idle
 * keep-alive socket (fires before the inactivity bound on idle
 * connections). `forceCloseConnections: 'idle'` keeps `close()` from
 * hanging on idle keep-alive sockets during shutdown.
 *
 * §5.6's bounded in-flight-request wait (decision D-109): the component
 * stops last-but-first in the documented registration order
 * (`[lock, storage, graceful-drain, polling, http]`), before the shared
 * drain of `shutdown.ts` could observe it — and `fastify.close()` already
 * serializes the in-flight-request wait itself. The component therefore
 * owns the §5.6 bound directly: it races the close against ten seconds and
 * forces completion (`closeAllConnections`) when the bound expires, while
 * the shared tracker remains the polling side's mechanism. A close failure
 * reaches `stop()` only through an `onClose` hook that calls its
 * `done(err)` callback — a hook that throws synchronously escapes as an
 * unhandled process error and the close never settles (verified).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { LifecycleComponent } from './app';
import {
  API_MAX_PARAM_LENGTH,
  apiErrorHandler,
  notFoundClassification,
  sendApiError,
  staticServingErrorHandler,
} from './api/error';
import { apiRoutes } from './api';
import { MAX_DRAIN_TIMEOUT_MS } from './shutdown';
import type { Logger } from '../util/logger';

/** Spec §15.5: request bodies are limited to 64 KiB. */
export const HTTP_BODY_LIMIT_BYTES = 65_536;

/**
 * Spec §15.5: the socket-inactivity bound (`connectionTimeout`, applied by
 * Fastify as `server.setTimeout`, observable as `server.timeout`). Five
 * minutes generously exceeds the longest legitimate silent handler — a
 * §7.2 provider exchange (15 s deadline × retries + backoff) — while a
 * socket that goes quiet is never kept alive indefinitely.
 */
export const HTTP_CONNECTION_TIMEOUT_MS = 300_000;

/**
 * Spec §15.5: the bound for receiving an entire request. Generous for a
 * ≤64 KiB body from a local client, and far below Node's 5-minute default,
 * so a stalled client cannot hold a connection indefinitely.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;

/** Spec §15.5: an idle keep-alive socket is closed after this long. */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 72_000;

/**
 * The served frontend output (spec §14.1, §3): `ui/dist` under the package
 * root — the directory `ui/vite.config.ts` builds into and the layout the
 * packaging tasks (184–186) ship. Resolved the same way
 * `bin/quotameter.mjs` locates the manifest: from the module's own URL,
 * which holds in the repository (jiti) and in the published package alike.
 */
export function resolveUiDistDir(): string {
  return fileURLToPath(new URL('../../ui/dist', import.meta.url));
}

/** What `buildHttpServer` and `createHttpServerComponent` accept. */
export interface HttpServerOptions {
  /** Bind address; §15.1's loopback default is the config layer's call. */
  readonly host: string;
  /** TCP port; `0` binds an ephemeral port (tests). */
  readonly port: number;
  /**
   * The redacting logger whose Pino instance Fastify logs through (spec §3,
   * §16) — the Layer-A-protected `Logger.pino` of D-025, so Fastify's
   * records flow through the same redaction as every other log line.
   */
  readonly logger: Logger;
  /**
   * Directory of the built UI served as static files. Defaults to
   * {@link resolveUiDistDir}; absent directories degrade to an API-only
   * server with a warning (the frontend build is task 165's deliverable).
   */
  readonly staticRoot?: string;
  /**
   * Bound of the graceful in-flight-request wait on stop (spec §5.6).
   * Defaults to the ten-second §5.6 bound single-sited in `./shutdown`;
   * values above it are refused — a longer wait would weaken the contract —
   * while shorter values only tighten it (and keep the forced-close path
   * deterministically testable).
   */
  readonly stopTimeoutMs?: number;
}

/**
 * The HTTP listener as a lifecycle component (task 060's seam): `start`
 * listens, `stop` closes gracefully within the §5.6 bound.
 */
export interface HttpServerComponent extends LifecycleComponent {
  /**
   * The constructed Fastify instance — the injection surface for tests
   * (`fastify.inject`, no sockets) and for the composition root.
   */
  readonly server: FastifyInstance;
}

/**
 * §16's request-logging gate ("HTTP request logging is disabled except at
 * `debug`") over Fastify's `LogController` — including the one line the
 * stock controller always emits: the closing-server 503 record, which is
 * per-request traffic, not a lifecycle event, and therefore gated here
 * like every other request line.
 */
export class RequestLoggingGate extends LogController {
  private readonly requestLoggingDisabled: boolean;

  constructor(disableRequestLogging: boolean) {
    super({ disableRequestLogging });
    this.requestLoggingDisabled = disableRequestLogging;
  }

  override serviceUnavailable(logger: FastifyBaseLogger, server: FastifyInstance): void {
    if (this.requestLoggingDisabled) return;
    super.serviceUnavailable(logger, server);
  }
}

/**
 * Builds the Fastify instance: plugins, limits, timeouts, static serving,
 * and the route seam (spec §3, §13, §15.5, §16; decision D-109).
 *
 * Pure construction — no socket. Tests inject against the returned instance
 * directly; production listens through `createHttpServerComponent`.
 */
export function buildHttpServer(options: HttpServerOptions): FastifyInstance {
  const server = Fastify({
    // The cast is typing-only: pino's Logger satisfies FastifyBaseLogger
    // structurally, but letting it flow into the factory's generic would
    // narrow the instance's public type below the default `FastifyInstance`
    // alias (pino's extra members break method variance).
    loggerInstance: options.logger.pino as FastifyBaseLogger,
    logController: new RequestLoggingGate(options.logger.level !== 'debug'),
    bodyLimit: HTTP_BODY_LIMIT_BYTES,
    connectionTimeout: HTTP_CONNECTION_TIMEOUT_MS,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
    forceCloseConnections: 'idle',
    // The router's parameter bound (task 148, D-113): single-sited with
    // the `/api` scope's catch-all classification (`unmatchedApiClassification`
    // measures segments against this value), so the bound the router
    // enforces and the bound the envelope re-derives cannot drift.
    maxParamLength: API_MAX_PARAM_LENGTH,
    // The §13 envelope behind fastify's router-level failures too (task
    // 148, D-113 review fix): without this callback, a malformed
    // percent-escape path (`/api/%zz`) bypasses `setErrorHandler` entirely
    // and gets a hardcoded framework body with the unstable native code on
    // the wire. Routed through the same handler, the codes classify onto
    // the registry (`FST_ERR_BAD_URL` → VALIDATION,
    // `FST_ERR_MAX_PARAM_LENGTH` → URI_TOO_LONG — the latter only at a
    // routing dead end; the `/api` scope's catch-all route answers the
    // rescued ones, mode-independently, per D-113's post-verification fix).
    frameworkErrors: apiErrorHandler,
  });

  // Spec §3's enabling plugin for the §13 auth endpoints: cookie parsing
  // only — session cookie flags are per-response behavior (task 157).
  server.register(cookie);

  const staticRoot = options.staticRoot ?? resolveUiDistDir();
  const staticAvailable = existsSync(staticRoot);
  // The SPA fallback serves `index.html`; a static root without it (a
  // partial build, a pre-created volume) must not fall into `sendFile`'s
  // ENOENT inside the 404 handler — fastify answers that with a plain-text
  // basic 404 plus a warn line. The fallback branch below requires the
  // file itself (D-113 review fix); assets keep serving either way.
  const spaIndexAvailable = staticAvailable && existsSync(join(staticRoot, 'index.html'));
  // The static plugin rides in its own scope with a containment error
  // handler (D-113 review fix): `send`'s client rejections carry only a
  // foreign 403/404 and would otherwise resolve to INTERNAL — a client
  // typo answered as a server fault plus one error-level log record per
  // request. A named function expression (not an inline arrow) keeps the
  // scope identifiable in `printPlugins()` output — the root-observable
  // pin of this registration (`hasPlugin` cannot see encapsulated
  // plugins, only the booted tree shows them).
  const staticServingScope: FastifyPluginAsync = async function staticServingScope(scope) {
    scope.setErrorHandler(staticServingErrorHandler);
    await scope.register(fastifyStatic, { root: staticRoot });
  };
  if (staticAvailable) {
    server.register(staticServingScope);
  } else {
    options.logger.warn(
      `no built UI at ${staticRoot}: serving the API only ` +
        '(build the frontend to serve the web interface)',
    );
  }

  // Static serving with SPA fallback (spec §14.1): deep links serve the app
  // shell. This handler answers what the route table cannot match at all —
  // the bare `/api` (the api scope's catch-all needs a trailing segment),
  // non-API misses in API-only mode, and the partial-build degradation —
  // while the `/api/…` unmatched arm lives in the api scope's own catch-all
  // route (`./api`, D-113 post-verification fix), which outranks both this
  // handler and the static wildcard. `/apiary` stays a UI deep link, never
  // a string prefix. Every arm resolves to the §13 error envelope; an
  // unmatched route is not an error in fastify, so the 404 class lives in
  // route/not-found handlers, not in the error handler.
  server.setNotFoundHandler((request, reply) => {
    // `split` never returns an empty array — the first element always exists.
    const path = request.url.split('?')[0]!;
    const isApiPath = path === '/api' || path.startsWith('/api/');
    if (spaIndexAvailable && request.method === 'GET' && !isApiPath) {
      reply.sendFile('index.html');
      return;
    }
    sendApiError(reply, notFoundClassification(request.method, path));
  });

  // The §13 error envelope behind every thrown error (task 148, D-113):
  // registered at root scope so API and non-API failures alike answer the
  // one common shape — a second, framework-default error body for non-API
  // paths would split the contract the UI client (169) builds against.
  // Errors from encapsulated scopes (the static scope above, the `/api`
  // route scope below) bubble to it unless the scope contains them first.
  server.setErrorHandler(apiErrorHandler);

  // The §13 route scope (task 147 landed the health route; 148+ join here).
  server.register(apiRoutes, { prefix: '/api' });

  return server;
}

/**
 * Validates the §5.6 stop bound — the same contract `createGracefulDrain`
 * enforces, kept identical so one rule governs both in-flight waits.
 */
function requireStopTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_DRAIN_TIMEOUT_MS) {
    throw new Error(
      `http-listener stopTimeoutMs must be a finite number greater than 0 and at most ` +
        `${MAX_DRAIN_TIMEOUT_MS} (spec §5.6 bounds the in-flight wait at 10 seconds); ` +
        `got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Graceful close within the §5.6 bound (decision D-109): stop accepting
 * connections, let in-flight requests settle, and once the bound expires
 * destroy the remaining connections so the close completes.
 */
async function closeBounded(server: FastifyInstance, timeoutMs: number): Promise<void> {
  const closing = server.close();
  // Assigned synchronously by the executor below; the definite-assignment
  // assertion avoids a never-executed placeholder closure.
  let cancelBound!: () => void;
  const boundExpired = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), timeoutMs);
    cancelBound = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  try {
    if (await Promise.race([closing.then(() => false), boundExpired])) {
      server.server.closeAllConnections();
    }
    await closing;
  } finally {
    // An unexpired timer must not outlive the settled close.
    cancelBound();
  }
}

/**
 * Wraps a constructed Fastify instance as the `http-listener` lifecycle
 * component (task 060's seam, spec §5.6).
 *
 * `stop` is idempotent while it succeeds (later calls share the settled
 * result) and stays retryable after it rejects — the component contract of
 * U-018: a failed release must remain addressable for the shell's retry.
 */
export function createHttpServerComponent(options: HttpServerOptions): HttpServerComponent {
  const stopTimeoutMs = requireStopTimeoutMs(options.stopTimeoutMs ?? MAX_DRAIN_TIMEOUT_MS);
  const server = buildHttpServer(options);
  let stopping: Promise<void> | undefined;

  return {
    name: 'http-listener',
    server,
    async start() {
      await server.listen({ host: options.host, port: options.port });
    },
    async stop() {
      if (stopping) return stopping;
      stopping = closeBounded(server, stopTimeoutMs);
      try {
        await stopping;
      } catch (error) {
        // A rejected close stays retryable (U-018): clear the memo so the
        // next `stop()` attempts the release again.
        stopping = undefined;
        throw error;
      }
    },
  };
}
