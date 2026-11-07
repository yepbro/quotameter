import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pm from 'picomatch';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config';

/**
 * The coverage threshold guard (task U-015; spec §17.3; decisions D-085, D-089,
 * D-093).
 *
 * Task 125's review P3-1: a zero-match key in `vitest.config.ts`'s
 * `coverage.thresholds` passes silently. With `perFile: true` (every
 * critical-module key in this repo's config; the `ui/src/**` group key is
 * deliberately NOT per-file — it judges one aggregate, and an empty group
 * reports `Unknown` and passes the same way), the installed Vitest judges
 * exactly the matched files — an empty match set judges nothing, so renaming
 * a module family (`peak-hours*`) or an exact-path module without updating
 * the config leaves a dead 100% key enforcing nothing while `make check`
 * stays green. This spec
 * fails instead, the way `package-layout.spec.ts` enforces the layer rules:
 * the config is imported (same-process truth — no text parsing of a TypeScript
 * file), its threshold keys are matched against the real `src/` + `ui/src`
 * tree with the same matcher Vitest uses, and the §17.3 critical-module map
 * (D-085, widened by D-089/U-016 and D-188/U-060) is enumerated here so a
 * config regression that DROPS or NARROWS a key fails too.
 *
 * Matching semantics — verified against the installed Vitest 5.1.0
 * (`node_modules/vitest/dist/chunks/cli-api.COfZo8lK.js`, `resolveThresholds`;
 * the same semantics as the 5.0.5 chunk D-093 verified, re-read by U-060 for
 * the UI group key): every threshold key that is not a global option becomes
 * `picomatch(key)` with **default options**, matched against each coverage
 * file's path **relative to the config root** (repo-root-relative, forward
 * slashes) — exact paths are literal patterns, globs behave per picomatch
 * (`*` never crosses `/`). A key whose entry lacks `perFile` is judged as ONE
 * group over the aggregate of its matched files (`coverageMap.getCoverageSummary()`)
 * — the semantics the non-perFile `ui/src/**` aggregate key relies on (D-188).
 * The guard mirrors the matching call one-for-one through the same library;
 * the default-options positive control below pins the semantics the mirror
 * relies on.
 *
 * Deliberate limits: a single family member renamed OUT of the `peak-hours*`
 * glob leaves the family by name — no structural signal can distinguish a
 * rename from a removal, so only the emptied family (or the stale map entry)
 * fails; threshold VALUES (the D-089 branch maxima) are coverage policy, not
 * structure, and are out of scope. The rename behavior is demonstrated by the
 * scratch experiment recorded in the task's commit body, not asserted live.
 *
 * Single-instance premise (task U-027, U-024's review P3): the mirror holds
 * only while this spec's `import 'picomatch'` and the runner's own load resolve
 * the SAME instance — true today because the declared devDependency range
 * (`^4.0.7`) matches the installed vitest 5.1.0's own picomatch range, so npm
 * keeps one root copy. A future range divergence would nest a second copy
 * under `node_modules/vitest/node_modules/` and split the mirror silently
 * (the guard would judge keys with semantics the runner no longer applies).
 * The resolve-identity test below pins that premise executably, upgrading
 * U-024's prose resolution evidence to an assertion.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');
const UI_SRC = path.join(REPO_ROOT, 'ui/src');

/** The four global threshold axes of §17.3/D-085's aggregate layer. */
const GLOBAL_AXES = ['lines', 'branches', 'functions', 'statements'] as const;

/**
 * The keys `resolveThresholds` treats as global options, not file patterns:
 * `perFile`, `autoUpdate`, the `100` shorthand, and the THRESHOLD_KEYS quartet.
 * Everything else in the threshold map is a glob-or-exact file key.
 */
const GLOBAL_THRESHOLD_KEYS = new Set<string>([...GLOBAL_AXES, 'perFile', 'autoUpdate', '100']);

/**
 * The §17.3 critical modules as patterns (D-085's map plus D-089/U-016's and
 * D-188/U-060's widenings): time-zone logic, the peak-hours family,
 * sanitization, §15.4's secret-handling mechanisms, the
 * configuration-loading/transport set, the §15.2 auth/session/hashing
 * quartet, and the UI tree's aggregate gate. A pattern that matches nothing
 * means a critical module moved or disappeared — the map and the config
 * keys must be updated together.
 */
