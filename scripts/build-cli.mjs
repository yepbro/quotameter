#!/usr/bin/env node
/**
 * CLI packaging build (task 185, spec §3, §5.1, §17.2; decision D-195).
 *
 * Compiles `src/` into `dist/` as real Node ESM so the installed
 * `quotameter` command resolves without a source checkout and without an
 * install-time build: `tsc` emits type-erased JavaScript through
 * `tsconfig.build.json`, then this script normalizes the emitted specifiers
 * to the forms plain Node ESM requires. The emitted graph mirrors `src/`
 * one-to-one — same files, same dynamic-import edges — so every landed
 * laziness and confinement pin (the `node:sqlite` storage gate, the lazy
 * server import behind `quotameter run`) holds in the shipped artifact by
 * construction; runtime dependencies stay external (npm installs them from
 * the manifest, the D-194 dependency audit keeps proving minimality).
 *
 * Why the normalization pass exists: `src/` deliberately uses the project's
 * extensionless bundler-resolution style (moduleResolution "bundler", jiti
 * in development and tests), which `tsc` preserves verbatim — but plain
 * Node ESM rejects extensionless relative specifiers (`./commands`) and
 * relative directory imports (`../providers/zai-coding-plan`), and jiti
 * additionally resolves extensionless deep bare imports (`ajv/dist/2020`)
 * that real Node ESM refuses. The pass therefore (1) rewrites extensionless
 * relative specifiers to `.js`, (2) rewrites relative directory imports to
 * `/index.js`, and (3) fails closed on any extensionless deep bare import —
 * the class that would otherwise build clean and crash only inside a clean
 * install. Rewrites are planned with TypeScript's own parser over the
 * emitted JavaScript (AST positions, never regexes), so prose strings
 * containing `from './x'` cannot be corrupted.
 *
 * Output goes to `dist/` by default (gitignored, excluded from lint and
 * format); `CLI_DIST_DIR` redirects it (the test suites build into temp
 * fixture roots). The build is wired into every context that packs or
 * verifies: CI's build and package jobs, the release workflow (before
 * `verify:build`, `check:package`, and publish — pinned by
 * test/unit/release-workflow.spec.ts), and `make build`.
 *
 * The pure seams (`mapRelativeSpecifier`, `isDeepBareImport`,
 * `planSpecifierEdits`, `applyEdits`) are exported for
 * test/unit/build-cli-script.spec.ts (the check-package.mjs pattern); their
 * type surface lives in `build-cli.d.mts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** File extensions Node ESM loads from a plain path without export mapping. */
const PLAIN_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node'];

/**
 * Maps one relative specifier of an emitted module to the exact form plain
 * Node ESM resolves, or returns undefined when nothing emitted matches.
 * `resolveSibling(candidate)` answers whether the emitted tree contains the
 * file the candidate names — bundler resolution's two fallbacks
 * (`spec + '.js'`, `spec + '/index.js'`) probed against reality.
 */
export function mapRelativeSpecifier(specifier, resolveSibling) {
  if (specifier.endsWith('.js')) return specifier;
  const asFile = `${specifier}.js`;
  if (resolveSibling(asFile) === true) return asFile;
  const asIndex = `${specifier}/index.js`;
  if (resolveSibling(asIndex) === true) return asIndex;
  return undefined;
}

/**
 * True for bare specifiers that plain Node ESM resolves only when they name
 * a real file: a path beyond the package name (or scope) without a plain
 * file extension. `node:` builtins are exempt (extensionless by design).
 * This is exactly the class jiti resolves through CJS extension guessing
 * and real Node ESM refuses (`ajv/dist/2020` — verified live on the pinned
 * runtime); importing the exact file path is the fix.
 */
