import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { apiRoutes } from '../../src/server/api/index';
import type { AccountConfigStore, ManagedAccountConfig } from '../../src/server/api/accounts';
import { apiErrorHandler } from '../../src/server/api/error';
import { createLogger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { createQuotaRepository, type QuotaRepository } from '../../src/storage/repository';
import { ProviderRegistry } from '../../src/providers/registry';
import type { AccountContext, QuotaProvider } from '../../src/providers/registry';
import { ApiClientError } from '../../ui/src/api/error';
import { createApiClient } from '../../ui/src/api/client';
import type { ApiFetch } from '../../ui/src/api/client';
import { withTempDir } from '../helpers/isolation';

/**
 * The task-171 done-condition, executable end to end: "UI/API tests prove
 * the key is never returned to the browser" (spec §6.3, §14.2, §15.4;
 * decision D-136).
 *
 * What was already proven where: tasks 159/160 pinned each route family's
 * responses server-side — marker-secret scans over every accounts/
 * settings/status body through `fastify.inject` (the providers listing is
 * structurally key-free: no secret flows through it) — and task 170
 * pinned the UI affordances (masked inputs, never prefilled, cleared
 * after every submit attempt — success and refusal alike — the mask
 * rendered verbatim) against synthetic key-free fixtures. The seam
 * between them is this file's reason: no earlier test drove the REAL
 * `/api` surface through the UI's own data layer. Here the real API
 * client (D-134 — the exact `createApiClient` object every accounts-page
 * component calls, with its real header/mutation/body pipeline) runs a
 * full §14.2 management session — list, create with a key, replace key,
 * test, rename, archive, and one refused create for the error path —
 * against the real route stack: real serializers, real §15.3 guards,
 * the §13 error handler, real migrated `node:sqlite` storage, the real
 * provider registry. The bridge between client and server captures
 * every exchange — response body and request body — exactly as the
 * browser's `fetch` would deliver and send it.
 *
 * The proof chain, each link executable: the browser receives only
 * (a) response bodies — scanned here over the real surface, markers
 * absent, mask present — and (b) the client's resolved values, success
 * and error alike (the state Vue components render from; an error's
 * `serverMessage`/`serverDetails` ride the same client state) —
 * collected here and scanned the same way. The rendered-DOM leg stays
 * with the component suite (`accounts-view.spec.ts`: the mask renders
 * verbatim, the typed key never lingers — input value and rendered
 * text), which composes with this file because the components render
 * nothing but this client's outputs. A component-mount over the real
 * server is not hostable in this repo's matrix: the component project's
 * happy-dom environment container (Vitest 5) refuses to bundle the
 * `node:*` built-ins the server graph statically requires — recorded in
 * D-136 as the pattern's boundary.
 *
 * The configuration-file half is the D-128 seam (the in-memory store
 * double of the integration suites, trimmed to this session's needs):
 * keys live in `config.json` in production, and the seam's
 * `ManagedAccountConfig` view structurally carries no key value — the
 * same guarantee the composition root will implement.
 */

/** The §15.4 marker secret submitted through the create calls — nothing it touches may reach the browser. */
const MARKER_KEY = 'sk-browser-marker-create-6c4a2e91';

/** The rotation marker submitted through the replace-key call. */
const MARKER_KEY_2 = 'sk-browser-marker-rotate-0d7f43b8';

/** Deterministic §11.1 epoch-millisecond base; the harness clock ticks 1 s per call. */
const NOW = 1_762_000_000_000;

/* ── The configuration-store double (the D-128 seam, in memory) ─────────── */

/** One stored entry — the configuration file's account row, secret included. */
interface StoredEntry {
  readonly id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  apiKey?: string;
}

/**
 * The in-memory {@link AccountConfigStore}: file keys verbatim, the
 * write paths the session drives (`add` rejecting duplicate ids per the
 * seam contract, `update`, `remove`), the `failNextAdd` hook for the
 * INTERNAL-path exchange, and `secretOf` — the one channel the secret
 * VALUE may take, server-side only.
 */
class MemoryAccountStore implements AccountConfigStore {
  private readonly entries = new Map<string, StoredEntry>();

  /** Reject the next `add` with this error — the config-write failure hook. */
  failNextAdd: unknown = undefined;

  private view(entry: StoredEntry): ManagedAccountConfig {
    return {
      id: entry.id,
      providerId: entry.providerId,
      label: entry.label,
      enabled: entry.enabled,
      keyConfigured: entry.apiKey !== undefined,
      keySource: 'file',
    };
  }

  /** The stored secret of an account — the write-path proof. */
  keyOf(id: string): string | undefined {
    return this.entries.get(id)?.apiKey;
  }

  async list(): Promise<ReadonlyArray<ManagedAccountConfig>> {
    return [...this.entries.values()].map((entry) => this.view(entry));
  }

  async find(id: string): Promise<ManagedAccountConfig | null> {
    const entry = this.entries.get(id);
    return entry === undefined ? null : this.view(entry);
  }

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
  }

  async update(
    id: string,
    changes: { label?: string; enabled?: boolean; apiKey?: string },
  ): Promise<ManagedAccountConfig | null> {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    const updated: StoredEntry = {
      ...entry,
      label: changes.label ?? entry.label,
      enabled: changes.enabled ?? entry.enabled,
      apiKey: changes.apiKey !== undefined ? changes.apiKey : entry.apiKey,
    };
    this.entries.set(id, updated);
    return this.view(updated);
  }

  async remove(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async secretOf(id: string): Promise<string | null> {
    return this.entries.get(id)?.apiKey ?? null;
  }
}

/* ── The provider double (real registry; §8.1 credential check) ─────────── */

/** Every AccountContext handed to validateCredentials, in order. */
interface ProviderBehavior {
  readonly contexts: AccountContext[];
}

function createRegistry(): { registry: ProviderRegistry; behavior: ProviderBehavior } {
  const behavior: ProviderBehavior = { contexts: [] };
  const provider: QuotaProvider = {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan (test double)',
    async validateCredentials(account: AccountContext): Promise<void> {
      behavior.contexts.push(account);
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not under test in this suite');
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  return { registry, behavior };
}

/* ── The browser-side bridge: the client's fetch seam over inject ───────── */

/** One exchange exactly as the browser's fetch would send and receive it. */
interface CapturedExchange {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly requestBody?: string;
  readonly body: string;
}

/**
 * Bridges the client's injectable fetch seam (D-134) onto the real
 * `/api` scope: every client dispatch runs through `app.inject` with
 * the client's own method/URL/headers/body — so the session's mutations
 * pass the real §15.3 Origin/custom-header and §15.1 auth guards, the
 * bodies are the real serializers' output, and each exchange is
 * captured verbatim, request and response alike. What lands in
 * `captured` IS what leaves and reaches the browser.
 */
function bridgeFetch(app: FastifyInstance, captured: CapturedExchange[]): ApiFetch {
  return async (input, init) => {
    const response = await app.inject({
      method: init.method,
      url: input,
      headers: init.headers,
      payload: init.body,
    });
    captured.push({
      method: init.method,
      url: input,
      status: response.statusCode,
      requestBody: init.body,
      body: response.body,
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: () => Promise.resolve(response.body),
    };
  };
}

/* ── The session ────────────────────────────────────────────────────────── */

describe('the UI data layer against the real /api surface (task 171, §6.3/§14.2/§15.4)', () => {
  it('never returns the submitted key to the browser across a full management session', async () => {
    await withTempDir(async (dir) => {
      // The real stack: migrated disposable database, repository,
      // registry, configuration-store seam, deterministic clock, the
      // §13 error handler, and the `/api` scope with its three landed
      // guards.
      const database = new DatabaseSync(dir.sqlitePath());
      database.exec('PRAGMA foreign_keys = ON');
      await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
      const repository: QuotaRepository = createQuotaRepository({ database });
      const store = new MemoryAccountStore();
      const { registry, behavior } = createRegistry();
      const sink: MemoryLogSink = createMemoryLogSink();
      const app = Fastify({
        loggerInstance: createLogger({ level: 'warn', destination: sink })
          .pino as FastifyBaseLogger,
      });
      app.setErrorHandler(apiErrorHandler);
      let clock = NOW;
      await app.register(apiRoutes, {
        prefix: '/api',
        auth: { mode: 'auto', bindHost: '127.0.0.1' },
        accounts: { store, repository, registry, now: () => (clock += 1000) },
        providers: { registry, schedules: () => ({}) },
      });

      const captured: CapturedExchange[] = [];
      // The client the accounts page installs (D-134) — the real
      // pipeline, bridged onto the real routes.
      const client = createApiClient({ fetchImpl: bridgeFetch(app, captured) });
      /** Every value the client resolved this session — the browser-side state. */
      const browserState: unknown[] = [];

      try {
        // The page's mount loads (AccountsView): provider types and the
        // (empty) accounts list.
        browserState.push(await client.providers.list(), await client.accounts.list());

        // The add form's create (§5.3, key included): the marker
        // leaves the browser exactly once per create, in the POST body.
        const created = await client.accounts.create({
          providerId: 'zai-coding-plan',
          label: 'Main',
          apiKey: MARKER_KEY,
        });
        browserState.push(created);
        // The create write path carried the exact secret server-side
        // (§6.3: the file-stored source) — anchored BEFORE the
        // rotation replaces it.
        expect(store.keyOf(created.id)).toBe(MARKER_KEY);
        browserState.push(await client.accounts.list());

        // The replace-key form's PATCH (§14.2 write-only).
        await client.accounts.update(created.id, { apiKey: MARKER_KEY_2 });
        const rotated = await client.accounts.list();
        browserState.push(rotated);
        // Captured before the archive step removes the entry (§8.2:
        // archiving is the configuration entry's removal).
        const storedKeyAfterRotation = store.keyOf(created.id);

        // The connection test (§14.2): the real provider double sees
        // the current secret — server-side only.
        browserState.push(await client.accounts.test(created.id));

        // Rename, then archive — the rest of the §14.2 verb set.
        const renamed = await client.accounts.update(created.id, { label: 'Renamed' });
        const afterRename = await client.accounts.list();
        browserState.push(renamed, afterRename);
        const removed = await client.accounts.remove(created.id);
        const archived = await client.accounts.list();
        browserState.push(removed, archived);

        /* ── The done-condition's proofs ───────────────────────────── */

        // (0) Non-vacuous: the session really drove the real surface —
        // every exchange so far a success, every §14.2 verb dispatched,
        // both route families loaded, the rename and archive real.
        expect(captured.length).toBeGreaterThanOrEqual(10);
        for (const exchange of captured) {
          expect(exchange.status, `${exchange.method} ${exchange.url}`).toBeGreaterThanOrEqual(200);
          expect(exchange.status, `${exchange.method} ${exchange.url}`).toBeLessThan(300);
        }
        const dispatched = captured.map((exchange) => `${exchange.method} ${exchange.url}`);
        expect(dispatched).toContain('GET /api/providers');
        expect(dispatched).toContain('POST /api/accounts');
        expect(dispatched.some((line) => line.startsWith('PATCH /api/accounts/'))).toBe(true);
        expect(
          dispatched.some(
            (line) => line.startsWith('POST /api/accounts/') && line.endsWith('/test'),
          ),
        ).toBe(true);
        expect(dispatched.some((line) => line.startsWith('DELETE /api/accounts/'))).toBe(true);
        expect(renamed.label).toBe('Renamed');
        expect(afterRename.accounts.find((account) => account.id === created.id)?.label).toBe(
          'Renamed',
        );
        expect(removed.result).toBe('archived');

        // (1) The write path is real: the server-side halves hold the
        // exact secrets (the store after rotation, anchored before the
        // archive removed the entry; the provider double saw the
        // CURRENT key — the rotated one — through the branded context)
        // — proving the markers were genuinely in play, server-side
        // only.
        expect(storedKeyAfterRotation).toBe(MARKER_KEY_2);
        expect(behavior.contexts).toHaveLength(1);
        expect(behavior.contexts[0]?.secret).toBe(MARKER_KEY_2);

        // (2) The wire: no exchange's response body — every response
        // the browser would receive this session — contains either
        // marker, no request URL ever carried one (§15.4's URL
        // channel), and the markers left the browser only through the
        // two write channels (the create POST and the replace-key
        // PATCH) — never a GET or a DELETE body.
        for (const exchange of captured) {
          expect(exchange.body, `${exchange.method} ${exchange.url}`).not.toContain(MARKER_KEY);
          expect(exchange.body, `${exchange.method} ${exchange.url}`).not.toContain(MARKER_KEY_2);
          expect(exchange.url, exchange.method).not.toContain(MARKER_KEY);
          expect(exchange.url, exchange.method).not.toContain(MARKER_KEY_2);
        }
        for (const exchange of captured) {
          const carries = [MARKER_KEY, MARKER_KEY_2].filter((marker) =>
            (exchange.requestBody ?? '').includes(marker),
          );
          if (carries.length === 0) continue;
          const line = `${exchange.method} ${exchange.url}`;
          const isWriteChannel =
            line === 'POST /api/accounts' ||
            (exchange.method === 'PATCH' && exchange.url.startsWith('/api/accounts/'));
          expect(isWriteChannel, `${line} carried ${carries.join(',')}`).toBe(true);
        }
        expect(captured.some((exchange) => exchange.body.includes('********'))).toBe(true);

        // (3) The parsed half — the state the components render from:
        // no client-resolved success value contains key material,
        // while the display state is exactly the mask and its boolean.
        for (const value of browserState) {
          const rendered = JSON.stringify(value);
          expect(rendered).not.toContain(MARKER_KEY);
          expect(rendered).not.toContain(MARKER_KEY_2);
        }
        expect(created.hasKey).toBe(true);
        expect(created.keyMask).toBe('********');
        const view = rotated.accounts.find((account) => account.id === created.id);
        expect(view).toMatchObject({ hasKey: true, keyMask: '********', keySource: 'file' });
        expect(archived.accounts.find((account) => account.id === created.id)).toMatchObject({
          status: 'archived',
          keySource: 'none',
          hasKey: false,
          keyMask: null,
        });

        // (4) The error path — the one §13 exchange a session can
        // honestly fail: a refused create whose server-side cause is a
        // configuration-write failure. The INTERNAL envelope must stay
        // marker-free on the wire, the thrown client error (whose
        // `serverMessage`/`serverDetails` ride client state like any
        // resolved value) must carry no marker either, and the
        // server-side log channel — §15.4's, not a browser channel —
        // must contain the cause but never the key (the api-accounts
        // suite's pin, now over the client-driven path and a
        // non-empty sink).
        const sessionLength = captured.length;
        store.failNextAdd = new Error('config write failed (injected)');
        const failedCreate = await client.accounts
          .create({ providerId: 'zai-coding-plan', label: 'Doomed', apiKey: MARKER_KEY })
          .then(
            () => {
              throw new Error('the refused create unexpectedly succeeded');
            },
            (error: unknown) => error,
          );
        expect(failedCreate).toBeInstanceOf(ApiClientError);
        const rejection = failedCreate as ApiClientError;
        expect(rejection.kind).toBe('rejected');
        expect(rejection.serverMessage).toBe('Internal server error');
        expect(JSON.stringify([rejection.serverMessage, rejection.serverDetails])).not.toContain(
          MARKER_KEY,
        );
        const refused = captured[sessionLength];
        expect(refused).toMatchObject({ method: 'POST', status: 500 });
        expect(refused?.body).not.toContain(MARKER_KEY);
        expect(refused?.body).toContain('"code":"INTERNAL"');
        const logged = JSON.stringify(sink.records());
        expect(sink.records().length).toBeGreaterThan(0);
        expect(logged).toContain('internal error');
        expect(logged).not.toContain(MARKER_KEY);
        expect(logged).not.toContain(MARKER_KEY_2);
      } finally {
        await app.close();
        database.close();
      }
    });
  });
});
