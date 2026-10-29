/**
 * Configuration reload — the §6.4 change-application operation (spec §5.2,
 * §6.2, §6.4; decision D-026).
 *
 * This module owns the reload side of trust boundary 3: on a SIGHUP or a CLI
 * `quotameter reload` request (spec §5.2) it re-runs the landed load pipeline
 * (`loadConfigWithEnv`, the seam D-023 names "the pipeline startup and the
 * task 068 reload re-run") against the current file, classifies what changed
 * per §6.4, swaps the effective configuration atomically on success, and —
 * the §6.2 rule — keeps the last valid configuration untouched on failure:
 * a reload failure must never leave the process without a working config.
 *
 * The reload *result* is the vocabulary the future consumers share: the CLI
 * `reload` command (task 141) reports `applied` / `pending-restart` /
 * `rejected`, and the UI labels `restartRequired` fields "restart required"
 * with a `quotameter restart` hint (spec §6.4). Signal installation is not
 * here: `src/server/main.ts` deliberately leaves SIGHUP unhandled, and the
 * later assembly task wires `process.on('SIGHUP', …)` to `reload()` (the
 * D-024 readiness discipline); until then production behavior is identical.
 *
 * Startup is not here either: §6.2's "invalid startup configuration, refuse
 * to start" stays with the composition root. The reloader is constructed
 * from a successful load — there is no reload-without-an-incumbent state, so
 * "keep the last valid configuration" is true from the first reload on.
 */

import { CONFIG_DEFAULTS, type Config } from '../schemas/config';
import type { Logger } from '../util/logger';
import { type ConfigEnvLoadResult, loadConfigWithEnv } from './env';
import type { ConfigReadFilesystem } from './load';

/* ── The §6.4 classification table ─────────────────────────────────────── */

/**
 * The settings spec §6.4 pins as restart-requiring: `server.host`,
 * `server.port`, and the authentication mode. A live process cannot rebind
 * its listener or re-decide its authentication pipeline mid-flight; the UI
 * must label these "restart required" (spec §6.4). The list is closed —
 * everything else in the contract applies after a successful reload.
 */
export type RestartRequiredField = 'server.host' | 'server.port' | 'auth.mode';

/** Every setting `RELOAD_FIELDS` classifies (the union of both halves). */
export type ReloadField = RestartRequiredField | LiveReloadField;

/** A §6.4 live-applicable setting: applied by the reload that loaded it. */
export type LiveReloadField =
  | 'app.timezone'
  | 'app.pollingIntervalSeconds'
  | 'app.historyRetentionDays'
  | 'accounts'
  | 'providers'
  | 'logging.level'
  | 'auth.passwordHash';

/** Which side of the §6.4 split a setting belongs to. */
export type ReloadApplyClass = 'live' | 'restart';

/**
 * One classified setting: its field path (the problems-vocabulary style),
 * its §6.4 class, and the configuration slice compared to detect changes.
 * The discriminated union keeps `field` and `applies` in lockstep — narrowing
 * on `applies` narrows `field`.
 */
export type ReloadFieldSpec =
  | {
      readonly field: RestartRequiredField;
      readonly applies: 'restart';
      readonly read: (config: Config) => unknown;
    }
  | {
      readonly field: LiveReloadField;
      readonly applies: 'live';
      readonly read: (config: Config) => unknown;
    };

/**
 * The §6.4 classification, one row per setting, in canonical (reporting)
 * order. Scope rows cover whole sections — §6.4 speaks of "the account
 * list/labels/keys/enabled states" and "the provider peak-hour schedule",
 * which are the `accounts` array and the `providers` record wholesale
 * (`providers` includes `requestTimeoutSeconds`, which governs the next
 * request, decision D-026). `logging.level` and `auth.passwordHash` are the
 * two settings §6.4 does not name; D-026 classifies them live — the logger's
 * `setLevel` exists for exactly the reload path (D-025), and a password hash
 * is checked per authentication attempt, not wired into a listener.
 */
