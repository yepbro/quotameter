import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import type { AccountConfigStore, ManagedAccountConfig } from '../../src/server/api/accounts';
import { apiErrorHandler } from '../../src/server/api/error';
import { detectCycleResetEvents } from '../../src/services/events-cycle';
import type { NormalizedMetric, ProviderSnapshot } from '../../src/schemas/metrics';
import {
  persistCollectionCycle,
  type CollectionCycleWrite,
  type CycleMetricInput,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type QuotaRepository,
  type RunOutcome,
} from '../../src/storage/repository';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 events endpoint on the wire (task 161, spec §12, §13, §11.3;
 * decision D-139): `GET /api/events` — the unified §12.2 timeline — through
 * the real `/api` scope over a real migrated disposable `node:sqlite`
 * database. The §11.2 history is seeded through the real write path
 * (`persistCollectionCycle` with task 118's live reset detection), so the
 * reset items on the wire are the events the polling pipeline would have
 * persisted; gaps, failed cycles, and stopped-service regions come from the
 * landed task-119/120 services composed by the route. The done-condition's
 * classes: resets (both §12.1 conditions, the false-positive avoidance),
 * gaps (threshold, cadence, invalid-point exclusion), collection failures
 * (evidence, §7.4 redaction, range filtering), stopped regions (clamped
 * edges, the pre-range anchor), retention reporting, errors, the §15.1
 * seam, and the no-half-wired 404.
 */

/** Deterministic §11.1 epoch-millisecond base. */
const NOW = 1_761_000_000_000;

/** One day of absolute time. */
const DAY_MS = 86_400_000;

/** The §15.4 marker secret — nothing it touches may reach a response body. */
const MARKER_KEY = 'sk-marker-secret-4f7a1c9e2b';

/** `t` as the §13 ISO request parameter. */
function iso(t: number): string {
  return new Date(t).toISOString();
}

/** The shared events query URL (defaults: the last 7 days of `work`). */
function eventsUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    accountId: 'work',
    from: iso(NOW - 7 * DAY_MS),
    to: iso(NOW),
    ...overrides,
  });
  return `/api/events?${params.toString()}`;
}

/* ── The configuration-store double (159's seam, read-only half) ─────────── */

interface StoredEntry {
  readonly id: string;
  readonly apiKey?: string;
}

class ReadOnlyAccountStore implements AccountConfigStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(seed: ReadonlyArray<StoredEntry>) {
    for (const entry of seed) this.entries.set(entry.id, entry);
  }

  private view(entry: StoredEntry): ManagedAccountConfig {
    return {
      id: entry.id,
      providerId: 'zai-coding-plan',
      label: `${entry.id} account`,
      enabled: true,
      keyConfigured: entry.apiKey !== undefined,
      keySource: 'file',
    };
  }

  async list(): Promise<ReadonlyArray<ManagedAccountConfig>> {
    return [...this.entries.values()].map((entry) => this.view(entry));
  }

  async find(id: string): Promise<ManagedAccountConfig | null> {
    const entry = this.entries.get(id);
    return entry === undefined ? null : this.view(entry);
  }

  async add(): Promise<void> {
    throw new Error('the events view never mutates the store');
  }

  async update(): Promise<ManagedAccountConfig | null> {
    throw new Error('the events view never mutates the store');
  }

  async remove(): Promise<boolean> {
    throw new Error('the events view never mutates the store');
  }

  async secretOf(id: string): Promise<string | null> {
    return this.entries.get(id)?.apiKey ?? null;
  }
}

/* ── The harness ────────────────────────────────────────────────────────── */

interface Harness {
  app: FastifyInstance;
  readonly repository: QuotaRepository;
  /** The §11.3 retention window in days — §6.4-live, read per request. */
  retentionDays: number;
  /** The app's log sink — the §16 diagnostics of the D-185 gate land here. */
  readonly sink: MemoryLogSink;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  readonly wired?: boolean;
}

async function withEventsApi(
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    repository.insertAccount({
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'work account',
      createdAt: NOW,
    });
    const sink = createMemoryLogSink();
    const harness: Harness = {
      app: undefined as unknown as Harness['app'],
      repository,
      retentionDays: 3650,
      sink,
    };
    const app = Fastify({
      loggerInstance: createLogger({ level: 'warn', destination: sink }).pino as FastifyBaseLogger,
    });
    harness.app = app;
    app.setErrorHandler(apiErrorHandler);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: options.auth ?? { mode: 'auto', bindHost: '127.0.0.1' },
      ...(options.wired === false
        ? {}
        : {
            history: {
              store: new ReadOnlyAccountStore([{ id: 'work', apiKey: MARKER_KEY }]),
              repository,
              historyRetentionDays: () => harness.retentionDays,
              now: () => NOW,
            },
          }),
    });
    try {
      await body(harness);
    } finally {
      await app.close();
      database.close();
    }
  });
}

