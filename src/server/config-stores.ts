/**
 * Production configuration stores over the config file (spec §6.2–§6.4,
 * §13, §15.2; task U-040, decisions D-128, D-130, D-140; the password
 * revocation order of the settings half is D-184).
 *
 * The consumer-owned seams the route families defined — `AccountConfigStore`
 * (task 159, D-128) and `SettingsStore` (task 160, D-130) — implemented by
 * the layer that owns the file, exactly as both decisions recorded: a
 * read-modify-write over the RAW file JSON validated before every write and
 * applied through §6.4's reload, so the last valid configuration stays
 * effective when anything refuses (spec §6.2). The one {@link ConfigFileOwner}
 * serializes every mutation of both stores — accounts and settings edit the
 * same file, and two interleaved read-modify-writes would clobber each
 * other's section.
 *
 * Why the RAW file JSON and not the effective configuration is the base:
 * the effective object is the environment-merged view (D-023) — persisting
 * it verbatim would bake `QUOTAMETER_*` values into `config.json`, the
 * write-side hazard D-130 pinned — and defaults-completion would materialize
 * sections the operator deliberately left minimal. Mutations therefore start
 * from the file as it lies, touch only the section they own, and hand the
 * candidate to `parseConfigWithEnv` (the exact reload pipeline) before any
 * byte is written: a mutation that would break the effective configuration
 * is refused without touching the file.
 *
 * The settings half's `read` also serves §11.3's applied-retention
 * reference (U-053, D-178): the `retention:applied-days` storage marker,
 * read through the repository — the one storage fact the settings surface
 * needs, beside the configuration facts.
 */

import { readFile } from 'node:fs/promises';
import { parseJson } from '../config/load';
import { parseConfigWithEnv } from '../config/env';
import type { EffectiveConfig, ReloadResult, ReloadSuccess } from '../config/reload';
import { writeConfigFile } from '../config/write';
import { hashPassword } from '../services/password-hash';
import type { QuotaRepository } from '../storage/repository';
import { RETENTION_APPLIED_DAYS_KEY } from '../storage/retention-cleanup';
import type { Logger } from '../util/logger';
import type { AccountConfigStore, ManagedAccountConfig } from './api/accounts';
import type { SettingsSnapshot, SettingsStore } from './api/settings';
import type { EnvOverrideField } from '../config/env';
import type { AccountConfig, Config } from '../schemas/config';

/* ── The serialized file owner ──────────────────────────────────────────── */

/** Options of {@link createConfigFileOwner}. */
export interface ConfigFileOwnerOptions {
  /** Path of the configuration file. */
  readonly targetPath: string;
  /**
   * The environment snapshot the pipeline merges with (D-023) — the same
   * snapshot the reloader judges reloads against, so a candidate validates
   * exactly as its reload will see it.
   */
  readonly env: NodeJS.ProcessEnv;
  /** The effective configuration (the reloader's `current()`). */
  readonly effective: () => EffectiveConfig;
  /**
   * §6.4's change application — the composition-wrapped reload (the
   * config-sync rides it), never a bare `reloader.reload()`.
   */
  readonly reload: () => Promise<ReloadResult>;
  /** Diagnostics sink; absent in state-only tests. */
  readonly logger?: Logger;
}

/** The serialized read-modify-write discipline over one configuration file. */
export interface ConfigFileOwner {
  /** The file this owner mutates. */
  readonly targetPath: string;
  /** The environment snapshot merges and validations run against. */
  readonly env: NodeJS.ProcessEnv;
  /** The effective configuration at read time. */
  effective(): EffectiveConfig;
  /**
   * Runs one serialized read-modify-write: reads the raw file JSON, hands
   * the (freshly parsed, privately held) object to `mutation` — which edits
   * in place and reports whether anything changed — validates the changed
   * candidate through the pipeline, writes it atomically (D-016) when it
   * changed, and applies §6.4 through the injected reload either way (the
   * §6.4 outcome of a no-change mutation is still the reload's answer).
   * Rejects when the candidate is invalid, the write fails, or the reload is
   * rejected — the incumbent stays effective (§6.2) — so the resolved value
   * is always the successful reload.
   */
  mutate(mutation: (file: Record<string, unknown>) => boolean): Promise<ReloadSuccess>;
}

