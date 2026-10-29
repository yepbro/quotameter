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
