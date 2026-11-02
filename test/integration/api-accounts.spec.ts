import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AuthModeGuardOptions } from '../../src/server/api/auth';
import type { AccountConfigStore, ManagedAccountConfig } from '../../src/server/api/accounts';
import { apiErrorHandler } from '../../src/server/api/error';
import { buildHttpServer } from '../../src/server/http';
import type {
  ParseFailureCollectionCycle,
  SuccessfulCollectionCycle,
} from '../../src/storage/collection-cycles';
import { persistCollectionCycle } from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import type { AccountContext, QuotaProvider } from '../../src/providers/registry';
import { ProviderRegistry } from '../../src/providers/registry';
import {
  CredentialCheckError,
  CredentialsRejectedError,
} from '../../src/providers/zai-coding-plan/validate';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { withTempDir } from '../helpers/isolation';

/**
 * The §13 accounts endpoints on the wire (task 159, spec §13, §8.2, §15;
 * decision D-128): every route through the real `/api` scope — the three
 * landed guards (Origin, custom-header/content-type, §15.1 auth-mode)
 * included — over a real migrated disposable `node:sqlite` database (the
 * task-087/088 pattern) and the real lifecycle modules (§8.2 archive/purge
 * through `retireAccount`/`purgeAccount`). The configuration-file half is
 * exercised through an in-memory {@link AccountConfigStore} double — the
 * D-128 seam, exactly the shape the composition root will implement over
 * the atomic config write — and the connection test through a test-double
 * provider registered in a real `ProviderRegistry` (throwing the real
 * D-052 credential-check errors, so the endpoint's structural `kind` read
 * is pinned against the adapter's actual vocabulary).
 *
 * The done-condition's three test classes per endpoint — contract
 * (request→response shapes and §13 status codes), authorization (the
 * §15.1 seam's rejection paths, pinned against the seam as it exists: the
 * fail-closed default and the configured modes; the sessions-backed
 * authenticator is the recorded plan gap D-125/D-126), and error (stable
 * codes for validation, unknown accounts, the §8.2 purge confirmation
 * semantics, and the provider-test failure mapping) — plus the §15.4
 * marker-secret discipline: a created account's key never appears in any
 * response body.
 */

/** Deterministic §11.1 epoch-millisecond base; the harness clock ticks 1 s per call. */
const NOW = 1_761_000_000_000;

/** The §15.4 marker secret — nothing it touches may ever reach a response body. */
const MARKER_KEY = 'sk-marker-secret-4f7a1c9e2b';

/** A second marker for key rotation flows. */
const MARKER_KEY_2 = 'sk-rotated-marker-9d3e5f7a1c';

/** The §15.3 dedicated mutation header (task 150, D-117). */
const MUTATION_HEADER = { 'x-quotameter-request': 'test-client' } as const;

/* ── The configuration-store double (the D-128 seam, in memory) ─────────── */

/** One stored entry — the configuration file's account row, secrets included. */
interface StoredEntry {
  readonly id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
}

/** A seeded account, before any route touches it. */
interface SeedAccount {
  readonly id: string;
  readonly providerId?: string;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  /** Whether a storage row is seeded beside the entry (default true). */
  readonly row?: boolean;
  /** Whether the seeded row starts archived (§8.2's end state). */
  readonly archived?: boolean;
}

/**
 * The in-memory configuration store: file keys verbatim, environment names
 * resolved against an injected value map (unset names resolve `null` — the
 * service-side D-112 residual), plus the two failure hooks the error
 * suites need (`failNextAdd` proves the compensation write; `nullNextUpdate`
 * proves the update-race refusal).
 */