/* ── Seeding: the real write path with live reset detection (task 110/118) ─ */

/** One §8.4 metric fixture. */
function metric(overrides: Partial<NormalizedMetric> = {}): NormalizedMetric {
  return {
    key: 'mcp-monthly',
    label: 'Monthly MCP tool quota',
    limitType: 'MONTHLY',
    unit: 'CREDITS',
    windowSeconds: undefined,
    used: 80,
    remaining: 20,
    limit: 100,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: undefined,
    isValid: true,
    invalidReason: undefined,
    derivedFields: undefined,
    ...overrides,
  };
}

/** The §8.4 metric as the storage row input (nulls for absent fields). */
function metricRowInput(m: NormalizedMetric): CycleMetricInput {
  return {
    metricKey: m.key,
    limitType: m.limitType,
    unit: m.unit,
    windowSeconds: m.windowSeconds ?? null,
    used: m.used ?? null,
    remaining: m.remaining ?? null,
    limit: m.limit ?? null,
    percentUsed: m.percentUsed ?? null,
    percentRemaining: m.percentRemaining ?? null,
    resetsAt: m.resetsAt ?? null,
    isValid: m.isValid,
    invalidReason: m.invalidReason ?? null,
    derivedFields: null,
  };
}

/**
 * Seeds one successful cycle as the poller does — detection read before the
 * atomic write (task 118's composition). `durationMs` controls the run's
 * wall-clock span (default 1.2 s).
 */
function seedSuccessCycle(
  repository: QuotaRepository,
  collectedAt: number,
  metrics: ReadonlyArray<NormalizedMetric>,
  options: { intervalSeconds?: number; durationMs?: number } = {},
): number {
  const durationMs = options.durationMs ?? 1_200;
  const snapshot: ProviderSnapshot = {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: 'Pro',
    metrics: [...metrics],
  };
  const events = detectCycleResetEvents(repository, 'work', snapshot);
  persistCollectionCycle(repository, {
    accountId: 'work',
    startedAt: collectedAt - durationMs,
    endedAt: collectedAt,
    intervalSeconds: options.intervalSeconds ?? 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt,
      planName: 'Pro',
      metrics: metrics.map(metricRowInput),
      events,
    },
  });
  return collectedAt;
}

/** Seeds one failed cycle — a run row only, no snapshot (§11.2). */
function seedFailedRun(
  repository: QuotaRepository,
  startedAt: number,
  outcome: Exclude<RunOutcome, 'success'>,
  evidence: {
    httpStatus?: number;
    errorMessage?: string;
    retryAfterSeconds?: number;
    attempts?: number;
    intervalSeconds?: number;
    durationMs?: number;
  } = {},
): void {
  const cycle: CollectionCycleWrite = {
    accountId: 'work',
    startedAt,
    endedAt: startedAt + (evidence.durationMs ?? 2_500),
    intervalSeconds: evidence.intervalSeconds ?? 300,
    attempts: evidence.attempts ?? 1,
    outcome,
    httpStatus: evidence.httpStatus ?? null,
    errorMessage: evidence.errorMessage ?? null,
    retryAfterSeconds: evidence.retryAfterSeconds ?? null,
  };
  persistCollectionCycle(repository, cycle);
}

/* ── Response shapes the assertions read ────────────────────────────────── */

/** One unified timeline entry (the `kind` discriminates the §12.2 classes). */
type EventWire =
  | {
      readonly kind: 'reset';
      readonly metricKey: string;
      readonly eventAt: number;
      readonly runId: number | null;
      readonly details: { readonly reason: string; [evidence: string]: unknown };
    }
  | {
      readonly kind: 'gap';
      readonly metricKey: string;
      readonly fromEpochMs: number;
      readonly toEpochMs: number;
      readonly elapsedMs: number;
      readonly intervalSeconds: number;
      readonly thresholdMs: number;
    }
  | {
      readonly kind: 'collection_error';
      readonly outcome: string;
      readonly fromEpochMs: number;
      readonly toEpochMs: number;
      readonly durationMs: number;
      readonly httpStatus: number | null;
      readonly message: string;
      readonly attempts: number;
      readonly retryAfterSeconds: number | null;
    }
  | {
      readonly kind: 'stopped_service';
      readonly fromEpochMs: number;
      readonly toEpochMs: number;
      readonly elapsedMs: number;
      readonly intervalSeconds: number;
      readonly thresholdMs: number;
    };

/** The full events response body. */
interface EventsBody {
  accountId: string;
  metric: string | null;
  range: { readonly outcome: string; readonly [field: string]: unknown };
  events: EventWire[];
}

