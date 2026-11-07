import { mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import type { Clock } from '../../src/util/clock';
import type { RetentionSleep } from '../../src/server/retention';
import {
  RETENTION_APPLIED_DAYS_KEY,
  RETENTION_LAST_RUN_KEY,
} from '../../src/storage/retention-cleanup';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { openStorageConnection } from '../../src/storage/connection';
import {
  persistCollectionCycle,
  type SuccessfulCollectionCycle,
} from '../../src/storage/collection-cycles';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The U-053 done-condition, executable end to end: the production
 * composition — `composeApplication`, the same construction `runServer`
 * assembles — now SCHEDULES §11.3's cleanup. The startup run deletes
 * expired history over a real pre-seeded database (strictly after the
 * migrations the storage component ran), the daily cadence re-runs it
 * (newly expired rows go), and a §6.4 retention reduction applied through
 * the REAL settings PUT takes effect at the next cleanup — the marker and
 * `GET /api/settings`'s `appliedRetentionDays` narrating the whole
 * sequence: 180 while the reduced window is merely configured, 30 once
 * the next cleanup applied it (the UI warning's exact lifecycle). §5.6's
 * stop cancels the schedule. No production seam is doubled: the only
 * test-owned boundary is time itself.
 *
 * **Time compression** (the polling suite's pattern, D-176/D-087): §11.3's
 * daily cadence makes a real-time second cleanup unfit for the test gate,
 * so the suite injects a clock whose wall reading scales by
 * {@link TIME_SCALE} and, through the composition's `retentionSleep` test
 * seam, a sleep that divides by the same factor — one day elapses in
 * ~4.3 real seconds. Every wait is deadline-based against observable
 * evidence (repository rows, meta markers, API bodies): parallel load can
 * only delay a cleanup past its due, never advance it. The one
 * absence-asserting wait (no run after stop) sits strictly inside the
 * half-day gate.
 */

/** The time-compression factor: scaled units per real millisecond. */
const TIME_SCALE = 20_000;

/** One scaled day as the test experiences it, in real milliseconds. */
const DAY_REAL_MS = 86_400_000 / TIME_SCALE;

/** A §11.3 window the whole suite runs with at startup (§11.3's default). */
const STARTUP_RETENTION_DAYS = 180;

/** The §6.4-reduced window the settings PUT installs mid-test. */
const REDUCED_RETENTION_DAYS = 30;

/* ── Time compression ────────────────────────────────────────────────────── */

/**
 * The fixed wall-clock base the scaled clock reads — a §11.1-scale epoch
 * (2025-10-20T22:40:00Z). The scale factor is applied to ELAPSED real
 * time, not to the current date: `Date.now() × 20 000` overflows the
 * safe-integer range SQLite's driver accepts (§11.1 stores epoch
 * milliseconds), while `BASE + elapsed × 20 000` stays §11.1-scale
 * forever.
 */
const CLOCK_BASE_EPOCH = 1_761_000_000_000;

/** A clock whose wall reading advances TIME_SCALE units per real ms. */
function createScaledClock(): Clock {
  const startedReal = Date.now();
  return {
    now: () => CLOCK_BASE_EPOCH + (Date.now() - startedReal) * TIME_SCALE,
    monotonicMs: () => performance.now() * TIME_SCALE,
  };
}

/**
 * The compressed wait — the `retentionSleep` seam: resolves after `ms`
 * scaled units (`ms / TIME_SCALE` real ms); on abort it rejects with a
 * plain error, which the schedule treats as its designed exit (the abort
 * is the fact, not the error's class).
 */
const scaledSleep: RetentionSleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('retention wait aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('retention wait aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms / TIME_SCALE);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/* ── Deadline-based waiting on observable evidence ───────────────────────── */

/** Resolves once `probe` returns a defined value; rejects at the deadline. */
async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ── The seeded history ──────────────────────────────────────────────────── */

/**
 * The seeded ages, in days before the seed moment: a run already expired
 * at startup (200 > 180), one that expires only after the first scaled
 * day (179.5), one that dies only at the reduced window's cleanup (100 >
 * 30), and one that survives everything (20 < 30).
 */
const AGES_DAYS = {
  expiredAtStartup: 200,
  expiresAfterFirstDay: 179.5,
  diesAtReducedWindow: 100,
  survives: 20,
} as const;

/** A successful cycle for `retained`, aged `ageDays` before `now`. */
function runAged(now: number, ageDays: number): SuccessfulCollectionCycle {
  const startedAt = now - ageDays * 86_400_000;
  return {
    accountId: 'retained',
    startedAt,
    endedAt: startedAt + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: startedAt + 1_200,
      planName: 'Pro',
      metrics: [
        {
          metricKey: 'monthly-credits',
          limitType: 'MONTHLY',
          unit: 'CREDITS',
          windowSeconds: null,
          used: 80,
          remaining: 20,
          limit: 100,
          percentUsed: 80,
          percentRemaining: 20,
          resetsAt: startedAt + 86_400_000,
          isValid: true,
          invalidReason: null,
          derivedFields: null,
        },
      ],
      events: [],
    },
  };
}

/**
 * Seeds the data directory's database through the production connection
 * and the canonical migrations — the world the composed service will open
 * — and returns the scaled clock reading the ages are anchored to.
 */
async function seedHistory(dataDir: string, clock: Clock): Promise<number> {
  // The composition's LOCK creates the data directory at its start
  // (D-017); seeding runs before that, so the directory is the seed's own
  // responsibility.
  await mkdir(dataDir, { recursive: true });
  const connection = openStorageConnection({ dataDir });
  try {
    await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database: connection.database });
    repository.insertAccount({
      id: 'retained',
      providerId: 'zai-coding-plan',
      label: 'Retained plan',
      createdAt: 1_700_000_000_000,
    });
    const now = clock.now();
    for (const age of Object.values(AGES_DAYS)) {
      persistCollectionCycle(repository, runAged(now, age));
    }
    return now;
  } finally {
    connection.close();
  }
}

