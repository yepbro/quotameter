/**
 * The D-128 strict request-validator construction (task 160; decision
 * D-128, extracted).
 *
 * Fastify's shared Ajv carries `removeAdditional: true`, which silently
 * strips unknown fields — a request body smuggling an extra field would
 * be accepted with the smuggled key ignored. §13's boundary rejects it:
 * unknown/malformed payloads answer the VALIDATION envelope. This factory
 * turns the stripping default off while re-asserting the framework's
 * remaining defaults — `coerceTypes: 'array'` keeps the query coercions
 * (`?purgeHistory=true`, numeric strings), `useDefaults`/`allErrors`
 * keep fastify's behavior — so the only change is that closed objects
 * are enforced instead of trimmed.
 *
 * Scope-local installation is the point (D-128): each endpoint plugin
 * calls `fastify.setValidatorCompiler(strictValidatorCompiler())` inside
 * its own encapsulated scope, so the rest of the API keeps the framework
 * default until a construction-level decision changes it for everyone.
 * Task 159's `./accounts.ts` carries its own construction with the full
 * rationale (frozen file history — it joins this single site at its next
 * owning change); `./status.ts` and `./settings.ts` consume this one, so
 * the new surface shares a single construction site from the start.
 */

import type { ValidateFunction } from 'ajv/dist/2020';
import Ajv2020 from 'ajv/dist/2020.js';

/**
 * Builds the strict, scope-local request validator (see the module
 * docblock). The import form is load-bearing: `ajv/dist/2020.js` WITH the
 * extension — Node ESM rejects the extensionless form the package's
 * export map offers beside it.
 */
export function strictValidatorCompiler(): (definition: {
  readonly schema: object;
}) => ValidateFunction {
  const validator = new Ajv2020({
    removeAdditional: false,
    coerceTypes: 'array',
    useDefaults: true,
    allErrors: true,
    addUsedSchema: false,
  });
  return (definition) => validator.compile(definition.schema);
}
