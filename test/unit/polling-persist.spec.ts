import { describe, expect, it } from 'vitest';
import {
  createAccountContext,
  type AccountContext,
  type QuotaProvider,
} from '../../src/providers/registry';
import {
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import { SnapshotParseError } from '../../src/providers/zai-coding-plan/snapshot';
import type { NormalizedMetric, ProviderSnapshot } from '../../src/schemas/metrics';
import { createCycleRecorder, type CycleRecorder } from '../../src/services/polling-persist';
import type { CycleOutcome } from '../../src/services/polling-outcomes';
import { runCycleWithRetries } from '../../src/services/polling-retry';
import type {
  NewCollectionRun,
  NewMetricValue,
  NewQuotaEvent,
  NewRawResponse,
  NewSnapshot,
  QuotaRepository,
} from '../../src/storage/repository';
import { createFixedClock, type Clock } from '../../src/util/clock';

/**
 * Task 110's seam (spec §7.2, §11.1; decision D-069): every cycle the engine
 * runs settles through `createCycleRecorder`'s closure pair — one run row per
 * cycle, a snapshot only for a successful one, the classification returned to
 * the engine. The suite drives the production composition: the real
 * `runCycleWithRetries` around `attempt` (its backoff stubbed through the
 * wrapper's own test seams) and the real `persistCollectionCycle` over a
 * recording fake repository — so the recorded rows prove the write input
 * satisfies the real writer, while the SQL gate itself is pinned by the
 * integration spec. `createFixedClock` supplies every wall reading (D-021);
 * no real timers, no network.
 */

/** Deterministic wall readings: the attempt reads T0, the settle T0 + 2_500. */
const T0 = 1_761_000_000_000;
const CYCLE_MS = 2_500;

/* ── Fakes and factories ───────────────────────────────────────────────── */

interface RecordingRepository {
  readonly runs: NewCollectionRun[];
  readonly snapshots: NewSnapshot[];
  readonly metrics: NewMetricValue[];
  readonly events: NewQuotaEvent[];
  readonly raws: NewRawResponse[];
  readonly repository: QuotaRepository;
}

/**
 * A recording stand-in for the facade: the write methods
 * `persistCollectionCycle` calls (plus the two the §7.4 cap composes) record
 * their rows and return plausible identities; `withTransaction` runs the
 * callback immediately. The read surface the recorder never touches is
 * intentionally absent — the cast documents the partiality.
 */
function recordingRepository(): RecordingRepository {
  const runs: NewCollectionRun[] = [];
  const snapshots: NewSnapshot[] = [];
  const metrics: NewMetricValue[] = [];
  const events: NewQuotaEvent[] = [];
  const raws: NewRawResponse[] = [];
  const repository = {
    withTransaction: <T>(work: (repo: QuotaRepository) => T): T =>
      work(repository as QuotaRepository),
    insertCollectionRun: (run: NewCollectionRun): number => {
      runs.push(run);
      return runs.length;
    },
    insertSnapshot: (snapshot: NewSnapshot): void => {
      snapshots.push(snapshot);
    },
    insertMetricValues: (rows: ReadonlyArray<NewMetricValue>): void => {
      metrics.push(...rows);
    },
    insertQuotaEvent: (event: NewQuotaEvent): void => {
      events.push(event);
    },
    insertRawResponse: (response: NewRawResponse): void => {
      raws.push(response);
    },
    listRawResponses: (): NewRawResponse[] => [],
    deleteRawResponsesByRunIds: (): number => 0,
  } as unknown as QuotaRepository;
  return { runs, snapshots, metrics, events, raws, repository };
}

/** A §8.1 provider whose `fetchSnapshot` runs `collect`. */
function fakeProvider(id: string, collect: QuotaProvider['fetchSnapshot']): QuotaProvider {
  return {
    id,
    name: id,
    validateCredentials: async () => {},
    fetchSnapshot: collect,
  };
}

function metric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'five-hour-credits',
    // Dropped by the row mapping: §11.2's metric row omits the label (D-039).
    label: 'Five-hour credits',
    limitType: 'ROLLING_WINDOW',
    unit: 'CREDITS',
    windowSeconds: 18_000,
    used: 42,
    remaining: 58,
    limit: 100,
    percentUsed: 42,
    percentRemaining: 58,
    resetsAt: T0 + 3_600_000,
    isValid: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: 'zai-coding-plan',
    collectedAt: T0 + 1_200,
    planName: 'Pro',
    metrics: [metric()],
    ...overrides,
  };
}