class MemoryAccountStore implements AccountConfigStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly envValues: ReadonlyMap<string, string>;
  failNextAdd: unknown = undefined;
  nullNextUpdate = false;

  constructor(seed: ReadonlyArray<SeedAccount>, env: Readonly<Record<string, string>>) {
    this.envValues = new Map(Object.entries(env));
    for (const account of seed) {
      this.entries.set(account.id, {
        id: account.id,
        providerId: account.providerId ?? 'zai-coding-plan',
        label: account.label ?? `${account.id} account`,
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

  /** The last add's full input, including the secret — the write-path proof. */
  lastAdded: { id: string; apiKey?: string } | undefined;

  async add(account: {
    id: string;
    providerId: string;
    label: string;
    enabled: boolean;
    apiKey?: string;
  }): Promise<void> {
    if (this.failNextAdd !== undefined) {
      const error = this.failNextAdd;
      this.failNextAdd = undefined;
      throw error;
    }
    if (this.entries.has(account.id)) {
      throw new Error(`duplicate account id '${account.id}'`);
    }
    this.entries.set(account.id, {
      id: account.id,
      providerId: account.providerId,
      label: account.label,
      enabled: account.enabled,
      apiKey: account.apiKey,
    });
    this.lastAdded = { id: account.id, apiKey: account.apiKey };
  }

  /** The last update's changes, including a rotated secret — the write-path proof. */
  lastUpdated: { id: string; changes: Record<string, unknown> } | undefined;

  async update(
    id: string,
    changes: { label?: string; enabled?: boolean; apiKey?: string },
  ): Promise<ManagedAccountConfig | null> {
    if (this.nullNextUpdate) {
      this.nullNextUpdate = false;
      return null;
    }
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    const updated: StoredEntry = {
      ...entry,
      label: changes.label ?? entry.label,
      enabled: changes.enabled ?? entry.enabled,
      apiKey: changes.apiKey !== undefined ? changes.apiKey : entry.apiKey,
    };
    this.entries.set(id, updated);
    this.lastUpdated = { id, changes: { ...changes } };
    return this.view(updated);
  }

  /** The last removed id — the archive/purge cleanup proof. */
  lastRemoved: string | undefined;

  failNextRemove = false;

  async remove(id: string): Promise<boolean> {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error('config write failed (injected)');
    }
    this.lastRemoved = id;
    return this.entries.delete(id);
  }

  async secretOf(id: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (entry.apiKey !== undefined) return entry.apiKey;
    if (entry.apiKeyEnv !== undefined) return this.envValues.get(entry.apiKeyEnv) ?? null;
    return null;
  }
}

/* ── The provider double (real registry, real D-052 error classes) ──────── */

type FakeProviderMode = 'ok' | 'rejected' | 'unavailable' | 'boom' | 'foreign-kind';

/** The controllable half of the test-double provider. */
interface FakeProviderBehavior {
  mode: FakeProviderMode;
  /** Every AccountContext handed to validateCredentials, in order. */
  readonly contexts: AccountContext[];
}

function createFakeRegistry(): { registry: ProviderRegistry; behavior: FakeProviderBehavior } {
  const behavior: FakeProviderBehavior = { mode: 'ok', contexts: [] };
  const provider: QuotaProvider = {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan (test double)',
    async validateCredentials(account: AccountContext): Promise<void> {
      behavior.contexts.push(account);
      if (behavior.mode === 'rejected') throw new CredentialsRejectedError(401);
      if (behavior.mode === 'unavailable') {
        throw new CredentialCheckError(
          'provider-unavailable',
          'the credential check could not be completed: connection refused (test double)',
        );
      }
      if (behavior.mode === 'boom') throw new Error('unclassified provider failure (test double)');
      if (behavior.mode === 'foreign-kind') {
        // A classified-LOOKING foreign error: a `kind` outside D-052's
        // vocabulary must not ride the 200 shape — it escalates (the
        // review round's mutation-hole pin).
        const foreign = new Error('foreign classifier (test double)');
        (foreign as Error & { kind: string }).kind = 'other';
        throw foreign;
      }
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test in this suite');
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { registry, behavior };
}

/* ── The harness: real database, real scope, doubled stores ─────────────── */

interface Harness {
  readonly app: FastifyInstance;
  readonly repository: QuotaRepository;
  readonly store: MemoryAccountStore;
  readonly behavior: FakeProviderBehavior;
  readonly sink: MemoryLogSink;
}

interface HarnessOptions {
  readonly auth?: AuthModeGuardOptions;
  readonly seed?: ReadonlyArray<SeedAccount>;
  readonly env?: Readonly<Record<string, string>>;
}

async function withApi(
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
        providerId: seed.providerId ?? 'zai-coding-plan',
        label: seed.label ?? `${seed.id} account`,
        createdAt: NOW,
      });
      if (seed.archived === true) repository.archiveAccount(seed.id, NOW);
    }
    const store = new MemoryAccountStore(options.seed ?? [], options.env ?? {});
    const { registry, behavior } = createFakeRegistry();
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const app = Fastify({
      loggerInstance: logger.pino as FastifyBaseLogger,
    });
    app.setErrorHandler(apiErrorHandler);
    let clock = NOW;
    await app.register(apiRoutes, {
      prefix: '/api',
      auth: options.auth ?? { mode: 'auto', bindHost: '127.0.0.1' },
      accounts: { store, repository, registry, now: () => (clock += 1000) },
    });
    try {
      await body({ app, repository, store, behavior, sink });
    } finally {
      await app.close();
      database.close();
    }
  });
}

/* ── Injection helpers (§15.3-exact: the dedicated header, JSON bodies) ─── */

/** One §13 call: mutations carry the dedicated header; bodies are JSON. */
async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  const headers: Record<string, string> = { ...options.headers };
  if (method !== 'GET') headers['x-quotameter-request'] = 'test-client';
  const payload = options.payload === undefined ? undefined : JSON.stringify(options.payload);
  // Content-Type rides only body-carrying requests — a bodiless mutation
  // claiming JSON answers fastify's own empty-body 400 (D-117's pin).
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload });
}

