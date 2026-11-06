import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The CI workflow supply-chain guard (task U-033, spec §4.4; decisions
 * D-045, D-157).
 *
 * The `install` job downloads the Node.js runtime archive straight from
 * nodejs.org — the most critical artifact the workflow consumes (everything
 * the clean-install smoke tests prove is proven about the runtime those
 * bytes install). Until U-033 that download was unverified: a compromised
 * mirror or CDN would have injected the very runtime the checks run on.
 * D-157 pins the mechanism: SHA-256 digests pinned HERE, in repository
 * history — the one trust domain a compromised CDN cannot rewrite — with a
 * run-time `SHASUMS256.txt` fetch explicitly rejected (it would verify the
 * mirror against itself). This spec is the mechanical half of the pin, the
 * U-029 line-scanner pattern (`test/unit/release-workflow.spec.ts`): a
 * small scanner over the workflow (no YAML dependency; the file is
 * actionlint-pinned to this block shape), every failure mode a loud
 * message telling the editor what must move with what.
 *
 * Pinned invariants (decision D-157):
 * - the download, verification, and extraction lines are EXACT shapes in
 *   download → verify → extract order, the extraction reading the exact
 *   path the digest verified — a `#`-prefixed, `|| true`-suffixed, or
 *   otherwise softened line fails the exact-shape pin by construction;
 * - the step stays fail-closed: `set +e` never appears in it and it
 *   carries no `continue-on-error:`, so a digest mismatch fails the job;
 * - the two digest literals are bound to their architecture arms (a swap
 *   or one-character corruption fails) and unknown architectures exit
 *   non-zero instead of downloading an empty-arch URL;
 * - the pinned version is consistent across every ci.yml site and the
 *   manifest — the install step's `version=` and name, the test matrix's
 *   declared-minimum entry and its comment's version mention, the
 *   timezone job's ICU-oracle pin, the install job's `node -v`
 *   expectation, the unsupported-node error grep, the documented SHASUMS
 *   source URL (derived from `PINNED_VERSION`, so a bump cannot leave it
 *   stale), and `package.json`'s `engines.node` —
 *   so ANY bump must edit `PINNED_VERSION` and `PINNED_DIGESTS` here in
 *   the same change (the D-155 deliberate-update discipline);
 * - the Dependabot half: both `dependabot.yml` update blocks keep
 *   declaring the `dependencies` label, and the `gh label create`
 *   repair for the label-is-repository-state residual stays documented.
 *
 * The hermetic suite cannot verify live repository metadata (and must not
 * try — no network); the text pins keep the declarations deliberate and
 * the repair discoverable.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const DEPENDABOT_CONFIG = path.join(REPO_ROOT, '.github/dependabot.yml');
const WORKFLOW_DOC = path.join(REPO_ROOT, 'docs/agents/workflow.md');

/**
 * The pinned Node runtime. The digests are the official
 * `SHASUMS256.txt` values for `node-v22.13.0-linux-<arch>.tar.xz`
 * (https://nodejs.org/dist/v22.13.0/SHASUMS256.txt, retrieved
 * 2026-11-04), re-verified by downloading and hashing both archives
 * before pinning. A version bump edits these constants, the workflow's
 * pinned lines, and `package.json`'s `engines.node` in one change.
 */
const PINNED_VERSION = '22.13.0';
const PINNED_DIGESTS = {
  x64: '3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6',
  arm64: '5de54a12983d0de6ba23597d4d0194e64933e26b0f04a469db3be9c3e18b6b2b',
} as const;

const SHASUMS_URL = `https://nodejs.org/dist/v${PINNED_VERSION}/SHASUMS256.txt`;

/** One `steps:` entry of the `install` job, in workflow order. */
interface WorkflowStep {
  name: string;
  /** Every raw workflow line of the step (name, `run:`, `with:`, …). */
  rawLines: string[];
  /** All lines of the step's `run:` block, if it has one. */
  runLines: string[];
}

function readCiWorkflow(): string {
  return readFileSync(CI_WORKFLOW, 'utf8');
}

/**
 * The ordered `steps:` list of the `install` job — a line scanner, not a
 * YAML parser (the U-029 pattern), bounded by the next job heading.
 * Throws loudly on every shape it does not recognize, never returns a
 * silently empty or truncated list.
 */
