# `src/cli/` — command implementations

The `quotameter` command surface (spec §5.2, Stage 11): `init`, `run`,
`start`/`stop`/`restart`, `reload`, `status`, `logs`, `service`
(`install`/`uninstall`), `passwd`, and `doctor`. `bin/quotameter.mjs` stays
a thin, build-free launcher that dispatches here (compiled at publish time
— no install-time build, spec §3).

**Rule:** a top-level consumer — it may import any layer except concrete
provider adapters. Nothing under `src/` imports this module; only `bin/` does.

## Dispatch skeleton (task 128, decision D-044)

| File                 | Owns                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `main.ts`            | `runCli(argv, deps)` — global flags, dispatch, exit codes; never calls `process.exit`                 |
| `commands.ts`        | the §5.2 command table (`buildCommandTable`), handler/context types, the shared `notImplemented` stub |
| `parser.ts`          | `node:util` `parseArgs` in strict mode; options per command; `UsageError`                             |
| `help.ts`            | pure help renderers (general, command, group)                                                         |
| `output.ts`          | the `CliOutput` writer seam (`systemOutput` → `process.stdout`/`stderr`)                              |
| `prompts.ts`         | the interactive prompt seam: readline prompter with a line queue, EOF-safe questions, muted secrets   |
| `init-questions.ts`  | the §5.3 question flow: per-value validation, empty-answer semantics, answers→config assembly         |
| `init-yes.ts`        | the §5.3 non-interactive layer: `--yes` flags → answers through the same parsers, env key channel     |
| `init-persist.ts`    | the §5.3 idempotent layer: existing-config detection, masked display, merge, consented atomic write   |
| `init.ts`            | the `init` handler: mode branch, detection outcomes, cancellation, the masked summaries               |
| `raw-diagnostics.ts` | the §7.4 diagnostic read path behind `doctor --raw <account>` (task 103)                              |

Everything a handler touches is injected: output (writer seam), version
(supplied by the launcher — `src/` cannot import `package.json`, the layout
test forbids imports leaving `src/`), and the command table itself
(`deps.commands`), so tests dispatch fake tables in-process.

### Output contract

`console` is banned in `src/**` (spec §15.4 logging rule); the CLI's
stdout/stderr output is its product and flows through `CliOutput` — direct
stream writes in production, a recorder in tests. Help and version go to
stdout; every error line goes to stderr in the form
`quotameter [<command path>: ]<message>` plus a `Try 'quotameter … --help'`
hint when the error is a usage error.

### Exit codes

- `0` success — including help, version, and the no-arguments help;
- `1` command failure — a handler error or a not-yet-implemented command;
- `2` usage error — unknown command/subcommand/option, missing subcommand,
  unexpected argument.