/** Creates one account through the API and resolves its id. */
async function createAccount(
  app: FastifyInstance,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await call(app, 'POST', '/api/accounts', {
    payload: { providerId: 'zai-coding-plan', label: 'Work plan', ...overrides },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

/** Seeds §11.2 history for the purge evidence: 3 runs, 2 snapshots, 2 metrics, 1 event, 1 raw. */
function seedHistory(repository: QuotaRepository, accountId: string): void {
  const metric = {
    metricKey: 'monthly-credits',
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
  } as const;
  const first: SuccessfulCollectionCycle = {
    accountId,
    startedAt: NOW,
    endedAt: NOW + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: NOW + 1_200,
      planName: 'Pro',
      metrics: [metric],
      events: [
        {
          metricKey: 'monthly-credits',
          eventType: 'RESET',
          eventAt: NOW + 86_400_000,
          details: {
            reason: 'used decreased beyond tolerance',
            previous: { collectedAt: NOW, used: 80 },
            current: { collectedAt: NOW + 300_000, used: 5 },
          },
        },
      ],
    },
  };
  const second: SuccessfulCollectionCycle = {
    ...first,
    startedAt: NOW + 300_000,
    endedAt: NOW + 301_200,
    snapshot: { ...first.snapshot, collectedAt: NOW + 301_200, events: [] },
  };
  const parseFailure: ParseFailureCollectionCycle = {
    accountId,
    startedAt: NOW + 600_000,
    endedAt: NOW + 601_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'parse_error',
    errorMessage: 'unexpected response schema',
    rawResponse: {
      capturedAt: NOW + 601_200,
      httpStatus: 200,
      contentType: 'application/json',
      body: '{"unexpected": true}',
    },
  };
  persistCollectionCycle(repository, first);
  persistCollectionCycle(repository, second);
  persistCollectionCycle(repository, parseFailure);
}

/* ── Contract: GET /api/accounts ────────────────────────────────────────── */

describe('GET /api/accounts — the masked list (§13)', () => {
  it('answers the empty state with an empty list and §15.5 no-store', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'GET', '/api/accounts');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accounts: [] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    });
  });

  it('lists created accounts with the merged view and the constant mask', async () => {
    await withApi(async ({ app }) => {
      await createAccount(app, { id: 'work', apiKey: MARKER_KEY });
      const response = await call(app, 'GET', '/api/accounts');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        accounts: [
          {
            id: 'work',
            providerId: 'zai-coding-plan',
            label: 'Work plan',
            enabled: true,
            status: 'active',
            hasKey: true,
            keySource: 'file',
            keyMask: '********',
            planName: null,
            createdAt: NOW + 1000,
            archivedAt: null,
          },
        ],
      });
      // §15.4: the key never rides any response.
      expect(response.body).not.toContain(MARKER_KEY);
    });
  });

  it('keeps archived accounts listed — archive retains identity and history (§8.2)', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      const deleted = await call(app, 'DELETE', `/api/accounts/${id}`);
      expect(deleted.statusCode).toBe(200);
      const list = await call(app, 'GET', '/api/accounts');
      const accounts = (
        list.json() as { accounts: Array<{ status: string; enabled: boolean; keySource: string }> }
      ).accounts;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ status: 'archived', enabled: false, keySource: 'none' });
    });
  });

  it('lists a configured account before its storage row exists (config-sync lag)', async () => {
    await withApi(
      async ({ app }) => {
        const list = await call(app, 'GET', '/api/accounts');
        expect(list.json()).toEqual({
          accounts: [
            expect.objectContaining({ id: 'hand-edited', status: 'active', createdAt: null }),
          ],
        });
      },
      { seed: [{ id: 'hand-edited', apiKey: MARKER_KEY, row: false }] },
    );
  });

  it('keeps the collection GET-and-POST only — other methods answer the §13 envelope', async () => {
    await withApi(async ({ app }) => {
      // POST on the collection is the create route (§13); every other
      // mutating method finds no route here.
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const response = await call(app, method, '/api/accounts', { payload: {} });
        expect(response.statusCode, method).toBe(404);
        expect(response.json(), method).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    });
  });
});

/* ── Contract: POST /api/accounts ───────────────────────────────────────── */