/** Whether the run aged `ageDays` before `seedNow` is still present. */
const runAgedPresent = (repository: QuotaRepository, seedNow: number, ageDays: number): boolean => {
  const startedAt = seedNow - ageDays * 86_400_000;
  return repository.listCollectionRuns('retained').some((run) => run.startedAt === startedAt);
};

/* ── The harness ─────────────────────────────────────────────────────────── */

/** What one composed-retention world hands the test body. */
interface RetentionWorld {
  readonly composed: ComposedApplication;
  readonly repository: QuotaRepository;
  readonly sink: MemoryLogSink;
  /** The scaled-clock reading the seeded ages are anchored to. */
  readonly seedNow: number;
  /** The §6.1 data directory — post-stop reopens read it. */
  readonly dataDir: string;
  /**
   * Reads from a FRESH connection over the data directory — the §5.6
   * post-stop shape (the lazy facade answers a wiring error once storage
   * has stopped).
   */
  readAfterStop<T>(read: (repository: QuotaRepository) => T): T;
  /** Injects against the real Fastify instance (no sockets). */
  inject(
    method: string,
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string; json(): unknown }>;
  /** Stops the application (idempotent). */
  stop(): Promise<void>;
}

/**
 * Seeds the data directory, composes, starts, runs the body, and stops —
 * the composition-polling harness's shape, with no accounts configured
 * (the polling engine is inert) and no provider registered (nothing can
 * reach the network).
 */
async function withRetentionApp(body: (world: RetentionWorld) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    const configDir = join(dir.path, 'config');
    const dataDir = join(dir.path, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeConfigFile(configFilePath(configDir), {
      app: { timezone: 'UTC', historyRetentionDays: STARTUP_RETENTION_DAYS },
      // §16/D-023: every successful reload applies the file's logging
      // level — the suite asserts post-reload records (the second daily
      // cleanup's, the GETs'), so the file must carry the sink's level
      // instead of letting the reload reset it to the default 'warn'.
      logging: { level: 'debug' },
    });
    const seedClock = createScaledClock();
    const seedNow = await seedHistory(dataDir, seedClock);

    const sink = createMemoryLogSink();
    const clock = seedClock;
    let app: QuotameterApp | undefined;
    let stopped = false;
    try {
      const composed = await composeApplication({
        env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir },
        clock,
        logger: createLogger({ level: 'debug', destination: sink }),
        providers: [],
        port: 0,
        retentionSleep: scaledSleep,
      });
      app = new QuotameterApp({ components: composed.components });
      await app.start();
      const world: RetentionWorld = {
        composed,
        repository: composed.repository,
        sink,
        seedNow,
        dataDir,
        readAfterStop(read) {
          const connection = openStorageConnection({ dataDir });
          try {
            return read(createQuotaRepository({ database: connection.database }));
          } finally {
            connection.close();
          }
        },
        inject: (method, url, payload) =>
          composed.httpServer.server.inject({
            method,
            url,
            headers: {
              // §15.3: every mutation carries the dedicated header; a bodied
              // one adds the JSON content type.
              ...(method === 'GET' || method === 'HEAD'
                ? {}
                : { 'x-quotameter-request': 'retention-suite' }),
              ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(payload === undefined ? {} : { payload }),
          }),
        async stop(): Promise<void> {
          if (app === undefined || stopped) return;
          stopped = true;
          await app.stop();
        },
      };
      await body(world);
    } finally {
      await app?.stop().catch(() => undefined);
    }
  });
}

/** `GET /api/settings`'s applied retention days, through the real API. */
async function appliedRetentionDays(world: RetentionWorld): Promise<number | null> {
  const response = await world.inject('GET', '/api/settings');
  expect(response.statusCode, `GET /api/settings answered: ${response.body}`).toBe(200);
  return (response.json() as { appliedRetentionDays: number | null }).appliedRetentionDays;
}

/* ── The done-condition ──────────────────────────────────────────────────── */

