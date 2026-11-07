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
  contracts —, peak-hours, auth — the login, logout, and session-reader
  contracts —, health, error), projected verbatim: what the
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
same generated-output-to-the-data-volume pattern as `make schema` (the
generator's output
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
- a security-model mismatch: the public set (`GET /api/health`,
  `POST /api/auth/login`, and `GET /api/auth/session` are the unauthenticated
  routes, spec §13/§15.1 — login and the session reader declare it through
  the same public route config, D-121/D-146/D-182)
  and the §15.3 mutation-header requirement are pinned against the live
  route configurations.

## Reading the API through it

- **Authentication** (spec §15.1): the document declares the session-cookie
  scheme globally. In `auth.mode: auto` direct loopback requests need no
  credential; behind a proxy indicator or in `required` mode, every
  operation except the health probe, login, and the session reader is
  authenticated. Sessions come from `POST /api/auth/login` (the wrong-password
  401 answers the same `UNAUTHENTICATED` code) and end at
  `POST /api/auth/logout`; the cookie's `Max-Age` mirrors the session row's
  effective expiry, and refreshed sightings do not re-issue it (D-146) — the
  row's §15.2 verdict is the security boundary. `GET /api/auth/session`
  (D-182) reports the §15.1 verdict for the request (`mode`) and whether the
  presented cookie maps to a valid session (`authenticated`, with the
  refreshed `session.expiresAt` on the valid arm) — the mode facts any probe
  of a protected route already reveals, stated instead of forced.
- **State-changing requests** (spec §15.3): every `POST`/`PUT`/`PATCH`/
  `DELETE` operation documents the required `X-Quotameter-Request` header and
  (where a body is declared) the `application/json` content type. CORS is
  disabled.
- **Ranges** (spec §13): `from`/`to` on `/api/history`, `/api/events`, and
  `/api/peak-hours` are ISO 8601 UTC with an explicit offset or `Z`;
  response timestamps are epoch milliseconds everywhere — D-139's
  one-format-per-direction rule, recorded as the deliberate API
  representation by the §10 amendment of spec 1.2 (D-183).
- **Account statuses** (spec §7.3, spec 1.1's archived-dominance rule —
  D-180/D-191): the status fields of `/api/status` rows and `/api/quota`
  carry the canonical lifecycle precedence `archived` → `disabled` →
  `not-configured` → the §7.3 working statuses. An account whose storage
  row is archived (§8.2) answers `archived` on every surface — including
  a hand-re-added archived id whose configuration entry still claims
  enabled/keyed — and never a runtime status; its reads stay unrefused
  with the retained history honestly labeled.
- **API keys** (spec §15.4): never on the wire — accounts carry `hasKey` and
  a constant, content-free mask.
- **Health diagnostics** (spec §13, D-192): `GET /api/health` is public in
  every auth mode and its unauthenticated body is the byte-exact literal
  `{"status":"ok"}` — the schema-compiled serializer omits the optional
  `polling` block entirely when it is not granted, so no diagnostic can
  leak. A request the §15.1 layer would grant — a direct loopback request
  in `auth.mode: auto`, or any request with a valid session — additionally
  receives `polling.running`: whether the polling engine's dispatch loop
  is alive. A dead engine (a wiring failure killed the scheduler with
  `running=false`) is thereby visible on the wire while the process stays
  up; the death itself logs exactly one `error` record (§16), and
  `quotameter status` warns from the run evidence (three intervals of
  silence under a live pid) with a `quotameter logs` pointer.