/** The account context the recorder carries (D-013's branded factory). */
function accountContext(id = 'work'): AccountContext {
  return createAccountContext(id, 'Work plan', 'secret-value');
}

interface RecorderHarness {
  readonly recorder: CycleRecorder;
  readonly repo: RecordingRepository;
  /** Runs one full cycle (attempt → wrapper) and settles the result. */
  runCycle(): Promise<CycleOutcome>;
}

/**
 * One recorder wired for a provider whose collection behaves as `collect`
 * (resolving a snapshot or throwing), driven through the production wrapper
 * with the backoff stubbed — the delay bounds are task 106's own pin.
 */
function harness(
  collect: QuotaProvider['fetchSnapshot'],
  overrides: { intervalSeconds?: () => number } = {},
): RecorderHarness {
  const repo = recordingRepository();
  const clock = createFixedClock(T0);
  const recorder = createCycleRecorder({
    account: accountContext(),
    provider: fakeProvider('zai-coding-plan', collect),
    repository: repo.repository,
    clock,
    intervalSeconds: overrides.intervalSeconds ?? (() => 300),
  });
  return {
    recorder,
    repo,
    runCycle: async () => {
      const result = await runCycleWithRetries(
        () => recorder.attempt(new AbortController().signal),
        { random: () => 0, sleep: async () => {} },
      );
      clock.advance(CYCLE_MS);
      return recorder.settleCycle(result);
    },
  };
}

/** A clock whose reading the test can corrupt between attempt and settle. */
function mutableClock(): Clock & { corrupt(): void } {
  let epoch: number = T0;
  return {
    now: () => epoch,
    monotonicMs: () => 0,
    corrupt: () => {
      epoch = Number.NaN;
    },
  };
}

/* ── The success path ──────────────────────────────────────────────────── */

describe('a successful cycle', () => {
  it('writes one run row and the snapshot with its metric rows', async () => {
    const value = snapshot();
    const { repo, runCycle } = harness(async () => value);

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('success');
    expect(repo.runs).toHaveLength(1);
    expect(repo.runs[0]).toEqual({
      accountId: 'work',
      startedAt: T0,
      endedAt: T0 + CYCLE_MS,
      intervalSeconds: 300,
      outcome: 'success',
      httpStatus: null,
      errorMessage: null,
      attempts: 1,
      retryAfterSeconds: null,
    });
    expect(repo.snapshots).toEqual([
      { accountId: 'work', runId: 1, collectedAt: value.collectedAt, planName: 'Pro' },
    ]);
    expect(repo.metrics).toHaveLength(1);
    expect(repo.metrics[0]).toEqual({
      accountId: 'work',
      runId: 1,
      collectedAt: value.collectedAt,
      metricKey: 'five-hour-credits',
      limitType: 'ROLLING_WINDOW',
      unit: 'CREDITS',
      windowSeconds: 18_000,
      used: 42,
      remaining: 58,
      limit: 100,
      percentUsed: 42,
      percentRemaining: 58,
      resetsAt: T0 + 3_600_000,
      isValid: true,
      invalidReason: null,
      derivedFields: null,
    });
    expect(repo.events).toHaveLength(0);
    expect(repo.raws).toHaveLength(0);
  });

  it('drops the metric label and nulls absent optional fields (§11.2, D-039)', async () => {
    const sparse = snapshot({
      metrics: [
        metric({
          key: 'spare',
          derivedFields: undefined,
          windowSeconds: undefined,
          resetsAt: undefined,
        }),
      ],
    });
    const { repo, runCycle } = harness(async () => sparse);

    await runCycle();

    expect(repo.metrics[0]).not.toHaveProperty('label');
    expect(repo.metrics[0]).toMatchObject({
      metricKey: 'spare',
      windowSeconds: null,
      resetsAt: null,
      derivedFields: null,
    });
  });

  it('stores a zero-metric snapshot — every successful collection is a snapshot (§11.1)', async () => {
    const { repo, runCycle } = harness(async () => snapshot({ metrics: [] }));

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('success');
    expect(repo.snapshots).toHaveLength(1);
    expect(repo.metrics).toHaveLength(0);
  });

  it('reads the interval seam at settle time (§11.2 "in effect")', async () => {
    let interval = 300;
    const { recorder, repo } = harness(async () => snapshot(), {
      intervalSeconds: () => interval,
    });

    await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));
    interval = 3600; // a §6.4 runtime change lands before the cycle settles
    recorder.settleCycle({ ok: true, value: snapshot(), attempts: 1 });

    expect(repo.runs[0]?.intervalSeconds).toBe(3600);
  });
});

