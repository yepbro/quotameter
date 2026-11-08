/**
 * OpenAPI document builder (spec §13, §18; task 163, decision D-144).
 *
 * Builds the published API description from the SAME TypeBox contracts the
 * routes validate and serialize through: every request/response schema in
 * `docs/openapi.json` is the JSON projection of the exported schema object
 * from `src/schemas/api/*`, and every error response is derived from the
 * frozen code registry (`src/schemas/api/error.ts`, D-113) — §13's "Define
 * every request and response through TypeBox/JSON Schema. Generate and
 * publish OpenAPI" with the wire contract as the single source of truth.
 *
 * The hand-maintained half is the ROUTE INVENTORY below: method, path,
 * operation metadata, and per-route error codes — the facts fastify route
 * options do not carry. `test/unit/openapi-published.spec.ts` pins that half
 * against the real `/api` scope (it boots `apiRoutes` with every family
 * registered and compares methods, paths, parameter schemas, bodies, response
 * schemas, and publicness), so the inventory cannot drift from the server in
 * either direction. Consumers: `scripts/generate-openapi.mjs` (the writer)
 * and the drift guard.
 *
 * OpenAPI 3.1.0 because the schemas are draft 2020-12 (TypeBox's dialect, the
 * same one the published configuration schema declares) and 3.1 schema
 * objects ARE JSON Schema 2020-12 — the projections embed verbatim, with no
 * `nullable` re-writing and no second schema language to drift.
 *
 * TypeScript modules are loaded through `jiti` (an existing devDependency)
 * exactly like `scripts/generate-schema.mjs`: plain Node on the minimum
 * runtime (22.13.0) cannot import `.ts` modules without the experimental
 * type-stripping flag.
 */
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);

const healthSchemas = await jiti.import('../src/schemas/api/health.ts');
const statusSchemas = await jiti.import('../src/schemas/api/status.ts');
const providersSchemas = await jiti.import('../src/schemas/api/providers.ts');
const accountSchemas = await jiti.import('../src/schemas/api/accounts.ts');
const settingsSchemas = await jiti.import('../src/schemas/api/settings.ts');
const historySchemas = await jiti.import('../src/schemas/api/history.ts');
const peakHoursSchemas = await jiti.import('../src/schemas/api/peak-hours.ts');
const authSchemas = await jiti.import('../src/schemas/api/auth.ts');
const errorSchemas = await jiti.import('../src/schemas/api/error.ts');
const { API_MUTATION_HEADER_NAME, STATE_CHANGING_METHODS } = await jiti.import(
  '../src/server/api/security.ts',
);
const { SESSION_COOKIE_NAME } = await jiti.import('../src/services/session-cookie.ts');

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The JSON projection of one TypeBox schema node: structured cloning via
 * JSON strips the `Symbol(Kind)`/modifier annotations TypeBox attaches for
 * its own runtime dispatch, leaving exactly the JSON Schema keywords a
 * consumer (Ajv, editor tooling, OpenAPI readers) sees. Deterministic by
 * construction — insertion order is preserved.
 */
function projection(schema) {
  return JSON.parse(JSON.stringify(schema));
}

/** The §13 error envelope every documented error response answers with. */
const errorBodyProjection = projection(errorSchemas.ApiErrorBodySchema);

/**
 * The §15.3 custom-header parameter carried by every state-changing
 * operation (D-117: presence with a non-empty value; the value is not
 * interpreted — a whitespace-only value is rejected like an absent one,
 * hence the `\\S` pattern). The name and the method set are imported from
 * the guard module, so the document and the enforcement cannot drift.
 */
const mutationHeaderParameter = {
  name: API_MUTATION_HEADER_NAME,
  in: 'header',
  required: true,
  description:
    'Required on every state-changing request (spec §15.3): a value with at least one non-whitespace character; not interpreted.',
  schema: { type: 'string', minLength: 1, pattern: '\\S' },
};

/**
 * Explodes one TypeBox object schema (a route's `params` or `querystring`
 * contract) into OpenAPI parameter objects: one per property, carrying the
 * property node's projection (constraints and description included) and the
 * object's `required` membership. Path parameters are always required
 * (RFC 9110 leaves no optional path segment). A property that declares a
 * `default` is documented optional — the validator runs with
 * `useDefaults: true`, so omitting it is legal and the server materializes
 * the default (the wire truth the schema's `required` list overstates; the
 * drift guard mirrors this rule at its comparison, so the two sites cannot
 * drift apart silently).
 */
