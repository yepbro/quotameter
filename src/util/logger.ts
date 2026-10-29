/**
 * Structured redacting logger (spec §16, §15.4; task 072, decision D-025).
 *
 * This is the module every layer logs through — the layout rule "secrets stop
 * at their layer" ends here, at the process exit side (the counterpart of the
 * entry-side construction gate on `AccountContext`, D-013). Spec §15.4 is
 * absolute: keys "must never appear in … logs", "including at debug level",
 * so redaction is structural, not level-based: whatever the configured level,
 * the same sanitizer runs on every record.
 *
 * Mechanism (decision D-025) — two layers around one Pino instance:
 *
 * - **Layer A (Pino configuration)** — `redact` paths for the sensitive key
 *   names (exact spellings at depths 0–2) and a custom `err` serializer that
 *   runs the deep sanitizer. It protects the underlying instance exposed as
 *   {@link Logger.pino}, which integrations such as the Fastify logger of
 *   task 146 consume directly and which therefore must redact on its own.
 * - **Layer B (the wrapper)** — the sanctioned first-party surface. A deep,
 *   cycle-safe sanitizer rewrites the merging object and the message string
 *   before Pino sees them: sensitive keys by name at any depth, known secret
 *   values wherever they occur in strings, and `Error` payloads (message,
 *   stack, cause chain, custom properties) normalized through Pino's
 *   `errWithCause` serializer and then sanitized.
 *
 * Levels: spec §16 fixes the *configuration* surface at
 * `error|warn|info|debug` with default `warn` — pinned by `LOG_LEVELS` in
 * `src/schemas/config.ts`, a deliberate twin of this module's full Pino
 * ladder (both layers are leaves and cannot import each other, D-009). The
 * wrapper exposes all six Pino levels so the marker-secret proof can cover
 * every level and crash paths can use `fatal`; which levels users may
 * configure stays the config layer's policy.
 *
 * Failure contract: creation validates its options and throws (wiring
 * mistakes fail fast, the registry style of D-013), but every log call is
 * synchronous and never throws — diagnostics must never take down the
 * service, the same rule the lifecycle seams apply (D-020).
 */

import { pino, stdSerializers, type DestinationStream, type Logger as PinoLogger } from 'pino';

/* ── Levels ────────────────────────────────────────────────────────────── */

/**
 * The full Pino level ladder this module can emit at. A deliberate superset
 * of the four supported configuration levels of spec §16 — see the module
 * comment and D-025.
 */
