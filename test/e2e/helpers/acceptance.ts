import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotameterApp } from '../../../src/server/app';
import { composeApplication } from '../../../src/server/composition';
import { resolveUiDistDir } from '../../../src/server/http';
import { configFilePath } from '../../../src/config/load';
import { writeConfigFile } from '../../../src/config/write';
import { ZaiCodingPlanProvider } from '../../../src/providers/zai-coding-plan/provider';
import type { AccountContext, QuotaProvider } from '../../../src/providers/registry';
import { persistCollectionCycle } from '../../../src/storage/collection-cycles';
import type {
  CollectionCycleWrite,
  CycleMetricInput,
} from '../../../src/storage/collection-cycles';
import type { QuotaRepository } from '../../../src/storage/repository';
import type { RunOutcome } from '../../../src/storage/repository';
import { detectCycleResetEvents } from '../../../src/services/events-cycle';
import type { NormalizedMetric, ProviderSnapshot } from '../../../src/schemas/metrics';
import { createLogger } from '../../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../../helpers/logSink';
import { startMockProviderServer, type MockProviderServer } from '../../helpers/mockProviderServer';

/**
 * The task-183 acceptance harness (spec §17.1, §14): the §17.1 acceptance
 * scenarios run against the production Vite build served by the REAL server
 * construction — `composeApplication` (the assembly `runServer` builds
 * through `buildApplication()`) started as a `QuotameterApp` on an ephemeral
 * loopback port, with the REAL Z.ai adapter registered and pointed at the
 * task-026 loopback mock provider server through the adapter's own base-URL
 * seams. Every scenario the suite asserts is therefore the production path:
 * the built bundle's pages, the real guards (§15.3 Origin/custom-header,
 * §15.1 auth mode, Host allowlist), the real stores over a real migrated
 * `node:sqlite` database, and the real credential check reaching the mock's
 * `/models` — exactly "the built package and mock provider" the done-
 * condition names, with no real network anywhere (the only outbound traffic
 * is the adapter's loopback requests; the browser stays same-origin behind
 * the served CSP `connect-src 'self'`).
 *
 * Differences from the Vitest `composedApi` harness (deliberate, both ways):
 * this module must run inside Playwright workers, so it owns a vitest-free
 * temp-directory lifecycle (`test/helpers/isolation.ts` imports vitest), and
 * it anchors every seeded timestamp to the REAL current time — §7.3 statuses
 * derive against the server's clock while the browser's rolling ranges and
 * relative times anchor on its own, so a fixed clock would fight one of the
 * two; seeding relative to `Date.now()` keeps both coherent and the
 * assertions deterministic (every age used sits far from its boundary).
 *
 * Isolation: one world per spec file (`test.describe.configure({ mode:
 * 'serial' })` keeps a file's tests on one worker, so its `beforeAll`
 * server serves exactly those tests — the a11y file deliberately starts a
 * second, password-mode world for its login-page scan) over unique temp
 * directories and ephemeral ports — the same world-per-suite model as the
 * sweep harness.
 */

/** The §15.4 marker secret of the acceptance worlds — never DOM, never logs. */
export const ACCEPTANCE_MARKER_KEY = 'sk-acceptance-marker-3f9c21';

/** The §15.2 password of the password-protected acceptance world. */
export const ACCEPTANCE_PASSWORD = 'acceptance-password-17';

/** One §8.4 metric of a seeded snapshot, over the real catalog's keys. */
export function seededMetric(
  key: string,
  overrides: Partial<NormalizedMetric> = {},
): NormalizedMetric {
  return {
    key,
    label: key,
    limitType: 'MONTHLY',
    // The real adapter's own unit per key (`mcp-monthly` is the
    // fixed-unit REQUESTS identity; the by-fields keys read CREDITS when
    // absolutes arrive) — the seeded worlds stay shapes the adapter can
    // genuinely emit.
    unit: key === 'mcp-monthly' ? 'REQUESTS' : 'CREDITS',
    used: 40,
    remaining: 60,
    limit: 100,
    percentUsed: 40,
    percentRemaining: 60,
    isValid: true,
    ...overrides,
  };
}

/** The storage row input of one seeded metric (absent fields as nulls). */
function metricRowInput(metric: NormalizedMetric): CycleMetricInput {
  return {
    metricKey: metric.key,
    limitType: metric.limitType,
    unit: metric.unit,
    windowSeconds: metric.windowSeconds ?? null,
    used: metric.used ?? null,
    remaining: metric.remaining ?? null,
    limit: metric.limit ?? null,
    percentUsed: metric.percentUsed ?? null,
    percentRemaining: metric.percentRemaining ?? null,
    resetsAt: metric.resetsAt ?? null,
    isValid: metric.isValid,
    invalidReason: metric.invalidReason ?? null,
    derivedFields: null,
  };
}

/**
 * Seeds one successful cycle as the polling pipeline would (task 118's
 * composition): the §12.1 reset detection reads BEFORE the atomic write, so
 * a usage drop between the stored past and this snapshot persists a genuine
 * reset event — the marker the §14.4 charts render.
 */
