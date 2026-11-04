import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The release-workflow guard (task U-029, spec §4.4; decisions D-008, D-152).
 *
 * `.github/workflows/release.yml` is the only publish channel (D-008), and
 * its defects were found the hard way: it once ran on the npm bundled with
 * Node 22 (10.x), which cannot perform tokenless OIDC trusted publishing,
 * built no web UI before packing, and ran no tests before publishing — a
 * workflow that could only ever fail at the first tag. This spec pins the
 * structural invariants that keep the channel publish-capable, the way
 * `test/integration/tz-verify-script.spec.ts` pins the CI time-zone matrix:
 * a small line scanner over the workflow (no YAML dependency exists; the
 * file is actionlint-pinned to this block shape), every failure mode a
 * loud throw telling the editor to keep the guard in step.
 *
 * Pinned invariants (decision D-152):
 * - npm is bumped to the shared ≥ 11 pin before any pack or publish step
 *   (trusted publishing needs npm ≥ 11.5), and the pin is IDENTICAL across
 *   the Dockerfile, ci.yml, and release.yml — the mechanized form of the
 *   "keep the pin in sync" comments those files carry;
 * - the publish job builds the web UI (`build:ui`) and verifies it
 *   (`verify:build`) BEFORE the tarball allowlist check, so the moment the
 *   package manifest's `files` allowlist covers `ui/dist` (task 184), the
 *   tarball check validates the built artifacts with no workflow change;
 * - a test gate (`test:ci`) runs before publishing;
 * - the tarball allowlist check runs before the publish step;
 * - the publish runs with `--provenance` under the `id-token: write`
 *   permission, and no npm token/secret appears anywhere in the workflow.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/release.yml');

/** One `steps:` entry of the publish job, in workflow order. */
interface WorkflowStep {
  name: string;
  /** First non-empty command line of the step's `run:` block, if it has one. */
  run?: string;
  /** All lines of the step's `run:` block, if it has one. */
  runLines: string[];
}

function readWorkflow(): string {
  return readFileSync(RELEASE_WORKFLOW, 'utf8');
}

/**
 * The ordered `steps:` list of the `publish` job — a line scanner, not a
 * YAML parser (the tz-verify-script pattern), bounded by the next job
 * heading. Throws loudly on every shape it does not recognize, never
 * returns a silently empty or truncated list.
 */
function releaseSteps(): WorkflowStep[] {
  const lines = readWorkflow().split('\n');
  const jobIndex = lines.findIndex((line) => line === '  publish:');
  if (jobIndex === -1) {
    throw new Error(
      "the 'publish:' job is missing from .github/workflows/release.yml — the D-008 " +
        'publish channel would not exist; restore the job or retire this guard deliberately',
    );
  }
  const nextJob = lines.findIndex(
    (line, index) => index > jobIndex && /^ {2}[A-Za-z][A-Za-z0-9-]*:$/.test(line),
  );
  const jobLines = lines.slice(jobIndex + 1, nextJob === -1 ? lines.length : nextJob);
  const stepsIndex = jobLines.findIndex((line) => line === '    steps:');
  if (stepsIndex === -1) {
    throw new Error(
      "no 'steps:' key found inside the publish job — if the workflow's shape " +
        'changed, update this scanner with it',
    );
  }
  const steps: WorkflowStep[] = [];
  let current: WorkflowStep | undefined;
  let runDepth = 0; // > 0 while collecting a multi-line `run: |` block
  for (const line of jobLines.slice(stepsIndex + 1)) {
    const stepStart = /^ {6}- name: (.+?)\s*$/.exec(line);
    if (stepStart?.[1]) {
      current = { name: stepStart[1], runLines: [] };
      steps.push(current);
      runDepth = 0;
      continue;
    }
    if (current === undefined) {
      if (/^ {6}- /.test(line)) {
        throw new Error(
          'a publish-job step carries no name — named steps are the pinned shape ' +
            'this scanner (and the release logs) read; name the step',
        );
      }
      continue; // job-level keys before the first step (runs-on, comments)
    }
    if (runDepth > 0) {
      if (line.trim().length === 0) {
        continue; // YAML keeps a block scalar alive through blank lines
      }
      const blockLine = /^ {10}(.*)$/.exec(line);
      if (blockLine?.[1] !== undefined) {
        current.runLines.push(blockLine[1]);
        continue;
      }
      runDepth = 0; // block ended; the line is reprocessed below
    }
    // The block form (`run: |`) must be tested before the inline form, or
    // the pipe itself becomes the captured command.
    if (/^ {8}run: \|\s*$/.test(line)) {
      runDepth = 1;
      continue;
    }
    const inlineRun = /^ {8}run: (.+?)\s*$/.exec(line);
    if (inlineRun?.[1]) {
      current.runLines.push(inlineRun[1]);
      continue;
    }
  }
  if (steps.length === 0) {
    throw new Error(
      'the publish job has no steps — the release channel cannot publish; ' +
        'restore the pipeline (docs/release.md describes it)',
    );
  }
  for (const step of steps) {
    step.run = step.runLines.find((line) => line.trim().length > 0);
  }
  return steps;
}

/** Index of the first step whose `run:` first line satisfies the predicate. */
function stepIndex(steps: readonly WorkflowStep[], predicate: (run: string) => boolean): number {
  return steps.findIndex((step) => step.run !== undefined && predicate(step.run));
}

/** The step must exist; its index is returned with a naming message for failures. */
function requireStep(
  steps: readonly WorkflowStep[],
  predicate: (run: string) => boolean,
  what: string,
): number {
  const index = stepIndex(steps, predicate);
  if (index === -1) {
    throw new Error(`the publish job lost its ${what} step — restore it (decision D-152)`);
  }
  return index;
}

