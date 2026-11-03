/**
 * Fastify server construction (tasks 146/158, spec §3, §13, §15.5, §16;
 * decisions D-109, D-127).
 *
 * The server shell: one factory builds the Fastify instance with everything
 * §13/§15.5 prescribe at construction time — the §3 plugin set that
 * construction owns, the 64 KiB request-body limit, the connection/request
 * timeouts, static file serving with the SPA fallback, and the `/api` route
 * seam (`./api`) — and a second factory wraps it as a `LifecycleComponent`
 * the application shell (task 060) can start and stop. The remaining
 * routes (159+) are later Stage-12 tasks; tasks 149/150's guards and
 * task 152's §15.1 auth-mode selection register inside the `/api` scope
 * itself (`./api`), while task 151's Host allowlist — the one
 * §15.3 check that must bind frontend routes too — and task 158's
 * §15.5 security-header layer (D-127: helmet plus the API `no-store`
 * hook — response-shaping, it rejects nothing) register here at root
 * scope (D-120); apart from those hooks nothing in this module
 * implements an endpoint or a security check. The §13 error envelope
 * (task 148, D-113) is the one error surface: the root-scope
 * `apiErrorHandler` from `./api/error` behind every thrown error, and the
 * not-found handler resolving 404s onto the same envelope.
 *
 * Split of §3's plugin list (decision D-109): `@fastify/static` and
 * `@fastify/cookie` are construction — serving the built UI and parsing
 * cookies have no configuration of their own. `@fastify/helmet` is
 * configuration-owning: task 158 (§15.5, D-127) registers it here with
 * exactly the security-header list the spec prescribes.
 * `@fastify/rate-limit` stays declared but unregistered
 * with no owning task left: §15.2's budget counts *failed* attempts
 * and answers with increasing delays — landed as the services-layer
 * primitive `src/services/login-rate-limit.ts` (156, D-125), which the
 * generic per-request 429 limiter cannot express.
 *
 * Security headers (§15.5, task 158, decision D-127): helmet answers the
 * spec's exact list — the strict CSP, nosniff, no-referrer — on every
 * route, and every helmet default the spec does not list is disabled
 * (HSTS is the §15.6 reverse proxy's layer, framing policy lives once
 * inside the spec'd CSP as `frame-ancestors 'none'`, and the cross-origin
 * isolation / agent-cluster / prefetch / legacy-IE headers are unlisted).
 * `Cache-Control: no-store` is §15.5's API-only rule and rides its own
 * root-scope hook ahead of the Host guard: helmet has no such option,
 * and the §13 `/api` path boundary (percent-decoded — the router matches
 * the decoded path, not `request.url`'s raw wire form) must not touch
 * static responses
 * (those keep @fastify/static's own `public, max-age=0` — revalidate
 * always, with send's ETags — which §15.5's wording permits and which
 * cannot serve a stale app shell after an upgrade).
 * Layering (verified on the pinned runtime): helmet's onRequest hooks
 * are added by a plugin registered AHEAD of the construction's addHook
 * calls, so they run FIRST in the root chain — every response carries
 * the helmet set, the Host guard's thrown 403s included, except the one
 * rejection class that never reaches any hook (the router-level
 * `frameworkErrors`, rejected during routing itself), which still
 * answers the §13 envelope whose `sendApiError` keeps error responses
 * uncacheable wherever they appear (the error-path `no-store`
 * guarantee; the route-scoped health header the D-111 pass carried is
 * gone, generalized by this hook).
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
import helmet from '@fastify/helmet';
import type { FastifyHelmetOptions } from '@fastify/helmet';
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
import type { ApiRoutesOptions } from './api';
import type { RequestAuthenticator } from './api/auth';
import { createHostAllowlist, createHostGuard } from './api/security';
import { CONFIG_DEFAULTS, type AuthMode } from '../schemas/config';
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
 * Spec §15.5 (task 158, decision D-127): the security-header configuration
 * — exactly the headers the spec lists, nothing more.
 *
 * **The CSP** is the strict reading of "a strict Content Security Policy
 * without inline scripts or external sources": `default-src 'none'` fails
 * closed (every fetch type without an explicit allowance is blocked), and
 * the allowances are exactly the §14.1 reality of the built UI — a
 * hashed-asset bundle from the same origin. Same-origin module scripts and
 * hashed styles (`script-src`/`style-src 'self'` — no `'unsafe-inline'`,
 * no `'unsafe-eval'`: Vite emits referenced files, never inline code, and
 * the runtime-only Vue build needs no `eval`), same-origin images and
 * bundled fonts (§14.1 "bundle fonts and assets locally"), and the
 * same-origin API (`connect-src 'self'`). No nonce machinery: §15.5
 * demands no inline scripts at all, so there is nothing for a nonce to
 * whitelist. The directives §15.5's "strict" implies beside them:
 * navigation/embedding types CSP does not fold into `default-src` are
 * pinned `'none'` (`base-uri`, `form-action`, `frame-ancestors`), and
 * `object-src 'none'` is explicit though `default-src` already covers it
 * — plugins are the classic fallback mistake. Insertion order is wire
 * order (helmet serializes the object deterministically); the integration
 * suite pins the exact byte string.
 *
 * **Beyond the CSP** the spec lists two more headers; every other helmet
 * default is disabled — §15.5's list is exhaustive, and the unlisted
 * defaults each have a reason not to reach the wire: HSTS belongs to the
 * §15.6 reverse proxy (the service never speaks TLS itself; an app-set
 * `max-age`/`includeSubDomains` would reach through a passing proxy into
 * subdomains the operator never delegated to this app), framing policy
 * lives once, inside the spec'd CSP (`frame-ancestors 'none'`), not again
 * in the legacy `X-Frame-Options`, and the cross-origin isolation,
 * agent-cluster, DNS-prefetch, Adobe-cross-domain, and IE-era headers
 * (download-options, the XSS auditor's disabling `0`) are unlisted and
 * unneeded by a same-origin SPA.
 */
