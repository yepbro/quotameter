import { describe, expect, it } from 'vitest';
import { QuotameterApp, type LifecycleComponent, type LifecycleEvent } from '../../src/server/app';
import type { ShutdownEvent } from '../../src/server/shutdown';
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOGGER_NAME,
  LOG_LEVEL_LADDER,
  REDACTED,
  createLifecycleSink,
  createLogger,
  type LadderLevel,
} from '../../src/util/logger';
import { createMemoryLogSink, createThrowingLogSink } from '../helpers/logSink';

/**
 * Unit tests for the structure and lifecycle seam of src/util/logger.ts
 * (spec §16, decision D-025). Secret-leak coverage lives in
 * logger-redaction.spec.ts; this file pins output shape, level control,
 * child loggers, and the D-020 seam contract.
 */

/** Pino's numeric `level` values, used to identify each emitted record. */
const LEVEL_VALUES: Record<LadderLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Levels at or above `level` on the Pino ladder — the ones that may emit. */
function levelsFrom(level: LadderLevel): LadderLevel[] {
  const start = LOG_LEVEL_LADDER.indexOf(level);
  return LOG_LEVEL_LADDER.filter((_, index) => index >= start);
}

describe('createLogger', () => {
  it('defaults to the spec §16 level and name', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    expect(DEFAULT_LOG_LEVEL).toBe('warn');
    expect(logger.level).toBe('warn');
    logger.warn('hello');
    const record = sink.singleRecord();
    expect(record.name).toBe(DEFAULT_LOGGER_NAME);
    expect(record.msg).toBe('hello');
    expect(record.level).toBe(LEVEL_VALUES.warn);
    expect(typeof record.time).toBe('number');
  });

  it('emits valid JSON records at every level with level filtering', () => {
    for (const level of LOG_LEVEL_LADDER) {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level, destination: sink });
      for (const emitter of LOG_LEVEL_LADDER) {
        logger[emitter](`message at ${emitter}`);
      }
      const expected = levelsFrom(level);
      const records = sink.records();
      expect(records.map((record) => record.msg)).toEqual(expected.map((l) => `message at ${l}`));
      for (const [index, record] of records.entries()) {
        expect(record.level).toBe(LEVEL_VALUES[expected[index]!]);
        expect(typeof record.time).toBe('number');
      }
    }
  });

  it('suppresses info and debug at the default level (spec §16)', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    logger.info('info');
    logger.debug('debug');
    logger.warn('warn');
    logger.error('error');
    expect(sink.records().map((record) => record.msg)).toEqual(['warn', 'error']);
  });

  it('carries structured data fields on the record', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    logger.error('poll failed', { component: 'polling', attempt: 3, retryable: true });
    const record = sink.singleRecord();
    expect(record.component).toBe('polling');
    expect(record.attempt).toBe(3);
    expect(record.retryable).toBe(true);
  });

  it('rejects an unknown level at construction with the ladder listed', () => {
    expect(() => createLogger({ level: 'verbose' as LadderLevel })).toThrow(
      /log level must be one of: trace, debug, info, warn, error, fatal; got 'verbose'/,
    );
  });

  it('honors a custom name', () => {
    const sink = createMemoryLogSink();
    createLogger({ name: 'cli', destination: sink }).warn('hello');
    expect(sink.records()[0]?.name).toBe('cli');
  });

  it('constructs against the default destination when none is injected', () => {
    // Exercises the `process.stdout` wiring branch by construction; no
    // record is ever emitted, so the real stdout stays untouched.
    expect(() => createLogger()).not.toThrow();
    expect(createLogger().level).toBe('warn');
  });
});

describe('level control', () => {
  it('setLevel changes filtering at runtime', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', destination: sink });
    logger.info('before');
    logger.setLevel('info');
    logger.info('after');
    expect(sink.records().map((record) => record.msg)).toEqual(['after']);
    expect(logger.level).toBe('info');
  });

  it('setLevel rejects an unknown level', () => {
    const logger = createLogger({ destination: createMemoryLogSink() });
    expect(() => logger.setLevel('loud' as LadderLevel)).toThrow(/log level must be one of/);
  });

  it('children track a parent setLevel performed after their creation', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', destination: sink });
    const child = logger.child({ component: 'polling' });
    child.info('suppressed');
    logger.setLevel('info');
    child.info('emitted after the parent moved');
    expect(sink.records().map((record) => record.msg)).toEqual(['emitted after the parent moved']);
  });
});

