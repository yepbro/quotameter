import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import type { AccountConfigStore, ManagedAccountConfig } from '../../src/server/api/accounts';
import { apiErrorHandler } from '../../src/server/api/error';
import type { PeakHoursResponse } from '../../src/schemas/api/peak-hours';
import type { PeakHoursConfig, ProvidersConfig } from '../../src/schemas/config';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 peak-hours endpoint on the wire (task 162, spec §9.3, §13, §11.3;
 * decision D-142): `GET /api/peak-hours` through the real `/api` scope — the
 * three landed guards included — over a real migrated disposable
 * `node:sqlite` database. The timeline is computed from the live schedule
 * configuration, so the only storage fact the route needs is the account
 * verdict (the D-128 both-halves row read); no history is seeded. The
 * done-condition's classes: the §9.1 production schedule with exact UTC
 * epochs and source-zone local times, the DST transition matrix on the wire,
 * retention behavior (truncation and rejection with the D-139 report), the
 * no-schedule and empty-windows arms, the error classes (invalid
 * timestamps, inverted range, span cap, unknown account, smuggled fields),
 * and the no-half-wired 404. All epochs are pinned literals (the D-073
 * invariance discipline — this suite runs under the §17.1 TZ matrix).
 */

/** Deterministic §11.1 epoch base: 2026-10-21T00:00:00Z (a Wednesday). */
const NOW = Date.UTC(2026, 9, 21);

/** One day of absolute time (the retention tests' unit). */
const DAY_MS = 86_400_000;

/** The §9.1 sample schedule, in the production zone. */
const ZAI_SCHEDULE: PeakHoursConfig = {
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  windows: [
    {
      id: 'zai-weekday-peak',
      name: 'Z.ai Coding Plan peak hours',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '14:00',
      end: '18:00',
      multiplier: 1.0,
    },
  ],
};

/** `t` as the §13 ISO request parameter (the D-139 request half). */
function iso(t: number): string {
  return new Date(t).toISOString();
}

/* ── The configuration-store double (159's seam, read-only half) ─────────── */

interface StoredEntry {
  readonly id: string;
  readonly providerId?: string;
}

class ReadOnlyAccountStore implements AccountConfigStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(seed: ReadonlyArray<StoredEntry>) {
    for (const entry of seed) this.entries.set(entry.id, entry);
  }

  private view(entry: StoredEntry): ManagedAccountConfig {
    return {
      id: entry.id,
      providerId: entry.providerId ?? 'zai-coding-plan',
      label: `${entry.id} account`,
      enabled: true,
      keyConfigured: false,
      keySource: 'none',
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
    throw new Error('the peak-hours view never mutates the store');
  }

  async update(): Promise<ManagedAccountConfig | null> {
    throw new Error('the peak-hours view never mutates the store');
  }

  async remove(): Promise<boolean> {
    throw new Error('the peak-hours view never mutates the store');
  }

  async secretOf(): Promise<string | null> {
    return null;
  }
}

/* ── The harness ────────────────────────────────────────────────────────── */

interface Harness {
  app: FastifyInstance;
  readonly repository: QuotaRepository;
  /** The live `providers` section — §6.4-live, swapped per test. */
  schedules: ProvidersConfig;
  /** The §11.3 retention window in days — §6.4-live, read per request. */
  retentionDays: number;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  /** Whether the peak-hours block is wired at all (the no-half-wired pin). */
  readonly wired?: boolean;
  /** Accounts the configuration store knows (storage always knows `work`). */
  readonly configAccounts?: ReadonlyArray<StoredEntry>;
}