/* ── Provider-level successes that fail §8.4 (D-069) ───────────────────── */

describe('a settled value that is not a valid snapshot', () => {
  it.each([
    ['a non-object value', undefined],
    ['a snapshot with §8.4 problems', { providerId: 'zai-coding-plan', metrics: 'nope' }],
    ['a snapshot from another adapter', snapshot({ providerId: 'other-provider' })],
  ])('classifies %s as parse_error and writes no snapshot', async (_label, value) => {
    const { repo, runCycle } = harness(async () => value as ProviderSnapshot);

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('parse_error');
    expect(repo.runs).toHaveLength(1);
    expect(repo.runs[0]).toMatchObject({ outcome: 'parse_error', httpStatus: null });
    expect(repo.runs[0]?.errorMessage).toContain('adapter returned an invalid snapshot');
    expect(repo.snapshots).toHaveLength(0);
    expect(repo.metrics).toHaveLength(0);
    expect(repo.raws).toHaveLength(0);
  });
});

/* ── Transport failures (105's taxonomy through 106's wrapper) ─────────── */

describe('transport failures', () => {
  it.each([
    [
      'a network failure retried to the cap',
      new TransportConnectionError('ECONNREFUSED'),
      'network_error',
      4,
    ],
    ['a timeout retried to the cap', new TransportTimeoutError(15_000), 'timeout', 4],
    [
      'an HTTP 503 retried to the cap',
      new TransportStatusError(503, 'Service Unavailable', undefined),
      'server_error',
      4,
    ],
    [
      'an HTTP 401 reported immediately',
      new TransportStatusError(401, 'Unauthorized', undefined),
      'auth_error',
      1,
    ],
  ])(
    'persists %s as one run row with the attempt count',
    async (_label, error, expectedOutcome, attempts) => {
      const { repo, runCycle } = harness(async () => {
        throw error as Error;
      });

      const outcome = await runCycle();

      expect(outcome.outcome).toBe(expectedOutcome);
      expect(repo.runs).toHaveLength(1);
      expect(repo.runs[0]).toMatchObject({
        outcome: expectedOutcome,
        attempts,
        errorMessage: (error as Error).message,
      });
      expect(repo.snapshots).toHaveLength(0);
      expect(repo.metrics).toHaveLength(0);
      expect(repo.raws).toHaveLength(0);
    },
  );

  it('retains the HTTP status on status-class failures', async () => {
    const { repo, runCycle } = harness(async () => {
      throw new TransportStatusError(403, 'Forbidden', undefined);
    });

    await runCycle();

    expect(repo.runs[0]).toMatchObject({ outcome: 'auth_error', httpStatus: 403 });
  });
});

