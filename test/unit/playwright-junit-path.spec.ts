import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import { resolveE2eJunitOutputFile } from '../helpers/e2e-report';

/**
 * The Playwright JUnit output-path guard (task U-034, spec §17;
 * docs/agents/environment.md).
 *
 * `playwright.config.ts` used to hardcode the CI JUnit reporter's
 * `outputFile: 'reports/e2e-junit.xml'` relative to the repository root —
 * the one writing tool left that ignored the container uid invariant: with
 * `CI` set inside the development container the reporter would write into
 * the bind-mounted repository tree (container uid 1000, host uid 1001) and
 * fail with `EACCES` only after the whole suite had passed (the reporter
 * mkdirs/writes at `onEnd`). Every other writing tool routes its output
 * through an env-configured directory with a host-friendly default; the fix
 * moves the JUnit XML to `REPORTS_DIR` — the same directory the Vitest
 * JUnit report uses (package.json `test:ci`) — keeping `reports/e2e-junit.xml`
 * as the unset-env default so CI's artifact upload keeps finding it
 * unchanged. The resolution lives in `test/helpers/e2e-report.ts` with the
 * env injectable as a parameter, so every arm (CI, no-CI, default) is
 * testable in-container instead of frozen at import time.
 *
 * Pinned invariants:
 * - behavioral, through the exported resolver the config itself calls:
 *   CI mode resolves the file inside `REPORTS_DIR` and creates the
 *   directory at resolution time (the `scripts/check-licenses.mjs` sibling
 *   pattern); without `CI` no directory is created; unset env resolves the
 *   documented host-friendly `reports/e2e-junit.xml` default; and the
 *   imported config's own reporter mirrors the live environment
 *   (list-only without `CI`);
 * - textual: the resolver derives the path from `REPORTS_DIR ?? 'reports'`
 *   with the real `process.env` as the default env, the config wires the
 *   resolver's result into the CI-gated junit reporter, and no hardcoded
 *   in-tree `outputFile` literal returns;
 * - cross-file: the Vitest JUnit script stays on the same `REPORTS_DIR`
 *   root, and the CI workflow's test job keeps uploading `reports/` — the
 *   consumer of the unset-env default both junit reports rely on.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'test/helpers/e2e-report.ts');
const CONFIG_PATH = path.join(REPO_ROOT, 'playwright.config.ts');
const MANIFEST_PATH = path.join(REPO_ROOT, 'package.json');
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');

/**
 * The `test` job's block of the CI workflow — a line scanner, not a YAML
 * parser (the U-029 pattern, `test/unit/ci-workflow.spec.ts`). Scoping
 * matters: the `static` job uploads `reports/` too, so a whole-file search
 * would stay green after the test job dropped the E2E report's path.
 */
