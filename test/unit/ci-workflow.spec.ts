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
 * Pinned invariants (decision D-157, extended to the two-runtime §17.2
 * matrix by task 195/D-203):
 * - the download, verification, and extraction lines are EXACT shapes in
 *   download → verify → extract order, the extraction reading the exact
 *   path the digest verified — a `#`-prefixed, `|| true`-suffixed, or
 *   otherwise softened line fails the exact-shape pin by construction;
 * - the step stays fail-closed: `set +e` never appears in it and it
 *   carries no `continue-on-error:`, so a digest mismatch fails the job;
 * - every pinned runtime (the declared minimum and the current LTS line
 *   of spec §17.2's "Node 22 and 24") is one matrix entry binding its
 *   version to BOTH architecture digests — a swapped or corrupted digest
 *   fails the exact-entry pin — and the step's case arms read exactly
 *   those matrix keys, so a runtime and its digests cannot drift apart;
 *   unknown architectures exit non-zero instead of downloading an
 *   empty-arch URL;
 * - the declared minimum is consistent across every ci.yml site and the
 *   manifest — the install matrix's minimum entry, the test matrix's
 *   declared-minimum entry and its comment's version mention, the
 *   timezone job's ICU-oracle pin, the unsupported-node error grep, the
 *   documented SHASUMS source URLs (derived from `PINNED_RUNTIMES`, so a
 *   bump cannot leave one stale), and `package.json`'s `engines.node` —
 *   so ANY bump must edit `PINNED_RUNTIMES` here in the same change (the
 *   D-155 deliberate-update discipline);
 * - the §17.2 init matrix (task 195, D-203): the install job runs
 *   `init --yes` non-interactively AFTER the installed-CLI proof, with
 *   the provider host blackholed, as a non-root account, stdin closed,
 *   and fail-closed artifact assertions — see the dedicated test.
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

/** One pinned runtime of the install matrix's `node:` axis. */
interface PinnedRuntime {
  /** What the entry is (install-matrix documentation, assertion text). */
  readonly role: string;
  /** The exact runtime version the matrix entry declares. */
  readonly version: string;
  /** The official SHASUMS256.txt digests, re-verified before pinning. */
  readonly digests: Readonly<{ x64: string; arm64: string }>;
}

/**
 * The pinned Node runtimes of the install matrix (task 195, spec §17.2:
 * "with Node 22 and 24", decision D-203 extending D-157 to two entries).
 * The digests are the official `SHASUMS256.txt` values for
 * `node-v<version>-linux-<arch>.tar.xz`, re-verified by downloading and
 * hashing both archives of each version before pinning:
 * - 22.13.0: https://nodejs.org/dist/v22.13.0/SHASUMS256.txt (2026-11-04)
 * - 24.22.2: https://nodejs.org/dist/v24.22.2/SHASUMS256.txt (2026-11-08)
 *
 * A version bump edits an entry here and the workflow's matrix `node:`
 * block in one change; the declared minimum additionally moves with the
 * test matrix, the timezone job, the unsupported-node grep, and
 * `package.json`'s `engines.node` (the consistency test below).
 */
const PINNED_MINIMUM: PinnedRuntime = {
  role: 'the declared minimum',
  version: '22.13.0',
  digests: {
    x64: '3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6',
    arm64: '5de54a12983d0de6ba23597d4d0194e64933e26b0f04a469db3be9c3e18b6b2b',
  },
};

const PINNED_LTS: PinnedRuntime = {
  role: 'the 24 LTS line §17.2 names',
  version: '24.22.2',
  digests: {
    x64: '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75',
    arm64: 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8',
  },
};

const PINNED_RUNTIMES: readonly PinnedRuntime[] = [PINNED_MINIMUM, PINNED_LTS];

const shasumsUrl = (runtime: PinnedRuntime): string =>
  `https://nodejs.org/dist/v${runtime.version}/SHASUMS256.txt`;

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
 * The install job's own lines (between its heading and the next job
 * heading) — the home of the strategy/matrix block the runtime pins read.
 * Same bounded-scanner discipline as {@link installSteps}: throws loudly
 * when the job disappears instead of returning silently empty lines.
 */
