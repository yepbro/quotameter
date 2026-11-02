/**
 * The §13 accounts endpoints (task 159, spec §13, §6.3, §8.2, §15.4;
 * decision D-128).
 *
 * Five routes inside the `/api` scope (`./index.ts` registers this plugin
 * when the construction supplies the dependencies): the management list
 * with masked keys, create with a write-only key, label/enable/key update,
 * §8.2's archive-vs-purge split, and the provider connection test. Every
 * request and response is defined by the TypeBox contracts in
 * `src/schemas/api/accounts.ts` — validation and serialization both run
 * through them, and the compiled serializers are closed objects, so the
 * write-only-key discipline holds structurally: no response key set
 * includes the secret, and a handler bug that returned it could not put it
 * on the wire (the D-111 health precedent, generalized).
 *
 * The two-store reality the spec fixes drives the shape: **secrets and the
 * enabled flag live in the configuration file** (§6.2/§6.3 — `apiKey` /
 * `apiKeyEnv`, never the database, pinned by the §11.2 schema tests), while
 * **lifecycle status and history live in SQLite** (§8.2/§11.2 — the
 * `accounts` row, `retireAccount`/`purgeAccount`). No runtime
 * configuration-mutation service exists yet (the composition root is empty
 * and §6.4's reload wiring is future work), so the configuration half is an
 * injected seam — {@link AccountConfigStore} — the D-121 `RequestAuthenticator`
 * precedent: the endpoints are complete and testable against the seam, and
 * the production implementation (atomic `writeConfigFile` reads-modify-
 * writes plus the §6.4 reload) is the composition task's to wire. The
 * storage half reuses the landed facade and lifecycle modules verbatim
 * (D-058/D-061) — nothing here issues SQL or re-implements archive/purge.
 *
 * Error vocabulary stays inside D-113's registry (no new codes — adding one
 * is a coordinated `src/schemas/api/error.ts` change this task does not
 * make): endpoint-specific refusals ride the existing classes with stable
 * `details.reason` values, the §15.1/D-115 pattern — `duplicate-account-id`
 * and `unknown-provider` inside VALIDATION (400), `account-archived`,
 * `environment-key-read-only`, and `no-key-configured` inside FORBIDDEN
 * (403 — "understood but refused", the honest class for state refusals),
 * and unknown ids as NOT_FOUND (404).
 */

import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import type { QuotaProvider, ProviderRegistry } from '../../providers/registry';
import { createAccountContext } from '../../providers/registry';
import type { QuotaRepository, AccountRecord } from '../../storage/repository';
import { purgeAccount, retireAccount } from '../../storage/account-lifecycle';
import {
  ACCOUNT_KEY_MASK,
  AccountIdParamsSchema,
  AccountMutationResultSchema,
  AccountTestResponseSchema,
  AccountViewSchema,
  AccountsListResponseSchema,
  CreateAccountBodySchema,
  DeleteAccountQuerySchema,
  EMPTY_PURGED_HISTORY_COUNTS,
  UpdateAccountBodySchema,
  type AccountTestResponse,
  type AccountView,
  type CreateAccountBody,
  type UpdateAccountBody,
} from '../../schemas/api/accounts';
import { ApiError } from './error';

/* ── The configuration-side seam (the D-121 pattern: define at the consumer) ─ */

/**
 * One managed account as the configuration holds it (spec §6.2, §6.3): the
 * management fields plus the secret's *state* — whether a source is
 * configured and where it comes from — never the value. `keySource` drives
 * §6.3's read-only rule for environment-sourced keys.
 */
export interface ManagedAccountConfig {
  /** Stable account identifier (the §6.2 charset). */
  readonly id: string;
  /** Provider adapter identifier. */
  readonly providerId: string;
  /** Display label. */
  readonly label: string;
  /** Polling on/off (§6.2 `enabled`). */
  readonly enabled: boolean;
  /** Whether exactly one secret source is configured (§6.3). */
  readonly keyConfigured: boolean;
  /** `'environment'` when the source is `apiKeyEnv` (read-only, §6.3), else `'file'`. */
  readonly keySource: 'file' | 'environment';
}