/** Reads one events response. */
async function getEvents(
  app: FastifyInstance,
  url: string,
): Promise<{ statusCode: number; body: EventsBody }> {
  const response = await app.inject({ method: 'GET', url });
  return { statusCode: response.statusCode, body: response.json() as EventsBody };
}

/** The entries of one kind. */
function ofKind(body: EventsBody, kind: EventWire['kind']): EventWire[] {
  return body.events.filter((event) => event.kind === kind);
}

/* ── Contract ───────────────────────────────────────────────────────────── */

describe('GET /api/events — the response contract', () => {
  it('answers the empty timeline honestly: no events, ok range, null filter', async () => {
    await withEventsApi(async ({ app }) => {
      const { statusCode, body } = await getEvents(app, eventsUrl());
      expect(statusCode).toBe(200);
      expect(body).toEqual({
        accountId: 'work',
        metric: null,
        range: {
          outcome: 'ok',
          requestedFrom: NOW - 7 * DAY_MS,
          requestedTo: NOW,
          effectiveFrom: NOW - 7 * DAY_MS,
          effectiveTo: NOW,
          retentionHorizon: null,
        },
        events: [],
      });
    });
  });

  it('echoes the metric filter and keeps the account-level classes unfiltered', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 3_000_000, [metric()]);
      seedSuccessCycle(repository, NOW - 200_000, [
        metric({ used: 10, remaining: 90, percentUsed: 10, percentRemaining: 90 }),
      ]);
      seedFailedRun(repository, NOW - 100_000, 'timeout', { attempts: 2 });
      const { body } = await getEvents(app, eventsUrl({ metric: 'tokens-5h' }));
      expect(body.metric).toBe('tokens-5h');
      // The unknown filter narrows the per-metric kinds to nothing…
      expect(ofKind(body, 'reset')).toEqual([]);
      expect(ofKind(body, 'gap')).toEqual([]);
      // …but failed cycles and stopped regions are account-level facts.
      expect(ofKind(body, 'collection_error')).toHaveLength(1);
    });
  });
});

/* ── §12.1 reset events through the real detection pipeline ─────────────── */

describe('GET /api/events — reset events (§12.1, live detection)', () => {
  it('serves condition 1 (the usage drop) with its evidence and run link', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 600_000, [
        metric({ used: 90, remaining: 10, percentUsed: 90, percentRemaining: 10 }),
      ]);
      seedSuccessCycle(repository, NOW - 300_000, [
        metric({ used: 10, remaining: 90, percentUsed: 10, percentRemaining: 90 }),
      ]);
      const resets = ofKind((await getEvents(app, eventsUrl())).body, 'reset');
      expect(resets).toHaveLength(1);
      const reset = resets[0] as Extract<EventWire, { kind: 'reset' }>;
      expect(reset.metricKey).toBe('mcp-monthly');
      // No resetsAt between the snapshots → the event time is the new
      // snapshot's own collection time (§12.1's fallback rule).
      expect(reset.eventAt).toBe(NOW - 300_000);
      expect(reset.runId).toBeTypeOf('number');
      expect(reset.details.reason).toContain('usage_decreased');
      // The evidence carries both compared points (D-046/D-074 vocabulary).
      expect(reset.details.previous).toMatchObject({ used: 90 });
      expect(reset.details.current).toMatchObject({ used: 10 });
    });
  });

  it('serves condition 2 at the previous resetsAt when it lies between the snapshots', async () => {
    await withEventsApi(async ({ app, repository }) => {
      // Identical values (no value evidence) with a declared reset that
      // passes between the two cycles and advances.
      seedSuccessCycle(repository, NOW - 600_000, [metric({ resetsAt: NOW - 500_000 })]);
      seedSuccessCycle(repository, NOW - 300_000, [metric({ resetsAt: NOW + DAY_MS })]);
      const resets = ofKind((await getEvents(app, eventsUrl())).body, 'reset');
      expect(resets).toHaveLength(1);
      const reset = resets[0] as Extract<EventWire, { kind: 'reset' }>;
      expect(reset.eventAt).toBe(NOW - 500_000);
      expect(reset.details.reason).toContain('resets_at_advanced');
    });
  });

  it('creates nothing on anti-predicted movement or rolling-window value movement', async () => {
    await withEventsApi(async ({ app, repository }) => {
      // Usage grows: the anti-predicted direction vetoes condition 1.
      seedSuccessCycle(repository, NOW - 600_000, [
        metric({ used: 50, remaining: 50, percentUsed: 50, percentRemaining: 50 }),
      ]);
      seedSuccessCycle(repository, NOW - 300_000, [
        metric({ used: 60, remaining: 40, percentUsed: 60, percentRemaining: 40 }),
      ]);
      // A rolling-window metric's replenishment is inadmissible value
      // evidence (D-074's conservative approach): a big drop with no
      // resetsAt advancement mints nothing.
      seedSuccessCycle(repository, NOW - 200_000, [
        metric({
          key: 'tokens-5h',
          limitType: 'ROLLING_WINDOW',
          windowSeconds: 18_000,
          used: 95,
          remaining: 5,
          percentUsed: 95,
          percentRemaining: 5,
        }),
      ]);
      seedSuccessCycle(repository, NOW - 100_000, [
        metric({
          key: 'tokens-5h',
          limitType: 'ROLLING_WINDOW',
          windowSeconds: 18_000,
          used: 5,
          remaining: 95,
          percentUsed: 5,
          percentRemaining: 95,
        }),
      ]);
      const { body } = await getEvents(app, eventsUrl());
      expect(ofKind(body, 'reset')).toEqual([]);
    });
  });
});