const SECURITY_HEADERS_CONFIGURATION: FastifyHelmetOptions = {
  contentSecurityPolicy: {
    // `useDefaults: false` — the emitted policy is exactly the directive
    // set below, not helmet's default policy merged over it.
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
    },
  },
  // §15.5's literal value, stated here so it is single-sited in this
  // module rather than inherited from helmet's default.
  referrerPolicy: { policy: ['no-referrer'] },
  // `xContentTypeOptions` stays at helmet's `nosniff` default (helmet
  // rejects the boolean `true` as an option value) — pinned by the
  // integration suite like the CSP string.
  strictTransportSecurity: false,
  xFrameOptions: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
  xDnsPrefetchControl: false,
  xPermittedCrossDomainPolicies: false,
  xDownloadOptions: false,
  xXssProtection: false,
};

/**
 * Whether a request URL addresses the API: the §13 `/api` prefix boundary —
 * the bare `/api` and every `/api/…` path, query stripped and
 * percent-decoded. The single site of that boundary, shared by the §15.5
 * no-store hook (task 158) and the not-found handler's SPA-vs-envelope
 * split (a lookalike like `/apiary` is a UI deep link, never an API path).
 * Decoding is required because fastify's `request.url` is the RAW wire path
 * while the router matches the decoded one (review round P2-1, reproduced:
 * `/%61pi/health` reaches the real `/api/health` handler) — a malformed
 * escape keeps the raw path, and those requests the router itself rejects
 * through `frameworkErrors` before any hook or handler runs.
 */
function isApiRequestPath(url: string): boolean {
  // `split` never returns an empty array — the first element always exists.
  const rawPath = url.split('?')[0]!;
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent-escape: fall through with the raw path — the
    // router-level frameworkErrors arm owns the rejection.
  }
  return path === '/api' || path.startsWith('/api/');
}

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

/**
 * The §15.1 authentication inputs `HttpServerOptions.auth` accepts (task
 * 152, decision D-121) — deliberately a projection of the config, not
 * the config itself: the listener takes exactly the facts the auth-mode
 * guard decides over, so the future composition root (which reads
 * `auth.mode` and `auth.passwordHash` from validated configuration)
 * maps them 1:1.
 */