/** The shared `npm install -g npm@X.Y.Z` pin of one file, or undefined. */
function npmPin(relativePath: string): string | undefined {
  return /npm install -g npm@([\d.]+)/.exec(
    readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  )?.[0];
}

describe('release workflow guard (task U-029, spec §4.4; decisions D-008, D-152)', () => {
  it('the npm pin is identical across the Dockerfile, ci.yml, and release.yml', () => {
    const pins = {
      Dockerfile: npmPin('Dockerfile'),
      ci: npmPin('.github/workflows/ci.yml'),
      release: npmPin('.github/workflows/release.yml'),
    };
    for (const [file, pin] of Object.entries(pins)) {
      expect(
        pin,
        `${file} no longer pins the shared npm version — restore the ` +
          '`npm install -g npm@X.Y.Z` line or update this guard with the new mechanism',
      ).toBeDefined();
    }
    expect(pins.release, 'the release pin must equal the ci.yml pin').toBe(pins.ci);
    expect(pins.release, 'the release pin must equal the Dockerfile pin').toBe(pins.Dockerfile);
  });

  it('the shared npm pin is at least 11.5.0 (trusted publishing needs ≥ 11.5)', () => {
    const match = /npm@(\d+)\.(\d+)\./.exec(npmPin('.github/workflows/release.yml') ?? '');
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);
    const capable =
      Number.isInteger(major) &&
      Number.isInteger(minor) &&
      (major > 11 || (major === 11 && minor >= 5));
    expect(
      capable,
      `the pinned npm is ${major}.${minor}; npm < 11.5 cannot perform tokenless OIDC ` +
        'trusted publishing — the first tag would fail at publish',
    ).toBe(true);
  });

  it('the publish job bumps npm before packing and publishing', () => {
    const steps = releaseSteps();
    const bump = requireStep(steps, (run) => /^npm install -g npm@\d/.test(run), 'npm update');
    const pack = requireStep(steps, (run) => run === 'npm run check:package', 'tarball allowlist');
    const publish = requireStep(steps, (run) => run.startsWith('npm publish'), 'npm publish');
    expect(bump, 'the npm bump must precede the tarball allowlist check').toBeLessThan(pack);
    expect(bump, 'the npm bump must precede the publish step').toBeLessThan(publish);
  });

  it('the publish job builds and verifies the web UI before the tarball check', () => {
    const steps = releaseSteps();
    const build = requireStep(steps, (run) => run === 'npm run build:ui', 'web UI build');
    const verify = requireStep(
      steps,
      (run) => run === 'npm run verify:build',
      'build verification',
    );
    const pack = requireStep(steps, (run) => run === 'npm run check:package', 'tarball allowlist');
    expect(
      build,
      'build:ui must run before check:package — the tarball check validates the built ' +
        'artifacts (task 184 lands them in the files allowlist)',
    ).toBeLessThan(pack);
    expect(verify, 'verify:build must run after build:ui').toBeGreaterThan(build);
    expect(
      verify,
      'verify:build must precede check:package — an unverified build must ' +
        'not reach the tarball check',
    ).toBeLessThan(pack);
  });

  it('a coverage-gated test run and the allowlist check precede the publish', () => {
    const steps = releaseSteps();
    const tests = requireStep(steps, (run) => run === 'npm run test:ci', 'test suite');
    const pack = requireStep(steps, (run) => run === 'npm run check:package', 'tarball allowlist');
    const publish = requireStep(steps, (run) => run.startsWith('npm publish'), 'npm publish');
    expect(tests, 'the test gate must precede the publish step').toBeLessThan(publish);
    expect(pack, 'the tarball allowlist check must precede the publish step').toBeLessThan(publish);
  });

  it('the publish refuses to run unless the tagged commit has a green CI check run', () => {
    const steps = releaseSteps();
    const gate = steps.findIndex(
      (step) =>
        step.runLines.some((line) => line.includes('check-runs')) &&
        step.runLines.some((line) => line.includes('"CI"')) &&
        step.runLines.some((line) => line.includes('compare/master...')),
    );
    expect(
      gate,
      'the green-CI gate step (a master-ancestry compare plus a check-runs lookup of ' +
        'the "CI" check on GITHUB_SHA) is missing — D-008 requires a green CI run on ' +
        'the tagged commit before publishing; a green PR-head run must not qualify',
    ).not.toBe(-1);
    const publish = requireStep(steps, (run) => run.startsWith('npm publish'), 'npm publish');
    expect(gate, 'the green-CI gate must precede the publish step').toBeLessThan(publish);
  });

  it('the workflow triggers on version tags, holds id-token write, and carries no npm token', () => {
    const text = readWorkflow();
    expect(text, 'the trigger must stay a pushed vX.Y.Z tag (D-008)').toContain("tags: ['v*.*.*']");
    expect(
      text,
      'the id-token: write permission is the OIDC identity trusted publishing needs',
    ).toMatch(/id-token:\s*write/);
    expect(
      text,
      'no npm token or repository secret may appear in the release workflow — ' +
        'trusted publishing replaced long-lived credentials (D-008)',
    ).not.toMatch(/NPM_TOKEN|_authToken|secrets\./);
    expect(
      text,
      'the publish must carry --provenance (D-008: releases carry attestations)',
    ).toMatch(/npm publish --provenance/);
  });

  it('every pinned step is found by exactly one scanner match (no dead pins)', () => {
    // If a predicate matched two steps, index-based order pins could pass on
    // the wrong step; the workflow keeps one step per command.
    const steps = releaseSteps();
    const firstLines = steps
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined);
    expect(new Set(firstLines).size, 'duplicate step commands in the publish job').toBe(
      firstLines.length,
    );
  });
});
