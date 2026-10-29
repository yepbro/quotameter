/**
 * Service settings validation — the `ConfigService` boundary for externally
 * supplied settings (task 073, spec §5.3, §6, §7.1; decision D-022).
 *
 * The landed parser of trust boundary 3 (`parseConfig` in
 * `src/config/load.ts` + `findConfigProblems` in `src/schemas/config.ts`)
 * owns every structural rule (types, ranges, closed enums, closed objects)
 * and every cross-field invariant of a complete `config.json`. But settings
 * also arrive from **outside** the file — `init` prompt answers (spec §5.3),
 * CLI flags, and the future `PUT /api/settings` payload (spec §13) — as
 * loose, string-typed, partial data. This module is the service-facing entry
 * point that shape sits in front of the parser:
 *
 * ```text
 *     submission ──normalize──▶ config-shaped values ──merge over base──▶ parseConfig
 *        (unknown)   (trim, blank ⇒ omitted,      (§5.3 keep-or-change)     │
 *                    numeric-string coercion)                    Validated<Config> | problems
 * ```
 *
 * What the layer adds over calling the parser directly (everything else is
 * delegated, never duplicated):
 *
 * - **Numeric-string coercion**: prompts and CLI flags deliver strings; the
 *   four integer settings (`server.port`, `app.pollingIntervalSeconds`,
 *   `app.historyRetentionDays`, `providers.<id>.requestTimeoutSeconds`) and
 *   the two peak-hours multipliers accept `"300"`/`"0.5"`. Ranges stay with
 *   the schema — a coerced value is re-validated by the parser, and a
 *   non-numeric string fails here with one field-specific message before the
 *   parser would report a type error on a value the user never meant as a
 *   string.
 * - **Blank answers mean "not supplied"**: after trimming, a blank string is
 *   omitted (spec §5.3 — the prompt's empty answer keeps the current value
 *   or the default), and an omitted field falls back to `base` or the spec
 *   defaults. Secrets are never trimmed; a blank secret is "not supplied".
 * - **Merge over the current configuration** (`base`): §5.3 requires init to
 *   be idempotent — display current settings, keep or change them. Objects
 *   merge field-wise; arrays (`accounts`, peak `windows`) and non-object
 *   section values replace wholesale (PUT semantics). Unknown keys flow to
 *   the parser untouched, so a typo'd submission key still fails validation.
 * - **The plaintext password** (`auth.password`, spec §5.3 step 4, §15.2):
 *   the one auth setting that exists only at this boundary — the schema
 *   knows the scrypt `passwordHash`, never the password. Rules: at least
 *   {@link MIN_PASSWORD_LENGTH} characters (spec §15.2), never trimmed or
 *   echoed, mutually exclusive with `passwordHash` (supplying both means the
 *   caller is confused about which side of the hashing seam it is on). A
 *   valid password is validated as the post-hashing state by substituting a
 *   placeholder hash — any non-empty opaque string is schema-equivalent to a
 *   scrypt hash (`minLength: 1`; the invariant checks presence only) — and
 *   returned as `pendingPassword` for the Stage-12 auth service to hash;
 *   the placeholder itself never leaves this module, and the file the
 *   caller writes is re-validated by the loader on the next start, so the
 *   trust boundary stays intact end-to-end.
 *
 * Like the parser it wraps, this function is total: it never throws for bad
 * input and never returns partial data — either one validated, canonical
 * configuration or a list of field-addressed, English, secret-free problems.
 */

import { parseConfig } from '../config/load';
import type { Validated } from '../schemas/boundary';
import type { Config, ProvidersConfig } from '../schemas/config';

/* ── Public contract ───────────────────────────────────────────────────── */

/**
 * The §15.2 password minimum. Lives here — not in the schema — because the
 * schema sees only the opaque hash; the plaintext password exists solely at
 * this boundary.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The outcome of validating externally supplied settings.
 *
 * The `pendingPassword` branch discriminates the one case in which the
 * settings are valid but the configuration is not yet complete: a plaintext
 * password was supplied and must be hashed into `auth.passwordHash` by the
 * future auth service before the file is written. Its `config` is therefore
 * deliberately **unbranded** — everything except the hash passed the full
 * parser, and the object a caller writes after hashing is re-validated by
 * the loader on the next start.
 */
export type SettingsValidationResult =
  | { ok: true; pendingPassword: undefined; config: Validated<Config> }
  | { ok: true; pendingPassword: string; config: Config }
  | { ok: false; problems: string[] };

