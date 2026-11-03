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
import { persistCollectionCycle, type CycleMetricInput } from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 history endpoint on the wire (task 161, spec §12, §13, §11.3;
 * decision D-139): `GET /api/history` through the real `/api` scope — the
 * three landed guards included — over a real migrated disposable
 * `node:sqlite` database, with §11.2 history seeded through the real write
 * path (`persistCollectionCycle` with task 118's live reset detection, the
 * exact task-110 composition). The done-condition's classes: the response
 * contract (points, buckets, empty points, range report, effective
 * resolution), retention behavior (truncation and rejection with the
 * report), downsampling (budget, extrema, boundary preservation), error
 * classes (invalid timestamps, inverted range, unknown account, smuggled
 * fields), the §15.1 seam, and the no-half-wired 404.
 */

/** Deterministic §11.1 epoch-millisecond base. */
const NOW = 1_761_000_000_000;

/** One day of absolute time (the retention tests' unit). */
const DAY_MS = 86_400_000;

/** The §15.4 marker secret — nothing it touches may reach a response body. */
const MARKER_KEY = 'sk-marker-secret-4f7a1c9e2b';

/** `t` as the §13 ISO request parameter (the D-139 request half). */
function iso(t: number): string {
  return new Date(t).toISOString();
}

/** The shared history query URL (defaults: the last 7 days of `work`). */
function historyUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    accountId: 'work',
    metric: 'mcp-monthly',
    from: iso(NOW - 7 * DAY_MS),
    to: iso(NOW),
    ...overrides,
  });
  return `/api/history?${params.toString()}`;
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
    throw new Error('the history view never mutates the store');
  }

  async update(): Promise<ManagedAccountConfig | null> {
    throw new Error('the history view never mutates the store');
  }

  async remove(): Promise<boolean> {
    throw new Error('the history view never mutates the store');
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
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  /** Whether the history block is wired at all (the no-half-wired pin). */
  readonly wired?: boolean;
}

