import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import type { AccountConfigStore, ManagedAccountConfig } from '../../src/server/api/accounts';
import { apiErrorHandler } from '../../src/server/api/error';
import type { AuthSuspensionState } from '../../src/services/polling-suspension';
import { INITIAL_SUSPENSION_STATE } from '../../src/services/polling-suspension';
import {
  persistCollectionCycle,
  type CollectionCycleWrite,
  type CycleMetricInput,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 status and quota endpoints on the wire (task 160, spec §13, §7.2,
 * §7.3, §8.4; decision D-130): both routes through the real `/api` scope —
 * the three landed guards included — over a real migrated disposable
 * `node:sqlite` database, with real §11.2 history seeded through
 * `persistCollectionCycle`. The configuration half is exercised through a
 * read-only in-memory {@link AccountConfigStore} double (159's seam,
 * unchanged), the D-064 suspension through a mutable per-account map, and
 * the §7.1 interval through a mutable reader — the two §6.4-live inputs
 * the per-request seam exists for.
 *
 * The done-condition's three test classes per route — contract (shapes and
 * §13 status codes), authorization (the §15.1 seam's rejection paths as it
 * exists: the fail-closed default and the configured modes; the
 * sessions-backed authenticator is the recorded D-125/D-126 plan gap), and
 * error (unknown ids, malformed and smuggled query fields) — plus the
 * §15.4 marker discipline: the configured key never appears in any
 * response body, and a marker embedded in a stored error message renders
 * as `[REDACTED]` (§7.4's rule, server-side).
 */

/** Deterministic §11.1 epoch-millisecond base. */
const NOW = 1_761_000_000_000;

/** The §15.4 marker secret — nothing it touches may ever reach a response body. */
const MARKER_KEY = 'sk-marker-secret-4f7a1c9e2b';

/* ── The configuration-store double (159's seam, read-only half) ─────────── */

interface StoredEntry {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
}

/** A seeded account, before any route touches it. */
interface SeedAccount {
  readonly id: string;
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  /** Whether a storage row is seeded beside the entry (default true). */
  readonly row?: boolean;
  /** Whether the seeded row starts archived (§8.2's end state). */
  readonly archived?: boolean;
}

class ReadOnlyAccountStore implements AccountConfigStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly envValues: ReadonlyMap<string, string>;

  constructor(seed: ReadonlyArray<SeedAccount>, env: Readonly<Record<string, string>>) {
    this.envValues = new Map(Object.entries(env));
    for (const account of seed) {
      this.entries.set(account.id, {
        id: account.id,
        providerId: 'zai-coding-plan',
        label: `${account.id} account`,
        enabled: account.enabled ?? true,
        apiKey: account.apiKey,
        apiKeyEnv: account.apiKeyEnv,
      });
    }
  }

  private view(entry: StoredEntry): ManagedAccountConfig {
    return {
      id: entry.id,
      providerId: entry.providerId,
      label: entry.label,
      enabled: entry.enabled,
      keyConfigured: entry.apiKey !== undefined || entry.apiKeyEnv !== undefined,
      keySource: entry.apiKeyEnv !== undefined ? 'environment' : 'file',
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
    throw new Error('the status view never mutates the store');
  }

  async update(): Promise<ManagedAccountConfig | null> {
    throw new Error('the status view never mutates the store');
  }

  async remove(): Promise<boolean> {
    throw new Error('the status view never mutates the store');
  }

  async secretOf(id: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (entry.apiKey !== undefined) return entry.apiKey;
    if (entry.apiKeyEnv !== undefined) return this.envValues.get(entry.apiKeyEnv) ?? null;
    return null;
  }
}

/* ── The harness ────────────────────────────────────────────────────────── */

interface Harness {
  app: FastifyInstance;
  readonly repository: QuotaRepository;
  readonly store: ReadOnlyAccountStore;
  /** The mutable §7.1 interval — §6.4-live, read per request. */
  intervalSeconds: number;
  /** The mutable per-account D-064 suspension map. */
  readonly suspensions: Map<string, AuthSuspensionState>;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  readonly seed?: ReadonlyArray<SeedAccount>;
  readonly env?: Readonly<Record<string, string>>;
}

async function withStatusApi(
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    for (const seed of options.seed ?? []) {
      if (seed.row === false) continue;
      repository.insertAccount({
        id: seed.id,
        providerId: 'zai-coding-plan',
        label: `${seed.id} account`,
        createdAt: NOW,
      });
      if (seed.archived === true) repository.archiveAccount(seed.id, NOW);
    }
    // An archived seed models the archived end state (§8.2): the storage
    // row stays, the configuration entry is gone (the archive removed it).
    const store = new ReadOnlyAccountStore(
      (options.seed ?? []).filter((seed) => seed.archived !== true),
      options.env ?? {},
    );
    const suspensions = new Map<string, AuthSuspensionState>();
    const harness: Harness = {
      app: undefined as unknown as Harness['app'],
      repository,
      store,
      intervalSeconds: 300,
      suspensions,
    };
    const sink: MemoryLogSink = createMemoryLogSink();
    const app = Fastify({
      loggerInstance: createLogger({ level: 'warn', destination: sink }).pino as FastifyBaseLogger,
    });
    harness.app = app;
    app.setErrorHandler(apiErrorHandler);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: options.auth ?? { mode: 'auto', bindHost: '127.0.0.1' },
      status: {
        store,
        repository,
        pollingIntervalSeconds: () => harness.intervalSeconds,
        suspensionOf: (accountId) => suspensions.get(accountId) ?? INITIAL_SUSPENSION_STATE,
        now: () => NOW,
      },
    });
    try {
      await body(harness);
    } finally {
      await app.close();
      database.close();
    }
  });
}

