# `src/config/` — configuration mechanics

Everything around the configuration file and environment (spec §6): XDG path
resolution with `QUOTAMETER_*` overrides (`paths.ts`, task 063), loading and
validation against the schema in `src/schemas/config.ts` (064, 067), atomic
writes and permission enforcement (065, 066). The runtime `ConfigService`
facade lives in `src/services/`; this module holds the mechanics it delegates
to.

## `paths.ts` — XDG path resolution (spec §6.1, decisions D-011, D-012)

`resolveConfigDir` / `resolveDataDir` / `resolvePaths` are pure functions over
an environment snapshot (defaults to `process.env`); they return absolute,
normalized directory paths. Precedence, highest first:

1. `QUOTAMETER_CONFIG_DIR` / `QUOTAMETER_DATA_DIR` — the value **is** the
   directory (no `quotameter` segment appended); relative values are anchored
   to the current working directory.
2. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` plus the `quotameter` segment — honored
   only when absolute; relative values fall through (XDG spec leaves them
   undefined).
3. Defaults `<home>/.config/quotameter` and `<home>/.local/share/quotameter`,
   where `<home>` is an absolute `HOME` from the snapshot, else `os.homedir()`
   — also required absolute; resolution throws when neither yields a usable
   directory.

An empty string counts as unset at every level, and all values are used
verbatim — a leading `~` is not expanded (decision D-012). Creating the
directories and enforcing their `0700`/`0600` permissions is task 066; file
naming and loading inside the resolved directories is task 064.

## `write.ts` — atomic configuration writes (spec §6.3, §15.4, decision D-016)

`writeConfigFile(targetPath, config)` is the only sanctioned way to change
the configuration file on disk. The target path is a parameter — file naming
(`config.json`) is owned by config loading (064). Steps:

1. **Serialize first**: pretty-printed JSON (2-space) with a trailing
   newline, hand-editable per spec §6.2. An unserializable value aborts the
   write before any filesystem effect.
2. **Create a temp file** `.<basename>.tmp-<pid>-<random>` next to the
   target (same directory ⇒ same filesystem ⇒ the final rename is atomic)
   with `open('wx', 0o600)`: `O_EXCL` refuses to clobber or follow anything
   already at the name, so a predictable suffix cannot be abused.
3. **Write, `chmod(0600)`, `fsync`, close** — one fsync covers data and the
   mode metadata; the explicit chmod defeats any process umask.
4. **Rename** onto the target — the only operation that ever changes the
   active file.

Failure semantics: any rejection after the temp file exists closes and
unlinks it and rethrows a `Failed to atomically write configuration file
<path>` error whose `cause` carries the original error (and its `code`:
`ENOENT`, `EACCES`, `EEXIST`, …); the active file is untouched. A hard crash
can leave an inert hidden temp file behind — it never becomes active and
never blocks later writes; sweeping stale temps is future housekeeping
(startup checks, 066). The result mode is **exactly `0600` on every write**:
`rename` replaces the inode, so the previous mode is not inherited — pinning
the spec mode corrects permissive drift (e.g. a hand-set `0644`) instead of
copying it. A missing target directory is a loud `ENOENT` failure, not a
silent `mkdir` — directory creation and `0700` enforcement belong to the
startup path (066).

The optional third parameter (`WriteFilesystem`) injects the fs primitives
for deterministic integration tests; production callers never pass it.

**Rule:** may import only `src/schemas/` and `src/util/` — no services,
storage, providers, or server code.

## `load.ts` — loading and validation (spec §6.2, §6.3, §15.4, decision D-018)

`loadConfigFile(targetPath)` is the only sanctioned way to turn the file on
disk into a configuration object. The file name is pinned here:
`CONFIG_FILE_NAME` is `config.json` (spec §6.1), and
`configFilePath(configDir)` composes it with the directory resolved by
`paths.ts`. Pipeline, first failure wins:

1. **Read** the file. A missing file (`configuration file not found: <path>`)
   is reported distinctly from an unreadable one
   (`cannot read configuration file <path>: EACCES`); nothing ever throws.
2. **Parse JSON** (`parseJson`, pure and exported). V8's parser errors can
   embed a quoted snippet of the input — a secret sitting on the broken line
   would land in the message — so the snippet is stripped and only
   `invalid JSON: <context>` remains (spec §15.4).
3. **Validate structurally** (`parseConfig`, pure and exported) against the
   TypeBox contract compiled once with the 2020-12 variant of Ajv (spec §3
   "TypeBox + Ajv"; the contract's numeric `exclusiveMinimum` needs it).
   Errors are re-worded into field-addressed English problems
   (`server.port: must be >= 1`, `auth.mode: must be one of: 'auto',