/* ── §12.2 collection gaps ──────────────────────────────────────────────── */

describe('GET /api/events — collection gaps (§12.2)', () => {
  it('serves a beyond-threshold gap with its edges, cadence, and threshold', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 1_500_000, [metric()]);
      seedSuccessCycle(repository, NOW - 1_200_000, [metric()]);
      seedSuccessCycle(repository, NOW - 200_000, [metric()]);
      const gaps = ofKind((await getEvents(app, eventsUrl())).body, 'gap');
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        kind: 'gap',
        metricKey: 'mcp-monthly',
        fromEpochMs: NOW - 1_200_000,
        toEpochMs: NOW - 200_000,
        elapsedMs: 1_000_000,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      });
    });
  });

  it('judges by the run-stamped cadence: the same spacing gaps at 300 s, not at 3600 s', async () => {
    await withEventsApi(async ({ app, repository }) => {
      // Era 1 (interval 300 s → threshold 990_000): a 5_000_000 ms hole gaps.
      seedSuccessCycle(repository, NOW - 12_000_000, [metric()], { intervalSeconds: 300 });
      seedSuccessCycle(repository, NOW - 7_000_000, [metric()], { intervalSeconds: 300 });
      // Era 2 (interval 3600 s → threshold 11_880_000): the same 5_000_000
      // ms spacing is ordinary cadence — D-075's per-pair judgment over the
      // run stamps, no false gap after an interval change (the (−7M, −5M)
      // pair is additionally widened to the 3600 s cadence that changed
      // inside its span).
      seedSuccessCycle(repository, NOW - 5_000_000, [metric()], { intervalSeconds: 3600 });
      seedSuccessCycle(repository, NOW, [metric()], { intervalSeconds: 3600 });
      const gaps = ofKind((await getEvents(app, eventsUrl())).body, 'gap');
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ fromEpochMs: NOW - 12_000_000, toEpochMs: NOW - 7_000_000 });
    });
  });

  it('excludes invalid points from the gap edges (§12.2 successful snapshots)', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 2_000_000, [metric()]);
      seedSuccessCycle(repository, NOW - 1_000_000, [
        metric({
          isValid: false,
          invalidReason: 'provider field missing',
          used: undefined,
          remaining: undefined,
          limit: undefined,
          percentUsed: undefined,
          percentRemaining: undefined,
        }),
      ]);
      seedSuccessCycle(repository, NOW - 100_000, [metric()]);
      const gaps = ofKind((await getEvents(app, eventsUrl())).body, 'gap');
      expect(gaps).toHaveLength(1);
      // The edges are the VALID points on both sides of the invalid one.
      expect(gaps[0]).toMatchObject({ fromEpochMs: NOW - 2_000_000, toEpochMs: NOW - 100_000 });
    });
  });

  it('enumerates every metric’s gaps when no filter is supplied', async () => {
    await withEventsApi(async ({ app, repository }) => {
      const twoMetrics = [
        metric(),
        metric({ key: 'tokens-5h', limitType: 'ROLLING_WINDOW', windowSeconds: 18_000 }),
      ];
      seedSuccessCycle(repository, NOW - 3_000_000, twoMetrics);
      seedSuccessCycle(repository, NOW - 200_000, twoMetrics);
      const gaps = ofKind((await getEvents(app, eventsUrl())).body, 'gap');
      expect(gaps.map((gap) => (gap as { metricKey: string }).metricKey).sort()).toEqual([
        'mcp-monthly',
        'tokens-5h',
      ]);
      const filtered = ofKind(
        (await getEvents(app, eventsUrl({ metric: 'tokens-5h' }))).body,
        'gap',
      );
      expect(filtered).toHaveLength(1);
      expect((filtered[0] as { metricKey: string }).metricKey).toBe('tokens-5h');
    });
  });
});

/* ── §12.2 failed cycles and stopped-service regions ────────────────────── */