/* ── The §7.2 Retry-After evidence (D-062's wiring note) ───────────────── */

describe('retry_after_seconds', () => {
  it.each([
    ['a 429 with delay-seconds', '37', 37],
    ['a 429 with an excessive value capped at one hour', '9999', 3600],
    ['a 429 with an already-elapsed HTTP-date', 'Mon, 01 Jan 2001 00:00:00 GMT', 0],
    ['a 429 without a header', undefined, null],
    ['a 429 with a malformed value', 'soon', null],
  ])('persists %s', async (_label, header, expected) => {
    const { repo, runCycle } = harness(async () => {
      throw new TransportStatusError(429, 'Too Many Requests', header);
    });

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('rate_limited');
    expect(repo.runs[0]?.retryAfterSeconds).toBe(expected);
  });

  it('persists null for a retried 503 that carried a header — only a 429 defers', async () => {
    const { repo, runCycle } = harness(async () => {
      throw new TransportStatusError(503, 'Service Unavailable', '120');
    });

    await runCycle();

    expect(repo.runs[0]).toMatchObject({ outcome: 'server_error', retryAfterSeconds: null });
  });
});

/* ── The §7.4 payload (structural hand-off, D-069) ─────────────────────── */

describe('adapter parse failures', () => {
  it('stores the sanitized payload beside the parse_error run (§7.4)', async () => {
    const { repo, runCycle } = harness(async () => {
      throw new SnapshotParseError(
        'response envelope was not the expected object',
        200,
        '{"code":0}',
      );
    });

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('parse_error');
    expect(repo.runs).toHaveLength(1);
    expect(repo.runs[0]).toMatchObject({
      outcome: 'parse_error',
      httpStatus: 200,
      errorMessage: 'response envelope was not the expected object',
    });
    // capturedAt is the settle reading — a parse failure is un-retried, so it
    // is milliseconds from the response's arrival (D-069).
    expect(repo.raws).toEqual([
      {
        accountId: 'work',
        runId: 1,
        capturedAt: T0 + CYCLE_MS,
        httpStatus: 200,
        contentType: null,
        body: '{"code":0}',
      },
    ]);
    expect(repo.snapshots).toHaveLength(0);
  });

  it('writes no payload for transport-level parse failures (no body retained)', async () => {
    const { repo, runCycle } = harness(async () => {
      throw new TransportContentTypeError('text/html');
    });

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('parse_error');
    expect(repo.runs).toHaveLength(1);
    expect(repo.raws).toHaveLength(0);
  });

  it('falls through to fail-fast when the parse shape carries a bogus status', async () => {
    const bogus = Object.assign(new Error('not really a parse failure'), {
      reason: 'looks like one',
      sanitizedPayload: '{}',
      httpStatus: 42,
    });
    const { recorder, repo } = harness(async () => {
      throw bogus;
    });

    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));

    expect(() => recorder.settleCycle(result)).toThrow(TypeError);
    expect(repo.runs).toHaveLength(0);
  });
});

/* ── The unpersistable and the fail-fast (D-069) ───────────────────────── */

