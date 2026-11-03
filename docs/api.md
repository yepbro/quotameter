# HTTP API reference (OpenAPI)

Quotameter's HTTP API is described by a published OpenAPI document (spec §13,
§18): [`docs/openapi.json`](openapi.json) in the repository — OpenAPI 3.1.0,
with every request and response schema embedded as the JSON Schema (draft
2020-12) projection of the TypeBox contracts the server validates and
serializes through. Point any OpenAPI 3.1 tooling (Swagger UI, Redoc,
Insomnia, Postman, editor plugins) at the file.

## The document is generated, not hand-written

The artifact is produced by `scripts/generate-openapi.mjs` from
`scripts/openapi-document.mjs`, which composes:

- **the wire contracts** — the exported TypeBox schemas from
  [`src/schemas/api/`](../src/schemas/api/) (accounts, status — which owns the
  quota contracts —, providers, settings, history — which owns the events
  contracts —, peak-hours, health, error), projected verbatim: what the
  document shows is what the routes validate through (spec §13: "Define every
  request and response through TypeBox/JSON Schema. Generate and publish
  OpenAPI");
- **the error registry** — every documented error response is derived from
  the frozen code table in `src/schemas/api/error.ts` (decision D-113): the
  HTTP status is the registry's own mapping and the body is the closed
  `{ "error": { "code", "message", "details" } }` envelope;
- **a literal route inventory** — method, path, operation metadata, and
  per-route error codes: the facts fastify route options do not carry.

## Regenerating

After changing `src/schemas/api/*` or the route surface:

```console
$ make openapi
```

`make openapi` regenerates the file inside the development container and
writes `docs/openapi.json` back to the repository from the host side — the
same uid-safety pattern as `make schema` (the container runs as uid 1000 and
must not write into the bind-mounted source tree; the generator's output
directory is env-configured through `OPENAPI_DIR`, see
[docs/agents/environment.md](agents/environment.md)). Without `make`, run
`npm run openapi:generate` and copy the file from `$OPENAPI_DIR` if you set
it.

## The drift guard

A unit test, `test/unit/openapi-published.spec.ts`, fails `make check` when
the published document and the real server drift apart — in either
direction:

- a route registered by the `/api` scope but absent from the document (a new
  endpoint must ship its documentation in the same commit);
- a documented operation with no matching route (a removed or renamed
  endpoint must take its documentation along);
- a schema mismatch: the document's path/query parameters, request bodies,
  and success responses must equal the projections of the schemas the routes
  actually declare — a route re-wired to a different contract fails even
  when its method and path still match;
- a security-model mismatch: the public set (`GET /api/health` is the one
  unauthenticated route, spec §13/§15.1) and the §15.3 mutation-header
  requirement are pinned against the live route configurations.

## Reading the API through it

- **Authentication** (spec §15.1): the document declares the session-cookie
  scheme globally. In `auth.mode: auto` direct loopback requests need no
  credential; behind a proxy indicator or in `required` mode, every
  non-health operation is authenticated.
- **State-changing requests** (spec §15.3): every `POST`/`PUT`/`PATCH`/
  `DELETE` operation documents the required `X-Quotameter-Request` header and
  (where a body is declared) the `application/json` content type. CORS is
  disabled.
- **Ranges** (spec §13): `from`/`to` on `/api/history`, `/api/events`, and
  `/api/peak-hours` are ISO 8601 UTC with an explicit offset or `Z`;
  response timestamps are epoch milliseconds.
- **API keys** (spec §15.4): never on the wire — accounts carry `hasKey` and
  a constant, content-free mask.
