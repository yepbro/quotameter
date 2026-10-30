import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { TransportAbortError, TransportStatusError } from '../../src/providers/transport';
import { runCycleWithRetries } from '../../src/services/polling-retry';
import {
  classifyParseFailure,
  classifySuccess,
  classifyTransportError,
  type CycleOutcome,
} from '../../src/services/polling-outcomes';
import {
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MAX_SECONDS,
  deferNextPoll,
  parseRetryAfter,
} from '../../src/services/polling-retry-after';

/**
 * Table-driven coverage of the §7.2 `Retry-After` rules (task 107, decision
 * D-062): the two RFC 9110 forms (delta-seconds and HTTP-date, the latter in
 * all three accepted formats), the one-hour cap with its exact boundary, the
 * three done-condition failure modes (malformed, past, excessive), the OWS
 * trimming of header values, the 429-only eligibility gate over task 105's
 * classification, and the interplay with task 106's result object — a 429
 * that escapes the cycle un-retried carries its header into the parser and
 * defers the account's next poll. The module takes time as data (D-021), so
 * every case is a pure call against one fixed clock reading; no timers, no
 * network.
 */

/**
 * The fixed clock reading every case runs against: 2026-10-31T12:00:00.600Z
 * (a Saturday). The 600 ms fraction is deliberate — whole-second HTTP-dates
 * around it exercise the ceil quantization and the past-date clamp.
 */
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0) + 600;

/** Canonical IMF-fixdate for an instant offset from {@link NOW}. */
function httpDateAt(offsetMs: number): string {
  const formatted = DateTime.fromMillis(NOW + offsetMs, { zone: 'utc' }).toHTTP();
  if (formatted === null) throw new Error(`httpDateAt: could not format offset ${offsetMs}`);
  return formatted;
}

/** The expected deferred decision for whole seconds against {@link NOW}. */
function deferred(seconds: number, capped: boolean) {
  return { deferred: true, seconds, capped, notBeforeEpochMs: NOW + seconds * 1000 };
}

describe('the §7.2 one-hour cap constants', () => {
  it('pins the cap in seconds and milliseconds', () => {
    expect(RETRY_AFTER_MAX_SECONDS).toBe(3600);
    expect(RETRY_AFTER_MAX_MS).toBe(3_600_000);
  });
});

describe('parseRetryAfter: delay-seconds form (RFC 9110 §10.1.3)', () => {
  it.each([
    ['0', '0', 0, false],
    ['a one-second wait', '1', 1, false],
    ['a plain wait', '37', 37, false],
    ['leading zeros', '037', 37, false],
    ['surrounding spaces', ' 42 ', 42, false],
    ['surrounding tabs and newline', '\t42\n', 42, false],
    ['exactly one hour — the boundary is honored, not capped', '3600', 3600, false],
    ['one second over the cap', '3601', 3600, true],
    ['two hours', '7200', 3600, true],
    ['one day', '86400', 3600, true],
    ['a magnitude no double can represent (still valid 1*DIGIT)', '9'.repeat(400), 3600, true],
  ])('defers %s', (_label, raw, seconds, capped) => {
    expect(parseRetryAfter(raw as string, NOW)).toEqual(
      deferred(seconds as number, capped as boolean),
    );
  });

  it.each([
    ['an empty value', ''],
    ['only whitespace', '   '],
    ['a negative number', '-1'],
    ['an explicit sign', '+37'],
    ['a decimal', '2.5'],
    ['an exponent form', '1e3'],
    ['trailing garbage', '12ab'],
    ['leading garbage', 'ab12'],
    ['a hexadecimal literal', '0x1F'],
    ['the literal NaN', 'NaN'],
    ['the literal Infinity', 'Infinity'],
    ['non-ASCII digits', '٤٢'],
    ['non-OWS whitespace padding (NBSP)', '\u00A042\u00A0'],
    ['an embedded space', '4 2'],
    ['a clock time', '14:30'],
    ['an ISO timestamp (not an HTTP-date)', '1994-11-06T08:49:37Z'],
  ])('ignores %s: %j', (_label, raw: string) => {
    expect(parseRetryAfter(raw, NOW)).toEqual({ deferred: false, reason: 'malformed' });
  });
});

