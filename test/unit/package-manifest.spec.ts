import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_EXACT, ALLOWED_PREFIXES, REQUIRED_ENTRIES } from '../../scripts/check-package.mjs';

/**
 * The npm package manifest's own contract (task 184, decision D-194; spec
 * §3, §4.2, §4.4, §5.1).
 *
 * The manifest is data, but its invariants are executable, and this spec is
 * the pin: name, version, engines, bin, the deliberate absence of a library
 * entry point, the private marker, the provenance metadata, the `files`
 * allowlist's agreement with `scripts/check-package.mjs` (the exported
 * constants there — extending either side alone fails here), and the
 * production-dependency audit against the code the shipped CLI resolves to.
 *
 * Boundary (D-194, executed by task 185/D-195): the compiled server graph
 * ships as `dist/` (tsc-emitted ESM from this same `src/` tree), packed
 * under the `dist/` allowlist prefix. The dependency audit scans
 * `src/` + `bin/` — the shipped graph is emitted from exactly that code
 * with specifier strings preserved, so the audit remains its faithful
 * proxy. The web UI's runtime libraries (vue, echarts, …) are deliberately
 * not audited: they stay devDependencies because the shipped artifact is
 * the prebuilt `ui/dist` bundle (spec §3: the frontend is built before
 * publication).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');
const BIN = path.join(REPO_ROOT, 'bin');

/** Extensions treated as source in the shipped-graph scan (layout-spec set). */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

interface Manifest {
  name: string;
  version: string;
  private: boolean;
  engines: { node: string };
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  author?: string;
  homepage?: string;
  bugs?: { url?: string };
  exports?: unknown;
  main?: unknown;
  repository?: { type?: unknown; url?: unknown };
}

const manifest: Manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** The dev image is pinned to the declared minimum runtime (spec §5.1, §20). */
function dockerfileNodeTag(): string {
  const match = /^FROM node:(\d+\.\d+\.\d+)-/m.exec(
    readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8'),
  );
  if (!match) throw new Error('Dockerfile: no pinned node:<version> base image found');
  return match[1] ?? '';
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Bare (package) specifiers imported by a module: static `from`, side-effect,
 * dynamic, and CommonJS `require` forms, anchored like the layout spec's
 * extractor so prose in template literals (`got from 'x'`) cannot masquerade
 * as an import. Relative specifiers, `node:` builtins, and non-package
 * shapes (`${…}`) are skipped; digit-leading names (7zip-bin-style legacy
 * packages) are admitted.
 */
function extractBareImports(code: string): Set<string> {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|[;\n])(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\n])import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] ?? '';
      if (/^[@a-z0-9]/i.test(specifier) && !specifier.startsWith('node:')) {
        specifiers.add(specifier);
      }
    }
  }
  return specifiers;
}

/** The installable package a specifier roots to: `@scope/name` keeps two segments. */
function rootPackageOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

/** True when a `files` entry (directory prefix or exact path) covers a packed path. */
function filesEntryCovers(entry: string, packedPath: string): boolean {
  return entry.endsWith('/') ? packedPath.startsWith(entry) : entry === packedPath;
}

/**
 * Basenames npm's pack walker force-includes from any directory it walks
 * (root README/LICENSE/NOTICE are wanted and listed; the trap is elsewhere).
 */
const FORCED_BASENAME_PATTERN = /^(readme|license|licence|copying|notice)([.-].*)?$/i;

/**
 * Directories that pack only part of their content: the parent of every
 * directory entry (`ui/dist/` → `ui`) and the directory of every exact file
 * entry (`schema/config.schema.json` → `schema` — verified: npm forces a
 * `schema/README.md` in, uncovered by `files`). Root-level entries yield
 * `.` and are skipped: the root's README/LICENSE/NOTICE are wanted.
 */
function partiallyPackedDirs(filesEntries: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const entry of filesEntries) {
    let current = path.posix.dirname(entry);
    while (current !== '.' && current !== '/') {
      dirs.add(current);
      current = path.posix.dirname(current);
    }
  }
  return dirs;
}

