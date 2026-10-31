import { describe, expect, it } from 'vitest';
import { createAccountContext } from '../../src/providers/registry';
import {
  LOG_LEVEL_LADDER,
  REDACTED,
  SENSITIVE_KEY_NAMES,
  createLogger,
  type LadderLevel,
  type LogData,
} from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * Marker-secret coverage for src/util/logger.ts (spec §15.4, §16; task 072
 * done-condition: "a marker-secret test proves secrets do not appear at any
 * log level"). The marker is a synthetic fixture value (never a real
 * secret); every assertion checks the RAW serialized JSON line, not the
 * parsed view, so a marker split across JSON escapes or nested values
 * cannot slip through.
 */

/** Synthetic marker secret — no real credential (test fixture rule). */
const MARKER = 'sk-live-quotameter-marker-9f1c2d';
const SECOND_MARKER = 'qq-marker-7d5e';

/** A payload exercising every leak vector at once. */
function leakyPayload(): LogData {
  const errorWithProps = Object.assign(new Error(`request rejected for ${MARKER}`), {
    apiKey: MARKER,
    note: `see ${MARKER}`,
  });
  return {
    exact: MARKER,
    interpolated: `token was ${MARKER} at the time`,
    password: MARKER,
    authorization: `Bearer ${MARKER}`,
    nested: {
      deep: {
        apiKey: MARKER,
        list: [MARKER, `mixed ${MARKER}`, { secret: MARKER }],
      },
    },
    err: errorWithProps,
    caused: new Error('outer failed', { cause: new Error(`caused by ${MARKER}`) }),
    nestedError: { inner: new Error(`inner boom after ${MARKER}`) },
  };
}

/** Fires every emitter with marker-laden message and data on a fresh logger. */
function emitAllLeakyVectors(
  level: LadderLevel,
  secrets: readonly string[],
  sink: MemoryLogSink,
): void {
  const logger = createLogger({ level, secrets, destination: sink });
  for (const emitter of LOG_LEVEL_LADDER) {
    logger[emitter](`operation failed with ${MARKER} and ${SECOND_MARKER}`, leakyPayload());
  }
}

/** Levels at or above `level` — the records that must have been emitted. */
function levelsFrom(level: LadderLevel): LadderLevel[] {
  const start = LOG_LEVEL_LADDER.indexOf(level);
  return LOG_LEVEL_LADDER.filter((_, index) => index >= start);
}

describe('marker matrix: no secret at any log level', () => {
  // The done-condition of task 072: for EVERY level on the Pino ladder, the
  // records that pass the level filter contain no marker occurrence — in
  // the message, in any field at any depth, in error payloads, anywhere in
  // the raw line.
  for (const level of LOG_LEVEL_LADDER) {
    it(`emits marker-free records at level '${level}'`, () => {
      const sink = createMemoryLogSink();
      emitAllLeakyVectors(level, [MARKER, SECOND_MARKER], sink);
      const lines = sink.lines();
      const expected = levelsFrom(level);
      expect(lines).toHaveLength(expected.length);
      for (const line of lines) {
        expect(line.includes(MARKER)).toBe(false);
        expect(line.includes(SECOND_MARKER)).toBe(false);
      }
    });
  }

  it('redacts with the same rigor when only one secret is registered', () => {
    const sink = createMemoryLogSink();
    emitAllLeakyVectors('trace', [MARKER], sink);
    for (const line of sink.lines()) {
      expect(line.includes(MARKER)).toBe(false);
    }
  });

  it('keeps redaction structural without any registered secrets (keys still redacted)', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'trace', destination: sink });
    logger.warn('plain message', { apiKey: MARKER, note: `value ${MARKER}` });
    const record = sink.singleRecord();
    // Key-name redaction is independent of the known-secret list...
    expect(record.apiKey).toBe(REDACTED);
    // ...while value scrubbing without a registered marker cannot guess.
    expect(record.note).toBe(`value ${MARKER}`);
  });

  it('ignores blank entries in the secrets list', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', secrets: ['', '   ', MARKER], destination: sink });
    logger.warn(`using ${MARKER}`);
    expect(sink.lines()[0]?.includes(MARKER)).toBe(false);
  });

  it('keeps whitespace runs verbatim when only blank markers are registered', () => {
    // The blank filter must drop blanks before the scrubber sees them: a
    // kept '' would interleave the placeholder between every character,
    // and a kept '   ' would redact ordinary runs of spaces (U-008).
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', secrets: ['', '   '], destination: sink });
    logger.warn('a  b   c');
    expect(sink.singleRecord().msg).toBe('a  b   c');
    expect(sink.singleLine().includes(REDACTED)).toBe(false);
  });

  it('scrubs nothing at all when no secrets are registered', () => {
    // The absent-list default must be empty: any seeded placeholder would
    // redact matching message text out of unconfigured loggers (U-008).
    const sink = createMemoryLogSink();
    createLogger({ level: 'warn', destination: sink }).warn('Stryker was here');
    expect(sink.singleRecord().msg).toBe('Stryker was here');
  });
});