async function withPeakHoursApi(
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
    // A storage-only account: configured nowhere, its row carries the
    // provider id the timeline resolves through (§8.2's retained account).
    repository.insertAccount({
      id: 'legacy',
      providerId: 'zai-coding-plan',
      label: 'archived account',
      createdAt: NOW,
    });
    repository.archiveAccount('legacy', NOW);
    const harness: Harness = {
      app: undefined as unknown as Harness['app'],
      repository,
      schedules: { 'zai-coding-plan': { peakHours: ZAI_SCHEDULE } },
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
            peakHours: {
              store: new ReadOnlyAccountStore(options.configAccounts ?? [{ id: 'work' }]),
              repository,
              schedules: () => harness.schedules,
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

/** GETs the peak-hours timeline of `work` over a range, with overrides. */
function peakHoursUrl(
  overrides: Record<string, string> = {},
  range?: { from: number; to: number },
): string {
  const params = new URLSearchParams({
    accountId: 'work',
    from: iso(range?.from ?? NOW - 2 * DAY_MS),
    to: iso(range?.to ?? NOW),
    ...overrides,
  });
  return `/api/peak-hours?${params.toString()}`;
}

type PeakHoursHttp = { statusCode: number; body: PeakHoursResponse };

async function getPeakHours(app: FastifyInstance, url: string): Promise<PeakHoursHttp> {
  const response = await app.inject({ method: 'GET', url });
  return { statusCode: response.statusCode, body: response.json() as PeakHoursResponse };
}

/* ── The served timeline ────────────────────────────────────────────────── */

describe('GET /api/peak-hours — the §9.1 production schedule', () => {
  it('serves the Z.ai weekday timeline with exact epochs and local times', async () => {
    await withPeakHoursApi(async ({ app }) => {
      // Monday 2026-10-19T00:00:00Z through Wednesday 2026-10-21T00:00:00Z:
      // two weekday peaks at 14:00–18:00 SGT (06:00–10:00 UTC each).
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: Date.UTC(2026, 9, 19), to: Date.UTC(2026, 9, 21) }),
      );
      expect(statusCode).toBe(200);
      expect(body).toEqual({
        accountId: 'work',
        providerId: 'zai-coding-plan',
        timezone: 'Asia/Singapore',
        offPeakMultiplier: 0.5,
        range: {
          outcome: 'ok',
          requestedFrom: Date.UTC(2026, 9, 19),
          requestedTo: Date.UTC(2026, 9, 21),
          effectiveFrom: Date.UTC(2026, 9, 19),
          effectiveTo: Date.UTC(2026, 9, 21),
          retentionHorizon: null,
        },
        intervals: [
          {
            kind: 'off-peak',
            start: Date.UTC(2026, 9, 19),
            end: Date.UTC(2026, 9, 19, 6),
            multiplier: 0.5,
            localStart: '2026-10-19T08:00',
            localEnd: '2026-10-19T14:00',
          },
          {
            kind: 'peak',
            start: Date.UTC(2026, 9, 19, 6),
            end: Date.UTC(2026, 9, 19, 10),
            multiplier: 1.0,
            windowId: 'zai-weekday-peak',
            name: 'Z.ai Coding Plan peak hours',
            localStart: '2026-10-19T14:00',
            localEnd: '2026-10-19T18:00',
          },
          {
            kind: 'off-peak',
            start: Date.UTC(2026, 9, 19, 10),
            end: Date.UTC(2026, 9, 20, 6),
            multiplier: 0.5,
            localStart: '2026-10-19T18:00',
            localEnd: '2026-10-20T14:00',
          },
          {
            kind: 'peak',
            start: Date.UTC(2026, 9, 20, 6),
            end: Date.UTC(2026, 9, 20, 10),
            multiplier: 1.0,
            windowId: 'zai-weekday-peak',
            name: 'Z.ai Coding Plan peak hours',
            localStart: '2026-10-20T14:00',
            localEnd: '2026-10-20T18:00',
          },
          {
            kind: 'off-peak',
            start: Date.UTC(2026, 9, 20, 10),
            end: Date.UTC(2026, 9, 21),
            multiplier: 0.5,
            localStart: '2026-10-20T18:00',
            localEnd: '2026-10-21T08:00',
          },
        ],
      });
    });
  });

  it('sets the no-store cache header', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: peakHoursUrl() });
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });
});

