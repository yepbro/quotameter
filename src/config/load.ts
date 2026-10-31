/**
 * Configuration loading and validation — trust boundary 3's runtime side
 * (spec §6.2; decisions D-014, D-015, D-018).
 *
 * One pipeline composes the landed pieces without changing them: the TypeBox
 * contract in `src/schemas/config.ts` compiled with Ajv (structural rules),
 * `CONFIG_DEFAULTS` (defaults completion), and `findConfigProblems`
 * (cross-field rules). The output is either one validated, canonical
 * configuration object or a list of readable, field-addressed English
 * problems — invalid configuration can never silently reach runtime services
 * (the task 064 done-condition): the loader never throws for bad input and
 * never returns partial data (the `BoundaryParser` contract of
 * `src/schemas/boundary.ts`).
 *
 * Out of scope here: directory creation and permission enforcement (task
 * 066), writing (task 065, `write.ts`), environment overrides (task 067),
 * and reload/SIGHUP orchestration (task 068) — `parseJson` and `parseConfig`
 * are exported separately so those tasks can compose this pipeline at the
 * right seams.
 */

import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv/dist/2020';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BoundaryParser, Validated } from '../schemas/boundary';
import {
  CONFIG_DEFAULTS,
  ConfigSchema,
  findConfigProblems,
  type AccountConfig,
  type Config,
  type PeakWindow,
} from '../schemas/config';

/* ── File naming (D-011 deferred it here; spec §6.1 names the file) ────── */

/** Name of the configuration file inside the resolved config directory. */
export const CONFIG_FILE_NAME = 'config.json';

/** Absolute path of the configuration file inside `configDir`. */
export function configFilePath(configDir: string): string {
  return path.join(configDir, CONFIG_FILE_NAME);
}

/* ── Structural validation (Ajv, decision D-018) ───────────────────────── */

/**
 * The compiled structural validator. TypeBox schemas are plain JSON Schema,
 * so the contract object compiles directly; the 2020-12 variant of Ajv is
 * required because the contract emits the numeric `exclusiveMinimum` form
 * (draft 2020-12), which draft-07 Ajv rejects. `useDefaults` is deliberately
 * off and defaults are completed explicitly instead: Ajv documents default
 * insertion only for `properties`/`items` schemas (behavior for the
 * providers record's `patternProperties` defaults is undocumented, even
 * where a version happens to apply them), it mutates the validated input,
 * and it cannot materialize absent whole sections — the loader needs all
 * three guarantees (see `applyConfigDefaults`).
 */
const structuralValidator = new Ajv2020({ allErrors: true }).compile(ConfigSchema);

/** The validated, canonical configuration — trust boundary 3's output. */
export type ConfigParsed = { ok: true; value: Validated<Config> };
/** Any loading step that failed: field-addressed, human-readable problems. */
export type ConfigRejected = { ok: false; problems: string[] };
/** Result of parsing untrusted input into a validated configuration. */
export type ConfigParseResult = ConfigParsed | ConfigRejected;
/** Result of loading and validating the configuration file from disk. */
export type ConfigLoadResult = { ok: true; config: Validated<Config> } | ConfigRejected;

/**
 * Parses untrusted configuration input into the validated, canonical
 * configuration object — trust boundary 3's parser (also exported as
 * {@link configBoundaryParser}).
 *
 * Three stages, first failure wins: structural validation against
 * `ConfigSchema` (Ajv, all errors), defaults completion from
 * `CONFIG_DEFAULTS` (every optional section materialized), and the
 * cross-field invariants of `findConfigProblems`. The input is treated as
 * read-only; the returned object is freshly built.
 */
export function parseConfig(input: unknown): ConfigParseResult {
  if (!structuralValidator(input)) {
    // Ajv guarantees `errors` is set when validation fails (that is why the
    // type also admits null: for the success case).
    const errors = structuralValidator.errors as ErrorObject[];
    const failedUnions = new Set(
      errors.filter((error) => error.keyword === 'anyOf').map((error) => error.instancePath),
    );
    const problems: string[] = [];
    for (const error of errors) {
      // A failed literal union reports one `const` error per branch plus an
      // `anyOf` error; one "must be one of" line replaces the whole group.
      if (error.keyword === 'const' && failedUnions.has(error.instancePath)) continue;
      if (error.keyword === 'anyOf') {
        const allowed = allowedValuesIn(errors, error.instancePath);
        problems.push(
          `${errorField(error.instancePath)}: ${
            allowed.length > 0
              ? `must be one of: ${allowed.join(', ')}`
              : 'must be one of the allowed values'
          }`,
        );
        continue;
      }
      problems.push(formatSchemaError(error, ConfigSchema, input));
    }
    return { ok: false, problems };
  }
  const config = applyConfigDefaults(input as Config);
  const problems = findConfigProblems(config);
  // The parser is the sanctioned construction site of the brand: everything
  // above proved the value against the schema and the invariants.
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, value: config as Validated<Config> };
}

