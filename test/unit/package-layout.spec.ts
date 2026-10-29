import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Executable layout contract (task 059).
 *
 * Enforces the module map and dependency rules documented in
 * docs/architecture/package-layout.md: every relative import in `src/`, `ui/`,
 * and `bin/` is resolved and checked against the layer table (including
 * adapter isolation and the node:sqlite storage gate), so a forbidden
 * dependency fails `make check` instead of surviving until review. Follows the
 * project's "lint contracts are executable" pattern (see
 * test/unit/vue-template-lint.spec.ts).
 *
 * Import extraction uses bounded regexes instead of a TypeScript AST parse on
 * purpose: the test stays fast and dependency-free. The patterns rely on
 * semicolon-terminated statements, which `make check` guarantees by running
 * the Prettier format check before the test suite.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');
const UI = path.join(REPO_ROOT, 'ui');
const BIN = path.join(REPO_ROOT, 'bin');

/** Extensions treated as source in layer scans (a stray .js cannot escape). */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

/** The src/ layers and what each may import besides itself. */
type Layer =
  | 'schemas'
  | 'util'
  | 'config'
  | 'providers:core'
  | 'providers:adapter'
  | 'storage'
  | 'services'
  | 'server'
  | 'cli';

const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  schemas: [],
  util: [],
  config: ['schemas', 'util'],
  'providers:core': ['schemas', 'util'],
  'providers:adapter': ['schemas', 'util', 'providers:core'],
  storage: ['schemas', 'util'],
  services: ['schemas', 'util', 'config', 'providers:core', 'storage'],
  server: [
    'schemas',
    'util',
    'config',
    'providers:core',
    'providers:adapter',
    'storage',
    'services',
  ],
  cli: ['schemas', 'util', 'config', 'providers:core', 'storage', 'services', 'server'],
};

const LAYER_DIRS = [
  'cli',
  'config',
  'providers',
  'schemas',
  'server',
  'services',
  'storage',
  'util',
];

function listFiles(
  dir: string,
  extensions: readonly string[],
  skipDirs: readonly string[],
): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      files.push(...listFiles(full, extensions, skipDirs));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function layerOf(srcFile: string): Layer {
  const rel = path.relative(SRC, srcFile);
  const [head, ...rest] = rel.split(path.sep);
  switch (head) {
    case 'schemas':
      return 'schemas';
    case 'util':
      return 'util';
    case 'config':
      return 'config';
    case 'storage':
      return 'storage';
    case 'services':
      return 'services';
    case 'server':
      return 'server';
    case 'cli':
      return 'cli';
    case 'providers':
      // Files directly in src/providers/ are the shared core; anything in a
      // subdirectory belongs to one adapter.
      return rest.length > 1 ? 'providers:adapter' : 'providers:core';
    default:
      throw new Error(`unknown layer for ${rel}: src modules must live in a layer directory`);
  }
}

/** The adapter id: the directory name directly below src/providers/. */
function adapterIdOf(srcFile: string): string {
  const segments = path.relative(SRC, srcFile).split(path.sep);
  return segments[1] ?? '';
}

