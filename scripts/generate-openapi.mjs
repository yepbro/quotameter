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
 * docs/agents/environment.md): generated output goes to the data volume,
 * not the bind-mounted repository tree, and `make openapi` generates into
 * the volume and streams the file back, so the repository copy changes
 * through one deliberate host-side step — the `make schema` pattern.
 *
 * The artifact is formatted with the repository's Prettier configuration —
 * the one `npm run format:check` enforces on the committed file — resolved
 * through the file's repository-relative path (never the output path: when
 * OPENAPI_DIR points into the container's data volume, no config is
 * findable there, and the bytes would differ between host and container
 * runs). Deterministic serialization: insertion-order keys, Prettier's
 * JSON layout, a single trailing newline — regeneration never churns the
 * diff.
 *
 * The serialization is exported as `serializeOpenApiDocument` (typed for
 * consumers by `scripts/generate-openapi.d.mts`) so the drift guard's
 * byte-freshness arm (task 192, D-202) runs the exact pipeline this writer
 * runs — one implementation, two consumers — instead of mirroring it. The
 * file write stays CLI-only (`check-package.mjs`'s invoked-directly
 * pattern): importing the serializer never touches the filesystem beyond
 * Prettier's config resolution.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildOpenApiDocument } from './openapi-document.mjs';

/**
 * Serializes an OpenAPI document exactly as the committed artifact is
 * written: Prettier's JSON layout under the repository's configuration,
 * resolved through the artifact's own repository location — anchored to
 * this module (`../docs/openapi.json`), never the output path and never
 * the process working directory, so the writer and the drift guard's byte
 * arm agree byte-for-byte regardless of where either is invoked from —
 * over two-space `JSON.stringify`, with a single trailing newline.
 */
export async function serializeOpenApiDocument(document) {
  const artifactPath = fileURLToPath(new URL('../docs/openapi.json', import.meta.url));
  const prettierOptions = (await resolveConfig(artifactPath)) ?? {};
  return format(`${JSON.stringify(document, null, 2)}\n`, {
    ...prettierOptions,
    parser: 'json',
  });
}

async function main() {
  const outDir = process.env.OPENAPI_DIR ?? 'docs';
  const outPath = join(outDir, 'openapi.json');

  const json = await serializeOpenApiDocument(buildOpenApiDocument());

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, json, 'utf8');

  console.log(`wrote ${outPath} (${Buffer.byteLength(json, 'utf8')} bytes)`);
}

// CLI entry: the module is imported (and unit-tested) as a pure seam, so
// run main() only when executed directly (`node scripts/generate-openapi.mjs`).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