/**
 * Validates externally supplied settings (init answers, CLI flags, future
 * API payloads) and returns the canonical configuration they produce.
 *
 * @param submission Untrusted, config-shaped but loosely typed input
 *   (`{ server: { host, port }, app: { timezone, … }, auth: { mode,
 *   password, passwordHash }, … }`). Init and the CLI map their flat §5.3
 *   answers onto these sections — one canonical vocabulary instead of a
 *   second flat one.
 * @param base The current validated configuration, when one exists (a
 *   re-run of `init`, a settings update). Omitted fields keep the base
 *   value; without a base they fall back to the spec defaults inside
 *   `parseConfig`.
 */
export function validateSettings(
  submission: unknown,
  base?: Validated<Config>,
): SettingsValidationResult {
  const problems: string[] = [];
  const password = extractPassword(submission, problems);
  const normalized = normalizeSubmission(submission, problems);
  const merged =
    base !== undefined && isPlainObject(normalized)
      ? mergeOverBase(normalized, base as CanonicalConfig, password !== undefined)
      : normalized;
  // A pending password implies `merged` is a plain object (the password was
  // extracted from its `auth` section), so the placeholder step can rely on
  // that shape even though the pipeline type is `unknown`.
  const candidate =
    password === undefined ? merged : withPlaceholderHash(merged as Record<string, unknown>);
  const parsed = parseConfig(candidate);
  if (!parsed.ok) return { ok: false, problems: [...problems, ...parsed.problems] };
  if (problems.length > 0) return { ok: false, problems };
  return password === undefined
    ? { ok: true, pendingPassword: undefined, config: parsed.value }
    : { ok: true, pendingPassword: password, config: withoutPlaceholderHash(parsed.value) };
}

/**
 * `Config` with every section materialized. The static `Config` type marks
 * the optional sections `?`, but the parser's defaults completion (D-018)
 * always emits them, so this view describes what `parseConfig` — and
 * therefore this module — actually produces and consumes.
 */
type CanonicalConfig = Required<
  Pick<Config, 'server' | 'app' | 'auth' | 'logging' | 'providers' | 'accounts'>
> &
  Omit<Config, 'server' | 'app' | 'auth' | 'logging' | 'providers' | 'accounts'>;

/* ── Plaintext password (spec §5.3 step 4, §15.2) ──────────────────────── */

/**
 * Reads and removes-in-effect `auth.password` from the submission (the input
 * is never mutated; normalization simply never copies the field). Returns
 * the password when one is supplied and valid, `undefined` when none is;
 * every rejection pushes exactly one field-specific problem. The value is
 * never included in any message (spec §15.4).
 */
function extractPassword(submission: unknown, problems: string[]): string | undefined {
  if (!isPlainObject(submission) || !isPlainObject(submission.auth)) return undefined;
  const auth = submission.auth;
  const hasPassword = auth.password !== undefined;
  if (!hasPassword) return undefined;
  if (auth.passwordHash !== undefined) {
    problems.push(
      'auth: password and passwordHash are mutually exclusive — supply the plaintext ' +
        'password (to be hashed) or the stored hash, not both (spec §15.2)',
    );
    return undefined;
  }
  if (typeof auth.password !== 'string') {
    problems.push('auth.password: expected a string');
    return undefined;
  }
  // Blank means the prompt was skipped: no password, no change.
  if (auth.password.trim() === '') return undefined;
  if (auth.password.length < MIN_PASSWORD_LENGTH) {
    problems.push(
      `auth.password: must be at least ${MIN_PASSWORD_LENGTH} characters long (spec §15.2)`,
    );
    return undefined;
  }
  return auth.password;
}

/**
 * The stand-in for the future scrypt hash while validating the post-hashing
 * state. Any non-empty string satisfies the contract (`minLength: 1`; the
 * password invariant checks presence only), so this one is as good as the
 * real hash — and it is stripped before anything is returned.
 */
const PENDING_HASH_PLACEHOLDER = '__quotameter-pending-password-hash__';

/** Substitutes the placeholder hash; {@link withoutPlaceholderHash} removes it. */
function withPlaceholderHash(merged: Record<string, unknown>): Record<string, unknown> {
  const auth = isPlainObject(merged.auth) ? merged.auth : {};
  return { ...merged, auth: { ...auth, passwordHash: PENDING_HASH_PLACEHOLDER } };
}