function installSteps(): WorkflowStep[] {
  const lines = readCiWorkflow().split('\n');
  const jobIndex = lines.findIndex((line) => line === '  install:');
  if (jobIndex === -1) {
    throw new Error(
      "the 'install:' job is missing from .github/workflows/ci.yml — the §4.4 " +
        'clean-install smoke tests would not exist; restore the job or retire ' +
        'this guard deliberately',
    );
  }
  const nextJob = lines.findIndex(
    (line, index) => index > jobIndex && /^ {2}[A-Za-z][A-Za-z0-9-]*:$/.test(line),
  );
  const jobLines = lines.slice(jobIndex + 1, nextJob === -1 ? lines.length : nextJob);
  const stepsIndex = jobLines.findIndex((line) => line === '    steps:');
  if (stepsIndex === -1) {
    throw new Error(
      "no 'steps:' key found inside the install job — if the workflow's shape " +
        'changed, update this scanner with it',
    );
  }
  const steps: WorkflowStep[] = [];
  let current: WorkflowStep | undefined;
  let runDepth = 0; // > 0 while collecting a multi-line `run: |` block
  for (const line of jobLines.slice(stepsIndex + 1)) {
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
          'an install-job step carries no name — named steps are the pinned shape ' +
            'this scanner (and the CI logs) read; name the step',
        );
      }
      continue; // job-level keys before the first step (container, matrix)
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
      'the install job has no steps — the clean-install smoke tests cannot ' +
        'run; restore the job (docs/agents/workflow.md describes the CI shape)',
    );
  }
  return steps;
}

/**
 * The Node-archive install step, found by its (version-agnostic) name
 * pattern. Renaming the step requires updating this scanner regex in the
 * same change (D-157).
 */
function nodeInstallStep(): WorkflowStep {
  const step = installSteps().find((candidate) =>
    /^Install Node\.js \d+\.\d+\.\d+ from official binaries$/.test(candidate.name),
  );
  if (step === undefined) {
    throw new Error(
      "the install job lost its 'Install Node.js <version> from official " +
        "binaries' step — the runtime the smoke tests run on would come back " +
        'unverified; restore the step (decision D-157) or update this scanner ' +
        'with the new name',
    );
  }
  return step;
}

/** Index of the exact line in the step's run block; -1 when absent. */
function runLineIndex(step: WorkflowStep, line: string): number {
  return step.runLines.indexOf(line);
}

