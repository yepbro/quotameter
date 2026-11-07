import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuotameterApp } from '../../src/server/app';
import { composeApplication } from '../../src/server/composition';
import type { ComposedApplication } from '../../src/server/composition';
import { configFilePath } from '../../src/config/load';
import { writeConfigFile } from '../../src/config/write';
import { ZaiCodingPlanProvider } from '../../src/providers/zai-coding-plan/provider';
import type { Clock } from '../../src/util/clock';
import type { PollingSleep } from '../../src/services/polling-scheduler';
import { TransportAbortError } from '../../src/providers/transport';
import type { CollectionRunRecord, QuotaRepository } from '../../src/storage/repository';
import { createQuotaRepository } from '../../src/storage/repository';
import { openStorageConnection } from '../../src/storage/connection';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { startMockProviderServer, type MockProviderServer } from '../helpers/mockProviderServer';
import { withTempDir } from '../helpers/isolation';

/**
 * The U-051 done-condition, executable end to end: the production
 * composition — `composeApplication`, the same construction `runServer`
 * assembles — now POLLS. The real `ZaiCodingPlanProvider` runs real HTTP
 * against the loopback mock provider server, the polling engine dispatches
 * §7.1's immediate first poll and the scheduled subsequent polls, cycles
 * persist through the real recorder into `collection_runs`/`snapshots`, the
 * §7.2 retry/`Retry-After`/suspension machinery runs live, §6.4 reloads
 * feed the engine through the composition's reload wrapper, and §5.6's
 * shutdown drains an aborted cycle. No production seam is doubled: the only
 * test-owned boundary is the provider's HTTP endpoint (the no-network
 * guard's rule) plus time itself.
 *
 * **Time compression.** §7.1's interval floor is 60 seconds — a real-time
 * "scheduled subsequent poll" would put a single test over a minute. The
 * suite therefore injects a clock whose BOTH readings scale by
 * {@link TIME_SCALE} (durations stay consistent: dues, gates, suspension
 * windows, and the adapter's `collectedAt` all live in scaled units — the
 * status freshness arithmetic compares like with like) and, through the
 * composition's `pollingSleep` test seam, a sleep that divides by the same
 * factor: a 60-second interval elapses in 3 real seconds, the §7.3 fresh
 * window (3 intervals) in 9, a 60-minute suspension window in 180. Every
 * wait is deadline-based against observable evidence (repository rows, API
 * bodies, mock requests): parallel load can only delay a poll past its due,
 * never advance it, so the assertions are load-uninvertible in the D-087
 * sense; the waits that assert ABSENCE inside a gate sit strictly inside it.
 */

/** The time-compression factor: scaled units per real millisecond. */
const TIME_SCALE = 20;

/** The §7.1 interval under test (its floor), in (scaled) seconds. */
const INTERVAL_SECONDS = 60;

/** The same interval as the test experiences it, in real milliseconds. */
const INTERVAL_REAL_MS = (INTERVAL_SECONDS * 1000) / TIME_SCALE;

/** The §15.4 marker secret — carried by the polled context, never leaked. */
const MARKER_KEY = 'sk-marker-composition-polling-9d31';

/** A second marker (the added account's key). */
const MARKER_KEY_2 = 'sk-marker-composition-polling-4d7a';

/** The dossier endpoint paths, as the adapter composes them. */
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const RESET_PATH = '/api/biz/customer-package-reset/list?targetType=PERSONAL';
const CREDENTIALS_PATH = '/models';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const SANITIZED_QUOTA = fixture('sanitized/zai-quota-limit.json');
const SANITIZED_SUBSCRIPTION = fixture('sanitized/zai-subscription-list.json');
const SANITIZED_RESET = fixture('sanitized/zai-customer-package-reset-list.json');

/* ── Time compression ────────────────────────────────────────────────────── */

/** A clock whose both readings advance TIME_SCALE units per real ms. */
function createScaledClock(): Clock {
  return {
    now: () => Date.now() * TIME_SCALE,
    monotonicMs: () => performance.now() * TIME_SCALE,
  };
}