'required'`, `providers: property name 'za i' must match the pattern …`);
   failed literal unions collapse their per-branch errors into one line.
   Data values are never echoed — only paths, schema constants, and, for
   type errors, the JSON type the data had.
4. **Complete defaults** from `CONFIG_DEFAULTS` (drift-locked to the schema
   annotations): every optional section is materialized, so the returned
   configuration is canonical (`providers: {}`, `accounts: []` when absent)
   and consumers never re-implement fallbacks. Absent secrets stay absent
   rather than becoming `undefined` keys. Ajv's own `useDefaults` is not
   used: it documents default insertion only for `properties`/`items`
   schemas, it mutates the validated input, and it cannot materialize
   absent whole sections.
5. **Check cross-field rules** via `findConfigProblems` (D-014): its
   problems are returned verbatim after structural validation passes.

Failures are `{ ok: false, problems }` — the `BoundaryParser` vocabulary of
`src/schemas/boundary.ts`; `configBoundaryParser` exposes step 3–5 in that
shape. Startup refuses to start on problems, reload keeps the last valid
configuration and reports them (spec §6.2, tasks 066/068); `doctor` reuses
`formatSchemaError` for schema problems. Environment overrides (067) compose
between `parseJson` and `parseConfig`; the atomic writer (065) takes the
same path via `configFilePath` — loading never writes or creates anything.
The optional second parameter (`ConfigReadFilesystem`) injects the read
primitive for deterministic tests; production callers never pass it.

## `permissions.ts` — startup permission enforcement (spec §6.3, §15.4, decision D-019)

`enforceConfigPermissions({ configDir, configFile })` is the startup
verifier required by §6.3: it creates the configuration directory when
absent and brings both objects to the spec modes — directory exactly
`0700`, file exactly `0600` (the constant `CONFIG_FILE_MODE` is shared
with `write.ts`). Policy, pinned in D-019:

- **Exact modes.** Compliant means `mode & 0o7777` equals the required
  mode, so setuid/setgid/sticky bits are cleared too, and
  stricter-than-required states (a hand-set `0500` directory or `0400`
  file) are corrected just like permissive drift — the exact-mode policy
  D-016 already applies to writes.
- **Fix = explicit `chmod` + re-verify.** `chmod` is exempt from the
  process umask (the directory-creation counterpart of D-016's `fchmod`),
  and the mode is re-read afterwards: a filesystem that accepts but does
  not apply the change still refuses startup.
- **Directory creation** walks the missing levels of the path and creates
  them one at a time, each `mkdir` followed by an explicit `chmod` to
  `0700`: Node's recursive `mkdir` would apply `mode & ~umask` to every
  new level, and a umask containing the owner-execute bit (e.g. `0177`)
  would leave the first new ancestor untraversable (`0600`), failing the
  next level's creation with a misleading `EACCES`. Per-level chmod keeps
  creation umask-proof at every depth; pre-existing levels are never
  touched (§6.3 pins the configuration directory; the ancestors hold no
  secrets).
- **The file is never created here.** An absent file passes as `'absent'`:
  creation with `0600` by construction belongs to the atomic write path
  (D-016), and an empty placeholder would be invalid JSON for the loader.
- **Symlinks on the final objects are refused.** A symlinked directory or
  file redirects where a `chmod` would land (and, for a directory, where
  later writes resolve); the atomic write's `rename` would instead
  silently replace a symlinked file — either way the operator's redirect
  is not honored, so both are refused. Symlinked _ancestors_ are not
  policed: normal path resolution applies, and the mode guarantees still
  bind to the real objects holding secrets.
- **Ownership is checked first.** Both objects must belong to the running
  uid; a foreign-owned object is uncorrectable by `chmod` and refuses with
  both uids in the message. An undeterminable uid refuses the same way the
  task-060 runtime gate does.

Refusals throw actionable English errors (`refusing to start: …`);
unexpected filesystem failures are wrapped once with the errno `cause`.
Enforcement is a startup verifier, not a race-free guard against a
concurrent writer in a parent directory: the path-based
`lstat` → `chmod` window can end only in a refusal or a mode-restricting
change — the post-fix re-read sees a substituted symlink and refuses —
never in a silent unsafe pass.

`createPermissionsCheck(options)` wraps the check as a lifecycle component
for the task-060 seam (the 074 pattern): structurally a `LifecycleComponent`
— the config layer must not import server code, so compatibility is proven
where the component is consumed. `start` enforces (a refusal aborts startup
through the app's rollback); `stop` is a no-op. The optional `filesystem`
and `getuid` parameters are test seams; production callers never pass them.
Composition-root wiring happens in the later assembly task.

## `env.ts` — environment-variable overrides (spec §6.3, §6.4, §14.5, decision D-023)

Environment-defined values take precedence over file values and are read-only
in the UI (spec §6.3). `env.ts` owns that layer as pure functions over an
environment snapshot (injectable in tests; `process.env` is never mutated):

- **`parseConfigWithEnv(fileInput, env)`** — the task 064 composition seam:
  scans the snapshot, splices the coerced values on top of the parsed file
  input, and validates the whole through `parseConfig`, so an environment
  value fails exactly like a file value — field-addressed, value-free
  problems (spec §15.4). Env-only configuration (absent file) works by
  passing `{}`.
- **`loadConfigWithEnv(targetPath, env?, filesystem?)`** — the full pipeline
  for startup and the task 068 reload: `loadConfigFile` composes the file
  stage, then overrides apply on top.

Supported variables (the `ENV_OVERRIDES` table; names mirror the field path —
upper-cased, `.` → `_`, camelCase → SNAKE_CASE — so the mapping is derivable
in both directions):

| Variable                                  | Field                        | Coercion |
| ----------------------------------------- | ---------------------------- | -------- |
| `QUOTAMETER_SERVER_HOST`                  | `server.host`                | string   |
| `QUOTAMETER_SERVER_PORT`                  | `server.port`                | integer  |
| `QUOTAMETER_APP_TIMEZONE`                 | `app.timezone`               | string   |
| `QUOTAMETER_APP_POLLING_INTERVAL_SECONDS` | `app.pollingIntervalSeconds` | integer  |
| `QUOTAMETER_APP_HISTORY_RETENTION_DAYS`   | `app.historyRetentionDays`   | integer  |
| `QUOTAMETER_AUTH_MODE`                    | `auth.mode`                  | string   |
| `QUOTAMETER_LOGGING_LEVEL`                | `logging.level`              | string   |

Semantics, pinned in D-023:

- **Precedence**: environment over file over defaults. A variable that is set
  marks its field as environment-sourced even when the value coincides with
  the file's. An empty string counts as unset (the uniform rule of D-011).
- **Coercion**: integer fields convert only pure decimal digit strings; every
  other value stays a string, and the landed parser rejects it with its
  pinned type message (`server.port: expected an integer, got a string`).
  Leading zeros are decimal (`09000` → `9000`), and a digit string long
  enough to coerce to `Infinity` fails the integer type check. Ranges,
  enums, IANA names, and cross-field rules (e.g. a password is still
  required for `QUOTAMETER_AUTH_MODE=required`) all come from `parseConfig`.
- **Unknown `QUOTAMETER_*` names are rejected** (`QUOTAMETER_SEVER_PORT:
unsupported environment variable`, codepoint-sorted so the order is
  host-independent) — a typo must fail, not silently pass (the D-014
  closed-contract philosophy). `QUOTAMETER_CONFIG_DIR` and
  `QUOTAMETER_DATA_DIR` are known and ignored here; `paths.ts` owns them.
- **Absent file**: when `loadConfigFile` reports the pinned
  `configuration file not found: <path>` problem and at least one override is
  set, the effective configuration is built from the environment alone (a
  success carries `fileAbsent: true`; a failure prepends the not-found
  problem so both facts are explained). With no overrides the missing file is
  the problem — though unsupported `QUOTAMETER_*` names are still scanned and
  reported beside it, so a typo does not wait for a file to appear; any other
  file failure (unreadable, invalid JSON, schema or cross-field problems)
  passes through verbatim — the environment never masks a broken file, and
  overrides never rescue one.
- **Read-only marking**: the success result carries `sources` — the
  overridden field paths in table order plus the ids of accounts whose secret
  source is `apiKeyEnv` (spec §6.3). This is the data the Stage 12/13 API and
  UI surface as read-only annotations (spec §14.5). No value, secret or not,
  ever enters the marking or a problem.

Secrets deliberately have no `QUOTAMETER_*` channel: account keys use the
per-account `apiKeyEnv` field (spec §6.3), and the password hash has no
spec-named environment alternative. Structured sections (`providers`,
`accounts`) do not map to single environment strings and stay file-only.
One consequence of the strict name scan: an `apiKeyEnv` value must not
itself start with `QUOTAMETER_` — the schema's variable-name pattern permits
it, but the moment such a variable is actually set in the service
environment, the scan rejects it as unsupported; point `apiKeyEnv` at a
name outside the reserved prefix.