describe('sensitive key names', () => {
  const sensitiveVariants = [
    'apiKey',
    'API_KEY',
    'api-key',
    'api_key',
    'apiKeyEnv',
    'apiSecret',
    'clientSecret',
    'secret',
    'password',
    'PasswordHash',
    'newPassword',
    'authorization',
    'accessToken',
    'access_token',
    'refreshToken',
    'idToken',
    'token',
    'bearerToken',
    'cookie',
    'set-cookie',
    'sessionId',
    'session_id',
    'sessionKey',
    'credentials',
    'proxyAuthorization',
  ];

  it('redacts values under every spelling variant at any depth', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const data: Record<string, unknown> = {};
    for (const key of sensitiveVariants) {
      data[key] = `value-of-${key}`;
    }
    logger.warn('keys by name', {
      ...data,
      deeper: { nested: { list: [{ password: 'deep-value' }] } },
    });
    const record = sink.singleRecord();
    for (const key of sensitiveVariants) {
      expect(record[key]).toBe(REDACTED);
    }
    expect(record.deeper).toEqual({ nested: { list: [{ password: REDACTED }] } });
  });

  it('keeps non-sensitive fields readable', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    logger.warn('normal fields', {
      accountId: 'acct-1',
      label: 'Personal',
      mode: 'auto',
      attempt: 3,
      ok: true,
      missing: null,
    });
    expect(sink.records()[0]).toMatchObject({
      accountId: 'acct-1',
      label: 'Personal',
      mode: 'auto',
      attempt: 3,
      ok: true,
      missing: null,
    });
  });

  it('redacts every exported vocabulary name through a spelling only the deep walk matches', () => {
    // The expected vocabulary is pinned HERE as literals, not read back
    // from the export: a mutant that blanks an entry would otherwise
    // vanish from the test's own iteration. Hyphen-joined spellings
    // ('a-p-i-…') normalize onto the vocabulary but never equal Layer A's
    // exact-spelling redact paths, so only Layer B's deep sanitizer can
    // redact them (U-008 triage of the literal survivors).
    const expected = [
      'apikey',
      'apikeyenv',
      'apisecret',
      'clientsecret',
      'secret',
      'password',
      'passwordhash',
      'newpassword',
      'oldpassword',
      'currentpassword',
      'authorization',
      'proxyauthorization',
      'authheader',
      'accesstoken',
      'refreshtoken',
      'idtoken',
      'token',
      'bearertoken',
      'bearer',
      'cookie',
      'setcookie',
      'sessionid',
      'sessionkey',
      'credentials',
    ];
    expect([...SENSITIVE_KEY_NAMES]).toEqual(expected);
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const data: Record<string, unknown> = {};
    for (const name of expected) {
      data[name.split('').join('-')] = `sentinel-for-${name}`;
    }
    logger.warn('vocabulary sweep', data);
    const record = sink.singleRecord();
    for (const name of expected) {
      expect(record[name.split('').join('-')], `key derived from '${name}'`).toBe(REDACTED);
    }
  });
});

describe('error payloads', () => {
  it('scrubs the marker from message, stack, and custom properties', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', secrets: [MARKER], destination: sink });
    const error = Object.assign(new Error(`poll failed with ${MARKER}`), {
      provider: 'zai-coding-plan',
      apiKey: MARKER,
      note: `echoes ${MARKER}`,
    });
    logger.error('collection failed', { err: error });
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as { err: Record<string, unknown> };
    expect(record.err.message).toBe(`poll failed with ${REDACTED}`);
    expect(record.err.stack).toContain(`poll failed with ${REDACTED}`);
    expect(record.err.apiKey).toBe(REDACTED);
    expect(record.err.note).toBe(`echoes ${REDACTED}`);
    expect(record.err.provider).toBe('zai-coding-plan');
  });

  it('scrubs the cause chain', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', secrets: [MARKER], destination: sink });
    logger.error('wrapped', {
      err: new Error('outer', { cause: new Error(`root cause ${MARKER}`) }),
    });
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as { err: { cause: { message: string } } };
    expect(record.err.cause.message).toBe(`root cause ${REDACTED}`);
  });

  it('scrubs aggregated error members', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', secrets: [MARKER], destination: sink });
    logger.error('aggregated', {
      err: new AggregateError([new Error(`member failed with ${MARKER}`)], 'all polls failed'),
    });
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as { err: Record<string, unknown> };
    expect(record.err.message).toBe('all polls failed');
    expect(JSON.stringify(record.err)).toContain(`member failed with ${REDACTED}`);
  });

  it('normalizes nested error values inside plain data', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', secrets: [MARKER], destination: sink });
    logger.error('nested', { details: { inner: new Error(`inner says ${MARKER}`) } });
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as { details: { inner: { message: string } } };
    expect(record.details.inner.message).toBe(`inner says ${REDACTED}`);
  });
});