/** True when the code imports the built-in SQLite module in any form. */
function importsNodeSqlite(code: string): boolean {
  return (
    /(?:^|[;\n])import\s*['"]node:sqlite['"]/.test(code) ||
    /from\s*['"]node:sqlite['"]/.test(code) ||
    /import\s*\(\s*['"]node:sqlite['"]\s*\)/.test(code)
  );
}

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/**
 * Extracts relative import references from TypeScript/Vue/JavaScript source.
 *
 * The character class stops at quotes and semicolons, so a match cannot cross
 * statement boundaries in this semicolon-terminated codebase; it still spans
 * prettier-wrapped multi-line import lists.
 */
function extractRelativeImports(code: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const fromRe = /(?:^|[;\n])(?:import|export)\s+(type\s+)?[^'";]*?from\s*['"](\.[^'"]+)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    refs.push({ specifier: match[2] ?? '', typeOnly: match[1] !== undefined });
  }
  const sideEffectRe = /(?:^|[;\n])import\s*['"](\.[^'"]+)['"]/g;
  for (const match of code.matchAll(sideEffectRe)) {
    refs.push({ specifier: match[1] ?? '', typeOnly: false });
  }
  const dynamicRe = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    refs.push({ specifier: match[1] ?? '', typeOnly: false });
  }
  return refs;
}

/** Resolves a relative specifier the way the bundler-style configs do. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function isWithin(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('package layout contract', () => {
  it('every src layer directory exists with its README', () => {
    const missing = LAYER_DIRS.filter((dir) => !existsSync(path.join(SRC, dir, 'README.md')));
    expect(missing, `layer directories missing their README: ${missing.join(', ')}`).toEqual([]);
  });

  it('no loose modules directly in src/', () => {
    const loose = readdirSync(SRC).filter((name) =>
      SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)),
    );
    expect(loose, 'files in src/ must live in a layer directory (see package-layout.md)').toEqual(
      [],
    );
  });

  it('src imports follow the layer rules', () => {
    const violations: string[] = [];
    for (const file of listFiles(SRC, SOURCE_EXTENSIONS, [])) {
      const layer = layerOf(file);
      const code = readFileSync(file, 'utf8');
      // Spec §3: all database access is isolated behind the storage module.
      if (importsNodeSqlite(code) && layer !== 'storage') {
        violations.push(
          `${path.relative(REPO_ROOT, file)} (${layer}): node:sqlite may be imported ` +
            `only inside src/storage/`,
        );
      }
      for (const ref of extractRelativeImports(code)) {
        const resolved = resolveSpecifier(file, ref.specifier);
        if (resolved === null) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: unresolved import '${ref.specifier}'`,
          );
          continue;
        }
        if (!isWithin(SRC, resolved)) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: import '${ref.specifier}' leaves src/`,
          );
          continue;
        }
        const target = layerOf(resolved);
        // Adapters are islands (spec §8.1): the same-layer exemption must not
        // let one provider adapter reach into a sibling adapter.
        if (
          layer === 'providers:adapter' &&
          target === 'providers:adapter' &&
          adapterIdOf(file) !== adapterIdOf(resolved)
        ) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: adapter '${adapterIdOf(file)}' imports ` +
              `sibling adapter '${adapterIdOf(resolved)}' via '${ref.specifier}'`,
          );
          continue;
        }
        if (target !== layer && !MAY_IMPORT[layer].includes(target)) {
          violations.push(
            `${path.relative(REPO_ROOT, file)} (${layer}): forbidden import ` +
              `'${ref.specifier}' (${target}); allowed: ${MAY_IMPORT[layer].join(', ') || '(own layer only)'}`,
          );
        }
      }
    }
    expect(
      violations.sort(),
      'dependency violations (see docs/architecture/package-layout.md)',
    ).toEqual([]);
  });

  it('ui only imports src schemas, and only as types', () => {
    const violations: string[] = [];
    const files = listFiles(UI, ['.ts', '.tsx', '.js', '.vue'], ['dist', 'node_modules']);
    for (const file of files) {
      for (const ref of extractRelativeImports(readFileSync(file, 'utf8'))) {
        const resolved = resolveSpecifier(file, ref.specifier);
        if (resolved === null) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: unresolved import '${ref.specifier}'`,
          );
          continue;
        }
        if (isWithin(UI, resolved)) continue;
        const inSchemas = isWithin(path.join(SRC, 'schemas'), resolved);
        if (!(inSchemas && ref.typeOnly)) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: '${ref.specifier}' — ui may import ` +
              `src/schemas/** only via type-only imports`,
          );
        }
      }
    }
    expect(violations.sort(), 'runtime imports from ui into server code are forbidden').toEqual([]);
  });

  it('bin scripts import only the cli layer', () => {
    const violations: string[] = [];
    for (const file of listFiles(BIN, ['.mjs', '.js', '.cjs'], [])) {
      for (const ref of extractRelativeImports(readFileSync(file, 'utf8'))) {
        const resolved = resolveSpecifier(file, ref.specifier);
        if (resolved === null) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: unresolved import '${ref.specifier}'`,
          );
          continue;
        }
        if (!isWithin(path.join(SRC, 'cli'), resolved)) {
          violations.push(
            `${path.relative(REPO_ROOT, file)}: bin may import src/cli/** only, ` +
              `not '${ref.specifier}'`,
          );
        }
      }
    }
    expect(
      violations.sort(),
      'bin/ is a thin launcher over src/cli (see package-layout.md)',
    ).toEqual([]);
  });
});