export function seedSuccessCycle(
  repository: QuotaRepository,
  accountId: string,
  collectedAt: number,
  metrics: ReadonlyArray<NormalizedMetric>,
  options: { intervalSeconds?: number; planName?: string } = {},
): void {
  const snapshot: ProviderSnapshot = {
    providerId: 'zai-coding-plan',
    collectedAt,
    planName: options.planName ?? 'Acceptance Pro',
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
      planName: options.planName ?? 'Acceptance Pro',
      metrics: metrics.map(metricRowInput),
      events,
    },
  } satisfies CollectionCycleWrite);
}

/** Seeds one failed cycle — the run row only, no snapshot (§11.2). */
export function seedFailedCycle(
  repository: QuotaRepository,
  accountId: string,
  startedAt: number,
  outcome: Exclude<RunOutcome, 'success'>,
  evidence: { httpStatus?: number; errorMessage?: string; attempts?: number } = {},
): void {
  persistCollectionCycle(repository, {
    accountId,
    startedAt,
    endedAt: startedAt + 2_500,
    intervalSeconds: 300,
    attempts: evidence.attempts ?? 1,
    outcome,
    httpStatus: evidence.httpStatus ?? null,
    errorMessage: evidence.errorMessage ?? null,
    retryAfterSeconds: null,
  } satisfies CollectionCycleWrite);
}

/** What {@link startAcceptanceServer} hands the scenario specs. */
export interface AcceptanceServer {
  /** The served application's origin, e.g. `http://127.0.0.1:39241`. */
  readonly baseUrl: string;
  /** The live repository — scenario seeding through the real write path. */
  readonly repository: QuotaRepository;
  /** The mock provider the real adapter's requests reach. */
  readonly mock: MockProviderServer;
  /** The server's log sink — §15.4 marker scans read its lines. */
  readonly sink: MemoryLogSink;
  /** Stops the app, the mock, and removes the temp directories. */
  stop(): Promise<void>;
}

/** Options of {@link startAcceptanceServer}. */
export interface AcceptanceServerOptions {
  /** The configuration file's JSON content (written through the atomic writer). */
  readonly config: unknown;
}

/**
 * Composes and starts the production application over fresh temp
 * directories with the real Z.ai adapter on the loopback mock provider —
 * the served-construction half of every acceptance scenario. The build
 * output location follows the documented flow: the container's `DIST_DIR`
 * volume when set, the package's `ui/dist` (CI's `npm run build:ui`)
 * otherwise — the same resolution the production listener applies.
 */
export async function startAcceptanceServer(
  options: AcceptanceServerOptions,
): Promise<AcceptanceServer> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'qm-acceptance-'));
  let app: QuotameterApp | undefined;
  let mock: MockProviderServer | undefined;
  try {
    const configDir = join(tempRoot, 'config');
    const dataDir = join(tempRoot, 'data');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeConfigFile(configFilePath(configDir), options.config);

    const sink = createMemoryLogSink();
    mock = await startMockProviderServer();
    // The real adapter's credential check (`/models`) is exercised by the
    // account-management scenarios; `fetchSnapshot` is doubled OFF: since
    // the polling engine joined the composition (U-051, D-176), a reachable
    // fetch would run the immediate first poll against the mock's default
    // `200 {}` and persist runs into worlds whose marker/status counts pin
    // exact seeded histories. The plain-`Error` rejection is the recorder's
    // fail-fast shape (neither a TransportError nor an adapter parse
    // failure) — contained by the engine per §7.2, persisting nothing (the
    // wrapper delegates member-by-member because the adapter holds its
    // state in `#private` fields a spread cannot carry). The live engine's
    // own proof lives in `test/integration/composition-polling.spec.ts`.
    const adapter = new ZaiCodingPlanProvider({
      codingBaseUrl: mock.url,
      apiBaseUrl: mock.url,
      timeoutMs: 2_000,
    });
    const provider: QuotaProvider = {
      id: adapter.id,
      name: adapter.name,
      ...(adapter.metricCatalog !== undefined ? { metricCatalog: adapter.metricCatalog } : {}),
      validateCredentials: (account: AccountContext) => adapter.validateCredentials(account),
      async fetchSnapshot(): Promise<never> {
        throw new Error('polled collection is not under test in the acceptance worlds');
      },
    };
    const composed = await composeApplication({
      env: { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: dataDir },
      logger: createLogger({ level: 'info', destination: sink }),
      providers: [provider],
      port: 0,
      staticRoot: process.env.DIST_DIR ?? resolveUiDistDir(),
    });
    app = new QuotameterApp({ components: composed.components });
    await app.start();

    const boundPort = (composed.httpServer.server.server.address() as { port: number }).port;
    let stopped = false;
    return {
      baseUrl: `http://127.0.0.1:${boundPort}`,
      repository: composed.repository,
      mock,
      sink,
      stop: async () => {
        if (stopped) return;
        try {
          // Both halves must settle (a rejecting stop stays retryable —
          // `stopped` flips only on success, the http component's own
          // contract); the temp directories go in the `finally` so a
          // failed stop cannot leak them either.
          await Promise.all([app!.stop(), mock!.close()]);
        } finally {
          await rm(tempRoot, { recursive: true, force: true });
        }
        stopped = true;
      },
    };
  } catch (error) {
    // A half-started world must not leak the app, the mock, or the temp
    // directories (the caller has no teardown handle yet); a throwing
    // teardown step must not skip the others or the cleanup.
    await Promise.allSettled([
      app?.stop() ?? Promise.resolve(),
      mock?.close() ?? Promise.resolve(),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