/** The boundary-3 parser in the `BoundaryParser` shape (decision D-014). */
export const configBoundaryParser: BoundaryParser<Config> = { parse: parseConfig };

/** The literal values of a failed union, quoted, in schema order. */
function allowedValuesIn(errors: ErrorObject[], instancePath: string): string[] {
  return errors
    .filter((error) => error.keyword === 'const' && error.instancePath === instancePath)
    .map((error) => `'${String((error.params as Record<string, unknown>).allowedValue)}'`);
}

/* ── Defaults completion (decision D-018) ──────────────────────────────── */

/**
 * Builds the canonical configuration: every optional section materialized,
 * every omitted field set to its spec default from `CONFIG_DEFAULTS` (kept
 * in lockstep with the schema annotations by the drift test in
 * `test/unit/config.spec.ts`). Runs only on structurally valid input, so
 * every field access is safe and every default satisfies the schema.
 *
 * Absent sections become their empty shapes (`providers: {}`,
 * `accounts: []`): consumers never re-implement fallback precedence, and
 * the object a reload (task 068) swaps in memory is complete. Optional
 * secret fields (`passwordHash`, `apiKey`, `apiKeyEnv`) are never
 * materialized as `undefined` keys — absent stays absent.
 */
function applyConfigDefaults(config: Config): Config {
  return {
    server: {
      host: config.server?.host ?? CONFIG_DEFAULTS.server.host,
      port: config.server?.port ?? CONFIG_DEFAULTS.server.port,
    },
    app: {
      timezone: config.app.timezone,
      pollingIntervalSeconds:
        config.app.pollingIntervalSeconds ?? CONFIG_DEFAULTS.app.pollingIntervalSeconds,
      historyRetentionDays:
        config.app.historyRetentionDays ?? CONFIG_DEFAULTS.app.historyRetentionDays,
    },
    auth: { ...config.auth, mode: config.auth?.mode ?? CONFIG_DEFAULTS.auth.mode },
    logging: { level: config.logging?.level ?? CONFIG_DEFAULTS.logging.level },
    providers: Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([providerId, provider]) => [
        providerId,
        {
          peakHours: {
            timezone: provider.peakHours.timezone,
            offPeakMultiplier:
              provider.peakHours.offPeakMultiplier ?? CONFIG_DEFAULTS.peakHours.offPeakMultiplier,
            windows: provider.peakHours.windows.map(completeWindow),
          },
          requestTimeoutSeconds:
            provider.requestTimeoutSeconds ?? CONFIG_DEFAULTS.provider.requestTimeoutSeconds,
        },
      ]),
    ),
    accounts: (config.accounts ?? []).map(completeAccount),
  };
}

/** A peak window with its optional multiplier defaulted (spec §9.2). */
function completeWindow(window: PeakWindow): PeakWindow {
  return { ...window, multiplier: window.multiplier ?? CONFIG_DEFAULTS.peakHours.windowMultiplier };
}

/** An account with its optional enabled flag defaulted; secrets untouched. */
function completeAccount(account: AccountConfig): AccountConfig {
  return { ...account, enabled: account.enabled ?? true };
}

/* ── JSON parsing with secret-safe errors (spec §15.4) ─────────────────── */

/**
 * V8's `Unexpected token` errors quote a raw region of the input: the whole
 * input when it fits (`Unexpected token 's', "[1, 2, s]" is not valid
 * JSON`) or a window around the error position with `...` on each truncated
 * side (`Unexpected token 's', ...""apiKey": sk-secr"... is not valid
 * JSON`) — inner quotes are never escaped, so the region can quote a secret
 * fragment straight from the file (U-003). Every snippet region opens with
 * a double quote, so everything from the first double quote on is dropped
 * and the residual `, ` / `, ...` separator tail is trimmed; the token
 * prefix that remains is V8's token-name vocabulary, not an input region.
 * The position-only message families (`… in JSON at position N (line L
 * column C)`) contain no double quotes and pass through unchanged.
 */
