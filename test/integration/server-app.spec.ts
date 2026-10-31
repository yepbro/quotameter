import { describe, expect, it } from 'vitest';
import { type LifecycleComponent, type LifecycleEvent, QuotameterApp } from '../../src/server/app';

/**
 * Lifecycle semantics of the application skeleton (task 060, spec §5.6):
 * registration-order startup, reverse-order shutdown, rollback on startup
 * failure, and idempotent signal-safe stopping.
 */

/** A component that records every hook call into the shared log. */
function recorder(
  log: string[],
  name: string,
  failure: 'start' | 'stop' | undefined = undefined,
): LifecycleComponent {
  return {
    name,
    async start() {
      log.push(`start:${name}`);
      if (failure === 'start') throw new Error(`start failed: ${name}`);
    },
    async stop() {
      log.push(`stop:${name}`);
      if (failure === 'stop') throw new Error(`stop failed: ${name}`);
    },
  };
}

/** A component whose `start` blocks until the gate is released. */
function gatedStart(name: string, gate: Promise<void>): LifecycleComponent {
  return {
    name,
    async start() {
      await gate;
    },
    async stop() {},
  };
}

/**
 * A component that owns a release marker: its `stop` rejects on the first
 * `failStops` calls and releases the marker on the next one — the
 * resource-leak shape this suite pins (a rejected rollback stop leaves the
 * marker held until a `stop()` retry succeeds; `Number.POSITIVE_INFINITY`
 * never releases). The rejection message carries the call number, so a
 * round's `AggregateError` can be told apart from any other round's.
 */
function leakyComponent(log: string[], name: string, failStops: number) {
  let stopCalls = 0;
  let released = false;
  const component: LifecycleComponent = {
    name,
    async start() {
      log.push(`start:${name}`);
    },
    async stop() {
      log.push(`stop:${name}`);
      stopCalls += 1;
      if (stopCalls <= failStops) throw new Error(`stop failed: ${name} (call ${stopCalls})`);
      released = true;
    },
  };
  return { component, released: () => released };
}