async function withHistoryApi(
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
    const harness: Harness = {
      app: undefined as unknown as Harness['app'],
      repository,
      retentionDays: 3650,
    };
    const sink = createMemoryLogSink();
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

/** One §8.4 metric fixture — the values a snapshot would carry. */
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
 * Seeds one successful cycle exactly as the poller does: the §12.1 events
 * are detected from the repository state first (task 118's seam, read
 * before the write), then the whole cycle persists atomically (§11.1).
 * Returns the snapshot's collection stamp.
 */
function seedSuccessCycle(
  repository: QuotaRepository,
  collectedAt: number,
  metrics: ReadonlyArray<NormalizedMetric>,
  options: { intervalSeconds?: number; accountId?: string } = {},
): number {
  const accountId = options.accountId ?? 'work';
  const snapshot: ProviderSnapshot = {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: 'Pro',
    metrics: [...metrics],
  };
  const events = detectCycleResetEvents(repository, accountId, snapshot);
  persistCollectionCycle(repository, {
    accountId,
    startedAt: collectedAt - 1_200,
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

/* ── Response shapes the assertions read ────────────────────────────────── */

/** One value-bearing point endpoint (a raw point or a bucket first/last). */
interface PointWire {
  readonly kind: 'point';
  readonly collectedAt: number;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly percentUsed: number | null;
  readonly percentRemaining: number | null;
  readonly resetsAt: number | null;
  readonly isValid: boolean;
  readonly invalidReason: string | null;
}

/** One aggregated bucket. */
interface BucketWire {
  readonly kind: 'bucket';
  readonly fromEpochMs: number;
  readonly toEpochMs: number;
  readonly count: number;
  readonly min: { readonly used: number | null };
  readonly max: { readonly used: number | null };
  readonly first: PointWire;
  readonly last: PointWire;
}

/** One points-array entry. */
type PointItem = PointWire | BucketWire | { readonly kind: 'empty'; readonly collectedAt: number };

/** The full history response body. */
interface HistoryBody {
  accountId: string;
  metric: string;
  unit: string | null;
  limitType: string | null;
  range: {
    outcome: string;
    requestedFrom: number;
    requestedTo: number;
    effectiveFrom: number | null;
    effectiveTo: number | null;
    retentionHorizon: number | null;
  };
  downsampled: boolean;
  resolutionMs: number | null;
  sourcePointCount: number;
  points: PointItem[];
}

/** Reads one history response. */
async function getHistory(
  app: FastifyInstance,
  url: string,
): Promise<{ statusCode: number; body: HistoryBody }> {
  const response = await app.inject({ method: 'GET', url });
  return { statusCode: response.statusCode, body: response.json() as HistoryBody };
}

/* ── Contract ───────────────────────────────────────────────────────────── */

describe('GET /api/history — the response contract', () => {
  it('answers the empty series honestly: null identity, no points, ok range', async () => {
    await withHistoryApi(async ({ app }) => {
      const { statusCode, body } = await getHistory(app, historyUrl());
      expect(statusCode).toBe(200);
      expect(body).toEqual({
        accountId: 'work',
        metric: 'mcp-monthly',
        unit: null,
        limitType: null,
        range: {
          outcome: 'ok',
          requestedFrom: NOW - 7 * DAY_MS,
          requestedTo: NOW,
          effectiveFrom: NOW - 7 * DAY_MS,
          effectiveTo: NOW,
          retentionHorizon: null,
        },
        downsampled: false,
        resolutionMs: null,
        sourcePointCount: 0,
        points: [],
      });
    });
  });

  it('renders seeded rows as points with values, validity, and series identity', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 600_000, [
        metric({ used: 90, remaining: 10, percentUsed: 90, percentRemaining: 10 }),
      ]);
      seedSuccessCycle(repository, NOW - 300_000, [metric()]);
      seedSuccessCycle(repository, NOW, [
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
      const { statusCode, body } = await getHistory(
        app,
        historyUrl({ from: iso(NOW - DAY_MS), to: iso(NOW) }),
      );
      expect(statusCode).toBe(200);
      // Series identity from the newest row — the invalid row still carries
      // the NOT NULL identity columns; its values stay honest nulls (§8.4).
      expect(body.unit).toBe('CREDITS');
      expect(body.limitType).toBe('MONTHLY');
      expect(body.sourcePointCount).toBe(3);
      expect(body.downsampled).toBe(false);
      expect(body.resolutionMs).toBeNull();
      expect(body.points.map((point) => point.kind)).toEqual(['point', 'point', 'point']);
      const [first, , last] = body.points as [PointWire, PointWire, PointWire];
      expect(first).toMatchObject({ collectedAt: NOW - 600_000, used: 90, isValid: true });
      expect(last).toEqual({
        kind: 'point',
        collectedAt: NOW,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: null,
        percentRemaining: null,
        resetsAt: null,
        isValid: false,
        invalidReason: 'provider field missing',
      });
    });
  });

  it('serves an archived account’s retained history (§8.2, the both-halves verdict)', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      // The storage row exists and is archived; the configuration entry is
      // gone (the archive removed it) — the store double knows only `work`.
      repository.insertAccount({
        id: 'gone',
        providerId: 'zai-coding-plan',
        label: 'gone account',
        createdAt: NOW - 30 * DAY_MS,
      });
      repository.archiveAccount('gone', NOW - 10 * DAY_MS);
      const archivedAt = seedSuccessCycle(repository, NOW - 5 * DAY_MS, [metric()], {
        accountId: 'gone',
      });
      const { statusCode, body } = await getHistory(
        app,
        historyUrl({ accountId: 'gone', from: iso(NOW - 7 * DAY_MS) }),
      );
      expect(statusCode).toBe(200);
      expect(body.points).toHaveLength(1);
      expect(body.points[0]).toMatchObject({ kind: 'point', collectedAt: archivedAt });
      // The events route reads the same both-halves verdict.
      const events = await app.inject({
        method: 'GET',
        url: `/api/events?accountId=gone&from=${iso(NOW - 7 * DAY_MS)}&to=${iso(NOW)}`,
      });
      expect(events.statusCode).toBe(200);
    });
  });

  it('accepts the §13 ISO parameter forms: Z and explicit numeric offsets', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 300_000, [metric()]);
      const withZ = await getHistory(app, historyUrl());
      const withOffset = await getHistory(
        app,
        historyUrl({
          from: iso(NOW - 7 * DAY_MS).replace('Z', '+00:00'),
          to: iso(NOW).replace('Z', '-00:00'),
        }),
      );
      expect(withZ.statusCode).toBe(200);
      expect(withOffset.statusCode).toBe(200);
      expect(withOffset.body.range.requestedFrom).toBe(withZ.body.range.requestedFrom);
      expect(withOffset.body.sourcePointCount).toBe(1);
    });
  });
});

