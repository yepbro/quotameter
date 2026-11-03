import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../scripts/openapi-document.mjs';
import { HealthResponseSchema } from '../../src/schemas/api/health';
import { API_MUTATION_HEADER_NAME } from '../../src/server/api/security';

/**
 * The OpenAPI builder's own contract (task 163, D-144): the rejection arms
 * that keep the literal inventory honest at build time — a duplicate
 * `operationId`, a duplicate `(method, path)` pair (which would otherwise
 * silently overwrite the earlier operation), an error code outside the
 * D-113 registry, two codes colliding on one HTTP status — plus the
 * publication rules the drift guard mirrors from the other side (the
 * defaulted-property rule, the mutation-header placement). The builder is
 * driven with injected inventories so every arm is reachable without
 * touching the committed one; the drift guard
 * (`openapi-published.spec.ts`) pins the committed document against the
 * real route table instead.
 */

/** One minimal inventory entry over a real schema export. */
function probeOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'get',
    path: '/api/probe',
    operationId: 'probe',
    tag: 'health',
    summary: 'Probe',
    description: 'Probe.',
    schema: { response: { 200: HealthResponseSchema } },
    responseDescriptions: { 200: 'The probe answered.' },
    errorCodes: ['VALIDATION'],
    ...overrides,
  };
}

describe('OpenAPI builder rejection arms (task 163, D-144)', () => {
  it('rejects a duplicate operationId', () => {
    expect(() =>
      buildOpenApiDocument([probeOperation(), probeOperation({ path: '/api/other' })]),
    ).toThrow("duplicate operationId 'probe'");
  });

  it('rejects a duplicate (method, path) pair even under different operationIds', () => {
    // Without this arm, the second entry would silently overwrite the first
    // in the paths map and the drift guard would only ever see the survivor.
    expect(() =>
      buildOpenApiDocument([probeOperation(), probeOperation({ operationId: 'probeAgain' })]),
    ).toThrow("duplicate operation 'get /api/probe'");
  });

  it('rejects an error code outside the registry (D-113 is the only vocabulary)', () => {
    expect(() => buildOpenApiDocument([probeOperation({ errorCodes: ['TEAPOT'] })])).toThrow(
      "error code 'TEAPOT' is not in the registry",
    );
  });

  it('rejects two codes colliding on one HTTP status', () => {
    expect(() =>
      buildOpenApiDocument([probeOperation({ errorCodes: ['VALIDATION', 'VALIDATION'] })]),
    ).toThrow('two codes for status 400');
  });
});

describe('OpenAPI builder publication rules (task 163, D-144)', () => {
  it('is deterministic — two calls return deep-equal documents', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument());
  });

  it('documents a defaulted property as optional (the validator materializes it)', () => {
    // The wire truth for `maxPoints`: the TypeBox `required` list names it,
    // but the validator runs with `useDefaults: true`, so omitting it is
    // legal (pinned end-to-end by api-history.spec.ts's default-budget
    // test). The builder's rule mirrors that truth; the drift guard's
    // `documentedEquivalent` mirrors the same rule against the live schema,
    // so the pair is checked against each other on every `make check`.
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const history = document.paths['/api/history']?.get as {
      parameters: Array<Record<string, unknown>>;
    };
    const maxPoints = history.parameters.find((parameter) => parameter.name === 'maxPoints');
    expect(maxPoints).toMatchObject({ in: 'query', required: false });
  });

  it('carries the §15.3 mutation header on exactly the state-changing methods', () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const mutating: Array<[string, string]> = [
      ['post', '/api/accounts'],
      ['patch', '/api/accounts/{id}'],
      ['delete', '/api/accounts/{id}'],
      ['post', '/api/accounts/{id}/test'],
      ['put', '/api/settings'],
    ];
    for (const [method, path] of mutating) {
      const operation = document.paths[path]?.[method] as { parameters?: unknown[] } | undefined;
      expect(
        operation?.parameters?.some(
          (parameter) => (parameter as Record<string, unknown>).name === API_MUTATION_HEADER_NAME,
        ),
        `${method} ${path} must document the mutation header`,
      ).toBe(true);
    }
    const safe: Array<[string, string]> = [
      ['get', '/api/health'],
      ['get', '/api/history'],
    ];
    for (const [method, path] of safe) {
      const operation = document.paths[path]?.[method] as { parameters?: unknown[] } | undefined;
      expect(
        operation?.parameters?.some(
          (parameter) => (parameter as Record<string, unknown>).in === 'header',
        ) ?? false,
        `${method} ${path} must not document header parameters`,
      ).toBe(false);
    }
  });
});