describe('GET /api/events — failed cycles and stopped regions (§12.2)', () => {
  it('serves one item per failed cycle with its evidence, redacted (§7.4)', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 4_000_000, [metric()]);
      seedFailedRun(repository, NOW - 3_000_000, 'network_error', {
        attempts: 3,
        errorMessage: `connection refused for ${MARKER_KEY}`,
      });
      seedFailedRun(repository, NOW - 2_900_000, 'rate_limited', {
        httpStatus: 429,
        attempts: 1,
        retryAfterSeconds: 60,
      });
      seedFailedRun(repository, NOW - 2_800_000, 'parse_error', { httpStatus: 200, attempts: 1 });
      const response = await app.inject({ method: 'GET', url: eventsUrl() });
      expect(response.body).not.toContain(MARKER_KEY);
      const errors = ofKind(response.json() as EventsBody, 'collection_error');
      expect(errors).toHaveLength(3);
      expect(errors[0]).toMatchObject({
        kind: 'collection_error',
        outcome: 'network_error',
        attempts: 3,
        message: 'connection refused for [REDACTED]',
        httpStatus: null,
        retryAfterSeconds: null,
      });
      expect(errors[1]).toMatchObject({
        outcome: 'rate_limited',
        httpStatus: 429,
        retryAfterSeconds: 60,
        durationMs: 2_500,
      });
      expect(errors[2]).toMatchObject({ outcome: 'parse_error', httpStatus: 200 });
    });
  });

  it('keeps failed cycles outside the range off the timeline', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedFailedRun(repository, NOW - 30 * DAY_MS, 'timeout', { attempts: 1 });
      seedFailedRun(repository, NOW - 100_000, 'timeout', { attempts: 1 });
      const errors = ofKind((await getEvents(app, eventsUrl())).body, 'collection_error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ fromEpochMs: NOW - 100_000 });
    });
  });

  it('serves a mid-range stopped region with clamped edges, cadence, and threshold', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 5_000_000, [metric()]);
      // A ~4.5-hour silence between the two successful cycles.
      seedSuccessCycle(repository, NOW - 500_000, [metric()]);
      // The range starts at the first record's collection time, so no
      // leading region precedes the one under test.
      const { body } = await getEvents(app, eventsUrl({ from: iso(NOW - 5_000_000) }));
      const stopped = ofKind(body, 'stopped_service');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toEqual({
        kind: 'stopped_service',
        fromEpochMs: NOW - 5_000_000,
        toEpochMs: NOW - 501_200,
        elapsedMs: 4_498_800,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      });
    });
  });

  it('expresses full-range downtime when the outage outlasts the evidence margin', async () => {
    await withEventsApi(async ({ app, repository }) => {
      // The review round's P1 fold: runs 40 days apart, the queried range
      // entirely inside the silence and farther from both than the margin —
      // the plain margin read finds nothing, and without the nearest-bound
      // probes the hatched region would silently disappear.
      seedSuccessCycle(repository, NOW - 40 * DAY_MS, [metric()]);
      seedSuccessCycle(repository, NOW, [metric()]);
      const from = NOW - 20 * DAY_MS;
      const to = NOW - 10 * DAY_MS;
      const { body } = await getEvents(app, eventsUrl({ from: iso(from), to: iso(to) }));
      const stopped = ofKind(body, 'stopped_service');
      expect(stopped).toHaveLength(1);
      // The nearest record after the range bounds the leading silence; the
      // module clamps it into the full-range region and judges by the
      // bounding run's own cadence.
      expect(stopped[0]).toEqual({
        kind: 'stopped_service',
        fromEpochMs: from,
        toEpochMs: to,
        elapsedMs: 10 * DAY_MS,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      });
    });
  });

  it('anchors the leading silence on a pre-range run (the evidence margin)', async () => {
    await withEventsApi(async ({ app, repository }) => {
      const from = NOW - 3 * 3_600_000;
      // A run straddling the range edge: started 5 s before `from`, ended
      // 5 s inside — only the margin-widened read sees it, and the region
      // starts at its end, not at the range edge (task 120's anchor rule).
      seedSuccessCycle(repository, from + 5_000, [metric()], { durationMs: 10_000 });
      seedSuccessCycle(repository, from + 2 * 3_600_000, [metric()]);
      const { body } = await getEvents(
        app,
        eventsUrl({ from: iso(from), to: iso(from + 2 * 3_600_000 + 600_000) }),
      );
      const stopped = ofKind(body, 'stopped_service');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toMatchObject({ fromEpochMs: from + 5_000 });
    });
  });

  it('never marks a stretch that holds run records as stopped', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 4_000_000, [metric()]);
      // An hour of failed cycles 600 s apart: records exist throughout, so
      // the §12.2 classes stay distinct — error markers, no hatched region
      // over the stretch (600 s sits under the 990 s threshold).
      for (let index = 0; index < 5; index++) {
        seedFailedRun(repository, NOW - 3_600_000 + index * 600_000, 'server_error', {
          httpStatus: 502,
        });
      }
      seedSuccessCycle(repository, NOW - 1_000_000, [metric()]);
      // The range is bounded by the records, so no leading/trailing silence
      // exists either: zero stopped regions is the pin.
      const { body } = await getEvents(
        app,
        eventsUrl({ from: iso(NOW - 4_000_000), to: iso(NOW - 500_000) }),
      );
      expect(ofKind(body, 'collection_error')).toHaveLength(5);
      expect(ofKind(body, 'stopped_service')).toEqual([]);
    });
  });

  it('orders the unified timeline by instant (then the frozen kind rank)', async () => {
    await withEventsApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 10_000_000, [metric()]);
      seedSuccessCycle(repository, NOW - 5_000_000, [
        metric({ used: 10, remaining: 90, percentUsed: 10, percentRemaining: 90 }),
      ]); // the usage drop resets; the 5M silence gaps
      seedFailedRun(repository, NOW - 4_900_000, 'timeout');
      seedSuccessCycle(repository, NOW - 100_000, [metric()]);
      const { body } = await getEvents(app, eventsUrl({ from: iso(NOW - 10_000_000) }));
      const instants = body.events.map((event) =>
        event.kind === 'reset' ? event.eventAt : event.fromEpochMs,
      );
      expect([...instants].sort((a, b) => a - b)).toEqual(instants);
      // The 5M silences yield BOTH §12.2 classes at the same instants — the
      // metric-level gaps and the run-level stopped regions — ordered by the
      // frozen kind rank (reset before gap at −5M); the second stopped
      // region is the post-failure silence before the final success.
      expect(body.events.map((event) => event.kind)).toEqual([
        'gap',
        'stopped_service',
        'reset',
        'gap',
        'collection_error',
        'stopped_service',
      ]);
    });
  });
});