/** One successful cycle with one metric — the base seeding helper. */
function successCycle(
  accountId: string,
  startedAt: number,
  overrides: { planName?: string; metrics?: readonly CycleMetricInput[] } = {},
): CollectionCycleWrite {
  return {
    accountId,
    startedAt,
    endedAt: startedAt + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: startedAt + 1_200,
      planName: overrides.planName ?? 'Pro',
      metrics:
        overrides.metrics === undefined
          ? [
              {
                metricKey: 'mcp-monthly',
                limitType: 'MONTHLY',
                unit: 'CREDITS',
                windowSeconds: null,
                used: 80,
                remaining: 20,
                limit: 100,
                percentUsed: 80,
                percentRemaining: 20,
                resetsAt: NOW + 86_400_000,
                isValid: true,
                invalidReason: null,
                derivedFields: null,
              },
            ]
          : overrides.metrics,
      events: [],
    },
  };
}

/* ── Contract: GET /api/status ──────────────────────────────────────────── */

describe('GET /api/status — service state and account statuses (§13/§7.3)', () => {
  it('answers the empty state: ok, the effective interval, no accounts', async () => {
    await withStatusApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', pollingIntervalSeconds: 300, accounts: [] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    });
  });

  it('derives fresh for a healthy account, with the two §7.2 most-recents', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 90_000));
        const response = await app.inject({ method: 'GET', url: '/api/status' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          status: 'ok',
          pollingIntervalSeconds: 300,
          accounts: [
            {
              id: 'work',
              status: 'fresh',
              lastSuccessAt: NOW - 88_800,
              lastError: null,
            },
          ],
        });
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('derives unreachable with the last error for a failing latest cycle', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 600_000));
        persistCollectionCycle(repository, {
          accountId: 'work',
          startedAt: NOW - 60_000,
          endedAt: NOW - 58_800,
          intervalSeconds: 300,
          attempts: 3,
          outcome: 'network_error',
          errorMessage: 'connection refused',
        });
        const response = await app.inject({ method: 'GET', url: '/api/status' });
        const accounts = (
          response.json() as { accounts: Array<{ status: string; lastError: unknown }> }
        ).accounts;
        expect(accounts[0]?.status).toBe('unreachable');
        expect(accounts[0]?.lastError).toEqual({
          outcome: 'network_error',
          message: 'connection refused',
          at: NOW - 60_000,
        });
        // §7.2's retention: the last success stays visible after the error.
        expect(
          (response.json() as { accounts: Array<{ lastSuccessAt: number }> }).accounts[0]
            ?.lastSuccessAt,
        ).toBe(NOW - 598_800);
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('derives disabled for a disabled account even with fresh data, and for archived rows', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('off', NOW - 60_000));
        persistCollectionCycle(repository, successCycle('gone', NOW - 60_000));
        const accounts = (
          (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
            accounts: Array<{ id: string; status: string }>;
          }
        ).accounts;
        expect(accounts).toEqual([
          { id: 'gone', status: 'disabled', lastSuccessAt: NOW - 58_800, lastError: null },
          { id: 'off', status: 'disabled', lastSuccessAt: NOW - 58_800, lastError: null },
        ]);
      },
      {
        seed: [
          { id: 'off', enabled: false, apiKey: MARKER_KEY },
          { id: 'gone', archived: true },
        ],
      },
    );
  });

  it('derives not-configured for an unresolved apiKeyEnv (§7.3/§6.3)', async () => {
    await withStatusApi(
      async ({ app }) => {
        const accounts = (
          (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
            accounts: Array<{ status: string }>;
          }
        ).accounts;
        expect(accounts).toEqual([
          { id: 'env-key', status: 'not-configured', lastSuccessAt: null, lastError: null },
        ]);
      },
      { seed: [{ id: 'env-key', apiKeyEnv: 'ZAI_UNSET_KEY' }] },
    );
  });

  it('derives auth-rejected while the D-064 suspension holds, even over a successful latest run', async () => {
    await withStatusApi(
      async ({ app, repository, suspensions }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 60_000));
        suspensions.set('work', {
          suspended: true,
          keyIdentity: 'generation-1',
          suspendedAtEpochMs: NOW - 30_000,
          nextVerificationAtEpochMs: NOW + 3_600_000,
        });
        const accounts = (
          (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
            accounts: Array<{ status: string }>;
          }
        ).accounts;
        expect(accounts[0]?.status).toBe('auth-rejected');
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('derives collecting for a configured account with no runs, and stale past three intervals', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        let accounts = (
          (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
            accounts: Array<{ status: string }>;
          }
        ).accounts;
        expect(accounts[0]?.status).toBe('collecting');
        // The snapshot stamp is the run start + 1.2 s; past the 900 s
        // window (three §7.1 intervals) the data reads stale.
        persistCollectionCycle(repository, successCycle('work', NOW - 1_000_000));
        accounts = (
          (await app.inject({ method: 'GET', url: '/api/status' })).json() as {
            accounts: Array<{ status: string }>;
          }
        ).accounts;
        expect(accounts[0]?.status).toBe('stale');
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('reads the interval per request — a §6.4 live change moves the freshness window', async () => {
    await withStatusApi(
      async (harness) => {
        persistCollectionCycle(harness.repository, successCycle('work', NOW - 1_000_000));
        const before = await harness.app.inject({ method: 'GET', url: '/api/status' });
        // ~999 s old data is stale inside the 900 s window of a 300 s interval…
        expect((before.json() as { accounts: Array<{ status: string }> }).accounts[0]?.status).toBe(
          'stale',
        );
        // …and fresh inside the 10,800 s window of a live-reloaded hour.
        harness.intervalSeconds = 3600;
        const after = await harness.app.inject({ method: 'GET', url: '/api/status' });
        expect((after.json() as { pollingIntervalSeconds: number }).pollingIntervalSeconds).toBe(
          3600,
        );
        expect((after.json() as { accounts: Array<{ status: string }> }).accounts[0]?.status).toBe(
          'fresh',
        );
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('lists a configured account before its storage row exists (config-sync lag)', async () => {
    await withStatusApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/status' });
        expect(response.json()).toEqual({
          status: 'ok',
          pollingIntervalSeconds: 300,
          accounts: [
            { id: 'hand-edited', status: 'collecting', lastSuccessAt: null, lastError: null },
          ],
        });
      },
      { seed: [{ id: 'hand-edited', apiKey: MARKER_KEY, row: false }] },
    );
  });
});

/* ── Contract: GET /api/quota ───────────────────────────────────────────── */

describe('GET /api/quota — the last valid values (§13/§8.4/§7.2)', () => {
  it('answers the account with header facts, metrics, and the §7.3 status', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(
          repository,
          successCycle('work', NOW - 90_000, {
            metrics: [
              {
                metricKey: 'mcp-monthly',
                limitType: 'MONTHLY',
                unit: 'CREDITS',
                windowSeconds: null,
                used: 80,
                remaining: 20,
                limit: 100,
                percentUsed: 80,
                percentRemaining: 20,
                resetsAt: NOW + 86_400_000,
                isValid: true,
                invalidReason: null,
                // A non-null derived-field mask, so the serializer's
                // array branch rides the wire too (review round P3).
                derivedFields: ['remaining', 'percentRemaining'],
              },
            ],
          }),
        );
        const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=work' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          accountId: 'work',
          status: 'fresh',
          collectedAt: NOW - 88_800,
          planName: 'Pro',
          metrics: [
            {
              metricKey: 'mcp-monthly',
              limitType: 'MONTHLY',
              unit: 'CREDITS',
              windowSeconds: null,
              used: 80,
              remaining: 20,
              limit: 100,
              percentUsed: 80,
              percentRemaining: 20,
              resetsAt: NOW + 86_400_000,
              isValid: true,
              invalidReason: null,
              derivedFields: ['remaining', 'percentRemaining'],
              collectedAt: NOW - 88_800,
            },
          ],
        });
        expect(response.headers['cache-control']).toBe('no-store');
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('assembles the last valid value per metric — an invalid newer row never erases one (D-077)', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 600_000));
        persistCollectionCycle(
          repository,
          successCycle('work', NOW - 90_000, {
            planName: 'Pro',
            metrics: [
              // The newer reading of the known metric is invalid: no values,
              // a reason — never zeros (§8.4).
              {
                metricKey: 'mcp-monthly',
                limitType: 'MONTHLY',
                unit: 'CREDITS',
                windowSeconds: null,
                used: null,
                remaining: null,
                limit: null,
                percentUsed: null,
                percentRemaining: null,
                resetsAt: null,
                isValid: false,
                invalidReason: 'field missing from provider response',
                derivedFields: null,
              },
              // A new valid metric rides the same snapshot.
              {
                metricKey: 'tokens-5h',
                limitType: 'ROLLING_WINDOW',
                unit: 'PERCENT',
                windowSeconds: 18_000,
                used: null,
                remaining: null,
                limit: null,
                percentUsed: 42,
                percentRemaining: 58,
                resetsAt: null,
                isValid: true,
                invalidReason: null,
                derivedFields: null,
              },
            ],
          }),
        );
        const metrics = (
          (await app.inject({ method: 'GET', url: '/api/quota?accountId=work' })).json() as {
            metrics: ReadonlyArray<Record<string, unknown>>;
          }
        ).metrics;
        expect(
          metrics.map((row) => ({
            metricKey: row.metricKey,
            collectedAt: row.collectedAt,
            used: row.used,
          })),
        ).toEqual([
          // The last VALID mcp-monthly row — the older snapshot's, with its
          // own stamp (D-077's per-row collection times).
          { metricKey: 'mcp-monthly', collectedAt: NOW - 598_800, used: 80 },
          // The new metric from the newer snapshot.
          { metricKey: 'tokens-5h', collectedAt: NOW - 88_800, used: null },
        ]);
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('answers the never-collected account honestly: null facts, empty metrics, never zero', async () => {
    await withStatusApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=work' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          accountId: 'work',
          status: 'collecting',
          collectedAt: null,
          planName: null,
          metrics: [],
        });
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('serves an archived account — §8.2 retains its history (reads are not refused)', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('gone', NOW - 90_000));
        const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=gone' });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { status: string; metrics: unknown[] };
        expect(body.status).toBe('disabled');
        expect(body.metrics).toHaveLength(1);
      },
      { seed: [{ id: 'gone', archived: true }] },
    );
  });
});