Global flags are checked in the order version → help, so `quotameter
--version --help` prints the version (the launcher's fast path agrees).
`quotameter status --bogus --help` is still a usage error: flags are
validated before help is shown.

### Plugging in real commands (tasks 129–145)

Replace one `stub(...)` row in `buildCommandTable` with a real handler
(`run: async (ctx) => …` returning the exit code) and declare its options
(`options: { timezone: { type: 'string', description: 'IANA time zone' }, … }`)
— the dispatcher, parser, and help renderers pick them up unchanged. The
option `description` renders in the command's help; undocumented options
print without trailing padding. The automatic `help` option name is
reserved: `parseCommandArgs` rejects a table that shadows it (a wiring
mistake fails loudly instead of silently breaking `-h`), so don't reuse
that name or its short. Subcommand nesting is exactly one level
(`service`), which is all §5.2 defines. Handlers receive parsed
`flags`/`positionals`; thrown errors are reported as command failures
(exit 1), so prefer returning precise codes.

## The `init` question layer (task 130, spec §5.3, decision D-099)

`quotameter init` asks the §5.3 questions in order — IANA time zone, bind
host, port, polling interval, optional account label, optional API key —
through three modules:

- **`prompts.ts`** — the `Prompter` seam (`ask`/`askSecret`, both resolving
  `string | null`). The production `createReadlinePrompter` never uses
  `readline`'s `question()`: piped input delivering several answers in one
  chunk would drop every line that fires while no question callback is
  pending, and a close without a final line would leave the promise pending
  forever. Instead it owns a line queue fed by the interface's `line`
  events, settles pending questions with `null` on `close`, and routes all
  echo through a mutable gate — `askSecret` mutes the gate so a typed key
  never reaches the terminal (terminal/raw mode is enabled exactly when
  stdin is a TTY, the only mode where muting can hide input), and
  type-ahead never echoes either: a `data` listener attached before the
  interface mutes any chunk carrying more than one answer (a paste) before
  readline can echo it, and a line arriving with no question pending latches
  a silent mode for the rest of the flow. Tests inject a scripted prompter;
  the real one is pinned over PassThrough streams and in child processes
  (piped, and under a real PTY via `script` for both typing and a
  whole-block paste).
- **`init-questions.ts`** — `askInitQuestions(deps)` runs the flow; every
  invalid answer is a stderr complaint and the same question again; any
  closed input cancels the whole flow with `null`. The per-value parsers
  (`parseTimeZone`, `parseHost`, `parsePort`, `parseIntervalSeconds`,
  `parseAccountLabel`, `parseApiKey`) are exported for `init --yes` (task
  131), and `buildInitConfig` is the single answers→`Config` assembly
  (server + app; the `accounts` array is task 133's). Empty-answer
  semantics: the default shown in the prompt for host/port/interval, skip
  for label/key, and a loud error for the time zone — the system zone is a
  hint inside the prompt, never an adoptable default (§5.3 step 2).
- **`init.ts`** — `runInitCommand(deps)` wires the flow into the command
  table, turns closed input into the standard handler failure
  (`quotameter init: input closed … — initialization cancelled`, exit 1),
  and prints `renderInitSummary`: every collected value except the key,
  which appears only as `configured (hidden)` / `skipped` (§6.3, §15.4), a
  password note for non-loopback hosts (§5.3 step 4), and — since task 132 —
  the write trailer naming the file the run wrote (or kept unchanged).

The remaining §5.3 steps (the account connection test, service
installation) extend `InitAnswers`/`buildInitConfig` rather than
re-deriving validation.

## The idempotent `init` layer (task 132, spec §5.3, decision D-101)

`init` must be idempotent: "on subsequent runs, display current settings and
let the user keep or change them". `init-persist.ts` plus the retain mode of
the two collection layers implement that with three detection outcomes at
the resolved configuration path (`resolvePaths` → `config.json`):

- **No file** — the fresh flows of tasks 130/131 unchanged, and the run
  writes the configuration: `enforceConfigPermissions` creates the
  directory at `0700` (or corrects/refuses), `writeConfigFile` writes the
  canonical file at `0600` atomically (§5.3 step 5's configuration half;
  the database lands with the storage-consuming steps, task 133+). The
  collected initial account is **not** persisted — the stable id and the
  §6.3 secret-source assembly are task 133's — and the summary says so.
- **Valid file** — the §5.3 subsequent-run flow: current settings are
  displayed (accounts masked to their secret state — a stored key never
  appears, an environment-sourced key names only its variable), every
  settings question offers its current value (`Enter to keep …`, the
  shared `retainOnEmpty` parser), and in `--yes` mode an absent optional
  option keeps the current value (an explicit flag is the consent to
  change that setting; `--timezone` stays mandatory, and the account flags
  are a clear failure — the initial account is a first-run step). Existing
  accounts and every setting init does not ask about are preserved
  verbatim through `validateSettings`' §5.3 merge. **Nothing is written
  unless a setting actually changes** — the done-condition: an unchanged
  re-run prints `No changes` and leaves the file byte-identical.
- **Stale-detection guard (both writing outcomes)** — immediately before
  any write the file is re-read and compared against what the run
  displayed (`sameDetectionState`: structural equality of the canonical
  configuration, so a reformatted-but-unchanged file is not a change): a
  fresh run requires the file to still be absent (a file created after
  the initial `none` result is never replaced — the no-clobber half), a
  re-run requires the same configuration that was shown, and anything
  else refuses with exit 1 and nothing written. The short
  re-read-to-rename window that remains is accepted (D-101): a lock would
  serialize only cooperating init processes, not the hand edits and
  foreign writers the guard exists for.
- **Present but invalid** — a hard refusal (exit 1): the loader's own
  secret-free problems are printed, the file is left untouched, and the
  user is told to fix or remove it — overwriting a configuration whose
  contents cannot be validated is never consented to (§6.2).

One state is deliberately tolerated on both sides of the pipeline
(D-101): a non-loopback bind (or `auth.mode: required`) without a password
hash — §15.1's own sentence binds _starting_ ("refuse to start"), §15.2
names `quotameter passwd` as the completer, and the task-130 note already
promised "set one with quotameter passwd". The tolerance is probed
structurally with a placeholder hash/password (D-022's technique, never by
matching problem wording), and it applies only to a password hash that is
**absent** — a present-but-malformed hash (empty, non-string) or a
non-object `auth` section is a defect the probe never masks, and any
further defect still refuses. Such a
configuration is written and re-read as `passwordPending`, displayed with
its remedy, and the service refuses to start on it until `passwd` completes
it — exactly the §15.1 sentence. Password collection inside `init` lands
with the scrypt tasks (§15.2, task 153).

The handler's detection and persistence are injectable seams
(`InitDeps.readExisting`/`persistConfig`) for unit tests; the real wiring —
including the double-init done-condition evidence through the actual
launcher — is pinned by `test/integration/cli-init-idempotent.spec.ts`.

## The `init --yes` layer (task 131, spec §5.3, decision D-100)

`quotameter init --yes` is the non-interactive half of §5.3: every value
comes from explicit options — `--timezone` (mandatory), `--host`,
`--port`, `--polling-interval`, `--account-label`, and the key channel
below — and stdin is never opened; the handler branches before a prompter
is constructed, so a prompt fallback is impossible by construction and the
command works with input closed. Rules:

- **Validation is the interactive flow's, reused.** `init-yes.ts` feeds
  every value through the task-130 exported parsers; an absent optional
  flag is the parser's empty input, so "omitted" inherits the same
  default as "pressed Enter" (`127.0.0.1`/`8787`/`300`, and no account).
  A missing or empty `--timezone` is one dedicated failure naming the flag
  (`--timezone is required with --yes: Quotameter never applies the system
time zone automatically…`, exit 1) — a set `QUOTAMETER_APP_TIMEZONE`
  does not satisfy it; service-load overrides play no role at collection
  time. An invalid value fails exactly like the typed answer.
- **All value problems are reported at once**, one `quotameter init: …`
  stderr line each, then exit 1 — a script gets the complete diagnosis in
  one run. Usage errors (unknown option, stray positional) stay exit 2
  via the strict parser; mode-conditional requirements are handler
  failures.
- **The API key enters only through the environment, by name.** There is
  deliberately no `--api-key <value>` option — a value flag would put the
  secret in the process listing and shell history (§15.4). Instead
  `--api-key-env <variable>` names the variable (§6.3's `apiKeyEnv`
  mechanism): init checks the name's shape (the account schema's exported
  pattern), rejects the reserved `QUOTAMETER_` prefix (the service's
  environment scan would reject such a variable once set), and requires the
  variable to be set as an own property with a non-empty value (empty
  counts as unset, D-011; inherited prototype names such as `toString`
  resolve on `process.env` and do not count — `Object.hasOwn`). Only the
  **name** is recorded (`InitAnswers.accountApiKeyEnv`); the value is
  consulted exactly once, for the non-empty check, and is never retained
  or printed — and no `--api-key-env` problem ever contains the supplied
  argument: a mistyped key (the value pasted where the name belongs — an
  underscore-only key is a syntactically valid variable name) must never
  reach stderr (§15.4). Task 133 consumes the name for the connection test
  and the secret-source decision.
- **A key source needs an account:** `--api-key-env` without
  `--account-label` is a problem (the label is what creates the account,
  exactly as in the interactive flow). `--account-label` alone means
  "account with the key added later in the UI".
- **Reproducibility:** `buildYesAnswers` is pure over flags + an
  environment snapshot + the optional existing configuration, and the
  summary rendered from its answers contains no timestamps, hints, or
  randomness — the same invocation prints byte-identical output when it
  starts from the same configuration state, which fresh directories
  (no file yet) guarantee; retain-mode output legitimately depends on the
  configuration the run started from (D-100's consequences say exactly
  this about task 132), so the reproducibility pin runs the launcher
  twice in fresh directories with the path normalized.
- **Value options require `--yes`:** any of the six without it is a clear
  failure (`--<name> requires --yes (non-interactive mode)`), never a
  silently ignored flag and never a half-prefilled wizard.

## The `doctor --raw` diagnostic read path (task 103, spec §7.4/§5.5, decision D-067)

`raw-diagnostics.ts` is the **only** sanctioned raw-payload consumer
outside `src/storage/`: `readRawDiagnostics(repository, accountId)` reads
the account's retained §7.4 payloads (newest first, bounded by the
20-per-account cap the storage write path enforces), and
`renderRawDiagnostics(records)` renders them as text — a header per record
(run id, captured instant as ISO 8601 UTC, HTTP status/content type with
explicit `no HTTP status`/`unknown content type` words when absent) and the
sanitized body verbatim below it (D-041: pretty-printing is a display
concern). The `doctor` row in `commands.ts` declares the spec-fixed
`--raw <account>` option; task 145's handler composes the two functions
behind it. §7.4's "(never over HTTP or in the web UI)" is enforced
mechanically by `test/unit/raw-response-gate.spec.ts`: any `src/**` or
`ui/**` file outside `src/storage/**` and `src/cli/**` that references the
raw-payload surface (facade identifiers, or this module's own API and
import path) fails `make check`.

