import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir } from '../helpers/isolation';

/**
 * The composition's SIGHUP reload surface (task U-052, decisions
 * D-176/D-177): the composed result publishes the wrapper every store
 * mutation flows through (`applyReload`) and the runtime's signal face
 * over it (`reloadOnSighup`) — the operation `src/server/main.ts` wires to
 * `process.on('SIGHUP', …)`. These tests pin the surface at the
 * composition boundary: the effective-configuration change a SIGHUP
 * delivers (observable through `/api/status`, which reads the live
 * configuration), the §16 outcome records, §6.2's keep-the-last-valid rule
 * through the signal face, and the containment a signal handler owes —
 * never throw synchronously, never leave an unhandled rejection — when the
 * wrapper's own steps fault. The process boundary (a real SIGHUP to a real
 * server child through the launcher) is pinned by `cli-run.spec.ts`.
 *
 * No accounts are configured except the fault probe (keyless, §7.3's `Not
 * configured` — never polled), so the polling engine stays idle and the
 * only moving part is the reload path itself; the logger is injected with
 * an in-memory sink at `debug` so the arrival note, the outcome records,
 * and the fault arm are all observable without touching `process.stdout`.
 */

interface Harness {
  readonly composed: ComposedApplication;
  readonly sink: MemoryLogSink;
  readonly configPath: string;
  /** Stops the §5.6 lifecycle, keeping the directories and the file. */
  stopLifecycle(): Promise<void>;
  /** Final teardown: idempotent lifecycle stop plus directory removal. */
  cleanup(): Promise<void>;
}

/** The log lines emitted so far, joined for substring assertions. */
function linesOf(sink: MemoryLogSink): string {
  return sink.lines().join('\n');
}

/**
 * Composes and starts the application over fresh temp directories with the
 * given configuration file content.
 */
