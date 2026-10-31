import { existsSync, readdirSync } from 'node:fs';
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
 * `coverage.thresholds` passes silently. With `perFile: true` (every file key
 * in this repo's config), the installed Vitest judges exactly the matched
 * files — an empty match set judges nothing, so renaming a module family
 * (`peak-hours*`) or an exact-path module without updating the config leaves a
 * dead 100% key enforcing nothing while `make check` stays green. This spec
 * fails instead, the way `package-layout.spec.ts` enforces the layer rules:
 * the config is imported (same-process truth — no text parsing of a TypeScript
 * file), its threshold keys are matched against the real `src/` tree with the
 * same matcher Vitest uses, and the §17.3 critical-module map (D-085, widened
 * by D-089/U-016) is enumerated here so a config regression that DROPS or
 * NARROWS a key fails too.
 *
 * Matching semantics — verified against the installed Vitest 5.0.5
 * (`node_modules/vitest/dist/chunks/cli-api.De07GUeT.js`, `resolveThresholds`):
 * every threshold key that is not a global option becomes `picomatch(key)`
 * with **default options**, matched against each coverage file's path
 * **relative to the config root** (repo-root-relative, forward slashes) —
 * exact paths are literal patterns, globs behave per picomatch (`*` never
 * crosses `/`). The guard mirrors that call one-for-one through the same
 * library; the default-options positive control below pins the semantics the
 * mirror relies on.
 *
 * Deliberate limits: a single family member renamed OUT of the `peak-hours*`
 * glob leaves the family by name — no structural signal can distinguish a
 * rename from a removal, so only the emptied family (or the stale map entry)
 * fails; threshold VALUES (the D-089 branch maxima) are coverage policy, not
 * structure, and are out of scope. The rename behavior is demonstrated by the
 * scratch experiment recorded in the task's commit body, not asserted live.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');

/** The four global threshold axes of §17.3/D-085's aggregate layer. */
const GLOBAL_AXES = ['lines', 'branches', 'functions', 'statements'] as const;

/**
 * The keys `resolveThresholds` treats as global options, not file patterns:
 * `perFile`, `autoUpdate`, the `100` shorthand, and the THRESHOLD_KEYS quartet.
 * Everything else in the threshold map is a glob-or-exact file key.
 */
const GLOBAL_THRESHOLD_KEYS = new Set<string>([...GLOBAL_AXES, 'perFile', 'autoUpdate', '100']);

/**
 * The §17.3 critical modules as patterns (D-085's map plus D-089/U-016's
 * widening): time-zone logic, the peak-hours family, sanitization, §15.4's
 * secret-handling mechanisms, and the configuration-loading/transport set.
 * A pattern that matches nothing means a critical module moved or disappeared
 * — the map and the config keys must be updated together.
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

/** Every `.ts` file under `src/`, repo-root-relative with forward slashes — the universe `coverage.include` feeds. */
function listSrcFiles(dir: string = SRC): string[] {
  // A missing directory yields an empty walk so the vacuity assertion fails
  // with its instruction-style message instead of a raw ENOENT stack trace.
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSrcFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

describe('coverage threshold guard (task U-015, spec §17.3; decision D-093)', () => {
  it('thresholds keep the pinned object form', () => {
    expect(isPlainObject(coverageThresholds()), shapeError()).toBe(true);
  });

  it('coverage include and the global threshold axes keep the pinned shape', () => {
    expect(
      coverageOptions()?.include,
      'coverage.include is pinned to src/**/*.ts — this guard offers only src files ' +
        `as threshold-key candidates; widen the include and this guard together`,
    ).toEqual(['src/**/*.ts']);
    const thresholds = coverageThresholds();
    if (!isPlainObject(thresholds)) throw new Error(shapeError());
    const missing = GLOBAL_AXES.filter((axis) => !(axis in thresholds));
    expect(
      missing,
      'the global aggregate axes of §17.3/D-085 are missing from the threshold map — ' +
        `the overall ${GLOBAL_AXES.join('/')} floor would be unenforced (values stay policy; presence is structure)`,
    ).toEqual([]);
  });

  it('every threshold key matches at least one src file (orphaned globs fail)', () => {
    const keys = fileThresholdKeys();
    expect(
      keys.length,
      'vacuity: no file keys found in the threshold map — the guard would assert nothing',
    ).toBeGreaterThan(0);
    const srcFiles = listSrcFiles();
    expect(
      srcFiles.length,
      'vacuity: no .ts files found under src/ — the guard would assert nothing',
    ).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const key of keys) {
      const matches = pm(key);
      if (!srcFiles.some((file) => matches(file))) {
        violations.push(
          `${key}: threshold key matches no file under src/ — it judges an empty file set ` +
            `and enforces nothing while make check stays green (rename or delete the key; the ` +
            `critical-module map lives in this spec and in decisions D-085/D-089)`,
        );
      }
    }
    expect(violations.sort(), 'orphaned coverage threshold keys').toEqual([]);
  });

  it('every critical module of the §17.3 map is enforced by a threshold key', () => {
    const keys = fileThresholdKeys();
    const keyMatchers = keys.map((key) => pm(key));
    const srcFiles = listSrcFiles();
    const violations: string[] = [];
    for (const entry of CRITICAL_MODULE_MAP) {
      const matchesMap = pm(entry.pattern);
      const required = srcFiles.filter((file) => matchesMap(file));
      if (required.length === 0) {
        violations.push(
          `${entry.pattern} (${entry.why}): the map pattern matches no src file — a §17.3 ` +
            `critical module was renamed or deleted; update this map and the vitest.config.ts ` +
            `key together (decisions D-085, D-089)`,
        );
        continue;
      }
      for (const file of required) {
        if (!keyMatchers.some((matches) => matches(file))) {
          violations.push(
            `${file} (${entry.why}): matched by no coverage threshold key — §17.3's ` +
              `critical-module target for it is unenforced (decisions D-085, D-089)`,
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
  });
});
