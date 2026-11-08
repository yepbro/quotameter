import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The no-install-time-build contract's dependency side (task 186, decision
 * D-196; spec §3, §17.2).
 *
 * The manifest side — the root package's own lifecycle-script ban — is
 * pinned in test/unit/package-manifest.spec.ts. This spec pins what
 * `npm install quotameter` executes on the CONSUMER's machine: the
 * production dependency closure must be pure JavaScript, so the install is
 * a file copy that needs no toolchain. CI proves the same end to end on
 * stock compiler-free distro images (the install job's toolchain-absence
 * and installed-tree steps, guarded by test/unit/ci-workflow.spec.ts).
 *
 * Two layers, both fail loudly with the remedy:
 *  - the LOCKFILE layer: no package in the closure may carry npm's own
 *    `hasInstallScript` flag — the flag npm computes for exactly the
 *    scripts that run when a dependency installs (preinstall/install/
 *    postinstall, node-gyp recipes included). It catches a native or
 *    script-carrying dependency at lockfile-update time, before any
 *    install runs;
 *  - the INSTALLED-TREE layer: no `binding.gyp` recipe, no `*.node`
 *    binary, and no preinstall/install/postinstall key in any closure
 *    package on disk — independent of npm's flag semantics, so a future
 *    npm that changes what `hasInstallScript` records cannot silently
 *    weaken the audit.
 *
 * These layers pin the LOCKFILE SNAPSHOT. A consumer's `npm install` of
 * the published tarball re-resolves the dependency ranges against the
 * live registry (a lockfile does not travel with a tarball), so a later
 * release of an allowed dependency can differ from the snapshot — CI
 * closes that gap per run by scanning EVERY package.json npm actually
 * laid down in the install matrix's container (the installed-tree step
 * in ci.yml), and the compiler-free container means nothing that slips
 * through could compile anyway (D-196's defense in depth).
 *
 * `prepare` is deliberately NOT banned for dependencies: 16 packages in
 * the closure (luxon, cookie, glob, minimatch, …) carry prepare-only dev
 * stubs, and npm does not execute a dependency's `prepare` when installing
 * from registry tarballs — only preinstall/install/postinstall run for
 * dependencies (verified live in the compiler-free container: the
 * `--foreground-scripts` install of the packed tarball shows zero script
 * activity). The compiler-free container is the defense in depth: even a
 * semantics change could not turn those stubs into a compilation.
 *
 * A future dependency that legitimately needs an install script or ships
 * prebuilt natives requires a successor decision to D-196 — the pin is
 * strict on purpose (spec §3: minimal runtime dependencies, no native
 * modules).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The lockfile shapes the closure walk reads (lockfileVersion 3). */
interface LockPackage {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  hasInstallScript?: boolean;
}

interface Lockfile {
  packages: Record<string, LockPackage | undefined>;
}

/**
 * npm-style resolution of a dependency name against the parent chain: the
 * parent's own `node_modules/<name>` first, then each ancestor, then the
 * root — lockfile keys are the real `node_modules` paths after `npm ci`, so
 * the resolved key is both the lockfile entry and the on-disk directory.
 */
function resolveLockKey(
  packages: Record<string, LockPackage | undefined>,
  name: string,
  fromKey: string,
): string | undefined {
  let dir = fromKey;
  for (;;) {
    const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (dir === '') return undefined;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut === -1 ? '' : dir.slice(0, cut);
  }
}

/**
 * The production dependency closure as lockfile keys: a breadth-first walk
 * from the root manifest's declared runtime dependencies through every
 * transitive edge npm would follow on a consumer install — `dependencies`,
 * `optionalDependencies`, and the required `peerDependencies` npm 7+
 * auto-installs (optional peers are skipped, matching npm); the root's own
 * optionalDependencies seed the walk too. Lockfile keys are the real
 * `node_modules` paths after `npm ci`, so each key is both the lockfile
 * entry and the on-disk directory.
 */
function prodClosureKeys(): string[] {
  const lock = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
  ) as Lockfile;
  const packages = lock.packages;
  if (packages === undefined || typeof packages !== 'object') {
    throw new Error('package-lock.json has no packages map (lockfileVersion 3 required)');
  }
  const root = packages[''];
  if (root?.dependencies === undefined) {
    throw new Error('package-lock.json root entry declares no dependencies');
  }

  /** Required peers only: npm skips peers marked optional in peerDependenciesMeta. */
  const requiredPeersOf = (entry: LockPackage): string[] =>
    Object.keys(entry.peerDependencies ?? {}).filter(
      (peer) => entry.peerDependenciesMeta?.[peer]?.optional !== true,
    );

  const seen = new Set<string>();
  const queue: Array<[name: string, fromKey: string]> = [
    ...Object.keys(root.dependencies),
    ...Object.keys(root.optionalDependencies ?? {}),
  ].map((name) => [name, ''] as const);
  while (queue.length > 0) {
    const [name, fromKey] = queue.shift()!;
    const key = resolveLockKey(packages, name, fromKey);
    if (key === undefined) {
      throw new Error(
        `package-lock.json cannot resolve ${name} (requested from ${fromKey || 'the root'}) — ` +
          'the lockfile is inconsistent with itself; regenerate it with npm install',
      );
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key];
    if (entry === undefined) continue;
    for (const dep of [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...requiredPeersOf(entry),
    ]) {
      queue.push([dep, key]);
    }
  }
  return [...seen];
}

