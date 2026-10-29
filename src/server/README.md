# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §5.6, §13, §15): the process entry
point `main.ts` — runtime gate (Node.js ≥ 22.13.0, non-root), signal wiring,
exit codes — and the lifecycle skeleton `app.ts` (task 060), where components
start in registration order and stop in reverse, realizing the §5.6 shutdown
sequence by construction. `single-instance.ts` (task 074) guards each data
directory with an atomically published lockfile: a second process on the same
data directory refuses to start with an actionable error, a lock left by a
crashed holder (dead pid) is broken automatically, and the lock is released
last, on stop (decision D-017). `shutdown.ts` (task 075) coordinates graceful
shutdown: the future polling service and HTTP listener register in-flight
operations in a shared `createInFlightTracker` counter, and the
`graceful-drain` component waits for them — bounded at 10 s by spec §5.6 —
when the application stops. Registered between storage and the schedulers
(`[lock, storage, graceful-drain, polling, http]`), reverse-order teardown
yields exactly the §5.6 sequence: stop scheduling, bounded wait for in-flight
work, close storage/checkpoint WAL, release the lock. Its `onEvent` stream is
the seam for the structured logger (task 072); its timeout clock is injectable
for deterministic tests (decision D-020). Later: Fastify construction and
plugins (146), the HTTP API routes (147–163), static UI serving, and security
middleware. It is the only layer allowed to wire concrete provider adapters
into the registry.

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.