describe('POST /api/accounts — create with a write-only key (§13)', () => {
  it('generates a stable id when none is supplied and defaults to enabled, keyless', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'POST', '/api/accounts', {
        payload: { providerId: 'zai-coding-plan', label: 'Work plan' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as Record<string, unknown>;
      // The generated id: charset-safe, collision-resistant, stable from now on.
      expect(body.id).toMatch(/^acc-[0-9a-f]{16}$/);
      expect(body).toMatchObject({ enabled: true, hasKey: false, keyMask: null, status: 'active' });
    });
  });

  it('persists the key to the store and the row to the database — both halves', async () => {
    await withApi(async ({ app, store, repository }) => {
      const response = await call(app, 'POST', '/api/accounts', {
        payload: {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'Work plan',
          apiKey: MARKER_KEY,
        },
      });
      expect(response.statusCode).toBe(201);
      // The write path carries the exact secret (§6.3: file-stored)…
      expect(store.lastAdded).toEqual({ id: 'work', apiKey: MARKER_KEY });
      // …and the storage row exists beside it (§11.2).
      expect(repository.getAccount('work')).toMatchObject({
        id: 'work',
        providerId: 'zai-coding-plan',
        status: 'active',
      });
      // …while the response carries only the mask state (§15.4).
      expect(response.body).not.toContain(MARKER_KEY);
    });
  });

  it('honors an explicit disabled create (§8.2 enable state)', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'POST', '/api/accounts', {
        payload: { providerId: 'zai-coding-plan', label: 'Paused', enabled: false },
      });
      expect(response.statusCode).toBe(201);
      expect((response.json() as { enabled: boolean }).enabled).toBe(false);
    });
  });
});

/* ── Contract: PATCH /api/accounts/:id ──────────────────────────────────── */

describe("PATCH /api/accounts/:id — §13's three mutable fields", () => {
  it('renames and mirrors the label to the storage row', async () => {
    await withApi(async ({ app, repository }) => {
      const id = await createAccount(app, { label: 'Before' });
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, {
        payload: { label: 'After' },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { label: string }).label).toBe('After');
      expect(repository.getAccount(id)?.label).toBe('After');
    });
  });

  it('toggles the enable state (configuration-only — no row column)', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, {
        payload: { enabled: false },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { enabled: boolean }).enabled).toBe(false);
    });
  });

  it('replaces the key write-only: the store receives it, the response never does', async () => {
    await withApi(async ({ app, store }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, {
        payload: { apiKey: MARKER_KEY_2 },
      });
      expect(response.statusCode).toBe(200);
      expect(store.lastUpdated).toEqual({ id, changes: { apiKey: MARKER_KEY_2 } });
      expect(response.body).not.toContain(MARKER_KEY);
      expect(response.body).not.toContain(MARKER_KEY_2);
      expect(response.json()).toMatchObject({ hasKey: true, keyMask: '********' });
    });
  });

  it('applies all three fields in one request', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, {
        payload: { label: 'All at once', enabled: false, apiKey: MARKER_KEY_2 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ label: 'All at once', enabled: false, hasKey: true });
    });
  });

  it('renames a configured account that has no storage row yet — the mirror is best-effort', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'PATCH', '/api/accounts/hand-edited', {
          payload: { label: 'Renamed before sync' },
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as { label: string }).label).toBe('Renamed before sync');
      },
      { seed: [{ id: 'hand-edited', row: false }] },
    );
  });
});

/* ── Contract: DELETE /api/accounts/:id — the §8.2 split ────────────────── */

describe('DELETE /api/accounts/:id — archive by default, purge on explicit request', () => {
  it('archives: row archived, history kept, configuration entry removed', async () => {
    await withApi(async ({ app, repository, store }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      seedHistory(repository, id);
      const response = await call(app, 'DELETE', `/api/accounts/${id}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ result: 'archived', removed: null });
      // §8.2: the archive keeps every history row…
      expect(repository.listCollectionRuns(id)).toHaveLength(3);
      // …marks the row archived with the writer-supplied timestamp…
      expect(repository.getAccount(id)).toMatchObject({
        status: 'archived',
        archivedAt: NOW + 2000,
      });
      // …and stops polling by removing the configuration entry.
      expect(store.lastRemoved).toBe(id);
    });
  });

  it('re-archive is idempotent and keeps the original timestamp (D-061)', async () => {
    await withApi(async ({ app, repository }) => {
      const id = await createAccount(app);
      const first = await call(app, 'DELETE', `/api/accounts/${id}`);
      expect((first.json() as { result: string }).result).toBe('archived');
      const second = await call(app, 'DELETE', `/api/accounts/${id}`);
      expect(second.statusCode).toBe(200);
      expect((second.json() as { result: string }).result).toBe('already-archived');
      expect(repository.getAccount(id)?.archivedAt).toBe(NOW + 2000);
    });
  });

  it('purges on ?purgeHistory=true with the D-061 evidence report', async () => {
    await withApi(async ({ app, repository }) => {
      const id = await createAccount(app);
      seedHistory(repository, id);
      const response = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=true`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        result: 'purged',
        removed: {
          collectionRuns: 3,
          snapshots: 2,
          metricValues: 2,
          quotaEvents: 1,
          rawResponses: 1,
        },
      });
      // §11.2's cascade: the account row and every history row are gone.
      expect(repository.getAccount(id)).toBeNull();
      expect(repository.listCollectionRuns(id)).toHaveLength(0);
    });
  });

  it('purges an already-archived account identically (D-061: purge ignores status)', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      await call(app, 'DELETE', `/api/accounts/${id}`);
      const response = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=true`);
      expect(response.statusCode).toBe(200);
      expect((response.json() as { result: string }).result).toBe('purged');
    });
  });

  it('archives a configuration-only account by its entry removal — both halves decide (review P1)', async () => {
    await withApi(
      async ({ app, store }) => {
        const response = await call(app, 'DELETE', '/api/accounts/hand-edited');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ result: 'archived', removed: null });
        expect(store.lastRemoved).toBe('hand-edited');
        // The account is gone from the list — the removal was the archive.
        const list = await call(app, 'GET', '/api/accounts');
        expect((list.json() as { accounts: unknown[] }).accounts).toHaveLength(0);
      },
      { seed: [{ id: 'hand-edited', row: false, apiKey: MARKER_KEY }] },
    );
  });

  it('purges a configuration-only account with the honest zero-evidence report (review P1)', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'DELETE', '/api/accounts/hand-edited?purgeHistory=true');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          result: 'purged',
          removed: {
            collectionRuns: 0,
            snapshots: 0,
            metricValues: 0,
            quotaEvents: 0,
            rawResponses: 0,
          },
        });
      },
      { seed: [{ id: 'hand-edited', row: false }] },
    );
  });

  it('treats ?purgeHistory=false as the honest archive request', async () => {
    await withApi(async ({ app, repository }) => {
      const id = await createAccount(app);
      seedHistory(repository, id);
      const response = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=false`);
      expect(response.statusCode).toBe(200);
      expect((response.json() as { result: string }).result).toBe('archived');
      expect(repository.getAccount(id)).not.toBeNull();
    });
  });
});