function parametersOf(objectSchema, location) {
  const required = new Set(objectSchema.required ?? []);
  return Object.entries(objectSchema.properties ?? {}).map(([name, node]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name) && node.default === undefined,
    description: node.description,
    schema: projection(node),
  }));
}

/**
 * The error responses of one operation, derived from the registry (D-113):
 * code → HTTP status + the default (leak-free) message as the description,
 * with the closed envelope schema as the body. Unknown codes fail the build
 * — the registry is the only vocabulary.
 */
function errorResponsesOf(codes) {
  const responses = {};
  const seenStatuses = new Set();
  for (const code of codes) {
    const definition = errorSchemas.API_ERROR_DEFINITIONS[code];
    if (definition === undefined) {
      throw new Error(
        `OpenAPI inventory: error code '${code}' is not in the registry (src/schemas/api/error.ts)`,
      );
    }
    const status = String(definition.statusCode);
    if (seenStatuses.has(status)) {
      throw new Error(`OpenAPI inventory: two codes for status ${status} on one operation`);
    }
    seenStatuses.add(status);
    responses[status] = {
      description: `${code} — ${definition.message}`,
      content: { 'application/json': { schema: errorBodyProjection } },
    };
  }
  return responses;
}

/** One success response with its serialized body contract. */
function successResponse(description, schema) {
  return {
    description,
    content: { 'application/json': { schema: projection(schema) } },
  };
}

/*
 * The route inventory (§13's table order). `path` is the OpenAPI template
 * form; the drift guard derives fastify's `:param` form for comparison.
 * `errorCodes` are registry codes (D-113), resolved to statuses above; the
 * base sets encode what the construction guarantees scope-wide: VALIDATION
 * and INTERNAL for every route, UNAUTHENTICATED (§15.1; not on the public
 * health route) and FORBIDDEN (the §15.3 Host/Origin/header guards) for all,
 * NOT_FOUND where the handler throws it, PAYLOAD_TOO_LARGE (the §15.5 64 KiB
 * body limit) and UNSUPPORTED_MEDIA_TYPE on the body-carrying mutations
 * (D-117's content-type leg binds body-carrying requests; the bodiless
 * DELETE and connection test deliberately document neither — a body is not
 * part of their contract, and §15.5's limit travels with one).
 */
