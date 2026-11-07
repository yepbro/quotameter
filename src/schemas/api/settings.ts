/**
 * The §13 settings endpoint contracts (task 160, spec §13, §6.2–§6.4,
 * §14.5; decision D-130).
 *
 * TypeBox definitions for the safe settings view (`GET /api/settings`) and
 * the runtime-modification update (`PUT /api/settings`) — the §6.4 seam the
 * web settings page renders from. Two disciplines shape the file:
 *
 * - **Secrets are structurally absent.** No view object declares
 *   `apiKey`, `apiKeyEnv`, or `passwordHash` anywhere; the auth half
 *   carries `passwordConfigured` — §13's mask-and-boolean pattern (the
 *   accounts surface's `hasKey`, applied to the password). Every object is
 *   closed (`additionalProperties: false`), so the compiled serializer
 *   drops anything else (the D-111 guard, generalized since D-128).
 * - **Every scalar is annotated, not just valued.** §14.5 demands three
 *   markings (restart-required, environment-overridden read-only, masked);
 *   the view answers the first two per field — `{ value, source,
 *   restartRequired }`, where `source: 'environment'` IS the §6.3
 *   read-only marking — so the UI never re-derives precedence knowledge
 *   (D-023's standing instruction to Stage 12/13).
 *
 * The PUT body is deliberately **structural only** (types and closed
 * enums): ranges and cross-field rules ride the D-022 boundary
 * (`validateSettings` → `parseConfig`), whose field-addressed problems are
 * the single-sourced error vocabulary — a schema-level range would fork
 * the messages. The two refusable-but-declared sections (`server`,
 * `auth.mode`, `auth.passwordHash`) exist in the body schema so the
 * endpoint answers them with stable refusal reasons instead of a generic
 * schema 400 (the accounts precedent: `apiKeyEnv` rejected at the schema
 * layer as a file concern; these rejected in the handler as §6.4/§6.3
 * refusals).
 */

import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { AUTH_MODES, LOG_LEVELS } from '../config';

/* ── The annotated-field vocabulary ─────────────────────────────────────── */

/**
 * Where a setting's effective value comes from: the configuration file, or
 * a `QUOTAMETER_*` environment override (§6.3 — environment-defined values
 * take precedence and are read-only, so `'environment'` is the wire form
 * of that marking).
 */
export const SETTINGS_SOURCES = Object.freeze(['file', 'environment'] as const);

/** One setting's provenance. */
export type SettingsSource = (typeof SETTINGS_SOURCES)[number];

/**
 * Wraps one scalar setting's schema into the annotated view shape. A local
 * helper (not a shared utility): it exists to keep the three §14.5
 * markings in lockstep with the value on every field of
 * {@link SettingsViewSchema}.
 */
function annotated<T extends TSchema>(value: T, description: string) {
  return Type.Object(
    {
      value,
      source: Type.Union(
        SETTINGS_SOURCES.map((source) => Type.Literal(source)),
        {
          description: "Value provenance; 'environment' is read-only (spec §6.3).",
        },
      ),
      restartRequired: Type.Boolean({
        description: 'Whether changing this setting requires a process restart (spec §6.4).',
      }),
    },
    { additionalProperties: false, description },
  );
}

/* ── GET /api/settings — the safe view ──────────────────────────────────── */

/**
 * The safe settings view (§13: "secrets omitted/masked"). Covers exactly
 * the sections §14.5's page edits or displays: `server` and `auth` are
 * displayed with restart markings, `app` and `logging` are the
 * runtime-modifiable scalars, and `auth.passwordConfigured` replaces the
 * hash. The `accounts` array and `providers` schedules are deliberately
 * absent — §13 gives them their own surfaces (`/api/accounts`,
 * `/api/providers`), so this view cannot become a second, leak-shaped copy
 * of them (D-022's GET-then-PUT warning made structural: there is nothing
 * here to round-trip).
 */