/* ── Contract: POST /api/accounts/:id/test ──────────────────────────────── */

describe('POST /api/accounts/:id/test — the provider connection test (§13/§8.2)', () => {
  it('answers ok and hands the provider the exact key through the branded context', async () => {
    await withApi(async ({ app, behavior }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'ok' });
      // The positive write/read path: the secret reached the provider…
      expect(behavior.contexts).toHaveLength(1);
      expect(behavior.contexts[0]?.accountId).toBe(id);
      expect(behavior.contexts[0]?.label).toBe('Work plan');
      expect(behavior.contexts[0]?.secret).toBe(MARKER_KEY);
      // …while the response never saw it.
      expect(response.body).not.toContain(MARKER_KEY);
    });
  });

  it("maps D-052's rejected kind onto outcome rejected with the sanitized message", async () => {
    await withApi(async ({ app, behavior }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      behavior.mode = 'rejected';
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        outcome: 'rejected',
        message: 'the provider rejected the account credentials (HTTP 401)',
      });
    });
  });

  it("maps D-052's unavailable kind onto outcome unavailable", async () => {
    await withApi(async ({ app, behavior }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      behavior.mode = 'unavailable';
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: 'unavailable' });
    });
  });

  it("tests a disabled account too — §7.2's manual-test request", async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app, { enabled: false, apiKey: MARKER_KEY });
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'ok' });
    });
  });
});

/* ── Authorization: the §15.1 seam as it exists (D-121, plan gap D-125/126) ─ */

describe('the accounts routes behind the §15.1 auth-mode guard', () => {
  // What these tests pin, precisely: the routes declare no public opt-out,
  // so the scope's third hook adjudicates them. The sessions-backed
  // RequestAuthenticator does not exist yet (the D-125/D-126 plan gap) —
  // the seam here is its landed shape: the fail-closed default (nothing is
  // authenticated) and the injected modes of §15.1.
  const REQUIRED_WITH_PASSWORD: AuthModeGuardOptions = {
    mode: 'required',
    bindHost: '127.0.0.1',
    passwordConfigured: () => true,
  };

  it('required mode with the fail-closed seam rejects every endpoint with 401', async () => {
    await withApi(
      async ({ app }) => {
        const requests: Array<{
          method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
          url: string;
          payload?: unknown;
        }> = [
          { method: 'GET', url: '/api/accounts' },
          {
            method: 'POST',
            url: '/api/accounts',
            payload: { providerId: 'zai-coding-plan', label: 'X' },
          },
          { method: 'PATCH', url: '/api/accounts/work', payload: { label: 'X' } },
          { method: 'DELETE', url: '/api/accounts/work' },
          { method: 'POST', url: '/api/accounts/work/test' },
        ];
        for (const request of requests) {
          const response = await call(app, request.method, request.url, {
            payload: request.payload,
          });
          expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
          expect(response.json(), `${request.method} ${request.url}`).toEqual({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required',
              details: { reason: 'authentication-required' },
            },
          });
        }
      },
      { auth: REQUIRED_WITH_PASSWORD, seed: [{ id: 'work' }] },
    );
  });

  it('a succeeding seam composes — required mode answers once authenticated', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'GET', '/api/accounts');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ accounts: [expect.objectContaining({ id: 'work' })] });
      },
      {
        auth: { ...REQUIRED_WITH_PASSWORD, isAuthenticated: () => true },
        seed: [{ id: 'work' }],
      },
    );
  });

  it("a proxied request against a passwordless server answers §15.1's 403 with instructions", async () => {
    await withApi(async ({ app }) => {
      // The default harness auth is auto + loopback + no password; the
      // proxy indicator alone flips the verdict.
      const get = await call(app, 'GET', '/api/accounts', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(get.statusCode).toBe(403);
      expect(get.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'proxy-without-password' } },
      });
      const post = await call(app, 'POST', '/api/accounts', {
        payload: { providerId: 'zai-coding-plan', label: 'X' },
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(post.statusCode).toBe(403);
      expect(post.json()).toMatchObject({
        error: { details: { reason: 'proxy-without-password' } },
      });
    });
  });

  it('the §15.3 mutation guards bind the new routes — bodied and bodiless alike', async () => {
    await withApi(async ({ app }) => {
      // POST without the dedicated header → 403 (the CSRF leg).
      const noHeader = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'content-type': 'application/json' },
        payload: '{"providerId":"zai-coding-plan","label":"X"}',
      });
      expect(noHeader.statusCode).toBe(403);
      expect(noHeader.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'missing-custom-header' } },
      });
      // DELETE bodiless without it → 403 too (the header leg is unconditional).
      const bodiless = await app.inject({ method: 'DELETE', url: '/api/accounts/none' });
      expect(bodiless.statusCode).toBe(403);
      // POST with the header but a form content type → 415 (the JSON leg).
      const formType = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { ...MUTATION_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'providerId=zai&label=X',
      });
      expect(formType.statusCode).toBe(415);
      expect(formType.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    });
  });
});