/* ── §12.2 gaps as empty points ─────────────────────────────────────────── */

describe('GET /api/history — collection gaps as explicit empty points', () => {
  it('splices one empty point between the edges of a beyond-threshold silence', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      // interval 300 s → threshold 990_000 ms; the 1_000_000 ms hole gaps.
      seedSuccessCycle(repository, NOW - 1_500_000, [metric()]);
      seedSuccessCycle(repository, NOW - 1_200_000, [metric()]);
      seedSuccessCycle(repository, NOW - 200_000, [metric()]);
      const { body } = await getHistory(app, historyUrl());
      expect(body.points.map((point) => point.kind)).toEqual(['point', 'point', 'empty', 'point']);
      expect(body.points[2]).toEqual({
        kind: 'empty',
        collectedAt: NOW - 1_200_000 + 500_000,
      });
    });
  });

  it('emits nothing for a silence at exactly the threshold (§12.2 "exceeds")', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 1_190_000, [metric()]);
      seedSuccessCycle(repository, NOW - 200_000, [
        metric({ used: 10, remaining: 90, percentUsed: 10, percentRemaining: 90 }),
      ]);
      const { body } = await getHistory(app, historyUrl());
      expect(body.points.map((point) => point.kind)).toEqual(['point', 'point']);
    });
  });
});

/* ── §13 downsampling ───────────────────────────────────────────────────── */