describe('QuotameterApp', () => {
  it('runs cleanly with zero components — the bootstrap milestone', async () => {
    const app = new QuotameterApp({ components: [] });
    await app.start();
    expect(app.running).toBe(true);
    await app.stop();
    expect(app.state).toBe('stopped');
  });

  it('starts components in registration order and emits lifecycle events', async () => {
    const log: string[] = [];
    const events: LifecycleEvent[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a'), recorder(log, 'b')],
      onLifecycle: (event) => events.push(event),
    });

    expect(app.state).toBe('created');
    await app.start();

    expect(app.state).toBe('running');
    expect(app.running).toBe(true);
    expect(log).toEqual(['start:a', 'start:b']);
    expect(events).toEqual([
      { type: 'state-change', state: 'starting' },
      { type: 'component-started', component: 'a' },
      { type: 'component-started', component: 'b' },
      { type: 'state-change', state: 'running' },
    ]);
  });

  it('stops components in reverse registration order', async () => {
    const log: string[] = [];
    const events: LifecycleEvent[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a'), recorder(log, 'b'), recorder(log, 'c')],
      onLifecycle: (event) => events.push(event),
    });
    await app.start();

    await app.stop();

    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:a', 'start:b', 'start:c', 'stop:c', 'stop:b', 'stop:a']);
    expect(events.slice(5)).toEqual([
      { type: 'state-change', state: 'stopping' },
      { type: 'component-stopped', component: 'c' },
      { type: 'component-stopped', component: 'b' },
      { type: 'component-stopped', component: 'a' },
      { type: 'state-change', state: 'stopped' },
    ]);
  });

  it('rolls back started components when one fails to start', async () => {
    const log: string[] = [];
    const events: LifecycleEvent[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a'), recorder(log, 'b', 'start'), recorder(log, 'c')],
      onLifecycle: (event) => events.push(event),
    });

    await expect(app.start()).rejects.toThrow('start failed: b');

    expect(app.state).toBe('failed');
    expect(log).toEqual(['start:a', 'start:b', 'stop:a']);
    // The rollback stops are part of the lifecycle record, not silent teardown.
    expect(events).toContainEqual({ type: 'component-stopped', component: 'a' });
    expect(events.at(-1)).toEqual({ type: 'state-change', state: 'failed' });
  });

  it('keeps rolling back when a rollback stop also fails', async () => {
    const log: string[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a', 'stop'), recorder(log, 'b', 'start')],
    });

    await expect(app.start()).rejects.toThrow('start failed: b');

    expect(app.state).toBe('failed');
    expect(log).toEqual(['start:a', 'start:b', 'stop:a']);
  });

  it('releases a component whose rollback stop rejected through a stop() retry', async () => {
    const log: string[] = [];
    const events: LifecycleEvent[] = [];
    const leaky = leakyComponent(log, 'leaky', 1);
    const app = new QuotameterApp({
      components: [leaky.component, recorder(log, 'broken', 'start')],
      onLifecycle: (event) => events.push(event),
    });

    await expect(app.start()).rejects.toThrow('start failed: broken');

    expect(app.state).toBe('failed');
    expect(log).toEqual(['start:leaky', 'start:broken', 'stop:leaky']);
    expect(leaky.released()).toBe(false);

    await app.stop();

    // The retry released exactly the unreleased component; `broken` never
    // started, so it is never stopped.
    expect(leaky.released()).toBe(true);
    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:leaky', 'start:broken', 'stop:leaky', 'stop:leaky']);
    // The failed rollback stop emitted nothing; the successful retry does.
    expect(events.filter((event) => event.type === 'component-stopped')).toEqual([
      { type: 'component-stopped', component: 'leaky' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'state-change', state: 'stopped' });
  });

  it('retries only the components the rollback could not release', async () => {
    const log: string[] = [];
    const leaky = leakyComponent(log, 'leaky', 1);
    const app = new QuotameterApp({
      components: [recorder(log, 'clean'), leaky.component, recorder(log, 'broken', 'start')],
    });

    await expect(app.start()).rejects.toThrow('start failed: broken');

    await app.stop();

    // `clean` was released by the rollback and is never stopped again; the
    // retry touches exactly `leaky`.
    expect(leaky.released()).toBe(true);
    expect(app.state).toBe('stopped');
    expect(log).toEqual([
      'start:clean',
      'start:leaky',
      'start:broken',
      'stop:leaky',
      'stop:clean',
      'stop:leaky',
    ]);
  });

  it('reports a failed retry as an AggregateError and stays retryable', async () => {
    const log: string[] = [];
    const leaky = leakyComponent(log, 'leaky', Number.POSITIVE_INFINITY);
    const app = new QuotameterApp({
      components: [leaky.component, recorder(log, 'broken', 'start')],
    });

    await expect(app.start()).rejects.toThrow('start failed: broken');

    const failure: AggregateError = await app.stop().then(
      () => {
        throw new Error('expected stop() to reject');
      },
      (error: unknown) => error as AggregateError,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('one or more components failed to stop');
    expect(failure.errors).toHaveLength(1);
    // The retry round's own error (rollback was call 1, this round call 2),
    // not the historical rollback rejection re-surfaced.
    expect((failure.errors[0] as Error).message).toBe('stop failed: leaky (call 2)');
    expect(app.state).toBe('failed');

    // The retry is repeatable: the next stop() calls the component again.
    await expect(app.stop()).rejects.toThrow(AggregateError);
    expect(log).toEqual(['start:leaky', 'start:broken', 'stop:leaky', 'stop:leaky', 'stop:leaky']);
  });

  it('keeps retrying until every component is released', async () => {
    const log: string[] = [];
    // The rollback stop and the first retry fail; the second retry releases.
    const leaky = leakyComponent(log, 'leaky', 2);
    const app = new QuotameterApp({
      components: [recorder(log, 'clean'), leaky.component, recorder(log, 'broken', 'start')],
    });

    await expect(app.start()).rejects.toThrow('start failed: broken');
    await expect(app.stop()).rejects.toThrow(AggregateError);
    expect(app.state).toBe('failed');

    await app.stop();

    expect(leaky.released()).toBe(true);
    expect(app.state).toBe('stopped');
    // `clean` stopped exactly once (rollback); `leaky` three times: the
    // rollback plus two retries.
    expect(log).toEqual([
      'start:clean',
      'start:leaky',
      'start:broken',
      'stop:leaky',
      'stop:clean',
      'stop:leaky',
      'stop:leaky',
    ]);
  });

  it('retries only the still-unreleased components of a partially failed round', async () => {
    const log: string[] = [];
    // Both reject their rollback stop; the first retry releases
    // `recovering` but not `stubborn`, so the final round retries exactly
    // `stubborn` — never the sibling the earlier round already released.
    const stubborn = leakyComponent(log, 'stubborn', 2);
    const recovering = leakyComponent(log, 'recovering', 1);
    const app = new QuotameterApp({
      components: [
        recorder(log, 'clean'),
        stubborn.component,
        recovering.component,
        recorder(log, 'broken', 'start'),
      ],
    });

    await expect(app.start()).rejects.toThrow('start failed: broken');

    const firstRound: AggregateError = await app.stop().then(
      () => {
        throw new Error('expected stop() to reject');
      },
      (error: unknown) => error as AggregateError,
    );
    expect(app.state).toBe('failed');
    // Exactly this round's errors: `stubborn`'s second call, neither the
    // historical rollback rejections nor `recovering`, which this round
    // released.
    expect(firstRound.errors.map((error) => (error as Error).message)).toEqual([
      'stop failed: stubborn (call 2)',
    ]);

    await app.stop();

    expect(stubborn.released()).toBe(true);
    expect(recovering.released()).toBe(true);
    expect(app.state).toBe('stopped');
    // `clean`: once (rollback). `recovering`: twice (rollback + first
    // retry). `stubborn`: three times (rollback + two retries).
    expect(log).toEqual([
      'start:clean',
      'start:stubborn',
      'start:recovering',
      'start:broken',
      'stop:recovering',
      'stop:stubborn',
      'stop:clean',
      'stop:recovering',
      'stop:stubborn',
      'stop:stubborn',
    ]);
  });

  it('keeps stop a no-op from failed when the rollback released everything', async () => {
    const log: string[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a'), recorder(log, 'b', 'start')],
    });

    await expect(app.start()).rejects.toThrow('start failed: b');
    await app.stop();

    expect(log).toEqual(['start:a', 'start:b', 'stop:a']);
    expect(app.state).toBe('failed');
  });

  it('coalesces concurrent stop calls from failed into one retry', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopCalls = 0;
    let released = false;
    const leaky: LifecycleComponent = {
      name: 'leaky',
      async start() {
        log.push('start:leaky');
      },
      async stop() {
        stopCalls += 1;
        log.push(`stop:leaky:${stopCalls}`);
        if (stopCalls === 1) throw new Error('stop failed: leaky');
        await gate;
        released = true;
      },
    };
    const app = new QuotameterApp({ components: [leaky, recorder(log, 'broken', 'start')] });

    await expect(app.start()).rejects.toThrow('start failed: broken');

    const first = app.stop();
    const second = app.stop();
    release();
    await Promise.all([first, second]);

    expect(released).toBe(true);
    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:leaky', 'start:broken', 'stop:leaky:1', 'stop:leaky:2']);
    // After the successful retry, stop() returns the settled success — the
    // component is not stopped again.
    await app.stop();
    expect(log).toEqual(['start:leaky', 'start:broken', 'stop:leaky:1', 'stop:leaky:2']);
  });

  it('refuses to start from any non-created state', async () => {
    const running = new QuotameterApp({ components: [] });
    await running.start();
    await expect(running.start()).rejects.toThrow(
      'cannot start the application from state "running"',
    );

    const stopped = new QuotameterApp({ components: [] });
    await stopped.start();
    await stopped.stop();
    await expect(stopped.start()).rejects.toThrow(
      'cannot start the application from state "stopped"',
    );

    const failed = new QuotameterApp({ components: [recorder([], 'x', 'start')] });
    await expect(failed.start()).rejects.toThrow('start failed: x');
    await expect(failed.start()).rejects.toThrow(
      'cannot start the application from state "failed"',
    );
  });

  it('treats stop as a no-op before the app ever started', async () => {
    const log: string[] = [];
    const app = new QuotameterApp({ components: [recorder(log, 'a')] });

    await app.stop();

    expect(log).toEqual([]);
    expect(app.state).toBe('created');
  });

  it('refuses to stop while the app is starting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new QuotameterApp({ components: [gatedStart('gated', gate)] });
    const starting = app.start();

    await expect(app.stop()).rejects.toThrow('cannot stop the application while it is starting');

    release();
    await starting;
  });

  it('coalesces concurrent and repeated stop calls into one shutdown', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LifecycleComponent = {
      name: 'slow',
      async start() {},
      async stop() {
        log.push('stop:slow');
        await gate;
      },
    };
    const app = new QuotameterApp({ components: [recorder(log, 'a'), slow] });
    await app.start();

    const first = app.stop();
    const second = app.stop();
    release();
    await Promise.all([first, second]);

    await app.stop();

    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:a', 'stop:slow', 'stop:a']);
  });

  it('stops every component even when one stop fails, and reports all failures', async () => {
    const log: string[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a'), recorder(log, 'b', 'stop'), recorder(log, 'c')],
    });
    await app.start();

    const failure: AggregateError = await app.stop().then(
      () => {
        throw new Error('expected stop() to reject');
      },
      (error: unknown) => error as AggregateError,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('one or more components failed to stop');
    expect(failure.errors).toHaveLength(1);
    expect((failure.errors[0] as Error).message).toBe('stop failed: b');
    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:a', 'start:b', 'start:c', 'stop:c', 'stop:b', 'stop:a']);
    // A later stop() re-rejects with the settled result: the failure must not
    // be masked from callers that arrive after the first shutdown failed.
    await expect(app.stop()).rejects.toThrow(AggregateError);
  });

  it('is unaffected by a throwing lifecycle sink', async () => {
    const log: string[] = [];
    const app = new QuotameterApp({
      components: [recorder(log, 'a')],
      onLifecycle: () => {
        throw new Error('sink is broken');
      },
    });

    await app.start();
    await app.stop();

    expect(app.state).toBe('stopped');
    expect(log).toEqual(['start:a', 'stop:a']);
  });
});