export const LOG_LEVEL_LADDER = Object.freeze([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const);

/** One level of {@link LOG_LEVEL_LADDER}. */
export type LadderLevel = (typeof LOG_LEVEL_LADDER)[number];

/** The spec §16 default log level. */
export const DEFAULT_LOG_LEVEL: LadderLevel = 'warn';

/** The `name` field every log record carries unless overridden. */
export const DEFAULT_LOGGER_NAME = 'quotameter';

/* ── Redaction vocabulary ──────────────────────────────────────────────── */

/** The placeholder that replaces every redacted value (spec §15.4). */
export const REDACTED = '[REDACTED]';

/** Placeholder for a reference cycle inside a logged payload. */
const CIRCULAR = '[Circular]';

/** Placeholder for a value whose property access threw (a hostile getter). */
const UNREADABLE = '[Unreadable]';

/**
 * Sensitive key names in normalized form (lowercase, non-alphanumerics
 * stripped). Matching is by normalized equality, so `apiKey`, `API_KEY`,
 * `api-key`, and `api_key` all hit the `apikey` entry. The list is closed
 * and deliberately errs on the side of redaction; additions are safe and
 * documented in `src/util/README.md`.
 */
export const SENSITIVE_KEY_NAMES = Object.freeze([
  'apikey',
  'apikeyenv',
  'apisecret',
  'clientsecret',
  'secret',
  'password',
  'passwordhash',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'authorization',
  'proxyauthorization',
  'authheader',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'bearertoken',
  'bearer',
  'cookie',
  'setcookie',
  'sessionid',
  'sessionkey',
  'credentials',
]);

const sensitiveKeys = new Set<string>(SENSITIVE_KEY_NAMES);

/**
 * Exact key spellings covered by the Layer A Pino `redact` paths: the
 * canonical camelCase names, their snake_case variants, and the HTTP header
 * forms of the header-shaped ones. Layer B normalizes, so this list only
 * needs the spellings plausibly seen by raw-instance consumers.
 */
const SENSITIVE_SPELLINGS = Object.freeze([
  'apiKey',
  'apiKeyEnv',
  'api_key',
  'api_key_env',
  'apiSecret',
  'api_secret',
  'clientSecret',
  'client_secret',
  'secret',
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'new_password',
  'oldPassword',
  'old_password',
  'currentPassword',
  'current_password',
  'authorization',
  'Authorization',
  'proxyAuthorization',
  'proxy_authorization',
  'Proxy-Authorization',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'token',
  'bearerToken',
  'bearer_token',
  'bearer',
  'cookie',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'sessionId',
  'session_id',
  'sessionKey',
  'session_key',
  'credentials',
]);

/**
 * Layer A redaction paths: every sensitive spelling at depths 0, 1, and 2
 * (`key`, `*.key`, `*.*.key` — the deepest wildcards Pino's redaction
 * supports). Arbitrary depth is Layer B's job.
 */
const REDACT_PATHS = Object.freeze(
  SENSITIVE_SPELLINGS.flatMap((spelling) =>
    ['', '*.', '*.*.'].map((prefix) => `${prefix}${spelling}`),
  ),
);

function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** Replaces every occurrence of every known secret inside `value`. */
function scrubSecrets(value: string, secrets: readonly string[]): string {
  let scrubbed = value;
  for (const secret of secrets) {
    if (scrubbed.includes(secret)) {
      // split/join instead of RegExp: secrets are arbitrary strings whose
      // regex metacharacters must be matched literally.
      scrubbed = scrubbed.split(secret).join(REDACTED);
    }
  }
  return scrubbed;
}

/**
 * Deeply sanitizes a log payload (decision D-025, Layer B).
 *
 * Own enumerable string properties only — the non-enumerable D-013
 * `AccountContext.secret` is invisible here by construction, exactly as
 * designed. `Error` values are normalized to Pino's `errWithCause` shape
 * (type, message, stack, cause chain, custom properties) and sanitized, so
 * a secret embedded in an error message or stack trace cannot survive.
 * Cycles collapse to {@link CIRCULAR}; a reference repeated in *different*
 * branches (not an ancestor) serializes in each branch. A value whose
 * property access throws (a hostile getter) collapses to an `[Unreadable]`
 * placeholder — one hostile value never costs the whole record.
 */
function sanitizeValue(
  value: unknown,
  secrets: readonly string[],
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') {
    return scrubSecrets(value, secrets);
  }
  if (value === null || typeof value !== 'object') {
    // Numbers, booleans, bigints, symbols, undefined: nothing to redact.
    // Functions are dropped by JSON serialization downstream.
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  ancestors.add(value);
  let result: unknown;
  if (value instanceof Date) {
    // An invalid Date's toISOString() throws RangeError, which would cost
    // the whole record; JSON's own rendering of it is null — match that.
    result = Number.isNaN(value.getTime()) ? null : value.toISOString();
  } else if (value instanceof Error) {
    try {
      result = sanitizeValue(stdSerializers.errWithCause(value), secrets, ancestors);
    } catch {
      // A hostile property getter on the error: fail closed for the error,
      // not for the record.
      result = UNREADABLE;
    }
  } else if (Array.isArray(value)) {
    // Indexed reads (not map) so a throwing element getter is caught here
    // instead of inside Array.prototype.map's own element read.
    const list: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      try {
        list.push(sanitizeValue(value[index], secrets, ancestors));
      } catch {
        list.push(UNREADABLE);
      }
    }
    result = list;
  } else {
    // Object.keys does not invoke getters; the per-property read below is
    // guarded so one hostile getter costs only its own property.
    const source = value as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      try {
        record[key] = isSensitiveKey(key)
          ? REDACTED
          : sanitizeValue(source[key], secrets, ancestors);
      } catch {
        record[key] = UNREADABLE;
      }
    }
    result = record;
  }
  ancestors.delete(value);
  return result;
}

/**
 * Sanitizes a record payload; a plain object in always yields a plain object
 * out (the sanitizer clones containers), so the cast is safe by construction.
 */