describe('GET /api/history — the maxPoints budget', () => {
  /**
   * Seeds `count` points 60 s apart (interval 60 s, threshold 198_000 ms)
   * with `usedOf` per index, optionally one 1_000_000 ms hole after index
   * `holeAfter`. Ascending `used` values mint no reset events (usage growth
   * is the anti-predicted direction, D-074) — a drop does. Returns the
   * collection stamps, ascending.
   */
  function seedSeries(
    repository: QuotaRepository,
    count: number,
    usedOf: (index: number) => number,
    options: { holeAfter?: number } = {},
  ): number[] {
    const stamps: number[] = [];
    for (let index = 0; index < count; index++) {
      // The hole shifts this index and every later one LATER by 1_000_000 ms,
      // so exactly one pair spacing widens (the stamps stay ascending).
      const hole = options.holeAfter !== undefined && index > options.holeAfter ? 1_000_000 : 0;
      const collectedAt = NOW - (count - index) * 60_000 + hole;
      const used = usedOf(index);
      seedSuccessCycle(
        repository,
        collectedAt,
        [
          metric({
            used,
            remaining: 1000 - used,
            percentUsed: used / 10,
            percentRemaining: (1000 - used) / 10,
          }),
        ],
        { intervalSeconds: 60 },
      );
      stamps.push(collectedAt);
    }
    return stamps;
  }

  it('passes a within-budget series through untouched', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      seedSeries(repository, 10, (index) => index);
      const { body } = await getHistory(
        app,
        historyUrl({ from: iso(NOW - DAY_MS), maxPoints: '100' }),
      );
      expect(body.downsampled).toBe(false);
      expect(body.resolutionMs).toBeNull();
      expect(body.points.every((point) => point.kind === 'point')).toBe(true);
      expect(body.sourcePointCount).toBe(10);
    });
  });

  it(
    'aggregates an overfull series: budget kept, extrema and endpoints preserved',
    { timeout: 20_000 },
    async () => {
      await withHistoryApi(async ({ app, repository }) => {
        const stamps = seedSeries(repository, 120, (index) => index);
        const { body } = await getHistory(
          app,
          historyUrl({ from: iso(NOW - DAY_MS), maxPoints: '100' }),
        );
        expect(body.downsampled).toBe(true);
        expect(body.resolutionMs).toBeTypeOf('number');
        expect(body.resolutionMs as number).toBeGreaterThan(0);
        const buckets = body.points as BucketWire[];
        expect(buckets.every((bucket) => bucket.kind === 'bucket')).toBe(true);
        expect(buckets.length).toBeLessThanOrEqual(100);
        // No loss: the members sum to the source series (§13's no-loss rule).
        expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(120);
        // Extrema preserved: the global min/max of the seeded values ride the
        // bucket extrema (D-081's per-field preservation).
        expect(Math.min(...buckets.map((bucket) => bucket.min.used as number))).toBe(0);
        expect(Math.max(...buckets.map((bucket) => bucket.max.used as number))).toBe(119);
        // First/last: the series' own endpoints (the caller's point objects).
        expect(buckets[0]?.first.collectedAt).toBe(stamps[0]);
        expect(buckets[buckets.length - 1]?.last.collectedAt).toBe(stamps[stamps.length - 1]);
      });
    },
  );

  it(
    'never aggregates across a gap or a reset: the boundaries survive',
    { timeout: 30_000 },
    async () => {
      await withHistoryApi(async ({ app, repository }) => {
        // 150 points, one hole after index 70, and a used drop of 90 at index
        // 100 (the real detector persists the RESET inside the same write).
        const stamps = seedSeries(repository, 150, (index) => (index < 100 ? index : index - 90), {
          holeAfter: 70,
        });
        const { body } = await getHistory(
          app,
          historyUrl({ from: iso(NOW - DAY_MS), maxPoints: '100' }),
        );
        const items = body.points;
        // The gap: an explicit empty point, bracketed by buckets whose observed
        // edges ARE the gap edges (nothing aggregated across the silence).
        const emptyIndex = items.findIndex((item) => item.kind === 'empty');
        expect(emptyIndex).toBeGreaterThan(0);
        expect(items[emptyIndex - 1]).toMatchObject({ kind: 'bucket', toEpochMs: stamps[70] });
        expect(items[emptyIndex + 1]).toMatchObject({ kind: 'bucket', fromEpochMs: stamps[71] });
        // The reset at t_100 (used drops 99 → 10): the bracketing points stay
        // in different buckets — the pre-reset point closes a bucket, the
        // post-reset point opens the next one.
        const preIndex = items.findIndex(
          (item) => item.kind === 'bucket' && item.toEpochMs === stamps[99],
        );
        expect(preIndex).toBeGreaterThanOrEqual(0);
        expect(items[preIndex + 1]).toMatchObject({ kind: 'bucket', fromEpochMs: stamps[100] });
        expect((items[preIndex] as BucketWire).last.used).toBe(99);
        expect((items[preIndex + 1] as BucketWire).first.used).toBe(10);
      });
    },
  );

  it(
    'never loses a gap that holds an invalid row: boundaries and order survive downsampling',
    { timeout: 30_000 },
    async () => {
      await withHistoryApi(async ({ app, repository }) => {
        // The review round's P1 fold: an invalid row inside the gap used to
        // glue the gap's edge points into one downsampler segment (nothing
        // straddled the whole interval) and could misplace the empty point.
        // The fix aggregates valid points only and re-inserts the invalid
        // row as its own point entry, ordered by the empty point's midpoint.
        const stamps = seedSeries(repository, 120, (index) => index, { holeAfter: 70 });
        const insideGap = stamps[70]! + 500_000; // before the 530_000 midpoint
        seedSuccessCycle(
          repository,
          insideGap,
          [
            metric({
              isValid: false,
              invalidReason: 'provider field missing',
              used: undefined,
              remaining: undefined,
              limit: undefined,
              percentUsed: undefined,
              percentRemaining: undefined,
            }),
          ],
          { intervalSeconds: 60 },
        );
        const { body } = await getHistory(
          app,
          historyUrl({ from: iso(NOW - DAY_MS), to: iso(NOW + 2_000_000), maxPoints: '100' }),
        );
        expect(body.downsampled).toBe(true);
        expect(body.sourcePointCount).toBe(121);
        const items = body.points;
        const emptyIndex = items.findIndex((item) => item.kind === 'empty');
        expect(emptyIndex).toBeGreaterThan(1);
        // Chronological around the gap: the pre-edge bucket closes at t70,
        // the invalid point rides inside the gap before the midpoint empty,
        // and the post-edge bucket opens at t71 — nothing aggregates across.
        expect(items[emptyIndex - 2]).toMatchObject({ kind: 'bucket', toEpochMs: stamps[70] });
        expect(items[emptyIndex - 1]).toMatchObject({
          kind: 'point',
          collectedAt: insideGap,
          isValid: false,
          used: null,
          invalidReason: 'provider field missing',
        });
        expect(items[emptyIndex]).toEqual({
          kind: 'empty',
          collectedAt: stamps[70]! + 530_000,
        });
        expect(items[emptyIndex + 1]).toMatchObject({ kind: 'bucket', fromEpochMs: stamps[71] });
        const buckets = items.filter((item) => item.kind === 'bucket') as BucketWire[];
        expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(120);
      });
    },
  );

  it(
    'applies the §13 default budget of 1500 when maxPoints is absent',
    { timeout: 30_000 },
    async () => {
      await withHistoryApi(async ({ app, repository }) => {
        // 1501 points of monotone usage (no resets along the way). Seeded as
        // one repository transaction — 1501 ceremony-wrapped cycle writes
        // cost ~40 s of wall clock for the same structural rows (the runs,
        // snapshots, and metric rows the composite foreign keys still pin
        // together, D-036/D-039); the boundary cases above already exercise
        // the full `persistCollectionCycle` path.
        repository.withTransaction((tx) => {
          for (let index = 0; index < 1501; index++) {
            const collectedAt = NOW - (1501 - index) * 60_000;
            const runId = tx.insertCollectionRun({
              accountId: 'work',
              startedAt: collectedAt - 1_200,
              endedAt: collectedAt,
              intervalSeconds: 60,
              outcome: 'success',
              httpStatus: 200,
              attempts: 1,
            });
            tx.insertSnapshot({ accountId: 'work', runId, collectedAt, planName: 'Pro' });
            tx.insertMetricValues([
              {
                accountId: 'work',
                runId,
                collectedAt,
                metricKey: 'mcp-monthly',
                limitType: 'MONTHLY',
                unit: 'CREDITS',
                windowSeconds: null,
                used: index * 0.1,
                remaining: 1000 - index * 0.1,
                limit: 1000,
                percentUsed: index * 0.01,
                percentRemaining: 100 - index * 0.01,
                resetsAt: null,
                isValid: true,
                invalidReason: null,
                derivedFields: null,
              },
            ]);
          }
        });
        // 1501 points at 60 s spacing span ~25 hours — the range covers two
        // days so every seeded row is in policy for both requests.
        const range = { from: iso(NOW - 2 * DAY_MS) };
        const defaulted = await getHistory(app, historyUrl(range));
        expect(defaulted.body.downsampled).toBe(true);
        expect(defaulted.body.resolutionMs).not.toBeNull();
        expect(defaulted.body.sourcePointCount).toBe(1501);
        const explicit = await getHistory(app, historyUrl({ ...range, maxPoints: '5000' }));
        expect(explicit.body.downsampled).toBe(false);
      });
    },
  );
});