### Launcher notes (`bin/quotameter.mjs`)

The launcher gates the runtime first — deriving the declared minimum from
the manifest's `engines.node` field, the single source of truth (an
unexpected declaration is a fatal packaging error, and a runtime whose
`process.versions.node` cannot be parsed fails closed with its own
message) — then answers a leading `--version`/`-v` itself (a fixed CI
contract: exactly the package version on stdout), then delegates via a
dynamic import with `mod.runCli ?? mod.default?.runCli` (jiti mounts the
TypeScript module as CommonJS during development and tests; the published
build is real ESM). The gate precedes the fast path and every command
module load, so a below-minimum runtime is rejected before any unsupported
feature (for example `node:sqlite`) can load; the ordering, the boundary
matrix (exactly 22.13.0 vs 22.12.x vs prerelease suffixes vs malformed
values), and the engines-derived minimum are pinned by
`test/integration/cli-bin-version-gate.spec.ts` against the real launcher
in a child process (task 129, decision D-098). An installation without the
compiled command modules (`ERR_MODULE_NOT_FOUND`) fails with a clear
message until the packaging tasks (184–186) ship them; any other module
failure surfaces as itself. All exits set `process.exitCode` and let the
event loop drain rather than calling `process.exit()`, so buffered pipe
output cannot be truncated.