describe('cancellation and fail-fast branches', () => {
  it('persists nothing for a caller abort and returns the pseudo-outcome', async () => {
    const { repo, runCycle } = harness(async () => {
      throw new TransportAbortError();
    });

    const outcome = await runCycle();

    expect(outcome.outcome).toBe('cancelled');
    expect(repo.runs).toHaveLength(0);
    expect(repo.snapshots).toHaveLength(0);
    expect(repo.raws).toHaveLength(0);
  });

  it('throws for an error outside both taxonomies and persists nothing', async () => {
    const { recorder, repo } = harness(async () => {
      throw new Error('adapter wiring bug');
    });

    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));

    expect(() => recorder.settleCycle(result)).toThrow(TypeError);
    expect(repo.runs).toHaveLength(0);
  });

  it('throws for a non-Error rejection', async () => {
    const { recorder } = harness(() => Promise.reject('a bare string'));
    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));

    expect(() => recorder.settleCycle(result)).toThrow(TypeError);
  });

  it('records the cycle-start rule: the first attempt stamps a retried cycle (review P1)', async () => {
    const clock = createFixedClock(T0);
    const repo = recordingRepository();
    const recorder = createCycleRecorder({
      account: accountContext(),
      provider: fakeProvider('zai-coding-plan', async () => {
        clock.advance(60_000); // each attempt consumes a request-timeout span
        throw new TransportTimeoutError(60_000);
      }),
      repository: repo.repository,
      clock,
      intervalSeconds: () => 300,
    });

    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal), {
      random: () => 0,
      sleep: async () => {},
    });
    recorder.settleCycle(result);

    expect(repo.runs[0]).toMatchObject({
      attempts: 4,
      startedAt: T0, // the cycle's first attempt, not the fourth
      endedAt: T0 + 4 * 60_000,
    });
  });

  it('throws when settle runs without a recorded attempt', () => {
    const { recorder } = harness(async () => snapshot());

    expect(() => recorder.settleCycle({ ok: true, value: snapshot(), attempts: 1 })).toThrow(
      TypeError,
    );
  });

  it('throws on a second settle for one cycle', async () => {
    const { recorder } = harness(async () => snapshot());

    await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));
    recorder.settleCycle({ ok: true, value: snapshot(), attempts: 1 });
    expect(() => recorder.settleCycle({ ok: true, value: snapshot(), attempts: 1 })).toThrow(
      TypeError,
    );
  });

  it('throws when the attempt reading is non-finite', () => {
    const clock = mutableClock();
    const recorder = createCycleRecorder({
      account: accountContext(),
      provider: fakeProvider('zai-coding-plan', async () => snapshot()),
      repository: recordingRepository().repository,
      clock,
      intervalSeconds: () => 300,
    });
    clock.corrupt();

    expect(() => recorder.attempt(new AbortController().signal)).toThrow(TypeError);
  });

  it('throws when the settle reading is non-finite and persists nothing', async () => {
    const clock = mutableClock();
    const repo = recordingRepository();
    const recorder = createCycleRecorder({
      account: accountContext(),
      provider: fakeProvider('zai-coding-plan', async () => snapshot()),
      repository: repo.repository,
      clock,
      intervalSeconds: () => 300,
    });

    const result = await runCycleWithRetries(() => recorder.attempt(new AbortController().signal));
    clock.corrupt();

    expect(() => recorder.settleCycle(result)).toThrow(TypeError);
    expect(repo.runs).toHaveLength(0);
  });
});

/* ── Factory fail-fast (the D-059/D-066 convention) ────────────────────── */

describe('createCycleRecorder validation', () => {
  const clock = createFixedClock(T0);
  const provider = fakeProvider('zai-coding-plan', async () => snapshot());
  const repository = recordingRepository().repository;
  const base = {
    account: accountContext(),
    provider,
    repository,
    clock,
    intervalSeconds: () => 300,
  } as const;

  it.each([
    ['no options', undefined],
    ['a null account', { ...base, account: null }],
    ['a provider without fetchSnapshot', { ...base, provider: { id: 'x', name: 'x' } }],
    ['a repository without withTransaction', { ...base, repository: {} }],
    ['a clock without now', { ...base, clock: {} }],
    ['a non-function intervalSeconds', { ...base, intervalSeconds: 300 }],
  ])('rejects %s', (_label, options) => {
    expect(() => createCycleRecorder(options as Parameters<typeof createCycleRecorder>[0])).toThrow(
      TypeError,
    );
  });
});