/* ── Authorization: the §15.1 seam as it exists ─────────────────────────── */

describe('the status routes behind the §15.1 auth-mode guard', () => {
  const REQUIRED_WITH_PASSWORD: AuthModeGuardOptions = {
    mode: 'required',
    bindHost: '127.0.0.1',
    passwordConfigured: () => true,
  };

  it('required mode with the fail-closed seam rejects both endpoints with 401', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 60_000));
        for (const url of ['/api/status', '/api/quota?accountId=work']) {
          const response = await app.inject({ method: 'GET', url });
          expect(response.statusCode, url).toBe(401);
          expect(response.json(), url).toEqual({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required',
              details: { reason: 'authentication-required' },
            },
          });
        }
      },
      { auth: REQUIRED_WITH_PASSWORD, seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('a succeeding seam composes — required mode answers once authenticated', async () => {
    await withStatusApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/status' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'ok' });
      },
      { auth: { ...REQUIRED_WITH_PASSWORD, isAuthenticated: () => true }, seed: [{ id: 'work' }] },
    );
  });

  it("answers §15.1's 403 with instructions for a proxied passwordless request", async () => {
    await withStatusApi(async ({ app }) => {
      const status = await app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(status.statusCode).toBe(403);
      expect(status.json()).toMatchObject({
        error: { details: { reason: 'proxy-without-password' } },
      });
      const quota = await app.inject({
        method: 'GET',
        url: '/api/quota?accountId=work',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(quota.statusCode).toBe(403);
    });
  });
});

