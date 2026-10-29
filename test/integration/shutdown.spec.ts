import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { type LifecycleComponent, QuotameterApp } from '../../src/server/app';
import { runServer } from '../../src/server/main';
import {
  createGracefulDrain,
  createInFlightTracker,
  MAX_DRAIN_TIMEOUT_MS,
  type ScheduleTimeout,
  type ShutdownEvent,
} from '../../src/server/shutdown';

/**
 * Graceful-shutdown coordination (task 075, spec §5.6, §17.1).
 *
 * The polling service (109+), HTTP listener (146), and storage (078+) do not
 * exist yet, so they appear here as the lifecycle-component mocks task 060's
 * design reserved: schedulers that "stop scheduling" in their `stop`, storage
 * that closes/checkpoints in its `stop`, the lock of task 074 released last.
 * Around them, the real drain component must realize the §5.6 sequence —
 * stop scheduling, wait (bounded at 10 s) for in-flight work, close storage,
 * release the lock — including the done-condition: an in-flight mock request
 * resolving slowly during shutdown.
 *
 * Timing is deterministic: the timeout clock is injected (no fake-timer
 * patching of process globals, which Stryker's worker threads forbid); the
 * real-timer cases wait ≤ 50 ms, and their one elapsed assertion is a lower
 * bound only, which a correct timer can never undershoot.
 */

/** A component whose hooks append their name to the shared log. */
function step(log: string[], name: string, failStop = false): LifecycleComponent {
  return {
    name,
    async start() {},
    async stop() {
      log.push(`stop:${name}`);
      if (failStop) throw new Error(`stop failed: ${name}`);
    },
  };
}

/** Pushes drain events into the shared log by type, keeping the full order. */
function eventSink(log: string[], events: ShutdownEvent[]): (event: ShutdownEvent) => void {
  return (event) => {
    events.push(event);
    log.push(event.type);
  };
}

/** Deterministic timeout clock: capture the requested timeout, fire by hand. */
function controlledClock(): {
  scheduleTimeout: ScheduleTimeout;
  fireTimeout(): void;
  readonly scheduled: number;
  readonly requestedMs: number;
  readonly cancelled: boolean;
} {
  let callback: (() => void) | undefined;
  let scheduled = 0;
  let requestedMs = 0;
  let cancelled = false;
  return {
    scheduleTimeout(cb: () => void, ms: number) {
      callback = cb;
      scheduled += 1;
      requestedMs = ms;
      cancelled = false;
      return () => {
        cancelled = true;
      };
    },
    fireTimeout() {
      callback?.();
    },
    get scheduled() {
      return scheduled;
    },
    get requestedMs() {
      return requestedMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * Resolves 'pending' unless `promise` settles within the current microtask
 * queue — proves a shutdown is genuinely blocked without real-time waits.
 */
async function pendingness(promise: Promise<unknown>): Promise<'pending' | 'settled'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    Promise.resolve().then(() => 'pending' as const),
  ]);
}

/** Lets every already-resolvable await run: the app reaches the drain's wait. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface AssemblyOptions {
  readonly timeoutMs?: number;
  readonly scheduleTimeout?: ScheduleTimeout;
  /** Name of a component whose stop throws (error-isolation scenarios). */
  readonly failStop?: string;
}

/** Assembles the §5.6 registration order around the real drain component. */
function assembleApp(options: AssemblyOptions = {}) {
  const log: string[] = [];
  const events: ShutdownEvent[] = [];
  const inFlight = createInFlightTracker();
  const app = new QuotameterApp({
    components: [
      step(log, 'lock'),
      step(log, 'storage', options.failStop === 'storage'),
      createGracefulDrain({
        inFlight,
        timeoutMs: options.timeoutMs,
        scheduleTimeout: options.scheduleTimeout,
        onEvent: eventSink(log, events),
      }),
      step(log, 'polling'),
      step(log, 'http'),
    ],
  });
  return { app, log, events, inFlight };
}