describe('GET /api/peak-hours — the DST matrix on the wire', () => {
  it('serves the 23-hour spring day of America/New_York', async () => {
    await withPeakHoursApi(async ({ app, schedules }) => {
      schedules['zai-coding-plan'] = {
        peakHours: {
          timezone: 'America/New_York',
          offPeakMultiplier: 0.5,
          windows: [
            {
              id: 'ny-sunday',
              name: 'Sunday peak',
              days: ['sun'],
              start: '00:00',
              end: '24:00',
              multiplier: 1.0,
            },
          ],
        },
      };
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: Date.UTC(2026, 2, 7, 12), to: Date.UTC(2026, 2, 9, 12) }),
      );
      expect(statusCode).toBe(200);
      expect(body.timezone).toBe('America/New_York');
      expect(body.intervals).toEqual([
        {
          kind: 'off-peak',
          start: Date.UTC(2026, 2, 7, 12),
          end: Date.UTC(2026, 2, 8, 5),
          multiplier: 0.5,
          localStart: '2026-03-07T07:00',
          localEnd: '2026-03-08T00:00',
        },
        {
          kind: 'peak',
          start: Date.UTC(2026, 2, 8, 5),
          end: Date.UTC(2026, 2, 9, 4),
          multiplier: 1.0,
          windowId: 'ny-sunday',
          name: 'Sunday peak',
          localStart: '2026-03-08T00:00',
          localEnd: '2026-03-09T00:00',
        },
        {
          kind: 'off-peak',
          start: Date.UTC(2026, 2, 9, 4),
          end: Date.UTC(2026, 2, 9, 12),
          multiplier: 0.5,
          localStart: '2026-03-09T00:00',
          localEnd: '2026-03-09T08:00',
        },
      ]);
    });
  });

  it('serves the quarter-hour Pacific/Chatham gap shift', async () => {
    await withPeakHoursApi(async ({ app, schedules }) => {
      schedules['zai-coding-plan'] = {
        peakHours: {
          timezone: 'Pacific/Chatham',
          offPeakMultiplier: 0.5,
          windows: [
            {
              id: 'chatham',
              name: 'Chatham peak',
              days: ['sun'],
              start: '03:00',
              end: '03:30',
              multiplier: 1.0,
            },
          ],
        },
      };
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: Date.UTC(2026, 8, 26, 12), to: Date.UTC(2026, 8, 27, 12) }),
      );
      expect(statusCode).toBe(200);
      expect(body.intervals[1]).toEqual({
        kind: 'peak',
        start: Date.UTC(2026, 8, 26, 14, 15),
        end: Date.UTC(2026, 8, 26, 14, 45),
        multiplier: 1.0,
        windowId: 'chatham',
        name: 'Chatham peak',
        // Both edges sat inside the [02:45, 03:45) gap: the wire renders
        // the shifted instants' own local times (D-073/D-079).
        localStart: '2026-09-27T04:00',
        localEnd: '2026-09-27T04:30',
      });
    });
  });
});

describe('GET /api/peak-hours — retention (the D-139 report, inherited)', () => {
  it('truncates a partially out-of-retention range and serves the clamped timeline', async () => {
    await withPeakHoursApi(async (harness) => {
      const from = NOW - 30 * DAY_MS;
      // §11.3's minimum window: the horizon is NOW - 7 days =
      // 2026-10-14T00:00:00Z (a Wednesday), and the effective timeline
      // starts exactly there — inside that day's pre-peak stretch.
      harness.retentionDays = 7;
      const { statusCode, body } = await getPeakHours(
        harness.app,
        peakHoursUrl({}, { from, to: NOW }),
      );
      expect(statusCode).toBe(200);
      const horizon = NOW - 7 * DAY_MS;
      expect(body.range).toEqual({
        outcome: 'truncated',
        requestedFrom: from,
        requestedTo: NOW,
        effectiveFrom: horizon,
        effectiveTo: NOW,
        retentionHorizon: horizon,
      });
      // Five weekday peaks (Wed 14 – Fri 16, Mon 19, Tue 20) with their
      // off-peak stretches: the partition of [horizon, NOW).
      expect(body.intervals).toHaveLength(11);
      expect(body.intervals[0]).toEqual({
        kind: 'off-peak',
        start: horizon,
        end: Date.UTC(2026, 9, 14, 6),
        multiplier: 0.5,
        localStart: '2026-10-14T08:00',
        localEnd: '2026-10-14T14:00',
      });
      const last = body.intervals[body.intervals.length - 1]!;
      expect(last).toEqual({
        kind: 'off-peak',
        start: Date.UTC(2026, 9, 20, 10),
        end: NOW,
        multiplier: 0.5,
        localStart: '2026-10-20T18:00',
        localEnd: '2026-10-21T08:00',
      });
      // The partition invariants over the effective range (D-073).
      expect(body.intervals[0]!.start).toBe(horizon);
      for (const [index, interval] of body.intervals.entries()) {
        expect(interval.start).toBeGreaterThanOrEqual(horizon);
        expect(interval.end).toBeLessThanOrEqual(NOW);
        if (index > 0) {
          expect(interval.start).toBe(body.intervals[index - 1]!.end);
        }
      }
    });
  });

  it('answers the rejected arm with the horizon named and empty intervals', async () => {
    await withPeakHoursApi(async (harness) => {
      harness.retentionDays = 7;
      const { statusCode, body } = await getPeakHours(
        harness.app,
        peakHoursUrl({}, { from: NOW - 30 * DAY_MS, to: NOW - 20 * DAY_MS }),
      );
      expect(statusCode).toBe(200);
      expect(body.range.outcome).toBe('rejected');
      expect(body.range.effectiveFrom).toBe(null);
      expect(body.range.effectiveTo).toBe(null);
      expect(body.range.retentionHorizon).toBe(NOW - 7 * DAY_MS);
      expect(body.intervals).toEqual([]);
      // The schedule facts still echo — they are configuration, not range
      // output (the arm is orthogonal to the no-schedule arm).
      expect(body.timezone).toBe('Asia/Singapore');
      expect(body.offPeakMultiplier).toBe(0.5);
    });
  });

  it('reads the retention window per request (§6.4-live)', async () => {
    await withPeakHoursApi(async (harness) => {
      const from = NOW - 30 * DAY_MS;
      harness.retentionDays = 7;
      const tight = await getPeakHours(harness.app, peakHoursUrl({}, { from, to: NOW }));
      harness.retentionDays = 30;
      const wide = await getPeakHours(harness.app, peakHoursUrl({}, { from, to: NOW }));
      expect(tight.body.range.outcome).toBe('truncated');
      expect(wide.body.range.outcome).toBe('ok');
      expect(wide.body.range.requestedFrom).toBe(from);
    });
  });
});