describe('child loggers', () => {
  it('carries bindings on every record', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    const child = logger.child({ component: 'polling', accountId: 'acct-1' });
    child.info('poll started');
    child.warn('poll slow');
    for (const record of sink.records()) {
      expect(record.component).toBe('polling');
      expect(record.accountId).toBe('acct-1');
    }
    expect(sink.records().map((record) => record.msg)).toEqual(['poll started', 'poll slow']);
  });

  it('inherits the parent level', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    const child = logger.child({ component: 'c' });
    child.info('suppressed');
    child.error('emitted');
    expect(sink.records().map((record) => record.msg)).toEqual(['emitted']);
  });

  it('sanitizes sensitive binding keys and known-secret binding values', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink, secrets: ['sk-live-marker'] });
    logger
      .child({ component: 'x', apiKey: 'whatever', note: 'uses sk-live-marker here' })
      .error('boom');
    const record = sink.singleRecord();
    expect(record.apiKey).toBe(REDACTED);
    expect(record.note).toBe(`uses ${REDACTED} here`);
  });
});

describe('emission never throws (D-020 rule for diagnostics)', () => {
  it('swallows a throwing destination on every emitter', () => {
    const logger = createLogger({ destination: createThrowingLogSink() });
    for (const emitter of LOG_LEVEL_LADDER) {
      expect(() => logger[emitter]('message', { any: 'data' })).not.toThrow();
      expect(() => logger[emitter]('message')).not.toThrow();
    }
  });
});

describe('exposed pino instance (Layer A, task 146 base)', () => {
  it('redacts sensitive keys for direct raw-instance callers', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    logger.pino.error({
      apiKey: 'k1',
      wrap: { password: 'k2' },
      deeper: { wrap2: { secret: 'k3' } },
    });
    const record = sink.singleRecord();
    expect(record.apiKey).toBe(REDACTED);
    expect(record.wrap).toEqual({ password: REDACTED });
    expect(record.deeper).toEqual({ wrap2: { secret: REDACTED } });
  });

  it('sanitizes err payloads for direct raw-instance callers', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink, secrets: ['sk-live-marker'] });
    logger.pino.error({ err: new Error('failed with sk-live-marker') });
    const record = sink.singleRecord();
    const err = record.err as Record<string, unknown>;
    expect(err.message).toBe(`failed with ${REDACTED}`);
    expect(String(err.stack)).not.toContain('sk-live-marker');
  });
});

describe('createLifecycleSink', () => {
  it('logs lifecycle events at info with the event as data', () => {
    const sink = createMemoryLogSink();
    // Lifecycle events are the info-level content of spec §16, so a logger
    // that shows them is configured at 'info' (at the default 'warn' they
    // are filtered out, by design).
    const logger = createLogger({ level: 'info', destination: sink });
    const lifecycle = createLifecycleSink(logger);
    lifecycle({ type: 'state-change', state: 'running' });
    const record = sink.singleRecord();
    expect(record.level).toBe(LEVEL_VALUES.info);
    expect(record.msg).toBe('lifecycle: state-change');
    expect(record.event).toEqual({ type: 'state-change', state: 'running' });
  });

  it('is structurally assignable to both reserved server seams', () => {
    const logger = createLogger({ destination: createMemoryLogSink() });
    // Compile-time proof: the sink is a valid onLifecycle (app.ts) and
    // onEvent (shutdown.ts) subscriber without any adapter.
    const forApp: (event: LifecycleEvent) => void = createLifecycleSink(logger);
    const forShutdown: (event: ShutdownEvent) => void = createLifecycleSink(logger);
    expect(typeof forApp).toBe('function');
    expect(typeof forShutdown).toBe('function');
  });

  it('records shutdown drain events with their fields', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    createLifecycleSink(logger)({ type: 'drain-timeout', inFlight: 2, timeoutMs: 10_000 });
    const record = sink.singleRecord();
    expect(record.event).toEqual({ type: 'drain-timeout', inFlight: 2, timeoutMs: 10_000 });
  });

  it('never throws, even for a broken destination or a hostile event', () => {
    const logger = createLogger({ level: 'info', destination: createThrowingLogSink() });
    const lifecycle = createLifecycleSink(logger);
    expect(() => lifecycle({ type: 'state-change', state: 'running' })).not.toThrow();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'type', {
      enumerable: true,
      get(): string {
        throw new Error('boom');
      },
    });
    expect(() => lifecycle(hostile as { readonly type: string })).not.toThrow();
  });

  it('serves the real QuotameterApp onLifecycle seam end-to-end', async () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    const component: LifecycleComponent = {
      name: 'stub',
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    const app = new QuotameterApp({
      components: [component],
      onLifecycle: createLifecycleSink(logger),
    });
    await app.start();
    await app.stop();
    const messages = sink.records().map((record) => record.msg);
    expect(messages).toEqual([
      'lifecycle: state-change',
      'lifecycle: component-started',
      'lifecycle: state-change',
      'lifecycle: state-change',
      'lifecycle: component-stopped',
      'lifecycle: state-change',
    ]);
    const events = sink.records().map((record) => record.event);
    expect(events).toEqual([
      { type: 'state-change', state: 'starting' },
      { type: 'component-started', component: 'stub' },
      { type: 'state-change', state: 'running' },
      { type: 'state-change', state: 'stopping' },
      { type: 'component-stopped', component: 'stub' },
      { type: 'state-change', state: 'stopped' },
    ]);
  });
});