const OPERATIONS = [
  {
    method: 'get',
    path: '/api/health',
    operationId: 'getHealth',
    tag: 'health',
    summary: 'Public health probe',
    description:
      'The one endpoint that answers without authentication in every auth mode (spec §13, §15.1). ' +
      'The unauthenticated response is exactly `{ "status": "ok" }`; no diagnostics ride it. ' +
      'A request the §15.1 layer would grant — direct loopback in `auto` mode, or a valid ' +
      'session — additionally carries the `polling.running` diagnostics: whether the polling ' +
      "engine's dispatch loop is alive (FSM-4, D-192).",
    public: true,
    schema: { response: { 200: healthSchemas.HealthResponseSchema } },
    responseDescriptions: {
      200: 'The service is up; granted requests also learn whether the polling engine is running.',
    },
    errorCodes: ['VALIDATION', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/status',
    operationId: 'getStatus',
    tag: 'status',
    summary: 'Service state and per-account status',
    description:
      "Service state plus every account's §7.3 status, last successful collection, and last error " +
      "(message redacted against the account's secret). Timestamps are epoch milliseconds.",
    schema: { response: { 200: statusSchemas.StatusResponseSchema } },
    responseDescriptions: { 200: 'Service state with one row per known account.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/providers',
    operationId: 'getProviders',
    tag: 'providers',
    summary: 'Available provider types and their peak-hour schedules',
    description:
      'The registered provider adapters with their declared metric catalogs and the live, read-only ' +
      'peak-hour schedule configuration (spec §9.2) nested per provider.',
    schema: { response: { 200: providersSchemas.ProvidersListResponseSchema } },
    responseDescriptions: { 200: 'One entry per registered provider adapter.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/accounts',
    operationId: 'listAccounts',
    tag: 'accounts',
    summary: 'List accounts (keys masked)',
    description:
      'The management list: the union of configured accounts and storage rows, id-ascending. ' +
      'API keys never ride the response — only `hasKey` and the constant, content-free `keyMask` (spec §13, §15.4).',
    schema: { response: { 200: accountSchemas.AccountsListResponseSchema } },
    responseDescriptions: { 200: 'All known accounts, masked.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'post',
    path: '/api/accounts',
    operationId: 'createAccount',
    tag: 'accounts',
    summary: 'Add an account',
    description:
      'Creates an account. `apiKey` is write-only: accepted here, never echoed (spec §13). ' +
      'The `id` is generated when absent and must fit the configuration charset when supplied.',
    schema: {
      body: accountSchemas.CreateAccountBodySchema,
      response: { 201: accountSchemas.AccountViewSchema },
    },
    responseDescriptions: { 201: 'The created account view.' },
    errorCodes: [
      'VALIDATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'INTERNAL',
    ],
  },
  {
    method: 'patch',
    path: '/api/accounts/{id}',
    operationId: 'updateAccount',
    tag: 'accounts',
    summary: 'Change label, enable state, or key',
    description:
      "Updates §13's three mutable fields; at least one must be supplied. A replacement `apiKey` is " +
      'write-only. Archived accounts are refused (archival is terminal), as are environment-sourced keys (§6.3).',
    params: accountSchemas.AccountIdParamsSchema,
    schema: {
      body: accountSchemas.UpdateAccountBodySchema,
      response: { 200: accountSchemas.AccountViewSchema },
    },
    responseDescriptions: { 200: 'The updated account view.' },
    errorCodes: [
      'VALIDATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'INTERNAL',
    ],
  },
  {
    method: 'delete',
    path: '/api/accounts/{id}',
    operationId: 'deleteAccount',
    tag: 'accounts',
    summary: 'Archive; ?purgeHistory=true explicitly purges history',
    description:
      'Archives the account by default (idempotent; history kept). Only the literal ' +
      '`?purgeHistory=true` arms the destructive purge, whose response carries per-table removal counts.',
    params: accountSchemas.AccountIdParamsSchema,
    querystring: accountSchemas.DeleteAccountQuerySchema,
    schema: { response: { 200: accountSchemas.AccountMutationResultSchema } },
    responseDescriptions: { 200: 'The lifecycle outcome with the (possibly null) purge evidence.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'post',
    path: '/api/accounts/{id}/test',
    operationId: 'testAccountConnection',
    tag: 'accounts',
    summary: 'Test provider connection',
    description:
      "Runs the provider's credential check. A completed test answers 200 with `ok`, `rejected`, or " +
      '`unavailable` — a failed credential is a successful test with a negative result, not a request error.',
    params: accountSchemas.AccountIdParamsSchema,
    schema: { response: { 200: accountSchemas.AccountTestResponseSchema } },
    responseDescriptions: {
      200: 'The test outcome; `message` is present exactly on non-ok outcomes.',
    },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/quota',
    operationId: 'getQuota',
    tag: 'status',
    summary: 'Latest successful snapshot for an account',
    description:
      'The last valid value per metric with header facts from the latest snapshot (rows may come from ' +
      'different snapshots, each stamped). Absence is honest: null facts and an empty metric list, never placeholders.',
    querystring: statusSchemas.QuotaQuerySchema,
    schema: { response: { 200: statusSchemas.QuotaResponseSchema } },
    responseDescriptions: { 200: 'The last valid metric values with freshness context.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/history',
    operationId: 'getHistory',
    tag: 'history',
    summary: 'Metric series with downsampling and gap encoding',
    description:
      'The retention-aware series for one metric. `from`/`to` are ISO 8601 UTC with an explicit offset; ' +
      'response timestamps are epoch milliseconds. Ranges beyond retention answer 200 with a range report; ' +
      '`maxPoints` (100–5000, default 1500) triggers bucket aggregation preserving min/max/first/last.',
    querystring: historySchemas.HistoryQuerySchema,
    schema: { response: { 200: historySchemas.HistoryResponseSchema } },
    responseDescriptions: {
      200: 'The (possibly downsampled, possibly empty) series with its range report.',
    },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/events',
    operationId: 'getEvents',
    tag: 'history',
    summary: 'Resets, gaps, and collection failures',
    description:
      'The unified timeline of resets, gaps, failed collection cycles, and stopped-service regions for ' +
      'one account and range (optionally one metric), kind-discriminated on the wire.',
    querystring: historySchemas.EventsQuerySchema,
    schema: { response: { 200: historySchemas.EventsResponseSchema } },
    responseDescriptions: { 200: 'The timeline items with the range report.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/peak-hours',
    operationId: 'getPeakHours',
    tag: 'peak-hours',
    summary: 'UTC peak/off-peak intervals for a range',
    description:
      "The account's provider schedule computed over the requested range: peak/off-peak intervals as " +
      'epoch-ms boundaries beside the schedule-zone local-time strings. A range beyond retention answers ' +
      '200 with the range report over the effective range.',
    querystring: peakHoursSchemas.PeakHoursQuerySchema,
    schema: { response: { 200: peakHoursSchemas.PeakHoursResponseSchema } },
    responseDescriptions: { 200: 'The interval list with the schedule facts.' },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/settings',
    operationId: 'getSettings',
    tag: 'settings',
    summary: 'Safe settings view (secrets masked)',
    description:
      'Every scalar setting with value, source (`file`/`environment`), and restart-required marking; ' +
      'secrets are masked or omitted (spec §13, §14.5) and configuration/data paths are read-only facts. ' +
      'Beside the static class markings, `pendingRestart` carries the live restart-pending diff — the ' +
      'restart-requiring fields whose effective values were changed and adopted by a reload and still ' +
      'await a process restart (empty on a fresh process; spec §6.4, D-193).',
    schema: { response: { 200: settingsSchemas.SettingsResponseSchema } },
    responseDescriptions: {
      200: 'The annotated settings view with paths and the live pendingRestart diff.',
    },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'put',
    path: '/api/settings',
    operationId: 'updateSettings',
    tag: 'settings',
    summary: 'Update runtime-modifiable settings',
    description:
      'Applies the settings allowed for runtime modification (spec §6.4). Environment-overridden fields, ' +
      'restart-required fields, and the password hash are refused with stable reasons; the plaintext ' +
      '`auth.password` is the one sanctioned password channel.',
    schema: {
      body: settingsSchemas.UpdateSettingsBodySchema,
      response: { 200: settingsSchemas.UpdateSettingsResponseSchema },
    },
    responseDescriptions: { 200: 'The applied/restart-required outcome with the refreshed view.' },
    errorCodes: [
      'VALIDATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'INTERNAL',
    ],
  },
  {
    method: 'post',
    path: '/api/auth/login',
    operationId: 'login',
    tag: 'auth',
    summary: 'Log in with the password',
    description:
      'Composes §15.2 end to end: the per-source failed-attempt budget (increasing delays, never ' +
      'rejections — an over-budget attempt is answered slowly with the same envelope, and the ' +
      'slept delay is clamped to a transport-safe ceiling), scrypt verification, the session ' +
      'mint, and the `Set-Cookie` header (HttpOnly, SameSite=Strict, Path=/api; Secure when the ' +
      'client-facing leg is HTTPS). One attempt per source address runs at a time; a same-source ' +
      'request arriving while another is in flight answers the same 401 under `source-busy` ' +
      'without being verified. The route is public in the §15.1 sense (the credential-presenting ' +
      'client has no session yet), so `UNAUTHENTICATED` here is the wrong-or-absent-password ' +
      'verdict, not the mode guard’s demand. Repeated logins mint fresh sessions; a ' +
      'passwordless configuration answers 401 fail-closed.',
    public: true,
    schema: {
      body: authSchemas.LoginBodySchema,
      response: { 200: authSchemas.LoginResponseSchema },
    },
    responseDescriptions: {
      200: 'A session was established; the session cookie is set and `expiresAt` is its row’s effective expiry.',
    },
    errorCodes: [
      'VALIDATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'INTERNAL',
    ],
  },
  {
    method: 'post',
    path: '/api/auth/logout',
    operationId: 'logout',
    tag: 'auth',
    summary: 'Revoke the session and clear the cookie',
    description:
      'Session-bound and idempotent: revokes the session row named by the presented cookie and ' +
      'answers the clear-cookie twin (`Max-Age=0`) whether or not a live row was deleted. Under a ' +
      'password-demanding §15.1 verdict a request without a valid session answers 401 before the ' +
      'handler. Carries no body, so the §15.3 mutation header is its only extra requirement.',
    schema: { response: { 200: authSchemas.LogoutResponseSchema } },
    responseDescriptions: {
      200: 'Whether a live session was revoked; the cookie is cleared either way.',
    },
    errorCodes: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
  },
  {
    method: 'get',
    path: '/api/auth/session',
    operationId: 'getAuthSession',
    tag: 'auth',
    summary: 'Current session and auth-mode information',
    description:
      '§13’s third auth row (decision D-182): reports the §15.1 verdict for this request ' +
      '(`mode` — the same classification the guard applies to protected routes: 200/401/403 ' +
      'elsewhere already reveal it) and whether the presented session cookie maps to a valid, ' +
      'unexpired session row (`authenticated`; every other cookie outcome collapses to false). ' +
      'On the authenticated arm `session.expiresAt` carries the row’s refreshed effective expiry ' +
      '— the sighting refreshes it like any authenticated request (D-124) and no cookie is ' +
      '(re-)issued. Public like login: the client asking whether it needs credentials may hold ' +
      'none yet; the Host and §15.3 guards still bind the route.',
    public: true,
    schema: { response: { 200: authSchemas.SessionResponseSchema } },
    responseDescriptions: {
      200:
        'The request’s §15.1 mode and the presented cookie’s validity, with the refreshed ' +
        'expiry exactly on the valid arm.',
    },
    errorCodes: ['VALIDATION', 'FORBIDDEN', 'INTERNAL'],
  },
];

/** The tag table (one per route family), in inventory order. */
const TAGS = [
  { name: 'health', description: 'The public health probe (spec §13).' },
  { name: 'status', description: 'Service state and latest quota values (spec §7.3, §8.4).' },
  {
    name: 'providers',
    description: 'Provider types and read-only peak-hour schedules (spec §8.1, §9.2).',
  },
  { name: 'accounts', description: 'Account management with write-only keys (spec §8.2, §6.3).' },
  { name: 'history', description: 'Range-bearing series and timeline reads (spec §12, §11.3).' },
  { name: 'peak-hours', description: 'Computed peak/off-peak intervals (spec §9.3).' },
  {
    name: 'settings',
    description: 'The safe settings view and runtime updates (spec §6.4, §14.5).',
  },
  {
    name: 'auth',
    description:
      'Login, logout, and the session reader over the §15.2 primitives (spec §15.2, §15.1, §14.6).',
  },
];

/**
 * Builds the published OpenAPI document (pure data, no filesystem): the
 * inventory composed over the schema projections. Deterministic — given the
 * schemas and this module, two calls return deep-equal documents.
 *
 * The inventory is a parameter (defaulting to the one above) so the unit
 * spec can drive the builder's rejection arms — a duplicate `operationId`,
 * a duplicate `(method, path)` pair (which would otherwise silently
 * overwrite the earlier operation), an error code outside the registry, or
 * two codes colliding on one HTTP status.
 */
export function buildOpenApiDocument(operations = OPERATIONS) {
  const paths = {};
  const operationIds = new Set();
  const operationKeys = new Set();
  for (const operation of operations) {
    if (operationIds.has(operation.operationId)) {
      throw new Error(`OpenAPI inventory: duplicate operationId '${operation.operationId}'`);
    }
    operationIds.add(operation.operationId);

    const operationKey = `${operation.method} ${operation.path}`;
    if (operationKeys.has(operationKey)) {
      throw new Error(`OpenAPI inventory: duplicate operation '${operationKey}'`);
    }
    operationKeys.add(operationKey);

    const responses = {};
    for (const [status, description] of Object.entries(operation.responseDescriptions)) {
      responses[status] = successResponse(description, operation.schema.response[Number(status)]);
    }
    Object.assign(responses, errorResponsesOf(operation.errorCodes));

    const parameters = [
      ...(operation.params === undefined ? [] : parametersOf(operation.params, 'path')),
      ...(operation.querystring === undefined ? [] : parametersOf(operation.querystring, 'query')),
    ];
    if (STATE_CHANGING_METHODS.has(operation.method.toUpperCase())) {
      parameters.push(mutationHeaderParameter);
    }

    const item = paths[operation.path] ?? {};
    item[operation.method] = {
      summary: operation.summary,
      description: operation.description,
      operationId: operation.operationId,
      tags: [operation.tag],
      ...(operation.public === true ? { security: [] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(operation.schema.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: projection(operation.schema.body) } },
            },
          }),
      responses,
    };
    paths[operation.path] = item;
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Quotameter HTTP API',
      version,
      description:
        'The internal HTTP API of the Quotameter web service (spec §13). Every request and response is ' +
        'defined by the same TypeBox contracts the server validates through, and every error answers the ' +
        'common envelope `{ "error": { "code", "message", "details" } }` with stable codes. ' +
        'All state-changing requests (POST/PUT/PATCH/DELETE) require the dedicated nonstandard header, ' +
        'and a JSON content type whenever the request carries a body (spec §15.3); CORS is disabled. ' +
        'The human-readable reference is docs/api.md in the project repository ' +
        '(https://github.com/yepbro/quotameter).',
    },
    servers: [
      {
        url: '/',
        description: 'Same-origin: loopback, SSH tunnel, or reverse proxy (spec §15.6).',
      },
    ],
    security: [{ sessionCookie: [] }],
    tags: TAGS,
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description:
            'Session cookie of the password modes (spec §15.1/§15.2). Passwordless loopback access in ' +
            '`auto` mode needs no credential; every operation except the health probe, login, and the ' +
            'session reader is otherwise authenticated.',
        },
      },
    },
  };
}