/**
 * The compressed wait: resolves after `ms` scaled units (`ms / TIME_SCALE`
 * real ms), rejecting with the scheduler's documented abort error — the
 * `pollingSleep` seam, in the scheduler's own default-sleep shape.
 */
const scaledSleep: PollingSleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new TransportAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TransportAbortError());
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

/** Resolves once `predicate(read())` holds; rejects at the deadline. */
async function waitUntil(
  label: string,
  timeoutMs: number,
  read: () => number,
  predicate: (value: number) => boolean,
): Promise<number> {
  return waitFor(label, timeoutMs, () => {
    const value = read();
    return predicate(value) ? value : undefined;
  });
}

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ── The harness ─────────────────────────────────────────────────────────── */

/** Routes the healthy dossier trio (the sanitized fixtures) on the mock. */
function routeHealthyOn(mock: MockProviderServer): void {
  mock.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 200, body: SANITIZED_QUOTA });
  mock.setPathBehavior(SUBSCRIPTION_PATH, {
    kind: 'respond',
    status: 200,
    body: SANITIZED_SUBSCRIPTION,
  });
  mock.setPathBehavior(RESET_PATH, { kind: 'respond', status: 200, body: SANITIZED_RESET });
}

/** What one polled world hands the test body. */
interface PolledWorld {
  readonly composed: ComposedApplication;
  readonly repository: QuotaRepository;
  readonly mock: MockProviderServer;
  readonly sink: MemoryLogSink;
  /** The §6.1 data directory — the post-stop database reopen reads it. */
  readonly dataDir: string;
  /** Routes the healthy trio (the sanitized fixtures) on the mock. */
  routeHealthy(): void;
  /** Injects against the real Fastify instance (no sockets). */
  inject(
    method: string,
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string; json(): unknown }>;
  /** Stops the application mid-test (the §5.6 path; idempotent). */
  stop(): Promise<void>;
}

