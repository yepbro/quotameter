/**
 * Environment-variable overrides for scalar configuration settings
 * (spec §6.3, §6.4, §14.5; decision D-023).
 *
 * Environment-defined values take precedence over file values and are
 * read-only in the UI (spec §6.3). This module owns that layer: it scans an
 * environment snapshot for the supported `QUOTAMETER_*` variables, splices
 * the coerced values on top of the file-loaded configuration, and reports
 * which effective settings came from the environment — the marking the API
 * and UI surface as read-only annotations (spec §14.5, tasks 12/13 stages).
 *
 * Composition only — nothing here re-implements loading or validation: the
 * merged object flows through `parseConfig` from `load.ts` (task 064), so an
 * environment value is validated exactly like a file value, with the same
 * field-addressed, value-free problems (spec §15.4). Reload (task 068)
 * re-runs `loadConfigWithEnv`; this module holds no state and never mutates
 * the passed environment snapshot.
 */

import type { Validated } from '../schemas/boundary';
import type { Config } from '../schemas/config';
import { loadConfigFile, parseConfig, type ConfigReadFilesystem } from './load';

/* ── The override table (decision D-023) ───────────────────────────────── */

/**
 * A configuration field an environment variable can override. The union is
 * closed on purpose: structured sections (`providers`, `accounts`) do not map
 * to single environment strings and secrets deliberately have no
 * `QUOTAMETER_*` channel — account keys already have per-account `apiKeyEnv`
 * (spec §6.3), and the password hash has no spec-named environment
 * alternative.
 */
export type EnvOverrideField =
  | 'server.host'
  | 'server.port'
  | 'app.timezone'
  | 'app.pollingIntervalSeconds'
  | 'app.historyRetentionDays'
  | 'auth.mode'
  | 'logging.level';

/** How an environment string becomes a configuration value. */
export type EnvOverrideKind = 'string' | 'integer';

/** One supported variable: its name, its field path, and its coercion. */
export interface EnvOverrideSpec {
  /** The environment variable, e.g. `QUOTAMETER_SERVER_PORT`. */
  readonly variable: string;
  /** The configuration field it overrides, in the problems-vocabulary style. */
  readonly field: EnvOverrideField;
  /** The coercion applied before validation. */
  readonly kind: EnvOverrideKind;
}

/**
 * Every supported override, in canonical order (the order `sources.fields`
 * reports). Names mirror the field path — upper-cased, `.` → `_`,
 * camelCase → SNAKE_CASE — so the mapping is derivable in both directions
 * (the `QUOTAMETER_` prefix follows spec §4.2/§6.1; explicit unit segments
 * follow D-014).
 */
export const ENV_OVERRIDES: readonly EnvOverrideSpec[] = Object.freeze([
  Object.freeze({ variable: 'QUOTAMETER_SERVER_HOST', field: 'server.host', kind: 'string' }),
  Object.freeze({ variable: 'QUOTAMETER_SERVER_PORT', field: 'server.port', kind: 'integer' }),
  Object.freeze({ variable: 'QUOTAMETER_APP_TIMEZONE', field: 'app.timezone', kind: 'string' }),
  Object.freeze({
    variable: 'QUOTAMETER_APP_POLLING_INTERVAL_SECONDS',
    field: 'app.pollingIntervalSeconds',
    kind: 'integer',
  }),
  Object.freeze({
    variable: 'QUOTAMETER_APP_HISTORY_RETENTION_DAYS',
    field: 'app.historyRetentionDays',
    kind: 'integer',
  }),
  Object.freeze({ variable: 'QUOTAMETER_AUTH_MODE', field: 'auth.mode', kind: 'string' }),
  Object.freeze({ variable: 'QUOTAMETER_LOGGING_LEVEL', field: 'logging.level', kind: 'string' }),
]);

/**
 * `QUOTAMETER_*` variables this layer knows but does not own: the XDG
 * directory overrides consumed by `paths.ts` (task 063). They pass the
 * unknown-variable scan without affecting the configuration.
 */
const PATH_VARIABLES: readonly string[] = Object.freeze([
  'QUOTAMETER_CONFIG_DIR',
  'QUOTAMETER_DATA_DIR',
]);

const KNOWN_VARIABLES: ReadonlySet<string> = new Set([
  ...ENV_OVERRIDES.map((spec) => spec.variable),
  ...PATH_VARIABLES,
]);

