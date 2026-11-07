/**
 * The §13 settings endpoints (task 160, spec §13, §6.2–§6.4, §14.5, §15.2;
 * decision D-130).
 *
 * The safe settings view (`GET /settings`) and the runtime-modification
 * update (`PUT /settings`) — the §6.4 seam the web settings page renders
 * from. Like the accounts surface (D-128), the configuration half is an
 * injected seam because no runtime configuration-mutation service exists
 * yet: {@link SettingsStore} is defined here, at the consumer, exactly as
 * D-121 defined `RequestAuthenticator` — the routes are complete and fully
 * tested against the seam (an in-memory double in the suite), and the
 * composition task that owns the configuration file implements it over the
 * reloader's effective configuration, the atomic `writeConfigFile`, and
 * §6.4's change application.
 *
 * The GET discipline is §13's own sentence — "secrets omitted/masked": no
 * view object declares a secret field, the auth half carries
 * `passwordConfigured` (the mask-and-boolean pattern), and the closed
 * serializer contract drops anything else (D-111, generalized since
 * D-128). Every scalar is annotated with its §6.4 class and §6.3 source
 * (`source: 'environment'` is the read-only marking), so the UI renders
 * labels without re-deriving precedence (D-023's standing instruction).
 * Since U-053 (D-178) the GET response also carries
 * `appliedRetentionDays` — §11.3's reduce-retention warning reference,
 * read from the storage marker the cleanup writes; `null` before the
 * first completed cleanup.
 *
 * The PUT scope is §13's "Update settings allowed for runtime moderation"
 * read literally (D-130): the §6.4 live-applicable vocabulary is updatable;
 * the restart-requiring trio (`server.host`, `server.port`, `auth.mode`) is
 * **refused** with a stable reason — those settings change through the
 * configuration file plus `quotameter restart` (§6.4's own remedy; a
 * running process cannot rebind its listener, and the UI cannot restart
 * it), and the GET view's `restartRequired` markings identify them (the
 * task's done-condition). Environment-overridden fields are refused the
 * same way (§6.3 — the environment is the operator's channel, the twin of
 * the accounts surface's `environment-key-read-only`), and so is a
 * supplied `auth.passwordHash` (D-022: the plaintext `auth.password` is
 * the one sanctioned channel; a client-settable hash would let an
 * operator lock themselves out with a password nobody knows). Validation
 * then runs through the D-022 boundary — `validateSettings(body, base)` →
 * `parseConfig` — so every range, enum, and cross-field rule is enforced
 * by the same parser the loader uses, with its field-addressed,
 * value-free problems as the 400 details. A valid update reaches the seam
 * carrying D-022's `pendingPassword` for the composition to hash
 * (`auth.passwordHash` never passes through this endpoint in either
 * direction), and the response reports the outcome in D-026's vocabulary:
 * the live fields this change activated, and the restart-requiring fields
 * still pending against the process's startup configuration — a hand-edited
 * file change this update's reload carries, never this request's doing.
 *
 * Error vocabulary stays inside D-113's registry (no new codes): the three
 * refusals are FORBIDDEN (403, "understood but refused" — the 159 pattern)
 * with stable `details.reason` values; validation problems are VALIDATION
 * (400) with `details.problems`; a store failure escalates to the generic
 * INTERNAL envelope, logged server-side.
 */

import type { FastifyPluginAsync } from 'fastify';
import { ApiError } from './error';
import { strictValidatorCompiler } from './validation';
import {
  RESTART_REQUIRED_FIELDS,
  type LiveReloadField,
  type RestartRequiredField,
} from '../../config/reload';
import type { EnvironmentSources, EnvOverrideField } from '../../config/env';
import { validateSettings } from '../../services/config-validation';
import { CONFIG_DEFAULTS, type Config } from '../../schemas/config';
import type { Validated } from '../../schemas/boundary';
import {
  SettingsResponseSchema,
  UpdateSettingsBodySchema,
  UpdateSettingsResponseSchema,
  type SettingsPaths,
  type SettingsSource,
  type SettingsView,
  type UpdateSettingsBody,
} from '../../schemas/api/settings';

/* ── The configuration-side seam (the D-121 pattern: define at the consumer) ─ */