function withoutInputSnippet(message: string): string {
  const snippetStart = message.indexOf('"');
  if (snippetStart === -1) return message;
  return message.slice(0, snippetStart).replace(/,\s*(?:\.\.\.)?\s*$/, '');
}

/**
 * Parses configuration file text as JSON. Pure: `JSON.parse` on a string
 * cannot touch anything else, and the only failure mode becomes one
 * readable problem. Any JSON type parses successfully — the top-level
 * object requirement is a schema rule handled by `parseConfig`.
 */
export function parseJson(text: string): { ok: true; value: unknown } | ConfigRejected {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`invalid JSON: ${withoutInputSnippet(raw)}`] };
  }
  return { ok: true, value };
}

/* ── File loading ──────────────────────────────────────────────────────── */

/** The filesystem primitive loading needs, injectable like `WriteFilesystem`. */
export interface ConfigReadFilesystem {
  readFile(target: string): Promise<string>;
}

const realFilesystem: ConfigReadFilesystem = {
  readFile: (target) => readFile(target, 'utf8'),
};

/**
 * Loads and validates the configuration file at `targetPath`
 * (`configFilePath(resolveConfigDir(env))` at the call site).
 *
 * Never throws for a bad or unloadable file: a missing file, an unreadable
 * file, malformed JSON, a schema violation, and a cross-field violation all
 * become `{ ok: false, problems }` with self-describing English messages —
 * the caller (startup, reload, `doctor`) decides whether to refuse to
 * start, keep the last valid configuration (spec §6.2), or report. Nothing
 * read from the file — secrets included — is ever echoed into a problem
 * (spec §15.4).
 */
export async function loadConfigFile(
  targetPath: string,
  filesystem: ConfigReadFilesystem = realFilesystem,
): Promise<ConfigLoadResult> {
  let text: string;
  try {
    text = await filesystem.readFile(targetPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { ok: false, problems: [`configuration file not found: ${targetPath}`] };
    }
    return {
      ok: false,
      problems: [`cannot read configuration file ${targetPath}: ${describeReadFailure(error)}`],
    };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const result = parseConfig(parsed.value);
  return result.ok ? { ok: true, config: result.value } : result;
}

/** Distinguishes filesystem errors from other rejections (code-carrying only). */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** Read-failure reason without ever echoing file content. */
function describeReadFailure(error: unknown): string {
  if (isErrnoException(error)) return error.code;
  return error instanceof Error ? error.message : String(error);
}

/* ── Error formatting (the problems vocabulary, decision D-018) ────────── */

/** Field label for the root object: problems name the top level explicitly. */
const ROOT_PATH = 'configuration';

/**
 * Renders one Ajv error as a readable, field-addressed English problem:
 * `<path>: <message>`. Data values are never included — only field paths,
 * schema constants (allowed values, limits, patterns), and, for type
 * errors, the JSON type the data actually had — so secrets cannot leak
 * into error text (spec §15.4).
 *
 * `rootSchema` supplies schema context (a keyed record's id pattern);
 * `data`, when provided, names the actual type in type errors. The message
 * for a failed literal union comes from `parseConfig` (which sees the whole
 * error group); standalone use renders the generic union message.
 */
export function formatSchemaError(error: ErrorObject, rootSchema: object, data?: unknown): string {
  return `${errorField(error.instancePath)}: ${schemaErrorMessage(error, rootSchema, data)}`;
}

/**
 * The message half: keyword-specific text built from `params` alone, with
 * Ajv's own message as the passthrough for keywords this contract never
 * emits (kept total for future schema growth and `doctor` reuse).
 */
function schemaErrorMessage(
  error: ErrorObject,
  rootSchema: object,
  data: unknown | undefined,
): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'type':
      return `expected ${withArticle(String(params.type))}${actualTypeSuffix(error.instancePath, data)}`;
    case 'required':
      return `missing required property '${String(params.missingProperty)}'`;
    case 'additionalProperties':
      return additionalPropertiesMessage(error, rootSchema, params);
    case 'anyOf':
      return 'must be one of the allowed values';
    case 'const':
      return `must be '${String(params.allowedValue)}'`;
    case 'pattern':
      return `must match the pattern '${String(params.pattern)}'`;
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
      return `must be ${String(params.comparison)} ${String(params.limit)}`;
    case 'minLength':
      return `must be at least ${String(params.limit)} ${plural(
        Number(params.limit),
        'character',
      )} long`;
    case 'minItems':
      return `must contain at least ${String(params.limit)} ${plural(Number(params.limit), 'item')}`;
    case 'uniqueItems':
      return 'must not contain duplicate items';
    default:
      return error.message ?? `failed the '${error.keyword}' check`;
  }
}

