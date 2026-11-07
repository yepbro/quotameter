import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';
import { withQuotameterEnv } from '../helpers/hermeticEnv';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import type { LifecycleComponent } from '../../src/server/app';
import {
  buildApplication,
  currentRuntime,
  installReloadSignal,
  installShutdownSignals,
  runServer,
  verifyRuntime,
} from '../../src/server/main';

/**
 * Process orchestration of the server entry point (task 060, spec §5.6):
 * the runtime gate, signal wiring, exit codes of `runServer`, and the full
 * start/stop cycle in real child processes — the "start and stop cleanly
 * without collecting provider data" milestone. The child processes run the
 * actual TypeScript entry through jiti (no build step), driven by
 * test/helpers/serverMainRunner.ts. This task's coverage spans the process
 * boundary, so all of it (including the in-process parts) lives here rather
 * than being split across `test/unit/`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = join(REPO_ROOT, 'test/helpers/serverMainRunner.ts');

/**
 * Reserves an unused TCP port for a test's own listener (bind `0`, read the
 * assignment, release). The tiny race between release and the test's own
 * bind is the standard cost of not hard-coding a default port.
 */
async function reservePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Spawns the runner for `mode` with its marker directory set to `dir`. */
function startRunner(
  mode: string,
  dir: string,
): { child: ChildProcess; exited: Promise<ExitResult> } {
  const child = spawn(process.execPath, ['--import', 'jiti/register', RUNNER], {
    env: { ...process.env, QUOTAMETER_TEST_RUNNER_DIR: dir, QUOTAMETER_TEST_RUNNER_MODE: mode },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
  // 'close' (not 'exit'): stdio streams are drained by then, so the captured
  // stderr is complete when the promise resolves.
  const exited = new Promise<ExitResult>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr: Buffer.concat(chunks).toString('utf8') });
    });
  });
  return { child, exited };
}

/** Kills the child unless it has already exited. */
function killIfAlive(child: ChildProcess): void {
  if (child.exitCode === null) child.kill('SIGKILL');
}

/**
 * Readiness-marker wait for the real-signal scenarios (`signals-ready` is
 * the U-001 handshake: killing earlier races the OS-default disposition).
 * Its latency is one full child boot — the runner transpiles the
 * `runServer` module graph through `jiti/register` before installing the
 * handlers. Measured per D-094 (U-044, decision D-163): 1.8–2.2 s ambient
 * and under the six-hog rig in isolation, worst ≈4 s inside a full
 * coverage `make check` under the rig (pool load ~16; the SIGTERM/SIGINT
 * tests measured 4.7/5.5 s whole-test there). The 2026-11-04/05 waves
 * tripped this wait at the old 10 s default while isolated runs stayed
 * green. 20 s holds ≈5× the in-pool worst — D-094's bar is ≈3×.
 */
const MARKER_WAIT_TIMEOUT_MS = 20_000;

async function waitForFile(file: string, timeoutMs = MARKER_WAIT_TIMEOUT_MS): Promise<void> {
  await vi.waitFor(
    () => {
      expect(existsSync(file), `expected ${file} to appear`).toBe(true);
    },
    { timeout: timeoutMs, interval: 25 },
  );
}

describe('verifyRuntime', () => {
  it('accepts the declared minimum runtime and a regular user', () => {
    expect(() => verifyRuntime({ nodeVersion: '22.13.0', uid: 1000 })).not.toThrow();
    expect(() => verifyRuntime({ nodeVersion: '24.14.1', uid: 1 })).not.toThrow();
  });

  it('refuses a Node.js below the declared minimum', () => {
    expect(() => verifyRuntime({ nodeVersion: '22.12.9', uid: 1000 })).toThrow(
      /requires Node\.js >= 22\.13\.0 \(found 22\.12\.9\); refusing to start\. Upgrade Node\.js/,
    );
  });

  it('orders prerelease-suffixed runtimes by their numeric prefix', () => {
    // Nightly builds report suffixed process.versions.node; the gate counts
    // them as their release line (task 129, decision D-098) — a nightly of
    // a supported line runs, one below the line still refuses.
    expect(() =>
      verifyRuntime({ nodeVersion: '22.13.0-nightly.20261101abc', uid: 1000 }),
    ).not.toThrow();
    expect(() => verifyRuntime({ nodeVersion: '22.13.0+custom', uid: 1000 })).not.toThrow();
    expect(() => verifyRuntime({ nodeVersion: '22.12.9-nightly.20261101abc', uid: 1000 })).toThrow(
      /requires Node\.js >= 22\.13\.0 \(found 22\.12\.9-nightly\.20261101abc\); refusing to start/,
    );
  });

  it('refuses to run as root', () => {
    expect(() => verifyRuntime({ nodeVersion: '22.13.0', uid: 0 })).toThrow(/must not run as root/);
  });

  it('refuses to run when the uid cannot be determined', () => {
    expect(() => verifyRuntime({ nodeVersion: '22.13.0', uid: undefined })).toThrow(
      /cannot determine the uid/,
    );
  });

  it('reads the runtime facts of the current process', () => {
    const facts = currentRuntime();
    expect(facts.nodeVersion).toBe(process.versions.node);
    expect(facts.uid).toBe(process.getuid?.());
  });
});