export const RELOAD_FIELDS: readonly ReloadFieldSpec[] = Object.freeze([
  {
    field: 'server.host',
    applies: 'restart',
    read: (config) => config.server?.host,
  },
  {
    field: 'server.port',
    applies: 'restart',
    read: (config) => config.server?.port,
  },
  {
    field: 'auth.mode',
    applies: 'restart',
    read: (config) => config.auth?.mode,
  },
  {
    field: 'app.timezone',
    applies: 'live',
    read: (config) => config.app.timezone,
  },
  {
    field: 'app.pollingIntervalSeconds',
    applies: 'live',
    read: (config) => config.app.pollingIntervalSeconds,
  },
  {
    field: 'app.historyRetentionDays',
    applies: 'live',
    read: (config) => config.app.historyRetentionDays,
  },
  {
    field: 'accounts',
    applies: 'live',
    read: (config) => config.accounts ?? [],
  },
  {
    field: 'providers',
    applies: 'live',
    read: (config) => config.providers ?? {},
  },
  {
    field: 'logging.level',
    applies: 'live',
    read: (config) => config.logging?.level,
  },
  {
    field: 'auth.passwordHash',
    applies: 'live',
    read: (config) => config.auth?.passwordHash,
  },
]);

/**
 * The restart-requiring half of {@link RELOAD_FIELDS} as a flat list — the
 * data the settings UI (spec §14.5) labels "restart required". A unit test
 * pins its consistency with the table.
 */
export const RESTART_REQUIRED_FIELDS: readonly RestartRequiredField[] = Object.freeze([
  'server.host',
  'server.port',
  'auth.mode',
]);

/** Which of the classified settings differ between two configurations. */
export interface ReloadChanges {
  /** Live settings that differ — a reload applying `next` activates them. */
  readonly live: readonly LiveReloadField[];
  /** Restart-requiring settings that differ. */
  readonly restart: readonly RestartRequiredField[];
}

/**
 * Diffs two configurations at the granularity of {@link RELOAD_FIELDS}:
 * deep, structural comparison of each row's slice (equal content in a fresh
 * object is equal), field paths reported in table order. Pure — the caller
 * chooses the baselines that give the halves meaning:
 *
 * - `applied` in a reload result diffs against the *previous effective*
 *   configuration — the live settings this reload activated;
 * - `restartRequired` diffs against the *startup* configuration — what the
 *   running process actually bound, so repeated reloads keep reporting
 *   `pending-restart` until a real restart picks the values up (D-026).
 */
export function findReloadChanges(baseline: Config, next: Config): ReloadChanges {
  const changed = RELOAD_FIELDS.filter((spec) => !jsonEquals(spec.read(baseline), spec.read(next)));
  return {
    live: changed
      .filter(
        (spec): spec is Extract<ReloadFieldSpec, { applies: 'live' }> => spec.applies === 'live',
      )
      .map((spec) => spec.field),
    restart: changed
      .filter(
        (spec): spec is Extract<ReloadFieldSpec, { applies: 'restart' }> =>
          spec.applies === 'restart',
      )
      .map((spec) => spec.field),
  };
}

/** Structural equality for JSON-derived values (configurations are such). */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => jsonEquals(value, b[index]))
    );
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => key in bRecord && jsonEquals(aRecord[key], bRecord[key]))
  );
}

/* ── The effective configuration and the reload result ─────────────────── */

/**
 * What a successful pipeline run produces and the reloader holds — the
 * ok-branch of `ConfigEnvLoadResult` minus its discriminant, derived so the
 * two shapes cannot drift: the validated effective configuration, the
 * environment-source marking for the read-only annotations (spec §14.5),
 * and the file-absence provenance of the env-only mode (D-023).
 */
export type EffectiveConfig = Omit<Extract<ConfigEnvLoadResult, { ok: true }>, 'ok'>;

/** The three reload outcomes the future CLI command (141) and SIGHUP wiring consume. */
export type ReloadOutcome = 'applied' | 'pending-restart' | 'rejected';

/** A successful reload: the new effective configuration plus what it means. */
export interface ReloadSuccess {
  readonly ok: true;
  /**
   * `applied` — every §6.4 live setting is now in effect and nothing
   * restart-requiring changed. `pending-restart` — live settings are in
   * effect AND some restart-requiring setting differs from what the process
   * started with; the UI must label those "restart required" (spec §6.4).
   */
  readonly outcome: 'applied' | 'pending-restart';
  /** The newly adopted effective configuration (also `current()` from now). */
  readonly effective: EffectiveConfig;
  /** Live settings this reload changed, in `RELOAD_FIELDS` order. */
  readonly applied: readonly LiveReloadField[];
  /** Restart-requiring settings differing from the startup configuration. */
  readonly restartRequired: readonly RestartRequiredField[];
}

/** A rejected reload: problems verbatim from the pipeline; nothing changed. */
export interface ReloadFailure {
  readonly ok: false;
  readonly outcome: 'rejected';
  /**
   * Field-addressed, value-free problems (D-018) — safe to log and print.
   * The previously effective configuration remains active (spec §6.2).
   */
  readonly problems: readonly string[];
}