export interface HttpAuthOptions {
  /**
   * The `auth.mode` of §15.1; §6.4 pins it restart-requiring, so
   * construction-time capture is the value's own lifecycle. Defaults to
   * the config layer's own default (`auto`, single-sited in
   * `CONFIG_DEFAULTS`).
   */
  readonly mode?: AuthMode;
  /**
   * Whether `auth.passwordHash` is present, read per request — §6.4/D-026
   * classify the hash live (a password set by `quotameter passwd` while
   * the server runs takes effect on the next request, no restart).
   * Defaults to "not configured".
   */
  readonly passwordConfigured?: () => boolean;
  /**
   * The credential seam tasks 153–155 implement (scrypt verification,
   * session lookup); defaults to fail-closed "no request is
   * authenticated" until they land.
   */
  readonly isAuthenticated?: RequestAuthenticator;
}

/** HTTP listener settings (spec §5.3, §15.1). */
export interface HttpServerOptions {
  /**
   * Bind address; §15.1's loopback default is the config layer's call.
   * Doubles as §15.3's "configured host" in the root-scope Host-allowlist
   * guard (task 151, D-120): `server.host` is restart-requiring (§6.4),
   * so capturing it here at construction time is the value's own
   * lifecycle — a reload cannot change it under the running listener.
   */
  readonly host: string;
  /** TCP port; `0` binds an ephemeral port (tests). */
  readonly port: number;
  /**
   * The §15.1 authentication inputs the `/api` scope's auth-mode guard
   * needs (task 152, D-121): the mode (restart-requiring per §6.4,
   * captured here at construction — the D-120 precedent) beside the
   * per-request facts. The bind half of §15.1's address fact is
   * {@link HttpServerOptions.host} itself; defaults are the config
   * layer's own (`auto`, no password).
   */
  readonly auth?: HttpAuthOptions;
  /**
   * The redacting logger whose Pino instance Fastify logs through (spec §3,
   * §16) — the Layer-A-protected `Logger.pino` of D-025, so Fastify's
   * records flow through the same redaction as every other log line.
   */
  readonly logger: Logger;
  /**
   * The route-family dependencies the composition root supplies (tasks
   * 159–161, decisions D-128/D-130/D-139): the five optional
   * `ApiRoutesOptions` members beside `auth`, which the construction
   * derives above. Absent — the bare task-146 construction — the families
   * stay unregistered and their paths answer the scope catch-all's 404 (the
   * no-half-wired rule); passing a member wires exactly that family to the
   * stores the composition owns. The composition root
   * (`./composition.ts`, task U-040) is the production caller.
   */
  readonly routes?: Omit<ApiRoutesOptions, 'auth'>;
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

  // Task 158 (spec §15.5, decision D-127): the security-header layer —
  // the strict CSP, nosniff, and no-referrer of the spec's list, applied
  // to every route the server answers. The plugin is fp-wrapped (root
  // scope, no encapsulation), so the static scope's assets, the SPA
  // fallback, the `/api` routes, and the not-found arm all pass through
  // its hooks. Registered AHEAD of the addHook calls below, its hooks run
  // first in the root chain (verified on the pinned runtime) — even the
  // Host guard's thrown 403s carry the set. The only responses without it
  // are the router-level `frameworkErrors`, rejected during routing
  // before any hook runs; those still answer the §13 envelope with its
  // own no-store.
  server.register(helmet, SECURITY_HEADERS_CONFIGURATION);

  // Task 158 (spec §15.5, decision D-127): `Cache-Control: no-store` for
  // API responses — §15.5's one cache rule, and deliberately NOT part of
  // the helmet configuration: helmet has no such option, and the rule is
  // the §13 path boundary above, so static responses keep @fastify/static's
  // own caching default (`public, max-age=0` — the spec fixes no static
  // caching directive). The hook sits ahead of the Host guard so a
  // gate-rejected `/api` request carries no-store even without the
  // envelope — which sets it anyway; the two sites cannot disagree, they
  // share the one literal.
  server.addHook('onRequest', function apiCacheControlHook(request, reply, done) {
    if (isApiRequestPath(request.url)) {
      reply.header('cache-control', 'no-store');
    }
    done();
  });