/* ── Errors ─────────────────────────────────────────────────────────────── */

describe('GET /api/status and /api/quota — error classes', () => {
  it('answers 404 for an account unknown to both halves', async () => {
    await withStatusApi(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=none' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Account not found', details: null },
      });
    });
  });

  it('serves an entry-only account (no storage row yet): known via the configuration half', async () => {
    await withStatusApi(
      async ({ app }) => {
        const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=ghost' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          accountId: 'ghost',
          status: 'collecting',
          collectedAt: null,
          planName: null,
          metrics: [],
        });
      },
      { seed: [{ id: 'ghost', apiKey: MARKER_KEY, row: false }] },
    );
  });

  it('rejects malformed and smuggled query parameters through the strict scope (D-128)', async () => {
    await withStatusApi(async ({ app }) => {
      const cases: Array<{ url: string; why: string }> = [
        { url: '/api/quota', why: 'missing accountId' },
        { url: '/api/quota?accountId=', why: 'blank accountId' },
        { url: '/api/quota?accountId=has%20space', why: 'charset' },
        { url: '/api/quota?accountId=work&metric=monthly-credits', why: 'smuggled extra field' },
      ];
      for (const testCase of cases) {
        const response = await app.inject({ method: 'GET', url: testCase.url });
        expect(response.statusCode, testCase.why).toBe(400);
        expect(response.json(), testCase.why).toMatchObject({ error: { code: 'VALIDATION' } });
      }
    });
  });

  it('keeps both routes GET-only — other methods answer the §13 envelope', async () => {
    await withStatusApi(async ({ app }) => {
      for (const path of ['/api/status', '/api/quota']) {
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: { 'x-quotameter-request': 'test-client', 'content-type': 'application/json' },
          payload: '{}',
        });
        expect(response.statusCode, path).toBe(404);
        expect(response.json(), path).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    });
  });
});

