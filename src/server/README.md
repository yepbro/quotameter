# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §5.6, §13, §15): the process entry
point `main.ts` — runtime gate (Node.js ≥ 22.13.0, non-root), signal wiring,
exit codes — and the lifecycle skeleton `app.ts` (task 060), where components
start in registration order and stop in reverse, realizing the §5.6 shutdown
sequence by construction. Later: Fastify construction and plugins (146), the
HTTP API routes (147–163), static UI serving, and security middleware. It is
the only layer allowed to wire concrete provider adapters into the registry.

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.