describe('buildApplication', () => {
  it('assembles the production composition in §5.6 order', async () => {
    const dir = await createTempDir('quotameter-build-components-');
    try {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeConfigFile(configFilePath(configDir), { app: { timezone: 'UTC' } });
      let names: string[] | undefined;
      await withQuotameterEnv(
        { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
        async () => {
          names = (await buildApplication()).components.map((component) => component.name);
        },
      );
      // `shutdown.ts`'s documented §5.6 order, completed by U-051/D-176
      // and U-053/D-178: the retention schedule sits directly after
      // storage (its startup cleanup runs after migrations; its daily
      // wait is cancelled before the database closes), and the drain sits
      // between it and the scheduler so an aborted cycle's settlement
      // never races the database close.
      expect(names).toEqual([
        'single-instance-lock',
        'storage',
        'retention',
        'graceful-drain',
        'polling',
        'http-listener',
      ]);
    } finally {
      await dir.remove();
    }
  });

  it('exposes the composition-wrapped reload beside the components (D-177)', async () => {
    // The SIGHUP face is part of the assembled result the runtime wires —
    // the same wrapped reload the stores flow through, never a bare
    // `reloader.reload()` (D-176/D-177).
    const dir = await createTempDir('quotameter-build-reload-');
    try {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeConfigFile(configFilePath(configDir), { app: { timezone: 'UTC' } });
      let composed: Awaited<ReturnType<typeof buildApplication>> | undefined;
      await withQuotameterEnv(
        { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
        async () => {
          composed = await buildApplication();
        },
      );
      expect(typeof composed?.applyReload).toBe('function');
      expect(typeof composed?.reloadOnSighup).toBe('function');
    } finally {
      await dir.remove();
    }
  });

  it('refuses to assemble without a usable configuration (§6.2)', async () => {
    const dir = await createTempDir('quotameter-build-components-');
    try {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await expect(
        withQuotameterEnv(
          { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
          async () => {
            await expect(buildApplication()).rejects.toThrow(/configuration file not found/);
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await dir.remove();
    }
  });
});

describe('installShutdownSignals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wires SIGTERM and SIGINT to the trigger and disposes both', () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    const triggers: string[] = [];

    const signals = installShutdownSignals((signal) => triggers.push(signal));
    const registered = onSpy.mock.calls
      .filter(([event]) => event === 'SIGTERM' || event === 'SIGINT')
      .map(([event, listener]) => ({
        event: event as string,
        listener: listener as (signal: NodeJS.Signals) => void,
      }));
    expect(registered.map((entry) => entry.event).sort()).toEqual(['SIGINT', 'SIGTERM']);

    for (const { event, listener } of registered) listener(event as NodeJS.Signals);
    expect([...triggers].sort()).toEqual(['SIGINT', 'SIGTERM']);

    signals.dispose();
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});

describe('installReloadSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wires SIGHUP to the reload operation and disposes it', () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    const calls: number[] = [];
    const reload = (): void => {
      calls.push(calls.length);
    };

    const signals = installReloadSignal(reload);
    const registered = onSpy.mock.calls
      .filter(([event]) => event === 'SIGHUP')
      .map(([event, listener]) => ({
        event: event as string,
        listener: listener as () => void,
      }));
    expect(registered).toHaveLength(1);

    // The registered listener is the operation itself — no signal adapter
    // in between (the operation owns its error containment, D-177).
    expect(registered[0]?.listener).toBe(reload);
    registered[0]?.listener();
    expect(calls).toHaveLength(1);

    signals.dispose();
    expect(removeSpy).toHaveBeenCalledWith('SIGHUP', reload);
  });
});

describe('runServer (in-process)', () => {
  // Firing these after a failed test settles any `runServer` promise that is
  // still pending, so its keep-alive interval cannot hang the worker instead
  // of producing a crisp failure report.
  const shutdownTriggers: Array<() => void> = [];

  afterEach(async () => {
    for (const trigger of shutdownTriggers.splice(0)) trigger();
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
  });

  /** Captures fatal diagnostics written to stderr; restores on `restore()`. */
  function captureStderr(): { lines(): string; restore(): void } {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      lines: () => spy.mock.calls.map((call) => String(call[0])).join(''),
      restore: () => spy.mockRestore(),
    };
  }

  /**
   * Resolves once `started` settled and the microtask queue drained, with the
   * SIGTERM handler `runServer` registered (it installs right after
   * `app.start()` resolves).
   */
  async function sigtermHandlerAfter(
    onSpy: MockInstance<typeof process.on>,
    started: Promise<unknown>,
  ): Promise<(signal: NodeJS.Signals) => void> {
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const call = onSpy.mock.calls.filter(([event]) => event === 'SIGTERM').at(-1);
    expect(call, 'runServer did not register a SIGTERM handler').toBeDefined();
    return call?.[1] as (signal: NodeJS.Signals) => void;
  }

  /**
   * The SIGHUP twin of {@link sigtermHandlerAfter}: the reload handler
   * `runServer` registered (only when a reload operation exists, D-177).
   */
  async function sighupHandlerAfter(
    onSpy: MockInstance<typeof process.on>,
    started: Promise<unknown>,
  ): Promise<() => void> {
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const call = onSpy.mock.calls.filter(([event]) => event === 'SIGHUP').at(-1);
    expect(call, 'runServer did not register a SIGHUP handler').toBeDefined();
    return call?.[1] as () => void;
  }

  /**
   * A component that owns a release marker: its `stop` rejects on the first
   * `failStops` calls and releases the marker on the next one — the leak
   * shape of the startup-failure branch (a rollback stop that rejects leaves
   * the marker held; D-088's `stop()` retry is the release route, and
   * `runServer`'s best-effort stop is what triggers it, D-095). The
   * rejection message carries the call number, so the retry round's
   * AggregateError can be told apart from the rollback's rejection.
   */
  function leakyComponent(name: string, failStops: number) {
    let stopCalls = 0;
    let released = false;
    const component: LifecycleComponent = {
      name,
      async start() {},
      async stop() {
        stopCalls += 1;
        if (stopCalls <= failStops) throw new Error(`stop failed: ${name} (call ${stopCalls})`);
        released = true;
      },
    };
    return { component, stopCalls: () => stopCalls, released: () => released };
  }

  /** A component whose `start` rejects, so the startup sequence fails. */
  function brokenStart(name: string): LifecycleComponent {
    return {
      name,
      async start() {
        throw new Error(`start failed: ${name}`);
      },
      async stop() {},
    };
  }

  it('returns 0 after a signal-triggered clean shutdown', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    const hooks: string[] = [];
    let resolveStart!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const component: LifecycleComponent = {
      name: 'probe',
      async start() {
        hooks.push('start');
        resolveStart();
      },
      async stop() {
        hooks.push('stop');
      },
    };

    const server = runServer({ components: [component] });
    const handler = await sigtermHandlerAfter(onSpy, started);
    shutdownTriggers.push(() => handler('SIGTERM'));

    handler('SIGTERM');
    await expect(server).resolves.toBe(0);

    expect(hooks).toEqual(['start', 'stop']);
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('announces signal readiness once started, with both shutdown handlers installed', async () => {
    const onSpy = vi.spyOn(process, 'on');
    let resolveStart!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let handlersAtReady = -1;
    let announcements = 0;
    const component: LifecycleComponent = {
      name: 'probe',
      async start() {
        resolveStart();
      },
      async stop() {},
    };

    const server = runServer({
      components: [component],
      onSignalsReady: () => {
        announcements++;
        handlersAtReady = onSpy.mock.calls.filter(
          ([event]) => event === 'SIGTERM' || event === 'SIGINT',
        ).length;
      },
    });
    const handler = await sigtermHandlerAfter(onSpy, started);
    shutdownTriggers.push(() => handler('SIGTERM'));

    // The handshake the child-process tests rely on: `onSignalsReady` has
    // run exactly once by the first macrotask after start, and both handlers
    // were registered first.
    expect(announcements).toBe(1);
    expect(handlersAtReady).toBe(2);

    handler('SIGTERM');
    await expect(server).resolves.toBe(0);
  });

  it('routes SIGHUP to the reload operation without stopping the process (D-177)', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    let resolveStart!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const component: LifecycleComponent = {
      name: 'probe',
      async start() {
        resolveStart();
      },
      async stop() {},
    };
    let reloads = 0;
    const reload = (): void => {
      reloads++;
    };

    const server = runServer({ components: [component], reload });
    let settled = false;
    void server.then(() => {
      settled = true;
    });
    const sighup = await sighupHandlerAfter(onSpy, started);
    const sigterm = await sigtermHandlerAfter(onSpy, started);
    shutdownTriggers.push(() => sigterm('SIGTERM'));

    // A burst of SIGHUPs reaches the reload operation each time (the
    // reloader serializes them in production, D-026 §5); only a shutdown
    // signal resolves the run.
    sighup();
    sighup();
    expect(reloads).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    sigterm('SIGTERM');
    await expect(server).resolves.toBe(0);
    // Disposed with the shutdown pair: the seam itself was removed.
    expect(removeSpy).toHaveBeenCalledWith('SIGHUP', reload);
  });

  it('keeps the OS-default SIGHUP disposition when no reload operation exists (D-177)', async () => {
    const onSpy = vi.spyOn(process, 'on');
    let resolveStart!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const component: LifecycleComponent = {
      name: 'probe',
      async start() {
        resolveStart();
      },
      async stop() {},
    };

    const server = runServer({ components: [component] });
    const handler = await sigtermHandlerAfter(onSpy, started);
    shutdownTriggers.push(() => handler('SIGTERM'));

    // Bare components carry no reload operation, so no SIGHUP listener is
    // installed — an embedder keeps the terminal-disconnect default.
    expect(onSpy.mock.calls.some(([event]) => event === 'SIGHUP')).toBe(false);

    handler('SIGTERM');
    await expect(server).resolves.toBe(0);
  });

  it('runs with the assembled default components when none are passed', async () => {
    const onSpy = vi.spyOn(process, 'on');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // No `components`: the production assembly from buildApplication() runs —
    // the composed service (config load, lock, migrated storage, the wired
    // listener) over temp directories through the §6.1 environment channel.
    // The listener binds for real, so the configuration names a port
    // reserved for this test (the review round's P2: the schema cannot
    // express the ephemeral `0`, and a fixed default could collide with any
    // other listener).
    const port = await reservePort();
    const dir = await createTempDir('quotameter-runserver-default-');
    try {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeConfigFile(configFilePath(configDir), {
        app: { timezone: 'UTC' },
        server: { port },
      });
      let exitCode = -1;
      const server = withQuotameterEnv(
        { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
        async () => {
          exitCode = await runServer({
            runtime: { nodeVersion: '22.13.0', uid: 1000 },
            onSignalsReady: () => resolveReady(),
          });
        },
      );
      const handler = await sigtermHandlerAfter(onSpy, ready);
      shutdownTriggers.push(() => handler('SIGTERM'));

      // The composed default carries the reload operation, so the SIGHUP
      // handler is installed beside the shutdown pair (D-177) — the
      // real-signal behavior is pinned by cli-run.spec.ts through the
      // launcher.
      expect(onSpy.mock.calls.some(([event]) => event === 'SIGHUP')).toBe(true);

      await handler('SIGTERM');
      await server;
      expect(exitCode).toBe(0);
    } finally {
      await dir.remove();
    }
  });

  it('propagates a throwing readiness callback and still disposes the handlers', async () => {
    const removeSpy = vi.spyOn(process, 'removeListener');
    const component: LifecycleComponent = {
      name: 'probe',
      async start() {},
      async stop() {},
    };

    const server = runServer({
      components: [component],
      onSignalsReady: () => {
        throw new Error('ready probe exploded');
      },
    });
    // Attach the rejection expectation before any await so the rejection is
    // never momentarily unhandled.
    const rejected = expect(server).rejects.toThrow('ready probe exploded');
    await rejected;

    // The finally clause ran: both handlers disposed, keep-alive cleared.
    expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('does not announce signal readiness when the runtime gate refuses to start', async () => {
    const stderr = captureStderr();
    const announcements: string[] = [];
    try {
      const code = await runServer({
        runtime: { nodeVersion: '20.0.0', uid: 1000 },
        onSignalsReady: () => announcements.push('signals-ready'),
      });
      expect(code).toBe(1);
      expect(announcements).toEqual([]);
    } finally {
      stderr.restore();
    }
  });

  it('refuses to start on an unsupported runtime and explains why', async () => {
    const stderr = captureStderr();
    try {
      const code = await runServer({ runtime: { nodeVersion: '20.0.0', uid: 1000 } });
      expect(code).toBe(1);
      expect(stderr.lines()).toMatch(/requires Node\.js >= 22\.13\.0 \(found 20\.0\.0\)/);
    } finally {
      stderr.restore();
    }
  });

  it('refuses to start as root and explains why', async () => {
    const stderr = captureStderr();
    try {
      const code = await runServer({ runtime: { nodeVersion: '22.13.0', uid: 0 } });
      expect(code).toBe(1);
      expect(stderr.lines()).toMatch(/must not run as root/);
    } finally {
      stderr.restore();
    }
  });

  it('returns 1 and rolls back when a component fails to start', async () => {
    const hooks: string[] = [];
    const first: LifecycleComponent = {
      name: 'first',
      async start() {
        hooks.push('start:first');
      },
      async stop() {
        hooks.push('stop:first');
      },
    };
    const second: LifecycleComponent = {
      name: 'second',
      async start() {
        throw new Error('second exploded');
      },
      async stop() {},
    };
    const stderr = captureStderr();
    try {
      const code = await runServer({
        components: [first, second],
        runtime: { nodeVersion: '22.13.0', uid: 1000 },
      });
      expect(code).toBe(1);
      expect(stderr.lines()).toMatch(/quotameter: second exploded/);
    } finally {
      stderr.restore();
    }
    expect(hooks).toEqual(['start:first', 'stop:first']);
  });

  it('releases a leaked component through a best-effort stop when startup fails', async () => {
    // The rollback stop (call 1) rejects; runServer's awaited stop() —
    // D-088's retry from 'failed' — is call 2 and releases the marker before
    // the failure code is returned. The release route exists from main.
    const leaky = leakyComponent('leaky', 1);
    const stderr = captureStderr();
    try {
      const code = await runServer({
        components: [leaky.component, brokenStart('broken')],
        runtime: { nodeVersion: '22.13.0', uid: 1000 },
      });
      expect(code).toBe(1);
      expect(leaky.released()).toBe(true);
      expect(leaky.stopCalls()).toBe(2);
      // The startup error is the diagnosis; the successful retry is silent.
      expect(stderr.lines()).toMatch(/quotameter: start failed: broken/);
      expect(stderr.lines()).not.toMatch(/failed to stop/);
    } finally {
      stderr.restore();
    }
  });

  it('logs and swallows a failed cleanup retry without masking the startup error', async () => {
    // Both the rollback stop (call 1) and runServer's retry (call 2) reject:
    // the retry failure is reported and swallowed — the startup error stays
    // what the process reports, and the exit code stays 1.
    const leaky = leakyComponent('leaky', 2);
    const stderr = captureStderr();
    try {
      const code = await runServer({
        components: [leaky.component, brokenStart('broken')],
        runtime: { nodeVersion: '22.13.0', uid: 1000 },
      });
      expect(code).toBe(1);
      // Exactly one retry attempt from the entry point; the component stays
      // held and addressable (D-088's repeatability remains the app's route).
      expect(leaky.stopCalls()).toBe(2);
      expect(leaky.released()).toBe(false);
      const lines = stderr.lines();
      expect(lines).toMatch(/quotameter: start failed: broken/);
      // This round's AggregateError, in the shutdown vocabulary.
      expect(lines).toMatch(/one or more components failed to stop: stop failed: leaky \(call 2\)/);
      // The startup error came first — the stop-failure report never masks it.
      expect(lines.indexOf('start failed: broken')).toBeLessThan(lines.indexOf('failed to stop'));
    } finally {
      stderr.restore();
    }
  });

  it('describes non-Error rejections without crashing', async () => {
    const strange: LifecycleComponent = {
      name: 'strange',
      async start() {
        throw 'plain string failure';
      },
      async stop() {},
    };
    const stderr = captureStderr();
    try {
      const code = await runServer({
        components: [strange],
        runtime: { nodeVersion: '22.13.0', uid: 1000 },
      });
      expect(code).toBe(1);
      expect(stderr.lines()).toMatch(/quotameter: plain string failure/);
    } finally {
      stderr.restore();
    }
  });

  it('returns 1 when a component fails to stop, after stopping the rest', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const hooks: string[] = [];
    const kick: LifecycleComponent = {
      name: 'kick',
      async start() {
        resolveStarted();
      },
      async stop() {},
    };
    const ok: LifecycleComponent = {
      name: 'ok',
      async start() {},
      async stop() {
        hooks.push('stop:ok');
      },
    };
    const broken: LifecycleComponent = {
      name: 'broken',
      async start() {},
      async stop() {
        throw new Error('broken stop');
      },
    };
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const stderr = captureStderr();

    try {
      const server = runServer({
        components: [kick, ok, broken],
        runtime: { nodeVersion: '22.13.0', uid: 1000 },
      });
      const handler = await sigtermHandlerAfter(onSpy, started);
      const manualShutdown = () => handler('SIGTERM');
      shutdownTriggers.push(manualShutdown);

      manualShutdown();
      await expect(server).resolves.toBe(1);
      // The manual call consumed this test's shutdown trigger — drop it so
      // the afterEach safety net does not fire a second shutdown after
      // captureStderr restored, whose fatal diagnostics then reach the real
      // stderr (the "broken stop" line noising up full-suite runs; U-010).
      const consumed = shutdownTriggers.indexOf(manualShutdown);
      if (consumed !== -1) shutdownTriggers.splice(consumed, 1);

      expect(hooks).toEqual(['stop:ok']);
      expect(stderr.lines()).toMatch(/one or more components failed to stop: broken stop/);
    } finally {
      stderr.restore();
    }
  });
});

describe('runServer (child process, real signals)', () => {
  // One runner boot per test plus the signal-and-exit phase (measured
  // 1.9–2.0 s ambient, 5.5 s worst in a full coverage `make check` under
  // the six-hog rig, pool load ~16 — U-044/D-163). 30 s is the house
  // value for the shape (the U-039 real-launcher pin) at ≈5× that worst;
  // the 20 s marker-wait default above fits inside it with the exit
  // phase to spare.
  const CHILD_TIMEOUT = 30_000;

  async function runUntilCleanStop(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    const dir: TempDir = await createTempDir(`quotameter-server-${signal.toLowerCase()}-`);
    let child: ChildProcess | undefined;
    try {
      const started = startRunner('ok', dir.path);
      child = started.child;
      // Wait for signal readiness, not `started`: the marker component starts
      // before `runServer` installs the signal handlers, and a signal
      // delivered in that window kills the handler-less child via the
      // OS-default disposition (the U-001 race). `signals-ready` is emitted
      // only once both handlers are installed, so the kill below is always
      // caught.
      await waitForFile(join(dir.path, 'signals-ready'));

      started.child.kill(signal);
      const result = await started.exited;

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(existsSync(join(dir.path, 'started'))).toBe(true);
      expect(existsSync(join(dir.path, 'stopped'))).toBe(true);
    } finally {
      if (child) killIfAlive(child);
      await dir.remove();
    }
  }

  it(
    'starts, shuts down cleanly on SIGTERM, and exits 0',
    () => runUntilCleanStop('SIGTERM'),
    CHILD_TIMEOUT,
  );

  it('shuts down cleanly on SIGINT as well', () => runUntilCleanStop('SIGINT'), CHILD_TIMEOUT);

  it(
    'exits 1 with an explanation on an unsupported Node.js version',
    async () => {
      const dir = await createTempDir('quotameter-server-oldnode-');
      let child: ChildProcess | undefined;
      try {
        const started = startRunner('old-node', dir.path);
        child = started.child;
        const result = await started.exited;

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/requires Node\.js >= 22\.13\.0 \(found 22\.12\.0\)/);
        expect(existsSync(join(dir.path, 'started'))).toBe(false);
      } finally {
        if (child) killIfAlive(child);
        await dir.remove();
      }
    },
    CHILD_TIMEOUT,
  );

  it(
    'exits 1 with an explanation when started as root',
    async () => {
      const dir = await createTempDir('quotameter-server-root-');
      let child: ChildProcess | undefined;
      try {
        const started = startRunner('root', dir.path);
        child = started.child;
        const result = await started.exited;

        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/must not run as root/);
      } finally {
        if (child) killIfAlive(child);
        await dir.remove();
      }
    },
    CHILD_TIMEOUT,
  );
});