/**
 * Reads the raw file content as parsed JSON. An absent file reads `{}` —
 * the env-only mode's sanctioned shape (D-023: the environment alone builds
 * the effective configuration), and the base a first write starts from.
 * Malformed JSON and non-object roots reject: a read-modify-write over a
 * broken file must not "repair" it by silently replacing content.
 */
async function readRawConfig(targetPath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(targetPath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {};
    throw new Error(
      `cannot read configuration file ${targetPath}: ${
        isErrnoException(error) ? error.code : describeError(error)
      }`,
      { cause: error },
    );
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new Error(`cannot modify configuration file ${targetPath}: ${parsed.problems[0]}`);
  }
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new Error(
      `cannot modify configuration file ${targetPath}: the top level is not a JSON object`,
    );
  }
  return parsed.value as Record<string, unknown>;
}

/** Distinguishes code-carrying filesystem errors from other rejections. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** Error text without ever echoing file content. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The serialized mutation queue — the reloader's own serialization shape:
 * every mutation waits for its predecessor, and each reads the file itself,
 * in invocation order. A rejection never breaks the chain.
 */
function createMutationQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Creates the file owner both stores share. */
export function createConfigFileOwner(options: ConfigFileOwnerOptions): ConfigFileOwner {
  const enqueue = createMutationQueue();
  return {
    targetPath: options.targetPath,
    env: options.env,
    effective: options.effective,
    mutate(mutation) {
      return enqueue(async (): Promise<ReloadSuccess> => {
        const file = await readRawConfig(options.targetPath);
        const changed = mutation(file);
        if (changed) {
          const validated = parseConfigWithEnv(file, options.env);
          if (!validated.ok) {
            throw new Error(
              `refusing to persist an invalid configuration change: ${validated.problems.join('; ')}`,
            );
          }
          await writeConfigFile(options.targetPath, file);
        }
        const result = await options.reload();
        if (!result.ok) {
          throw new Error(
            'configuration reload rejected after the mutation (the last valid configuration ' +
              `stays effective): ${result.problems.join('; ')}`,
          );
        }
        if (changed) {
          options.logger?.info('configuration file changed through the API', {
            targetPath: options.targetPath,
            applied: result.applied,
            restartRequired: result.restartRequired,
          });
        }
        return result;
      });
    },
  };
}

/* ── The accounts half (D-128's seam over the real file) ───────────────── */

/** One raw `accounts` entry as the file holds it — unknown fields, mutable. */
interface RawAccountEntry {
  id?: unknown;
  providerId?: unknown;
  label?: unknown;
  enabled?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
}

/** Narrows one raw entry; a non-object slot is the candidate validation's. */
function asRawEntry(value: unknown): RawAccountEntry | null {
  return value !== null && typeof value === 'object' ? (value as RawAccountEntry) : null;
}

/** Whether one raw entry carries exactly this (string) id. */
function rawEntryHasId(value: unknown, id: string): value is RawAccountEntry {
  const entry = asRawEntry(value);
  return entry !== null && entry.id === id;
}

/**
 * The raw `accounts` array of a file object, materialized when absent. A
 * present-but-not-array value is a broken file the candidate validation
 * would reject — surfacing it here keeps the mutation from writing over
 * content it did not read.
 */
function rawAccountsOf(file: Record<string, unknown>): RawAccountEntry[] {
  if (file.accounts === undefined) {
    file.accounts = [];
    return file.accounts as RawAccountEntry[];
  }
  if (!Array.isArray(file.accounts)) {
    throw new Error('configuration file accounts: expected an array');
  }
  return file.accounts as RawAccountEntry[];
}

/** Maps one effective (validated) account entry to the seam's view. */
function managedOf(entry: AccountConfig): ManagedAccountConfig {
  const keyConfigured = entry.apiKey !== undefined || entry.apiKeyEnv !== undefined;
  return {
    id: entry.id,
    providerId: entry.providerId,
    label: entry.label,
    // The canonical parser materializes `enabled`; the fallback keeps the
    // mapping total over the declared `Config` type (the settings-view
    // precedent).
    enabled: entry.enabled ?? true,
    keyConfigured,
    // 'none' for the §5.3 keyless skip path (D-140 (8)): no source is
    // configured, which is not the file's source.
    keySource: !keyConfigured ? 'none' : entry.apiKeyEnv !== undefined ? 'environment' : 'file',
  };
}