export const SettingsViewSchema = Type.Object(
  {
    server: Type.Object(
      {
        host: annotated(Type.String({ description: 'Bind address.' }), 'The bind address.'),
        port: annotated(Type.Integer({ description: 'TCP port.' }), 'The TCP port.'),
      },
      { additionalProperties: false },
    ),
    app: Type.Object(
      {
        timezone: annotated(
          Type.String({ description: 'IANA display time zone.' }),
          'The display time zone.',
        ),
        pollingIntervalSeconds: annotated(
          Type.Integer({ description: 'Polling interval in seconds.' }),
          'The collection interval.',
        ),
        historyRetentionDays: annotated(
          Type.Integer({ description: 'Retention in days.' }),
          'The history retention period.',
        ),
      },
      { additionalProperties: false },
    ),
    auth: Type.Object(
      {
        mode: annotated(
          Type.Union(
            AUTH_MODES.map((mode) => Type.Literal(mode)),
            {
              description: 'Authentication mode.',
            },
          ),
          'The authentication mode.',
        ),
        /** §13's mask-and-boolean: whether a password hash is stored, never the hash. */
        passwordConfigured: Type.Boolean({
          description: 'Whether a password is configured.',
        }),
      },
      { additionalProperties: false },
    ),
    logging: Type.Object(
      {
        level: annotated(
          Type.Union(
            LOG_LEVELS.map((level) => Type.Literal(level)),
            {
              description: 'Log level.',
            },
          ),
          'The log level.',
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** The shape of the safe settings view. */
export type SettingsView = Static<typeof SettingsViewSchema>;

/**
 * The read-only paths §14.5 displays beside the settings — informational
 * facts of the running process (where the configuration and data live),
 * never editable and never secret. Kept outside {@link SettingsViewSchema}
 * so the pure view builder stays a function of configuration and sources.
 */
export const SettingsPathsSchema = Type.Object(
  {
    configPath: Type.String({ minLength: 1, description: 'Configuration file path.' }),
    dataDir: Type.String({ minLength: 1, description: 'Data directory path.' }),
  },
  { additionalProperties: false },
);

/** The shape of the read-only paths block. */
export type SettingsPaths = Static<typeof SettingsPathsSchema>;

/**
 * The `GET /api/settings` response. `appliedRetentionDays` (U-053, D-178)
 * is §11.3's reduce-retention warning's reference: the retention window
 * the last COMPLETED cleanup applied, read from the storage marker
 * `retention:applied-days` (D-063) — `null` before any cleanup has
 * completed (a fresh database). It stays outside {@link SettingsViewSchema}
 * beside the paths block so the pure view builder remains a function of
 * configuration and sources alone.
 */
export const SettingsResponseSchema = Type.Object(
  {
    settings: SettingsViewSchema,
    paths: SettingsPathsSchema,
    appliedRetentionDays: Type.Union([Type.Integer(), Type.Null()], {
      description:
        'The retention window in days the last completed cleanup applied; ' +
        'null before the first cleanup (spec §11.3 — the reduce-retention warning reference).',
    }),
  },
  { additionalProperties: false },
);

/** The shape `GET /api/settings` serializes to. */
export type SettingsResponse = Static<typeof SettingsResponseSchema>;

/* ── PUT /api/settings — the update body ───────────────────────────────── */

/**
 * The update body — the §6.4 live-applicable vocabulary plus the three
 * refusable declarations (§13's "Update settings allowed for runtime
 * modification", read literally — the restart-requiring trio is declared
 * only so its refusal carries a stable reason, D-130). Structural rules
 * only; ranges and cross-field invariants ride `validateSettings`
 * (D-022). Closed at every level: `accounts` and `providers` are rejected
 * at the schema layer — §9.2 keeps the schedule file-only and account
 * management has its own §13 surface — and an empty body is a client
 * error, not a no-op (the empty-patch precedent of the accounts surface).
 */
export const UpdateSettingsBodySchema = Type.Object(
  {
    server: Type.Optional(
      Type.Object(
        {
          host: Type.Optional(
            Type.String({ minLength: 1, description: 'Bind address (refused: restart required).' }),
          ),
          port: Type.Optional(
            Type.Integer({ description: 'TCP port (refused: restart required).' }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    app: Type.Optional(
      Type.Object(
        {
          timezone: Type.Optional(
            Type.String({ minLength: 1, description: 'IANA display time zone.' }),
          ),
          pollingIntervalSeconds: Type.Optional(
            Type.Integer({ description: 'Collection interval in seconds, 60–3600 (spec §7.1).' }),
          ),
          historyRetentionDays: Type.Optional(
            Type.Integer({ description: 'Retention in days, 7–3650 (spec §11.3).' }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    auth: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(
            Type.Union(
              AUTH_MODES.map((mode) => Type.Literal(mode)),
              {
                description: 'Authentication mode (refused: restart required).',
              },
            ),
          ),
          /** The §15.2 password-change channel — write-only, hashed by the store seam (D-022). */
          password: Type.Optional(
            Type.String({ minLength: 1, description: 'New password (write-only, never echoed).' }),
          ),
          /** Declared only so its refusal carries the stable reason; never accepted. */
          passwordHash: Type.Optional(
            Type.String({ minLength: 1, description: 'Refused: supply auth.password instead.' }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    logging: Type.Optional(
      Type.Object(
        {
          level: Type.Optional(
            Type.Union(
              LOG_LEVELS.map((level) => Type.Literal(level)),
              {
                description: 'Log level.',
              },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

/** The shape `PUT /api/settings` accepts. */
export type UpdateSettingsBody = Static<typeof UpdateSettingsBodySchema>;

/* ── PUT /api/settings — the apply outcome ──────────────────────────────── */

/**
 * Every field the §6.4/D-026 classification marks live-applicable — the
 * wire vocabulary of the `applied` list. Pinned against `LiveReloadField`
 * (`src/config/reload.ts`) by a schema-suite drift row.
 */
export const SETTINGS_APPLY_FIELDS = Object.freeze([
  'app.timezone',
  'app.pollingIntervalSeconds',
  'app.historyRetentionDays',
  'accounts',
  'providers',
  'logging.level',
  'auth.passwordHash',
] as const);

/**
 * The §6.4 restart-requiring fields — the wire vocabulary of the
 * `restartRequired` list. Pinned against `RESTART_REQUIRED_FIELDS`
 * (`src/config/reload.ts`) by a schema-suite drift row.
 */
export const SETTINGS_RESTART_FIELDS = Object.freeze([
  'server.host',
  'server.port',
  'auth.mode',
] as const);

/**
 * The `PUT /api/settings` outcome in D-026's own vocabulary: which live
 * fields the applied change activated, and which restart-requiring fields
 * still differ from what the process started with — non-empty exactly when
 * a pending change (a hand-edited file, carried by the reload this update
 * triggers) awaits `quotameter restart`. The PUT itself refuses
 * restart-requiring fields (D-130), so a non-empty list reports the
 * process's pending state, never this request's doing.
 */
export const UpdateSettingsResponseSchema = Type.Object(
  {
    applied: Type.Array(
      Type.Union(
        SETTINGS_APPLY_FIELDS.map((field) => Type.Literal(field)),
        {
          description: 'Live §6.4 fields this change activated.',
        },
      ),
    ),
    restartRequired: Type.Array(
      Type.Union(
        SETTINGS_RESTART_FIELDS.map((field) => Type.Literal(field)),
        {
          description: 'Restart-requiring fields pending since startup (spec §6.4).',
        },
      ),
    ),
  },
  { additionalProperties: false },
);

/** The shape `PUT /api/settings` serializes to. */
export type UpdateSettingsResponse = Static<typeof UpdateSettingsResponseSchema>;
