/**
 * Central typed configuration contract — trust boundary 3 (spec §6.2).
 *
 * This module owns the shape of `config.json`: the TypeBox schemas that task
 * 062 publishes as JSON Schema and task 064 compiles with Ajv, the derived
 * TypeScript types every consumer shares, and the cross-field invariants JSON
 * Schema cannot express, encoded once here as `findConfigProblems` (the
 * `problems` vocabulary of `boundary.ts`). Loading, applying defaults, and
 * refusing to start on invalid configuration are `src/config/` mechanics
 * (tasks 064+); this file is the contract they enforce. See
 * docs/architecture/trust-boundaries.md, boundary 3.
 *
 * Scope decisions (decision D-014):
 *
 * - The contract is provider-agnostic. Provider-specific values — in
 *   particular Z.ai's `offPeakMultiplier: 0.5` (spec §9.1) — are
 *   configuration *data* seeded by `init` and the example config, never
 *   schema constraints.
 * - Structural rules (types, ranges, patterns, closed enums) live in the
 *   schemas; semantic cross-field rules live in `findConfigProblems`. The
 *   split mirrors `metrics.ts` (D-010): the invariant checker receives data
 *   that already passed structural validation.
 * - Every object closes with `additionalProperties: false`: the file is
 *   hand-edited and applied via `quotameter reload` (spec §9.2), so a typo'd
 *   key must fail validation instead of being silently ignored.
 * - Secrets (`apiKey`, `apiKeyEnv`, `passwordHash`) are opaque non-empty
 *   strings here; nothing constrains or transforms their content, and no
 *   function in this module ever emits their values.
 */

import { type Static, Type } from '@sinclair/typebox';

/* ── Closed enums ──────────────────────────────────────────────────────── */

/**
 * Every authentication mode the application supports (spec §15.1): `auto`
 * (default — direct loopback needs no password) and `required` (a password
 * is always demanded; recommended behind a reverse proxy).
 */
export const AUTH_MODES = Object.freeze(['auto', 'required'] as const);

/** Whether and when the web interface demands the password (spec §15.1). */
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Every log level the application supports (spec §16). The default is `warn`;
 * HTTP request logging is a runtime behavior tied to these levels, not a
 * separate setting.
 */
export const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug'] as const);

/** Pino log level (spec §16). */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Every weekday abbreviation the peak-hours schedule accepts (spec §9.2);
 * calendar day selection uses the schedule time zone.
 */
export const WEEK_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const);

/** A weekday a peak window applies to (spec §9.2). */
export type WeekDay = (typeof WEEK_DAYS)[number];

const WeekDaySchema = Type.Union([
  Type.Literal('mon'),
  Type.Literal('tue'),
  Type.Literal('wed'),
  Type.Literal('thu'),
  Type.Literal('fri'),
  Type.Literal('sat'),
  Type.Literal('sun'),
]);

/* ── Section schemas ───────────────────────────────────────────────────── */

/**
 * URL-safe identifier charset shared by account ids and provider record
 * keys — both surface in API paths and storage keys (spec §13).
 */
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';

/** HTTP listener settings (spec §5.3, §15.1). */
export const ServerConfigSchema = Type.Object(
  {
    /** Bind address; the loopback default keeps the service private (spec §15.1). */
    host: Type.Optional(
      Type.String({
        minLength: 1,
        default: '127.0.0.1',
        description: 'Bind address; a non-loopback value requires a password (spec §15.1).',
      }),
    ),
    /** TCP port to listen on. */
    port: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 65535,
        default: 8787,
        description: 'TCP port (spec §5.3).',
      }),
    ),
  },
  { additionalProperties: false },
);

/** Application behavior settings (spec §6.2, §7.1, §10, §11.3). */
export const AppConfigSchema = Type.Object(
  {
    /**
     * User display time zone. Mandatory and explicit — it must never silently
     * inherit the server/OS time zone (spec §5.3, §10) — which is why the
     * field is required and has no default.
     */
    timezone: Type.String({
      minLength: 1,
      description: 'IANA display time zone; mandatory and never inherited (spec §10).',
    }),
    /** Collection interval; valid range 60–3600 seconds (spec §7.1). */
    pollingIntervalSeconds: Type.Optional(
      Type.Integer({
        minimum: 60,
        maximum: 3600,
        default: 300,
        description: 'Collection interval in seconds, 60–3600 (spec §7.1).',
      }),
    ),
    /** History retention; accepted range 7–3650 days (spec §11.3). */
    historyRetentionDays: Type.Optional(
      Type.Integer({
        minimum: 7,
        maximum: 3650,
        default: 180,
        description: 'History retention in days, 7–3650 (spec §11.3).',
      }),
    ),
  },
  { additionalProperties: false },
);