/**
 * The production `AccountConfigStore`: list/find/secretOf read the live
 * effective configuration (§6.4 — the account list is reload-live), and
 * add/update/remove are serialized read-modify-writes over the raw file
 * followed by §6.4's reload. `secretOf` resolves `apiKeyEnv` against the
 * composition's environment snapshot; an unset or empty name resolves
 * `null` (the D-011 empty-is-unset rule, the service-side D-112 residual).
 */
export function createConfigFileAccountStore(owner: ConfigFileOwner): AccountConfigStore {
  const effectiveAccounts = (): ReadonlyArray<AccountConfig> =>
    owner.effective().config.accounts ?? [];

  return {
    async list(): Promise<ReadonlyArray<ManagedAccountConfig>> {
      return effectiveAccounts().map(managedOf);
    },
    async find(id: string): Promise<ManagedAccountConfig | null> {
      const entry = effectiveAccounts().find((account) => account.id === id);
      return entry === undefined ? null : managedOf(entry);
    },
    async add(account) {
      await owner.mutate((file) => {
        const accounts = rawAccountsOf(file);
        if (accounts.some((entry) => rawEntryHasId(entry, account.id))) {
          // The id is client data, never a secret — safe to name (§15.4).
          throw new Error(`an account with id '${account.id}' already exists`);
        }
        const entry: Record<string, unknown> = {
          id: account.id,
          providerId: account.providerId,
          label: account.label,
          enabled: account.enabled,
        };
        if (account.apiKey !== undefined) entry.apiKey = account.apiKey;
        accounts.push(entry as RawAccountEntry);
        return true;
      });
    },
    async update(id, changes) {
      await owner.mutate((file) => {
        const raw = rawAccountsOf(file).find((entry) => rawEntryHasId(entry, id));
        if (raw === undefined) return false;
        if (changes.label !== undefined) raw.label = changes.label;
        if (changes.enabled !== undefined) raw.enabled = changes.enabled;
        if (changes.apiKey !== undefined) raw.apiKey = changes.apiKey;
        return true;
      });
      // The reloaded effective configuration is the canonical post-change
      // view (§6.4 applied it); read it back the same way `find` does. A
      // missing entry reads null — the route's unknown-account verdict.
      const updated = effectiveAccounts().find((account) => account.id === id);
      return updated === undefined ? null : managedOf(updated);
    },
    async remove(id: string): Promise<boolean> {
      let existed = false;
      await owner.mutate((file) => {
        const accounts = rawAccountsOf(file);
        if (!accounts.some((entry) => rawEntryHasId(entry, id))) return false;
        existed = true;
        file.accounts = accounts.filter((entry) => !rawEntryHasId(entry, id));
        return true;
      });
      return existed;
    },
    async secretOf(id: string): Promise<string | null> {
      const entry = effectiveAccounts().find((account) => account.id === id);
      if (entry === undefined) return null;
      if (entry.apiKey !== undefined) return entry.apiKey;
      if (entry.apiKeyEnv !== undefined) {
        const value = owner.env[entry.apiKeyEnv];
        return typeof value === 'string' && value !== '' ? value : null;
      }
      return null;
    },
  };
}

/* ── The settings half (D-130's seam over the real file) ───────────────── */

/** One §6.4-live scalar a settings PUT can change, with its file location. */
interface MutableSettingsField {
  /** The effective value at this field (canonical configurations only). */
  readonly read: (config: Config) => string | number | undefined;
  /** Writes the value into the raw file candidate's section. */
  readonly write: (file: Record<string, unknown>, value: string | number) => void;
  /** The pipeline's field path — also the environment-override key. */
  readonly path: EnvOverrideField;
}

/**
 * The §6.4-live scalars a settings PUT can change. The restart-requiring
 * trio and the structured sections (`accounts`, `providers`) are absent on
 * purpose: the endpoint refuses them (D-130), and the file keeps its own
 * values for everything this list omits.
 */