/**
 * Unknown keys read differently depending on the parent: a plain closed
 * object rejects a typo (`unknown property`), while a keyed record rejects
 * a name outside its id charset — the parent schema's `patternProperties`
 * (resolved from `schemaPath`, which points at the `additionalProperties`
 * keyword inside the parent) says which.
 */
function additionalPropertiesMessage(
  error: ErrorObject,
  rootSchema: object,
  params: Record<string, unknown>,
): string {
  const parent = resolveParentSchema(rootSchema, error.schemaPath);
  const name = String(params.additionalProperty);
  if (parent?.patternProperties !== undefined) {
    const patterns = Object.keys(parent.patternProperties as Record<string, unknown>);
    return `property name '${name}' must match the pattern '${patterns[0] ?? ''}'`;
  }
  return `unknown property '${name}'`;
}

/**
 * `data[<instancePath>]` rendered as ", got a …" for type errors; an empty
 * suffix when the path cannot be walked (possible on malformed input) or no
 * data was supplied. Only the JSON type is reported, never the value.
 */
function actualTypeSuffix(instancePath: string, data: unknown | undefined): string {
  if (data === undefined) return '';
  const value = valueAtPointer(data, instancePath);
  if (value === undefined) return '';
  const name = jsonTypeName(value);
  // `null` is a literal, not a countable type noun — it takes no article.
  return `, got ${name === 'null' ? name : withArticle(name)}`;
}

/**
 * JSON type name of a parsed value (`typeof` corrected for `null`/arrays).
 * Non-finite numbers are named distinctly: they are not JSON values (strict
 * `JSON.parse` yields `Infinity` for an out-of-range literal such as `1e400`,
 * and both TypeBox and Ajv exclude non-finite doubles from the `number` type
 * — verified on the pinned runtime, task 113/D-071), so a type error must
 * never read "expected a number, got a number".
 */
function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite number';
  return typeof value;
}

/** `"an integer"`, `"a string"` — article by leading vowel of the type name. */
function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Renders a JSON pointer against parsed data: `/accounts/0/id` →
 * `accounts[0].id`; the empty pointer → `configuration`. Pointer tokens are
 * unescaped (`~1`/`~0`) so property names survive verbatim.
 */
function errorField(instancePath: string): string {
  if (instancePath === '' || instancePath === '/') return ROOT_PATH;
  return instancePath
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((token) => (/^\d+$/.test(token) ? `[${token}]` : token))
    .reduce((field, part) => (part.startsWith('[') ? `${field}${part}` : `${field}.${part}`));
}

/**
 * Walks `data` along a JSON instance path; `undefined` when any step is not
 * an object/array (malformed input can break the walk mid-way).
 */
function valueAtPointer(data: unknown, instancePath: string): unknown {
  let current: unknown = data;
  for (const token of instancePath.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

/**
 * Resolves an Ajv `schemaPath` (a `#`-prefixed, percent-encoded JSON
 * pointer) to the schema **containing** the keyword it points at;
 * `undefined` when the pointer does not resolve. Percent-decoding is
 * required because Ajv URL-encodes pointer segments (`%5E%5B…` for `^[…`);
 * malformed escapes — possible only in hand-built pointers, never in
 * Ajv's own — are kept verbatim so the function stays total.
 */
function resolveParentSchema(
  rootSchema: object,
  schemaPath: string,
): Record<string, unknown> | undefined {
  const pointer = schemaPath.startsWith('#') ? schemaPath.slice(1) : schemaPath;
  const segments = pointer
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeSegment(segment.replace(/~1/g, '/').replace(/~0/g, '~')));
  let current: unknown = rootSchema;
  for (const key of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'object' && current !== null
    ? (current as Record<string, unknown>)
    : undefined;
}

/** Percent-decodes one pointer segment without throwing on bad escapes. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
