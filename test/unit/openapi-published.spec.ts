import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance, FastifySchema, HTTPMethods } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiRoutes } from '../../src/server/api/index';
import type { ApiRoutesOptions } from '../../src/server/api/index';
import type { AccountConfigStore } from '../../src/server/api/accounts';
import type { SettingsStore } from '../../src/server/api/settings';
import { API_MUTATION_HEADER_NAME, STATE_CHANGING_METHODS } from '../../src/server/api/security';
import { ApiErrorBodySchema, API_ERROR_DEFINITIONS } from '../../src/schemas/api/error';
import { SESSION_COOKIE_NAME } from '../../src/services/session-cookie';
import { ProviderRegistry } from '../../src/providers/registry';
import type { QuotaRepository } from '../../src/storage/repository';
import { buildOpenApiDocument } from '../../scripts/openapi-document.mjs';
import { serializeOpenApiDocument } from '../../scripts/generate-openapi.mjs';

/**
 * The OpenAPI drift guard (spec §13, §18; task 163, decision D-144;
 * extended by task 192, decision D-202): the published `docs/openapi.json`
 * must match the routes the server actually registers, in both directions
 * and down to the schemas — the same spirit as the coverage-threshold
 * guard (D-093) and the published-config-schema pin
 * (`config-schema-published.spec.ts`).
 *
 * The published document is the JSON projection of the same TypeBox
 * contracts the routes validate through, composed over a literal route
 * inventory (`scripts/openapi-document.mjs` — fastify route options carry no
 * operation metadata, so method/path/summary/error-code facts live there).
 * This suite pins the hand-maintained half against the real thing:
 *
 * 1. **Freshness** — the committed artifact equals the builder output, so
 *    regeneration (`make openapi`) cannot be forgotten; task 192 (D-202)
 *    pinned the byte level too: the committed file equals the writer's own
 *    serialization, so a green suite guarantees regeneration is a no-op.
 * 2. **No undocumented route** — every (method, path) the `/api` scope
 *    registers appears in the document.
 * 3. **No phantom route** — every documented (method, path) is really
 *    registered.
 * 4. **Schema wiring** — for every route, the document's path/query
 *    parameters, request body, and success-response schemas are exactly the
 *    projections of the schemas the route declares (a route re-wired to a
 *    different contract fails even when its method and path still match);
 *    every non-serializer response is an EXACT registry entry (description,
 *    status, and the closed envelope body), and the construction-guaranteed
 *    base codes (VALIDATION/INTERNAL/FORBIDDEN, plus UNAUTHENTICATED off
 *    the public route) are documented.
 * 5. **Security model** — the document's public set equals the live public
 *    route configs, exactly the state-changing methods carry §15.3's
 *    custom header (D-117), and the root session-cookie requirement and
 *    scheme are present (D-126's constant).
 * 6. **Contract-lane coverage** (task 192, D-202) — every documented
 *    operation is exercised end-to-end by the §13 contract sweep
 *    (`test/integration/api-sweep-contract.spec.ts`, task 164/D-145), and
 *    every sweep call targets exactly one documented operation: the
 *    published reference and the contract tests cannot fork.
 *
 * The route inventory is collected through fastify's `onRoute` hook — the
 * one public introspection surface that still exposes route options (method,
 * prefixed url, `schema`, `config`) on the pinned runtime. The boot is
 * registration-only: every injected seam throws if called, because nothing
 * in a plugin body invokes a seam before a request arrives (proven by this
 * suite booting green) — no sockets, no SQLite, so the guard lives in the
 * unit project.
 *
 * The committed artifact is read with `node:fs` instead of a typed JSON
 * import (the `config-schema-published.spec.ts` style) because at ~290 KB
 * the inferred literal type would dominate type-checking for no gain — the
 * guard compares parsed data, never the inferred shape.
 */

/** The committed published artifact's exact bytes (parsed for traversal below). */
const committedText = readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8');