  // Task 151 (spec §15.3, decision D-120): the Host-allowlist guard, the
  // one §15.3 layer registered here at ROOT scope instead of inside the
  // `/api` scope — validating `Host` against `localhost`, `127.0.0.1`,
  // `[::1]`, and the configured host must bind every route (API routes,
  // static assets, the SPA fallback), because the DNS-rebinding request
  // it exists to stop arrives at the frontend paths as surely as at the
  // API. Root registration also makes it the outermost §15.3 layer by
  // fastify's own hook chain (root hooks run ahead of scoped ones —
  // verified on the pinned runtime): a hostile-Host request never reaches
  // the Origin/custom-header guards or any handler, in every auth mode
  // and both static-serving states. The allowlist takes `options.host` —
  // the validated `server.host`, restart-requiring per §6.4, so
  // construction-time capture is the value's own lifecycle (D-120).
  const configuredHostName = options.host.trim().toLowerCase();
  if (
    configuredHostName === '0.0.0.0' ||
    configuredHostName === '::' ||
    configuredHostName === '[::]'
  ) {
    // The wildcard bind admits only its literal name in the allowlist
    // (the spec-literal fail-closed reading, D-120) — every concrete
    // interface address a client would name is "any other host", so the
    // operator hears it once, at construction, with the reachable
    // shapes named (the review round's ask: a silent 403 wall is not a
    // deployment recipe).
    options.logger.warn(
      `host allowlist: the wildcard bind ${configuredHostName} admits only its literal name in the Host check (spec §15.3) — ` +
        'bind the concrete address clients use, or reach the service through an SSH tunnel (localhost) or a proxy hop under an allowlisted Host',
    );
  }
  server.addHook('onRequest', createHostGuard(createHostAllowlist(options.host)));

  // Spec §3's enabling plugin for the §13 auth endpoints: cookie parsing
  // here, cookie *writing* through the services-layer attribute primitive
  // `src/services/session-cookie.ts` (task 157, D-126) — the flags are
  // per-response behavior, computed by the login/logout endpoint from the
  // request's transport facts and spread into `reply.setCookie`.
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
    if (spaIndexAvailable && request.method === 'GET' && !isApiRequestPath(request.url)) {
      reply.sendFile('index.html');
      return;
    }
    sendApiError(reply, notFoundClassification(request.method, request.url.split('?')[0]!));
  });

  // The §13 error envelope behind every thrown error (task 148, D-113):
  // registered at root scope so API and non-API failures alike answer the
  // one common shape — a second, framework-default error body for non-API
  // paths would split the contract the UI client (169) builds against.
  // Errors from encapsulated scopes (the static scope above, the `/api`
  // route scope below) bubble to it unless the scope contains them first.
  server.setErrorHandler(apiErrorHandler);

  // The §13 route scope (task 147 landed the health route; 148+ join here).
  // The auth inputs of the scope's third hook (task 152, D-121) are
  // derived here — the only place that holds both §15.1 address facts:
  // the bind host above and the mode/password projection of
  // `options.auth` (defaults: the config layer's own `auto` and "no
  // password"), with the bind's loopback-ness decided inside the guard
  // through `isLoopbackHost` (the single owner of that semantics). The
  // route-family dependencies (task U-040, D-140) ride beside them: absent
  // members stay unregistered, so the construction's default surface is
  // exactly what it was before the composition existed.
  server.register(apiRoutes, {
    prefix: '/api',
    auth: {
      mode: options.auth?.mode ?? CONFIG_DEFAULTS.auth.mode,
      bindHost: options.host,
      passwordConfigured: options.auth?.passwordConfigured,
      isAuthenticated: options.auth?.isAuthenticated,
    },
    ...(options.routes ?? {}),
  });

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