/* ── Retention (§13/§11.3, task 123's vocabulary) ────────────────────────── */

describe('GET /api/history — retention bounds', () => {
  /** Seeds one point per day over the last 30 days. */
  function seedMonth(repository: QuotaRepository): void {
    for (let day = 0; day < 30; day++) {
      seedSuccessCycle(repository, NOW - day * DAY_MS, [metric({ used: day })]);
    }
  }

  it('truncates a partially-older range, stating requested, effective, and horizon', async () => {
    await withHistoryApi(async (harness) => {
      seedMonth(harness.repository);
      harness.retentionDays = 7;
      const horizon = NOW - 7 * DAY_MS;
      const { statusCode, body } = await getHistory(
        harness.app,
        historyUrl({ from: iso(NOW - 30 * DAY_MS) }),
      );
      expect(statusCode).toBe(200);
      expect(body.range).toEqual({
        outcome: 'truncated',
        requestedFrom: NOW - 30 * DAY_MS,
        requestedTo: NOW,
        effectiveFrom: horizon,
        effectiveTo: NOW,
        retentionHorizon: horizon,
      });
      // Only the in-policy rows serve: days 0..7 (collected at/after the
      // horizon), whatever older rows still sit in the database.
      expect(body.sourcePointCount).toBe(8);
      const points = body.points.filter((point) => point.kind === 'point') as PointWire[];
      expect(points).toHaveLength(8);
      for (const point of points) {
        expect(point.collectedAt).toBeGreaterThanOrEqual(horizon);
      }
    });
  });

  it('answers the empty series with the rejected report for a range entirely beyond retention', async () => {
    await withHistoryApi(async (harness) => {
      seedMonth(harness.repository);
      harness.retentionDays = 7;
      const { statusCode, body } = await getHistory(
        harness.app,
        historyUrl({ from: iso(NOW - 30 * DAY_MS), to: iso(NOW - 20 * DAY_MS) }),
      );
      expect(statusCode).toBe(200);
      expect(body.range).toEqual({
        outcome: 'rejected',
        requestedFrom: NOW - 30 * DAY_MS,
        requestedTo: NOW - 20 * DAY_MS,
        effectiveFrom: null,
        effectiveTo: null,
        retentionHorizon: NOW - 7 * DAY_MS,
      });
      expect(body.points).toEqual([]);
      expect(body.sourcePointCount).toBe(0);
      expect(body.unit).toBeNull();
    });
  });

  it('reads the retention window per request (§6.4-live)', async () => {
    await withHistoryApi(async (harness) => {
      seedMonth(harness.repository);
      const from = iso(NOW - 30 * DAY_MS);
      harness.retentionDays = 7;
      const tight = await getHistory(harness.app, historyUrl({ from }));
      harness.retentionDays = 30;
      const wide = await getHistory(harness.app, historyUrl({ from }));
      expect(tight.body.range.outcome).toBe('truncated');
      expect(wide.body.range.outcome).toBe('ok');
      expect(wide.body.range.requestedFrom).toBe(NOW - 30 * DAY_MS);
    });
  });
});