/* ── Errors: POST ───────────────────────────────────────────────────────── */

describe('POST /api/accounts — error classes', () => {
  it('rejects an unknown provider with the stable reason', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'POST', '/api/accounts', {
        payload: { providerId: 'ghost-provider', label: 'X' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: 'VALIDATION',
          message: 'Unknown provider',
          details: { reason: 'unknown-provider', field: 'providerId' },
        },
      });
    });
  });

  it('rejects a duplicate id — against the storage row and the store entry alike', async () => {
    await withApi(
      async ({ app }) => {
        const viaRow = await call(app, 'POST', '/api/accounts', {
          payload: { id: 'work', providerId: 'zai-coding-plan', label: 'X' },
        });
        expect(viaRow.statusCode).toBe(400);
        expect(viaRow.json()).toMatchObject({
          error: { code: 'VALIDATION', details: { reason: 'duplicate-account-id' } },
        });
        const viaStore = await call(app, 'POST', '/api/accounts', {
          payload: { id: 'hand-edited', providerId: 'zai-coding-plan', label: 'X' },
        });
        expect(viaStore.statusCode).toBe(400);
        expect(viaStore.json()).toMatchObject({
          error: { code: 'VALIDATION', details: { reason: 'duplicate-account-id' } },
        });
      },
      { seed: [{ id: 'work' }, { id: 'hand-edited', row: false }] },
    );
  });

  it('rejects malformed bodies through the §13 envelope (schema + blank key)', async () => {
    await withApi(async ({ app }) => {
      const cases: Array<{ payload: unknown; why: string }> = [
        { payload: { providerId: 'zai-coding-plan' }, why: 'missing label' },
        { payload: { providerId: '', label: 'X' }, why: 'blank provider' },
        {
          payload: { id: 'has space', providerId: 'zai-coding-plan', label: 'X' },
          why: 'id charset',
        },
        {
          payload: { providerId: 'zai-coding-plan', label: 'X', apiKeyEnv: 'ZAI_KEY' },
          why: 'env binding is not a request field (§6.3)',
        },
        { payload: { providerId: 'zai-coding-plan', label: 'X', apiKey: ' ' }, why: 'blank key' },
        { payload: [], why: 'not an object' },
      ];
      for (const testCase of cases) {
        const response = await call(app, 'POST', '/api/accounts', { payload: testCase.payload });
        expect(response.statusCode, testCase.why).toBe(400);
        expect(response.json(), testCase.why).toMatchObject({ error: { code: 'VALIDATION' } });
      }
    });
  });

  it('compensates the storage row when the configuration write fails', async () => {
    await withApi(async ({ app, store, repository, sink }) => {
      store.failNextAdd = new Error('config write failed (injected)');
      const response = await call(app, 'POST', '/api/accounts', {
        payload: { id: 'doomed', providerId: 'zai-coding-plan', label: 'X' },
      });
      // The destructive half of the pair never happened: INTERNAL on the
      // wire, the row rolled back, the cause logged server-side (D-113).
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', details: null },
      });
      expect(response.body).not.toContain('config write failed');
      expect(repository.getAccount('doomed')).toBeNull();
      expect(sink.records().some((record) => String(record.msg).includes('internal error'))).toBe(
        true,
      );
    });
  });
});

/* ── Errors: PATCH ──────────────────────────────────────────────────────── */