/** Strips the placeholder from the validated configuration (never returned). */
function withoutPlaceholderHash(config: Config): Config {
  const auth: Record<string, unknown> = { ...config.auth };
  delete auth.passwordHash;
  return { ...config, auth: auth as Config['auth'] };
}

/* ── Normalization (config-shaped values from loose input) ─────────────── */

/**
 * Builds the normalized, config-shaped projection of the submission:
 * recognized sections with trimmed strings, omitted blanks, and coerced
 * numeric strings; unknown keys and unrecognized shapes verbatim — the
 * parser is the authority that rejects them, with its own field-addressed
 * messages. Never mutates the input, never throws.
 */
function normalizeSubmission(submission: unknown, problems: string[]): unknown {
  if (!isPlainObject(submission)) return submission;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'server', normalizeServer(submission.server, problems));
  assignDefined(normalized, 'app', normalizeApp(submission.app, problems));
  assignDefined(normalized, 'auth', normalizeAuth(submission.auth));
  assignDefined(normalized, 'logging', normalizeLogging(submission.logging));
  assignDefined(normalized, 'providers', normalizeProviders(submission.providers, problems));
  assignDefined(normalized, 'accounts', normalizeAccounts(submission.accounts));
  for (const [key, value] of Object.entries(submission)) {
    if (!KNOWN_SECTIONS.has(key) && value !== undefined) defineOwn(normalized, key, value);
  }
  return normalized;
}

/** Sections this module normalizes; every other key passes through verbatim. */
const KNOWN_SECTIONS = new Set(['server', 'app', 'auth', 'logging', 'providers', 'accounts']);

/**
 * Defines `key` as an own data property even for the name `__proto__`, where
 * a computed assignment would instead set the object's prototype (object
 * values) or vanish (primitives) — silently swallowing a key the parser must
 * reject (review finding, task 073: a JSON-derived own `__proto__` key has
 * to reach Ajv's `additionalProperties` check like every other unknown key).
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Copies the keys this module does not know verbatim, so a typo'd nested key
 * still reaches the parser and fails with its field-addressed "unknown
 * property" message instead of being silently dropped here.
 */
function passUnknownKeys(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key) && value !== undefined) defineOwn(target, key, value);
  }
}

const SERVER_FIELDS = new Set(['host', 'port']);
const APP_FIELDS = new Set(['timezone', 'pollingIntervalSeconds', 'historyRetentionDays']);
const AUTH_FIELDS = new Set(['mode', 'passwordHash', 'password']);
const LOGGING_FIELDS = new Set(['level']);
const PROVIDER_FIELDS = new Set(['requestTimeoutSeconds', 'peakHours']);
const PEAK_HOURS_FIELDS = new Set(['timezone', 'offPeakMultiplier', 'windows']);
const WINDOW_FIELDS = new Set(['id', 'name', 'days', 'start', 'end', 'multiplier']);
const ACCOUNT_FIELDS = new Set(['id', 'providerId', 'label', 'enabled', 'apiKey', 'apiKeyEnv']);

function normalizeServer(section: unknown, problems: string[]): unknown {
  if (section === undefined) return undefined;
  if (!isPlainObject(section)) return section;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'host', trimmedString(section.host));
  assignDefined(normalized, 'port', coercedInteger('server.port', section.port, problems));
  passUnknownKeys(normalized, section, SERVER_FIELDS);
  return normalized;
}

function normalizeApp(section: unknown, problems: string[]): unknown {
  if (section === undefined) return undefined;
  if (!isPlainObject(section)) return section;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'timezone', trimmedString(section.timezone));
  assignDefined(
    normalized,
    'pollingIntervalSeconds',
    coercedInteger('app.pollingIntervalSeconds', section.pollingIntervalSeconds, problems),
  );
  assignDefined(
    normalized,
    'historyRetentionDays',
    coercedInteger('app.historyRetentionDays', section.historyRetentionDays, problems),
  );
  passUnknownKeys(normalized, section, APP_FIELDS);
  return normalized;
}

/**
 * The auth section minus `password` (extracted up front) — `mode` trimmed,
 * `passwordHash` verbatim: it is an opaque secret, so no trimming and no
 * transformation, only the blank-means-not-supplied rule.
 */
function normalizeAuth(section: unknown): unknown {
  if (section === undefined) return undefined;
  if (!isPlainObject(section)) return section;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'mode', trimmedString(section.mode));
  if (typeof section.passwordHash === 'string' && section.passwordHash.trim() !== '') {
    normalized.passwordHash = section.passwordHash;
  } else if (section.passwordHash !== undefined && typeof section.passwordHash !== 'string') {
    normalized.passwordHash = section.passwordHash;
  }
  passUnknownKeys(normalized, section, AUTH_FIELDS);
  return normalized;
}