/** Bare package roots imported anywhere under src/ + bin/ (the shipped graph). */
function shippedGraphRoots(): Map<string, string[]> {
  const roots = new Map<string, string[]>();
  for (const file of [...listFiles(SRC, SOURCE_EXTENSIONS), ...listFiles(BIN, SOURCE_EXTENSIONS)]) {
    for (const specifier of extractBareImports(readFileSync(file, 'utf8'))) {
      const root = rootPackageOf(specifier);
      roots.set(root, [...(roots.get(root) ?? []), path.relative(REPO_ROOT, file)]);
    }
  }
  return roots;
}

describe('npm package manifest (task 184, D-194)', () => {
  it('declares the spec §4.2 package name and CLI command name', () => {
    expect(manifest.name).toBe('quotameter');
  });

  it('carries an exact semver version, and every non-placeholder number has a changelog section', () => {
    // Exact X.Y.Z only: prerelease/build suffixes would leak into the release
    // tag/version-match gates (docs/release.md, Tagging). `0.0.0` is the
    // deliberate pre-release placeholder (D-186): the release checklist's
    // version commit bumps it, so this pin must not freeze the literal.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (manifest.version !== '0.0.0') {
      const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
      expect(
        changelog.includes(`## [${manifest.version}]`),
        `CHANGELOG.md has no section for the released version ${manifest.version}`,
      ).toBe(true);
    }
  });

  it('declares engines.node in the exact >=X.Y.Z contract at the Dockerfile-pinned minimum', () => {
    // The exact shape is the manifest contract the runtime gates fail closed
    // on (bin/quotameter.mjs and scripts/verify-runtime.mjs, D-098); the
    // minimum must equal the dev image's pinned node tag. The CI sites are
    // pinned by test/unit/ci-workflow.spec.ts (PINNED_RUNTIMES' minimum
    // entry).
    expect(manifest.engines.node).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(manifest.engines.node).toBe(`>=${dockerfileNodeTag()}`);
  });

  it('maps the quotameter bin to the real shebang launcher entry', () => {
    expect(Object.keys(manifest.bin)).toEqual(['quotameter']);
    expect(manifest.bin.quotameter).toBe('bin/quotameter.mjs');
    const entry = path.join(REPO_ROOT, manifest.bin.quotameter ?? '');
    expect(existsSync(entry), 'bin/quotameter.mjs must exist').toBe(true);
    // npm symlinks the bin as-is; the shebang is what makes it executable.
    expect(readFileSync(entry, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('declares no library entry point (CLI-first package, D-194)', () => {
    // The bin is the only consumer surface; with no `exports` map, deep
    // imports like the published schema/config.schema.json (D-015) keep
    // working. Adding an API is a successor decision to D-194.
    expect(
      manifest.exports,
      'manifest must not declare `exports` without a successor decision',
    ).toBeUndefined();
    expect(
      manifest.main,
      'manifest must not declare `main` without a successor decision',
    ).toBeUndefined();
  });

  it('stays private in-tree; only the release workflow removes the marker', () => {
    // docs/release.md (D-152): `npm pkg delete private` runs in the release
    // pipeline; in-tree it must stay so no local publish can ever succeed.
    expect(manifest.private).toBe(true);
  });

  it('declares no install-time lifecycle scripts (spec §3: no install-time build)', () => {
    // Spec §3: "Do not use `postinstall` scripts or native modules." The
    // ban is npm's complete install-time lifecycle set, not just
    // `postinstall`: `preinstall`/`install`/`postinstall` run when a
    // consumer installs the package; `prepare` (with its `preprepare`/
    // `postprepare` companions) and the deprecated `prepublish` run on
    // git-URL and local installs — an install-time build under any of
    // these names is still an install-time build. (`prepublishOnly` is
    // publish-time, owned by the release pipeline, not install-time.) The
    // dependency side of the contract (nothing in the production closure
    // may compile or run scripts either) is pinned by
    // test/unit/install-time-build.spec.ts; CI proves both on stock
    // compiler-free distro images (task 186, D-196).
    const banned = [
      'preinstall',
      'install',
      'postinstall',
      'preprepare',
      'prepare',
      'postprepare',
      'prepublish',
    ];
    const present = banned.filter((script) => script in (manifest.scripts ?? {}));
    expect(
      present,
      'spec §3 forbids install-time lifecycle scripts; adding one is a successor decision to D-196',
    ).toEqual([]);
  });

  it('declares the GitHub repository provenance publication requires', () => {
    // `npm publish --provenance` refuses to run without repository metadata
    // (docs/release.md's task-184 dependency note, satisfied here). The URL
    // is pinned exactly — a substring match would let a fork URL pass.
    expect(manifest.repository?.type).toBe('git');
    expect(manifest.repository?.url).toBe('git+https://github.com/yepbro/quotameter.git');
    // The npm-page metadata D-194 declares: the §4.3 attribution and the
    // standard link trio must not drift or disappear unnoticed.
    expect(manifest.author).toBe('Den Brooks <denis@yepbro.pro>');
    expect(manifest.bugs?.url).toBe('https://github.com/yepbro/quotameter/issues');
    expect(manifest.homepage).toBe('https://github.com/yepbro/quotameter#readme');
  });

  it('files allowlist and scripts/check-package.mjs agree exactly', () => {
    // package.json is auto-included by npm pack, never a `files` entry.
    const allowlistedPaths = ALLOWED_EXACT.filter((entry) => entry !== 'package.json');
    for (const entry of allowlistedPaths) {
      expect(
        existsSync(path.join(REPO_ROOT, entry)),
        `allowlisted ${entry} must exist on disk`,
      ).toBe(true);
      expect(
        manifest.files.some((filesEntry) => filesEntryCovers(filesEntry, entry)),
        `allowlisted ${entry} is not covered by any manifest files entry`,
      ).toBe(true);
    }
    for (const filesEntry of manifest.files) {
      const isPrefixEntry = ALLOWED_PREFIXES.includes(filesEntry);
      const coversAllowlisted = allowlistedPaths.some((entry) =>
        filesEntryCovers(filesEntry, entry),
      );
      expect(
        isPrefixEntry || coversAllowlisted,
        `manifest files entry ${filesEntry} packs files the tarball check would reject`,
      ).toBe(true);
    }
    // The reverse direction for prefixes: an allowlisted prefix that `files`
    // does not declare would let the release tarball silently omit the UI
    // (npm packs nothing for a missing entry) while every gate stays green —
    // the exact half-update the agreement pin exists to catch.
    for (const prefix of ALLOWED_PREFIXES) {
      expect(prefix.endsWith('/'), `allowlist prefix ${prefix} must end with '/'`).toBe(true);
      expect(
        manifest.files.includes(prefix),
        `allowlisted prefix ${prefix} is not declared in manifest files — the release tarball would silently omit it`,
      ).toBe(true);
    }
    expect(
      REQUIRED_ENTRIES.filter((entry) => !ALLOWED_EXACT.includes(entry)),
      'required tarball entries must be part of the allowlist',
    ).toEqual([]);
  });

  it('keeps npm-forced basenames out of partially-packed directories', () => {
    // npm's pack walker force-includes README (and license-family) files of
    // any directory it walks for a `files` entry — with or without a build
    // present (verified empirically on npm 11.9: `ui/README.md` packed both
    // from a tree without `ui/dist` and from one with the real build; a
    // scratch `schema/README.md` packs beside the exact-file entry) — and no
    // `files` spelling or `!` negation can exclude them. `ui/` and `schema/`
    // pack only part of their content, so they must hold no README basename —
    // the reason the UI doc is `ui/OVERVIEW.md` (D-194).
    const offenders: string[] = [];
    for (const dir of partiallyPackedDirs(manifest.files)) {
      for (const name of readdirSync(path.join(REPO_ROOT, dir))) {
        if (FORCED_BASENAME_PATTERN.test(name)) {
          offenders.push(`${dir}/${name}`);
        }
      }
    }
    expect(
      offenders.sort(),
      'npm would force these into the tarball with no way to exclude them; ' +
        'rename them (the ui/OVERVIEW.md precedent, D-194)',
    ).toEqual([]);
  });

  it('declares exactly the runtime dependencies the shipped graph imports', () => {
    const roots = shippedGraphRoots();
    const undeclared = [...roots.keys()].filter((root) => !(root in manifest.dependencies)).sort();
    expect(
      undeclared,
      'packages imported by src/ or bin/ but missing from dependencies — the published package would crash on import',
    ).toEqual([]);

    const unused = Object.keys(manifest.dependencies)
      .filter((dependency) => !roots.has(dependency))
      .sort();
    expect(
      unused,
      'declared runtime dependencies nothing in the shipped graph imports (D-194 audit)',
    ).toEqual([]);
  });
});