describe('PATCH /api/accounts/:id — error classes', () => {
  it('rejects a blank key (whitespace is never a credential, D-011)', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, {
        payload: { apiKey: ' ' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: 'VALIDATION',
          message: 'apiKey must not be blank',
          details: { reason: 'blank-api-key', field: 'apiKey' },
        },
      });
    });
  });

  it("rejects the empty patch (§13's three fields, at least one)", async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, { payload: {} });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    });
  });

  it('answers 404 for an unknown account', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'PATCH', '/api/accounts/none', { payload: { label: 'X' } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Account not found', details: null },
      });
    });
  });

  it('refuses mutations on an archived account — the lifecycle is terminal (D-061)', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'PATCH', '/api/accounts/gone', {
          payload: { label: 'X' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          error: {
            code: 'FORBIDDEN',
            message: 'The account is archived and can no longer be modified',
            details: { reason: 'account-archived' },
          },
        });
      },
      { seed: [{ id: 'gone', archived: true }] },
    );
  });

  it('refuses a key change on an environment-sourced account (§6.3 read-only)', async () => {
    await withApi(
      async ({ app }) => {
        const refused = await call(app, 'PATCH', '/api/accounts/env-key', {
          payload: { apiKey: MARKER_KEY },
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({
          error: {
            code: 'FORBIDDEN',
            message: 'The API key is supplied by the environment and cannot be changed here',
            details: { reason: 'environment-key-read-only' },
          },
        });
        // The read-only rule is key-scoped: label and enabled stay mutable.
        const label = await call(app, 'PATCH', '/api/accounts/env-key', {
          payload: { label: 'Renamed anyway' },
        });
        expect(label.statusCode).toBe(200);
      },
      {
        seed: [{ id: 'env-key', apiKeyEnv: 'ZAI_TEST_KEY' }],
        env: { ZAI_TEST_KEY: MARKER_KEY },
      },
    );
  });

  it('answers 404 when the entry vanishes between the checks (the update race)', async () => {
    await withApi(async ({ app, store }) => {
      const id = await createAccount(app);
      store.nullNextUpdate = true;
      const response = await call(app, 'PATCH', `/api/accounts/${id}`, { payload: { label: 'X' } });
      expect(response.statusCode).toBe(404);
    });
  });

  it('rejects an out-of-charset id parameter at the schema layer', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'PATCH', '/api/accounts/bad%20id!', {
        payload: { label: 'X' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    });
  });
});

/* ── Errors: DELETE ─────────────────────────────────────────────────────── */

describe('DELETE /api/accounts/:id — error classes and purge semantics', () => {
  it('answers 404 for an unknown account on both arms', async () => {
    await withApi(async ({ app }) => {
      const archive = await call(app, 'DELETE', '/api/accounts/none');
      expect(archive.statusCode).toBe(404);
      expect(archive.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Account not found', details: null },
      });
      const purge = await call(app, 'DELETE', '/api/accounts/none?purgeHistory=true');
      expect(purge.statusCode).toBe(404);
    });
  });

  it('rejects a malformed purge flag — only the boolean grammar arms the destructive path', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      const response = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=yes`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
      // Nothing happened: the account is intact and active.
      expect((await call(app, 'GET', '/api/accounts')).json()).toMatchObject({
        accounts: [expect.objectContaining({ id, status: 'active' })],
      });
    });
  });

  it('surfaces a post-purge configuration-cleanup failure as INTERNAL, the purge itself done', async () => {
    await withApi(async ({ app, store, repository, sink }) => {
      const id = await createAccount(app);
      store.failNextRemove = true;
      const response = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=true`);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
      // The destructive half succeeded before the cleanup failed — and the
      // operator's retry REACHES the cleanup (the ghost entry still
      // resolves, so the both-halves unknown verdict does not 404 it) and
      // heals it: the entry leaves, the row is already gone, and the
      // zero-evidence purge reports success (the review round's P1 fix).
      expect(repository.getAccount(id)).toBeNull();
      const retry = await call(app, 'DELETE', `/api/accounts/${id}?purgeHistory=true`);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        result: 'purged',
        removed: {
          collectionRuns: 0,
          snapshots: 0,
          metricValues: 0,
          quotaEvents: 0,
          rawResponses: 0,
        },
      });
      const list = await call(app, 'GET', '/api/accounts');
      expect((list.json() as { accounts: unknown[] }).accounts).toHaveLength(0);
      expect(sink.records().some((record) => String(record.msg).includes('internal error'))).toBe(
        true,
      );
    });
  });
});

/* ── Errors: test ───────────────────────────────────────────────────────── */