/* ── Retention (§13/§11.3) ──────────────────────────────────────────────── */

describe('GET /api/events — retention bounds', () => {
  it('truncates the range and serves only in-policy timeline entries', async () => {
    await withEventsApi(async (harness) => {
      // Seeded OLDEST-first (the detector is conservative on out-of-order
      // pairs) with usage descending over time by 3 per 3-day step: the
      // live detector persists a RESET per drop — nine in all.
      for (let day = 27; day >= 0; day -= 3) {
        seedSuccessCycle(harness.repository, NOW - day * DAY_MS, [metric({ used: day + 10 })]);
      }
      harness.retentionDays = 7;
      const { statusCode, body } = await getEvents(
        harness.app,
        eventsUrl({ from: iso(NOW - 30 * DAY_MS) }),
      );
      expect(statusCode).toBe(200);
      expect(body.range.outcome).toBe('truncated');
      expect(body.range.effectiveFrom).toBe(NOW - 7 * DAY_MS);
      // Every entry sits at/after the horizon (the loop is the pin); the
      // resets alone prove the clamp: of the nine drops seeded across the
      // month, exactly the three inside the window (eventAt 0, 3, and 6
      // days ago) survive — the day-9 drop is out of policy.
      const horizon = NOW - 7 * DAY_MS;
      for (const event of body.events) {
        const instant = event.kind === 'reset' ? event.eventAt : event.fromEpochMs;
        expect(instant).toBeGreaterThanOrEqual(horizon);
      }
      expect(ofKind(body, 'reset')).toHaveLength(3);
    });
  });

  it('answers the empty timeline with the rejected report beyond retention', async () => {
    await withEventsApi(async (harness) => {
      seedSuccessCycle(harness.repository, NOW - 20 * DAY_MS, [metric()]);
      harness.retentionDays = 7;
      const { statusCode, body } = await getEvents(
        harness.app,
        eventsUrl({ from: iso(NOW - 30 * DAY_MS), to: iso(NOW - 10 * DAY_MS) }),
      );
      expect(statusCode).toBe(200);
      expect(body.range).toEqual({
        outcome: 'rejected',
        requestedFrom: NOW - 30 * DAY_MS,
        requestedTo: NOW - 10 * DAY_MS,
        effectiveFrom: null,
        effectiveTo: null,
        retentionHorizon: NOW - 7 * DAY_MS,
      });
      expect(body.events).toEqual([]);
    });
  });
});

/* ── Errors, authorization, and the no-half-wired pin ───────────────────── */