/* ── The §15.4 marker discipline across the whole surface ───────────────── */

describe('the write-only key and §7.4 redaction across every flow (§15.4)', () => {
  it('never returns the configured key in any response body', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        persistCollectionCycle(repository, successCycle('work', NOW - 60_000));
        persistCollectionCycle(repository, {
          accountId: 'work',
          startedAt: NOW - 30_000,
          endedAt: NOW - 29_000,
          intervalSeconds: 300,
          attempts: 1,
          outcome: 'timeout',
          errorMessage: 'request timed out',
        });
        const bodies = [
          (await app.inject({ method: 'GET', url: '/api/status' })).body,
          (await app.inject({ method: 'GET', url: '/api/quota?accountId=work' })).body,
          (await app.inject({ method: 'GET', url: '/api/quota?accountId=none' })).body,
        ];
        for (const body of bodies) {
          expect(body).not.toContain(MARKER_KEY);
        }
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('renders a marker embedded in a stored error message as [REDACTED] (§7.4)', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        // A contract-violating provider residual: the transport should
        // never embed key material (D-042/D-048), but if one does, the
        // §7.4 rule catches it server-side (the D-114 precedent).
        persistCollectionCycle(repository, {
          accountId: 'work',
          startedAt: NOW - 30_000,
          endedAt: NOW - 29_000,
          intervalSeconds: 300,
          attempts: 1,
          outcome: 'server_error',
          errorMessage: `upstream failed after bearer ${MARKER_KEY}`,
        });
        const response = await app.inject({ method: 'GET', url: '/api/status' });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(MARKER_KEY);
        expect(response.body).toContain('upstream failed after bearer [REDACTED]');
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });

  it('renders a marker embedded in a provider plan name as [REDACTED] — data fields get the same rule (review P3)', async () => {
    await withStatusApi(
      async ({ app, repository }) => {
        // The plan name is provider-controlled data (§8.4), not a
        // sanitized-by-construction transport message — a contract-violating
        // provider reflecting key material there hits the same §7.4 guard.
        persistCollectionCycle(
          repository,
          successCycle('work', NOW - 60_000, { planName: `Pro (${MARKER_KEY})` }),
        );
        const response = await app.inject({ method: 'GET', url: '/api/quota?accountId=work' });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(MARKER_KEY);
        expect((response.json() as { planName: string }).planName).toBe('Pro ([REDACTED])');
      },
      { seed: [{ id: 'work', apiKey: MARKER_KEY }] },
    );
  });
});

/* ── The unwired construction keeps the catch-all answer ────────────────── */

describe('the task-146 construction without status dependencies', () => {
  it('answers /api/status with the scope catch-all 404 envelope — no half-wired surface', async () => {
    const app = Fastify({
      loggerInstance: createLogger({ level: 'warn', destination: createMemoryLogSink() })
        .pino as FastifyBaseLogger,
    });
    app.setErrorHandler(apiErrorHandler);
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: { mode: 'auto', bindHost: '127.0.0.1' },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/api/status' },
        },
      });
    } finally {
      await app.close();
    }
  });
});