describe('POST /api/accounts/:id/test — error classes', () => {
  it('answers 404 for an unknown account', async () => {
    await withApi(async ({ app }) => {
      const response = await call(app, 'POST', '/api/accounts/none/test');
      expect(response.statusCode).toBe(404);
    });
  });

  it('refuses the test on an archived account', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'POST', '/api/accounts/gone/test');
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error: { details: { reason: 'account-archived' } },
        });
      },
      { seed: [{ id: 'gone', archived: true }] },
    );
  });

  it('refuses the test when no key is configured (§7.3 Not configured)', async () => {
    await withApi(async ({ app }) => {
      const id = await createAccount(app);
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'No API key is configured for this account',
          details: { reason: 'no-key-configured' },
        },
      });
    });
  });

  it('answers unavailable when the environment source resolves to no value', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'POST', '/api/accounts/env-key/test');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          outcome: 'unavailable',
          message: 'the configured API key source resolved to no value',
        });
      },
      // The name is configured (a §6.3 source) but this process's
      // environment does not carry it — the D-112 residual, service-side.
      { seed: [{ id: 'env-key', apiKeyEnv: 'ZAI_UNSET_KEY' }] },
    );
  });

  it('answers unavailable when the account names a provider this build lacks', async () => {
    await withApi(
      async ({ app }) => {
        const response = await call(app, 'POST', '/api/accounts/ghost/test');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          outcome: 'unavailable',
          message: "the account's provider 'ghost-plan' is not available in this build",
        });
      },
      { seed: [{ id: 'ghost', providerId: 'ghost-plan', apiKey: MARKER_KEY }] },
    );
  });

  it("escalates a classified-looking FOREIGN kind to INTERNAL too — only D-052's vocabulary rides the 200 shape", async () => {
    await withApi(async ({ app, behavior }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      behavior.mode = 'foreign-kind';
      const response = await call(app, `POST`, `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', details: null },
      });
      expect(response.body).not.toContain('foreign classifier');
    });
  });

  it('escalates an unclassifiable provider failure to the INTERNAL envelope, logged', async () => {
    await withApi(async ({ app, behavior, sink }) => {
      const id = await createAccount(app, { apiKey: MARKER_KEY });
      behavior.mode = 'boom';
      const response = await call(app, 'POST', `/api/accounts/${id}/test`);
      expect(response.statusCode).toBe(500);
      // D-113's strict rule: the error's own words never reach the wire…
      expect(response.json()).toEqual({
        error: { code: 'INTERNAL', message: 'Internal server error', details: null },
      });
      expect(response.body).not.toContain('unclassified provider failure');
      // …the log carries the cause (§16), never the key (§15.4).
      const logged = JSON.stringify(sink.records());
      expect(logged).toContain('unclassified provider failure');
      expect(logged).not.toContain(MARKER_KEY);
    });
  });
});

/* ── The §15.4 marker discipline across the whole surface ───────────────── */

describe('the write-only key across every flow (§13/§15.4)', () => {
  it('never returns the created or rotated key in any response body', async () => {
    await withApi(async ({ app, repository }) => {
      const bodies: string[] = [];
      const collect = (response: { body: string }): void => {
        bodies.push(response.body);
      };

      collect(
        await call(app, 'POST', '/api/accounts', {
          payload: {
            id: 'work',
            providerId: 'zai-coding-plan',
            label: 'Work plan',
            apiKey: MARKER_KEY,
          },
        }),
      );
      collect(await call(app, 'GET', '/api/accounts'));
      collect(await call(app, 'PATCH', '/api/accounts/work', { payload: { label: 'Renamed' } }));
      collect(
        await call(app, 'PATCH', '/api/accounts/work', { payload: { apiKey: MARKER_KEY_2 } }),
      );
      collect(await call(app, 'POST', '/api/accounts/work/test'));
      // The error paths too: every §13 envelope these flows can produce.
      collect(await call(app, 'PATCH', '/api/accounts/work', { payload: {} }));
      collect(await call(app, 'PATCH', '/api/accounts/none', { payload: { label: 'X' } }));
      collect(
        await call(app, 'POST', '/api/accounts', {
          payload: { id: 'work', providerId: 'zai-coding-plan', label: 'Dup', apiKey: MARKER_KEY },
        }),
      );
      seedHistory(repository, 'work');
      collect(await call(app, 'DELETE', '/api/accounts/work?purgeHistory=true'));
      collect(await call(app, 'GET', '/api/accounts'));

      expect(bodies).not.toHaveLength(0);
      for (const body of bodies) {
        expect(body).not.toContain(MARKER_KEY);
        expect(body).not.toContain(MARKER_KEY_2);
      }
    });
  });
});

/* ── The unwired construction keeps the catch-all answer ────────────────── */

describe('the task-146 construction without accounts dependencies', () => {
  it("answers /api/accounts with the scope catch-all's 404 envelope — no half-wired surface", async () => {
    const sink = createMemoryLogSink();
    const server = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger: createLogger({ level: 'warn', destination: sink }),
    });
    try {
      const response = await server.inject({ method: 'GET', url: '/api/accounts' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/api/accounts' },
        },
      });
    } finally {
      await server.close();
    }
  });
});