describe('the composed retention schedule (U-053, D-178)', () => {
  it(
    'runs the startup cleanup after the migrations and exposes the applied window',
    { timeout: 30_000 },
    async () => {
      await withRetentionApp(async (world) => {
        // §11.3's startup run, strictly after the storage component's
        // migrations (a seeded final-schema world): the 200-day-old run
        // went, everything younger survived.
        expect(runAgedPresent(world.repository, world.seedNow, AGES_DAYS.expiredAtStartup)).toBe(
          false,
        );
        expect(
          runAgedPresent(world.repository, world.seedNow, AGES_DAYS.expiresAfterFirstDay),
        ).toBe(true);
        expect(runAgedPresent(world.repository, world.seedNow, AGES_DAYS.diesAtReducedWindow)).toBe(
          true,
        );
        expect(runAgedPresent(world.repository, world.seedNow, AGES_DAYS.survives)).toBe(true);
        // §11.2's cleanup metadata — the reduce-retention warning's data.
        expect(world.repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY)).toBe(
          String(STARTUP_RETENTION_DAYS),
        );
        expect(world.repository.getMetaValue(RETENTION_LAST_RUN_KEY)).not.toBeNull();
        // The settings surface carries the applied window (§11.3/D-178).
        await expect(appliedRetentionDays(world)).resolves.toBe(STARTUP_RETENTION_DAYS);
        // §16: the startup run is an info lifecycle record.
        expect(
          world.sink
            .records()
            .find(
              (record) =>
                typeof record.msg === 'string' &&
                record.msg.startsWith('retention cleanup completed'),
            ),
        ).toMatchObject({ phase: 'startup', retentionDays: STARTUP_RETENTION_DAYS });
        await world.stop();
      });
    },
  );

  it(
    're-runs daily, and a §6.4 reduction applied through the settings PUT lands at the next cleanup',
    { timeout: 60_000 },
    async () => {
      await withRetentionApp(async (world) => {
        // The first scaled day: the 179.5-day-old run crosses the 180-day
        // window and the daily cleanup takes it — no external kick.
        await waitFor('the 179.5-day run to be deleted by the first daily cleanup', 20_000, () =>
          runAgedPresent(world.repository, world.seedNow, AGES_DAYS.expiresAfterFirstDay)
            ? undefined
            : 'gone',
        );

        // The operator reduces retention through the REAL §6.4 surface.
        const put = await world.inject('PUT', '/api/settings', {
          app: { historyRetentionDays: REDUCED_RETENTION_DAYS },
        });
        expect(put.statusCode, `PUT /api/settings answered: ${put.body}`).toBe(200);
        // §11.3's warning window: the applied window still names the last
        // COMPLETED cleanup — 180, not the newly configured 30.
        await expect(appliedRetentionDays(world)).resolves.toBe(STARTUP_RETENTION_DAYS);

        // The next daily run applies the reduced window: the 100-day-old
        // run goes, the 20-day-old one stays, the marker flips.
        await waitFor('the 100-day run to be deleted by the reduced-window cleanup', 20_000, () =>
          runAgedPresent(world.repository, world.seedNow, AGES_DAYS.diesAtReducedWindow)
            ? undefined
            : 'gone',
        );
        expect(runAgedPresent(world.repository, world.seedNow, AGES_DAYS.survives)).toBe(true);
        expect(world.repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY)).toBe(
          String(REDUCED_RETENTION_DAYS),
        );
        // The warning's self-clearing arm: the surface now names 30.
        await expect(appliedRetentionDays(world)).resolves.toBe(REDUCED_RETENTION_DAYS);
        // The daily phase is narrated in order: startup, then dailies.
        expect(
          world.sink
            .records()
            .filter(
              (record) =>
                typeof record.msg === 'string' &&
                record.msg.startsWith('retention cleanup completed'),
            )
            .map((record) => record.phase),
        ).toEqual(['startup', 'daily', 'daily']);
        await world.stop();
      });
    },
  );

  it(
    'stop cancels the schedule — no cleanup after §5.6 shutdown',
    { timeout: 30_000 },
    async () => {
      await withRetentionApp(async (world) => {
        const lastRunAtStart = world.repository.getMetaValue(RETENTION_LAST_RUN_KEY);
        expect(lastRunAtStart).not.toBeNull();
        await world.stop();
        // Strictly inside the half-day gate: the next daily due is a full
        // scaled day (DAY_REAL_MS) after the startup run; the marker must
        // not move in this window. Read from a fresh §5.6 reopen — the
        // composed facade is closed with the app.
        await sleepReal(DAY_REAL_MS / 2);
        expect(
          world.readAfterStop((repository) => repository.getMetaValue(RETENTION_LAST_RUN_KEY)),
        ).toBe(lastRunAtStart);
        expect(
          world.readAfterStop((repository) =>
            runAgedPresent(repository, world.seedNow, AGES_DAYS.expiresAfterFirstDay),
          ),
        ).toBe(true);
      });
    },
  );
});