describe('GET /api/events — error classes and the §15.1 seam', () => {
  it('answers the shared error classes (§13, D-139)', async () => {
    await withEventsApi(async ({ app }) => {
      const badFrom = await getEvents(app, eventsUrl({ from: '2026-10-20T12:00:00' }));
      expect(badFrom.statusCode).toBe(400);
      expect((badFrom.body as unknown as { error: { details: unknown } }).error.details).toEqual({
        reason: 'invalid-timestamp',
        param: 'from',
      });
      const inverted = await getEvents(app, eventsUrl({ from: iso(NOW), to: iso(NOW - DAY_MS) }));
      expect(inverted.statusCode).toBe(400);
      expect((inverted.body as unknown as { error: { details: unknown } }).error.details).toEqual({
        reason: 'inverted-range',
      });
      const unknown = await getEvents(app, eventsUrl({ accountId: 'ghost' }));
      expect(unknown.statusCode).toBe(404);
      const smuggled = await app.inject({ method: 'GET', url: `${eventsUrl()}&maxPoints=100` });
      expect(smuggled.statusCode).toBe(400);
    });
  });

  it('rejects unauthenticated under required mode with 401', async () => {
    await withEventsApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: eventsUrl() });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'UNAUTHENTICATED', details: { reason: 'authentication-required' } },
        });
      },
      { auth: { mode: 'required', bindHost: '127.0.0.1', passwordConfigured: () => true } },
    );
  });

  it('answers the scope catch-all 404 when the construction passes no history block', async () => {
    await withEventsApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: eventsUrl() });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      },
      { wired: false },
    );
  });
});