function normalizeLogging(section: unknown): unknown {
  if (section === undefined) return undefined;
  if (!isPlainObject(section)) return section;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'level', trimmedString(section.level));
  passUnknownKeys(normalized, section, LOGGING_FIELDS);
  return normalized;
}

function normalizeProviders(section: unknown, problems: string[]): unknown {
  if (section === undefined) return undefined;
  if (!isPlainObject(section)) return section;
  const normalized: Record<string, unknown> = {};
  for (const [providerId, provider] of Object.entries(section)) {
    if (provider === undefined) continue;
    if (!isPlainObject(provider)) {
      defineOwn(normalized, providerId, provider);
      continue;
    }
    const entry: Record<string, unknown> = {};
    assignDefined(
      entry,
      'requestTimeoutSeconds',
      coercedInteger(
        `providers.${providerId}.requestTimeoutSeconds`,
        provider.requestTimeoutSeconds,
        problems,
      ),
    );
    if (provider.peakHours !== undefined) {
      assignDefined(
        entry,
        'peakHours',
        normalizePeakHours(providerId, provider.peakHours, problems),
      );
    }
    passUnknownKeys(entry, provider, PROVIDER_FIELDS);
    defineOwn(normalized, providerId, entry);
  }
  return normalized;
}

function normalizePeakHours(providerId: string, peakHours: unknown, problems: string[]): unknown {
  if (!isPlainObject(peakHours)) return peakHours;
  const normalized: Record<string, unknown> = {};
  assignDefined(normalized, 'timezone', trimmedString(peakHours.timezone));
  assignDefined(
    normalized,
    'offPeakMultiplier',
    coercedNumber(
      `providers.${providerId}.peakHours.offPeakMultiplier`,
      peakHours.offPeakMultiplier,
      problems,
    ),
  );
  if (peakHours.windows !== undefined) {
    normalized.windows = normalizeWindows(providerId, peakHours.windows, problems);
  }
  passUnknownKeys(normalized, peakHours, PEAK_HOURS_FIELDS);
  return normalized;
}

function normalizeWindows(providerId: string, windows: unknown, problems: string[]): unknown {
  if (!Array.isArray(windows)) return windows;
  return windows.map((window, index) => {
    if (!isPlainObject(window)) return window;
    const at = `providers.${providerId}.peakHours.windows[${index}]`;
    const normalized: Record<string, unknown> = {};
    assignDefined(normalized, 'id', trimmedString(window.id));
    assignDefined(normalized, 'name', trimmedString(window.name));
    if (window.days !== undefined) {
      // A blank day string stays: the parser's closed-enum message addresses
      // it by index, which omitting would silently re-index.
      normalized.days = Array.isArray(window.days)
        ? window.days.map((day) => (typeof day === 'string' ? day.trim() : day))
        : window.days;
    }
    assignDefined(normalized, 'start', trimmedString(window.start));
    assignDefined(normalized, 'end', trimmedString(window.end));
    assignDefined(
      normalized,
      'multiplier',
      coercedNumber(`${at}.multiplier`, window.multiplier, problems),
    );
    passUnknownKeys(normalized, window, WINDOW_FIELDS);
    return normalized;
  });
}

/**
 * Account secrets are verbatim (`apiKey`); identifiers and labels are trim-
 * normalized. `enabled` and any unrecognized field pass through for the
 * parser.
 */
function normalizeAccounts(section: unknown): unknown {
  if (section === undefined) return undefined;
  if (!Array.isArray(section)) return section;
  return section.map((account) => {
    if (!isPlainObject(account)) return account;
    const normalized: Record<string, unknown> = {};
    assignDefined(normalized, 'id', trimmedString(account.id));
    assignDefined(normalized, 'providerId', trimmedString(account.providerId));
    assignDefined(normalized, 'label', trimmedString(account.label));
    if (account.enabled !== undefined) normalized.enabled = account.enabled;
    if (typeof account.apiKey === 'string' && account.apiKey.trim() !== '') {
      normalized.apiKey = account.apiKey;
    } else if (account.apiKey !== undefined && typeof account.apiKey !== 'string') {
      normalized.apiKey = account.apiKey;
    }
    assignDefined(normalized, 'apiKeyEnv', trimmedString(account.apiKeyEnv));
    passUnknownKeys(normalized, account, ACCOUNT_FIELDS);
    return normalized;
  });
}