/* ── Errors, authorization, and the no-half-wired pin ───────────────────── */

describe('GET /api/history — error classes', () => {
  it('answers VALIDATION for malformed and offset-less timestamps', async () => {
    await withHistoryApi(async ({ app }) => {
      // A blank parameter dies at the closed schema (minLength), answering
      // the framework-mapped VALIDATION envelope with its validation facts.
      const blank = await getHistory(app, historyUrl({ from: '' }));
      expect(blank.statusCode).toBe(400);
      expect((blank.body as unknown as { error: { code: string } }).error.code).toBe('VALIDATION');
      // Anything the schema admits but §10's strict parse rejects (no
      // explicit offset, a bare date, plain garbage) reaches the endpoint's
      // parser and answers the stable reason with the offending parameter.
      const cases: Array<{ overrides: Record<string, string>; param?: string }> = [
        { overrides: { from: '2026-10-20T12:00:00' }, param: 'from' },
        { overrides: { from: '2026-10-20' }, param: 'from' },
        { overrides: { to: 'yesterday' }, param: 'to' },
      ];
      for (const { overrides, param } of cases) {
        const { statusCode, body } = await getHistory(app, historyUrl(overrides));
        expect(statusCode, JSON.stringify(overrides)).toBe(400);
        const error = (body as unknown as { error: { code: string; details: unknown } }).error;
        expect(error.code).toBe('VALIDATION');
        expect(error.details).toEqual({ reason: 'invalid-timestamp', param });
      }
    });
  });

  it('answers VALIDATION/inverted-range when from is later than to', async () => {
    await withHistoryApi(async ({ app }) => {
      const { statusCode, body } = await getHistory(
        app,
        historyUrl({ from: iso(NOW), to: iso(NOW - DAY_MS) }),
      );
      expect(statusCode).toBe(400);
      const error = (body as unknown as { error: { details: unknown } }).error;
      expect(error.details).toEqual({ reason: 'inverted-range' });
    });
  });

  it('answers NOT_FOUND for an account unknown to both halves', async () => {
    await withHistoryApi(async ({ app }) => {
      const { statusCode, body } = await getHistory(app, historyUrl({ accountId: 'ghost' }));
      expect(statusCode).toBe(404);
      const error = (body as unknown as { error: { code: string } }).error;
      expect(error.code).toBe('NOT_FOUND');
    });
  });

  it('answers VALIDATION for out-of-budget maxPoints and smuggled fields', async () => {
    await withHistoryApi(async ({ app }) => {
      for (const maxPoints of ['99', '5001', '1500.5', 'many']) {
        const { statusCode, body } = await getHistory(app, historyUrl({ maxPoints }));
        expect(statusCode, maxPoints).toBe(400);
        const error = (body as unknown as { error: { code: string } }).error;
        expect(error.code).toBe('VALIDATION');
      }
      const smuggled = await app.inject({ method: 'GET', url: `${historyUrl()}&timezone=UTC` });
      expect(smuggled.statusCode).toBe(400);
      const error = (smuggled.json() as { error: { code: string } }).error;
      expect(error.code).toBe('VALIDATION');
    });
  });

  it('never puts the configured key on any response body (§15.4)', async () => {
    await withHistoryApi(async ({ app, repository }) => {
      seedSuccessCycle(repository, NOW - 300_000, [metric()]);
      for (const url of [
        historyUrl(),
        historyUrl({ maxPoints: '99' }),
        historyUrl({ accountId: 'ghost' }),
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.body).not.toContain(MARKER_KEY);
      }
    });
  });
});