describe('GET /api/events — clock-skewed rows are tolerated (D-185)', () => {
  /**
   * The same mixed clean/skewed world as the history suite's D-185 block
   * (all rows through the real facade write path — the D-034 schema
   * deliberately admits the skew), exercising the events-only halves:
   * the INVERTED failed run R4 (`ended_at` 60 s before `started_at`) must
   * be PROJECTED to a zero-duration marker at its trusted start (the
   * record still bounds stopped silence — the review round's P1 proved
   * dropping it can merge two legal neighbor silences into a fabricated
   * outage), the normal failure R7 must still mark, the pre-coverage
   * point p1 must leave the p1→p2 silence unjudged, and the real
   * gap/stopped pair around R5→R6 must survive. Interval 300 s ⇒ the
   * §12.2 threshold is 990 000 ms.
   */
  const T0 = NOW - 3_600_000;

  /** Seeds the skewed first success: a snapshot stamped before its run. */
  function seedSkewedSuccess(repository: QuotaRepository): void {
    persistCollectionCycle(repository, {
      accountId: 'work',
      startedAt: T0 + 300_000,
      endedAt: T0 + 301_200,
      intervalSeconds: 300,
      attempts: 1,
      httpStatus: 200,
      outcome: 'success',
      snapshot: {
        collectedAt: T0,
        planName: 'Pro',
        metrics: [metricRowInput(metric())],
        events: [],
      },
    });
  }

  it('answers 200 with the inverted run skipped, the normal failure kept, and both diagnostics logged', async () => {
    await withEventsApi(async ({ app, repository, sink }) => {
      seedSkewedSuccess(repository);
      seedSuccessCycle(repository, T0 + 1_200_000, [metric()]);
      seedSuccessCycle(repository, T0 + 1_260_000, [metric()]);
      // The inverted failed run: `persistCollectionCycle` writes it as-is
      // (no CHECK rejects the ordering — D-034's deliberate leniency).
      persistCollectionCycle(repository, {
        accountId: 'work',
        startedAt: T0 + 1_500_000,
        endedAt: T0 + 1_440_000,
        intervalSeconds: 300,
        attempts: 1,
        outcome: 'network_error',
        httpStatus: null,
        errorMessage: 'connection reset',
        retryAfterSeconds: null,
      });
      seedSuccessCycle(repository, T0 + 1_560_000, [metric()]);
      seedSuccessCycle(repository, T0 + 3_000_000, [metric()]);
      seedFailedRun(repository, T0 + 3_060_000, 'network_error', {
        durationMs: 2_500,
        errorMessage: 'connection timed out',
      });

      const { statusCode, body } = await getEvents(app, eventsUrl());
      expect(statusCode).toBe(200);

      // The unjudgeable p1→p2 silence (20 min, beyond the 990 s threshold)
      // mints nothing; the real p5→p6 gap (24 min) is detected exactly.
      expect(ofKind(body, 'gap')).toEqual([
        {
          kind: 'gap',
          metricKey: 'mcp-monthly',
          fromEpochMs: T0 + 1_560_000,
          toEpochMs: T0 + 3_000_000,
          elapsedMs: 1_440_000,
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
      ]);

      // Both failures mark: the inverted run as a zero-duration cycle at
      // its trusted start (the record is real evidence — hiding a failed
      // cycle would under-report an outage the operator lived through),
      // the normal one with its true span.
      const errors = ofKind(body, 'collection_error');
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({
        outcome: 'network_error',
        fromEpochMs: T0 + 1_500_000,
        toEpochMs: T0 + 1_500_000,
        durationMs: 0,
        message: 'connection reset',
      });
      expect(errors[1]).toMatchObject({
        outcome: 'network_error',
        fromEpochMs: T0 + 3_060_000,
        toEpochMs: T0 + 3_062_500,
        durationMs: 2_500,
        message: 'connection timed out',
      });

      // Stopped regions: the leading silence up to the first run, and the
      // interior R5→R6 record silence — the inverted run's skip mints
      // nothing extra (its neighbors sit 5 min apart, under the threshold).
      expect(ofKind(body, 'stopped_service')).toEqual([
        {
          kind: 'stopped_service',
          fromEpochMs: NOW - 7 * DAY_MS,
          toEpochMs: T0 + 300_000,
          elapsedMs: T0 + 300_000 - (NOW - 7 * DAY_MS),
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
        {
          kind: 'stopped_service',
          fromEpochMs: T0 + 1_560_000,
          toEpochMs: T0 + 2_998_800,
          elapsedMs: 1_438_800,
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
      ]);

      // Both skips are §16-visible as sanitized warn diagnostics.
      const warns = sink
        .records()
        .filter((record) => record.msg === 'clock-skewed history evidence tolerated');
      expect(warns).toEqual([
        expect.objectContaining({
          level: 40,
          kind: 'inverted_run',
          accountId: 'work',
          count: 1,
          earliestStartedAt: T0 + 1_500_000,
          latestStartedAt: T0 + 1_500_000,
        }),
        expect.objectContaining({
          level: 40,
          kind: 'unjudgeable_point',
          accountId: 'work',
          count: 1,
          earliestCollectedAt: T0,
          latestCollectedAt: T0,
          coverageFromEpochMs: T0 + 300_000,
        }),
      ]);
    });
  });

  it('keeps a projected inverted run bounding silence: two legal legs must not merge into a stopped region (the review P1)', async () => {
    await withEventsApi(async ({ app, repository, sink }) => {
      // Three records at the 300 s cadence: the neighbor silences around
      // the inverted run are 798 800 ms each — legal inter-poll cadence
      // under the 990 000 ms threshold — while their MERGED span
      // (1 597 600 ms) exceeds it. Dropping the inverted row from the walk
      // would fabricate a hatched outage across a cycle that ran; the
      // projection keeps the record bounding silence at its trusted start.
      seedSuccessCycle(repository, NOW - 3_598_800, [metric()]);
      persistCollectionCycle(repository, {
        accountId: 'work',
        startedAt: NOW - 2_800_000,
        endedAt: NOW - 2_801_000,
        intervalSeconds: 300,
        attempts: 1,
        outcome: 'network_error',
        httpStatus: null,
        errorMessage: 'connection reset',
        retryAfterSeconds: null,
      });
      seedSuccessCycle(repository, NOW - 2_000_000, [metric()]);

      const { statusCode, body } = await getEvents(app, eventsUrl());
      expect(statusCode).toBe(200);

      // Exactly two stopped regions — the leading silence up to the first
      // run and the trailing one after the last — and NOTHING between the
      // neighbors of the inverted run: the would-be fabricated region is
      // the merged 1 597 600 ms span.
      expect(ofKind(body, 'stopped_service')).toEqual([
        {
          kind: 'stopped_service',
          fromEpochMs: NOW - 7 * DAY_MS,
          toEpochMs: NOW - 3_600_000,
          elapsedMs: NOW - 3_600_000 - (NOW - 7 * DAY_MS),
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
        {
          kind: 'stopped_service',
          fromEpochMs: NOW - 2_000_000,
          toEpochMs: NOW,
          elapsedMs: 2_000_000,
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
      ]);

      // The failed inverted cycle still marks — at its trusted start, with
      // the honest zero-duration projection of an unreliable span.
      const errors = ofKind(body, 'collection_error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        outcome: 'network_error',
        fromEpochMs: NOW - 2_800_000,
        toEpochMs: NOW - 2_800_000,
        durationMs: 0,
      });

      // The point silence across the failed cycle is real (no snapshot was
      // produced) and still gaps: 1 598 800 ms > 990 000 ms.
      expect(ofKind(body, 'gap')).toEqual([
        {
          kind: 'gap',
          metricKey: 'mcp-monthly',
          fromEpochMs: NOW - 3_598_800,
          toEpochMs: NOW - 2_000_000,
          elapsedMs: 1_598_800,
          intervalSeconds: 300,
          thresholdMs: 990_000,
        },
      ]);

      const warns = sink
        .records()
        .filter((record) => record.msg === 'clock-skewed history evidence tolerated');
      expect(warns).toEqual([
        expect.objectContaining({
          level: 40,
          kind: 'inverted_run',
          accountId: 'work',
          count: 1,
          earliestStartedAt: NOW - 2_800_000,
          latestStartedAt: NOW - 2_800_000,
        }),
      ]);
    });
  });
});