function testJobBlock(): string {
  const lines = readFileSync(CI_WORKFLOW_PATH, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === '  test:');
  if (start === -1) {
    throw new Error(
      "the 'test:' job is missing from .github/workflows/ci.yml — the E2E " +
        'junit report would have no consumer; restore the job or update this ' +
        'guard with the workflow shape',
    );
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[A-Za-z][A-Za-z0-9-]*:$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('playwright junit output path (task U-034, docs/agents/environment.md)', () => {
  it('CI mode resolves the junit report inside REPORTS_DIR and creates the directory', () => {
    // A not-yet-existing directory under a fresh temp root proves the
    // resolution-site mkdirSync, never a pre-existing directory.
    const reportsDir = path.join(mkdtempSync(path.join(tmpdir(), 'qm-e2e-junit-')), 'reports');

    const outputFile = resolveE2eJunitOutputFile({ CI: '1', REPORTS_DIR: reportsDir });

    expect(
      outputFile,
      'the outputFile must follow REPORTS_DIR — a relative/in-tree path here ' +
        'is the exact uid-invariant violation U-034 closed',
    ).toBe(path.join(reportsDir, 'e2e-junit.xml'));
    expect(
      existsSync(reportsDir),
      'CI mode must create the reports directory itself (the sibling tools ' +
        'mkdir at resolution time — scripts/check-licenses.mjs)',
    ).toBe(true);
  });

  it('without CI no directory is created — local runs keep no junit side effects', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'qm-e2e-local-'));
    const reportsDir = path.join(parent, 'reports');

    const outputFile = resolveE2eJunitOutputFile({ REPORTS_DIR: reportsDir });

    expect(outputFile).toBe(path.join(reportsDir, 'e2e-junit.xml'));
    expect(existsSync(reportsDir), 'no CI, no reporter — nothing may be created').toBe(false);
  });

  it("unset env resolves the host-friendly 'reports/e2e-junit.xml' default", () => {
    expect(
      resolveE2eJunitOutputFile({}),
      'the unset-env default must stay byte-identical to the pre-U-034 path ' +
        "so the CI workflow's reports/ upload keeps working",
    ).toBe(path.join('reports', 'e2e-junit.xml'));
  });

  it("the config's own reporter mirrors the live environment (list-only without CI)", () => {
    // The static import froze the config under THIS process's environment —
    // exactly what a real run does at config load.
    const { reporter } = playwrightConfig as { reporter: unknown };
    if (process.env.CI) {
      const junit = (reporter as Array<[string, Record<string, unknown>]>).find(
        ([name]) => name === 'junit',
      );
      expect(junit, 'CI must keep the junit reporter beside list').toBeDefined();
      expect(junit?.[1]?.outputFile, 'the wired outputFile is the resolver over the real env').toBe(
        resolveE2eJunitOutputFile({
          CI: process.env.CI,
          REPORTS_DIR: process.env.REPORTS_DIR,
        }),
      );
    } else {
      expect(reporter, 'no CI, no junit reporter — local runs stay list-only').toBe('list');
    }
  });

  it('the resolver reads the real process.env and the config wires it into the CI reporter', () => {
    const helper = readFileSync(HELPER_PATH, 'utf8');
    expect(
      helper.includes("env.REPORTS_DIR ?? 'reports'") && helper.includes('= process.env'),
      'the report directory must be env-configured with the documented ' +
        "relative default, read from the real process.env — 'reports' keeps " +
        'host and CI runs unchanged',
    ).toBe(true);

    const config = readFileSync(CONFIG_PATH, 'utf8');
    expect(
      config.includes('resolveE2eJunitOutputFile()'),
      'the config must derive the outputFile through the shared resolver — ' +
        'an inline re-derivation could drift from the tested behavior',
    ).toBe(true);
    // The exact reporter line pins BOTH branches: the junit reporter exists
    // only under CI, and the local arm stays the bare 'list' — a rewrite of
    // either side (e.g. a junit reporter leaking into local runs, which
    // would write reports/ in-tree from the container again) fails here.
    const reporterLine = config
      .split('\n')
      .find((line) => line.trimStart().startsWith('reporter:'));
    expect(reporterLine?.trim(), 'the reporter must stay gated on CI exactly as before').toBe(
      "reporter: process.env.CI ? [['list'], ['junit', { outputFile: junitOutputFile }]] : 'list',",
    );
    expect(
      config,
      'the pre-U-034 hardcoded in-tree outputFile literal must not return ' +
        '(container CI runs would write into the bind mount again)',
    ).not.toContain("outputFile: 'reports/");
  });

  it('keeps both junit reports on one REPORTS_DIR root and CI uploading reports/', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      manifest.scripts?.['test:ci']?.includes('${REPORTS_DIR:-reports}/junit.xml'),
      "the Vitest junit script's REPORTS_DIR root is why the Playwright XML " +
        'joins it — both junit artifacts stay siblings if either moves',
    ).toBe(true);
    expect(
      testJobBlock().includes('reports/'),
      "the CI TEST job's artifact upload consumes the unset-env default path " +
        '(the static job uploads reports/ too, so this pin is scoped to the ' +
        'test job — a whole-file search would stay green after the test job ' +
        'dropped the path); it must stay in lockstep with the config default',
    ).toBe(true);
  });
});
