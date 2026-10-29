#!/usr/bin/env node
/**
 * JSON Schema publication generator (spec §6.2, §18; task 062, D-015).
 *
 * Serializes the canonical configuration contract — `CONFIG_SCHEMA_DOCUMENT`
 * in `src/schemas/config.ts` — into `config.schema.json`. The committed file
 * under `schema/` is the published artifact; rerun this script after the
 * contract changes. `test/unit/config-schema-published.spec.ts` fails when
 * the committed file drifts from the contract, so regeneration cannot be
 * forgotten.
 *
 * Output directory: `SCHEMA_DIR` when set, otherwise `schema` (repository
 * root — the host-friendly default). The development container sets
 * `SCHEMA_DIR` to a path inside its data volume (see compose.yaml and
 * docs/agents/environment.md): the container runs as uid 1000 and must not
 * write into the bind-mounted repository tree. `make schema` generates into
 * the volume and streams the file back, so the repository copy is always
 * written by a host-side process.
 *
 * TypeScript is loaded through `jiti` (an existing devDependency) because
 * plain Node on the minimum runtime (22.13.0) cannot import `.ts` modules
 * without the experimental type-stripping flag.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { format, resolveConfig } from 'prettier';

const jiti = createJiti(import.meta.url);
const { CONFIG_SCHEMA_DOCUMENT } = await jiti.import('../src/schemas/config.ts');

const outDir = process.env.SCHEMA_DIR ?? 'schema';
const outPath = join(outDir, 'config.schema.json');

// The artifact is formatted with the repository's Prettier configuration —
// the one `npm run format:check` enforces on the committed file — resolved
// through the file's repository-relative path (never the output path: when
// SCHEMA_DIR points into the container's data volume, no config is findable
// there, and the bytes would differ between host and container runs).
// Programmatic format() calls do not read config files on their own.
const prettierOptions = (await resolveConfig('schema/config.schema.json')) ?? {};

// Deterministic serialization: insertion-order keys, Prettier's JSON layout,
// and a single trailing newline. Given the same contract and Prettier
// version, regeneration reproduces byte-identical output — it never churns
// the diff.
const json = `${await format(`${JSON.stringify(CONFIG_SCHEMA_DOCUMENT, null, 2)}\n`, {
  ...prettierOptions,
  parser: 'json',
})}`;

await mkdir(outDir, { recursive: true });
await writeFile(outPath, json, 'utf8');

console.log(`wrote ${outPath} (${Buffer.byteLength(json, 'utf8')} bytes)`);