/**
 * An environment string counts as a decimal integer only when it is pure
 * ASCII digits — no sign, whitespace, decimals, or other bases. Anything
 * else stays a string, and the landed parser rejects it with its pinned
 * type message (`server.port: expected an integer, got a string`), so this
 * layer adds no error vocabulary of its own for bad values.
 */
const DECIMAL_INTEGER = /^[0-9]+$/;

/* ── Results and marking ───────────────────────────────────────────────── */

/**
 * Which effective settings came from the environment (spec §6.3, §14.5) —
 * the read-only marking the API/UI will surface. Secrets are never included:
 * only field paths and account ids.
 */
export interface EnvironmentSources {
  /** Overridden field paths, in `ENV_OVERRIDES` table order. */
  readonly fields: readonly EnvOverrideField[];
  /** Ids of accounts whose secret source is `apiKeyEnv` (spec §6.3). */
  readonly accountSecrets: readonly string[];
}

/** Result of applying environment overrides and validating the whole. */
export type ConfigEnvResult =
  | { ok: true; config: Validated<Config>; sources: EnvironmentSources }
  | { ok: false; problems: string[] };

/**
 * Result of loading the file and applying overrides. `fileAbsent` reports
 * provenance for the env-only mode of spec §6.3: the effective configuration
 * was built from the environment because no configuration file exists.
 */
export type ConfigEnvLoadResult =
  | { ok: true; config: Validated<Config>; sources: EnvironmentSources; fileAbsent: boolean }
  | { ok: false; problems: string[] };

/* ── The pure layer (the task 064 seam, decision D-018) ────────────────── */

/**
 * Applies environment overrides to parsed-but-unvalidated file input and
 * validates the whole through `parseConfig` — the composition seam task 064
 * exported (`parseJson` → **here** → `parseConfig`). Precedence: environment
 * over file over defaults. A variable that is set marks its field as
 * environment-sourced even when the value coincides with the file's.
 *
 * Problems concatenate two independent, deterministic groups: unknown
 * `QUOTAMETER_*` variable names (sorted), then every parser problem of the
 * merged object. Env-only configuration works by passing `{}` — `parseConfig`
 * completes the defaults exactly as it does for a minimal file.
 */