describe('ci workflow guard (task U-033, spec §4.4; decisions D-045, D-157)', () => {
  it('downloads, verifies, and extracts the Node archive as exact shapes in that order', () => {
    const step = nodeInstallStep();
    const download = `curl -fsSL "https://nodejs.org/dist/v\${version}/node-v\${version}-linux-\${arch}.tar.xz" -o /tmp/node.tar.xz`;
    const verify = 'echo "${digest}  /tmp/node.tar.xz" | sha256sum -c -';
    const extract = 'tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs';
    const pairs: Array<[string, string]> = [
      [download, 'the pinned download line'],
      [verify, 'the pinned digest-verification line'],
      [extract, 'the pinned extraction line'],
    ];
    for (const [line, what] of pairs) {
      expect(
        step.runLines.includes(line),
        `${what} is missing or edited — the pin is an EXACT shape so any ` +
          'softening (a # prefix, a trailing || true, a rewritten pipe) fails ' +
          'here; restore the line (decision D-157)',
      ).toBe(true);
    }
    expect(
      runLineIndex(step, verify),
      'the digest check must run AFTER the download it verifies',
    ).toBeGreaterThan(runLineIndex(step, download));
    expect(
      runLineIndex(step, verify),
      'the digest check must run BEFORE the extraction — extracting first ' +
        'would execute the tarball parser on unverified bytes',
    ).toBeLessThan(runLineIndex(step, extract));
    expect(
      step.runLines.filter((line) => line === download).length +
        step.runLines.filter((line) => line === verify).length +
        step.runLines.filter((line) => line === extract).length,
      'each pinned triad line must appear exactly once — a duplicate would ' +
        'let an order pin pass on the wrong occurrence',
    ).toBe(3);
  });

  it('the verification is fail-closed: no set +e in the step, no continue-on-error on it', () => {
    const step = nodeInstallStep();
    expect(
      step.runLines.some((line) => line.includes('set +e')),
      '`set +e` inside the step would let a digest mismatch pass: execution ' +
        "continues and the step exits with the LAST command's status — remove " +
        'it (the runner default shell for run: is bash -e, which aborts on the ' +
        'verify pipeline non-zero exit; decision D-157)',
    ).toBe(false);
    expect(
      step.rawLines.some((line) => line.includes('continue-on-error')),
      '`continue-on-error` on this step would downgrade a digest mismatch to ' +
        'a warning — remove it (decision D-157)',
    ).toBe(false);
  });

  it('the digests are bound to their architecture arms and unknown architectures exit non-zero', () => {
    const step = nodeInstallStep();
    // The case body sits one indent level deeper than the step's top-level
    // commands; the scanner keeps that inner indentation verbatim.
    const arms: Array<[string, string]> = [
      [`  x86_64) arch=x64; digest=${PINNED_DIGESTS.x64} ;;`, 'the x86_64 arm'],
      [`  aarch64) arch=arm64; digest=${PINNED_DIGESTS.arm64} ;;`, 'the aarch64 arm'],
    ];
    for (const [line, what] of arms) {
      expect(
        step.runLines.includes(line),
        `${what} must bind its architecture to its pinned digest as an exact ` +
          'line — a swapped or corrupted digest fails here (decision D-157)',
      ).toBe(true);
    }
    const failClosed = step.runLines.find((line) => line.trimStart().startsWith('*)'));
    expect(
      failClosed,
      'the case statement needs a fail-closed *) arm — without it an unknown ' +
        'runner architecture would download an empty-arch URL (decision D-157)',
    ).toBeDefined();
    expect(failClosed, 'the *) arm must exit non-zero, not fall through to the download').toContain(
      'exit 1',
    );
  });

  it('the pinned Node version is consistent across ci.yml, the digests source, and the manifest', () => {
    const step = nodeInstallStep();
    const text = readCiWorkflow();
    expect(
      step.runLines.includes(`version=${PINNED_VERSION}`),
      "the install step's version= variable must equal PINNED_VERSION — every " +
        'other site below is compared against this constant',
    ).toBe(true);
    expect(step.name, 'the step name embeds the pinned version').toBe(
      `Install Node.js ${PINNED_VERSION} from official binaries`,
    );
    const sites: Array<[string, string]> = [
      [`'${PINNED_VERSION}'`, "the test matrix's declared-minimum entry"],
      [
        `(${PINNED_VERSION}, required for flagless node:sqlite)`,
        "the test matrix comment's declared-minimum mention",
      ],
      [`node-version: ${PINNED_VERSION}`, 'the timezone job ICU-oracle pin'],
      [`test "$(node -v)" = "v${PINNED_VERSION}"`, "the install job's runtime expectation"],
      [`grep -F "${PINNED_VERSION}"`, "the unsupported-node job's error grep"],
      [SHASUMS_URL, 'the documented SHASUMS source URL'],
    ];
    for (const [needle, what] of sites) {
      expect(text, `${what} must stay on the pinned version`).toContain(needle);
    }
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(
      manifest.engines?.node,
      "package.json's engines.node must stay on the pinned minimum — a bump " +
        'that skips the manifest leaves the declared support behind',
    ).toBe(`>=${PINNED_VERSION}`);
  });

  it('both Dependabot update blocks keep declaring the label, and its repair stays documented', () => {
    const dependabot = readFileSync(DEPENDABOT_CONFIG, 'utf8');
    const declarations = dependabot
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line === '- dependencies').length;
    expect(
      declarations,
      'both dependabot.yml update blocks (npm and github-actions) must keep ' +
        'declaring the dependencies label — it exists as repository metadata ' +
        '(created per D-157), and removing the declaration only makes the ' +
        'reference implicit (Dependabot defaults use the same label)',
    ).toBe(2);
    const repair = 'gh label create dependencies --repo yepbro/quotameter';
    expect(
      dependabot,
      'the dependabot.yml header must keep the documented repair one-liner ' +
        '(the label is repository state, not content — forks re-break until ' +
        'it runs; decision D-157)',
    ).toContain(repair);
    expect(
      readFileSync(WORKFLOW_DOC, 'utf8'),
      'docs/agents/workflow.md must keep documenting the repair one-liner ' +
        'beside the Dependabot section (decision D-157)',
    ).toContain(repair);
  });
});