async function startHarness(config: Record<string, unknown>): Promise<Harness> {
  const dir = await createTempDir('qm-composition-sighup-');
  const configDir = join(dir.path, 'config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configPath = configFilePath(configDir);
  await writeConfigFile(configPath, config);

  const sink = createMemoryLogSink();
  const composed = await composeApplication({
    env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
    logger: createLogger({ level: 'debug', destination: sink }),
    port: 0,
  });
  const app = new QuotameterApp({ components: composed.components });
  await app.start();
  let stopped = false;
  const stopLifecycle = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  return {
    composed,
    sink,
    configPath,
    stopLifecycle,
    async cleanup() {
      await stopLifecycle();
      await dir.remove();
    },
  };
}

/** The effective §7.1 interval as `/api/status` reports it. */
async function statusInterval(world: Harness): Promise<number> {
  const response = await world.composed.httpServer.server.inject({
    method: 'GET',
    url: '/api/status',
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { pollingIntervalSeconds?: number };
  expect(body.pollingIntervalSeconds).toBeDefined();
  return body.pollingIntervalSeconds ?? -1;
}

describe('ComposedApplication reload surface (SIGHUP, D-177)', () => {
  it(
    'applyReload applies a changed live setting to the effective configuration',
    { timeout: 20_000 },
    async () => {
      const world = await startHarness({
        app: { timezone: 'UTC', pollingIntervalSeconds: 60 },
      });
      try {
        // The rewrite carries an explicit `logging.level`: the reloader
        // applies it through `setLevel` BEFORE its own success record
        // (D-026's pinned order), so a level-less file resets the level to
        // the default `warn` and filters the `info` line by design.
        await writeConfigFile(world.configPath, {
          app: { timezone: 'UTC', pollingIntervalSeconds: 120 },
          logging: { level: 'debug' },
        });

        const result = await world.composed.applyReload();

        expect(result.ok).toBe(true);
        if (result.ok) {
          // §6.4: the interval is a live setting, applied by this reload.
          expect(result.applied).toContain('app.pollingIntervalSeconds');
          expect(result.effective.config.app.pollingIntervalSeconds).toBe(120);
        }
        expect(await statusInterval(world)).toBe(120);
        // The §16 outcome record is the reloader's own info lifecycle line.
        expect(linesOf(world.sink)).toContain('"msg":"configuration reloaded"');
      } finally {
        await world.cleanup();
      }
    },
  );

  it(
    'reloadOnSighup delivers the same reload, notes the arrival at debug, and survives a rejected file (§6.2)',
    { timeout: 20_000 },
    async () => {
      const world = await startHarness({
        app: { timezone: 'UTC', pollingIntervalSeconds: 60 },
      });
      try {
        expect(await statusInterval(world)).toBe(60);

        // A valid change: the signal face fires the wrapped reload without
        // throwing, and the effective configuration follows the file. The
        // explicit `logging.level` keeps the reloader's `info` success
        // record visible — `setLevel` runs before it (D-026's order).
        await writeConfigFile(world.configPath, {
          app: { timezone: 'UTC', pollingIntervalSeconds: 300 },
          logging: { level: 'debug' },
        });
        expect(() => world.composed.reloadOnSighup()).not.toThrow();
        await vi.waitFor(
          async () => {
            expect(await statusInterval(world)).toBe(300);
          },
          { timeout: 10_000, interval: 25 },
        );
        const reloaded = linesOf(world.sink);
        expect(reloaded).toContain('"msg":"reloading configuration (SIGHUP)"');
        expect(reloaded).toContain('"msg":"configuration reloaded"');

        // A rejected file: §6.2 keeps the last valid configuration, the
        // signal-face contract is "never die", and the reloader's warn
        // record is the §16 report.
        await writeFile(world.configPath, '{"app": "not an object"}\n');
        expect(() => world.composed.reloadOnSighup()).not.toThrow();
        await vi.waitFor(
          () => {
            expect(linesOf(world.sink)).toContain(
              '"msg":"configuration reload rejected; keeping the last valid configuration"',
            );
          },
          { timeout: 10_000, interval: 25 },
        );
        expect(await statusInterval(world)).toBe(300);
      } finally {
        await world.cleanup();
      }
    },
  );

  it(
    'contains a faulting follow-up application at error without misreporting the effective configuration',
    { timeout: 20_000 },
    async () => {
      // The deterministic fault: after the lifecycle stopped, the config-sync
      // inside the wrapper reaches for the storage facade, which answers the
      // clear wiring error — the shape a SIGHUP racing a shutdown produces
      // in production (a stopped scheduler's setAccounts refusal is the
      // same class, contained by the same arm). The fault lands AFTER the
      // reloader adopted the new configuration, so the record must say the
      // follow-up lagged — not that the old configuration was kept.
      const world = await startHarness({
        app: { timezone: 'UTC' },
        accounts: [{ id: 'fault-probe', providerId: 'zai-coding-plan', label: 'A' }],
      });
      try {
        await writeConfigFile(world.configPath, {
          app: { timezone: 'UTC' },
          accounts: [{ id: 'fault-probe', providerId: 'zai-coding-plan', label: 'B' }],
          logging: { level: 'debug' },
        });
        await world.stopLifecycle();

        expect(() => world.composed.reloadOnSighup()).not.toThrow();
        const FOLLOW_UP_FAILED =
          '"msg":"configuration reload applied but its follow-up application failed; ' +
          'storage and polling may lag the effective configuration"';
        await vi.waitFor(
          () => {
            expect(linesOf(world.sink)).toContain(FOLLOW_UP_FAILED);
          },
          { timeout: 10_000, interval: 25 },
        );
        // The honest record sequence: the reloader's success record FIRST
        // (the new configuration IS effective), the follow-up fault SECOND
        // — never the contradictory "kept the last valid configuration".
        const lines = world.sink.lines();
        const reloadedAt = lines.findIndex((line) =>
          line.includes('"msg":"configuration reloaded"'),
        );
        const faultedAt = lines.findIndex((line) => line.includes(FOLLOW_UP_FAILED));
        expect(reloadedAt).toBeGreaterThanOrEqual(0);
        expect(faultedAt).toBeGreaterThan(reloadedAt);
        expect(linesOf(world.sink)).not.toContain(
          '"msg":"configuration reload failed; keeping the last valid configuration"',
        );
        // The fault record carries the wiring error, normalized by the
        // logger's errWithCause shape (D-025) and value-free per §16.
        const record = world.sink
          .records()
          .find(
            (entry) =>
              entry.msg ===
              'configuration reload applied but its follow-up application failed; ' +
                'storage and polling may lag the effective configuration',
          );
        expect(record).toBeDefined();
        const carried = record?.error as { message?: string } | undefined;
        expect(carried?.message).toContain('storage is not started');
      } finally {
        await world.cleanup();
      }
    },
  );
});