/** Composes, starts, runs the body, and stops the polled application. */
async function withPolledApp(
  config: Record<string, unknown>,
  body: (world: PolledWorld) => Promise<void>,
  beforeStart?: (mock: MockProviderServer) => void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const configDir = join(dir.path, 'config');
    const dataDir = join(dir.path, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeConfigFile(configFilePath(configDir), config);

    const sink = createMemoryLogSink();
    const clock = createScaledClock();
    const mock = await startMockProviderServer();
    const adapter = new ZaiCodingPlanProvider({
      codingBaseUrl: mock.url,
      apiBaseUrl: mock.url,
      timeoutMs: 5_000,
      clock,
    });
    let app: QuotameterApp | undefined;
    let stopped = false;
    try {
      const composed = await composeApplication({
        env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir },
        clock,
        logger: createLogger({
          level: 'debug',
          destination: sink,
          secrets: [MARKER_KEY, MARKER_KEY_2],
        }),
        providers: [adapter],
        port: 0,
        pollingSleep: scaledSleep,
      });
      app = new QuotameterApp({ components: composed.components });
      // §7.1: the first poll is immediate — provider routing (and any
      // refusal scripting) must be in place BEFORE the component starts.
      beforeStart?.(mock);
      await app.start();
      const world: PolledWorld = {
        composed,
        repository: composed.repository,
        mock,
        sink,
        dataDir,
        routeHealthy: () => routeHealthyOn(mock),
        inject: (method, url, payload) =>
          composed.httpServer.server.inject({
            method,
            url,
            headers: {
              // §15.3: every mutation carries the dedicated header; a bodied
              // one adds the JSON content type.
              ...(method === 'GET' || method === 'HEAD'
                ? {}
                : { 'x-quotameter-request': 'polling-suite' }),
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
      await mock.close();
    }
  });
}

/** The runs of one account, `started_at`-ascending. */
const runsOf = (repository: QuotaRepository, accountId: string): readonly CollectionRunRecord[] =>
  repository.listCollectionRuns(accountId);

/** Resolves once the account holds at least `count` persisted runs. */
const waitRuns = (
  world: PolledWorld,
  accountId: string,
  count: number,
  timeoutMs: number,
): Promise<readonly CollectionRunRecord[]> =>
  waitFor(`${accountId} runs >= ${count}`, timeoutMs, () => {
    const runs = runsOf(world.repository, accountId);
    return runs.length >= count ? runs : undefined;
  });

/** The §15.4 marker scan: key material is in no log line and no body. */
const expectMarkersAbsent = (world: PolledWorld, bodies: readonly string[]): void => {
  const logs = world.sink.lines().join('\n');
  expect(logs, 'the marker key never appears in a log line').not.toContain(MARKER_KEY);
  expect(logs, 'the second marker never appears in a log line').not.toContain(MARKER_KEY_2);
  for (const [index, body] of bodies.entries()) {
    expect(body, `response body ${index} carries no marker key`).not.toContain(MARKER_KEY);
    expect(body, `response body ${index} carries no second marker`).not.toContain(MARKER_KEY_2);
  }
};

/** The §7.3 status token of one account, read through the real API. */
async function statusOf(world: PolledWorld, accountId: string): Promise<string> {
  const response = await world.inject('GET', '/api/status');
  expect(response.statusCode).toBe(200);
  const accounts = (response.json() as { accounts: { id: string; status: string }[] }).accounts;
  const row = accounts.find((account) => account.id === accountId);
  if (row === undefined) throw new Error(`no status row for '${accountId}'`);
  return row.status;
}

/* ── The done-condition ──────────────────────────────────────────────────── */

describe('the composed polling engine (U-051, D-176)', () => {
  const polledConfig = {
    app: { timezone: 'UTC', pollingIntervalSeconds: INTERVAL_SECONDS },
    accounts: [
      { id: 'poll-me', providerId: 'zai-coding-plan', label: 'Polled', apiKey: MARKER_KEY },
    ],
  };

  it(
    'runs the first collection immediately after startup and persists the cycle (§7.1/§11.1)',
    { timeout: 30_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          const runs = await waitRuns(world, 'poll-me', 1, 15_000);

          // One successful cycle: the run row and its snapshot, with the
          // evidence §11.2 pins — real wall stamps, the live configuration's
          // interval, one attempt, the delivered 2xx.
          expect(runs).toHaveLength(1);
          const run = runs[0]!;
          expect(run.outcome).toBe('success');
          expect(run.attempts).toBe(1);
          expect(run.httpStatus).toBe(200);
          expect(run.intervalSeconds).toBe(INTERVAL_SECONDS);
          expect(run.retryAfterSeconds).toBeNull();
          const snapshot = world.repository.getSnapshotByRun(run.id);
          expect(snapshot).not.toBeNull();
          expect(world.repository.getLatestSnapshot('poll-me')?.planName).toBe('pro');

          // The real adapter made the dossier trio with the resolved secret —
          // the AccountContext carried the configured key (§8.1).
          const urls = world.mock.requests.map((request) => request.url);
          expect(urls).toEqual([QUOTA_PATH, SUBSCRIPTION_PATH, RESET_PATH]);
          const authorization = world.mock.requests[0]!.headers.authorization;
          expect(String(authorization)).toBe(`Bearer ${MARKER_KEY}`);

          // Observable through the API: §7.3's Fresh and §13's quota metrics.
          expect(await statusOf(world, 'poll-me')).toBe('fresh');
          const quota = await world.inject('GET', '/api/quota?accountId=poll-me');
          expect(quota.statusCode).toBe(200);
          const metrics = (quota.json() as { metrics: { metricKey: string }[] }).metrics.map(
            (metric) => metric.metricKey,
          );
          expect([...metrics].sort()).toEqual(['mcp-monthly', 'tokens-5h']);
          expectMarkersAbsent(world, [quota.body]);
        },
        routeHealthyOn,
      );
    },
  );

  it(
    'schedules the subsequent polls with no external kick (§7.1)',
    { timeout: 60_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          await waitRuns(world, 'poll-me', 1, 15_000);
          // The interval plus jitter elapses in 3.0–3.3 real seconds; the
          // deadline carries several intervals of load margin (D-087).
          const runs = await waitRuns(world, 'poll-me', 3, 30_000);

          const [first, second, third] = runs;
          for (const run of [first, second, third]) expect(run?.outcome).toBe('success');
          // Monotonic dues: each inter-poll gap is at least the configured
          // interval (scaled), and §7.1 backfills nothing.
          expect(second!.startedAt - first!.startedAt).toBeGreaterThanOrEqual(
            INTERVAL_SECONDS * 1000,
          );
          expect(third!.startedAt - second!.startedAt).toBeGreaterThanOrEqual(
            INTERVAL_SECONDS * 1000,
          );
          expect(world.mock.requests.length).toBe(9);
        },
        routeHealthyOn,
      );
    },
  );

  it(
    'feeds account and interval changes through the reload wrapper (§6.4)',
    { timeout: 90_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          await waitRuns(world, 'poll-me', 1, 15_000);

          // An interval change re-anchors the schedule; the next cycle's run
          // row carries the new interval (the recorder's live reader).
          const put = await world.inject('PUT', '/api/settings', {
            app: { pollingIntervalSeconds: 90 },
          });
          expect(put.statusCode).toBe(200);
          const intervalChange = await waitFor('a run recorded at interval 90', 40_000, () =>
            runsOf(world.repository, 'poll-me').find((run) => run.intervalSeconds === 90),
          );
          expect(intervalChange.outcome).toBe('success');

          // An added account polls immediately (§7.1's per-account restart).
          const added = await world.inject('POST', '/api/accounts', {
            id: 'added-later',
            providerId: 'zai-coding-plan',
            label: 'Added later',
            apiKey: MARKER_KEY_2,
          });
          expect(added.statusCode).toBe(201);
          await waitRuns(world, 'added-later', 1, 15_000);
          expect(runsOf(world.repository, 'added-later')[0]!.outcome).toBe('success');

          // A disabled account stops polling while the engine keeps serving
          // the enabled one — the differential makes the freeze observable.
          const disabled = await world.inject('PATCH', '/api/accounts/poll-me', {
            enabled: false,
          });
          expect(disabled.statusCode).toBe(200);
          await sleepReal(INTERVAL_REAL_MS * 1.5); // any in-flight cycle settles
          const frozenAt = runsOf(world.repository, 'poll-me').length;
          await waitUntil(
            'added-later keeps polling while poll-me is disabled',
            40_000,
            () => runsOf(world.repository, 'added-later').length,
            (value) => value >= 2,
          );
          expect(runsOf(world.repository, 'poll-me')).toHaveLength(frozenAt);

          // Re-enabling resumes with an immediate first poll (a fresh entry).
          const enabled = await world.inject('PATCH', '/api/accounts/poll-me', {
            enabled: true,
          });
          expect(enabled.statusCode).toBe(200);
          await waitUntil(
            'poll-me resumes',
            20_000,
            () => runsOf(world.repository, 'poll-me').length,
            (value) => value > frozenAt,
          );
          expectMarkersAbsent(world, [put.body, added.body, disabled.body, enabled.body]);
        },
        routeHealthyOn,
      );
    },
  );

  it(
    'defers the next poll after a 429 and persists the deferral evidence (§7.2)',
    { timeout: 60_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          // The cycle's first GET is refused with a Retry-After.
          const runs = await waitRuns(world, 'poll-me', 1, 15_000);
          const refused = runs[0]!;
          expect(refused.outcome).toBe('rate_limited');
          expect(refused.attempts).toBe(1); // no retry within the cycle
          expect(refused.retryAfterSeconds).toBe(120);

          // The gate: 120 scaled seconds = 6 real seconds. Strictly inside it
          // no new cycle can start (load only delays a poll, never advances
          // it); healthy routing is restored first so the post-gate cycle
          // succeeds.
          world.routeHealthy();
          await sleepReal(2_500);
          expect(runsOf(world.repository, 'poll-me')).toHaveLength(1);

          // After the gate opens, the schedule resumes.
          const resumed = await waitRuns(world, 'poll-me', 2, 30_000);
          expect(resumed[1]!.outcome).toBe('success');
        },
        (mock) => {
          mock.setPathBehavior(QUOTA_PATH, {
            kind: 'respond',
            status: 429,
            headers: { 'retry-after': '120' },
          });
        },
      );
    },
  );

  it(
    'suspends after a polled 401, shows Auth rejected, and lifts on the manual test (§7.2)',
    { timeout: 60_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          const runs = await waitRuns(world, 'poll-me', 1, 15_000);
          expect(runs[0]!.outcome).toBe('auth_error');

          // The holder — the /api/status seam — learned the polled verdict
          // (the settle wrapper's feed): rank 1 of §7.3.
          expect(await statusOf(world, 'poll-me')).toBe('auth-rejected');

          // The manual test's release reaches the ENGINE through the
          // observation bridge: one owed attempt, dispatched immediately,
          // against healthy routing — and its success lifts the pause.
          world.routeHealthy();
          world.mock.setPathBehavior(CREDENTIALS_PATH, {
            kind: 'respond',
            status: 200,
            body: '{"data":[]}',
          });
          const test = await world.inject('POST', '/api/accounts/poll-me/test');
          expect(test.statusCode).toBe(200);
          expect((test.json() as { outcome: string }).outcome).toBe('ok');
          const recovered = await waitRuns(world, 'poll-me', 2, 20_000);
          expect(recovered[1]!.outcome).toBe('success');
          expect(await statusOf(world, 'poll-me')).toBe('fresh');
          expectMarkersAbsent(world, [test.body]);
        },
        (mock) => {
          mock.setPathBehavior(QUOTA_PATH, { kind: 'respond', status: 401, body: '{}' });
        },
      );
    },
  );

  it(
    'shuts down cleanly mid-cycle: the aborted attempt persists nothing (§5.6/D-069)',
    { timeout: 60_000 },
    async () => {
      await withPolledApp(
        polledConfig,
        async (world) => {
          await waitRuns(world, 'poll-me', 1, 15_000);

          // The next cycle hangs in the provider (a delayed response past
          // the shutdown), so stop() aborts a genuinely in-flight attempt.
          world.mock.setPathBehavior(QUOTA_PATH, {
            kind: 'respond',
            status: 200,
            body: SANITIZED_QUOTA,
            delayMs: 4_000,
          });
          await waitFor('the second cycle is in flight', 15_000, () =>
            world.mock.requests.length >= 4 ? true : undefined,
          );
          const before = runsOf(world.repository, 'poll-me').length;

          // §5.6's sequence through the composed components: the listener
          // closes, the engine stops scheduling and aborts the flight, the
          // drain (bounded at ten real seconds) waits for its settlement —
          // classified 'cancelled', deliberately unpersisted (D-069) — and
          // storage checkpoints and closes behind it. The stop resolving is
          // the whole assertion: no hang, no leaked timer.
          await world.stop();

          // After the lifecycle the storage component is closed — the lazy
          // facade answers its wiring error — so the evidence read reopens
          // the checkpointed database the §5.6 path left behind.
          const connection = openStorageConnection({ dataDir: world.dataDir });
          const repository = createQuotaRepository({ database: connection.database });
          try {
            const runs = repository.listCollectionRuns('poll-me');
            expect(runs).toHaveLength(before);
            expect(runs[0]!.outcome).toBe('success');
          } finally {
            connection.close();
          }
        },
        routeHealthyOn,
      );
    },
  );
});