/** What the settings endpoint reads from the running configuration. */
export interface SettingsSnapshot {
  /** The effective configuration — the last valid load (D-026's `current()`). */
  readonly config: Validated<Config>;
  /** Which effective settings the environment supplies (§6.3, D-023). */
  readonly sources: EnvironmentSources;
  /** The read-only §14.5 display paths. */
  readonly paths: SettingsPaths;
  /**
   * The retention window the last completed cleanup applied, read from
   * the `retention:applied-days` marker (§11.3, D-063/D-178) — `null`
   * before any cleanup has completed. The reduce-retention warning's
   * reference: the records between a smaller configured window and this
   * applied one are exactly what the next cleanup deletes.
   */
  readonly appliedRetentionDays: number | null;
}

/**
 * What applying a validated update means, in D-026's vocabulary: the §6.4
 * live fields the change activated (the reload's `applied` diff) and the
 * restart-requiring fields still differing from the startup configuration
 * (the reload's `restartRequired` diff).
 */
export interface SettingsApplyOutcome {
  readonly applied: readonly LiveReloadField[];
  readonly restartRequired: readonly RestartRequiredField[];
}

/**
 * The configuration read/write-reload seam — the D-121/D-128 precedent:
 * the endpoints are complete against this interface, and the composition
 * root implements it over `loadConfigWithEnv`/atomic `writeConfigFile` and
 * §6.4's change application. `apply` receives the **validated** post-change
 * effective configuration this endpoint produced through the D-022
 * boundary (base sections the body omitted are already merged in, so
 * stored account secrets and provider schedules survive a settings PUT —
 * D-022's GET-then-PUT warning honored structurally), plus the plaintext
 * password when one was supplied: hashing it into `auth.passwordHash`
 * (§15.2, `hashPassword`) and revoking sessions on change are the
 * composition's and the future auth service's business, never this
 * endpoint's.
 *
 * The `sources` half of the payload is the write-side obligation
 * (review round P2): the configuration handed over is the
 * **environment-merged** effective one (D-023), so an implementation that
 * persists it verbatim would bake `QUOTAMETER_*` values into the file —
 * after the operator unsets the variable, the file would keep a value the
 * environment alone was meant to own. The implementation must exclude
 * every `sources.fields` path from the file write (the effective
 * configuration is the in-memory truth; the file keeps its own values for
 * those fields).
 */
export interface SettingsStore {
  /** The effective configuration, its environment marking, and the paths. */
  read(): Promise<SettingsSnapshot>;
  /**
   * Persists and applies a validated change; resolves the §6.4 outcome. A
   * rejected promise means the write or reload failed — the incumbent
   * configuration stays effective (§6.2) and the endpoint answers INTERNAL —
   * or, for a password change, one of the revocation's two arms (§15.2's
   * fail-secure order, D-184): the pre-write revocation itself failed
   * (nothing was written; the incumbent hash stays effective with its
   * sessions coherent), or the revocation succeeded and the change then
   * failed (the incumbent hash stays effective, but every stored session is
   * gone — the operator must sign in again with the current password).
   *
   * `attempted` carries the fields the request body actually supplied (the
   * write-side twin of `sources`, D-140): the implementation persists only
   * what a PUT attempted, so a change validated against an older snapshot
   * cannot silently revert a field a concurrent request already applied.
   */
  apply(change: {
    readonly config: Config;
    readonly pendingPassword: string | undefined;
    /** Which effective fields the environment supplies — never file-written. */
    readonly sources: EnvironmentSources;
    /** Which fields the request body supplied — the only file-write candidates. */
    readonly attempted: readonly EnvOverrideField[];
  }): Promise<SettingsApplyOutcome>;
}

/** What the `/api` scope passes to {@link settingsRoutes}. */
export interface SettingsRouteOptions {
  /** The configuration-side settings store (the seam above). */
  readonly store: SettingsStore;
}

/* ── Pure view composition ─────────────────────────────────────────────── */

/**
 * The §6.3 provenance of one effective field: `'environment'` exactly when
 * the environment supplies it (D-023's marking), else `'file'`.
 */
function sourceOf(sources: EnvironmentSources, field: EnvOverrideField): SettingsSource {
  return sources.fields.includes(field) ? 'environment' : 'file';
}

/**
 * Builds the safe settings view (§13/§14.5): every scalar with its value,
 * provenance, and §6.4 class. The restart flags are fixed by the spec's
 * closed §6.4 list — `server.host`, `server.port`, `auth.mode` (D-026's
 * `RESTART_REQUIRED_FIELDS`), everything else live — and omitted optional
 * sections read the spec defaults (the parser materializes them; the
 * fallbacks keep this function total over the declared `Config` type, and
 * the unit suite exercises both shapes). Pure; the handler adds the
 * read-only paths block from the snapshot.
 */