describe('createInFlightTracker', () => {
  it('counts begun and completed operations', () => {
    const tracker = createInFlightTracker();
    expect(tracker.count).toBe(0);
    const first = tracker.begin();
    const second = tracker.begin();
    expect(tracker.count).toBe(2);
    first.done();
    expect(tracker.count).toBe(1);
    second.done();
    expect(tracker.count).toBe(0);
  });

  it('treats done() as idempotent per operation', () => {
    const tracker = createInFlightTracker();
    const operation = tracker.begin();
    operation.done();
    operation.done();
    operation.done();
    expect(tracker.count).toBe(0);
  });

  it('resolves whenIdle immediately when nothing is in flight', async () => {
    const tracker = createInFlightTracker();
    await expect(tracker.whenIdle()).resolves.toBeUndefined();
  });

  it('resolves whenIdle exactly when the last operation completes', async () => {
    const tracker = createInFlightTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    let settled = false;
    void tracker.whenIdle().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    first.done();
    await flushMicrotasks();
    expect(settled).toBe(false); // one operation still in flight
    second.done();
    await flushMicrotasks();
    expect(settled).toBe(true); // notified on the transition to zero
  });

  it('resolves every concurrent idle waiter', async () => {
    const tracker = createInFlightTracker();
    const operation = tracker.begin();
    const waits = [tracker.whenIdle(), tracker.whenIdle(), tracker.whenIdle()];
    operation.done();
    const settled = await Promise.all(waits.map((wait) => wait.then(() => 'resolved' as const)));
    expect(settled).toEqual(['resolved', 'resolved', 'resolved']);
  });
});

describe('createGracefulDrain option validation', () => {
  const tracker = createInFlightTracker();

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, MAX_DRAIN_TIMEOUT_MS + 1])(
    'rejects timeoutMs %s (the §5.6 bound is an invariant, not a knob)',
    (timeoutMs) => {
      expect(() => createGracefulDrain({ inFlight: tracker, timeoutMs })).toThrow(
        /graceful-drain timeoutMs must be a finite number/,
      );
    },
  );

  it('accepts the spec bound and positive values below it', () => {
    expect(() =>
      createGracefulDrain({ inFlight: tracker, timeoutMs: MAX_DRAIN_TIMEOUT_MS }),
    ).not.toThrow();
    expect(() => createGracefulDrain({ inFlight: tracker, timeoutMs: 1 })).not.toThrow();
    expect(() => createGracefulDrain({ inFlight: tracker })).not.toThrow();
  });

  it('pins the §5.6 bound to ten seconds', () => {
    expect(MAX_DRAIN_TIMEOUT_MS).toBe(10_000);
  });
});