describe('GET /api/peak-hours — the schedule arms', () => {
  it('answers the no-schedule arm when the provider is unconfigured', async () => {
    await withPeakHoursApi(async (harness) => {
      delete harness.schedules['zai-coding-plan'];
      const { statusCode, body } = await getPeakHours(harness.app, peakHoursUrl());
      expect(statusCode).toBe(200);
      expect(body.timezone).toBe(null);
      expect(body.offPeakMultiplier).toBe(null);
      expect(body.intervals).toEqual([]);
      expect(body.providerId).toBe('zai-coding-plan');
      expect(body.range.outcome).toBe('ok');
    });
  });

  it('computes the empty-windows schedule as the whole-range off-peak interval', async () => {
    await withPeakHoursApi(async (harness) => {
      harness.schedules['zai-coding-plan'] = {
        peakHours: { timezone: 'Asia/Singapore', windows: [] },
      };
      const { statusCode, body } = await getPeakHours(harness.app, peakHoursUrl());
      expect(statusCode).toBe(200);
      expect(body.timezone).toBe('Asia/Singapore');
      expect(body.offPeakMultiplier).toBe(1);
      expect(body.intervals).toEqual([
        {
          kind: 'off-peak',
          start: NOW - 2 * DAY_MS,
          end: NOW,
          multiplier: 1,
          localStart: '2026-10-19T08:00',
          localEnd: '2026-10-21T08:00',
        },
      ]);
    });
  });

  it('serves a storage-only (archived) account from its row’s provider id', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const { statusCode, body } = await getPeakHours(app, peakHoursUrl({ accountId: 'legacy' }));
      expect(statusCode).toBe(200);
      expect(body.providerId).toBe('zai-coding-plan');
      expect(body.timezone).toBe('Asia/Singapore');
      expect(body.intervals.length).toBeGreaterThan(0);
    });
  });

  it('resolves the provider id from the configuration entry when both halves know it', async () => {
    await withPeakHoursApi(
      async ({ app }) => {
        const { statusCode, body } = await getPeakHours(
          app,
          peakHoursUrl({ accountId: 'special' }),
        );
        expect(statusCode).toBe(200);
        expect(body.providerId).toBe('special-provider');
        // No providers entry for the special provider: the no-schedule arm.
        expect(body.timezone).toBe(null);
      },
      { configAccounts: [{ id: 'special', providerId: 'special-provider' }] },
    );
  });
});