/**
 * The configuration-file account store — the seam the future composition
 * root implements over `loadConfigWithEnv` + atomic `writeConfigFile`
 * writes (§6.3: keys live in the `0600` config file, never the database)
 * and §6.4's change application. The endpoint module owns the interface,
 * exactly as `./auth.ts` owns `RequestAuthenticator` (D-121): the routes
 * are complete against it, and the implementation cannot tangle endpoint
 * semantics with filesystem ones.
 *
 * Contract: `add` rejects (a rejected promise) when the id already exists;
 * `update` resolves `null` for an unknown id; `remove` resolves whether an
 * entry existed; `secretOf` resolves the secret VALUE for the connection
 * test only — server-side process memory (§15.4), consumed by
 * {@link createAccountContext} and never echoed, logged, or serialized.
 */
export interface AccountConfigStore {
  /** Every configured account. */
  list(): Promise<ReadonlyArray<ManagedAccountConfig>>;
  /** The configured account with this id, or `null`. */
  find(id: string): Promise<ManagedAccountConfig | null>;
  /** Persists a new account entry (creating its secret source); rejects on a duplicate id. */
  add(account: {
    readonly id: string;
    readonly providerId: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly apiKey?: string;
  }): Promise<void>;
  /**
   * Applies label/enable/key changes to the configured entry; resolves the
   * updated state, or `null` when the id is unknown.
   */
  update(
    id: string,
    changes: { readonly label?: string; readonly enabled?: boolean; readonly apiKey?: string },
  ): Promise<ManagedAccountConfig | null>;
  /** Removes the configured entry; resolves whether one existed. */
  remove(id: string): Promise<boolean>;
  /** The account's secret value, or `null` when none resolves (no source, or an unset environment name). */
  secretOf(id: string): Promise<string | null>;
}

/** What the `/api` scope passes to {@link accountRoutes}. */
export interface AccountsRouteOptions {
  /** The configuration-side account store (the seam above). */
  readonly store: AccountConfigStore;
  /** The storage facade — account rows and §8.2 lifecycle (D-058). */
  readonly repository: QuotaRepository;
  /** The provider registry — `validateCredentials` for the test endpoint (§8.1). */
  readonly registry: ProviderRegistry;
  /** The clock for writer-supplied timestamps (§11.1, the D-021 seam). */
  readonly now: () => number;
}

/* ── Pure view composition ─────────────────────────────────────────────── */

/**
 * Builds one {@link AccountView} from the merge's halves. The configured
 * entry wins for the management fields (label/provider/enabled/key state —
 * it is §6.4's live-reloadable truth); the storage row owns lifecycle and
 * history facts. Either half may be absent: a configured account not yet
 * mirrored into storage reads `status: 'active'` with null history facts
 * (the config-sync is composition wiring), and a storage row without a
 * configuration entry — an archived account, whose entry the archive
 * removed — reads `enabled: false` with no key state.
 */
export function accountView(
  managed: ManagedAccountConfig | null | undefined,
  record: AccountRecord | null,
): AccountView {
  if (managed === undefined && record === null) {
    // Unreachable through the merge (each half feeds the ids it owns);
    // fail loudly on wiring bugs rather than serializing an id-less view.
    throw new TypeError('accountView: one of managed config or storage record is required');
  }
  const hasKey = managed?.keyConfigured ?? false;
  return {
    // The guard above makes `record` the id source exactly when `managed`
    // is absent, so the non-null assertions are covered — the house
    // `split('?')[0]!` shape.
    id: managed?.id ?? record!.id,
    providerId: managed?.providerId ?? record!.providerId,
    label: managed?.label ?? record!.label,
    enabled: managed?.enabled ?? false,
    status: record?.status ?? 'active',
    hasKey,
    keySource: managed?.keySource ?? 'none',
    keyMask: hasKey ? ACCOUNT_KEY_MASK : null,
    planName: record?.planName ?? null,
    createdAt: record?.createdAt ?? null,
    archivedAt: record?.archivedAt ?? null,
  };
}

/**
 * Merges the configured accounts with the storage rows into the §13 list —
 * the union keyed by id (an archived account stays listed with its history
 * retained, §8.2; a configured account stays listed before its row
 * exists), id-ascending so the response is deterministic.
 */