export function settingsViewOf(config: Config, sources: EnvironmentSources): SettingsView {
  return {
    server: {
      host: {
        value: config.server?.host ?? CONFIG_DEFAULTS.server.host,
        source: sourceOf(sources, 'server.host'),
        restartRequired: true,
      },
      port: {
        value: config.server?.port ?? CONFIG_DEFAULTS.server.port,
        source: sourceOf(sources, 'server.port'),
        restartRequired: true,
      },
    },
    app: {
      timezone: {
        value: config.app.timezone,
        source: sourceOf(sources, 'app.timezone'),
        restartRequired: false,
      },
      pollingIntervalSeconds: {
        value: config.app.pollingIntervalSeconds ?? CONFIG_DEFAULTS.app.pollingIntervalSeconds,
        source: sourceOf(sources, 'app.pollingIntervalSeconds'),
        restartRequired: false,
      },
      historyRetentionDays: {
        value: config.app.historyRetentionDays ?? CONFIG_DEFAULTS.app.historyRetentionDays,
        source: sourceOf(sources, 'app.historyRetentionDays'),
        restartRequired: false,
      },
    },
    auth: {
      mode: {
        value: config.auth?.mode ?? CONFIG_DEFAULTS.auth.mode,
        source: sourceOf(sources, 'auth.mode'),
        restartRequired: true,
      },
      // §13's mask-and-boolean: the hash's presence, never its value.
      passwordConfigured: config.auth?.passwordHash !== undefined,
    },
    logging: {
      level: {
        value: config.logging?.level ?? CONFIG_DEFAULTS.logging.level,
        source: sourceOf(sources, 'logging.level'),
        restartRequired: false,
      },
    },
  };
}

/**
 * The field paths a PUT body attempts, in the wire vocabulary's canonical
 * order — the refusals below and the tests read this, so the attempted-set
 * is derived once. `auth.password` is deliberately absent: it is the one
 * sanctioned auth write, not a refusal candidate. The return type is
 * `EnvOverrideField` on purpose (review round P3): every attemptable field
 * is environment-overridable today and `RESTART_REQUIRED_FIELDS` is a
 * subset of it, so a unit row pins this list against `ENV_OVERRIDES`'s own
 * fields — a new body field or override that breaks the identity fails the
 * suite instead of silently narrowing the refusals.
 */
export function attemptedSettingsFields(body: UpdateSettingsBody): readonly EnvOverrideField[] {
  const fields: EnvOverrideField[] = [];
  if (body.server?.host !== undefined) fields.push('server.host');
  if (body.server?.port !== undefined) fields.push('server.port');
  if (body.app?.timezone !== undefined) fields.push('app.timezone');
  if (body.app?.pollingIntervalSeconds !== undefined) fields.push('app.pollingIntervalSeconds');
  if (body.app?.historyRetentionDays !== undefined) fields.push('app.historyRetentionDays');
  if (body.auth?.mode !== undefined) fields.push('auth.mode');
  if (body.logging?.level !== undefined) fields.push('logging.level');
  return fields;
}

/**
 * The free-text fields a body supplies blank-after-trim (the D-011 rule:
 * whitespace is never a value). D-022's boundary reads a blank as "not
 * supplied" — the right semantics for an interactive prompt's skipped
 * answer, but through the request body an explicit blank field is a client
 * mistake, and answering it with a success-shaped no-op would claim an
 * action that did not happen (a blank password "change" that keeps the old
 * password). The endpoint rejects them; the closed enums (`auth.mode`,
 * `logging.level`) cannot be blank by schema.
 */
export function blankAttemptedSettingsFields(body: UpdateSettingsBody): readonly string[] {
  const fields: string[] = [];
  if (body.server?.host !== undefined && body.server.host.trim() === '') fields.push('server.host');
  if (body.app?.timezone !== undefined && body.app.timezone.trim() === '') {
    fields.push('app.timezone');
  }
  if (body.auth?.password !== undefined && body.auth.password.trim() === '') {
    fields.push('auth.password');
  }
  return fields;
}

/* ── The refusals (D-113 classes, stable reasons) ───────────────────────── */

/**
 * The §6.3 refusal: environment-defined values are read-only in the UI/API
 * — the twin of the accounts surface's `environment-key-read-only` refusal.
 */
function refuseEnvironmentOverrides(fields: readonly string[]): never {
  throw new ApiError('FORBIDDEN', {
    message:
      'These settings are supplied by environment variables and cannot be changed here; ' +
      'change them in the service environment',
    details: { reason: 'environment-overridden-read-only', fields: [...fields] },
  });
}