describe('graceful-drain component', () => {
  it('starts as a no-op and stops silently when nothing is in flight', async () => {
    const events: ShutdownEvent[] = [];
    const drain = createGracefulDrain({
      inFlight: createInFlightTracker(),
      timeoutMs: 1_000,
      onEvent: (event) => events.push(event),
    });

    await drain.start();
    await drain.stop();

    expect(events).toEqual([]); // a clean no-traffic shutdown logs nothing
  });

  it('waits for a slowly resolving in-flight operation, then completes (done-condition)', async () => {
    const inFlight = createInFlightTracker();
    const events: ShutdownEvent[] = [];
    let clockValue = 1_000;
    const drain = createGracefulDrain({
      inFlight,
      onEvent: (event) => events.push(event),
      now: () => (clockValue += 50), // drain starts at 1050, completes at 1100
    });
    const operation = inFlight.begin();

    const stopping = drain.stop();
    expect(await pendingness(stopping)).toBe('pending');
    expect(events).toEqual([
      { type: 'drain-started', inFlight: 1, timeoutMs: MAX_DRAIN_TIMEOUT_MS },
    ]);

    operation.done(); // the slow request finally settles
    await stopping;

    expect(events).toEqual([
      { type: 'drain-started', inFlight: 1, timeoutMs: MAX_DRAIN_TIMEOUT_MS },
      { type: 'drain-completed', waitedMs: 50 },
    ]);
    expect(inFlight.count).toBe(0);
  });

  it('abandons the wait at the bound and reports forced completion', async () => {
    const inFlight = createInFlightTracker();
    const events: ShutdownEvent[] = [];
    const clock = controlledClock();
    const drain = createGracefulDrain({
      inFlight,
      timeoutMs: 25,
      scheduleTimeout: clock.scheduleTimeout,
      onEvent: (event) => events.push(event),
    });
    const operation = inFlight.begin(); // never completes in time

    const stopping = drain.stop();
    expect(await pendingness(stopping)).toBe('pending');
    expect(clock.scheduled).toBe(1);
    expect(clock.requestedMs).toBe(25);
    clock.fireTimeout(); // the §5.6 bound expires
    await stopping;

    expect(events).toEqual([
      { type: 'drain-started', inFlight: 1, timeoutMs: 25 },
      { type: 'drain-timeout', inFlight: 1, timeoutMs: 25 },
    ]);

    // A late completion after the abandoned drain is harmless.
    operation.done();
    expect(inFlight.count).toBe(0);
  });

  it('cancels the timeout once idle — no timer outlives the shutdown', async () => {
    const inFlight = createInFlightTracker();
    const clock = controlledClock();
    const drain = createGracefulDrain({
      inFlight,
      timeoutMs: 5_000,
      scheduleTimeout: clock.scheduleTimeout,
    });
    const operation = inFlight.begin();

    const stopping = drain.stop();
    expect(clock.cancelled).toBe(false);
    operation.done();
    await stopping;

    expect(clock.cancelled).toBe(true);
    expect(clock.scheduled).toBe(1);
  });

  it('settles the idle drain even when an injected canceller throws', async () => {
    const inFlight = createInFlightTracker();
    const drain = createGracefulDrain({
      inFlight,
      timeoutMs: 5_000,
      scheduleTimeout: () => () => {
        throw new Error('canceller is broken');
      },
    });
    const operation = inFlight.begin();

    const stopping = drain.stop();
    operation.done();
    await expect(stopping).resolves.toBeUndefined(); // settle must not depend on the seam
  });

  it('survives a throwing diagnostics sink', async () => {
    const inFlight = createInFlightTracker();
    const clock = controlledClock();
    const drain = createGracefulDrain({
      inFlight,
      timeoutMs: 10,
      scheduleTimeout: clock.scheduleTimeout,
      onEvent: () => {
        throw new Error('sink is broken');
      },
    });
    const operation = inFlight.begin();

    const stopping = drain.stop();
    clock.fireTimeout();
    await expect(stopping).resolves.toBeUndefined();
    operation.done();
  });

  it('times out against the default clock within the requested bound', async () => {
    const inFlight = createInFlightTracker();
    const events: ShutdownEvent[] = [];
    const drain = createGracefulDrain({
      inFlight,
      timeoutMs: 30,
      onEvent: (event) => events.push(event),
    });
    inFlight.begin(); // never completes

    const startedAt = performance.now(); // monotonic: immune to wall-clock steps
    await drain.stop();

    // A 30 ms timer cannot fire early, so at least 25 ms have passed.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(events).toEqual([
      { type: 'drain-started', inFlight: 1, timeoutMs: 30 },
      { type: 'drain-timeout', inFlight: 1, timeoutMs: 30 },
    ]);
  });
});

