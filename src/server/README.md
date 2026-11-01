# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §5.6, §13, §15): the process entry
point `main.ts` — runtime gate (Node.js ≥ 22.13.0 by numeric prefix, so a
nightly of a supported line runs while anything below the line refuses;
non-root; task 129, decision D-098), signal wiring, exit codes — and the
lifecycle skeleton `app.ts` (task 060), where components
start in registration order and stop in reverse, realizing the §5.6 shutdown
sequence by construction. `single-instance.ts` (task 074) guards each data
directory with an atomically published lockfile: a second process on the same
data directory refuses to start with an actionable error, a lock left by a
crashed holder (dead pid) is broken automatically, and the lock is released
last, on stop (decision D-017). `shutdown.ts` (task 075) coordinates graceful
shutdown: the polling service registers in-flight operations in a shared
`createInFlightTracker` counter, and the `graceful-drain` component waits for
them — bounded at 10 s by spec §5.6 — when the application stops. The HTTP
listener keeps its own §5.6 bound instead (decision D-109): it stops before
the drain in the documented registration order
(`[lock, storage, graceful-drain, polling, http]`), and `fastify.close()`
already serializes the in-flight-request wait — so `http.ts` races the close
against the same ten-second bound and forces completion
(`closeAllConnections`) when it expires. Registered between storage and the
schedulers, reverse-order teardown yields exactly the §5.6 sequence: stop
scheduling, bounded wait for in-flight work, close storage/checkpoint WAL,
release the lock. Its `onEvent` stream is the seam for the structured logger
(task 072); its timeout clock is injectable for deterministic tests
(decision D-020). `http.ts` (task 146) is the Fastify construction: the §3
plugin set construction owns (`@fastify/static` with the §14.1 SPA fallback,
`@fastify/cookie`; `@fastify/helmet`/`@fastify/rate-limit` stay with their
configuring tasks 158/156 — D-109), the §15.5 body limit and
connection/request timeouts, §16's level-gated request logging through the
redacting logger's Pino instance, and the `/api` route seam; the same
factory wraps it as the `http-listener` lifecycle component the application
shell starts and stops, and tests drive through `fastify.inject` without
sockets. The routes live in `src/server/api/` (147–163): `index.ts` is the
registered `/api` scope every Stage-12 endpoint joins. Later: the HTTP API
routes (147–163) and security middleware (149–152, 156–158). It is the only
layer allowed to wire concrete provider adapters into the registry. `providers.ts` (task 133) is that privilege's first
exercise: `createInitialAccountProvider()` constructs the v1.0 adapter with
production defaults for `init`'s initial-account connection test (spec §5.3
step 6) — the factory constructs and never registers, so the future
bootstrap composition that fills the `ProviderRegistry` is unchanged by it
(decision D-102).

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.
