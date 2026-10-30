/**
 * Child-process entry for the single-instance integration tests (task 074).
 *
 * Spawned as `node --import jiti/register test/helpers/singleInstanceRunner.ts`
 * so the real TypeScript lock module runs in a real process, without a build
 * step (same pattern as `serverMainRunner.ts`, task 060). The environment
 * selects the scenario:
 *
 * - `QUOTAMETER_TEST_RUNNER_DATA_DIR` — data directory the lock guards (required);
 * - `QUOTAMETER_TEST_RUNNER_MODE`     — `hold` (default) or `run`.
 *
 * `hold` acquires the lock directly, writes a `held` marker file, and parks
 * until killed — an exact foreign holder for liveness tests; a `SIGKILL`
 * leaves a genuinely stale lock behind. `run` starts the full server
 * lifecycle (`runServer`) with the lock as its only component — the honest
 * "second process": it exits 1 with the contention explanation when the data
 * directory is taken, and releases the lock on SIGTERM otherwise. Only `run`
 * registers the `onSignalsReady` seam (D-024): it writes a `signals-ready`
 * marker once the shutdown handlers are installed, so the spec can signal
 * this child without the U-001 kill-before-handler race; a refused contender
 * never reaches that point, and `hold` installs no handlers at all — it must
 * die by `SIGKILL` with the lock left stale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runServer } from '../../src/server/main';
import { createSingleInstanceLock } from '../../src/server/single-instance';

const dataDir = requiredEnv('QUOTAMETER_TEST_RUNNER_DATA_DIR');
const mode = requiredMode(process.env.QUOTAMETER_TEST_RUNNER_MODE ?? 'hold');
const lock = createSingleInstanceLock({ dataDir });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredMode(value: string): 'hold' | 'run' {
  if (value === 'hold' || value === 'run') return value;
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