describe('D-013 AccountContext stays secret-free', () => {
  it('logs the context without the non-enumerable secret', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', destination: sink });
    const account = createAccountContext('acct-1', 'Personal', MARKER);
    logger.error('account failed', { account, context: account });
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as { account: Record<string, unknown> };
    expect(record.account).toEqual({ accountId: 'acct-1', label: 'Personal' });
    expect('secret' in record.account).toBe(false);
  });
});

describe('payload structure survival', () => {
  it('preserves arrays, nesting, and primitives', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    logger.info('structured', {
      list: [1, 'two', false, null],
      nested: { a: { b: { c: 'deep' } } },
    });
    expect(sink.records()[0]?.list).toEqual([1, 'two', false, null]);
    expect(sink.records()[0]?.nested).toEqual({ a: { b: { c: 'deep' } } });
  });

  it('serializes dates as ISO strings and invalid dates as null', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', destination: sink });
    logger.info('at', { at: new Date(Date.UTC(2026, 9, 30, 12, 0, 0)), bad: new Date(Number.NaN) });
    expect(sink.records()[0]?.at).toBe('2026-10-30T12:00:00.000Z');
    // JSON's own rendering of an invalid Date is null; throwing would cost
    // the whole record (review finding, task 072).
    expect(sink.records()[0]?.bad).toBeNull();
  });

  it('keeps an invalid Date inside an error payload from dropping the record', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', destination: sink });
    const err = Object.assign(new Error('boom'), { at: new Date(Number.NaN) });
    logger.error('failed', { err });
    const record = sink.singleRecord() as { err: { message: string; at: null } };
    expect(record.err.message).toBe('boom');
    expect(record.err.at).toBeNull();
  });

  it('does not throw for an invalid Date through the raw instance err serializer', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ destination: sink });
    const err = Object.assign(new Error('boom'), { at: new Date(Number.NaN) });
    expect(() => logger.pino.error({ err })).not.toThrow();
    expect((sink.singleRecord().err as Record<string, unknown>).message).toBe('boom');
  });

  it('collapses cycles without losing the record or leaking', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', secrets: [MARKER], destination: sink });
    const payload: Record<string, unknown> = { name: 'cycle', note: `holds ${MARKER}` };
    payload.self = payload;
    logger.warn('cyclic payload', payload);
    const line = sink.lines()[0]!;
    expect(line.includes(MARKER)).toBe(false);
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.name).toBe('cycle');
    expect(record.self).toBe('[Circular]');
  });

  it('serializes a reference repeated across sibling branches in both', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const shared = { tag: 'shared' };
    logger.warn('siblings', { first: shared, second: shared });
    const record = sink.records()[0] as Record<string, unknown>;
    expect(record.first).toEqual({ tag: 'shared' });
    expect(record.second).toEqual({ tag: 'shared' });
  });

  it('collapses a throwing property getter to a placeholder without losing the record', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const payload: Record<string, unknown> = { healthy: 'value' };
    Object.defineProperty(payload, 'hostile', {
      enumerable: true,
      get(): string {
        throw new Error('boom');
      },
    });
    logger.warn('hostile payload', payload);
    const record = sink.singleRecord();
    expect(record.healthy).toBe('value');
    expect(record.hostile).toBe('[Unreadable]');
  });

  it('collapses a throwing array element getter to a placeholder', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const list = ['safe'];
    Object.defineProperty(list, '1', {
      enumerable: true,
      get(): string {
        throw new Error('boom');
      },
    });
    logger.warn('hostile array', { list });
    expect(sink.singleRecord().list).toEqual(['safe', '[Unreadable]']);
  });

  it('collapses an error whose property getter throws instead of dropping the record', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'error', destination: sink });
    const err = new Error('outer');
    Object.defineProperty(err, 'hostile', {
      enumerable: true,
      get(): string {
        throw new Error('boom');
      },
    });
    logger.error('failed', { err, healthy: 'value' });
    const record = sink.singleRecord();
    expect(record.err).toBe('[Unreadable]');
    expect(record.healthy).toBe('value');
  });

  it('does not mutate the caller payload (sanitization clones)', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', secrets: [MARKER], destination: sink });
    const payload = { apiKey: MARKER, note: `value ${MARKER}` };
    logger.warn('immutability', payload);
    expect(payload).toEqual({ apiKey: MARKER, note: `value ${MARKER}` });
  });
});

describe('redaction placeholder', () => {
  it('keeps surrounding text around the placeholder', () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'info', secrets: [MARKER], destination: sink });
    logger.info(`connecting with ${MARKER} over https`);
    expect(sink.records()[0]?.msg).toBe(`connecting with ${REDACTED} over https`);
  });

  it('uses the exported REDACTED constant consistently', () => {
    expect(REDACTED).toBe('[REDACTED]');
  });
});