describe('parseRetryAfter: HTTP-date form (RFC 9110 §5.6.7)', () => {
  it.each([
    ['IMF-fixdate 29.4 s away, ceil → 30', 'Sat, 31 Oct 2026 12:00:30 GMT', 30, false],
    ['RFC 850 obs-date (SHOULD-accepted)', 'Saturday, 31-Oct-26 12:00:30 GMT', 30, false],
    ['asctime obs-date (SHOULD-accepted)', 'Sat Oct 31 12:00:30 2026', 30, false],
    ['surrounding OWS is trimmed before parsing', '  Sat, 31 Oct 2026 12:00:30 GMT\t', 30, false],
    ['400 ms away, ceil → a full second', 'Sat, 31 Oct 2026 12:00:01 GMT', 1, false],
    [
      '30.6 s in the past clamps to zero, still a valid parse',
      'Sat, 31 Oct 2026 11:59:30 GMT',
      0,
      false,
    ],
    ['600 ms in the past clamps to zero', 'Sat, 31 Oct 2026 12:00:00 GMT', 0, false],
    [
      '3 599.4 s away, ceil → exactly the cap, uncapped',
      'Sat, 31 Oct 2026 13:00:00 GMT',
      3600,
      false,
    ],
    ['3 600.4 s away, ceil → 3601 → capped', 'Sat, 31 Oct 2026 13:00:01 GMT', 3600, true],
  ])('defers %s', (_label, raw, seconds, capped) => {
    expect(parseRetryAfter(raw as string, NOW)).toEqual(
      deferred(seconds as number, capped as boolean),
    );
  });

  it('caps a far-future HTTP-date at one hour', () => {
    expect(parseRetryAfter(httpDateAt(30 * 86_400_000), NOW)).toEqual(
      deferred(RETRY_AFTER_MAX_SECONDS, true),
    );
  });

  it("applies RFC 9110 §5.6.7's sliding 50-year rule to RFC 850 two-digit years", () => {
    // Luxon's fixed pivot reads '31-Oct-68' as 1968 — 58 years in the past —
    // but 2068 is within 50 years of NOW, so the RFC reading is 2068: an
    // excessive defer that caps at one hour instead of clamping to zero.
    expect(parseRetryAfter('Thursday, 31-Oct-68 12:00:30 GMT', NOW)).toEqual(
      deferred(RETRY_AFTER_MAX_SECONDS, true),
    );
    // '31-Dec-99' keeps 1999: its 2099 reading would be 73 years ahead —
    // more than 50 — so the past-century reading is the RFC's, and the
    // elapsed date clamps to zero rather than borrowing a century.
    expect(parseRetryAfter('Friday, 31-Dec-99 12:00:30 GMT', NOW)).toEqual(deferred(0, false));
  });

  it('reads a two-digit year more than 50 years ahead as the past century', () => {
    // Against a 1990 clock, '01-Jan-50' parses (as 2050 — the weekday name
    // matches that reading) as more than 50 years ahead: the most recent
    // same-digits year is 1950, 40 years in the past, clamped to zero.
    const NOW_1990 = Date.UTC(1990, 0, 1, 0, 0, 0);
    expect(parseRetryAfter('Saturday, 01-Jan-50 12:00:30 GMT', NOW_1990)).toEqual({
      deferred: true,
      seconds: 0,
      capped: false,
      notBeforeEpochMs: NOW_1990,
    });
  });

  it.each([
    ['an impossible day of month', 'Sun, 99 Nov 1994 08:49:37 GMT'],
    ['a lowercase zone token', 'Sun, 06 Nov 1994 08:49:37 gmt'],
    ['a weekday contradicting the date', 'Tue, 31 Oct 2026 12:00:30 GMT'],
    ['a non-GMT zone', 'Sat, 31 Oct 2026 12:00:30 EST'],
    ['a missing day-name', '31 Oct 2026 12:00:30 GMT'],
    ['a five-digit year (outside the grammar)', 'Sat, 31 Oct 10000 12:00:30 GMT'],
    ['plain garbage', 'not a date'],
  ] as const)('ignores %s: %j', (_label, raw: string) => {
    expect(parseRetryAfter(raw, NOW)).toEqual({ deferred: false, reason: 'malformed' });
  });

  it('reports an absent header without deferring', () => {
    expect(parseRetryAfter(undefined, NOW)).toEqual({ deferred: false, reason: 'absent' });
  });
});

describe('parseRetryAfter decision invariants', () => {
  it('never defers below zero or past one hour; notBefore always matches the seconds', () => {
    const samples: readonly string[] = [
      '0',
      '37',
      '3600',
      '999999999',
      httpDateAt(-86_400_000),
      httpDateAt(86_400_000),
    ];
    for (const raw of samples) {
      const decision = parseRetryAfter(raw, NOW);
      expect(decision.deferred, raw).toBe(true);
      if (decision.deferred) {
        expect(decision.seconds, raw).toBeGreaterThanOrEqual(0);
        expect(decision.seconds, raw).toBeLessThanOrEqual(RETRY_AFTER_MAX_SECONDS);
        if (decision.capped) expect(decision.seconds, raw).toBe(RETRY_AFTER_MAX_SECONDS);
        expect(decision.notBeforeEpochMs, raw).toBe(NOW + decision.seconds * 1000);
      }
    }
  });

  it('rejects a non-string header value and a non-finite clock reading', () => {
    expect(() => parseRetryAfter(42 as unknown as string, NOW)).toThrow(TypeError);
    expect(() => parseRetryAfter('37', Number.NaN)).toThrow(/nowEpochMs must be a finite number/u);
    expect(() => parseRetryAfter('37', Number.POSITIVE_INFINITY)).toThrow(
      /nowEpochMs must be a finite number/u,
    );
  });
});