export function mergeAccountViews(
  managed: ReadonlyArray<ManagedAccountConfig>,
  records: ReadonlyArray<AccountRecord>,
): ReadonlyArray<AccountView> {
  const rowsById = new Map(records.map((record) => [record.id, record]));
  const views = new Map<string, AccountView>();
  for (const entry of managed) {
    views.set(entry.id, accountView(entry, rowsById.get(entry.id) ?? null));
  }
  for (const record of records) {
    if (!views.has(record.id)) {
      views.set(record.id, accountView(undefined, record));
    }
  }
  // Ids are unique in the map, so the two-valued comparator is a total
  // order over the entries it sees.
  return [...views.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/* ── Connection-test classification (D-052's kinds as §13 data) ────────── */

/**
 * Reads the provider-neutral credential-check discriminant off a thrown
 * value: `CredentialCheckError.kind` is the structural vocabulary the
 * adapter contract exposes precisely for consumers that cannot import
 * adapter types (`src/providers/zai-coding-plan/validate.ts`, D-052).
 * Anything else — no `kind`, an unknown literal, or a non-string `message`
 * — resolves `null`, and the caller rethrows: unknown provenance belongs
 * to the §13 INTERNAL envelope, never to the 200 test-result shape
 * (D-113's strict-classification rule applied at the endpoint).
 */
function credentialCheckKind(
  error: unknown,
): 'credentials-rejected' | 'provider-unavailable' | null {
  if (typeof error !== 'object' || error === null) return null;
  const kind = (error as { readonly kind?: unknown }).kind;
  if (kind !== 'credentials-rejected' && kind !== 'provider-unavailable') return null;
  return typeof (error as { readonly message?: unknown }).message === 'string' ? kind : null;
}

/* ── Route handlers' shared lookups ────────────────────────────────────── */

/**
 * The refusal for a mutation aimed at an archived account: §8.2's archive
 * is terminal (D-061 named reactivation out of scope), so the request is
 * understood but refused — FORBIDDEN with the stable reason, never a 404
 * lie about an account the list still shows.
 */
function refuseArchived(): never {
  throw new ApiError('FORBIDDEN', {
    message: 'The account is archived and can no longer be modified',
    details: { reason: 'account-archived' },
  });
}

/** The stable unknown-account refusal (404, the registry's default shape). */
function refuseUnknownAccount(): never {
  throw new ApiError('NOT_FOUND', { message: 'Account not found' });
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers the five §13 accounts routes inside the `/api` scope. The
 * scope's three guards (Origin, custom-header/content-type, §15.1
 * auth-mode — tasks 149/150/152) apply to everything registered here by
 * fastify's hook encapsulation, so these routes are CSRF-screened and
 * authentication-gated exactly like the rest of `/api`; none of them is
 * public (no `PUBLIC_AUTH_ROUTE_CONFIG` — only health is, §13).
 */
export const accountRoutes: FastifyPluginAsync<AccountsRouteOptions> = async (fastify, options) => {
  const { store, repository, registry, now } = options;

  // Strict schema validation, scoped to these routes (D-128): fastify's
  // shared Ajv carries `removeAdditional: true`, which silently strips
  // unknown fields — a create payload smuggling `apiKeyEnv` alongside the
  // declared fields would be accepted with the smuggled key ignored. §13's
  // boundary rejects it: unknown/malformed payloads answer the VALIDATION
  // envelope. This scope-local compiler turns the stripping default off
  // (the config layer's own no-removeAdditional discipline, D-018) while
  // re-asserting the framework's remaining defaults — `coerceTypes:
  // 'array'` keeps the query boolean coercion (`?purgeHistory=true`),
  // `useDefaults`/`allErrors` keep fastify's behavior — so the only change
  // is that closed objects are enforced instead of trimmed. Scope-local by
  // design: the rest of the API keeps the framework default until a
  // construction-level decision changes it for everyone.
  const strictValidator = new Ajv2020({
    removeAdditional: false,
    coerceTypes: 'array',
    useDefaults: true,
    allErrors: true,
    addUsedSchema: false,
  });
  fastify.setValidatorCompiler((definition) => strictValidator.compile(definition.schema));

  fastify.get(
    '/accounts',
    {
      // §13: response defined by schema; the closed object is the
      // structural no-key-leak guard (see the module docblock).
      schema: { response: { 200: AccountsListResponseSchema } },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { accounts: mergeAccountViews(await store.list(), repository.listAccounts()) };
    },
  );

  fastify.post(
    '/accounts',
    {
      schema: {
        body: CreateAccountBodySchema,
        response: { 201: AccountViewSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as CreateAccountBody;
      // A whitespace-only key is not a credential (the D-011 blank rule;
      // secrets are never trimmed — the check rejects, it does not strip).
      if (body.apiKey !== undefined && body.apiKey.trim() === '') {
        throw new ApiError('VALIDATION', {
          message: 'apiKey must not be blank',
          details: { reason: 'blank-api-key', field: 'apiKey' },
        });
      }
      if (!registry.has(body.providerId)) {
        throw new ApiError('VALIDATION', {
          message: 'Unknown provider',
          details: { reason: 'unknown-provider', field: 'providerId' },
        });
      }
      // The id: client-supplied (validated against the §6.2 charset by the
      // body schema) or generated — stable from creation on either way.
      const id = body.id ?? `acc-${randomBytes(8).toString('hex')}`;
      if (repository.getAccount(id) !== null || (await store.find(id)) !== null) {
        throw new ApiError('VALIDATION', {
          message: 'An account with this id already exists',
          details: { reason: 'duplicate-account-id', field: 'id' },
        });
      }
      const enabled = body.enabled ?? true;
      // Storage row first, configuration entry second: the facade insert
      // is synchronous and a just-created row carries no history, so a
      // failing configuration write has a total compensation (deleteAccount)
      // — the reverse order would leave a configured account whose every
      // collection fails on the missing row. Accepted residual (review
      // round, declined with reasons): the duplicate pre-check above is
      // two steps, so two truly concurrent creates with one client id
      // race through it and the loser answers INTERNAL over the driver's
      // raw constraint error instead of the 400 duplicate class — mapping
      // it would mean message-matching SQLite's wording, a fragile
      // contract D-058 keeps out of the facade, and the single-user §15.1
      // service has no second operator to hold the window open.
      repository.insertAccount({
        id,
        providerId: body.providerId,
        label: body.label,
        createdAt: now(),
      });
      try {
        await store.add({
          id,
          providerId: body.providerId,
          label: body.label,
          enabled,
          apiKey: body.apiKey,
        });
      } catch (error) {
        repository.deleteAccount(id);
        throw error;
      }
      const managed: ManagedAccountConfig = {
        id,
        providerId: body.providerId,
        label: body.label,
        enabled,
        keyConfigured: body.apiKey !== undefined,
        keySource: 'file',
      };
      reply.header('cache-control', 'no-store').code(201);
      return accountView(managed, repository.getAccount(id));
    },
  );

  fastify.patch(
    '/accounts/:id',
    {
      schema: {
        params: AccountIdParamsSchema,
        body: UpdateAccountBodySchema,
        response: { 200: AccountViewSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { readonly id: string };
      const body = request.body as UpdateAccountBody;
      if (body.apiKey !== undefined && body.apiKey.trim() === '') {
        throw new ApiError('VALIDATION', {
          message: 'apiKey must not be blank',
          details: { reason: 'blank-api-key', field: 'apiKey' },
        });
      }
      // The lifecycle owner refuses first: an archived account is not
      // patchable (D-061 — no reactivation), and the store entry the
      // archive removed means the update below would 404 anyway.
      const record = repository.getAccount(id);
      if (record?.status === 'archived') refuseArchived();
      const current = await store.find(id);
      if (current === null) refuseUnknownAccount();
      // §6.3: environment-defined values are read-only in the UI/API — the
      // environment is the operator's channel, a request body is not.
      if (body.apiKey !== undefined && current.keySource === 'environment') {
        throw new ApiError('FORBIDDEN', {
          message: 'The API key is supplied by the environment and cannot be changed here',
          details: { reason: 'environment-key-read-only' },
        });
      }
      const updated = await store.update(id, body);
      if (updated === null) refuseUnknownAccount();
      // The row's label is a denormalized mirror for history views; the
      // configuration (above) is the truth. A missing row (a configured
      // account not yet mirrored) is not an error — the mirror lands with
      // the config-sync.
      if (body.label !== undefined) {
        repository.updateAccountDetails(id, { label: body.label });
      }
      reply.header('cache-control', 'no-store');
      return accountView(updated, repository.getAccount(id));
    },
  );

  fastify.delete(
    '/accounts/:id',
    {
      schema: {
        params: AccountIdParamsSchema,
        querystring: DeleteAccountQuerySchema,
        response: { 200: AccountMutationResultSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { readonly id: string };
      const query = request.query as { readonly purgeHistory?: boolean };
      const managed = await store.find(id);
      if (query.purgeHistory === true) {
        // §8.2's separate explicit action (§13's `?purgeHistory=true`
        // spelling): delete the row and let the schema's cascading foreign
        // keys take every history table — through the landed lifecycle
        // module, which also reports what was removed (D-061).
        const outcome = purgeAccount(repository, id);
        // Unknown is a BOTH-halves verdict (the review round's P1): a
        // configuration entry without a row (a hand-edited account the
        // config-sync has not mirrored, or the residue of a purge whose
        // entry-removal failed) is an account this API lists and must be
        // able to purge — 404 only when neither half knows the id.
        if (outcome.result === 'unknown' && managed === null) refuseUnknownAccount();
        // The configuration entry must not outlive the account (a ghost
        // entry would keep answering "configured" for a purged id); a
        // removal failure surfaces as INTERNAL after the destructive half
        // succeeded — the operator's retry reaches this same removal (the
        // row is gone; `managed` still resolves), and the server-side log
        // (the INTERNAL class is the one that logs, D-113) carries the
        // cause.
        await store.remove(id);
        reply.header('cache-control', 'no-store');
        return {
          result: 'purged',
          account:
            outcome.result === 'unknown'
              ? accountView(managed, null)
              : accountView(managed, outcome.account),
          removed: outcome.result === 'unknown' ? EMPTY_PURGED_HISTORY_COUNTS : outcome.removed,
        };
      }
      // §8.2's default: archive, keep every history row. The storage row is
      // the lifecycle owner; the configuration entry is removed so polling
      // stops — `already-archived` (the idempotent re-archive, D-061)
      // removes nothing new. Unknown is the same both-halves verdict as
      // above: an entry without a row is archived by its removal alone.
      const outcome = retireAccount(repository, { accountId: id, archivedAt: now() });
      if (outcome.result === 'unknown' && managed === null) refuseUnknownAccount();
      await store.remove(id);
      reply.header('cache-control', 'no-store');
      if (outcome.result === 'unknown') {
        // A configuration-only account: no row ever existed, so the entry
        // removal IS the archive.
        return { result: 'archived', account: accountView(managed, null), removed: null };
      }
      return {
        result: outcome.result,
        account: accountView(managed, outcome.account),
        removed: null,
      };
    },
  );

  fastify.post(
    '/accounts/:id/test',
    {
      schema: {
        params: AccountIdParamsSchema,
        response: { 200: AccountTestResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { readonly id: string };
      const record = repository.getAccount(id);
      const managed = await store.find(id);
      if (record === null && managed === null) refuseUnknownAccount();
      if (record?.status === 'archived') refuseArchived();
      if (managed === null || !managed.keyConfigured) {
        // §7.3's `Not configured` as the endpoint's honest refusal: the
        // test exists to check a key, and there is none to check.
        throw new ApiError('FORBIDDEN', {
          message: 'No API key is configured for this account',
          details: { reason: 'no-key-configured' },
        });
      }
      // `resolvedKey`, not `secret`: the value is compared, never echoed —
      // and the lint rule's vocabulary is name-triggered.
      const resolvedKey = await store.secretOf(id);
      if (resolvedKey === null) {
        // Configured source, unresolvable value (an `apiKeyEnv` name the
        // server environment does not carry — the D-112 residual, on the
        // service side): the check cannot run, which is §7.2's
        // inconclusive class, not a refusal.
        reply.header('cache-control', 'no-store');
        return {
          outcome: 'unavailable',
          message: 'the configured API key source resolved to no value',
        } satisfies AccountTestResponse;
      }
      // The registry's branded context: the secret is non-enumerable and
      // the object frozen, so it cannot ride into a log line (§15.4).
      const context = createAccountContext(id, managed.label, resolvedKey);
      const providerId = managed.providerId;
      let provider: QuotaProvider;
      try {
        provider = registry.get(providerId);
      } catch {
        // An account naming a provider this build does not carry (the
        // D-119 doctor case): inconclusive, never a crash.
        reply.header('cache-control', 'no-store');
        return {
          outcome: 'unavailable',
          message: `the account's provider '${providerId}' is not available in this build`,
        } satisfies AccountTestResponse;
      }
      try {
        // Bounded by the provider transport's own §7.2 deadline (D-042);
        // no second race here would add a bound, only duplicate one.
        await provider.validateCredentials(context);
      } catch (error) {
        const kind = credentialCheckKind(error);
        if (kind === null) throw error;
        reply.header('cache-control', 'no-store');
        return {
          outcome: kind === 'credentials-rejected' ? 'rejected' : 'unavailable',
          message: (error as Error).message,
        } satisfies AccountTestResponse;
      }
      reply.header('cache-control', 'no-store');
      return { outcome: 'ok' } satisfies AccountTestResponse;
    },
  );
};