/**
 * The scripts npm actually executes when a dependency installs from a
 * registry tarball. `prepare`/`prepublish` are excluded by npm semantics
 * (see the module docblock); the root package's own ban is the stricter
 * five-key set in package-manifest.spec.ts.
 */
const DEPENDENCY_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** Every file under `dir` ending in `.node` (native addon binaries). */
function nativeAddonBinaries(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...nativeAddonBinaries(full));
    } else if (entry.name.endsWith('.node')) {
      found.push(full);
    }
  }
  return found;
}

describe('no install-time build: the production dependency closure (task 186, D-196)', () => {
  it('is free of install scripts in the lockfile (npm hasInstallScript)', () => {
    const lock = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as Lockfile;
    const offenders = prodClosureKeys().filter(
      (key) => lock.packages[key]?.hasInstallScript === true,
    );
    expect(
      offenders,
      'these production dependencies declare install scripts (npm hasInstallScript) — they ' +
        'would execute on every consumer install and can compile (node-gyp). Spec §3 forbids ' +
        'native modules and install-time builds; replace the dependency with a pure-JS one or ' +
        'record a successor decision to D-196',
    ).toEqual([]);
  });

  it('contains no native addons or install scripts in the installed tree', () => {
    const missing: string[] = [];
    const scripted: string[] = [];
    const recipes: string[] = [];
    const binaries: string[] = [];
    for (const key of prodClosureKeys()) {
      const dir = path.join(REPO_ROOT, key);
      if (!existsSync(dir)) {
        missing.push(key);
        continue;
      }
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      scripted.push(
        ...DEPENDENCY_LIFECYCLE_SCRIPTS.filter(
          (script) => pkg.scripts !== undefined && script in pkg.scripts,
        ).map((script) => `${key}: ${script}`),
      );
      if (existsSync(path.join(dir, 'binding.gyp'))) {
        recipes.push(`${key}/binding.gyp`);
      }
      binaries.push(...nativeAddonBinaries(dir));
    }
    expect(
      missing,
      'these production dependencies are absent from node_modules — the tree is out of sync ' +
        'with the lockfile (run make deps / npm ci); the audit reads exactly what a consumer ' +
        'install would lay down',
    ).toEqual([]);
    expect(
      scripted,
      'these production dependencies carry preinstall/install/postinstall scripts, which npm ' +
        'executes on every consumer install — spec §3 forbids install-time builds; replace ' +
        'the dependency or record a successor decision to D-196',
    ).toEqual([]);
    expect(
      recipes,
      'these node-gyp recipes would trigger native compilation on install (spec §3 forbids ' +
        'native modules); replace the dependency or record a successor decision to D-196',
    ).toEqual([]);
    expect(
      binaries.map((file) => path.relative(REPO_ROOT, file)),
      'these prebuilt native addon binaries make the package platform-specific and executable-' +
        'only (spec §3: support x64 and arm64 without compilation — pure JS needs neither); ' +
        'replace the dependency or record a successor decision to D-196',
    ).toEqual([]);
  });
});
