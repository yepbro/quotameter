import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The time-suite selection guard (task 126, spec §17.1; decision D-097).
 *
 * CI's `timezone` job runs `npm run test:time` under one process `TZ` per
 * matrix cell. That script selects files through Vitest CLI filters —
 * substring-OR matches over the spec file path, verified against the
 * installed Vitest 5.0.5 (`vitest list clock rolling-ranges peak-hours
 * compare-epoch-ms` lists exactly the files pinned below). Substring
 * selection is fragile in both directions: a renamed time/peak-hours spec
 * silently leaves the selection, and a newly added one outside the filter
 * vocabulary joins nothing. This spec fails the first direction, the way
 * `coverage-thresholds.spec.ts` guards the threshold keys: the
 * `test:time` command is parsed from package.json (same-process truth, no
 * text parsing of a script's callers), its filters are applied to the real
 * `test/unit` + `test/integration` trees with the same substring rule, and
 * the selection must equal the pinned manifest — the
 * time/peak-hours suite (§17.1 "ranges, calendar boundaries, peak windows,
 * DST transitions … run under different `TZ` values", tasks 071/093/094/
 * 114/115/116 plus the epoch-ordering leaf D-090's family grew, and task
 * 162's endpoint suites joined with the wire-side DST proof).
 *
 * Deliberate limits, accepted in D-097: a file renamed OUT of the filter
 * vocabulary is indistinguishable from a removal by structure alone, so
 * only the emptied selection or the stale manifest fails (the same limit
 * `coverage-thresholds.spec.ts` records for renamed modules) — and a NEW
 * spec added outside the filter vocabulary is not detected at all: no
 * structural signal says a file is "time/peak-hours" besides its name, and
 * an inventory that classifies every future spec would tax unrelated
 * suites. The convention that carries the limit: time/peak-hours specs are
 * named after their modules (clock, rolling-ranges, peak-hours*,
 * compare-epoch-ms), so they join the filters naturally; a new vocabulary
 * family edits the filters and this manifest in the same change. The CI
 * matrix's zone list is pinned structurally by
 * `test/integration/tz-verify-script.spec.ts` (it scans
 * `.github/workflows/ci.yml` and compares the workflow's matrix with the
 * `scripts/verify-tz.mjs` membership).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The time/peak-hours suite the §17.1 matrix runs — the files selected by
 * package.json's `test:time` filters today. Keep this list, the filters,
 * and the suite in step: a new time/peak-hours spec joins the filters and
 * this manifest in the same change.
 */
const TIME_SUITE_MANIFEST = [
  'test/integration/api-peak-hours.spec.ts',
  'test/integration/rolling-ranges-tz.spec.ts',
  'test/unit/api-peak-hours-schema.spec.ts',
  'test/unit/api-peak-hours-view.spec.ts',
  'test/unit/clock.property.spec.ts',
  'test/unit/clock.spec.ts',
  'test/unit/compare-epoch-ms.spec.ts',
  'test/unit/peak-hours-dst.matrix.spec.ts',
  'test/unit/peak-hours-dst.property.spec.ts',
  'test/unit/peak-hours-dst.spec.ts',
  'test/unit/peak-hours-intervals.property.spec.ts',
  'test/unit/peak-hours-intervals.spec.ts',
  'test/unit/peak-hours-validation.spec.ts',
  'test/unit/rolling-ranges.property.spec.ts',
  'test/unit/rolling-ranges.spec.ts',
] as const;

interface PackageJson {
  scripts?: Record<string, string | undefined>;
}

/** The `test:time` command string, parsed from the same package.json npm runs. */
function timeSuiteCommand(): string {
  const raw = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  const command = pkg.scripts?.['test:time'];
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(
      "package.json scripts['test:time'] is missing — the §17.1 time-zone matrix has " +
        'nothing to run; restore the script (decision D-097)',
    );
  }
  return command;
}

/** The CLI filters of the command: every argument after `vitest run`. */
function timeSuiteFilters(): string[] {
  const command = timeSuiteCommand();
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts[0] !== 'vitest' || parts[1] !== 'run' || parts.length < 3) {
    throw new Error(
      `scripts['test:time'] must be a 'vitest run <filter>…' command with at least one ` +
        `filter (the pinned shape, decision D-097) — got '${command}'`,
    );
  }
  return parts.slice(2);
}

/** Every `*.spec.ts` under one directory, repo-root-relative with forward slashes. */
function listSpecFiles(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...listSpecFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.spec.ts')) {
      files.push(path.join(dir, entry.name).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

/** The Vitest CLI filter rule this guard mirrors: substring-OR over the path. */
function isSelected(file: string, filters: readonly string[]): boolean {
  return filters.some((filter) => file.includes(filter));
}

describe('time-suite selection guard (task 126, spec §17.1; decision D-097)', () => {
  it('the test:time filters select exactly the pinned time/peak-hours manifest', () => {
    const filters = timeSuiteFilters();
    const scanned = [...listSpecFiles('test/unit'), ...listSpecFiles('test/integration')];
    expect(
      scanned.length,
      'vacuity: no spec files found under test/unit or test/integration — the guard ' +
        'would assert nothing',
    ).toBeGreaterThan(0);
    const selected = scanned.filter((file) => isSelected(file, filters)).sort();
    expect(selected, 'the files test:time selects (the §17.1 matrix suite)').toEqual(
      [...TIME_SUITE_MANIFEST].sort(),
    );
  });

  it('every pinned manifest file still exists (the matrix cannot silently shrink)', () => {
    const violations = TIME_SUITE_MANIFEST.filter(
      (file) => !existsSync(path.join(REPO_ROOT, file)),
    );
    expect(
      violations,
      'manifest entries that no longer exist — a time/peak-hours spec was renamed, moved, ' +
        'or deleted; update the test:time filters and this manifest together (decision D-097)',
    ).toEqual([]);
  });

  it('every filter matches at least one spec file (no dead filter)', () => {
    const filters = timeSuiteFilters();
    const scanned = [...listSpecFiles('test/unit'), ...listSpecFiles('test/integration')];
    const violations = filters.filter((filter) => !scanned.some((file) => file.includes(filter)));
    expect(
      violations,
      'filters that select nothing — a dead filter types nothing and hides a vocabulary ' +
        'drift from the manifest above',
    ).toEqual([]);
  });

  it('the mirror pins the substring-OR filter semantics (positive control)', () => {
    // A bare filter matches every path containing it — both clock suites.
    expect(isSelected('test/unit/clock.spec.ts', ['clock'])).toBe(true);
    expect(isSelected('test/unit/clock.property.spec.ts', ['clock'])).toBe(true);
    // It reaches across directories: rolling-ranges lives in unit and integration.
    expect(isSelected('test/unit/rolling-ranges.spec.ts', ['rolling-ranges'])).toBe(true);
    expect(isSelected('test/integration/rolling-ranges-tz.spec.ts', ['rolling-ranges'])).toBe(true);
    // And it is a substring, not a prefix or basename match.
    expect(isSelected('test/unit/compare-epoch-ms.spec.ts', ['compare-epoch-ms'])).toBe(true);
    expect(isSelected('test/unit/picomatch.d.ts', ['clock'])).toBe(false);
    expect(isSelected('test/unit/clock.spec.ts', ['zzz'])).toBe(false);
  });
});
