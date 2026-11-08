# Configuration reference

Every field of Quotameter's `config.json`: its type, default, validation rule,
environment override, and how a change takes effect (spec
[§6](../plan/SPECIFICATION.md#6-configuration-and-secrets)). The reference stays
in agreement with the shipped JSON Schema
([`schema/config.schema.json`](../schema/config.schema.json)) through an
executable drift guard (`test/unit/configuration-reference.spec.ts`, decision
D-197): the schema is generated from the canonical TypeScript contract
(`src/schemas/config.ts`, decision D-015), and the guard parses these tables and
compares them against that contract — a field added to the schema without a row
here (or a row whose default, type, range, override, or restart class drifted)
fails `make check`.

Companion documents: [docs/config-schema.md](config-schema.md) (the schema
artifact: editor validation, regeneration) and
[docs/config.example.json](config.example.json) (a complete example with one
Z.ai Coding Plan provider and account — spec defaults throughout except the
seeded Z.ai schedule, see the providers note).

## Reading order

- [File locations and permissions](#file-locations-and-permissions) — where the
  file lives, who may read it.
- [Values and precedence](#values-and-precedence) — environment over file over
  defaults; what "effective configuration" means.
- [Validation](#validation) — structural rules, cross-field rules, and what
  happens on failure.
- [Applying changes](#applying-changes) — reload vs restart, field by field.
- [Field reference](#field-reference) — the tables.
- [Environment variables](#environment-variables) — the complete
  `QUOTAMETER_*` vocabulary.
- [Secrets](#secrets) — API keys and the password hash.

## File locations and permissions

The configuration file is `config.json` inside the configuration directory; the
SQLite database lives in the data directory (spec §6.1). Both directories
resolve with XDG semantics (decisions D-011, D-012):

1. `QUOTAMETER_CONFIG_DIR` / `QUOTAMETER_DATA_DIR` — the value **is** the
   directory (no `quotameter` segment is appended). Relative values are
   honored, anchored to the current working directory.
2. `$XDG_CONFIG_HOME/quotameter` / `$XDG_DATA_HOME/quotameter` — honored only
   when absolute; relative values fall through to the defaults.
3. Defaults: `~/.config/quotameter` and `~/.local/share/quotameter`.

All values are used verbatim — a leading `~` is not expanded — and an empty
value counts as unset at every level. Resolution fails loudly (never with a
relative guess) when no absolute home directory can be determined.

The file stores secrets, so its permissions are enforced at startup (spec §6.3,
decision D-019): the configuration directory must be exactly mode `0700` and
the file exactly mode `0600`; deviations — including stricter ones — are fixed
by `chmod` and re-verified, and a fix that cannot land refuses startup.
Objects that cannot be fixed at all — foreign-owned, symlinked, or of the
wrong type, or an undeterminable running uid — refuse startup the same way.
The service writes the file atomically (temporary file, `fsync`, `rename`;
decision D-016), so a crash mid-write never destroys the previous
configuration.

## Values and precedence

Three layers compose into the effective configuration (spec §6.3, decision
D-023), highest first:

1. **Environment overrides** — the seven `QUOTAMETER_*` variables of the
   [environment table](#environment-variables), each spliced onto its field.
2. **File values** — `config.json`.
3. **Defaults** — the `Default` column below, applied wherever a field or whole
   section is omitted.

An environment-defined value is read-only in the web UI (the settings surface
marks overridden fields and `apiKeyEnv`-backed key inputs; spec §14.5). An
empty variable counts as unset. When no configuration file exists but at least
one override is set, the effective configuration is built from the environment
alone — in practice `QUOTAMETER_APP_TIMEZONE` must be among them, because
`app.timezone` is mandatory; the environment never masks a broken file — an
unreadable, malformed, or invalid file is reported as such even when overrides
could have filled in every field.

## Validation

Two layers (spec §6.2, decision D-014):

- **Structural** — types, ranges, patterns, closed enums, defaults, and unknown
  -key rejection (`additionalProperties: false` at every level: a typo'd key
  fails validation instead of being silently ignored). These rules are exactly
  the published JSON Schema; numbers must be finite.
- **Cross-field** — rules JSON Schema cannot express, checked by the
  application at startup and reload (decision D-014, the
  `findConfigProblems` invariants):

| Rule                                                                                                                                            | Where                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `app.timezone` and each `providers.<id>.peakHours.timezone` must be valid IANA time zone names (offset identifiers like `+03:00` are not names) | `app`, `providers.<id>.peakHours` |
| `apiKey` and `apiKeyEnv` are mutually exclusive per account; a keyless account is valid and keyed later                                         | `accounts[]`                      |
| Account ids are unique across the file; window ids are unique within their schedule                                                             | `accounts[]`, peak `windows[]`    |
| A window's `start` must be earlier than its `end` (a cross-midnight window is therefore unrepresentable — split it into two)                    | peak `windows[]`                  |
| Windows on the same day may touch but must not overlap                                                                                          | peak `windows[]`                  |
| A password (the `auth.passwordHash` left by `passwd`/`init`) is required when `auth.mode` is `required` or `server.host` is not loopback        | `auth`, `server.host`             |

On an invalid **startup** configuration the service refuses to start and
explains the problem; on an invalid **reload** it keeps the last valid
configuration and reports the error (spec §6.2). Schema and JSON-parse
problems are field-addressed and value-free — they never echo file contents,
so a secret on a broken line cannot leak into the message (spec §15.4); the
cross-field messages may quote a non-secret value (a time-zone name, an
account id, a window time) but never a secret.

## Applying changes

Changes reach the running service through a reload — `quotameter reload` or
`SIGHUP` (spec §6.4, decision D-026). Two classes of fields differ:

- **Reload fields** (the `reload` rows below) — the polling interval, display
  time zone, retention period, the whole `accounts` array (labels, keys,
  enabled states), the whole `providers` record (schedules and the request
  timeout, which governs the next request), the log level, and the password
  hash — take effect with the successful reload that loaded them.
- **Restart fields** — exactly `server.host`, `server.port`, and `auth.mode` —
  are validated and stored but a live process cannot rebind its listener or
  re-decide its authentication pipeline: they apply only after `quotameter
restart`. The settings UI labels them "restart required" and, since D-193,
  also shows the live pending state (which restart-marked fields currently
  differ from what the process started with) until a restart picks them up.

## Field reference

Columns: **Type** is the JSON type (`enum` marks a closed string set); **Default**
is the value applied when the field is omitted (`—` = none — the field is never
materialized with a placeholder); **Validation** lists the schema constraints
(`required` marks fields mandatory in their section) and, where marked
_cross-field_, an application-checked rule; **Environment override** is the
exact variable that overrides the field (see
[Environment variables](#environment-variables); `—` = file-only); **Applies**
says when a change takes effect (`restart` = only after `quotameter restart`,
`reload` = with the next successful reload). Every object level rejects
unknown keys; the `app` section is the only required section.

### `server` — HTTP listener (optional)

| Field         | Type    | Default     | Validation                                                                 | Environment override     | Applies |
| ------------- | ------- | ----------- | -------------------------------------------------------------------------- | ------------------------ | ------- |
| `server.host` | string  | `127.0.0.1` | `minLength 1`; a non-loopback bind demands a password (cross-field, §15.1) | `QUOTAMETER_SERVER_HOST` | restart |
| `server.port` | integer | `8787`      | `1–65535`                                                                  | `QUOTAMETER_SERVER_PORT` | restart |

The loopback default keeps the service private; see the spec §15.1 rule above
before binding a public interface.

### `app` — application behavior (required)

| Field                        | Type    | Default | Validation                                                                                         | Environment override                      | Applies |
| ---------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------- |
| `app.timezone`               | string  | —       | required; `minLength 1`; a valid IANA time zone name (cross-field) — display time, never inherited | `QUOTAMETER_APP_TIMEZONE`                 | reload  |
| `app.pollingIntervalSeconds` | integer | `300`   | `60–3600`                                                                                          | `QUOTAMETER_APP_POLLING_INTERVAL_SECONDS` | reload  |
| `app.historyRetentionDays`   | integer | `180`   | `7–3650`                                                                                           | `QUOTAMETER_APP_HISTORY_RETENTION_DAYS`   | reload  |

`app` is the only required section because `app.timezone` must never be
defaulted (spec §10): charts and timestamps are meaningless without an explicit
zone. The retention is applied at startup and daily; shrinking it below
already-stored history prunes the excess (spec §11.3).

### `auth` — single-user authentication (optional)

| Field               | Type   | Default | Validation                                                                                                   | Environment override   | Applies |
| ------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------ | ---------------------- | ------- |
| `auth.mode`         | enum   | `auto`  | one of `auto`, `required`                                                                                    | `QUOTAMETER_AUTH_MODE` | restart |
| `auth.passwordHash` | string | —       | `minLength 1`; the opaque scrypt hash the service writes (spec §15.2) — never hand-authored, never displayed | —                      | reload  |

`auto` demands the password for every non-loopback or proxied request and may
skip it for direct loopback access; `required` demands it always (recommended
behind a reverse proxy, spec §15.1). An absent hash means "no password
configured" and is only valid on loopback `auto`. The hash is checked on every
authentication attempt, so a changed hash takes effect without a restart.

### `logging` — diagnostics (optional)

| Field           | Type | Default | Validation                              | Environment override       | Applies |
| --------------- | ---- | ------- | --------------------------------------- | -------------------------- | ------- |
| `logging.level` | enum | `warn`  | one of `error`, `warn`, `info`, `debug` | `QUOTAMETER_LOGGING_LEVEL` | reload  |

One Pino level ladder (spec §16); the level applies through the next successful
reload without a restart.

### `providers.<id>` — per-provider settings (optional record)

Keys are provider ids — the registered adapter id (for example
`zai-coding-plan`) — matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Each entry
holds the settings shared by that provider's accounts.

| Field                                           | Type    | Default | Validation                                                                                          | Environment override | Applies |
| ----------------------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------- | -------------------- | ------- |
| `providers.<id>.peakHours`                      | object  | —       | required; the provider's rate schedule (fields below)                                               | —                    | reload  |
| `providers.<id>.peakHours.timezone`             | string  | —       | required; `minLength 1`; a valid IANA time zone name (cross-field); independent of `app.timezone`   | —                    | reload  |
| `providers.<id>.peakHours.offPeakMultiplier`    | number  | `1`     | `> 0`; the credit-rate multiplier outside every window                                              | —                    | reload  |
| `providers.<id>.peakHours.windows`              | array   | —       | required; may be empty (an unverified schedule); items below                                        | —                    | reload  |
| `providers.<id>.peakHours.windows[].id`         | string  | —       | required; `minLength 1`; unique within the schedule (cross-field)                                   | —                    | reload  |
| `providers.<id>.peakHours.windows[].name`       | string  | —       | required; `minLength 1`                                                                             | —                    | reload  |
| `providers.<id>.peakHours.windows[].days`       | array   | —       | required; `minItems 1`; `uniqueItems`; items one of `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` | —                    | reload  |
| `providers.<id>.peakHours.windows[].start`      | string  | —       | required; `HH:mm` with a leading zero; pattern `^([01][0-9]\|2[0-3]):[0-5][0-9]$`                   | —                    | reload  |
| `providers.<id>.peakHours.windows[].end`        | string  | —       | required; `HH:mm` or `24:00`; pattern `^(([01][0-9]\|2[0-3]):[0-5][0-9]\|24:00)$`                   | —                    | reload  |
| `providers.<id>.peakHours.windows[].multiplier` | number  | `1`     | `> 0`; the credit-rate multiplier inside the window                                                 | —                    | reload  |
| `providers.<id>.requestTimeoutSeconds`          | integer | `15`    | `5–60`; one total deadline per provider HTTP exchange (spec §7.2)                                   | —                    | reload  |

The defaults are provider-neutral (decision D-014): the Z.ai plan's verified
schedule (weekday 14:00–18:00 `Asia/Singapore`, peak `1.0`, off-peak `0.5`) is
seeded data carried by the example config — `init` writes no provider data, so
add the schedule yourself or copy the example's block; the shipped default of
both multipliers is `1`.

### `accounts` — monitored accounts (optional array)

| Field                   | Type    | Default | Validation                                                                                                       | Environment override | Applies |
| ----------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------- | ------- |
| `accounts[].id`         | string  | —       | required; pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; unique across accounts (cross-field)                       | —                    | reload  |
| `accounts[].providerId` | string  | —       | required; `minLength 1`; must be a registered provider id at runtime                                             | —                    | reload  |
| `accounts[].label`      | string  | —       | required; `minLength 1`                                                                                          | —                    | reload  |
| `accounts[].enabled`    | boolean | `true`  | disabled accounts are not polled (they keep their history)                                                       | —                    | reload  |
| `accounts[].apiKey`     | string  | —       | `minLength 1`; secret — see [Secrets](#secrets)                                                                  | —                    | reload  |
| `accounts[].apiKeyEnv`  | string  | —       | `minLength 1`; pattern `^[A-Za-z_][A-Za-z0-9_]*$`; the variable name supplying the key — see [Secrets](#secrets) | —                    | reload  |

## Environment variables

The complete `QUOTAMETER_*` vocabulary (spec §6.1, §6.3; decision D-023). The
seven **override variables** splice onto exactly one configuration field each —
names mirror the field path (`.` → `_`, camelCase → SNAKE_CASE), so the mapping
is derivable in both directions:

| Variable                                  | Field                        | Coercion |
| ----------------------------------------- | ---------------------------- | -------- |
| `QUOTAMETER_SERVER_HOST`                  | `server.host`                | string   |
| `QUOTAMETER_SERVER_PORT`                  | `server.port`                | integer  |
| `QUOTAMETER_APP_TIMEZONE`                 | `app.timezone`               | string   |
| `QUOTAMETER_APP_POLLING_INTERVAL_SECONDS` | `app.pollingIntervalSeconds` | integer  |
| `QUOTAMETER_APP_HISTORY_RETENTION_DAYS`   | `app.historyRetentionDays`   | integer  |
| `QUOTAMETER_AUTH_MODE`                    | `auth.mode`                  | string   |
| `QUOTAMETER_LOGGING_LEVEL`                | `logging.level`              | string   |

Semantics: environment over file over defaults; an empty value counts as
unset; integer variables coerce only pure decimal digit strings (anything else
fails validation with the field's own message); an overridden value is marked
read-only in the UI even when it coincides with the file's. Every other
`QUOTAMETER_*` name is **rejected** as `unsupported environment variable` — a
typo fails, it is never silently ignored.

Three **reserved names** pass the scan without touching the effective
configuration — each has a declared consumer outside the configuration layer:

| Variable                | Consumer                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUOTAMETER_CONFIG_DIR` | Directory resolution ([above](#file-locations-and-permissions)); the value is the directory itself.                                                                                                                                    |
| `QUOTAMETER_DATA_DIR`   | Directory resolution for the SQLite database and runtime state.                                                                                                                                                                        |
| `QUOTAMETER_CLI_ENTRY`  | The launcher (`bin/quotameter.mjs`): `dist`/`source` pins which CLI entry runs — a packaging/debug control that acts before any configuration is read (decision D-196; invalid values are refused fail-closed by the launcher itself). |

Secrets deliberately have no `QUOTAMETER_*` channel: account keys use the
per-account `apiKeyEnv` field, and the password hash has none at all.

## Secrets

`accounts[].apiKey` and `auth.passwordHash` are the secret-bearing fields
(spec §6.3, §15.4); `accounts[].apiKeyEnv` is the **name** of the environment
variable supplying a key. Only their **shape** is documented and validated —
opaque non-empty strings; their values never appear in this reference, the
published schema's descriptions, logs, API responses, or error messages.
Operationally:

- The key form in the web UI is write-only: it shows a mask and whether a key
  is configured, never the value.
- An `apiKeyEnv`-backed key is read from the named environment variable at
  runtime; the UI marks it read-only. The reserved `QUOTAMETER_` prefix is
  off-limits: `init --yes` refuses such `--api-key-env` values at its input
  boundary (decision D-100), and the service reserves the whole `QUOTAMETER_*`
  namespace for its own variables — point at a name outside it.
- `auth.passwordHash` is written only by the service (`quotameter passwd`,
  `init`, or the settings password change); to change the password, use those,
  never a hand-edited hash.