export function isDeepBareImport(specifier) {
  if (specifier.startsWith('node:')) return false; // builtins are valid extensionless
  if (!/^[a-z@]/i.test(specifier)) return false;
  if (PLAIN_FILE_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return false;
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.length > 2 : segments.length > 1;
}

/**
 * Plans every specifier rewrite one emitted module needs, walking the
 * emitted JavaScript with TypeScript's parser. Relative specifiers are
 * mapped through {@link mapRelativeSpecifier}; extensionless deep bare
 * imports are reported; both defect classes land in `problems` and the
 * caller fails the build. String literals whose parent is not an import
 * form (prose like "got from './x'") are structurally invisible — the
 * precision regexes cannot offer. Type-only imports are already erased by
 * `tsc` and never reach this pass.
 */
export function planSpecifierEdits(code, resolveSibling) {
  const sourceFile = ts.createSourceFile('emitted.js', code, ts.ScriptTarget.ES2023, true);
  /** @type {Array<{start: number, end: number, text: string}>} */
  const edits = [];
  const problems = [];

  const plan = (node) => {
    const specifier = node.text;
    if (specifier.startsWith('.')) {
      const mapped = mapRelativeSpecifier(specifier, resolveSibling);
      if (mapped === undefined) {
        problems.push(`unresolvable relative specifier '${specifier}' — no emitted module matches`);
      } else if (mapped !== specifier) {
        // `start` is null on StringLiteral nodes in this TypeScript line;
        // the literal's inner text spans [end - 1 - length, end - 1). The
        // span is verified against the raw code before use — an escaped
        // literal ('\u002e/x') makes the cooked text shorter than the raw,
        // and splicing at the derived offset would corrupt the module:
        // refuse instead (fail closed).
        const start = node.end - 1 - specifier.length;
        if (code.slice(start, node.end - 1) !== specifier) {
          problems.push(
            `specifier '${specifier}' uses escapes the planner cannot splice safely; ` +
              'write the module path without escapes',
          );
        } else {
          edits.push({ start, end: node.end - 1, text: mapped });
        }
      }
      return;
    }
    if (isDeepBareImport(specifier)) {
      problems.push(
        `extensionless deep import '${specifier}' — plain Node ESM cannot resolve it ` +
          '(jiti can); import the exact file path (…/x.js)',
      );
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) && node.parent !== undefined) {
      const parent = node.parent;
      const isImportForm =
        ts.isImportDeclaration(parent) ||
        (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
          parent.arguments[0] === node);
      if (isImportForm) plan(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { edits, problems };
}

/** Applies planned edits (ascending, offset-adjusted) — a pure splice. */
export function applyEdits(code, edits) {
  let out = code;
  let offset = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    out = out.slice(0, edit.start + offset) + edit.text + out.slice(edit.end + offset);
    offset += edit.text.length - (edit.end - edit.start);
  }
  return out;
}

/** Every emitted `.js` file under `dir`, recursively. */
function listEmittedFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listEmittedFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/**
 * Runs the packaging build. Emits into a clean outDir (a stale output tree
 * must never survive into a tarball), then normalizes and verifies every
 * emitted module. Exits non-zero with an actionable message on any defect.
 */
function main() {
  const outDir = resolve(process.env.CLI_DIST_DIR ?? 'dist');
  const tscJs = join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');

  // The build removes the outDir before emitting — refuse a value that
  // would take the repository (or any of its ancestors) with it (the
  // `CLI_DIST_DIR=.` typo class; vite's emptyOutDir guards the same way).
  const outToRoot = relative(outDir, ROOT);
  if (outToRoot === '' || (!outToRoot.startsWith('..') && !isAbsolute(outToRoot))) {
    console.error(
      `build:cli: CLI_DIST_DIR (${outDir}) must not be the repository or one of its ancestors`,
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(tscJs)) {
    console.error(
      'build:cli: typescript is not installed (node_modules/typescript missing) — run npm ci first',
    );
    process.exitCode = 1;
    return;
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Shell-free spawn of the pinned compiler; the CLI flag overrides the
  // config's outDir so CLI_DIST_DIR redirects the whole build.
  const compiled = spawnSync(
    process.execPath,
    [tscJs, '-p', 'tsconfig.build.json', '--outDir', outDir],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (compiled.error !== undefined || compiled.status !== 0) {
    console.error(`build:cli: tsc failed (status ${String(compiled.status)})`);
    console.error(compiled.stdout ?? '');
    console.error(compiled.stderr ?? '');
    process.exitCode = 1;
    return;
  }

  const emittedFiles = listEmittedFiles(outDir);
  const failures = [];
  let rewrites = 0;
  for (const file of emittedFiles) {
    const resolveSibling = (candidate) => existsSync(resolve(dirname(file), candidate));
    const code = readFileSync(file, 'utf8');
    const { edits, problems } = planSpecifierEdits(code, resolveSibling);
    if (problems.length > 0) {
      failures.push(`${file}: ${problems.join('; ')}`);
    } else if (edits.length > 0) {
      writeFileSync(file, applyEdits(code, edits));
      rewrites += edits.length;
    }
  }

  const entry = join(outDir, 'cli', 'main.js');
  if (emittedFiles.length === 0) failures.push(`tsc emitted nothing under ${outDir}`);
  if (!existsSync(entry)) failures.push(`missing compiled CLI entry: ${entry}`);

  if (failures.length > 0) {
    console.error(
      `build:cli: the compiled graph is not loadable by plain Node ESM:\n  ${failures.join('\n  ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const tscVersion = createTscVersion();
  console.log(
    `build:cli: ${emittedFiles.length} modules emitted to ${outDir} ` +
      `(${rewrites} specifiers normalized, typescript ${tscVersion})`,
  );
}

/** The installed compiler's version, for the build log. */
function createTscVersion() {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', 'typescript', 'package.json'), 'utf8'),
  );
  return String(pkg.version);
}

// CLI entry: the module is imported (and unit-tested) as a pure seam, so
// run main() only when executed directly (`node scripts/build-cli.mjs`).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