describe('deferNextPoll: the 429-only eligibility gate (spec §7.2, D-048)', () => {
  it.each([
    [
      'a 429 with a delta-seconds header defers the next poll',
      classifyTransportError(new TransportStatusError(429, 'Too Many Requests', '37')),
      deferred(37, false),
    ],
    [
      'a 429 with an HTTP-date header defers the next poll',
      classifyTransportError(new TransportStatusError(429, '', httpDateAt(30_000))),
      deferred(30, false),
    ],
    [
      'a 429 without the header (legal, D-034) keeps the normal interval',
      classifyTransportError(new TransportStatusError(429, '', undefined)),
      { deferred: false, reason: 'absent' },
    ],
    [
      'a 429 with a malformed header ignores it safely',
      classifyTransportError(new TransportStatusError(429, '', 'soon')),
      { deferred: false, reason: 'malformed' },
    ],
    [
      'a 503 carrying the header is ineligible — it was retried in-cycle by 106',
      classifyTransportError(new TransportStatusError(503, 'Service Unavailable', '120')),
      { deferred: false, reason: 'ineligible' },
    ],
    [
      'a 401 carrying the header is ineligible — suspension is task 108',
      classifyTransportError(new TransportStatusError(401, 'Unauthorized', '5')),
      { deferred: false, reason: 'ineligible' },
    ],
    [
      'a parse failure is ineligible',
      classifyParseFailure({ reason: 'envelope was not the expected object' }),
      { deferred: false, reason: 'ineligible' },
    ],
    ['a success is ineligible', classifySuccess(200), { deferred: false, reason: 'ineligible' }],
    [
      'a caller abort is ineligible',
      classifyTransportError(new TransportAbortError()),
      { deferred: false, reason: 'ineligible' },
    ],
  ])('%s', (_label, outcome: CycleOutcome, expected) => {
    expect(deferNextPoll(outcome, NOW)).toEqual(expected);
  });

  it('validates its inputs fail-fast', () => {
    expect(() => deferNextPoll({} as CycleOutcome, NOW)).toThrow(
      /deferNextPoll: classified must be a CycleOutcome/u,
    );
    expect(() => deferNextPoll(null as unknown as CycleOutcome, NOW)).toThrow(
      /deferNextPoll: classified must be a CycleOutcome/u,
    );
    expect(() =>
      deferNextPoll({ ...classifySuccess(), retryAfterRaw: 5 } as unknown as CycleOutcome, NOW),
    ).toThrow(/deferNextPoll: classified must be a CycleOutcome/u);
    // The clock reading is validated on every path, even a non-deferring one.
    expect(() => deferNextPoll(classifySuccess(), Number.NaN)).toThrow(
      /nowEpochMs must be a finite number/u,
    );
  });
});

describe('task 106 interplay: the 429 outcome carries the header into the parser', () => {
  it('a 429 escaping the cycle un-retried defers the next poll by the capped header', async () => {
    const result = await runCycleWithRetries(async () => {
      throw new TransportStatusError(429, 'Too Many Requests', '7200');
    });
    // §7.2: no retry within the current cycle — one attempt, no backoff.
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(TransportStatusError);
    const decision = deferNextPoll(
      classifyTransportError(result.error as TransportStatusError),
      NOW,
    );
    expect(decision).toEqual(deferred(RETRY_AFTER_MAX_SECONDS, true));
    expect(decision.deferred && decision.notBeforeEpochMs).toBe(NOW + RETRY_AFTER_MAX_MS);
  });

  it('a retried-then-exhausted 5xx with the header stays ineligible for a deferral', async () => {
    const result = await runCycleWithRetries(
      async () => {
        throw new TransportStatusError(503, 'Service Unavailable', '120');
      },
      { random: () => 0, sleep: async () => {} },
    );
    expect(result.attempts).toBe(4);
    if (result.ok) return;
    expect(
      deferNextPoll(classifyTransportError(result.error as TransportStatusError), NOW),
    ).toEqual({ deferred: false, reason: 'ineligible' });
  });
});
