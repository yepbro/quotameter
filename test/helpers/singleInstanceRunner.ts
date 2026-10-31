/**
 * Child-process entry for the single-instance integration tests (task 074).
 *
 * Spawned as `node --import jiti/register test/helpers/singleInstanceRunner.ts`
 * so the real TypeScript lock module runs in a real process, without a build
 * step (same pattern as `serverMainRunner.ts`, task 060). The environment
 * selects the scenario:
 *
 * - `QUOTAMETER_TEST_RUNNER_DATA_DIR` — data directory the lock guards (required);
 * - `QUOTAMETER_TEST_RUNNER_MODE`     — `hold` (default), `run`, or `break-pause`;
 * - `QUOTAMETER_TEST_RUNNER_STALE_PID` — pid of the crafted stale starter lock
 *   that `break-pause` waits behind (required for `break-pause`);
 * - `QUOTAMETER_TEST_RUNNER_GUARD_TIMEOUT_MS` — optional recovery-guard wait
 *   override (U-017), so orchestrated scenarios are not bound by the default;
 * - `QUOTAMETER_TEST_RUNNER_MARK_GUARD_WAIT` — when `1`, the liveness probe
 *   writes a `guard-waiting` marker on its first call: with the guard held by
 *   another process, that first call is provably the first guard-wait poll,
 *   so the spec learns the exact moment this child started waiting on the
 *   recovery guard (causal, no timing assumptions).
 *
 * `hold` acquires the lock directly, writes a `held` marker file, and parks
 * until killed — an exact foreign holder for liveness tests; a `SIGKILL`
 * leaves a genuinely stale lock behind. `run` starts the full server
 * lifecycle (`runServer`) with the lock as its only component — the honest
 * "second process": it exits 1 with the contention explanation when the data
 * directory is taken, and releases the lock on SIGTERM otherwise. Only `run`
 * and `break-pause` register the `onSignalsReady` seam (D-024): they write a
 * `signals-ready` marker once the shutdown handlers are installed, so the
 * spec can signal this child without the U-001 kill-before-handler race; a
 * refused contender never reaches that point, and `hold` installs no handlers
 * at all — it must die by `SIGKILL` with the lock left stale.
 *
 * `break-pause` (U-017) reproduces the reviewer's interleaving from inside a
 * real process: its liveness seam stalls while the crafted stale lock is the
 * inspected one (`saw-stale` marker) until a live holder has taken the path
 * (`held` marker), and its capture seam parks the breaker after the
 * lock-rename with the path vacant (`captured` marker) until the spec allows
 * it to proceed (`resume` marker). The spec then observes whether a third
 * process can steal the vacancy — which the recovery guard (D-086) must
 * prevent — before releasing the breaker to finish its decision.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runServer } from '../../src/server/main';
import { createSingleInstanceLock, isProcessAlive } from '../../src/server/single-instance';

const dataDir = requiredEnv('QUOTAMETER_TEST_RUNNER_DATA_DIR');
const mode = requiredMode(process.env.QUOTAMETER_TEST_RUNNER_MODE ?? 'hold');
const stalePid =
  mode === 'break-pause' ? requiredPositiveInt('QUOTAMETER_TEST_RUNNER_STALE_PID') : 0;
const guardTimeoutMs = optionalPositiveInt('QUOTAMETER_TEST_RUNNER_GUARD_TIMEOUT_MS');
const lock = createSingleInstanceLock(breakPauseOptions());

function breakPauseOptions() {
  const base = {
    dataDir,
    ...guardWaitMarker(),
    ...(guardTimeoutMs === undefined ? {} : { guardTimeoutMs }),
  };
  if (mode !== 'break-pause') return base;
  return {
    ...base,
    isAlive: (pid: number): boolean => {
      if (pid !== stalePid) return isProcessAlive(pid);
      // The inspected stale lock: announce the inspection, then stall until
      // the live holder has replaced the path content — the reviewer's
      // "inspected S, but the rename lands on the successor" prelude.
      writeFileSync(join(dataDir, 'saw-stale'), 'saw-stale\n');
      blockUntil(() => existsSync(join(dataDir, 'held')));
      return false;
    },
    onCaptured: async () => {
      // Mid-recovery pause: the lock path is vacant and this process holds
      // the recovery guard with a captured file aside (D-086).
      writeFileSync(join(dataDir, 'captured'), 'captured\n');
      blockUntil(() => existsSync(join(dataDir, 'resume')));
    },
  };
}

/** The `guard-waiting` marker seam (see the header), inactive by default. */
function guardWaitMarker(): { isAlive?: (pid: number) => boolean } {
  if (process.env.QUOTAMETER_TEST_RUNNER_MARK_GUARD_WAIT !== '1') return {};
  let marked = false;
  return {
    isAlive: (pid: number): boolean => {
      if (!marked) {
        marked = true;
        writeFileSync(join(dataDir, 'guard-waiting'), 'guard-waiting\n');
      }
      return isProcessAlive(pid);
    },
  };
}

/** Blocks the child's main thread until `condition` holds (bounded). */
function blockUntil(condition: () => boolean, timeoutMs = 15_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the orchestration marker');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredPositiveInt(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredMode(value: string): 'hold' | 'run' | 'break-pause' {
  if (value === 'hold' || value === 'run' || value === 'break-pause') return value;
  throw new Error(`unknown QUOTAMETER_TEST_RUNNER_MODE: ${value}`);
}

function fail(error: unknown): never {
  writeFileSync(join(dataDir, 'failed'), `${String(error)}\n`);
  process.stderr.write(`single-instance runner failed: ${String(error)}\n`);
  process.exit(3);
}

try {
  if (mode === 'hold') {
    await lock.start();
    writeFileSync(join(dataDir, 'held'), 'held\n');
    // Park until the spec kills this process: the holder must outlive the
    // test steps that contend with it.
    setInterval(() => {}, 60_000);
  } else {
    const code = await runServer({
      components: [lock],
      onSignalsReady: () => writeFileSync(join(dataDir, 'signals-ready'), 'signals-ready\n'),
    });
    // Hard exit: the runner owns the process and owes the test a definite code.
    process.exit(code);
  }
} catch (error) {
  fail(error);
}