/** The committed published artifact, as loose keyword maps for traversal. */
const committedDocument = JSON.parse(committedText) as Record<string, unknown>;

/** The re-assembled form of "no parameters of this kind were documented". */
const NO_PARAMETERS = {
  additionalProperties: false,
  type: 'object',
  properties: {},
} as const;

/** The builder's current output (the same object `make openapi` serializes). */
const builtDocument = buildOpenApiDocument();

/* ── The live route inventory (the real `/api` scope, registration-only) ── */

/** One route as fastify's `onRoute` hook reports it, normalized. */
interface LiveRoute {
  readonly method: HTTPMethods;
  /** The prefixed router form, e.g. `/api/accounts/:id`. */
  readonly url: string;
  readonly schema: FastifySchema | undefined;
  readonly config: unknown;
}

/** Everything `onRoute` saw, in registration order (HEAD twins included). */
const collected: LiveRoute[] = [];

let app: FastifyInstance | undefined;

/** A seam double that fails the test the moment a registration-only boot calls it. */
function refusingSeam(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `drift-guard boot: seam ${name} was called (registration must not invoke seams)`,
    );
  };
}

beforeAll(async () => {
  const refuse = refusingSeam;
  const store = {
    list: refuse('store.list'),
    find: refuse('store.find'),
    add: refuse('store.add'),
    update: refuse('store.update'),
    remove: refuse('store.remove'),
    secretOf: refuse('store.secretOf'),
  } as unknown as AccountConfigStore;
  const repository = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`drift-guard boot: repository.${String(property)} was called`);
      },
    },
  ) as QuotaRepository;
  const settingsStore = {
    read: refuse('settings.read'),
    apply: refuse('settings.apply'),
  } as unknown as SettingsStore;
  const never = refuse('clock');
  const schedules = refuse('schedules');

  // Every route family is wired — the `Required<...>` satisfaction is the
  // future-family pin: a new optional member of `ApiRoutesOptions` left
  // unwired here fails typecheck in this file, so a new family can never
  // be silently invisible to every arm below.
  const wiredRoutes = {
    accounts: { store, repository, registry: new ProviderRegistry(), now: never },
    status: {
      store,
      repository,
      pollingIntervalSeconds: refuse('pollingIntervalSeconds'),
      suspensionOf: refuse('suspensionOf'),
      now: never,
    },
    providers: { registry: new ProviderRegistry(), schedules },
    settings: { store: settingsStore },
    history: { store, repository, historyRetentionDays: refuse('retention'), now: never },
    peakHours: {
      store,
      repository,
      schedules,
      historyRetentionDays: refuse('retention'),
      now: never,
    },
    authRoutes: { repository, passwordHash: refuse('passwordHash'), now: never },
    // FSM-4/D-192: the health diagnostics source — refusing, because the
    // registration-only boot never serves a request.
    health: { polling: { running: refuse('health.running') } },
  } satisfies Required<Omit<ApiRoutesOptions, 'auth'>>;

  app = Fastify({ logger: false });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      collected.push({
        method,
        url: route.url,
        schema: route.schema,
        config: route.config,
      });
    }
  });
  await app.register(apiRoutes, {
    prefix: '/api',
    auth: { mode: 'auto', bindHost: '127.0.0.1' },
    ...wiredRoutes,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

/** Fastify's router form (`:id`) to the OpenAPI template form (`{id}`). */
function templateForm(routerPath: string): string {
  return routerPath.replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** The documented operations: `${method} ${templatePath}` → the operation object. */
function documentedOperations(): Map<string, Record<string, unknown>> {
  const operations = new Map<string, Record<string, unknown>>();
  const paths = committedDocument.paths as Record<string, Record<string, unknown>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      operations.set(`${method.toUpperCase()} ${path}`, operation as Record<string, unknown>);
    }
  }
  return operations;
}

/**
 * The live operations worth documenting: every registered route except
 * fastify's auto-generated HEAD twins (a transport artifact of GET, not a
 * §13 operation — their headers are the GET's) and the scope's catch-all
 * (`/api/*`, an error handler for unmatched paths, not an operation; its
 * contract is the error envelope every operation already documents).
 */
function liveDocumentedRoutes(): LiveRoute[] {
  const hasGet = new Set(collected.filter((route) => route.method === 'GET').map((r) => r.url));
  return collected.filter(
    (route) => route.url !== '/api/*' && !(route.method === 'HEAD' && hasGet.has(route.url)),
  );
}

/** The JSON projection of a live schema node (TypeBox symbols stripped). */
function projection(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

/**
 * The documented equivalent of a live params/querystring projection: the
 * builder's publication rule — a property that declares a `default` is
 * documented optional, because the validator (`useDefaults: true`)
 * materializes it when omitted (the wire truth the TypeBox `required` list
 * overstates; e.g. `maxPoints`). The rule lives here beside the builder's
 * copy deliberately: this arm compares the two, so a change on one side
 * without the other fails `make check`.
 */
function documentedEquivalent(schema: unknown): Record<string, unknown> {
  const node = projection(schema) as Record<string, unknown>;
  const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties === undefined || !Array.isArray(node.required)) return node;
  const required = (node.required as string[]).filter(
    (name) => properties[name]?.default === undefined,
  );
  return { ...node, ...(required.length > 0 ? { required } : {}) };
}

/** The operation's parameters for one location, as a loose array. */
function parametersOf(
  operation: Record<string, unknown>,
  location: string,
): Array<Record<string, unknown>> {
  const parameters = operation.parameters;
  if (parameters === undefined) return [];
  return (parameters as Array<Record<string, unknown>>).filter(
    (parameter) => parameter.in === location,
  );
}

/** Re-assembles exploded parameters into the object schema they came from. */
function reassembledObjectSchema(
  operation: Record<string, unknown>,
  location: 'path' | 'query',
): Record<string, unknown> {
  const selected = parametersOf(operation, location);
  const required = selected
    .filter((parameter) => parameter.required === true)
    .map((parameter) => parameter.name);
  return {
    additionalProperties: false,
    type: 'object',
    ...(required.length > 0 ? { required } : {}),
    properties: Object.fromEntries(selected.map((parameter) => [parameter.name, parameter.schema])),
  };
}

/* ── 1. Freshness ───────────────────────────────────────────────────────── */

/* ── Contract-lane coverage helpers (task 192, D-202) ───────────────────── */

/** The §13 contract sweep's source (task 164, D-145) — the tie's other side. */
const sweepSource = readFileSync(
  new URL('../integration/api-sweep-contract.spec.ts', import.meta.url),
  'utf8',
);

/**
 * The sweep's HTTP invocations as the parser recognizes them: the method
 * single-quoted, the path a quoted string or a template literal (`\s*`
 * spans the multi-line argument lists).
 */
const SWEEP_CALL_PATTERN = /\.(?:call|probe)\(\s*'([A-Z]+)'\s*,\s*(['"`])([^'"`]+)\2/g;

/** One `call`/`probe` invocation of the sweep, as the source parser sees it. */
interface SweptCall {
  readonly method: string;
  /** The path with the query string stripped — routing never sees it. */
  readonly path: string;
}

/** The sweep's HTTP invocations, parsed out of its source. */
function sweptCalls(): SweptCall[] {
  return [...sweepSource.matchAll(SWEEP_CALL_PATTERN)].map((match) => ({
    method: match[1] ?? '',
    path: (match[3] ?? '').split('?')[0] ?? '',
  }));
}

/**
 * Raw `call`/`probe` invocation openings the parser did not match — the
 * parse-pin's teeth. A sweep call written in a shape the parser cannot see
 * (a double-quoted method, a path through a variable, a renamed helper)
 * would otherwise silently drop out of the coverage set below; this fails
 * naming the unseen invocation instead.
 */
function unparsedInvocations(): string[] {
  const parsed = new Set([...sweepSource.matchAll(SWEEP_CALL_PATTERN)].map((m) => m.index));
  return [...sweepSource.matchAll(/\.(?:call|probe)\(/g)]
    .filter((match) => !parsed.has(match.index))
    .map((match) => JSON.stringify(sweepSource.slice(match.index, (match.index ?? 0) + 60)));
}

/** True when a concrete swept path instantiates an OpenAPI path template. */
function pathMatchesTemplate(path: string, template: string): boolean {
  const segments = path.split('/');
  const templateSegments = template.split('/');
  return (
    segments.length === templateSegments.length &&
    segments.every((segment, index) => {
      const templateSegment = templateSegments[index] ?? '';
      return segment === templateSegment || (segment !== '' && /^\{[^}]+\}$/.test(templateSegment));
    })
  );
}

describe('published OpenAPI artifact (spec §13, §18; task 163, D-144)', () => {
  it('equals the builder output — regenerate with `make openapi` when stale', () => {
    // Both sides are pure JSON data: the projection drops the TypeBox
    // symbol markers the live schema nodes carry, so equality compares
    // exactly what an OpenAPI consumer reads.
    expect(committedDocument).toEqual(builtDocument);
  });

  it('is byte-for-byte what regeneration writes — `make openapi` is a no-op while green', async () => {
    // The equality above compares parsed data, so a hand-reformatted file
    // (or a Prettier configuration change) would pass while NOT being what
    // `make openapi` produces. The byte arm runs the writer's own exported
    // serializer — the one implementation, never a mirrored copy that
    // could fork — so green guarantees a zero-diff regeneration (task 192,
    // D-202).
    expect(await serializeOpenApiDocument(builtDocument)).toBe(committedText);
  });

  it('declares OpenAPI 3.1.0 over the draft 2020-12 dialect the schemas use', () => {
    expect(committedDocument.openapi).toBe('3.1.0');
    expect(committedDocument.jsonSchemaDialect).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect((committedDocument.info as Record<string, unknown>).title).toBe('Quotameter HTTP API');
  });

  /* ── 2 + 3. Route-table drift, both arms ──────────────────────────────── */

  it('documents every real /api route — no undocumented routes', () => {
    const documented = documentedOperations();
    const missing = liveDocumentedRoutes()
      .map((route) => `${route.method} ${templateForm(route.url)}`)
      .filter((key) => !documented.has(key));
    expect(
      missing,
      'routes registered by the /api scope but absent from docs/openapi.json — ' +
        'add them to the inventory in scripts/openapi-document.mjs and run `make openapi`',
    ).toEqual([]);
  });

  it('documents no route the real scope does not register — no phantom routes', () => {
    const live = new Set(
      liveDocumentedRoutes().map((route) => `${route.method} ${templateForm(route.url)}`),
    );
    const phantom = [...documentedOperations().keys()].filter((key) => !live.has(key));
    expect(
      phantom,
      'documented operations with no matching route in the /api scope — ' +
        'remove them from the inventory in scripts/openapi-document.mjs and run `make openapi`',
    ).toEqual([]);
  });

  it('keeps the scope structural pins: the catch-all and the HEAD twins exist', () => {
    // The exclusions above must never silently swallow a restructure: the
    // catch-all route (D-113) stays registered for many methods, and GET
    // routes keep their auto HEAD twins.
    const catchAll = collected.find((route) => route.url === '/api/*');
    expect(catchAll?.schema).toBeUndefined();
    expect(collected.some((route) => route.url === '/api/health' && route.method === 'HEAD')).toBe(
      true,
    );
  });

  /* ── 4. Schema wiring ─────────────────────────────────────────────────── */

  it('embeds exactly the params/query/body/response schemas the routes declare', () => {
    const documented = documentedOperations();
    for (const route of liveDocumentedRoutes()) {
      const key = `${route.method} ${templateForm(route.url)}`;
      const operation = documented.get(key);
      expect(operation, `documented operation for ${key}`).toBeDefined();

      // Path parameters: the exploded set re-assembles to the live params
      // schema's documented equivalent (names, required flags, and every
      // embedded constraint compared at once). No params schema → no path
      // parameters.
      expect(reassembledObjectSchema(operation!, 'path'), `path parameters of ${key}`).toEqual(
        route.schema?.params === undefined
          ? NO_PARAMETERS
          : documentedEquivalent(route.schema.params),
      );

      // Query parameters, same discipline.
      expect(reassembledObjectSchema(operation!, 'query'), `query parameters of ${key}`).toEqual(
        route.schema?.querystring === undefined
          ? NO_PARAMETERS
          : documentedEquivalent(route.schema.querystring),
      );

      // Request body: presence must match, and the embedded schema must be
      // the projection of the contract the route validates through.
      const body = operation!.requestBody as Record<string, unknown> | undefined;
      expect(body !== undefined, `requestBody presence of ${key}`).toBe(
        route.schema?.body !== undefined,
      );
      if (route.schema?.body !== undefined && body !== undefined) {
        const content = body.content as Record<string, Record<string, unknown>>;
        expect(content['application/json']?.schema, `body schema of ${key}`).toEqual(
          projection(route.schema.body),
        );
      }

      // Responses. A status is either the route's serializer status (then
      // the documented body is that schema's projection) or an error class
      // (then it must be an EXACT registry entry — description, status, and
      // the closed envelope body — so neither an invented description nor a
      // mis-mapped status can ride along). The construction-guaranteed base
      // set is asserted with it: VALIDATION/INTERNAL/FORBIDDEN everywhere,
      // UNAUTHENTICATED everywhere but the public route.
      const responses = operation!.responses as Record<string, Record<string, unknown>>;
      const liveStatuses = new Set(
        Object.keys(route.schema?.response ?? {}).map((status) => String(status)),
      );
      const isPublicLive =
        (route.config as { readonly auth?: unknown } | undefined)?.auth === 'public';
      const requiredCodes: Array<keyof typeof API_ERROR_DEFINITIONS> = isPublicLive
        ? ['VALIDATION', 'FORBIDDEN', 'INTERNAL']
        : ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'];
      for (const code of requiredCodes) {
        expect(
          responses[String(API_ERROR_DEFINITIONS[code].statusCode)],
          `${key} must document the ${code} class (the construction guarantees it)`,
        ).toBeDefined();
      }
      const descriptions = new Map(
        Object.entries(API_ERROR_DEFINITIONS).map(([code, definition]) => [
          `${code} — ${definition.message}`,
          String(definition.statusCode),
        ]),
      );
      const envelope = projection(ApiErrorBodySchema);
      for (const [status, response] of Object.entries(responses)) {
        if (liveStatuses.has(status)) {
          const content = (response.content as Record<string, Record<string, unknown>>)[
            'application/json'
          ];
          const liveResponses = route.schema?.response as Record<number, unknown> | undefined;
          expect(content?.schema, `response ${status} schema of ${key}`).toEqual(
            projection(liveResponses?.[Number(status)]),
          );
          continue;
        }
        const registryStatus = descriptions.get(String(response.description));
        expect(
          registryStatus,
          `status ${status} of ${key} is neither the route's serializer status nor an exact registry error description`,
        ).toBeDefined();
        expect(
          registryStatus,
          `registry status of "${String(response.description)}" (${key})`,
        ).toBe(status);
        const content = (response.content as Record<string, Record<string, unknown>>)[
          'application/json'
        ];
        expect(content?.schema, `error body of ${key} ${status}`).toEqual(envelope);
      }
      for (const status of liveStatuses) {
        expect(responses[status], `documented status ${status} of ${key}`).toBeDefined();
      }
    }
  });

  /* ── 5. Security model ────────────────────────────────────────────────── */

  it('marks exactly the live public routes public (spec §13, §15.1)', () => {
    const documented = documentedOperations();
    for (const route of liveDocumentedRoutes()) {
      const operation = documented.get(`${route.method} ${templateForm(route.url)}`)!;
      const isPublicLive =
        (route.config as { readonly auth?: unknown } | undefined)?.auth === 'public';
      if (isPublicLive) {
        expect(operation.security, `security override of the public ${route.url}`).toEqual([]);
      } else {
        expect(
          operation.security,
          `security override of the non-public ${route.url}`,
        ).toBeUndefined();
      }
    }
  });

  it('requires the §15.3 mutation header on exactly the state-changing methods', () => {
    const documented = documentedOperations();
    for (const route of liveDocumentedRoutes()) {
      const operation = documented.get(`${route.method} ${templateForm(route.url)}`)!;
      const headerParameters = parametersOf(operation, 'header');
      if (STATE_CHANGING_METHODS.has(route.method)) {
        expect(headerParameters, `the ${route.method} ${route.url} mutation header`).toEqual([
          expect.objectContaining({
            name: API_MUTATION_HEADER_NAME,
            in: 'header',
            required: true,
          }),
        ]);
      } else {
        expect(headerParameters, `header parameters of the safe ${route.url}`).toEqual([]);
      }
    }
  });

  /* ── 6. Global security contract ──────────────────────────────────────── */

  it('declares the global session-cookie requirement and the scheme (spec §15.1/§15.2)', () => {
    // The per-operation overrides above are meaningless without the root
    // requirement they override: deleting it (or the scheme) would publish
    // an effectively unauthenticated reference while every other arm still
    // passed. The scheme name is the owning module's constant.
    expect(committedDocument.security).toEqual([{ sessionCookie: [] }]);
    const components = committedDocument.components as Record<string, Record<string, unknown>>;
    const scheme = components.securitySchemes?.sessionCookie as Record<string, unknown>;
    expect(scheme).toBeDefined();
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME });
  });

  /* ── 7. Contract-lane coverage (task 192, D-202) ──────────────────────── */

  it('is exercised end-to-end by the §13 contract sweep, in both directions', () => {
    // The arms above prove the document matches what the server REGISTERS;
    // this one proves it matches what the contract tests TEST. The sweep
    // (task 164, D-145) answers every §13 endpoint through the production
    // composition — the executable form of the spec's route table — so
    // tying its calls to the document's operations makes "API docs match
    // contract tests" a checked invariant: a documented operation without
    // a sweep call (documentation the contract lane never proves) and a
    // sweep call without its documented operation (a tested route the
    // reference does not publish) both fail here.
    const calls = sweptCalls();
    // The parse-pin: every raw invocation must be seen by the parser — a
    // call shape it cannot recognize fails here by name, never silently.
    expect(
      unparsedInvocations(),
      'sweep invocations the parser cannot see — extend the parser (SWEEP_CALL_PATTERN) or reshape the call',
    ).toEqual([]);

    const documented = documentedOperations();
    const covered = new Set<string>();
    const offDocument: string[] = [];
    for (const call of calls) {
      const hits = [...documented.keys()].filter(
        (key) =>
          key.startsWith(`${call.method} `) &&
          pathMatchesTemplate(call.path, key.slice(call.method.length + 1)),
      );
      if (hits.length === 1) {
        covered.add(hits[0]!);
      } else {
        offDocument.push(`${call.method} ${call.path} (${hits.length} matching operations)`);
      }
    }
    expect(offDocument, 'sweep calls that do not hit exactly one documented operation').toEqual([]);

    const uncovered = [...documented.keys()].filter((key) => !covered.has(key));
    expect(
      uncovered,
      'documented operations the contract sweep never exercises — add the ' +
        'happy-path call to test/integration/api-sweep-contract.spec.ts',
    ).toEqual([]);
  });
});
