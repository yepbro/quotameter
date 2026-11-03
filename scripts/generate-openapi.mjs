#!/usr/bin/env node
/**
 * OpenAPI publication generator (spec §13, §18; task 163, D-144).
 *
 * Serializes the API description built by `scripts/openapi-document.mjs`
 * into `docs/openapi.json` — the committed artifact §18's "Generated
 * OpenAPI documentation" names. The document is derived from the TypeBox
 * contracts the routes validate through, plus the literal route inventory;
 * `test/unit/openapi-published.spec.ts` fails when the committed file
 * drifts from the builder or from the real route table, so regeneration
 * cannot be forgotten.
 *
 * Output directory: `OPENAPI_DIR` when set, otherwise `docs` (repository
 * root — the host-friendly default). The development container sets
 * `OPENAPI_DIR` to a path inside its data volume (see compose.yaml and
 * docs/agents/environment.md): the container runs as uid 1000 and must not
 * write into the bind-mounted repository tree. `make openapi` generates
 * into the volume and streams the file back, so the repository copy is
 * always written by a host-side process — the `make schema` pattern.
 *
 * The artifact is formatted with the repository's Prettier configuration —
 * the one `npm run format:check` enforces on the committed file — resolved
 * through the file's repository-relative path (never the output path: when
 * OPENAPI_DIR points into the container's data volume, no config is
 * findable there, and the bytes would differ between host and container
 * runs). Deterministic serialization: insertion-order keys, Prettier's
 * JSON layout, a single trailing newline — regeneration never churns the
 * diff.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { buildOpenApiDocument } from './openapi-document.mjs';

const outDir = process.env.OPENAPI_DIR ?? 'docs';
const outPath = join(outDir, 'openapi.json');

const document = buildOpenApiDocument();
const prettierOptions = (await resolveConfig('docs/openapi.json')) ?? {};
const json = `${await format(`${JSON.stringify(document, null, 2)}\n`, {
  ...prettierOptions,
  parser: 'json',
})}`;

await mkdir(outDir, { recursive: true });
await writeFile(outPath, json, 'utf8');

console.log(`wrote ${outPath} (${Buffer.byteLength(json, 'utf8')} bytes)`);