describe('GET /api/history — the §15.1 seam', () => {
  const REQUIRED_WITH_PASSWORD: AuthModeGuardOptions = {
    mode: 'required',
    bindHost: '127.0.0.1',
    passwordConfigured: () => true,
  };

  it('required mode with the fail-closed seam rejects with 401', async () => {
    await withHistoryApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: historyUrl() });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
            details: { reason: 'authentication-required' },
          },
        });
      },
      { auth: REQUIRED_WITH_PASSWORD },
    );
  });

  it("answers §15.1's 403 with instructions for a proxied passwordless request", async () => {
    await withHistoryApi(async ({ app }) => {
      const response = await app.inject({
        method: 'GET',
        url: historyUrl(),
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { details: { reason: 'proxy-without-password' } },
      });
    });
  });

  it('a succeeding seam composes — required mode answers once authenticated', async () => {
    await withHistoryApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: historyUrl() });
        expect(response.statusCode).toBe(200);
      },
      { auth: { ...REQUIRED_WITH_PASSWORD, isAuthenticated: () => true } },
    );
  });
});

describe('GET /api/history — the no-half-wired rule (D-128)', () => {
  it('answers the scope catch-all 404 when the construction passes no history block', async () => {
    await withHistoryApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: historyUrl() });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      },
      { wired: false },
    );
  });
});