/** Result of {@link ConfigReloader.reload} — the task 068 result contract. */
export type ReloadResult = ReloadSuccess | ReloadFailure;

/* ── The reloader ──────────────────────────────────────────────────────── */

/** Options accepted by {@link createConfigReloader}. */
export interface ConfigReloaderOptions {
  /**
   * The startup load's success result — the incumbent the first reload is
   * measured against and the configuration kept on every failed reload.
   * Adopted (deep-frozen) by the reloader.
   */
  readonly initial: EffectiveConfig;
  /** Path of the configuration file re-read on every reload. */
  readonly targetPath: string;
  /**
   * Environment snapshot the overrides are re-applied from on every reload
   * (D-023); defaults to `process.env`. Taken as a one-time shallow copy —
   * a later in-process `process.env` mutation cannot flip an
   * environment-pinned setting across reloads.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Read primitive injection for deterministic tests; production omits it. */
  readonly filesystem?: ConfigReadFilesystem;
  /**
   * The redacting logger (spec §16, §15.4): reloads are `info` lifecycle
   * events, rejections are `warn` reports, and every successful reload
   * applies `logging.level` through `setLevel` — the call D-025 reserved
   * for this path. Data logged is value-free by construction (field paths,
   * outcome, pipeline problems). Absent in tests that assert state only.
   */
  readonly logger?: Logger;
}

/** The reload operation plus the effective-configuration holder it maintains. */
export interface ConfigReloader {
  /** The startup configuration — the baseline `restartRequired` diffs against. */
  readonly startup: EffectiveConfig;
  /** The currently effective configuration (the last valid one ever loaded). */
  current(): EffectiveConfig;
  /**
   * Re-runs the load pipeline and applies §6.4. Never rejects for
   * configuration problems — those are the `rejected` result; only a fault
   * in an injected dependency (a broken logger) can reject, and then the
   * incumbent stays active. Concurrent calls serialize: every caller gets
   * its own result, each run re-reads the file, in invocation order.
   */
  reload(): Promise<ReloadResult>;
}

/**
 * Creates the reloader from the startup load's success result (§6.2's
 * refuse-to-start on an invalid startup configuration is the composition
 * root's policy — the reloader only ever exists with a valid incumbent).
 */
export function createConfigReloader(options: ConfigReloaderOptions): ConfigReloader {
  // A shallow copy, not the live reference: the reloader must judge every
  // reload against the environment the process started with, so runtime env
  // mutation (a library writing `process.env`) cannot flip a pinned field.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const startup = adopt(options.initial);
  let current = startup;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<ReloadResult> => {
    const loaded = await loadConfigWithEnv(options.targetPath, env, options.filesystem);
    if (!loaded.ok) {
      options.logger?.warn('configuration reload rejected; keeping the last valid configuration', {
        problems: loaded.problems,
      });
      return { ok: false, outcome: 'rejected', problems: loaded.problems };
    }
    const next = adopt(loaded);
    const applied = findReloadChanges(current.config, next.config).live;
    const restartRequired = findReloadChanges(startup.config, next.config).restart;
    const outcome = restartRequired.length > 0 ? 'pending-restart' : 'applied';
    // The one live side effect this module owns (D-025). The level is
    // schema-guaranteed to be one of the four §16 levels, all on the ladder,
    // so this cannot throw; the fallback mirrors `env.ts` — the type cannot
    // express that the canonical parser always materializes the section.
    options.logger?.setLevel(next.config.logging?.level ?? CONFIG_DEFAULTS.logging.level);
    current = next;
    options.logger?.info('configuration reloaded', { outcome, applied, restartRequired });
    return { ok: true, outcome, effective: next, applied, restartRequired };
  };

  return {
    startup,
    current: () => current,
    reload(): Promise<ReloadResult> {
      // Serialize: a reload begun while another is in flight waits for it,
      // then re-runs the pipeline itself — SIGHUP bursts each take effect.
      const result = queue.then(run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

/**
 * Freezes a pipeline success into immutable shared state: the configuration
 * object deep-frozen in place (the D-013 immutable-in-memory precedent —
 * every future consumer reads the same untouched value), the wrapper frozen
 * around it. `sources` is frozen by the pipeline already (`sourcesOf`).
 */
function adopt(loaded: EffectiveConfig): EffectiveConfig {
  deepFreeze(loaded.config);
  return Object.freeze({
    config: loaded.config,
    sources: loaded.sources,
    fileAbsent: loaded.fileAbsent,
  });
}

/** Freezes a JSON-derived object graph in place (arrays and plain objects). */
function deepFreeze(value: object): void {
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
}