describe('§5.6 shutdown sequence through QuotameterApp', () => {
  it('stops scheduling, drains in-flight work, then closes storage and releases the lock', async () => {
    const { app, log, inFlight } = assembleApp();
    await app.start();
    const operation = inFlight.begin();

    const stopping = app.stop();
    await flushMicrotasks();
    // The drain blocks the teardown: storage and the lock wait behind it.
    expect(log).toEqual(['stop:http', 'stop:polling', 'drain-started']);
    expect(await pendingness(stopping)).toBe('pending');

    operation.done(); // the slow in-flight request settles
    await stopping;

    expect(log).toEqual([
      'stop:http',
      'stop:polling',
      'drain-started',
      'drain-completed',
      'stop:storage',
      'stop:lock',
    ]);
    expect(app.state).toBe('stopped');
  });

  it('shuts an idle application down without drain diagnostics', async () => {
    const { app, log, events } = assembleApp();
    await app.start();

    await app.stop();

    expect(log).toEqual(['stop:http', 'stop:polling', 'stop:storage', 'stop:lock']);
    expect(events).toEqual([]);
  });

  it('forces completion at the bound and still closes storage and releases the lock', async () => {
    const clock = controlledClock();
    const { app, log, events, inFlight } = assembleApp({
      timeoutMs: 10,
      scheduleTimeout: clock.scheduleTimeout,
    });
    await app.start();
    inFlight.begin(); // never completes

    const stopping = app.stop();
    await flushMicrotasks();
    clock.fireTimeout();
    await stopping;

    expect(log).toEqual([
      'stop:http',
      'stop:polling',
      'drain-started',
      'drain-timeout',
      'stop:storage',
      'stop:lock',
    ]);
    expect(events[1]).toEqual({ type: 'drain-timeout', inFlight: 1, timeoutMs: 10 });
  });

  it('keeps draining and releasing the lock when closing storage fails', async () => {
    const { app, log, inFlight } = assembleApp({ failStop: 'storage' });
    await app.start();
    const operation = inFlight.begin();

    const stopping = app.stop();
    await flushMicrotasks();
    expect(log).toEqual(['stop:http', 'stop:polling', 'drain-started']);
    operation.done();

    await expect(stopping).rejects.toThrow('one or more components failed to stop');

    // The drain ran before the failing stop; the lock behind it still released.
    expect(log).toEqual([
      'stop:http',
      'stop:polling',
      'drain-started',
      'drain-completed',
      'stop:storage',
      'stop:lock',
    ]);
    expect(app.state).toBe('stopped');
  });
});

describe('runServer end-to-end (in-process, SIGTERM)', () => {
  // Firing these after a failed test settles any `runServer` promise that is
  // still pending, so its keep-alive interval cannot hang the worker instead
  // of producing a crisp failure report. The drain bound of the test below
  // (100 ms) keeps such a worst-case shutdown short.
  const DRAIN_BOUND_MS = 100;
  const shutdownTriggers: Array<() => void> = [];
  let activeServer: Promise<number> | undefined;

  afterEach(async () => {
    const pending = shutdownTriggers.splice(0);
    for (const trigger of pending) trigger();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (activeServer !== undefined && (await pendingness(activeServer)) === 'pending') {
      // Worst case (a failed test): give a signal-triggered shutdown with a
      // bounded drain time to settle so no keep-alive handle hangs the worker.
      // On the green path the server has already settled and no wait is paid.
      await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_BOUND_MS + 150));
    }
    activeServer = undefined;
    vi.restoreAllMocks();
  });

  function lastSigtermHandler(
    onSpy: MockInstance<typeof process.on>,
  ): (signal: NodeJS.Signals) => void {
    const call = onSpy.mock.calls.filter(([event]) => event === 'SIGTERM').at(-1);
    expect(call, 'runServer did not register a SIGTERM handler').toBeDefined();
    return call?.[1] as (signal: NodeJS.Signals) => void;
  }

  it('drains the in-flight request between scheduling shutdown and storage close, exiting 0', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const log: string[] = [];
    const events: ShutdownEvent[] = [];
    const inFlight = createInFlightTracker();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const http: LifecycleComponent = {
      name: 'http',
      async start() {
        resolveStarted();
      },
      async stop() {
        log.push('stop:http');
      },
    };

    const server = runServer({
      components: [
        step(log, 'lock'),
        step(log, 'storage'),
        createGracefulDrain({
          inFlight,
          timeoutMs: DRAIN_BOUND_MS,
          onEvent: eventSink(log, events),
        }),
        step(log, 'polling'),
        http,
      ],
      runtime: { nodeVersion: '22.13.0', uid: 1000 },
    });
    activeServer = server;
    await started;
    await flushMicrotasks(); // runServer installs its signal handlers after start
    const handler = lastSigtermHandler(onSpy);
    shutdownTriggers.push(() => handler('SIGTERM'));

    const operation = inFlight.begin(); // an in-flight request outlives scheduling shutdown
    handler('SIGTERM');
    await flushMicrotasks();
    expect(log).toEqual(['stop:http', 'stop:polling', 'drain-started']);
    expect(await pendingness(server)).toBe('pending'); // the process is still draining

    operation.done(); // the slow request settles well within the bound
    await expect(server).resolves.toBe(0);

    expect(log).toEqual([
      'stop:http',
      'stop:polling',
      'drain-started',
      'drain-completed',
      'stop:storage',
      'stop:lock',
    ]);
  });
});