/**
 * The §6.4 refusal (D-130): restart-requiring settings change through the
 * configuration file plus `quotameter restart` — the remedy §6.4 itself
 * prescribes for the UI to show beside them.
 */
function refuseRestartRequired(fields: readonly string[]): never {
  throw new ApiError('FORBIDDEN', {
    message:
      'These settings take effect only after a process restart; edit the configuration file ' +
      'and run quotameter restart',
    details: { reason: 'restart-required-field', fields: [...fields] },
  });
}

/** The D-022 refusal: the stored hash is never accepted; supply the password. */
function refusePasswordHash(): never {
  throw new ApiError('FORBIDDEN', {
    message: 'The stored password hash is never accepted or returned; supply auth.password instead',
    details: { reason: 'password-hash-not-settable' },
  });
}

/* ── The plugin ────────────────────────────────────────────────────────── */

/**
 * Registers the two §13 settings routes inside the `/api` scope. The
 * scope's three guards (Origin, custom-header/content-type, §15.1
 * auth-mode) apply by fastify's hook encapsulation — and §15.5's "settings
 * must not be writable without authentication where authentication is
 * required" is the auth guard's own method-blind rule (D-121), so the PUT
 * is exactly as guarded as the GET.
 */
export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (
  fastify,
  options,
) => {
  const { store } = options;

  // Strict schema validation, scoped to these routes (D-128, single
  // construction site in ./validation.ts): a smuggled extra field (an
  // `accounts` array, a `providers` schedule) answers the VALIDATION
  // envelope instead of being silently stripped — D-022's GET-then-PUT
  // secret-drop hazard cannot even form.
  fastify.setValidatorCompiler(strictValidatorCompiler());

  fastify.get(
    '/settings',
    {
      schema: { response: { 200: SettingsResponseSchema } },
    },
    async (_request, reply) => {
      const snapshot = await store.read();
      reply.header('cache-control', 'no-store');
      return {
        settings: settingsViewOf(snapshot.config, snapshot.sources),
        paths: snapshot.paths,
        appliedRetentionDays: snapshot.appliedRetentionDays,
      };
    },
  );

  fastify.put(
    '/settings',
    {
      schema: {
        body: UpdateSettingsBodySchema,
        response: { 200: UpdateSettingsResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as UpdateSettingsBody;
      const snapshot = await store.read();
      // A supplied-but-blank value is a client mistake, not a skipped
      // prompt (D-011/D-022): rejected before any policy, so no refusal or
      // success can claim an action a blank field never performed.
      const blank = blankAttemptedSettingsFields(body);
      if (blank.length > 0) {
        throw new ApiError('VALIDATION', {
          message: 'Blank values are not valid settings',
          details: { reason: 'blank-value', fields: [...blank] },
        });
      }
      const attempted = attemptedSettingsFields(body);
      // §6.3 first (the environment wins over the file, so its refusal is
      // the truthful one for a field both rules could claim), then §6.4.
      const envAttempted = attempted.filter((field) => snapshot.sources.fields.includes(field));
      if (envAttempted.length > 0) refuseEnvironmentOverrides(envAttempted);
      const restartAttempted = attempted.filter((field) =>
        (RESTART_REQUIRED_FIELDS as readonly string[]).includes(field),
      );
      if (restartAttempted.length > 0) refuseRestartRequired(restartAttempted);
      if (body.auth?.passwordHash !== undefined) refusePasswordHash();
      // The D-022 boundary: the same validation the loader runs, merged
      // over the effective configuration (omitted sections keep their
      // values — including stored account secrets, which this body cannot
      // even name), with the parser's field-addressed problems as details.
      const result = validateSettings(body, snapshot.config);
      if (!result.ok) {
        throw new ApiError('VALIDATION', {
          message: 'Invalid settings',
          details: { reason: 'invalid-settings', problems: [...result.problems] },
        });
      }
      const outcome = await store.apply({
        config: result.config,
        pendingPassword: result.pendingPassword,
        // The write-side obligation rides the payload (see the seam): the
        // environment-merged fields are marked for the file write to skip,
        // and the attempted fields are the only write candidates — a change
        // validated against an older snapshot cannot revert fields a
        // concurrent request already applied (D-140).
        sources: snapshot.sources,
        attempted,
      });
      reply.header('cache-control', 'no-store');
      return outcome;
    },
  );
};