const MUTABLE_SETTINGS_FIELDS: ReadonlyArray<MutableSettingsField> = Object.freeze([
  {
    read: (config: Config) => config.app.timezone,
    write: (file: Record<string, unknown>, value: string | number) =>
      writeSectionField(file, 'app', 'timezone', value),
    path: 'app.timezone',
  },
  {
    read: (config: Config) => config.app.pollingIntervalSeconds,
    write: (file: Record<string, unknown>, value: string | number) =>
      writeSectionField(file, 'app', 'pollingIntervalSeconds', value),
    path: 'app.pollingIntervalSeconds',
  },
  {
    read: (config: Config) => config.app.historyRetentionDays,
    write: (file: Record<string, unknown>, value: string | number) =>
      writeSectionField(file, 'app', 'historyRetentionDays', value),
    path: 'app.historyRetentionDays',
  },
  {
    read: (config: Config) => config.logging?.level,
    write: (file: Record<string, unknown>, value: string | number) =>
      writeSectionField(file, 'logging', 'level', value),
    path: 'logging.level',
  },
]);

/** Writes one scalar into a raw file section, refusing a non-object slot. */
function writeSectionField(
  file: Record<string, unknown>,
  section: string,
  field: string,
  value: string | number,
): void {
  const existing = file[section];
  if (existing !== undefined && (existing === null || typeof existing !== 'object')) {
    throw new Error(
      `configuration file ${section}: expected a JSON object (refusing to overwrite)`,
    );
  }
  file[section] = { ...(existing as Record<string, unknown>), [field]: value };
}

/** Options of {@link createConfigFileSettingsStore}. */
export interface ConfigFileSettingsStoreOptions {
  /**
   * The session store — a password change revokes every session BEFORE
   * the configuration write (§15.2, the fail-secure order of D-184).
   */
  readonly repository: QuotaRepository;
  /** The data directory of the §14.5 read-only paths block. */
  readonly dataDir: string;
}

/**
 * Reads §11.3's reduce-retention warning reference from storage: the
 * retention window the last completed cleanup applied
 * (`retention:applied-days`, written by every `runRetentionCleanup` —
 * D-063). Absent (no cleanup yet) reads `null`; a value that does not
 * parse as an integer reads `null` too — fail-soft by design (D-178): the
 * marker is a display annotation, and a corrupted marker must not take
 * the settings page down with it (the cleanup rewrites it on its next
 * run, which is also the repair).
 */
