/**
 * Hermetic environment construction for real-launcher child processes
 * (task U-045, decision D-173). Not to be confused with
 * `test/helpers/hermeticEnv.ts` (D-028's sanctioned `process.env` narrowing
 * for default-seam tests): this helper never touches the parent environment —
 * it builds the environment a spawned launcher child inherits.
 *
 * The `init` service-setup step (§5.3 step 7, tasks 137–138) probes the
 * machine it runs on: the `/run/systemd/system` marker and — decisive here —
 * an own-property `XDG_RUNTIME_DIR` whose `systemd` runtime directory exists,
 * verified through real read-only `systemctl` queries (D-160). On a machine
 * with a live session manager (the hosted ubuntu-latest job sessions since
 * GitHub's 26.04 image — D-162) a real-launcher child that inherits the
 * session variables does not just OBSERVE that manager, it ACTS on it: the
 * `user-unit` route executes `systemctl --user daemon-reload` and
 * `systemctl --user enable --now quotameter.service` against one shared unit
 * name — a stateful, machine-mutating step whose outcome legitimately differs
 * between two otherwise identical invocations (the first install versus the
 * re-enable of a unit left failed or auto-restarting by an earlier run).
 * That is the divergence class behind the 2026-11-02→04 daily mutation
 * failures: the reproducibility cell's two real-launcher runs agreed on
 * every collected byte and diverged in the service-setup block — either
 * through that stateful enable (re-captured in privileged systemd
 * containers under concurrent invocations) or through the same
 * machine-coupling's other face, the probe's load-sensitive timeout
 * splitting absent/present between the two runs; see
 * `docs/agents/gotchas.md` and D-173.
 *
 * The launcher's only test-reachable knob is its environment — the
 * integration suites cannot inject the step's seams (D-162's recorded
 * reason) — so hermeticity is enforced at the spawn boundary: the session
 * variables are stripped from what the child inherits. Without an own
 * `XDG_RUNTIME_DIR`, `probeServiceCapabilities` never spawns the user probe
 * (`userManager: false` by construction), and on a systemd machine the step
 * takes the deterministic write-only `user-manager-unavailable` route — no
 * `systemctl --user` query and no user-unit commands (the read-only
 * system-manager verification still runs there; only its own timeout race,
 * not the session, can vary its answer). On a
 * systemd-less machine (the development container and every CI/mutation job
 * container, D-162) nothing changes: the probe returns at the marker
 * before anything is spawned.
 *
 * D-100's reproducibility contract is preserved, not weakened: byte-identity
 * was always defined over "flags + environment" — this helper pins the
 * environment's one mutable dimension instead of letting the runner's
 * session leak into it. Everything else passes through verbatim (`PATH`,
 * `HOME`, the `QUOTAMETER_*` configuration variables, the suites' key and
 * password variables).
 */

/**
 * The environment variables that make a child observe — and, through the
 * §5.3 step-7 user-unit route, act on — the invoking user's session manager.
 * `XDG_RUNTIME_DIR` is the probe's own gate (an own-property read, D-160);
 * the `DBUS_*` session addresses are belt-and-braces: they would let a
 * spawned `systemctl --user` reach a user bus even if the runtime-dir gate
 * were ever re-widened. The system-bus variables are deliberately kept: the
 * system-manager verification is read-only and its answer does not change
 * the route.
 */
export const SESSION_MANAGER_ENV_KEYS: readonly string[] = [
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_STARTER_ADDRESS',
  'DBUS_STARTER_BUS_TYPE',
];

/**
 * Copies `base` (default: the current `process.env`) minus the session
 * variables of {@link SESSION_MANAGER_ENV_KEYS} — a fresh object, so callers
 * may add per-run variables (`QUOTAMETER_CONFIG_DIR`, key variables) and
 * delete from the result without touching the parent environment.
 */
export function hermeticChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SESSION_MANAGER_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Pins a spawned launcher child to the SOURCE entry (`src/` through jiti):
 * `QUOTAMETER_CLI_ENTRY=source` (task 186, decision D-196).
 *
 * Every real-launcher suite that preloads `--import jiti/register` tests
 * the development contract — the TypeScript source tree through jiti, the
 * task-130 child-process pattern. D-195's deliberate dist-first resolution
 * flips those children into the compiled `dist/` graph whenever a built
 * `dist/` exists in the tree (`make check-all`'s build leg leaves one; so
 * does any local `npm run build:cli`), and under jiti's process-wide ESM
 * hooks the compiled graph then dies inside Node's require(esm) bridge
 * with `request for '…/node_modules/jiti/lib/jiti.mjs' is not in cache`
 * (the 2026-11-08 landing failure: 26 real-launcher tests, red only on
 * the SECOND consecutive `make check-all`). Spreading this pin into the
 * spawn env makes the suites' subject independent of ambient build state;
 * the compiled mode keeps its own dedicated suite
 * (`test/integration/cli-bin-dist.spec.ts` — plain Node, fixture package
 * roots, no jiti hooks) and the launcher's auto order stays untouched.
 *
 * Spread AFTER any `...process.env`/`hermeticChildEnv()` base so the pin
 * wins over an ambient value; the suites that deliberately strip
 * `QUOTAMETER_*` re-set it explicitly. Membership is guarded by
 * `test/unit/launcher-source-mode-pin.spec.ts` — a new jiti-spawning
 * launcher suite without the pin fails `make check`.
 */
export const CLI_ENTRY_SOURCE: Readonly<NodeJS.ProcessEnv> = { QUOTAMETER_CLI_ENTRY: 'source' };