describe('GET /api/peak-hours — error classes', () => {
  it('answers VALIDATION for malformed and offset-less timestamps', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const blank = await getPeakHours(app, peakHoursUrl({ from: '' }));
      expect(blank.statusCode).toBe(400);
      expect((blank.body as unknown as { error: { code: string } }).error.code).toBe('VALIDATION');
      const cases: Array<{ overrides: Record<string, string>; param?: string }> = [
        { overrides: { from: '2026-10-20T12:00:00' }, param: 'from' },
        { overrides: { from: '2026-10-20' }, param: 'from' },
        { overrides: { to: 'yesterday' }, param: 'to' },
      ];
      for (const { overrides, param } of cases) {
        const { statusCode, body } = await getPeakHours(app, peakHoursUrl(overrides));
        expect(statusCode, JSON.stringify(overrides)).toBe(400);
        const error = (body as unknown as { error: { code: string; details: unknown } }).error;
        expect(error.code).toBe('VALIDATION');
        expect(error.details).toEqual({ reason: 'invalid-timestamp', param });
      }
    });
  });

  it('answers VALIDATION/inverted-range when from is later than to', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: NOW, to: NOW - DAY_MS }),
      );
      expect(statusCode).toBe(400);
      const error = (body as unknown as { error: { details: unknown } }).error;
      expect(error.details).toEqual({ reason: 'inverted-range' });
    });
  });

  it('answers VALIDATION/range-too-wide for a span over the calculator’s cap', async () => {
    await withPeakHoursApi(async ({ app }) => {
      // Retention never clamps `to` (D-082): a far-future end beyond the
      // 3660-local-day cap reaches the calculator's loud refusal.
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: NOW, to: NOW + 4000 * DAY_MS }),
      );
      expect(statusCode).toBe(400);
      const error = (body as unknown as { error: { code: string; details: unknown } }).error;
      expect(error.code).toBe('VALIDATION');
      expect(error.details).toEqual({ reason: 'range-too-wide', maxDays: 3660 });
    });
  });

  it('answers VALIDATION/range-unsupported at the epoch representability edge', async () => {
    await withPeakHoursApi(async ({ app }) => {
      // One day at the ECMAScript time ceiling (the review round's P2):
      // every value parses and the span is one day, but no zone conversion
      // can render the +8:00 reading past the representable bound — the
      // honest refusal names the epoch range, never the day cap.
      const from = Date.parse('+275760-09-12T00:00:00.000Z');
      const to = Date.parse('+275760-09-13T00:00:00.000Z');
      const { statusCode, body } = await getPeakHours(app, peakHoursUrl({}, { from, to }));
      expect(statusCode).toBe(400);
      const error = (body as unknown as { error: { code: string; details: unknown } }).error;
      expect(error.code).toBe('VALIDATION');
      expect(error.details).toEqual({ reason: 'range-unsupported' });
    });
  });

  it('answers NOT_FOUND for an account unknown to both halves', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const { statusCode, body } = await getPeakHours(app, peakHoursUrl({ accountId: 'ghost' }));
      expect(statusCode).toBe(404);
      const error = (body as unknown as { error: { code: string } }).error;
      expect(error.code).toBe('NOT_FOUND');
    });
  });

  it('answers VALIDATION for smuggled query fields', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const smuggled = await app.inject({
        method: 'GET',
        url: `${peakHoursUrl()}&metric=mcp-monthly`,
      });
      expect(smuggled.statusCode).toBe(400);
      const error = (smuggled.json() as { error: { code: string } }).error;
      expect(error.code).toBe('VALIDATION');
    });
  });

  it('serves the degenerate from === to range as the empty timeline', async () => {
    await withPeakHoursApi(async ({ app }) => {
      const { statusCode, body } = await getPeakHours(
        app,
        peakHoursUrl({}, { from: NOW, to: NOW }),
      );
      expect(statusCode).toBe(200);
      expect(body.intervals).toEqual([]);
      expect(body.range.outcome).toBe('ok');
      expect(body.timezone).toBe('Asia/Singapore');
    });
  });
});

describe('GET /api/peak-hours — the no-half-wired pin', () => {
  it('answers the scope catch-all 404 when the options are absent', async () => {
    await withPeakHoursApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: peakHoursUrl() });
        expect(response.statusCode).toBe(404);
        const error = (response.json() as { error: { code: string } }).error;
        expect(error.code).toBe('NOT_FOUND');
      },
      { wired: false },
    );
  });
});
