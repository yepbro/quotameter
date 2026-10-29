import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTempDir, type TempDir } from '../helpers/isolation';
import type { LifecycleComponent } from '../../src/server/app';
import {
  buildComponents,
  currentRuntime,
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

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
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
      /requires Node\.js >= 22\.13\.0 \(found 22\.12\.9\); refusing to start/,
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

describe('buildComponents', () => {
  it('assembles no components at the bootstrap stage', () => {
    expect(buildComponents()).toEqual([]);
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

  it('runs with the assembled default components when none are passed', async () => {
    const onSpy = vi.spyOn(process, 'on');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // No `components`: the bootstrap assembly from buildComponents() runs —
    // the "starts and stops cleanly without collecting provider data"
    // milestone through the production default.
    const server = runServer({
      runtime: { nodeVersion: '22.13.0', uid: 1000 },
      onSignalsReady: () => resolveReady(),
    });
    const handler = await sigtermHandlerAfter(onSpy, ready);
    shutdownTriggers.push(() => handler('SIGTERM'));

    handler('SIGTERM');
    await expect(server).resolves.toBe(0);
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
      shutdownTriggers.push(() => handler('SIGTERM'));

      handler('SIGTERM');
      await expect(server).resolves.toBe(1);

      expect(hooks).toEqual(['stop:ok']);
      expect(stderr.lines()).toMatch(/one or more components failed to stop: broken stop/);
    } finally {
      stderr.restore();
    }
  });
});

describe('runServer (child process, real signals)', () => {
  const CHILD_TIMEOUT = 20_000;

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