/** Single-user authentication settings (spec §15.1, §15.2). */
export const AuthConfigSchema = Type.Object(
  {
    /** When the web interface demands the password (spec §15.1). */
    mode: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('required')], {
        default: 'auto',
        description: 'Password policy: "auto" (loopback may skip it) or "required".',
      }),
    ),
    /**
     * scrypt password hash. Absent means no password is configured; the
     * encoding (algorithm, salt, parameters) is owned by the auth service
     * (spec §15.2), not by this contract.
     */
    passwordHash: Type.Optional(
      Type.String({ minLength: 1, description: 'scrypt password hash (spec §15.2).' }),
    ),
  },
  { additionalProperties: false },
);

/** Logging settings (spec §16). */
export const LoggingConfigSchema = Type.Object(
  {
    /** Pino log level; default `warn` (spec §16). */
    level: Type.Optional(
      Type.Union(
        [Type.Literal('error'), Type.Literal('warn'), Type.Literal('info'), Type.Literal('debug')],
        {
          default: 'warn',
          description: 'Log level: error, warn, info, or debug (spec §16).',
        },
      ),
    ),
  },
  { additionalProperties: false },
);

/** `HH:mm` with a leading zero, 00:00–23:59 — a window start (spec §9.2). */
const HHMM_START_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

/** `HH:mm` as above, or `24:00` to end at midnight — a window end (spec §9.2). */
const HHMM_END_PATTERN = '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$';

/** One peak window inside a provider's schedule (spec §9.2). */
export const PeakWindowSchema = Type.Object(
  {
    /** Stable identifier; unique within its schedule (checked by the invariants). */
    id: Type.String({ minLength: 1, description: 'Stable window identifier.' }),
    /** English display label. */
    name: Type.String({ minLength: 1, description: 'Human-readable window name.' }),
    /** Weekdays the window applies to; at least one, no duplicates (spec §9.2). */
    days: Type.Array(WeekDaySchema, {
      minItems: 1,
      uniqueItems: true,
      description: 'Days of week, a non-empty subset of mon–sun.',
    }),
    /** Inclusive local start time. */
    start: Type.String({ pattern: HHMM_START_PATTERN, description: 'Local start, HH:mm.' }),
    /** Exclusive local end time; `24:00` ends at midnight (spec §9.2). */
    end: Type.String({ pattern: HHMM_END_PATTERN, description: 'Local end, HH:mm or 24:00.' }),
    /** Quota-credit rate during the window, relative to the standard rate. */
    multiplier: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        default: 1,
        description: 'Credit-rate multiplier during the window; positive (spec §9.2).',
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * A provider's peak-hours schedule (spec §9.1, §9.2). `windows` is required:
 * a provider without a verified schedule carries an empty array and the UI
 * shows "Peak-hours schedule is not configured" (spec §9.2).
 */
export const PeakHoursConfigSchema = Type.Object(
  {
    /** Schedule time zone; independent of the user's display time zone (spec §9.2, §10). */
    timezone: Type.String({
      minLength: 1,
      description: 'IANA time zone the schedule is expressed in (spec §9.2).',
    }),
    /** Credit-rate multiplier outside every window; `1.0` when omitted (spec §9.2). */
    offPeakMultiplier: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        default: 1,
        description: 'Multiplier outside windows; defaults to 1.0 (spec §9.2).',
      }),
    ),
    /** Peak windows; may be empty when no schedule is verified (spec §9.2). */
    windows: Type.Array(PeakWindowSchema, { description: 'Peak windows in local schedule time.' }),
  },
  { additionalProperties: false },
);

