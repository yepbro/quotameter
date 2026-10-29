# `src/server/` — composition root and HTTP API

The application assembly point (spec §3, §13, §15): the entry point and
lifecycle hooks (task 060), Fastify construction and plugins (146), the HTTP
API routes (147–163), static UI serving, and security middleware. It is the
only layer allowed to wire concrete provider adapters into the registry.

**Rule:** as the composition root it may import every layer except
`src/cli/`. Route handlers validate input through `src/schemas/api/` and
delegate to services; they never touch providers or SQL directly.