function sanitizeRecord(
  record: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Record<string, unknown> {
  return sanitizeValue(record, secrets, new Set()) as Record<string, unknown>;
}

/* ── Public types ──────────────────────────────────────────────────────── */

/** Structured data attached to a log call; values are sanitized deeply. */
export type LogData = Readonly<Record<string, unknown>>;

/** A message plus optional structured data — the sanctioned call shape. */
export type LogCall = (message: string, data?: LogData) => void;

/**
 * The application logger. First-party code uses the level methods and never
 * touches {@link pino} directly; integrations that require a genuine Pino
 * instance (the Fastify logger of task 146) take {@link pino}, which still
 * redacts through its Layer A configuration.
 */
export interface Logger {
  /** The configured Pino instance (Layer A protection; see the module comment). */
  readonly pino: PinoLogger;
  /** Current level; §16 defaults to `warn`. */
  readonly level: LadderLevel;
  /** Changes the level at runtime (reload path, decision D-023). Throws on an unknown level. */
  setLevel(level: LadderLevel): void;
  /** Emits a record at every Pino level — see the module comment on §16's four configuration levels. */
  readonly trace: LogCall;
  readonly debug: LogCall;
  readonly info: LogCall;
  readonly warn: LogCall;
  readonly error: LogCall;
  readonly fatal: LogCall;
  /** Derives a logger whose records carry the (sanitized) `bindings` fields. */
  child(bindings: LogData): Logger;
}

/** Options accepted by {@link createLogger}; all optional. */
export interface LoggerOptions {
  /**
   * Initial level from {@link LOG_LEVEL_LADDER}; defaults to `warn`
   * (spec §16). The configuration contract restricts users to the four §16
   * levels — that policy lives in `src/schemas/config.ts`.
   */
  readonly level?: LadderLevel;
  /** The `name` field of every record; defaults to `quotameter`. */
  readonly name?: string;
  /**
   * Known secret values (marker secrets, API keys) redacted wherever they
   * occur — interpolated into messages, field values, array elements, error
   * text. Blank entries are ignored. Key-name redaction applies
   * independently of this list.
   */
  readonly secrets?: readonly string[];
  /**
   * Destination stream for the JSON lines; defaults to `process.stdout`
   * (spec §16: stdout/stderr collected by journald — one JSON stream, with
   * the destination injectable so tests and alternate setups never patch
   * process globals).
   */
  readonly destination?: DestinationStream;
}

/* ── Construction ──────────────────────────────────────────────────────── */

function requireLadderLevel(level: string): LadderLevel {
  if (!(LOG_LEVEL_LADDER as readonly string[]).includes(level)) {
    throw new Error(
      `log level must be one of: ${LOG_LEVEL_LADDER.join(', ')}; got '${level}' (spec §16 supports ` +
        `error, warn, info, debug for configuration)`,
    );
  }
  return level as LadderLevel;
}

/** Drops blank entries; a blank marker would redact everything and nothing. */
function collectSecrets(secrets: readonly string[] | undefined): string[] {
  if (secrets === undefined) return [];
  return secrets.filter((secret) => secret.trim() !== '');
}

function makeEmitter(
  level: LadderLevel,
  instance: PinoLogger,
  secrets: readonly string[],
): LogCall {
  return (message, data) => {
    try {
      // Skip the sanitization cost when the level filter would drop the
      // record anyway (the default level is 'warn'; debug/trace/info calls
      // are the hot, usually-discarded path).
      if (!instance.isLevelEnabled(level)) return;
      const sanitizedMessage = scrubSecrets(message, secrets);
      if (data === undefined) {
        instance[level](sanitizedMessage);
      } else {
        instance[level](sanitizeRecord(data, secrets), sanitizedMessage);
      }
    } catch {
      // Diagnostics must never take down the caller — the D-020 seam rule,
      // applied to every emitter (a broken destination or a hostile payload
      // with throwing getters stops here).
    }
  };
}

/** Wraps a configured Pino instance in the Layer B surface. */
function wrapLogger(instance: PinoLogger, secrets: readonly string[]): Logger {
  const emit = (level: LadderLevel): LogCall => makeEmitter(level, instance, secrets);
  return {
    pino: instance,
    get level(): LadderLevel {
      return instance.level as LadderLevel;
    },
    setLevel(level) {
      instance.level = requireLadderLevel(level);
    },
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child(bindings) {
      return wrapLogger(instance.child(sanitizeRecord(bindings, secrets)), secrets);
    },
  };
}

/**
 * Creates the structured redacting logger (spec §16, §15.4).
 *
 * The returned wrapper is synchronous and never throws on emission; invalid
 * options (an unknown level) throw at construction — wiring mistakes fail
 * fast, runtime diagnostics never do.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = requireLadderLevel(options.level ?? DEFAULT_LOG_LEVEL);
  const secrets = collectSecrets(options.secrets);
  const instance = pino(
    {
      level,
      name: options.name ?? DEFAULT_LOGGER_NAME,
      // Layer A: protects the exposed raw instance (task 146 integrations).
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
      serializers: {
        err: (value: unknown) => sanitizeValue(value, secrets, new Set()),
      },
    },
    options.destination ?? process.stdout,
  );
  return wrapLogger(instance, secrets);
}

/* ── Lifecycle seam ────────────────────────────────────────────────────── */

/**
 * The structural event shape the lifecycle sink accepts. `src/util` is a
 * leaf and cannot import the event unions of `src/server/app.ts`
 * (`LifecycleEvent`) and `src/server/shutdown.ts` (`ShutdownEvent`); this
 * supertype is assignable from both, so those call sites adopt the sink
 * without any edit here.
 */
export type LifecycleLogEvent = { readonly type: string } & Record<string, unknown>;

/**
 * Adapts {@link Logger} to the reserved lifecycle seams (`onLifecycle` of
 * task 060, `onEvent` of task 075): a synchronous sink that logs
 * `lifecycle: <type>` at `info` — spec §16's "at `info`, log only lifecycle
 * events" — and never throws (decision D-020: diagnostics must never affect
 * the lifecycle).
 */
export function createLifecycleSink(logger: Logger): (event: LifecycleLogEvent) => void {
  return (event) => {
    try {
      logger.info(`lifecycle: ${event.type}`, { event });
    } catch {
      // The emitters never throw, but reading `event.type` can (a hostile
      // payload with a throwing getter) — the D-020 contract holds anyway.
    }
  };
}