/** Per-provider settings, shared by all of that provider's accounts (spec §9.2). */
export const ProviderConfigSchema = Type.Object(
  {
    /** The provider's rate schedule; required, possibly with empty windows. */
    peakHours: PeakHoursConfigSchema,
    /** Provider HTTP request timeout; configurable 5–60 seconds (spec §7.2). */
    requestTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 5,
        maximum: 60,
        default: 15,
        description: 'Provider HTTP timeout in seconds, 5–60 (spec §7.2).',
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Provider configuration keyed by provider id (spec §9.2). The record is
 * closed: under JSON Schema `patternProperties` semantics a key matching no
 * pattern (a line separator, a space, the empty string) would otherwise be
 * unconstrained and skip validation entirely, so `additionalProperties:
 * false` plus the id charset rejects it (found in review).
 */
export const ProvidersConfigSchema = Type.Record(
  Type.String({ pattern: ID_PATTERN }),
  ProviderConfigSchema,
  { additionalProperties: false },
);

/**
 * One monitored account (spec §6.2, §6.3, §8.2). The secret source is either
 * `apiKey` or `apiKeyEnv` — exactly one, enforced by the invariants below
 * (spec §6.3); the schema keeps both optional so the derived type stays
 * ergonomic for consumers.
 */
export const AccountConfigSchema = Type.Object(
  {
    /**
     * Stable account identifier. Constrained to a URL-safe charset because
     * it appears in API paths (spec §13) and database keys.
     */
    id: Type.String({
      pattern: ID_PATTERN,
      description: 'Stable account id.',
    }),
    /** Provider adapter identifier (registry membership is checked at runtime). */
    providerId: Type.String({ minLength: 1, description: 'Provider adapter id.' }),
    /** English display label. */
    label: Type.String({ minLength: 1, description: 'Display label.' }),
    /** Whether the account is polled; a newly added account is enabled. */
    enabled: Type.Optional(Type.Boolean({ default: true, description: 'Polling on/off.' })),
    /** API key stored in the config file (spec §6.3); opaque, never echoed. */
    apiKey: Type.Optional(
      Type.String({ minLength: 1, description: 'API key stored in the config file.' }),
    ),
    /** Environment variable that supplies the API key instead (spec §6.3). */
    apiKeyEnv: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
        description: 'Environment variable name supplying the key (spec §6.3).',
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The complete `config.json` contract (spec §6.2). `app` is required because
 * `app.timezone` is mandatory and must never be defaulted (spec §10); every
 * other section may be omitted and filled from `CONFIG_DEFAULTS` at load.
 */
export const ConfigSchema = Type.Object(
  {
    server: Type.Optional(ServerConfigSchema),
    app: AppConfigSchema,
    auth: Type.Optional(AuthConfigSchema),
    logging: Type.Optional(LoggingConfigSchema),
    providers: Type.Optional(ProvidersConfigSchema),
    accounts: Type.Optional(Type.Array(AccountConfigSchema)),
  },
  { additionalProperties: false },
);

/* ── Derived types ─────────────────────────────────────────────────────── */

/** Validated `server` section (spec §5.3, §15.1). */
export type ServerConfig = Static<typeof ServerConfigSchema>;
/** Validated `app` section (spec §6.2, §7.1, §10, §11.3). */
export type AppConfig = Static<typeof AppConfigSchema>;
/** Validated `auth` section (spec §15.1, §15.2). */
export type AuthConfig = Static<typeof AuthConfigSchema>;
/** Validated `logging` section (spec §16). */
export type LoggingConfig = Static<typeof LoggingConfigSchema>;
/** Validated per-provider settings (spec §7.2, §9.2). */
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
/** All provider settings keyed by provider id (spec §9.2). */
export type ProvidersConfig = Static<typeof ProvidersConfigSchema>;
/** A provider's peak-hours schedule (spec §9.2). */
export type PeakHoursConfig = Static<typeof PeakHoursConfigSchema>;
/** One peak window (spec §9.2). */
export type PeakWindow = Static<typeof PeakWindowSchema>;
/** One account (spec §6.2, §6.3). */
export type AccountConfig = Static<typeof AccountConfigSchema>;
/** One validated configuration object — trust boundary 3's output. */
export type Config = Static<typeof ConfigSchema>;

/* ── Defaults ──────────────────────────────────────────────────────────── */

/**
 * The default values the spec names, mirrored by the `default` annotations
 * inside the schemas above (task 064 applies them at load; a drift test
 * keeps the two in lockstep). `app` has no entry: `app.timezone` is mandatory
 * and must never be defaulted (spec §10), so no full default section exists.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  server: Object.freeze({ host: '127.0.0.1', port: 8787 }),
  auth: Object.freeze({ mode: 'auto' as AuthMode }),
  logging: Object.freeze({ level: 'warn' as LogLevel }),
  app: Object.freeze({ pollingIntervalSeconds: 300, historyRetentionDays: 180 }),
  provider: Object.freeze({ requestTimeoutSeconds: 15 }),
  peakHours: Object.freeze({ offPeakMultiplier: 1, windowMultiplier: 1 }),
});

/* ── Semantic helpers ──────────────────────────────────────────────────── */

/**
 * True when `name` is a valid IANA time zone identifier (spec §5.3, §9.2).
 * `Intl.DateTimeFormat` also accepts ECMA-402 offset identifiers such as
 * `+03:00`, which are not IANA names, so those are rejected explicitly.
 * IANA aliases (for example `Asia/Calcutta`) and `UTC` remain valid; name
 * resolution (case-insensitive in V8) follows `Intl` — the same resolver the
 * display path uses server-side (Luxon) and client-side (spec §10).
 */
export function isValidTimeZoneName(name: string): boolean {
  if (name.startsWith('+') || name.startsWith('-')) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `host` addresses this machine's loopback interface (spec §15.1):
 * `localhost`, any `127.0.0.0/8` IPv4 address, or `::1` (bracketed or not —
 * the bracket forms are the ones Host-header validation admits in §15.3).
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return ipv4 !== null && ipv4[1] === '127';
}

/**
 * Minutes since local midnight for an `HH:mm` or `24:00` string; only called
 * on values that passed `PeakWindowSchema` validation, so the parse cannot
 * fail. `24:00` maps to 1440, past every real start time, which makes window
 * ordering comparisons uniform.
 */
function minutesSinceMidnight(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/* ── Semantic invariants ───────────────────────────────────────────────── */

/**
 * Returns the cross-field invariant violations of `config` (already
 * structurally validated against `ConfigSchema`) as field-addressed
 * problems; an empty array means the configuration is semantically valid
 * and may be applied. Structural checking stays with the schema — this
 * function owns the rules JSON Schema cannot express.
 */
export function findConfigProblems(config: Config): string[] {
  const problems: string[] = [];

  // The display time zone must be a real IANA name (spec §5.3, §10).
  if (!isValidTimeZoneName(config.app.timezone)) {
    problems.push(`app.timezone: '${config.app.timezone}' is not a valid IANA time zone`);
  }

  // Exactly one secret source per account; ids are stable and unique
  // (spec §6.2, §6.3).
  const seenAccountIds = new Set<string>();
  for (const [index, account] of (config.accounts ?? []).entries()) {
    const at = `accounts[${index}] '${account.id}'`;
    if (account.apiKey !== undefined && account.apiKeyEnv !== undefined) {
      problems.push(`${at}: apiKey and apiKeyEnv are mutually exclusive (spec §6.3)`);
    }
    if (account.apiKey === undefined && account.apiKeyEnv === undefined) {
      problems.push(`${at}: exactly one of apiKey or apiKeyEnv must be set (spec §6.3)`);
    }
    if (seenAccountIds.has(account.id)) {
      problems.push(`accounts[${index}]: duplicate account id '${account.id}'`);
    }
    seenAccountIds.add(account.id);
  }

  // Peak-hours schedule rules per provider (spec §9.2).
  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    const { peakHours } = provider;
    const where = `providers.${providerId}.peakHours`;

    if (!isValidTimeZoneName(peakHours.timezone)) {
      problems.push(`${where}.timezone: '${peakHours.timezone}' is not a valid IANA time zone`);
    }

    const seenWindowIds = new Set<string>();
    for (const [index, window] of peakHours.windows.entries()) {
      const at = `${where}.windows[${index}] '${window.id}'`;
      const start = minutesSinceMidnight(window.start);
      const end = minutesSinceMidnight(window.end);
      // start < end also makes a cross-midnight window unrepresentable:
      // crossing midnight would require start >= end (spec §9.2).
      if (start >= end) {
        problems.push(`${at}: start '${window.start}' must be earlier than end '${window.end}'`);
      }
      if (seenWindowIds.has(window.id)) {
        problems.push(`${where}.windows[${index}]: duplicate window id '${window.id}'`);
      }
      seenWindowIds.add(window.id);
    }

    // Windows on the same day may touch but not overlap (spec §9.2). The
    // running latest end catches containment (a window nested inside an
    // earlier one) that a purely adjacent-pair comparison would miss.
    for (const day of WEEK_DAYS) {
      const onDay = peakHours.windows
        .filter((window) => window.days.includes(day))
        .sort((a, b) => minutesSinceMidnight(a.start) - minutesSinceMidnight(b.start));
      let latestEnd = -1;
      let latestEndId = '';
      for (const window of onDay) {
        if (minutesSinceMidnight(window.start) < latestEnd) {
          problems.push(
            `${where}: windows '${latestEndId}' and '${window.id}' overlap on '${day}'`,
          );
        }
        if (minutesSinceMidnight(window.end) > latestEnd) {
          latestEnd = minutesSinceMidnight(window.end);
          latestEndId = window.id;
        }
      }
    }
  }

  // Network/authentication consistency (spec §15.1): a password is required
  // whenever the bind address is not loopback or the mode demands one.
  const host = config.server?.host ?? CONFIG_DEFAULTS.server.host;
  const mode = config.auth?.mode ?? CONFIG_DEFAULTS.auth.mode;
  if (config.auth?.passwordHash === undefined && (mode === 'required' || !isLoopbackHost(host))) {
    problems.push(
      'auth: a password is required when auth.mode is "required" or server.host is not loopback (spec §15.1)',
    );
  }

  return problems;
}
