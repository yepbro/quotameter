/**
 * Child-process entry for the server-main integration tests (task 060).
 *
 * Spawned as `node --import jiti/register test/helpers/serverMainRunner.ts`
 * so the real TypeScript entry point runs in a real process without a build
 * step. The environment selects the scenario:
 *
 * - `QUOTAMETER_TEST_RUNNER_DIR`  — directory for marker files (required);
 * - `QUOTAMETER_TEST_RUNNER_MODE` — `ok` (default), `old-node`, `root`.
 *
 * The `ok` mode registers a marker component so the spec can observe the
 * startup and shutdown sequences through the filesystem, exactly like the
 * real components the later construction tasks will register. Every mode
 * registers the `onSignalsReady` seam, but the `signals-ready` marker
 * appears only when the components started and the shutdown handlers are
 * installed — the `old-node` and `root` gates refuse before that point.
 * The spec waits for the marker before sending a signal, because the
 * `started` marker alone races the handler installation (U-001).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LifecycleComponent } from '../../src/server/app';
import { runServer } from '../../src/server/main';

const dir = requiredEnv('QUOTAMETER_TEST_RUNNER_DIR');
const mode = requiredMode(process.env.QUOTAMETER_TEST_RUNNER_MODE ?? 'ok');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredMode(value: string): 'ok' | 'old-node' | 'root' {
  if (value === 'ok' || value === 'old-node' || value === 'root') {
    return value;
  }
  throw new Error(`unknown QUOTAMETER_TEST_RUNNER_MODE: ${value}`);
}

function marker(name: string): void {
  writeFileSync(join(dir, name), `${name}\n`);
}

const markerComponent: LifecycleComponent = {
  name: 'marker',
  async start() {
    marker('started');
  },
  async stop() {
    marker('stopped');
  },
};

const components: readonly LifecycleComponent[] = mode === 'ok' ? [markerComponent] : [];

const runtime =
  mode === 'old-node'
    ? { nodeVersion: '22.12.0', uid: 1000 }
    : mode === 'root'
      ? { nodeVersion: process.versions.node, uid: 0 }
      : undefined;

void (async () => {
  const code = await runServer({
    components,
    runtime,
    onSignalsReady: () => marker('signals-ready'),
  });
  // Hard exit: the runner owns the process and owes the test a definite code.
  process.exit(code);
})().catch((error: unknown) => {
  process.stderr.write(`runner failed: ${String(error)}\n`);
  process.exit(2);
});
