import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The systemd scenario structure guard (task 196, spec §17.2's final
 * sentence, §5.2-§5.6; decision D-206).
 *
 * The systemd lifecycle scenarios themselves cannot run in the vitest
 * projects — they need systemd as PID 1, logind, and a per-user manager,
 * none of which the development container or the CI job containers provide
 * (D-103's measured premise). They run in a purpose-built docker container
 * driven by `make test-systemd` (locally) and the CI `systemd` job, so the
 * in-suite pin is the same one the release checklist (D-205) and the example
 * units (D-200) use for executable prose: a structural guard that fails
 * `make check` when the scenario machinery drifts.
 *
 * What is pinned, and why each pin is load-bearing:
 *
 * - `test/systemd/Dockerfile` — the package set is exact knowledge:
 *   `systemd` alone does not boot in a container (`systemd-sysv` supplies
 *   /sbin/init) and user managers die without `libpam-systemd` (no PAM
 *   module → no XDG_RUNTIME_DIR in user@.service — validated live in
 *   D-206's design). A dropped package reproduces exactly the silent,
 *   environment-shaped breakage this guard exists to catch. The base image
 *   must equal the development Dockerfile's pin: the scenario runtime is
 *   the declared minimum, not an accident of the scenario image.
 * - `test/systemd/scenario.sh` — fail-closed anchors for every scenario
 *   family §17.2's final sentence names (install/start, restart after
 *   failure, reboot enablement, user service with linger) plus §6.4's
 *   reload: the real CLI commands, the exact operator-visible strings the
 *   landed renderers print, and the §5.6 lock check. A softened assertion
 *   (a grepped string renamed away, a `kill -9` turned into a stop) fails
 *   here before it can hollow out the scenario unnoticed.
 * - `test/systemd/run.sh` — the boot flags (`--privileged`, `--tmpfs
 *   /run`) are required for systemd-as-PID-1; the phase order with reboots
 *   between them IS the reboot-enablement scenario; the cleanup trap keeps
 *   the host free of scenario containers.
 * - The wiring — the CI `systemd` job (same tarball artifact as the install
 *   matrix, gated by the `CI` job), the `make test-systemd` target (packed
 *   into the data volume per the generated-output rule), and the testing
 *   guide's run instruction must stay in agreement with the scripts.
 *
 * Boundary: what the scenarios DO when they run is task 196's done condition
 * ("system and user service scenarios pass"), verified by executing them —
 * this spec pins the shape that makes the execution trustworthy, not its
 * result.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Reads a repository file, verbatim. */
function repoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** The first `FROM <image>` line of a Dockerfile, or a loud null. */
function dockerfileBase(relativePath: string): string {
  const from = /^FROM (\S+)/m.exec(repoFile(relativePath));
  if (from?.[1] === undefined) {
    throw new Error(
      `${relativePath} has no FROM line — a scenario image without a base is unrecognized shape`,
    );
  }
  return from[1];
}

/** Asserts every needle appears in the haystack, naming the first miss. */
function expectAll(haystack: string, needles: readonly string[], what: string): void {
  for (const needle of needles) {
    expect(haystack, `${what} lost the anchor '${needle}'`).toContain(needle);
  }
}

describe('the systemd scenario image (test/systemd/Dockerfile)', () => {
  const dockerfile = repoFile('test/systemd/Dockerfile');

  it('is based on the same pinned runtime as the development image', () => {
    // The scenario environment runs the declared minimum (the base carries
    // Node); a scenario image drifting off the project's runtime pin would
    // test a support contract the project does not declare.
    const scenarioBase = dockerfileBase('test/systemd/Dockerfile');
    const devBase = dockerfileBase('Dockerfile');
    expect(
      scenarioBase,
      'the scenario image must pin the same base as the development Dockerfile',
    ).toBe(devBase);
    expect(scenarioBase).toContain('22.13.0');
  });

  it('installs the boot-critical package set — the exact set, not a prefix', () => {
    // systemd-sysv: /sbin/init (PID 1); libpam-systemd: user managers that
    // actually start (XDG_RUNTIME_DIR); sudo: the genuine privileged route
    // (SUDO_USER resolution). Dropping any of these breaks the scenario
    // environment in ways a reviewer cannot see in a diff — and because the
    // pin carries the line's trailing continuation, silently ADDING a
    // package fails too (a substring pin would not catch that).
    expect(dockerfile).toContain('apt-get install -y systemd systemd-sysv libpam-systemd sudo \\');
  });

  it('creates the fixed-uid scenario owner with passwordless sudo', () => {
    expectAll(
      dockerfile,
      [
        'useradd --create-home --uid 1001 --user-group --shell /bin/bash qmsvc',
        'qmsvc ALL=(ALL) NOPASSWD: ALL',
        'COPY scenario.sh /usr/local/lib/quotameter-systemd-scenario.sh',
        'STOPSIGNAL SIGRTMIN+3',
        'CMD ["/sbin/init"]',
      ],
      'the scenario Dockerfile',
    );
  });
});

describe('the in-container scenario script (test/systemd/scenario.sh)', () => {
  const scenario = repoFile('test/systemd/scenario.sh');

  it('is an executable, fail-closed bash script with the three phases', () => {
    const mode = statSync(path.join(REPO_ROOT, 'test/systemd/scenario.sh')).mode;
    expect(
      mode & 0o111,
      'scenario.sh must carry the executable bit (docker COPY preserves it)',
    ).not.toBe(0);
    expect(scenario.startsWith('#!/usr/bin/env bash')).toBe(true);
    expectAll(scenario, ['set -euo pipefail'], 'the scenario script');
    for (const phase of ['pre-reboot-system', 'post-reboot-system', 'post-reboot-user']) {
      expect(scenario, `the scenario script lost the '${phase}' phase`).toContain(
        `run_${phase.replace(/-/g, '_')}()`,
      );
      expect(scenario, `the phase dispatch lost '${phase}'`).toContain(phase);
    }
  });

  it("binds the scenario owner to the image's account and fixed uid", () => {
    // The Dockerfile creates the account (qmsvc, uid 1001) as literals; the
    // script binds to it through SCENARIO_USER and the runtime dir through
    // USER_RUNTIME_DIR. The two files cannot be checked against each other
    // at runtime (the script only runs inside the image), so the agreement
    // is pinned here.
    expectAll(
      scenario,
      ["SCENARIO_USER='qmsvc'", "USER_RUNTIME_DIR='/run/user/1001'"],
      'the scenario owner binding',
    );
  });

  it('drives the real CLI: install, init, systemctl, reload — never a hand-written unit', () => {
    expectAll(
      scenario,
      [
        'quotameter init --yes --timezone UTC',
        'sudo quotameter service install',
        'sudo quotameter service uninstall',
        'quotameter service install',
        'quotameter reload',
        'quotameter status',
        'systemctl is-active',
        'systemctl is-enabled',
      ],
      'the scenario script',
    );
  });

  it('covers §17.2 restart-after-failure and the §5.6 lock re-acquisition', () => {
    // The crash must be a real failure exit (SIGKILL on the supervised main
    // pid) so Restart=on-failure is the mechanism that brings the service
    // back — the directive asserted from the INSTALLED unit (systemctl
    // show), not from a comment the runtime never executes; and the
    // restarted instance re-acquiring the single-instance lock is the §5.6
    // survival the spec's lifecycle sentence asks about.
    expectAll(
      scenario,
      [
        'kill -9',
        'systemctl show -p Restart --value',
        "'on-failure'",
        'NRestarts',
        '.quotameter.lock',
        'lock_holder_pid',
        'MainPID',
      ],
      'the crash-restart scenario',
    );
  });

  it('covers §6.4 reload: accepted, rejected without SIGHUP, service-side record', () => {
    expectAll(
      scenario,
      [
        'reload accepted',
        'the configuration is invalid',
        'no SIGHUP was sent',
        'configuration reloaded',
        'pollingIntervalSeconds',
      ],
      'the reload scenario',
    );
  });

  it('covers the user unit and linger with the exact §5.3 operator strings', () => {
    // These strings are the landed renderers' operator-visible contracts
    // (D-107's guidance, D-108's outcomes); pinning them keeps the scenario
    // asserting what a user actually sees, not a paraphrase.
    expectAll(
      scenario,
      [
        'loginctl enable-linger',
        'loginctl disable-linger',
        'sudo loginctl enable-linger ${SCENARIO_USER}',
        'installed the user service for ${SCENARIO_USER} — no sudo needed.',
        'Linger is already enabled for ${SCENARIO_USER}',
        '/var/lib/systemd/linger',
      ],
      'the user-unit/linger scenario',
    );
  });

  it('probes the running service over the loopback health endpoint', () => {
    expectAll(
      scenario,
      ['http://127.0.0.1:8787/api/health', 'health_endpoint_answers'],
      'the health scenario',
    );
  });
});

describe('the host-side orchestrator (test/systemd/run.sh)', () => {
  const runner = repoFile('test/systemd/run.sh');

  it('is an executable, fail-closed bash script that builds the scenario image', () => {
    const mode = statSync(path.join(REPO_ROOT, 'test/systemd/run.sh')).mode;
    expect(mode & 0o111, 'run.sh must carry the executable bit').not.toBe(0);
    expect(runner.startsWith('#!/usr/bin/env bash')).toBe(true);
    expectAll(
      runner,
      ['set -euo pipefail', 'docker build', 'Dockerfile', 'trap cleanup EXIT'],
      'the scenario orchestrator',
    );
  });

  it('boots systemd with the required flags and mounts the payload read-only', () => {
    expectAll(
      runner,
      [
        '--privileged',
        '--tmpfs /run',
        '/payload:ro',
        '/usr/local/lib/quotameter-systemd-scenario.sh',
      ],
      'the scenario orchestrator',
    );
  });

  it('runs the three phases in order, waiting for the manager after every boot', () => {
    // A manager wait must follow EVERY boot — the initial `docker run` and
    // each `docker restart` — or a phase can interrogate a manager that has
    // not finished starting (exactly the first draft's execution-caught
    // bug). Position pins, not a presence check.
    const run = runner.indexOf('docker run -d --privileged');
    const runWait = runner.indexOf('wait_for_boot', run);
    const first = runner.indexOf("phase 'pre-reboot-system'");
    const firstRestart = runner.indexOf('docker restart "$CONTAINER"', first);
    const firstWait = runner.indexOf('wait_for_boot', firstRestart);
    const second = runner.indexOf("phase 'post-reboot-system'");
    const secondRestart = runner.indexOf('docker restart "$CONTAINER"', second);
    const secondWait = runner.indexOf('wait_for_boot', secondRestart);
    const third = runner.indexOf("phase 'post-reboot-user'");
    expect(run, 'the orchestrator lost its docker run invocation').toBeGreaterThan(-1);
    expect(runWait, 'the orchestrator must wait for the manager after docker run').toBeGreaterThan(
      run,
    );
    expect(first, "the orchestrator lost the 'pre-reboot-system' phase call").toBeGreaterThan(
      runWait,
    );
    expect(
      firstRestart,
      'the orchestrator must reboot the container after phase 1',
    ).toBeGreaterThan(first);
    expect(
      firstWait,
      'the orchestrator must wait for the manager after the first reboot',
    ).toBeGreaterThan(firstRestart);
    expect(second, "the orchestrator lost the 'post-reboot-system' phase call").toBeGreaterThan(
      firstWait,
    );
    expect(
      secondRestart,
      'the orchestrator must reboot the container after phase 2',
    ).toBeGreaterThan(second);
    expect(
      secondWait,
      'the orchestrator must wait for the manager after the second reboot',
    ).toBeGreaterThan(secondRestart);
    expect(third, "the orchestrator lost the 'post-reboot-user' phase call").toBeGreaterThan(
      secondWait,
    );
  });
});

describe('the scenario wiring (CI job, make target, testing guide)', () => {
  const workflow = repoFile('.github/workflows/ci.yml');
  const makefile = repoFile('Makefile');

  it("the CI workflow runs the scenarios from the package job's tarball and gates on them", () => {
    expect(workflow, "the ci.yml 'systemd:' job is missing (task 196, D-206)").toContain(
      '\n  systemd:\n',
    );
    // Bounded scan of the job's own lines (the bounded-scanner discipline of
    // test/unit/ci-workflow.spec.ts): the job must consume the same package
    // artifact the install matrix uses and invoke the orchestrator.
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line === '  systemd:');
    const end = lines.findIndex(
      (line, index) => index > start && /^ {2}[a-zA-Z][a-zA-Z0-9_-]*:$/.test(line),
    );
    const job = lines.slice(start, end === -1 ? undefined : end).join('\n');
    expect(job).toContain('needs: package');
    expect(job).toContain('name: package-tarball');
    expect(job).toContain('test/systemd/run.sh quotameter-*.tgz');
    // The gate pin is scoped to the CI job's own lines (the bounded-scanner
    // discipline): a whole-workflow regex would be satisfied by any OTHER
    // job listing 'systemd' in its needs while the gate silently dropped it.
    const gateIndex = lines.findIndex((line) => line === '  CI:');
    expect(gateIndex, "the ci.yml 'CI:' gate job is missing").toBeGreaterThan(-1);
    const gateEnd = lines.findIndex(
      (line, index) => index > gateIndex && /^ {2}[a-zA-Z][a-zA-Z0-9_-]*:$/.test(line),
    );
    const gate = lines.slice(gateIndex, gateEnd === -1 ? undefined : gateEnd).join('\n');
    expect(
      gate,
      "the CI gate job must list 'systemd' in its needs — an ungated scenario job proves nothing",
    ).toMatch(/needs: \[[^\]]*\bsystemd\b[^\]]*\]/);
  });

  it('the make target builds, packs into the data volume, and hands the tarball to the orchestrator', () => {
    // Line-based extraction (backslash continuations defeat a single regex:
    // a greedy `[^\n]*` eats the trailing backslash): the recipe is the run
    // of tab-indented lines directly under the target line.
    const lines = makefile.split('\n');
    const targetIndex = lines.findIndex((line) => line.startsWith('test-systemd:'));
    expect(targetIndex, "the Makefile lost the 'test-systemd' target").toBeGreaterThan(-1);
    const recipeLines: string[] = [];
    for (let i = targetIndex + 1; i < lines.length && lines[i]!.startsWith('\t'); i += 1) {
      recipeLines.push(lines[i]!);
    }
    const recipe = recipeLines.join('\n');
    expect(recipeLines.length, "the 'test-systemd' target has no recipe").toBeGreaterThan(0);
    expectAll(
      recipe,
      [
        'npm run build:cli',
        'npm pack --pack-destination /var/lib/quotameter/reports',
        'bash test/systemd/run.sh',
      ],
      'the test-systemd recipe',
    );
  });

  it('the testing guide documents how to run the scenarios', () => {
    const guide = repoFile('docs/agents/testing.md');
    expectAll(guide, ['make test-systemd', 'test/systemd/run.sh'], 'docs/agents/testing.md');
  });
});