function installJobLines(): string[] {
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
  return lines.slice(jobIndex + 1, nextJob === -1 ? lines.length : nextJob);
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
 * The Node-archive install step, found by its exact (parameterized) name.
 * Renaming the step requires updating this constant in the same change
 * (D-157; the name reads the matrix version since task 195's two-runtime
 * axis, D-203).
 */
const NODE_INSTALL_STEP_NAME = 'Install Node.js ${{ matrix.node.version }} from official binaries';

function nodeInstallStep(): WorkflowStep {
  const step = installSteps().find((candidate) => candidate.name === NODE_INSTALL_STEP_NAME);
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

  it('every pinned runtime is one matrix entry binding its version to both digests', () => {
    // Task 195 (spec §17.2, D-203): the install matrix's runtime axis is
    // exactly the two lines the spec names — the declared minimum and the
    // current LTS — each entry an EXACT three-line shape binding the
    // version to both architecture digests. A swapped or corrupted digest
    // fails here by construction; a third runtime joins by adding an
    // entry here and in PINNED_RUNTIMES in the same change.
    const jobLines = installJobLines();
    for (const runtime of PINNED_RUNTIMES) {
      const entry: Array<[string, string]> = [
        [`          - version: '${runtime.version}'`, `${runtime.role}: the version line`],
        [`            digest_x64: ${runtime.digests.x64}`, `${runtime.role}: the x64 digest`],
        [`            digest_arm64: ${runtime.digests.arm64}`, `${runtime.role}: the arm64 digest`],
      ];
      for (const [line, what] of entry) {
        expect(
          jobLines.includes(line),
          `${what} is missing or edited in the install matrix — the pin is an ` +
            'EXACT shape so a corrupted digest or a re-indented entry fails here ' +
            '(decision D-157/D-203)',
        ).toBe(true);
      }
    }
    expect(
      jobLines.filter((line) => /^ {10}- version: /.test(line)).length,
      'the install matrix declares exactly the two pinned runtimes — an extra ' +
        'runtime entry without a PINNED_RUNTIMES counterpart (or vice versa) ' +
        'would make this count disagree with the loop above',
    ).toBe(PINNED_RUNTIMES.length);
  });

  it('the digests are bound to their architecture arms and unknown architectures exit non-zero', () => {
    const step = nodeInstallStep();
    // The case body sits one indent level deeper than the step's top-level
    // commands; the scanner keeps that inner indentation verbatim. The
    // arms read the matrix keys the entry test above pins, so a runtime's
    // digests cannot drift from the archive its cell downloads.
    const arms: Array<[string, string]> = [
      ['  x86_64) arch=x64; digest=${{ matrix.node.digest_x64 }} ;;', 'the x86_64 arm'],
      ['  aarch64) arch=arm64; digest=${{ matrix.node.digest_arm64 }} ;;', 'the aarch64 arm'],
    ];
    for (const [line, what] of arms) {
      expect(
        step.runLines.includes(line),
        `${what} must bind its architecture to its matrix digest key as an exact ` +
          'line — hardcoding a literal here would desynchronize the digest from ' +
          'the matrix entry (decisions D-157/D-203)',
      ).toBe(true);
    }
    expect(
      step.runLines.includes('version=${{ matrix.node.version }}'),
      'the version must come from the matrix entry — a hardcoded version would ' +
        'make one runtime cell verify another runtime',
    ).toBe(true);
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

  it('the pinned runtime is verified after install and the declared minimum is consistent everywhere', () => {
    const text = readCiWorkflow();
    // The install job's runtime expectation reads the matrix (any pinned
    // runtime is verified in its own cell); the minimum additionally
    // anchors the runtime-floor sites below, which must never float to a
    // newer line while `engines.node` still declares the minimum.
    const steps = installSteps();
    const verify = steps.find((candidate) => candidate.name === 'Verify the pinned runtime');
    expect(
      verify,
      "the install job lost its 'Verify the pinned runtime' step — a mis-installed " +
        'runtime would surface only as confusing downstream failures',
    ).toBeDefined();
    expect(
      verify?.runLines.includes('test "$(node -v)" = "v${{ matrix.node.version }}"'),
      'the runtime expectation must read the matrix entry (decision D-203)',
    ).toBe(true);
    const sites: Array<[string, string]> = [
      [`          - version: '${PINNED_MINIMUM.version}'`, 'the install matrix minimum entry'],
      [`        node: ['${PINNED_MINIMUM.version}', '22', '24']`, "the test matrix's node list"],
      [
        `(${PINNED_MINIMUM.version}, required for flagless node:sqlite)`,
        "the test matrix comment's declared-minimum mention",
      ],
      [`node-version: ${PINNED_MINIMUM.version}`, 'the timezone job ICU-oracle pin'],
      [`grep -F "${PINNED_MINIMUM.version}"`, "the unsupported-node job's error grep"],
      ...PINNED_RUNTIMES.map(
        (runtime) =>
          [shasumsUrl(runtime), `the documented SHASUMS source URL for ${runtime.version}`] as [
            string,
            string,
          ],
      ),
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
    ).toBe(`>=${PINNED_MINIMUM.version}`);
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

  it('the package job builds the compiled CLI before the tarball check and the pack', () => {
    // Task 185 (spec §17.2, D-195): the install job's smoke steps run the
    // installed `quotameter` through the compiled dist/ shipped in the
    // tarball — so the pack cannot happen without the build, and
    // check:package must validate the built dist/ entries too.
    const text = readCiWorkflow();
    const lines = text.split('\n');
    const jobIndex = lines.findIndex((line) => line === '  package:');
    expect(jobIndex, "the 'package:' job is missing from ci.yml").toBeGreaterThan(-1);
    const jobEnd = lines.findIndex(
      (line, index) => index > jobIndex && /^ {2}[A-Za-z][A-Za-z0-9-]*:$/.test(line),
    );
    const jobLines = lines.slice(jobIndex, jobEnd === -1 ? lines.length : jobEnd);
    const buildIndex = jobLines.findIndex((line) => line.trim() === 'run: npm run build:cli');
    const checkIndex = jobLines.findIndex((line) => line.trim() === 'run: npm run check:package');
    const packIndex = jobLines.findIndex((line) => line.trim() === 'run: npm pack');
    expect(buildIndex, 'the package job must run `npm run build:cli`').toBeGreaterThan(-1);
    expect(
      checkIndex,
      'the package job must keep its tarball allowlist check (npm run check:package)',
    ).toBeGreaterThan(-1);
    expect(packIndex, 'the package job must keep packing (npm pack)').toBeGreaterThan(-1);
    expect(
      buildIndex,
      'build:cli must precede check:package — the check validates the packed dist/',
    ).toBeLessThan(checkIndex);
    expect(
      buildIndex,
      'build:cli must precede the pack — the smoke-test tarball carries dist/',
    ).toBeLessThan(packIndex);
  });

  it('the install job runs a real command through the installed CLI (dist resolution)', () => {
    // The --version fast path proves nothing about the packaged CLI (it
    // never loads the command modules); --help loads the whole compiled
    // dispatch graph. A tarball without dist/ fails this step loudly.
    const steps = installSteps();
    const step = steps.find((candidate) =>
      candidate.runLines.some((line) => line.includes('quotameter --help')),
    );
    expect(
      step,
      'the install job lost its real-command step (quotameter --help) — the clean ' +
        'global-install proof of task 185 (D-195) would be gone; restore the step or ' +
        'update this guard with its replacement',
    ).toBeDefined();
    expect(
      step?.runLines.some((line) => line.includes('Usage: quotameter')),
      'the step must assert the rendered command table, not just a zero exit',
    ).toBe(true);
  });

  it('the install job proves the container is compiler-free before the tarball install', () => {
    // Task 186 (spec §3/§17.2, D-196): the no-install-time-build proof needs
    // a container where native compilation is IMPOSSIBLE. The tool list is
    // an exact pin — dropping a compiler from it would silently weaken what
    // the matrix proves.
    const steps = installSteps();
    const toolchain = steps.findIndex(
      (candidate) => candidate.name === 'Verify the container ships no build toolchain',
    );
    expect(
      toolchain,
      "the install job lost its 'Verify the container ships no build toolchain' step — the " +
        'compiler-free proof of task 186 (D-196) would be gone; restore the step or update ' +
        'this guard with its replacement',
    ).toBeGreaterThan(-1);
    const runLines = steps[toolchain]?.runLines ?? [];
    expect(
      runLines.includes('for tool in gcc cc g++ clang make python3 python; do'),
      'the toolchain check must cover exactly the pinned compiler/interpreter set — ' +
        'gcc cc g++ clang make python3 python (decision D-196)',
    ).toBe(true);
    expect(
      runLines.some((line) => line.includes('command -v "$tool"')),
      'the toolchain check must probe each tool with command -v',
    ).toBe(true);
    expect(
      runLines.some((line) => line.trim() === 'exit 1'),
      'the toolchain check must exit non-zero when a tool is present — a warning-only ' +
        'check would let the matrix silently run with a compiler',
    ).toBe(true);
    expect(
      steps[toolchain]?.rawLines.some((line) => line.includes('continue-on-error')),
      'continue-on-error on the toolchain check would downgrade a present compiler to a ' +
        'warning — the D-157 fail-closed rule for every install-job guard step',
    ).toBe(false);
    const install = steps.findIndex(
      (candidate) => candidate.name === 'Install the package globally from the tarball',
    );
    expect(
      toolchain,
      'the toolchain check must run BEFORE the tarball install it guards',
    ).toBeLessThan(install);
  });

  it('the tarball install surfaces lifecycle scripts (--foreground-scripts)', () => {
    // Task 186 (D-196): with the structural pins asserting no script
    // exists, running the install with --foreground-scripts turns any
    // regression into a visible line in the job log instead of hidden
    // detached output.
    const step = installSteps().find(
      (candidate) => candidate.name === 'Install the package globally from the tarball',
    );
    expect(
      step,
      "the 'Install the package globally from the tarball' step is missing",
    ).toBeDefined();
    expect(
      step?.runLines.includes(
        'npm install --global --prefix /usr/local --foreground-scripts ./quotameter-*.tgz',
      ),
      'the install command must keep --foreground-scripts (task 186, D-196) — it surfaces ' +
        'any dependency lifecycle script the moment it runs',
    ).toBe(true);
  });

  it('the install job verifies the installed package: no scripts, no natives, dist present', () => {
    // Task 186 (spec §3/§17.2, D-196): the post-install verification trio —
    // the installed manifest (what npm actually read), the installed tree
    // (nothing native shipped or compiled, and no install script anywhere
    // npm wrote — a consumer install re-resolves dependency ranges against
    // the live registry, so the scan reads the tree npm laid down on THIS
    // run), and the compiled CLI the tarball must already carry (task 185,
    // D-195). Every step must stay fail-closed: the failure expressions
    // are pinned and continue-on-error banned (the D-157 rule).
    const steps = installSteps();
    const byName = (name: string) => steps.findIndex((candidate) => candidate.name === name);
    const install = byName('Install the package globally from the tarball');

    const lifecycle = byName('Verify the installed manifest has no install-time lifecycle scripts');
    expect(
      lifecycle,
      'the install job lost its installed-manifest lifecycle check — the shipped tarball ' +
        'could grow an install-time script without any gate noticing (task 186, D-196)',
    ).toBeGreaterThan(-1);
    const lifecycleLines = steps[lifecycle]?.runLines ?? [];
    expect(
      lifecycleLines.some((line) =>
        line.includes(
          '"preinstall","install","postinstall","preprepare","prepare","postprepare","prepublish"',
        ),
      ),
      "the lifecycle check must ban npm's complete install-time set, matching the manifest pin",
    ).toBe(true);
    expect(
      lifecycleLines.some((line) => line.includes('process.exit(1)')),
      'the lifecycle check must fail the job (process.exit(1)), not just log — deleting the ' +
        'failure branch would otherwise keep this pin green',
    ).toBe(true);

    const natives = byName(
      'Verify the installed tree contains no native addons or install scripts',
    );
    expect(
      natives,
      'the install job lost its installed-tree scan — a dependency shipping prebuilt or ' +
        'compiled addons, or an install script in the registry-resolved tree, would install ' +
        'unnoticed (task 186, D-196)',
    ).toBeGreaterThan(-1);
    const nativeLines = steps[natives]?.runLines ?? [];
    expect(
      nativeLines.some((line) => line.includes('binding.gyp')) &&
        nativeLines.some((line) => line.includes('endsWith(".node")')),
      'the installed-tree scan must look for both *.node binaries and binding.gyp recipes',
    ).toBe(true);
    expect(
      nativeLines.some((line) =>
        line.includes('const banned=["preinstall","install","postinstall"]'),
      ),
      "the tree scan must also check every installed package's manifest for install scripts — the " +
        'lockfile pins guard the snapshot, this guards what npm resolved THIS run',
    ).toBe(true);
    expect(
      nativeLines.some((line) => line.includes('process.exit(1)')),
      'the tree scan must fail the job when an offender is found, not just log',
    ).toBe(true);

    const dist = byName('Verify the installed tree ships the compiled CLI (dist)');
    expect(
      dist,
      'the install job lost its dist-presence check — a tarball without the compiled CLI ' +
        'would need an install-time build (task 186, D-195/D-196)',
    ).toBeGreaterThan(-1);
    const distLines = steps[dist]?.runLines ?? [];
    expect(
      distLines.some((line) => line.includes('dist/cli/main.js')),
      'the dist check must assert the entry the launcher resolves (dist/cli/main.js)',
    ).toBe(true);
    expect(
      distLines.some((line) => line.trim() === 'exit 1'),
      'the dist check must fail the job, not warn',
    ).toBe(true);

    for (const [index, what] of [
      [lifecycle, 'the lifecycle check'],
      [natives, 'the installed-tree scan'],
      [dist, 'the dist-presence check'],
    ] as const) {
      expect(index, `${what} must run AFTER the tarball install`).toBeGreaterThan(install);
      expect(
        steps[index]?.rawLines.some((line) => line.includes('continue-on-error')),
        `${what} must not carry continue-on-error — it would downgrade a real failure to a ` +
          'warning (the D-157 fail-closed rule)',
      ).toBe(false);
    }
  });

  it('the install job runs init --yes non-interactively with the provider blackholed', () => {
    // Task 195 (spec §17.2, D-203): `init --yes` must complete in every
    // clean matrix cell with NO network path to the provider. Every arm
    // of the step is pinned as an EXACT fail-closed block (start line +
    // echo + `exit 1` + closing line) — a presence-only pin would let a
    // later edit drop or soften an arm while this guard stays green (the
    // review round's P2, reproduced live), so the arm count is exact and
    // the pre-run ordering (blackhole → resolver check → account → run)
    // is asserted by index, the way the --help order pin works.
    const steps = installSteps();
    const index = steps.findIndex(
      (candidate) => candidate.name === 'Run init --yes non-interactively without provider access',
    );
    expect(
      index,
      "the install job lost its init --yes step — §17.2's non-interactive " +
        'initialization would no longer be proven in the clean matrix (task 195, ' +
        'D-203); restore the step or update this guard with its replacement',
    ).toBeGreaterThan(-1);
    const lines = steps[index]?.runLines ?? [];

    // The exact fail-closed block of one assertion arm: the `|| {`-form
    // arms end with `}`, the if-form arms with `fi`; the checker proves
    // the echo and the `exit 1` sit INSIDE the arm, not merely somewhere.
    const armBlock = (start: string, closer: string, echo: string): void => {
      const at = lines.indexOf(start);
      expect(
        at,
        `the init step lost its assertion arm ${JSON.stringify(start.slice(0, 60))}… — ` +
          'the fail-closed block is an EXACT pin, restore it whole',
      ).toBeGreaterThan(-1);
      expect(lines[at + 1], 'the arm must echo its ::error:: line right after the test').toBe(
        `  ${echo}`,
      );
      expect(lines[at + 2], 'the arm must exit non-zero inside the block').toBe('  exit 1');
      expect(lines[at + 3], 'the arm must close its block').toBe(closer);
    };

    // The run's own failure arm (the one arm with a diagnostic cat before
    // the echo — the captured output must reach the log on failure).
    const runArm =
      'if ! setpriv --reuid=qminit --regid=qminit --init-groups env HOME=/home/qminit quotameter init --yes --timezone UTC </dev/null >/tmp/init-output 2>&1; then';
    const runArmAt = lines.indexOf(runArm);
    expect(
      runArmAt,
      'the init step lost its run arm — the invocation itself must be pinned whole',
    ).toBeGreaterThan(-1);
    expect(lines[runArmAt + 1], 'the run arm must cat the captured output to stderr').toBe(
      '  cat /tmp/init-output >&2',
    );
    expect(lines[runArmAt + 2]).toBe(
      '  echo "::error::quotameter init --yes failed in the clean container"',
    );
    expect(lines[runArmAt + 3], 'the run arm must exit non-zero inside the block').toBe('  exit 1');
    expect(lines[runArmAt + 4], 'the run arm must close its block').toBe('fi');

    // The six remaining fail-closed arms, in workflow order.
    armBlock(
      'grep -F "Configuration written to /home/qminit/.config/quotameter/config.json." /tmp/init-output >/dev/null || {',
      '}',
      'echo "::error::init --yes did not report the written configuration (§5.3 step 5)"',
    );
    armBlock(
      'grep -F "Database ready at /home/qminit/.local/share/quotameter/quotameter.sqlite." /tmp/init-output >/dev/null || {',
      '}',
      'echo "::error::init --yes did not report the initialized database (§5.3 step 5)"',
    );
    armBlock(
      'if grep -F "api.z.ai" /tmp/init-output >/dev/null; then',
      'fi',
      'echo "::error::init --yes named or contacted the provider host in the no-provider matrix"',
    );
    armBlock(
      'test "$(stat -c %a /home/qminit/.config/quotameter)" = 700 || {',
      '}',
      'echo "::error::the configuration directory is not 0700 (§5.3 step 5)"',
    );
    armBlock(
      'test "$(stat -c %a /home/qminit/.config/quotameter/config.json)" = 600 || {',
      '}',
      'echo "::error::the configuration file is not 0600 (§5.3 step 5)"',
    );
    armBlock(
      'test "$(stat -c %a /home/qminit/.local/share/quotameter)" = 700 || {',
      '}',
      'echo "::error::the data directory is not 0700 (§5.3 step 5)"',
    );
    expect(
      lines.filter((line) => line.trim() === 'exit 1').length,
      'the init step must carry EXACTLY its seven fail-closed block arms (the ' +
        'resolver check is the eighth arm, a one-liner pinned above) — a dropped ' +
        'arm or an added softening one makes this count disagree (review P2)',
    ).toBe(7);

    // The pre-run prefix, in order: the dual-family blackhole, the
    // resolver check that proves it effective, and the account — all
    // BEFORE the run they guard.
    const blackhole = "printf '192.0.2.1 api.z.ai\\n100:: api.z.ai\\n' >> /etc/hosts";
    const blackholeAt = lines.indexOf(blackhole);
    expect(
      blackholeAt,
      'the step must blackhole the provider host for BOTH families (TEST-NET-1 ' +
        'and the RFC 6666 discard-only block) before anything runs',
    ).toBeGreaterThan(-1);
    const resolverCheckAt = lines.findIndex(
      (line) =>
        line.includes('dns.lookup("api.z.ai",{all:true}') && line.includes('process.exit(1)'),
    );
    expect(
      resolverCheckAt,
      "the step must verify the blackhole through Node's own resolver (dns.lookup) " +
        'and fail closed when api.z.ai resolves outside it — the no-provider claim ' +
        'must be enforced, not assumed',
    ).toBeGreaterThan(-1);
    const useraddAt = lines.indexOf('useradd --create-home --user-group --shell /bin/sh qminit');
    expect(
      useraddAt,
      'the step must create a regular account — init refuses a root process ' +
        'without SUDO_USER (D-105), and the operator shape is a real home',
    ).toBeGreaterThan(-1);
    const runAt = lines.findIndex((line) => line.includes('quotameter init --yes --timezone UTC'));
    expect(
      runAt,
      'the step must invoke `quotameter init --yes --timezone UTC` — the flag ' +
        'set of the non-interactive §5.3 flow (the mandatory zone, D-100)',
    ).toBeGreaterThan(-1);
    expect(lines[runAt], 'the init run must drop to the created account via setpriv').toContain(
      'setpriv --reuid=qminit --regid=qminit --init-groups',
    );
    expect(
      lines[runAt],
      'the init run must close stdin — `--yes` never reads it, and the closed ' +
        'input makes the non-interactive claim checkable',
    ).toContain('</dev/null');
    expect(
      blackholeAt < resolverCheckAt && resolverCheckAt < useraddAt && useraddAt < runAt,
      'the prefix must run in order: blackhole → resolver check → account → run — ' +
        'a reordered prefix (the review P2 reproduction) keeps every arm yet guards ' +
        'nothing',
    ).toBe(true);
    expect(
      steps[index]?.rawLines.some((line) => line.includes('continue-on-error')),
      'continue-on-error on the init step would downgrade a real failure to a ' +
        'warning (the D-157 fail-closed rule for every install-job guard step)',
    ).toBe(false);

    // Order: the init proof runs after the installed-CLI proof (it is the
    // deeper end-to-end claim — the command it runs must already be known
    // to resolve) and therefore after everything before it.
    const help = steps.findIndex((candidate) =>
      candidate.runLines.some((line) => line.includes('quotameter --help')),
    );
    expect(help, 'the installed-CLI proof step must exist (pinned separately)').toBeGreaterThan(-1);
    expect(
      index,
      'init --yes must run AFTER the installed-CLI proof (quotameter --help)',
    ).toBeGreaterThan(help);
  });
});