export function appliedRetentionDaysOf(repository: QuotaRepository): number | null {
  const raw = repository.getMetaValue(RETENTION_APPLIED_DAYS_KEY);
  if (raw === null) return null;
  const trimmed = raw.trim();
  // §11.3's own 7–3650 bounds make any negative (or non-integer) marker
  // corrupt by construction — the cleanup only ever writes in-range days.
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The production `SettingsStore`. `read` serves the effective configuration
 * with its environment marking; `apply` persists only the mutable scalars
 * the request ATTEMPTED (the payload's `attempted` set — a change validated
 * against an older snapshot cannot revert a field a concurrent request
 * already applied, the write-side twin of `sources`) — never an
 * environment-supplied field (D-130's write-side obligation: those stay the
 * environment's, so unsetting the variable cannot reveal a baked-in copy),
 * never a section the PUT cannot own (accounts, providers, server,
 * auth.mode), and the password hash only ever from a fresh `hashPassword`
 * of the supplied plaintext (the effective hash is not copied back, so a
 * concurrent `passwd` write survives). A password change revokes every
 * session BEFORE the configuration mutation — the fail-secure order of
 * D-184, `quotameter passwd`'s recorded reasoning (§15.2/D-124), with
 * the shared rationale documented once in
 * `docs/security/password-change-revocation.md`: a failed revocation
 * refuses the change with nothing written, and a mutation failing after
 * a successful revocation is rethrown with the revocation stated
 * arm-true (sessions gone, the running service keeps the current
 * password, the file's state named as uncertain because a rejected
 * reload leaves it ahead of memory).
 */
export function createConfigFileSettingsStore(
  owner: ConfigFileOwner,
  options: ConfigFileSettingsStoreOptions,
): SettingsStore {
  return {
    async read(): Promise<SettingsSnapshot> {
      const current = owner.effective();
      return {
        config: current.config,
        sources: current.sources,
        paths: { configPath: owner.targetPath, dataDir: options.dataDir },
        appliedRetentionDays: appliedRetentionDaysOf(options.repository),
      };
    },
    async apply(change) {
      // Hashing is this store's own obligation (D-130) and is async — it
      // runs before the serialized mutation, which only places the result.
      const passwordHash =
        change.pendingPassword === undefined
          ? undefined
          : await hashPassword(change.pendingPassword);
      // Fail-secure order (§15.2, D-184 — `quotameter passwd`'s reasoning,
      // now shared by both password-change paths): revoke first, write
      // second. The reverse order's failed-revocation arm would leave the
      // NEW hash effective with every old session still valid — the exact
      // state "changing the password revokes all sessions" forbids — so a
      // failed revocation refuses the whole change: nothing is queued,
      // nothing written, the incumbent hash and its sessions stay coherent.
      // The revocation deliberately runs OUTSIDE the file owner's queue:
      // it is a synchronous storage call needing no atomicity with the
      // write (every interleaving is fail-secure), and the mutation
      // callback stays a pure file edit.
      let revokedSessions = 0;
      if (passwordHash !== undefined) {
        try {
          revokedSessions = options.repository.deleteAllSessions();
        } catch (error) {
          throw new Error(
            'revoking the sessions failed (the password change was refused, ' +
              `nothing was written): ${describeError(error)}`,
            { cause: error },
          );
        }
      }
      let result: ReloadSuccess;
      try {
        result = await owner.mutate((file) => {
          let wrote = false;
          for (const field of MUTABLE_SETTINGS_FIELDS) {
            // Only what the request attempted is a write candidate: a change
            // validated against an older snapshot must not revert a field a
            // concurrent request already applied (the `sources` payload's
            // write-side twin, D-140)…
            if (!change.attempted.includes(field.path)) continue;
            // …and the environment's fields are never file-written (D-130):
            // the file keeps its own values, so unsetting the variable cannot
            // be silently replaced by a baked-in copy.
            if (change.sources.fields.includes(field.path)) continue;
            const next = field.read(change.config);
            // An undefined read cannot be expressed by the PUT (the boundary
            // returns canonical, defaults-completed configurations) — writing
            // it would silently delete the field from the file, so it is
            // skipped.
            if (next === undefined) continue;
            field.write(file, next);
            wrote = true;
          }
          if (passwordHash !== undefined) {
            const auth = file.auth;
            if (auth !== undefined && (auth === null || typeof auth !== 'object')) {
              throw new Error(
                'configuration file auth: expected a JSON object (refusing to overwrite)',
              );
            }
            file.auth = { ...(auth as Record<string, unknown>), passwordHash };
            wrote = true;
          }
          return wrote;
        });
      } catch (error) {
        // The safe-direction residual, reported exactly and arm-true: the
        // revocation already happened and the change did not become
        // effective. What the file holds depends on WHERE the mutation
        // failed — a refused candidate or a failed atomic write leaves it
        // untouched, a rejected reload leaves it AHEAD (the new hash
        // written, §6.2's incumbent effective until a later reload adopts
        // it) — so the annotation states the one truth every arm shares
        // (the running service keeps the current password) beside the
        // uncertainty (the file may already hold the new hash). Only when
        // sessions were actually deleted; a zero-count revocation lost
        // nothing and rethrows bare.
        if (revokedSessions > 0) {
          const noun = revokedSessions === 1 ? 'session' : 'sessions';
          throw new Error(
            `${describeError(error)} (the password change did not complete, but ` +
              `${revokedSessions} stored ${noun} had already been revoked — the running ` +
              'service keeps the current password, and the configuration file may ' +
              'already hold the new hash, which a later reload would apply)',
            { cause: error },
          );
        }
        throw error;
      }
      return { applied: result.applied, restartRequired: result.restartRequired };
    },
  };
}