export function parseConfigWithEnv(
  fileInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ConfigEnvResult {
  const scan = scanEnvironment(env);
  const parsed = parseConfig(applyOverrides(fileInput, scan.values));
  if (!parsed.ok) {
    return { ok: false, problems: [...scan.unknownProblems, ...parsed.problems] };
  }
  if (scan.unknownProblems.length > 0) {
    return { ok: false, problems: scan.unknownProblems };
  }
  return { ok: true, config: parsed.value, sources: sourcesOf(scan.fields, parsed.value) };
}

/* ── File composition (startup and the task 068 reload pipeline) ───────── */

/**
 * Loads the configuration file and applies environment overrides on top —
 * the full pipeline startup and reload re-run. The file stage is owned by
 * `loadConfigFile` (task 064); only its outcome is composed here.
 *
 * A missing file is not fatal when at least one override is set: the
 * effective configuration is built from the environment alone (spec §6.3)
 * and a success carries `fileAbsent: true`. With no overrides the missing
 * file is the problem itself — "nothing is configured" must not surface as
 * a schema complaint — though unsupported `QUOTAMETER_*` names are still
 * scanned and reported beside it. Any other file failure (unreadable file,
 * invalid JSON, schema or cross-field problems) passes through verbatim:
 * the environment never masks a broken file.
 */
export async function loadConfigWithEnv(
  targetPath: string,
  env: NodeJS.ProcessEnv = process.env,
  filesystem?: ConfigReadFilesystem,
): Promise<ConfigEnvLoadResult> {
  const file = await loadConfigFile(targetPath, filesystem);
  if (file.ok) {
    const result = parseConfigWithEnv(file.config, env);
    return result.ok ? { ...result, fileAbsent: false } : result;
  }
  // The not-found message is pinned verbatim by the task 064 tests; matching
  // it exactly is the sanctioned way to detect absence without re-reading.
  const notFound = `configuration file not found: ${targetPath}`;
  if (file.problems.length !== 1 || file.problems[0] !== notFound) return file;
  if (!hasOverride(env)) {
    // Nothing valid comes from the environment, so the missing file is the
    // problem — but a typo'd QUOTAMETER_* name is still scanned and reported
    // beside it rather than surfacing only after a file or override appears.
    const unknownProblems = unknownVariableProblems(env);
    return unknownProblems.length > 0
      ? { ok: false, problems: [notFound, ...unknownProblems] }
      : file;
  }
  const result = parseConfigWithEnv({}, env);
  return result.ok
    ? { ...result, fileAbsent: true }
    : { ok: false, problems: [notFound, ...result.problems] };
}

/* ── Environment scan ──────────────────────────────────────────────────── */

/** One scan of an environment snapshot: usable overrides plus rejections. */
interface EnvironmentScan {
  /** Coerced values keyed by field path (insertion order = table order). */
  readonly values: ReadonlyMap<EnvOverrideField, unknown>;
  /** Fields whose variables are set, in table order (the marking half). */
  readonly fields: readonly EnvOverrideField[];
  /** Problems for unsupported `QUOTAMETER_*` names, sorted by name. */
  readonly unknownProblems: string[];
}

/**
 * Reads the override variables from an environment snapshot. An empty string
 * counts as unset at every level — the uniform rule of decision D-011.
 * Integer coercion only converts what `DECIMAL_INTEGER` accepts; every other
 * value passes through untouched for the parser to judge.
 */
function scanEnvironment(env: NodeJS.ProcessEnv): EnvironmentScan {
  const values = new Map<EnvOverrideField, unknown>();
  const fields: EnvOverrideField[] = [];
  for (const spec of ENV_OVERRIDES) {
    const raw = env[spec.variable];
    if (!isSet(raw)) continue;
    values.set(
      spec.field,
      spec.kind === 'integer' && DECIMAL_INTEGER.test(raw) ? Number(raw) : raw,
    );
    fields.push(spec.field);
  }
  return { values, fields, unknownProblems: unknownVariableProblems(env) };
}

/**
 * Problems for unsupported `QUOTAMETER_*` names, in codepoint order — the
 * sort is locale-independent so the problem order is stable across hosts
 * regardless of the runtime's default collation.
 */
function unknownVariableProblems(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => isSet(value) && name.startsWith('QUOTAMETER_'))
    .map(([name]) => name)
    .filter((name) => !KNOWN_VARIABLES.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${name}: unsupported environment variable`);
}

/** A variable carries a value only when it is a non-empty string. */
function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value !== '';
}

/** True when at least one supported override variable is set. */
function hasOverride(env: NodeJS.ProcessEnv): boolean {
  return ENV_OVERRIDES.some((spec) => isSet(env[spec.variable]));
}

/* ── Merge ─────────────────────────────────────────────────────────────── */

/**
 * Splices the coerced values into a fresh copy of the file input. The input
 * is never mutated; sections along an override path are copied, everything
 * else is shared (the parser treats its input as read-only).
 */
function applyOverrides(
  fileInput: unknown,
  values: ReadonlyMap<EnvOverrideField, unknown>,
): unknown {
  let merged = fileInput;
  for (const [field, value] of values) {
    const [section, key] = field.split('.') as [string, string];
    merged = spliceLeaf(merged, section, key, value);
  }
  return merged;
}

/**
 * Sets one leaf under a two-level path. A section that exists but is not a
 * plain object is left untouched: the override must not silently "repair" a
 * malformed file section — the parser reports the file's own type error
 * instead, and the configuration as a whole is rejected (spec §6.2).
 */
function spliceLeaf(base: unknown, section: string, key: string, value: unknown): unknown {
  if (!isPlainObject(base)) return base;
  const existing = base[section];
  if (existing === undefined) return { ...base, [section]: { [key]: value } };
  if (!isPlainObject(existing)) return base;
  return { ...base, [section]: { ...existing, [key]: value } };
}

/** A mergeable node: an object, but not `null` or an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ── Marking ───────────────────────────────────────────────────────────── */

/**
 * Builds the read-only marking from the scan and the validated effective
 * configuration: overridden fields in table order, plus the ids of accounts
 * whose secret source is `apiKeyEnv` — those key fields are
 * environment-defined and read-only in the UI (spec §6.3, §14.5). No value,
 * secret or not, ever enters the marking.
 */
function sourcesOf(
  fields: readonly EnvOverrideField[],
  config: Validated<Config>,
): EnvironmentSources {
  return Object.freeze({
    fields: Object.freeze(fields),
    accountSecrets: Object.freeze(
      (config.accounts ?? [])
        .filter((account) => account.apiKeyEnv !== undefined)
        .map((account) => account.id),
    ),
  });
}
