import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The mutation workflow honesty guard (task U-046, spec §4.4, §17.3;
 * decisions D-045, D-054, D-172).
 *
 * Between 2026-11-01 and U-046, a daily run that died in Stryker's initial
 * test run (U-045's `ConfigError`) was reported as a QUALITY REGRESSION:
 * `steps.stryker.outcome` is `failure` for any Stryker-step failure, the
 * render step's shell redirect held an empty body after the renderer's
 * ENOENT, the upsert blanked the rolling issue with it, and the title,
 * comment, and final `::error` all claimed a below-break score that was
 * never measured. D-172's mechanism: the report file's existence — not the
 * step outcome — supplies every verdict claim; a crashed run posts its
 * crash report to the comment thread and never replaces the last scored
 * body.
 *
 * This spec is the U-029/U-033 line-scanner pattern
 * (`test/unit/ci-workflow.spec.ts`): a small scanner over the workflow (no
 * YAML dependency; actionlint validates the syntax), every failure mode a
 * loud message telling the editor what must move with what. The renderer
 * half of the contract lives in `test/unit/render-mutation-report.spec.ts`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/mutation.yml');
const REPORT_JSON = 'reports/mutation/mutation.json';

/** One `steps:` entry of the single `mutation` job, in workflow order. */
interface WorkflowStep {
  name: string;
  /** Every raw workflow line of the step (name, `run:`, `if:`, `env:`, …). */
  rawLines: string[];
  /** All lines of the step's `run:` block, if it has one. */
  runLines: string[];
}

/**
 * The ordered `steps:` list of the `mutation` job — a line scanner, not a
 * YAML parser (the U-029 pattern). Throws loudly on every shape it does
 * not recognize, never returns a silently empty or truncated list.
 */
function mutationSteps(): WorkflowStep[] {
  const lines = readFileSync(WORKFLOW_PATH, 'utf8').split('\n');
  const stepsIndex = lines.findIndex((line) => line === '    steps:');
  if (stepsIndex === -1) {
    throw new Error(
      "no 'steps:' key found in .github/workflows/mutation.yml — if the " +
        "workflow's shape changed, update this scanner with it",
    );
  }
  const steps: WorkflowStep[] = [];
  let current: WorkflowStep | undefined;
  let runDepth = 0; // > 0 while collecting a multi-line `run: |` block
  for (const line of lines.slice(stepsIndex + 1)) {
    const stepStart = /^ {6}- name: (.+?)\s*$/.exec(line);
    if (stepStart?.[1]) {
      current = { name: stepStart[1], rawLines: [line], runLines: [] };
      steps.push(current);
      runDepth = 0;
      continue;
    }
    if (current === undefined) {
      if (/^ {6}- /.test(line)) {
        throw new Error(
          'a mutation-job step carries no name — named steps are the pinned shape ' +
            'this scanner (and the run logs) read; name the step',
        );
      }
      continue; // job-level keys before the first step (container, runs-on)
    }
    current.rawLines.push(line);
    if (runDepth > 0) {
      if (line.trim().length === 0) {
        continue; // YAML keeps a block scalar alive through blank lines
      }
      const blockLine = /^ {10}(.*)$/.exec(line);
      if (blockLine?.[1] !== undefined) {
        current.runLines.push(blockLine[1]);
        continue;
      }
      runDepth = 0; // block ended; the line was already captured as raw
      continue;
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
      'the mutation job has no steps — the daily mutation gate would not ' +
        'exist; restore the workflow (docs/mutation-testing.md, decision D-045)',
    );
  }
  return steps;
}

function stepByName(pattern: RegExp, what: string): WorkflowStep {
  const step = mutationSteps().find((candidate) => pattern.test(candidate.name));
  if (step === undefined) {
    throw new Error(
      `${what} — the step is missing from .github/workflows/mutation.yml; ` +
        'restore it (decision D-172) or update this guard with the new name',
    );
  }
  return step;
}

describe('mutation workflow honesty guard (task U-046, spec §4.4, §17.3; decisions D-045, D-172)', () => {
  it('the Stryker step tees its output and keeps failing loudly, not fatally', () => {
    const step = stepByName(/^Run mutation tests$/, "the 'Run mutation tests' step is missing");
    expect(
      step.rawLines.some((line) => line.trim() === 'continue-on-error: true'),
      'continue-on-error must stay: a below-threshold score still produces the triage issue (D-045)',
    ).toBe(true);
    expect(
      step.rawLines.some((line) => line.trim() === 'shell: bash'),
      'shell: bash supplies -eo pipefail — without it the tee pipeline would ' +
        "report tee's exit status and a crashed Stryker would look successful (D-172)",
    ).toBe(true);
    expect(
      step.runLines.includes(
        '  env HOME=/home/node npm run test:mutation 2>&1 | tee /tmp/stryker-output.log',
      ),
      'the exact tee line is pinned (two-space block indentation kept verbatim, ' +
        'the U-033 scanner convention): the crash report extracts its failing ' +
        'tests from /tmp/stryker-output.log, so a rewritten pipe breaks the contract',
    ).toBe(true);
    expect(
      step.runLines.some((line) => line.includes('set +e')),
      '`set +e` would let a Stryker crash exit 0 — remove it',
    ).toBe(false);
  });

  it('the Stryker output log is preserved as the artifact exactly when no report was produced', () => {
    const steps = mutationSteps();
    const preserve = stepByName(
      /^Preserve the Stryker output log when no report was produced$/,
      'the log-preservation step is missing',
    );
    // Index by NAME against the same `steps` parse: `stepByName` re-reads the
    // workflow, so its object identities never match this array's (the review
    // round's P2 — a `=== preserve` findIndex returned -1 and the ordering
    // pin below held vacuously).
    const preserveIndex = steps.findIndex((step) => step.name === preserve.name);
    const artifactIndex = steps.findIndex((step) =>
      /^Retain mutation report artifact$/.test(step.name),
    );
    if (artifactIndex === -1) {
      throw new Error("the 'Retain mutation report artifact' step is missing — restore it (D-045)");
    }
    expect(
      preserveIndex,
      'the log-preservation step must exist in the scanned order (a -1 here ' +
        'would make the ordering pin below vacuous)',
    ).toBeGreaterThan(-1);
    expect(
      preserve.rawLines.some((line) => line.trim() === 'if: always()'),
      'the log must be preserved on a crashed run — the step that failed is the reason it exists',
    ).toBe(true);
    expect(
      preserve.runLines.includes(
        `if [ ! -f ${REPORT_JSON} ] && [ -s /tmp/stryker-output.log ]; then`,
      ),
      'the guard is the honesty pin: the log is copied ONLY when no report ' +
        'exists (a scored run uploads its report, not its huge progress log)',
    ).toBe(true);
    expect(
      preserve.runLines.includes('  cp /tmp/stryker-output.log reports/mutation/'),
      'the copy target is the artifact upload path — reports/mutation/ is what the artifact step reads',
    ).toBe(true);
    expect(
      preserveIndex,
      'the log must be copied BEFORE the artifact upload runs — after it, the crash evidence never uploads',
    ).toBeLessThan(artifactIndex);
  });

  it('the render step feeds the captured log to the committed renderer', () => {
    const step = stepByName(
      /^Render report markdown$/,
      "the 'Render report markdown' step is missing",
    );
    expect(
      step.rawLines.some((line) => line.trim() === 'STRYKER_LOG_FILE: /tmp/stryker-output.log'),
      'the renderer reads the Stryker log through STRYKER_LOG_FILE — without ' +
        'the env wiring the crash body cannot list the failing initial-run tests',
    ).toBe(true);
    expect(
      step.rawLines.some((line) => line.trim() === 'if: always()'),
      'the render step runs on a crashed run too — that is the case it now serves (D-172)',
    ).toBe(true);
  });

  it('every pipefail-using step declares bash, and gh is installed before its first use', () => {
    const steps = mutationSteps();

    // The D-162 container's default step shell is `sh` (dash), where
    // `set -o pipefail` is illegal: the upsert step died at line 1 with
    // "set: Illegal option -o pipefail" (exit 2) on every container run
    // until it declared `shell: bash` (task 197, D-207). The rule is
    // generic — any step whose script uses pipefail must declare bash —
    // so the next pipefail step cannot regress silently.
    for (const step of steps) {
      if (!step.runLines.some((line) => line.includes('pipefail'))) continue;
      expect(
        step.rawLines.some((line) => line.trim() === 'shell: bash'),
        `${step.name}: uses pipefail but does not declare shell: bash — under ` +
          'the container default sh the step dies at "set: Illegal option -o ' +
          'pipefail" (D-207)',
      ).toBe(true);
    }

    // The same blind spot hid a second defect (the review round's P1):
    // `gh` is preinstalled on the hosted RUNNER image, not inside the
    // node container, so the upsert would have died at `gh: command not
    // found` (exit 127) even with bash. The install step must exist,
    // verify its tarball against pinned digests, self-check, and run
    // before the first step that invokes gh.
    const install = steps.find((step) => /^Install the GitHub CLI/.test(step.name));
    expect(
      install,
      'the digest-pinned gh install step is missing — without it the upsert ' +
        'step exits 127 at the first gh call inside the container (D-207)',
    ).toBeDefined();
    const firstGhUse = steps.findIndex((step) =>
      step.runLines.some((line) => /\bgh \w/.test(line)),
    );
    const installIndex = steps.findIndex((step) => step.name === install?.name);
    expect(
      firstGhUse,
      'some step invokes gh — the ordering pin below needs that step to exist',
    ).toBeGreaterThan(-1);
    expect(
      installIndex,
      'the install step must exist in the scanned order (a -1 here would ' +
        'make the ordering pin vacuous)',
    ).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(firstGhUse);
    expect(
      install?.runLines.includes('echo "${digest}  /tmp/gh.tar.gz" | sha256sum -c -'),
      'the gh tarball must be digest-verified (the D-157 posture): a bare ' +
        'download trusts the release CDN against itself',
    ).toBe(true);
    // The version and BOTH architecture digests move together: the pinned
    // literals appear verbatim, once each (a bumped version that leaves a
    // digest behind fails here).
    for (const literal of [
      'version=2.103.3',
      'digest=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
      'digest=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63',
    ]) {
      expect(
        install?.runLines.filter((line) => line.includes(literal)).length,
        `the gh pin "${literal.slice(0, 24)}…" must appear exactly once — a ` +
          'version bump edits the version and both digests in one change',
      ).toBe(1);
    }
    expect(
      install?.runLines.some((line) => line.trim() === 'gh --version'),
      'the install step self-checks — a broken binary must fail the job at ' +
        'install time, not at the first triage call',
    ).toBe(true);

    // And the upsert step itself declares bash (the pipefail rule above
    // holds because its `set -euo pipefail` line is now legal — pin the
    // declaration explicitly so removing it is a named failure).
    const upsert = stepByName(
      /^Upsert the triage issue$/,
      "the 'Upsert the triage issue' step is missing",
    );
    expect(
      upsert.rawLines.some((line) => line.trim() === 'shell: bash'),
      'the upsert step runs under bash — its set -euo pipefail is illegal ' +
        "under the container's default sh (D-207)",
    ).toBe(true);
  });

  it('the upsert verdict comes from the report file, not the step outcome', () => {
    const step = stepByName(
      /^Upsert the triage issue$/,
      "the 'Upsert the triage issue' step is missing",
    );
    expect(
      step.runLines.includes('if [ -f "$report" ]; then'),
      'the report-existence branch is the discriminator: steps.stryker.outcome ' +
        'is failure for ANY Stryker failure, so the outcome alone must never ' +
        'supply the verdict wording (D-172)',
    ).toBe(true);
    expect(
      step.runLines.includes('  verdict="crashed (no report produced)"'),
      'the crashed verdict is pinned verbatim (else-arm indentation kept) — it appears in the issue title',
    ).toBe(true);
    expect(
      step.runLines.includes('if [ -f "$report" ] && [ -s "$body" ]; then'),
      'the ONLY branch that may write a body combines a scored report with a ' +
        'non-empty rendered body — a crash or an empty body must never reach --body-file',
    ).toBe(true);
    expect(
      step.runLines.filter((line) => line.includes('gh issue edit') && line.includes('--body-file'))
        .length,
      'exactly one gh issue edit carries --body-file (the scored branch); a ' +
        'second one anywhere else reintroduces the body-blanking path U-046 closed',
    ).toBe(1);
    expect(
      step.runLines.filter(
        (line) => line.includes('gh issue create') && line.includes('--body-file'),
      ).length,
      'issue creation keeps needing a body file or a literal body (gh refuses ' +
        'interactive bodies headlessly) — count stays in lockstep with the branches',
    ).toBe(2);
    expect(
      step.runLines.some((line) => line.includes('the report renderer produced no output')),
      'the renderer-aborted arm must say so honestly instead of claiming a report exists',
    ).toBe(true);
    expect(
      step.runLines.some((line) => line.includes('no score was measured')),
      'the crashed-run comments must state that no score was measured',
    ).toBe(true);
  });

  it('the final step fails the job with wording that matches what actually happened', () => {
    const step = stepByName(
      /^Fail the job after reporting when the gate is not green$/,
      "the final 'fail the job' step is missing",
    );
    expect(
      step.rawLines.some((line) => line.trim().startsWith('if: steps.stryker.outcome')),
      'the step keys off the Stryker step outcome (either failure mode stays red)',
    ).toBe(true);
    const belowBreak = step.runLines.indexOf(
      '  echo "::error::Mutation score is below the configured break threshold; see the mutation-report issue."',
    );
    const crashed = step.runLines.indexOf(
      '  echo "::error::Stryker exited without producing a mutation report — no score was measured; see the mutation-report issue."',
    );
    const gate = step.runLines.indexOf(`if [ -f ${REPORT_JSON} ]; then`);
    expect(
      belowBreak,
      'the below-break message is pinned verbatim (it feeds the run annotation)',
    ).toBeGreaterThan(-1);
    expect(
      crashed,
      'the crashed-run message is pinned verbatim — a phantom score claim fails here',
    ).toBeGreaterThan(-1);
    expect(
      gate,
      'the message must branch on the report file, not the step outcome (D-172)',
    ).toBeGreaterThan(-1);
    expect(
      gate < belowBreak && belowBreak < crashed,
      'the below-break wording may appear only inside the report-exists arm',
    ).toBe(true);
  });
});