const CRITICAL_MODULE_MAP = [
  { pattern: 'src/util/clock.ts', why: 'time-zone logic (§10)' },
  { pattern: 'src/util/rolling-ranges.ts', why: 'time-zone logic (§10)' },
  { pattern: 'src/services/peak-hours*.ts', why: 'peak-hours family (§9.3)' },
  { pattern: 'src/providers/sanitize.ts', why: 'sanitization (§7.4)' },
  { pattern: 'src/util/logger.ts', why: 'secret-handling (§15.4)' },
  { pattern: 'src/config/permissions.ts', why: 'secret-handling (§15.4)' },
  { pattern: 'src/config/write.ts', why: 'secret-handling (§15.4)' },
  { pattern: 'src/providers/transport.ts', why: 'shared transport (D-089)' },
  { pattern: 'src/config/env.ts', why: 'configuration loading (D-089)' },
  { pattern: 'src/config/load.ts', why: 'configuration loading (D-089)' },
  { pattern: 'src/config/reload.ts', why: 'configuration loading (D-089)' },
  { pattern: 'src/services/password-hash.ts', why: 'auth/session/hashing (§15.2, D-188)' },
  { pattern: 'src/services/sessions.ts', why: 'auth/session/hashing (§15.2, D-188)' },
  { pattern: 'src/services/session-cookie.ts', why: 'auth/session/hashing (§15.2, D-188)' },
  { pattern: 'src/services/login-rate-limit.ts', why: 'auth/session/hashing (§15.2, D-188)' },
  { pattern: 'ui/src/**', why: 'UI aggregate gate (§17.3 overall, D-188)' },
] as const;

/** The coverage options of the imported config; shapes are pinned by the tests. */
function coverageOptions(): { include?: unknown } | undefined {
  const test = (vitestConfig as { test?: { coverage?: { include?: unknown } } }).test;
  return test?.coverage as { include?: unknown } | undefined;
}