/* ── Field normalizers ─────────────────────────────────────────────────── */

/**
 * A non-secret string: trimmed; blank-after-trim means "not supplied"
 * (`undefined`). Non-strings pass through for the parser to reject.
 */
function trimmedString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * An integer setting (spec §5.3, §7.1, §7.2, §11.3): numeric strings are
 * coerced, anything else non-numeric fails with one field-specific problem
 * and the field is omitted (so the parser never adds a second, noisier
 * message for the same mistake). Native numbers pass through — ranges stay
 * with the schema.
 */
function coercedInteger(field: string, value: unknown, problems: string[]): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (INTEGER_PATTERN.test(trimmed)) return Number(trimmed);
  problems.push(`${field}: expected an integer`);
  return undefined;
}

/** A number setting (the peak-hours multipliers): as `coercedInteger`, fractional. */
function coercedNumber(field: string, value: unknown, problems: string[]): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (NUMBER_PATTERN.test(trimmed)) return Number(trimmed);
  problems.push(`${field}: expected a number`);
  return undefined;
}

const INTEGER_PATTERN = /^[+-]?\d+$/;
// Flat alternation, no nested quantifiers (keeps it linear for every input).
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/* ── Merge over the current configuration (spec §5.3 idempotent init) ──── */

/**
 * Overlays the normalized submission on the current configuration: the six
 * known sections merge field-wise (arrays and non-object section values
 * replace wholesale), unknown submission keys pass through for the parser.
 * A pending password drops any base `passwordHash` — the password the caller
 * will hash replaces it.
 */
function mergeOverBase(
  normalized: Record<string, unknown>,
  base: CanonicalConfig,
  passwordReplacesHash: boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(normalized)) {
    if (!KNOWN_SECTIONS.has(key) && value !== undefined) defineOwn(merged, key, value);
  }
  merged.server = mergeObjectSection(base.server, normalized.server);
  merged.app = mergeObjectSection(base.app, normalized.app);
  merged.logging = mergeObjectSection(base.logging, normalized.logging);
  merged.providers = mergeProvidersSection(base.providers, normalized.providers);
  merged.auth = mergeAuthSection(base, normalized.auth, passwordReplacesHash);
  merged.accounts = normalized.accounts ?? base.accounts;
  return merged;
}

/** Field-wise merge; a non-object submission section replaces wholesale. */
function mergeObjectSection(baseSection: object, normalizedSection: unknown): unknown {
  if (normalizedSection === undefined) return baseSection;
  if (!isPlainObject(normalizedSection)) return normalizedSection;
  return { ...baseSection, ...normalizedSection };
}

/**
 * The auth merge with the password-replacement rule: when a pending password
 * exists the base hash is dropped (the placeholder — later the real hash —
 * takes its place); `mode` keeps its normal field-wise override semantics.
 */
function mergeAuthSection(
  base: CanonicalConfig,
  normalizedSection: unknown,
  passwordReplacesHash: boolean,
): unknown {
  if (normalizedSection === undefined && !passwordReplacesHash) return base.auth;
  if (!isPlainObject(normalizedSection)) return normalizedSection;
  const merged: Record<string, unknown> = { ...base.auth, ...normalizedSection };
  if (passwordReplacesHash) delete merged.passwordHash;
  return merged;
}

/**
 * Providers merge per id: an existing provider's entry merges field-wise
 * (peak `windows` inside `peakHours` replace wholesale — arrays have no
 * meaningful per-element merge); a new provider id replaces wholesale.
 */
function mergeProvidersSection(base: ProvidersConfig, normalizedSection: unknown): unknown {
  if (normalizedSection === undefined) return base;
  if (!isPlainObject(normalizedSection)) return normalizedSection;
  const merged: Record<string, unknown> = { ...base };
  for (const [providerId, provider] of Object.entries(normalizedSection)) {
    const baseProvider = base[providerId];
    if (!isPlainObject(provider) || !isPlainObject(baseProvider)) {
      defineOwn(merged, providerId, provider);
      continue;
    }
    const overlay: Record<string, unknown> = { ...provider };
    if (isPlainObject(provider.peakHours)) {
      overlay.peakHours = { ...baseProvider.peakHours, ...provider.peakHours };
    }
    defineOwn(merged, providerId, { ...baseProvider, ...overlay });
  }
  return merged;
}