/** The coverage thresholds of the imported config; shape is pinned by the tests. */
function coverageThresholds(): unknown {
  return (coverageOptions() as { thresholds?: unknown } | undefined)?.thresholds;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(): string {
  return (
    `coverage.thresholds must be the object form mapping file keys to per-key ` +
    `threshold objects (this repo's pinned shape; decision D-085) — got ${typeof coverageThresholds()}`
  );
}

/** The file keys of the threshold map, split from the global options exactly as resolveThresholds does. */
function fileThresholdKeys(): string[] {
  const thresholds = coverageThresholds();
  if (!isPlainObject(thresholds)) throw new Error(shapeError());
  return Object.keys(thresholds).filter((key) => !GLOBAL_THRESHOLD_KEYS.has(key));
}

/** Every `.ts` file under `src/` and every `.ts`/`.vue` file under `ui/src/`, repo-root-relative with forward slashes — the universe `coverage.include` feeds. */
function listUniverseFiles(dir: string, extensions: readonly string[]): string[] {
  // A missing directory yields an empty walk so the vacuity assertion fails
  // with its instruction-style message instead of a raw ENOENT stack trace.
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listUniverseFiles(full, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  }
  return files;
}

/** The whole coverage universe: every .ts file under src plus every .ts and .vue file under ui/src. */
function listCoverageFiles(): string[] {
  return [...listUniverseFiles(SRC, ['.ts']), ...listUniverseFiles(UI_SRC, ['.ts', '.vue'])].sort();
}

describe('coverage threshold guard (task U-015, spec §17.3; decision D-093)', () => {
  it('thresholds keep the pinned object form', () => {
    expect(isPlainObject(coverageThresholds()), shapeError()).toBe(true);
  });

  it('coverage include and the global threshold axes keep the pinned shape', () => {
    expect(
      coverageOptions()?.include,
      'coverage.include is pinned to the src + ui/src universe — this guard ' +
        `offers exactly those files as threshold-key candidates; widen the ` +
        `include and this guard together`,
    ).toEqual(['src/**/*.ts', 'ui/src/**/*.ts', 'ui/src/**/*.vue']);
    const thresholds = coverageThresholds();
    if (!isPlainObject(thresholds)) throw new Error(shapeError());
    const missing = GLOBAL_AXES.filter((axis) => !(axis in thresholds));
    expect(
      missing,
      'the global aggregate axes of §17.3/D-085 are missing from the threshold map — ' +
        `the overall ${GLOBAL_AXES.join('/')} floor would be unenforced (values stay policy; presence is structure)`,
    ).toEqual([]);
    // Structural intent pin (D-188): the UI key is an AGGREGATE gate — a key
    // without `perFile` is judged as one group over its matched files, which
    // is the whole anti-masking design. An accidental `perFile: true` on it
    // would flip the gate to per-file 90 (a different, silently stricter or
    // looser regime) without any structural signal elsewhere.
    const uiEntry = (thresholds as Record<string, unknown>)['ui/src/**'];
    expect(
      uiEntry,
      "the 'ui/src/**' threshold key is missing — the UI aggregate gate (D-188) is " +
        'unenforced; re-add it beside the critical-module keys',
    ).toBeTypeOf('object');
    expect(
      (uiEntry as Record<string, unknown> | null)?.perFile,
      "the 'ui/src/**' threshold entry must NOT set perFile — without it the runner " +
        'judges one aggregate over the matched files (the D-188 anti-masking design); ' +
        'perFile would silently flip the gate to per-file 90',
    ).toBeUndefined();
  });

  it('every threshold key matches at least one coverage-universe file (orphaned globs fail)', () => {
    const keys = fileThresholdKeys();
    expect(
      keys.length,
      'vacuity: no file keys found in the threshold map — the guard would assert nothing',
    ).toBeGreaterThan(0);
    const universeFiles = listCoverageFiles();
    expect(
      universeFiles.length,
      'vacuity: no .ts/.vue files found under src/ or ui/src/ — the guard would assert nothing',
    ).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const key of keys) {
      const matches = pm(key);
      if (!universeFiles.some((file) => matches(file))) {
        violations.push(
          `${key}: threshold key matches no file under src/ or ui/src/ — it judges an ` +
            `empty file set and enforces nothing while make check stays green (rename or ` +
            `delete the key; the critical-module map lives in this spec and in decisions ` +
            `D-085/D-089/D-188)`,
        );
      }
    }
    expect(violations.sort(), 'orphaned coverage threshold keys').toEqual([]);
  });

  it('every critical module of the §17.3 map is enforced by a threshold key', () => {
    const keys = fileThresholdKeys();
    const keyMatchers = keys.map((key) => pm(key));
    const universeFiles = listCoverageFiles();
    const violations: string[] = [];
    for (const entry of CRITICAL_MODULE_MAP) {
      const matchesMap = pm(entry.pattern);
      const required = universeFiles.filter((file) => matchesMap(file));
      if (required.length === 0) {
        violations.push(
          `${entry.pattern} (${entry.why}): the map pattern matches no coverage-universe ` +
            `file — a §17.3 critical module was renamed or deleted; update this map and ` +
            `the vitest.config.ts key together (decisions D-085, D-089, D-188)`,
        );
        continue;
      }
      for (const file of required) {
        if (!keyMatchers.some((matches) => matches(file))) {
          violations.push(
            `${file} (${entry.why}): matched by no coverage threshold key — its ` +
              `§17.3 target is unenforced (decisions D-085, D-089, D-188)`,
          );
        }
      }
    }
    expect(
      violations.sort(),
      '§17.3 critical modules not enforced by the coverage thresholds',
    ).toEqual([]);
  });

  it('the matcher mirrors the installed Vitest (positive control)', () => {
    // picomatch with default options, exactly as resolveThresholds compiles keys.
    const family = pm('src/services/peak-hours*.ts');
    expect(family('src/services/peak-hours-one.ts')).toBe(true);
    expect(family('src/services/peak-hours-two.ts')).toBe(true);
    // A prefix glob does not match siblings outside the family, and `*` never crosses `/`.
    expect(family('src/services/polling-scheduler.ts')).toBe(false);
    expect(family('src/services/nested/peak-hours-x.ts')).toBe(false);
    // Exact paths are literal patterns: no wildcard, no substring matching.
    const exact = pm('src/util/clock.ts');
    expect(exact('src/util/clock.ts')).toBe(true);
    expect(exact('src/util/clock.spec.ts')).toBe(false);
    expect(exact('test/unit/clock.spec.ts')).toBe(false);
    // The UI aggregate key's pattern (D-188): `**` matches nested .ts and
    // .vue files under ui/src, and nothing outside the tree.
    const uiGroup = pm('ui/src/**');
    expect(uiGroup('ui/src/main.ts')).toBe(true);
    expect(uiGroup('ui/src/components/MetricCard.vue')).toBe(true);
    expect(uiGroup('ui/vite.config.ts')).toBe(false);
    expect(uiGroup('src/services/sessions.ts')).toBe(false);
  });

  it('the guard and the runner resolve one picomatch instance (resolve identity)', () => {
    // The premise the mirror above rests on (task U-027): this spec's
    // `import 'picomatch'` and the runner's own load must reach the same
    // package. Resolving with `paths` rooted at the installed vitest's package
    // directory reproduces the runner's candidate walk — a nested
    // `node_modules/vitest/node_modules/picomatch` shadows the root copy
    // exactly as it would for vitest's own import.
    const specRequire = createRequire(import.meta.url);
    const guardPath = specRequire.resolve('picomatch');
    const vitestDir = path.dirname(specRequire.resolve('vitest/package.json'));
    const runnerPath = specRequire.resolve('picomatch', { paths: [vitestDir] });
    expect(
      runnerPath,
      "picomatch resolves to two instances — the guard mirrors the runner's " +
        "threshold-key matching only through ONE picomatch (U-024's dedupe, the " +
        "premise of D-093's mirror): the declared devDependency range no longer " +
        "tracks the installed vitest's own picomatch range, so npm nested a " +
        `divergent copy under the runner. The guard resolves ${guardPath}; the ` +
        `runner resolves ${runnerPath}. Re-pin the picomatch range to vitest's ` +
        'declared range (or dedupe the tree), then re-run this spec — a split ' +
        'mirror is silent everywhere else in the suite',
    ).toBe(guardPath);
  });
});
