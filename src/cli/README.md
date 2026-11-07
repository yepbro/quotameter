# `src/cli/` — command implementations

The `quotameter` command surface (spec §5.2, Stage 11): `init`, `run`,
`start`/`stop`/`restart`, `reload`, `status`, `logs`, `service`
(`install`/`uninstall`), `passwd`, and `doctor`. `bin/quotameter.mjs` stays
a thin, build-free launcher that dispatches here (compiled at publish time
— no install-time build, spec §3).

**Rule:** a top-level consumer — it may import any layer except concrete
provider adapters. Nothing under `src/` imports this module; only `bin/` does.

## Dispatch skeleton (task 128, decision D-044)

| File                   | Owns                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.ts`              | `runCli(argv, deps)` — global flags, dispatch, exit codes; never calls `process.exit`                                                            |
| `commands.ts`          | the §5.2 command table (`buildCommandTable`), handler/context types — every command real (the stub helpers retired with U-050's `run`)           |
| `parser.ts`            | `node:util` `parseArgs` in strict mode; options per command; `UsageError`                                                                        |
| `help.ts`              | pure help renderers (general, command, group)                                                                                                    |
| `output.ts`            | the `CliOutput` writer seam (`systemOutput` → `process.stdout`/`stderr`)                                                                         |
| `prompts.ts`           | the interactive prompt seam: readline prompter with a line queue, EOF-safe questions, muted secrets                                              |
| `init-questions.ts`    | the §5.3 question flow: per-value validation, empty-answer semantics, answers→config assembly                                                    |
| `init-yes.ts`          | the §5.3 non-interactive layer: `--yes` flags → answers through the same parsers, env key and password channels                                  |
| `init-account.ts`      | the §5.3 step-6 account leg: id/secret-source assembly, the connection test, the failure offer                                                   |
| `init-password.ts`     | the §5.3 step-4 password leg: the loopback-optional/non-loopback-required question pair over passwd's shared flow (U-042)                        |
| `init-database.ts`     | the §5.3 step-5 database leg: data directory `0700` + migrations through the storage open/migrate pair, fresh runs only (U-059)                  |
| `init-persist.ts`      | the §5.3 idempotent layer: existing-config detection, masked display, merge, consented atomic write                                              |
| `init.ts`              | the `init` handler: mode branch, detection outcomes, the account step, cancellation, masked summaries                                            |
| `raw-diagnostics.ts`   | the §7.4 diagnostic read path behind `doctor --raw <account>` (task 103)                                                                         |
| `systemd-unit.ts`      | the §5.4 system unit generator, unit-file parser, and structural validator (task 134)                                                            |
| `systemd-user-unit.ts` | the §5.3/§5.4 user unit generator and structural validator (task 135)                                                                            |
| `service-owner.ts`     | the §5.3 ownership/privilege decision layer: invocation context, service-owner resolution, privileged-operation routing (task 136)               |
| `service-setup.ts`     | the §5.3 step-7 branch layer: capability probes, the route matrix, the no-sudo user-unit install, the manual-steps fallbacks (task 137)          |
| `service-linger.ts`    | the §5.3 linger detection + guidance layer: flag-file tri-state probe, the enable-linger command with the logout/reboot consequence (task 138)   |
| `service-install.ts`   | the §5.2 `service install`/`uninstall` handlers: idempotent unit lifecycle on both unit kinds, through the 136/137 seams (task 139)              |
| `passwd.ts`            | the §5.2 `passwd` handler: the §15.2 password pair, scrypt-hash-only persistence, session revocation (task 144)                                  |
| `doctor.ts`            | the §5.5 `doctor` handler: the check-result contract, the eleven §5.5 checks through the landed seams, `--raw` over the 103 read path (task 145) |
| `run.ts`               | the §5.2 `run` handler: foreground service start through a lazy `runServer` import, exit-code forwarding (U-050)                                 |

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
hint when the error is a usage error. Two documented exceptions: the `logs`
passthrough runner forwards a child journalctl's stdout
as **raw bytes** — a live stream cannot be expressed in the seam's
one-newline lines — with its own EPIPE and backpressure handling for the
run's duration (task 143, D-116); and the `run` handler writes nothing at
all, delegating stream ownership to `runServer` (stdout is §16's JSON log
stream, refusals are `runServer`'s direct stderr diagnostics — U-050).

### Exit codes

- `0` success — including help, version, and the no-arguments help;
- `1` command failure — a handler error;
- `2` usage error — unknown command/subcommand/option, missing subcommand,
  unexpected argument.

Global flags are checked in the order version → help, so `quotameter
--version --help` prints the version (the launcher's fast path agrees).
`quotameter status --bogus --help` is still a usage error: flags are
validated before help is shown.

### Plugging in real commands (tasks 129–145 + U-050)

Every §5.2 command is real — the tasks 129–145 wave plus U-050's `run` (the
last stub) completed the surface, and the stub helpers are gone. The table
still accepts a new command the same way: one row with its options and a
handler returning the exit code (`run: async (ctx) => …`). The
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
  state-only `Password` row (`set (only a scrypt hash is stored)` /
  `none`, U-042), the §5.3 step-4 requirement note when no password was
  set on a non-loopback bind, and — since task 132 — the write trailer
  naming the file the run wrote (or kept unchanged).

The remaining §5.3 steps (service installation) extend `InitAnswers`/
`buildInitConfig` rather than re-deriving validation.

## The initial account setup (task 133, spec §5.3 step 6, decision D-102)

`init-account.ts` makes the optional initial account real on fresh runs —
re-runs never collect one (their questions are not asked, their flags are
rejected, D-101):

- **Assembly** — the answers become the persisted `AccountConfig`: a
  deterministic id slug of the label (`work`, `My Work` → `my-work`;
  charset-safe — leading/trailing separators including underscores are
  trimmed, since the id's first character must be alphanumeric — capped at
  the schema/SQL id length, `account` when nothing usable survives), the
  provider's own id, `enabled: true`, and exactly one
  §6.3 secret source — the typed key (`apiKey`) or `--api-key-env`'s
  variable (`apiKeyEnv`; the collection modes are each capable of only one,
  D-099/D-100, and a blank variable value counts as unset, never a
  credential). A label without any key assembles nothing (§6.3's
  exactly-one rule) — the summary states the account is added later in the
  web UI, which is §5.3 step 3's skip path.
- **The connection test** — `validateCredentials` through the §8.1
  contract, with the secret sealed in a non-enumerable `AccountContext`
  (only an explicit `.secret` read reaches it). The provider comes from
  `InitDeps.provider`, whose production default is the composition root's
  `createInitialAccountProvider()` factory (`src/server/providers.ts` —
  `src/server/` is the one layer the package layout allows to import
  concrete adapters, and `cli` may import `server`, so the CLI layer stays
  provider-neutral). Its D-052 default 15 s deadline is deliberate here
  (U-054, D-179): D-102 orders the step-6 test before the configuration
  write (step 5's configuration half, deferred to the run's end) — a
  fresh run has no file yet, and a re-run keeps the same answer-driven
  factory — so the running service's
  registry default (`createConfiguredZaiProvider`) is the one that honors
  the configured deadline.
- **The failure contract** — a failed test **never aborts the run**: the
  failure is explained on stderr (the provider-neutral detail plus one
  class-specific guidance line — `credentials-rejected` means the provider
  refused the key, `provider-unavailable` means the check was
  inconclusive; an error without a recognized `kind` classifies
  unavailable — hostile shapes included, the `kind` read and the detail
  stringification are independently guarded — and the known secret is
  scrubbed from every detail line as defense in depth). Interactively,
  §5.3's "offer to continue with the account in an error state" is then
  asked (Enter/`y` keeps, `n` drops the account from this run's write,
  closed input cancels like a closed question); `init --yes` has no
  prompter and always keeps the account. A Ctrl-C during the
  connection-test wait cancels through the prompter's `interrupted()` latch
  (`SIGINT`-only, never piped EOF); the step runs **before** the consented
  write, so a dropped account is simply absent from it and the
  stale-detection guard still re-reads the file immediately before the
  write.
- **Secret discipline (§15.4)** — the key value appears in no stdout/stderr
  line at any stage (prompt handling, validation, failure explanation,
  offer, success summary, decline path) — pinned by marker tests in the
  unit, in-process, real-launcher, and PTY suites — and lives exactly where
  §6.3/D-004 put it: inside the `0600` configuration file.

## The idempotent `init` layer (task 132, spec §5.3, decision D-101)

`init` must be idempotent: "on subsequent runs, display current settings and
let the user keep or change them". `init-persist.ts` plus the retain mode of
the two collection layers implement that with three detection outcomes at
the resolved configuration path (`resolvePaths` → `config.json`):

- **No file** — the fresh flows of tasks 130/131 unchanged, and the run
  writes the configuration: `enforceConfigPermissions` creates the
  directory at `0700` (or corrects/refuses), `writeConfigFile` writes the
  canonical file at `0600` atomically (§5.3 step 5's configuration half).
  Since task 133 a fresh run with a key source also stores the initial account
  (see the account-setup section above) — tested, offered on failure, and
  persisted with its secret inside the `0600` file. Since U-059 (D-187)
  the fresh run then creates the **database** (`init-database.ts`, below)
  right after the write — the §5.3 step-5 database half the task-132
  deferral waited on.
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
it — exactly the §15.1 sentence.

Since U-042 (decision D-141) `init` collects the password itself on fresh
runs — §15.2's promise that the password is set "via `init`" is now the
whole truth, not a `passwd` detour:

- **Interactive (`init-password.ts`)** — after the §5.3 step-3 questions
  and before the account's connection test, one muted question pair over
  `passwd`'s own `askNewPassword` (D-118): loopback binds ask optionally
  (`Web password (…; Enter for none — set one later with quotameter
passwd): `, the exactly-empty answer skips), non-loopback binds ask
  required-shaped (`Web password (… — required before the service starts
on a non-loopback bind): `, the empty answer is the §15.2 length
  complaint; three rejected pairs abort the run). The confirmation is
  passwd's own `Confirm password:`; a mismatch restarts the pair.
  Completing the run without a password keeps the §15.1 default —
  `auth: { mode: 'auto' }`, no hash.
- **Non-interactive (`--password-env <variable>`, `init-yes.ts`)** — the
  same by-name environment discipline as `--api-key-env` (never a
  `--password <value>` flag: §15.4's process-listing rule). Name checks
  identical; the §15.2 minimum is checked on the raw untrimmed value; no
  problem ever contains the argument or the value. Absent flag → no
  password (a non-loopback bind then lands in the pending state above —
  the D-101 journey stays). Against an existing configuration the flag is
  a clear failure pointing at `quotameter passwd`.
- **Storage** — the handler hashes the collected password through
  `hashPassword` (D-118's encoding, D-122's verification) and submits only
  the opaque hash through `validateSettings` — passwd's exact convention;
  the plaintext exists only between the prompt (or the env read) and the
  hashing call, never inside `InitAnswers`, any output line, or the file.
  When the data directory still holds a database (a configuration deleted
  or re-pointed while the database survived), storing the password revokes
  its sessions first, in `passwd`'s fail-secure order (review round P1:
  "fresh" is fresh about the configuration file only) — revoke before the
  write, abort on failure, report what was revoked.
- **Re-runs collect no password** — D-101's four settings questions stay
  exactly four; changing a password requires D-118's fail-secure
  session-revocation ordering, which is `passwd`'s contract, and a pending
  re-run keeps its passwd remedy.

The handler's detection and persistence are injectable seams
(`InitDeps.readExisting`/`persistConfig`) for unit tests; the real wiring —
including the double-init done-condition evidence through the actual
launcher — is pinned by `test/integration/cli-init-idempotent.spec.ts`.

## The fresh-run finalization: database, verification, summary (task U-059, spec §5.3 steps 5/7/8, decision D-187)

With the collection layers landed, a fresh run's ending is an explicit
lifecycle — `write-config → database → service-setup → health-check →
summary`, in that order, with exactly one abort rule beyond the write
itself:

- **The database step (`init-database.ts`) aborts the run on failure.**
  After the consented configuration write, the run reads the data
  directory's §5.6 single-instance lock and **refuses under a live
  holder** (naming the pid — init must never run backup or DDL under a
  running service; an unreadable or invalid lock refuses fail-closed, a
  dead holder's stale lock proceeds, §5.6's next start clears it), then
  creates the data directory (`0700` — an explicit `chmod` after the
  recursive mkdir, because `mkdir`'s mode is masked by the invoking
  shell's umask, the configuration path's own umask-exempt step) and
  brings the database to the current schema through the storage
  composition's own open/migrate pair (`openStorageConnection` +
  `runStartupMigrations` over `MIGRATIONS`), consumed through dynamic
  imports so `node:sqlite` stays out of every dispatch graph (D-116; the
  child's only new stderr noise is the module's ExperimentalWarning — the
  documented property of invocations that actually open a database). The
  sequence is idempotent: a surviving database (the D-141 world)
  classifies up-to-date or behind and migrates exactly as the service
  would at start. Failure policy: §5.3 step 5 is a must, not best-effort
  — every reachable failure (unwritable data directory, corrupt file at
  the path, WAL-incapable filesystem, §11.4's newer schema) leaves an
  environment no service can start in, so the run exits 1 with the
  configuration file explicitly kept (re-running init does not retry the
  step — it is fresh-run-only; the service's own start creates the
  database, and the remedy line says so). The §5.3 step-6
  connection-test tolerance is the deliberate contrast: a bad key harms
  one account, a bad data directory harms the whole service — installing
  an auto-restarting unit over it would be the harmful alternative.
- **The service step reports whether it started a service.**
  `runServiceSetupStep` returns `{ serviceStarted }` — `true` only on the
  user-unit route's successful `enable --now`, the one leg where init's
  own run put a service on the machine. That return value is the
  precondition of the step's verification half: a service that was
  installed and started gets the bounded loopback `GET /api/health` probe
  (`verifyServiceHealth`, `service-setup.ts`): 30 s total deadline, 2 s
  per request, 500 ms between attempts — a freshly enabled unit still
  boots Node and opens its database, so a first refusal is startup
  latency, not a verdict; healthy means HTTP 200 with §13's
  `{"status":"ok"}` body, everything else retries inside the bound (a
  timeout firing mid-body is a failed attempt with the timeout's own
  diagnostic, never a "wrong payload" verdict; the retry sleep is
  deliberately ref'd — mid-poll it is often the only pending work of the
  CLI process). The probe host is loopback by construction (the
  configured host when it is itself loopback, otherwise `127.0.0.1` — a
  wildcard bind accepts loopback connections; a service bound to one
  specific non-loopback address may refuse the probe while healthy on its
  own interface, the recorded residual). A password-pending
  configuration is **not** probed — §15.1 refuses that start by design,
  the pending remedy line already said so, and waiting out the budget for
  a start that cannot happen helps nobody (recorded residual: the
  user-unit leg still enables the pending unit, which `Restart=on-failure`
  cycles until `quotameter passwd` completes it — tightening that is
  task 137's design, not this step's). A failed probe is honest stderr
  plus the `status`/`logs` guidance and **never fails the run**: the
  configuration is written and the unit installed; the manual fallbacks
  remain §5.3's designed outcome.
- **The step-8 block closes the run** (`renderInitNextSteps`): the
  effective URL (`http://<host>:<port>` — §15.1's service never terminates
  TLS itself; IPv6 literals bracketed; a **wildcard** bind has no
  client-usable URL and renders the machine-address placeholder with the
  every-interface fact), the SSH-tunnel access **exactly for a loopback
  bind** — only a loopback URL is unreachable from another machine, and
  the tunnel is §15.5's recommended remote-access method for exactly that
  world (a non-loopback bind is directly reachable; its password note
  already rendered), the `status`/`logs` command names, and the
  configuration and data paths. Fresh runs only; re-runs keep their
  update trailers.

The seams: `InitDeps.createDatabase` (production `createInitDatabase`) and
`InitDeps.checkServiceHealth` (production `verifyServiceHealth`); both are
recorded or forbidden in the unit suites, real in the integration suites —
a real launcher run leaves a genuinely migrated `quotameter.sqlite` inside
the redirected data directory (pinned by reading the migration journal
back), and a squatter file on the data-directory path aborts the run
honestly with the configuration kept.

## The `init --yes` layer (task 131, spec §5.3, decision D-100)

`quotameter init --yes` is the non-interactive half of §5.3: every value
comes from explicit options — `--timezone` (mandatory), `--host`,
`--port`, `--polling-interval`, `--account-label`, the key channel below,
and `--password-env` (U-042's §15.2 password channel, same env-by-name
discipline) — and stdin is never opened; the handler branches before a
prompter is constructed, so a prompt fallback is impossible by
construction and the command works with input closed. Rules:

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
  "account with the key added later in the UI". `--password-env` needs no
  account — the web password is independent of the initial account.
- **Reproducibility:** `buildYesAnswers` is pure over flags + an
  environment snapshot + the optional existing configuration, and the
  summary rendered from its answers contains no timestamps, hints, or
  randomness — the same invocation prints byte-identical output when it
  starts from the same configuration state, which fresh directories
  (no file yet) guarantee; retain-mode output legitimately depends on the
  configuration the run started from (D-100's consequences say exactly
  this about task 132), so the reproducibility pin runs the launcher
  twice in fresh directories with the path normalized.
- **Value options require `--yes`:** any of the seven without it is a clear
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

## The systemd unit generator (task 134, spec §5.4, decision D-103)

`systemd-unit.ts` is the pure content half of service installation —
**generation, parsing, validation; no filesystem, no systemd calls**.
Installing/enabling the unit (`quotameter service install`, §5.2) is task
139 and consumes this module.

- **`buildSystemUnit(input)`** renders the system unit deterministically
  from validated inputs: absolute `nodePath`/`cliPath` (§5.4 — Node may live
  in nvm or NodeSource, so the unit pins `process.execPath`'s and the CLI
  entry's absolute values; the same inputs must produce byte-identical
  content, which is what `service install`'s regeneration and `doctor`'s
  staleness check build on), regular `User=` (never `root`, §5.1; optional
  `Group=`), `Restart=on-failure` with `RestartSec=<n>s` from input,
  `After=`/`Wants=network-online.target`, `Environment=NODE_ENV=production`,
  the §5.4 hardening set (`NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths` limited
  to the config/data directories of §6.1), journald output, and
  `Type=exec` + `WantedBy=multi-user.target` (D-103). Input validation
  throws before any content is built: relative paths, whitespace or control
  characters in interpolated values (a newline could inject directives),
  systemd metacharacters (`\`, `"`, `'`, `$`, `%` — this generator does not
  escape them, and unescaped they change unit semantics, so a path that
  would need quoting or escaping is a loud error), `root` as user or group,
  and non-safe-integer `restartSecSeconds` are all refused with
  field-naming messages. `SystemUnitInput` has no secret-carrying field at
  all — §5.4's "never put secrets in unit files" holds by construction, and
  the validator enforces the read-back half.
- **`parseUnitFile(content)`** reads unit content back into sections and
  directives the way systemd's documented grammar
  ([systemd.syntax(7)](https://www.freedesktop.org/software/systemd/man/latest/systemd.syntax.html))
  parses it: full-line `#`/`;` comments, blank lines, CRLF/CR, BOM, all
  whitespace after `=` ignored, section names kept verbatim between the
  brackets (systemd does not trim them — `[ Service ]` is a different,
  unknown section), backslash continuations where the backslash becomes a
  single space and comment blocks between continued lines are skipped (an
  even, escaped number of trailing backslashes does not continue). It
  reports malformed lines as problem strings — no throws: it reads files
  the application does not control (hand-edited installed units). `doctor`
  (task 145) reuses it for the §5.4 stale Node/CLI path check on
  `ExecStart`.
- **`validateSystemUnit(content, expected?)`** is the structural validator:
  the systemd-less environments the gates run in (the development container
  and the CI test jobs' pinned 24.04 image, D-160) ship no
  `systemd-analyze`, so a generated unit's done-condition is
  the exact-content snapshot plus this invariant checker. It verifies every
  §5.4 contract directive (exact values, truthy-boolean spellings, systemd
  time units, absolute `ExecStart` tokens `<node> <cli> run`, `User=`/
  `Group=` neither `root` nor a numeric id — id 0 is root by another
  spelling — absolute `ReadWritePaths` entries that never include `/`, and
  with `expected` supplied exactly the generated config/data pair in
  order), flags duplicate keys (systemd's silent last-wins hides
  corruption), rejects unexpected sections (empty ones included, via the
  parsed headers) and directives (strict shape of the generated unit), and
  rejects **any** `Environment=` line other than `NODE_ENV=production` —
  the mechanical no-secrets rule, whose problem message deliberately does
  not reproduce the divergent value so a smuggled secret can never be
  echoed into diagnostics (§15.4).

Task 135's user unit — `systemd-user-unit.ts`, the next section — reuses
the shared pieces: `renderUnitFile`, `assertUnitPathInput`,
`assertUnitRestartSecSeconds`, `checkUnitShape` with the exported check
builders, and the pinned `Description`/`Documentation` constants.

## The systemd user unit generator (task 135, spec §5.3 step 7 / §5.4, decision D-104)

`systemd-user-unit.ts` is the user-unit twin of task 134's module — pure
generation and structural validation, **no filesystem, no systemd calls**.
Installing under `~/.config/systemd/user/`, `systemctl --user enable`, and
linger guidance are tasks 137–139.

- **`buildUserUnit(input)`** renders the user unit deterministically from
  `UserUnitInput { nodePath, cliPath, restartSecSeconds }` — there is
  deliberately no user, group, config-directory, or data-directory field,
  and no secret-carrying field at all (§5.4's no-secrets rule holds by
  construction). §5.4's unit-generic directives are kept verbatim (D-104:
  the spec's first sentence prescribes them for units, and only the
  hardening sentence splits by manager kind): absolute `ExecStart=<node>
<cli> run`, `Restart=on-failure` with `RestartSec=<n>s`,
  `After=`/`Wants=network-online.target`,
  `Environment=NODE_ENV=production`, journald output, `Type=exec`, the
  pinned `Description`/`Documentation`, and no `WorkingDirectory` (D-103
  carried over). The manager-compatible adaptations, verified against
  systemd.exec(7): **no `User=`/`Group=`** ("only available for system
  services and not supported for services running in per-user instances";
  the user manager already runs the service as the owning regular account,
  §5.1 by construction); **the minimal hardening set is
  `NoNewPrivileges=true` only** (the namespacing directives the system unit
  carries — `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`,
  `ReadWritePaths` — are unavailable to the unprivileged user manager
  without `PrivateUsers=true`/unprivileged user namespaces; write
  protection in user mode is the application's own §6.3 permission
  discipline); and **`WantedBy=default.target`** (the user manager ships
  `default.target` and no `multi-user.target`; `network-online.target`
  stays because ordering against a missing unit is trivially satisfied and
  the want has no effect — benign, and §5.4 prescribes the directives
  without a user-unit exception).
- **`USER_UNIT_NAME`** is the same file name as the system unit's — the
  system and user managers keep separate unit namespaces.
  **`userUnitInstallPath(homeDir)`** composes §5.3 step 7's literal
  `~/.config/systemd/user/quotameter.service` under an injection-guarded
  absolute home directory (the shared `assertUnitPathInput` guard; honoring
  a custom `XDG_CONFIG_HOME` is task 139's installer decision).
- **`validateUserUnit(content)`** is the user shape on the shared
  `checkUnitShape` engine extracted from `validateSystemUnit` (a
  behavior-preserving refactor — task 134's suite passes unchanged): the
  system-only directives are not in the allowed key set, so their presence
  (a system unit pasted into `~/.config/systemd/user/`) is an
  unexpected-directive problem; `WantedBy=` must be `default.target`; and
  any `Environment=` line other than `NODE_ENV=production` is rejected
  without echoing the divergent value. The two-way cross-check in
  `test/unit/cli-systemd-user-unit.spec.ts` — each validator rejects the
  other twin's generated unit — pins the contracts as genuinely distinct.

## The ownership/privilege decision layer (task 136, spec §5.3 steps 1/7, decision D-105)

`service-owner.ts` is the pure, injectable seam behind §5.3's ownership
rules — the decision half only: it classifies the invocation, resolves the
service owner, and states which operations may use privileges. It performs
no installations and no privileged operations; tasks 137 (fallback paths),
138 (linger guidance), and 139 (`service install`/`uninstall`) consume it.
`resolveServiceOwner({ getuid?, env?, passwd? })` returns either
`{ state: 'ok', context }` or `{ state: 'problems', problems }`
(problems-not-throws, every problem in one pass):

- **Regular user** (`uid !== 0`) — the owner is the first user-database
  entry with the current uid, **and the name must resolve back to that same
  entry**: a generated `User=` carries only the name, and systemd resolves
  names by first database match, so duplicate account names with different
  ids (an earlier same-name alias at uid 0, say) could select the wrong —
  possibly root — account; an ambiguous database is refused (review round
  P0). `kind: 'regular-user'`, `privileges: 'none'`
  → §5.3 step 7's consent-to-invoke-sudo route, task 137's branch.
  `SUDO_*` is **never consulted** at a non-root uid: any user can export
  those names, so they are untrusted leftovers (`sudo -u otheruser` lands
  here with the target account as the owner).
- **Root with `SUDO_USER`** — the owner is the account sudo recorded
  (`kind: 'sudo'`, `privileges: 'held'`: the privileged systemd operations
  may run in-process), and the sudo environment must verify against the
  user database: the variable is an own, non-empty property
  (`Object.hasOwn`, the init-yes.ts `process.env` precedent — inherited
  names never count), names an existing account that is not root
  (`SUDO_USER` of `root` is a sudo chain invoked by root — §5.1 refuses),
  and `SUDO_UID`/`SUDO_GID` are set, plain-decimal, and equal to the
  account's database uid/gid — sudo itself guarantees that consistency, so
  any deviation means the environment is not a genuine sudo invocation and
  all deviations accumulate as problems. A `sudo -s` root shell keeps
  exactly this consistent trio, so it resolves like a direct
  `sudo quotameter init`.
- **Root without a verifiable `SUDO_USER`** (unset, or any of the checks
  above failing) — problems with actionable guidance (sudo from a regular
  account, or a regular user's user-level service), never a guessed
  account: §5.3's only owner-determination mechanism for a root process is
  `SUDO_USER`. **There is no ok outcome whose owner is root** — pinned as
  a property over arbitrary databases/environments/uids in
  `test/unit/cli-service-owner.property.spec.ts`.

The user database is `/etc/passwd`, parsed per passwd(5) by the pure
`parsePasswdFile` (seven `:`-separated fields, non-empty name, plain-decimal
ids within the exactly-comparable safe-integer range — values beyond `2^53-1`
are skipped, since `Number` precision loss could make two different id
strings compare equal; malformed lines are skipped — root-owned file, not
ours to diagnose) with `readEtcPasswd` as the production seam; lookups take
the first match (getpwnam/getpwuid semantics). Node has no getpwnam binding
and §5.1's supported targets keep local users there; NSS/SSSD directory
users are outside v1.0's supported targets and surface as the
unknown-account refusal. An undeterminable uid (non-POSIX runtime) is the
`permissions.ts` precedent's problem arm. The sudo id verification
(`SUDO_UID`/`SUDO_GID`) uses the same decimal-id grammar, so no id enters
the layer through two rules.

Privilege routing is a frozen vocabulary: `PRIVILEGED_SYSTEMD_OPERATIONS`
(install/remove system unit, `daemon-reload`, enable/disable, start/stop,
`enable-linger` — §5.3 step 7's writes under `/etc/systemd/system/` and the
system manager, plus the linger command §5.3 names and task 139's
uninstall) with `isPrivilegedSystemdOperation` as the single classification
point; everything else a service setup touches — configuration/data
directories, the provider connection test, the user-unit install under the
owner's home, status/journalctl queries — runs as the service owner.

## The service-setup branch layer (task 137, spec §5.3 step 7, decision D-106)

`service-setup.ts` routes §5.3 step 7 for a resolved owner context (task
136's layer — `init` resolves it first and fails fast on its problems,
printing each verbatim with the `quotameter init:` prefix, exit 1, nothing
written and no prompter constructed) against the probed machine
capabilities, and owns the two fallback paths:

| privileges | systemd | user manager | route                                                |
| ---------- | ------- | ------------ | ---------------------------------------------------- |
| held       | yes     | (any)        | system-unit plan (rendered; execution is 139's)      |
| held       | no      | (any)        | manual — initialize and run from the owner's account |
| none       | yes     | yes          | **user-unit install without sudo** (executed here)   |
| none       | yes     | no           | manual — unit written + exact session commands       |
| none       | no      | (any)        | manual — `quotameter run`                            |

- **Probes** — `probeServiceCapabilities` (D-160) reads well-known facts and,
  when they claim systemd, verifies the claim with one read-only command per
  scope: `/run/systemd/system` (the marker systemd itself creates when it is
  the init system) gates everything — absent means `caps(false, false)` with
  no process spawned; present, `systemctl is-system-running` is asked, and an
  inert answer (systemd's own "not booted with systemd" diagnostic, a bus
  failure, a missing binary) classifies the machine absent too, never into
  raw systemctl errors. `userManager` additionally needs an own, non-empty
  `XDG_RUNTIME_DIR` whose `systemd` runtime directory exists (own-property
  read: an inherited `XDG_RUNTIME_DIR` is not a session) and a live
  `systemctl --user is-active default.target` — exit codes never classify
  (a degraded system or an inactive target is a manager answering); the
  probe is async and every consumer's `probeCapabilities` seam accepts a
  synchronous fixed answer.
- **The no-sudo install** — all unprivileged, through injectable seams:
  task 135's `buildUserUnit` (with `INIT_RESTART_SEC_SECONDS = 5`, D-106 —
  D-103 keeps no default in the generator and 139 owns the configurable
  flag), written by `writeUnitFileToDisk` to
  `userUnitInstallPath(owner.home)`, then `systemctl --user daemon-reload`
  and `systemctl --user enable --now quotameter.service` through
  `spawnServiceCommand` (stderr captured only up to a small streaming cap
  and reported as one bounded line). Unit preparation and installation are
  one failure domain: any throw or failed command — §5.3's "or
  installation fails" — falls back to exact manual steps (the two session
  commands when the file made it to disk, the foreground command with the
  real reason as the lead when it did not, the failure on stderr), never a
  crash out of the step.
- **Manual steps** — rendered commands each on their own indented line,
  copy-pasteable, led by the actual reason. A privileged run on a
  systemd-less machine is directed to **initialize and run from the
  owner's regular account** (`quotameter init`, then `quotameter run`):
  the sudo run's configuration file is root-owned `0600` wherever the
  privileged environment placed it, so no regular account — the only kind
  §5.1 allows to run the service — can use it (making a privileged run's
  writes owner-readable is task 139's privileged machinery). When only the
  user manager is unreachable, the unit file is still written (the write
  needs no manager) and the steps are the exact `systemctl --user`
  commands for the next login session plus the foreground alternative.
- **The owner-name guard** — the owner's account name reaches copy-paste
  command text (the linger and manual commands), so the step refuses a
  name outside the POSIX account grammar
  (`unsafeOwnerNameProblem`: letters, digits, underscore, hyphen, not
  digit/hyphen-leading) with one stderr problem and no rendered commands —
  a whitespace- or metacharacter-carrying `/etc/passwd` row cannot inject
  into the printed steps.
- **Linger, detected** — the user-unit outputs (the installed outcome
  and both manual completion-steps fallbacks) carry §5.3's linger
  guidance driven by the probed state (`service-linger.ts`, task 138,
  decision D-107): the probe stats the persistent linger flag file
  `/var/lib/systemd/linger/<owner>` — the on-disk state
  `loginctl enable-linger` writes and logind's `Linger` property reads —
  classifying the flag file present as enabled, `ENOENT` (missing file
  or missing flag directory: no user has a flag) as disabled, and any
  other stat error as unknown. Disabled keeps task 137's sentence
  verbatim — the exact `sudo loginctl enable-linger <owner>` command on
  its own line with the logout/reboot explanation; unknown prints the
  same command led by a could-not-determine sentence (**never silently
  treated as enabled**: advising the idempotent command is harmless,
  withholding it would stop the service at the owner's logout); enabled
  prints a plain confirmation with no command. The outputs where no user
  service can linger (systemd absent, the write-failure foreground
  fallback, the system-unit plan) carry no linger note, and the probe
  never runs there.
- **The system-unit route** — routed and planned, not executed: the
  privileged operations (install `/etc/systemd/system/quotameter.service`
  with `User=<owner>`, daemon-reload, enable --now, verify `is-active` and
  `/api/health`) belong to task 139's `quotameter service install`
  machinery; the plan names them and directs to that §5.2 command from the
  regular account.
- **The verification half (U-059, D-187)** — `verifyServiceHealth` is the
  bounded loopback `GET /api/health` poll both consumers run after a
  service was actually started (see the fresh-run finalization section):
  `runServiceSetupStep`'s `{ serviceStarted }` return is init's
  precondition for probing, `service install`'s system route probes after
  its `is-active` gate. Injectable at every seam (fetcher, sleep, clock,
  all three budgets); the healthy/wrong-status/wrong-body arms are pinned
  against a real loopback server the suite owns — the production fetcher
  is real `fetch` on 127.0.0.1 with `redirect: 'error'` (D-154's
  documented guard gap closed by policy at every fetch site).

The step runs on fresh runs after the configuration write (re-runs keep
their update trailers; re-installation is `service install`'s job) and asks
no questions. Branch coverage: every route is seam-driven in
`test/unit/cli-service-setup.spec.ts` (the container cannot produce the
systemd routes for real), while the systemd-less manual route — the one
real on the development container — is additionally pinned through the real
launcher (piped, `--yes`, and under a real PTY) in
`test/integration/cli-init-service.spec.ts`.

## The `service install` / `service uninstall` commands (task 139, spec §5.2/§5.4, decision D-108)

`service-install.ts` holds both §5.2 handlers — `runServiceInstallCommand(deps)` and
`runServiceUninstallCommand(deps)`, wired into the `service` group of the dispatch table
(install declares `--restart-sec <seconds>`). The commands are **independent of `init` by
construction**: nothing here reads, writes, or requires a configuration — the unit content
comes from the task 134/135 generators, the owner context from task 136's resolver, the
route from task 137's matrix, and the linger guidance from task 138.

- **Idempotency** — §5.4's "`quotameter service install` must regenerate the unit" is the
  whole design: install-when-absent and install-when-present run the _same_ sequence
  (deterministic generator rewrite → `daemon-reload` → `enable --now`, a no-op on an
  enabled service), so re-running install after an upgrade is the stale-Node/CLI-path
  remedy. A pre-existing unit file (probed before the write) only adds a regenerated note
  — a running service keeps the previous unit until restarted. Uninstall-when-absent is a
  `nothing to do` success with zero side effects.
- **Routing** — task 137's matrix decides the unit kind: privileges held on a systemd
  machine manage the **system** unit (the privileged operations of D-105's vocabulary run
  in-process: write/remove `/etc/systemd/system/quotameter.service`, `daemon-reload`,
  `enable --now`/`disable --now`, and the `is-active` verification §5.3 step 7 prescribes
  for the privileged route); a regular user manages the **user** unit entirely
  unprivileged (write under the owner's home, `systemctl --user`). Cross-unit mistakes
  draw a stderr warning on install and the exact removal hint on a no-op uninstall; the
  §5.6 single-instance lock is the backstop, not the mechanism.
- **System-unit paths** — `ReadWritePaths` resolves through the §6.1 `resolvePaths`
  precedence over the process environment with `HOME` forced to the owner's home (a
  privileged run must never pin root's paths into a unit that runs as the owner): sudo's
  default environment stripping yields the owner's XDG defaults, while an
  operator-declared override (`sudo -E`, `sudo QUOTAMETER_CONFIG_DIR=…`) is honored. The
  owner's home passes the shared injection guard; install does not create or chown the
  directories (D-106's deferred ownership machinery stays out of scope — a missing
  configuration surfaces in `is-active` with actionable guidance).
- **Unavailable routes** — install on a systemd-less machine refuses with the exact
  foreground alternative (exit 1: unlike init, whose configuration write already
  succeeded, install's whole job is the service); an unreachable user manager still
  writes the unit file and prints the exact session commands plus the detected linger
  guidance. Uninstall on manager-less machines removes the file without manager commands
  and says so.
- **Exit codes** — install exits 0 exactly when the unit was written, reloaded, and
  enabled/started (plus `is-active` and — since U-059, D-187 — the `/api/health`
  verification on the system route when a readable configuration names the endpoint);
  uninstall exits 0 exactly when
  the file is gone (or was absent) and every executed manager command succeeded — a
  failed `disable`/`daemon-reload` is reported but does not block the file removal, since
  the manager self-heals on its next reload while a half-removed unit would not; the
  partial outcome then names the exact cleanup command (`sudo systemctl daemon-reload`,
  or the `--user` spelling). Prescriptive system-route commands print with the `sudo`
  prefix — the normal invocation is the one-shot `sudo quotameter service install`,
  whose shell is the regular account. The owner-problem gate (D-105, including the
  broken-system throw of an unreadable user database, rendered as the standard failure
  line) and the POSIX owner-name guard (D-106) fail fast like init's; neither handler
  throws.
- **The §5.3 step-7 privileged verification (U-059, D-187)** — after `is-active`
  passes, the system route probes `GET /api/health` through the shared
  `verifyServiceHealth` seam. The endpoint comes from the **owner's**
  configuration, resolved through the same `ownerUnitDirectories` §6.1
  precedence the unit's `ReadWritePaths` use and read best-effort through
  init's detection pipeline (one validator, no drift): D-108's structural
  independence survives — no readable configuration skips the probe with one
  honest `Health check skipped: …` line instead of failing, because the
  command still requires no configuration and `is-active` already proved the
  start. A probe that runs and does not pass within its bound fails the
  install (exit 1, stderr detail, `status`/`logs` guidance) — §5.3's verify
  is this command's own contract. The user route keeps §5.3's user-unit
  bullet scope (enable, no prescribed verification; init's own user-unit leg
  does probe, contained — the asymmetry is spec-anchored and recorded in
  D-187).

Branch coverage: every route and failure path is seam-driven in
`test/unit/cli-service-install.spec.ts` (the systemd-less test environments:
the container and the CI test jobs' pinned 24.04 image, D-160);
the systemd-less routes the container does produce — the install refusal and the
no-op/manager-less uninstall — are additionally pinned through the real launcher in
`test/integration/cli-service-install.spec.ts`.

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

## The `reload` command (task 141, spec §5.2/§6.4, decision D-112)

`service-reload.ts` holds the §5.2 `quotameter reload` handler — the command that
triggers §6.4's change application without a restart and answers whether the
configuration was accepted or rejected. It is composed of landed layers only:
the D-105 owner resolution (shared `resolveOwnerForCommand`), the D-108
owner-scoped §6.1 directories (the now-exported `ownerUnitDirectories` — `HOME`
forced to the owner's passwd home, `QUOTAMETER_*` overrides honored), the §5.6
single-instance lock of the landed `src/server/single-instance.ts` (imported
read-only), and the task 068 pipeline the service itself re-runs on SIGHUP.

- **Running-service discovery** — the handler reads the lock file of the owner's
  data directory: it exists exactly while a service instance holds that
  directory, for every run mode (systemd unit or foreground `quotameter run`),
  and names the holder pid. The four read states are honest outcomes: absent →
  not-running guidance (`quotameter start` / `quotameter run`); a dead holder
  pid → the same guidance with the stale-lock explanation (§5.6's next start
  clears it); unreadable or invalid → a loud failure with the lock module's own
  remedy wording. Nothing is signalled in any of them.
- **Accepted/rejected (D-112)** — the command re-runs `loadConfigWithEnv` — the
  exact function the service reloader executes on SIGHUP — over the same §6.1
  configuration path in its own process. A file with problems is **rejected**:
  every pipeline problem prints (one prefixed stderr line each) and **no SIGHUP
  is sent**, because §6.2 pins the signal's effect as a guaranteed no-op (keep
  the last valid configuration). A valid file is signalled via
  `process.kill(pid, 'SIGHUP')`, with errno classified by a pure classifier
  (`ESRCH` → exited meanwhile; `EPERM` → the owner-account/sudo steps, the
  owner-account first because sudo's default `env_reset` drops the
  `QUOTAMETER_*` path override that located the lock).
- **§6.4 honesty** — the success report advises (live settings apply;
  `server.host`/`server.port`/`auth.mode` need `quotameter restart`) but never
  fabricates the service's `applied`/`pending-restart` classification — only
  the service's reloader can diff against its in-memory configuration, and the
  authoritative record is its log line (`quotameter logs`, task 143).
- **Exit codes** — 0 exactly when the configuration validated and SIGHUP was
  delivered; every other outcome exits 1. The handler never throws.

The receiving end is the server runtime since U-052 (D-177): `runServer`
installs the SIGHUP handler whenever a reload operation exists — the
production path always, once the application is running, via the
composition's fault-containing wrapper — so the delivered signal performs
§6.4's reload through the same wrapped operation the stores flow through
(config-sync and polling feeds included) instead of terminating the
process. Residual windows (D-177): during startup — after the §5.6 lock
exists but before the handler installs, exactly the pid `quotameter
reload` discovers — and in the post-dispose shutdown tail, a delivered
SIGHUP still terminates (the OS default; systemd's `Restart=on-failure`
recovers).

Branch coverage: every outcome is seam-driven in
`test/unit/cli-service-reload.spec.ts` (beside the payload-parse table and the
production seams against real directories and real child processes); the three
real-launcher routes — not-running, rejected with no signal delivered to a live
signal-holding child, and accepted with the child's SIGHUP marker appearing
after exit 0 — are pinned in `test/integration/cli-service-reload.spec.ts`;
the server side (a real SIGHUP to a real `quotameter run` child: alive, the
effective configuration changed, §6.2 keep-last-valid on rejection) is pinned
in `test/integration/cli-run.spec.ts`.

## The `status` command (task 142, spec §5.2/§7.3, decision D-114)

`service-status.ts` holds the §5.2 `quotameter status` handler — the status
report: service status, latest collection, and last error for each account,
useful for a system unit, a user unit, and a foreground run alike. It is
composed of landed layers only, each fact from the layer that owns it:

- **Installed scope** — D-110's disk discovery (the 139 exists-seam over the
  two install paths), never a re-derived install route. Both unit kinds on
  disk is reported as the mistake task 139 warns about, in the report's own
  Installed line.
- **Running state** — D-112's lock read (the shared `readServiceLock` over
  `lockFilePath` of the owner's data directory, liveness through
  `isProcessAlive`): run-mode independent, answering "running, at which pid?"
  where a manager query could only answer "installed". The four read states
  render honestly: absent → stopped; a live holder → `running (pid …)`; a
  dead holder → stopped with the stale-lock explanation; unreadable/invalid →
  `unknown` plus a stderr failure line.
- **Manager state** — `systemctl [-–user] is-active quotameter.service`
  through task 137's command seam, only for an installed unit, and only as an
  unprivileged query (D-105's vocabulary: status queries run as the service
  owner). A privileged run never asks a `--user` manager (it would be root's,
  not the owner's — the report prints the regular-account step instead). The
  binary exit status renders `active`/`not active` **only for a command that
  ran and answered**: a non-zero exit carrying a stderr diagnostic (spawn
  failure, unreachable bus) renders `unknown (<diagnostic>)` and makes the
  exit 1 — never a false `not active`; the unit kind disambiguates the line
  only when both are installed.
- **Per-account facts** — the account list is the live configuration (the
  service's own `loadConfigWithEnv` pipeline); each status is task 111's
  `deriveAccountStatus` (§7.3's vocabulary through `ACCOUNT_STATUS_LABELS`)
  over `readPollingRunEvidence` storage reads. The two inputs a separate
  process cannot observe take their honest proxies (D-114): the D-064
  suspension passes `INITIAL_SUSPENSION_STATE` (the `auth_error`-run branch
  keeps rank 1 truthful — D-070's recorded stance for this consumer), and
  `configured` resolves `apiKeyEnv` against this invocation's environment
  (the D-112 residual: the CLI cannot see the service's environment).
- **§7.2's two most-recents** — the last collection is the evidence's
  `lastSuccessAt` (the latest snapshot's §8.4 stamp); the last error is the
  newest **non-success** run (six bounded, indexed `getLatestCollectionRun`
  probes), rendered with its §7.3-named outcome label and the stored message
  (sanitized by construction, D-048) after an exact-occurrence redaction of
  every §6.3 secret source — file-stored keys, environment-supplied key
  values, and the password hash (§7.4's rule mirrored — the public sanitizer
  is payload-shaped).
- **Dead-engine suspicion (FSM-4, D-192)** — a separate process cannot
  probe the polling engine, so the report reads the same silence §12.2's
  timeline reads: `assessEngineLiveness` warns — one advisory line with a
  `quotameter logs` pointer — when the lock is held by a live pid yet no
  account the engine would poll (enabled, secret resolvable in this
  invocation's environment) has recorded a cycle for more than three
  jitter-expanded intervals (`gapThresholdMs` from `history-gaps.ts`, the
  one threshold source; any outcome counts — a failing cycle still proves
  the loop alive). A stopped service's old cycles are expected and never
  warn; the suspicion is exit-neutral (D-114: states are not failures).
- **§10 time discipline** — every rendered timestamp is
  `formatZonedDate`/`formatZonedTime` in the configured display zone with the
  zone's name, never a machine-local reading; `now` comes from the injectable
  clock seam (D-021 — `createSystemClock` stays the only `Date.now` site).
- **Storage** — `openStatusStore` opens an **existing** database only, and
  **read-only** (through the additive storage sibling
  `openReadOnlyStorageConnection` — the layout's `node:sqlite` layer rule
  keeps the read-only knowledge inside `src/storage/`): the
  command never creates a database (a read-only handle cannot), never writes
  pages (no hot-journal recovery as another user under `sudo`), and still
  passes the §11.1 pragma verification because a quotameter database is
  already WAL — the accepted residual is that a crashed writer's hot journal
  needs a writer first and reads as an honest failure. An absent file is
  empty evidence (the §7.3 no-run paths answer); an unreadable one is a
  stderr failure with the accounts section marked unavailable, and only the
  repository reads sit inside that failure's try. The existence probe runs
  before any storage module loads, so `node:sqlite`'s ExperimentalWarning
  belongs to invocations that actually open a database, not to every
  launcher invocation through the dispatch table (the raw-diagnostics.ts
  discipline). §6.3's env-only mode reports its provenance (`valid — from
environment overrides, no configuration file`), never implying a file
  exists.
- **Exit codes (D-114)** — 0 exactly when every probe _answered_ (stopped,
  not installed, no accounts, and no data are states, not failures); 1 when a
  probe could not answer (owner problems, unusable home, unreadable/invalid
  lock, invalid configuration, storage failure) — the report still renders
  everything established, with the failure lines on stderr. The handler never
  throws.

Branch coverage: the installed-scope × manager × running × configuration ×
storage matrix is seam-driven in `test/unit/cli-service-status.spec.ts`
(beside the pure-helper tables — the manager probe plan, the outcome-filtered
latest-error read, the §6.3 secret resolution, the §10 formatter, the
redaction, the dead-engine liveness table — and the production opener against
real directories, including a
corrupt database); the real-launcher routes — the bare machine, the full
report over a real configuration and a real migrated SQLite database (marker
key never rendered), the invalid configuration, and a real §5.6 lock naming a
live pid — plus the in-process opener-over-seeded-database read are pinned in
`test/integration/cli-service-status.spec.ts`.

## The `logs` command (task 143, spec §5.2/§16, decision D-116)

`service-logs.ts` holds the §5.2 `quotameter logs` handler — the convenient
`journalctl` wrapper §16 names as the diagnostics surface for the Pino JSON
logs journald collects. It composes the landed layers and adds exactly one
new mechanism, the streaming passthrough:

- **Scope** — D-110's installed-unit disk discovery (the 140 handler's
  shape): a system unit runs `journalctl … -u quotameter.service`, a user
  unit `journalctl --user … -u quotameter.service`. Both units installed is
  the 139 mistake: D-108's privileges rule selects and the shared
  cross-unit note goes to stderr **before** the stream (after a follow it
  would be lost under the entries).
- **Reading is unprivileged** — D-105's vocabulary names journalctl queries
  service-owner operations: the system journal is read in-process whatever
  this invocation's privileges are, and an OS-level refusal renders the
  `sudo journalctl …` remedy; a privileged run facing a user unit is sent
  to the regular account (root's `--user` query reads root's journal,
  never the owner's). The 140/142 capability gates mirror over: no systemd
  means no journal at all, and an unreachable user manager gets the exact
  next-login-session command.
- **Foreground-run honesty** — D-112's lock read (`readServiceLock` +
  `isProcessAlive`), consulted only on the nothing-installed path: a live
  lock holder is a foreground `quotameter run`, which has **no journal**
  (its messages are on the terminal it was started from) and gets the
  honest guidance naming its pid. An installed unit's journal is read
  regardless of running state (journals persist across stops), so the lock
  is not consulted there.
- **The convenience defaults (D-116)** — `--no-pager` always (the wrapper
  keeps the user's scrollback), `--lines=100` (`-n/--lines` takes a whole
  count ≥ 1 or `all`), `--output=short-precise` (`-o/--output` validates
  against a closed enum of journalctl's stable formats; `cat` shows the
  raw §16 JSON line, `json` the full journal record), and `-f/--follow`
  opt-in.
- **The passthrough runner** — `runJournalctlPassthrough` spawns the built
  command with piped stdio, forwards stdout chunks **raw** to the
  process's stdout as they arrive (no line reassembly — follow mode is a
  live stream; the raw byte path is the one documented exception to the
  `CliOutput` line contract), captures stderr bounded (the house cap,
  sliced chunk-exactly by the pure `appendCappedStderrChunk`) for the
  failure detail, and forwards SIGINT/SIGTERM to the child: a Ctrl-C ends
  a follow as success (the `docker logs -f` convention), a **second**
  signal escalates to SIGKILL (a wedged child cannot hold the terminal),
  and the forwarders are removed when the child closes. A closed output
  pipe (`quotameter logs | head`, EPIPE on `process.stdout`) gets the same
  stop-early semantics — the run resolves as an interrupted success
  instead of an unhandled stream error — and `write`-reported
  backpressure pauses the child's stdout until the sink drains
  (`--lines=all` over a slow pipe cannot queue the journal in memory; an
  `exit`-time resume guarantees `close` even on a paused stream).
  journalctl's own stderr is part of its product: a non-empty capture is
  flushed to stderr on a successful exit, while a failed exit quotes the
  first line in the detail. journalctl missing is detected through the
  spawn error arm (ENOENT), not a PATH probe.
- **Exit codes (D-116)** — 0 exactly when journalctl ran and exited 0, or
  was interrupted through a forwarded signal (no chatter either way — the
  stream is the product); 1 for every honest failure: owner problems, an
  unusable owner home, nothing installed (foreground or not), a privileged
  run facing a user unit, an unavailable manager, a missing journalctl, or
  a failed journalctl (with the exact command that ran and the scope's
  direct journalctl remedy — the user's own `-f`/`-n`/`-o` flags carry
  over — plus `quotameter status` on stdout). The handler never throws.

Branch coverage: the scope × capability × viewer-outcome matrix, the flag
parsers, and the byte-pinned command vectors are seam-driven in
`test/unit/cli-service-logs.spec.ts`, beside the bounded-capture helper
table and the real-child passthrough tests (stdout forwarding order and
split-line content exactness, exit-status and first-stderr-line detail
arms, the SIGKILL-without-forwarding arm, the missing-binary arm, the
EPIPE-as-interrupted and stream-error arms, the backpressure gate with its
drain replacement, the second-signal SIGKILL escalation); the
real-launcher routes — nothing installed, a real §5.6 lock naming a live
child (the foreground-run honesty), `--help`, and the follow-mode interrupt
through a driver child running the real runner (U-001 readiness handshake,
SIGINT forwarded to the grandchild, interrupted-success outcome) — are
pinned in `test/integration/cli-service-logs.spec.ts`.

## The `passwd` command (task 144, spec §5.2/§15.2, decision D-118)

`passwd.ts` holds the §5.2 `quotameter passwd` handler — set or change the
web password — composed of landed layers (D-101 detection/staleness, the
D-022 settings boundary, the §6.3 permission/atomic-write path, the
D-105/D-108 owner resolution and directories, the D-112 lock read) plus one
new module: the §15.2 hash encoding `src/services/password-hash.ts`
(`hashPassword` — scrypt from `node:crypto`, a fresh 16-byte random salt
per hash, the exported `SCRYPT_PARAMETERS` work parameters, and the
self-describing `scrypt$N=…,r=…,p=…,keylen=…$<salt>$<hash>` encoding whose
parameters travel with the hash so task 153's verifier never drifts from
what is on disk).

- **Interactive-only, no value flags** (§5.2 declares no options; a
  `--password` flag would put the secret in the process listing — the
  §15.4 rule behind init's env-by-name key channel). The password is asked
  twice through the prompter's muted `askSecret`; a blank/too-short first
  answer (the D-022 boundary's exported `MIN_PASSWORD_LENGTH` = 12, on the
  raw untrimmed value) and a mismatching confirmation each draw one
  secret-free stderr complaint and restart the pair, up to three attempts;
  closed input or Ctrl-C cancels with nothing changed. No complaint, the
  success report, or any other line ever contains the typed value — the
  done-condition, pinned by marker tests at every level. Since U-042 the
  pair flow is shared: `askNewPassword` takes additive options (a custom
  first prompt, and a skip for exactly-empty first answers) that init's
  §5.3 step-4 leg (`init-password.ts`, D-141) consumes — one prompt-flow
  implementation behind both password setters, and `passwd`'s own call
  shape (no options) unchanged.
- **The write is never privileged**: a run with privileges held is refused
  to the owner's regular account before anything is asked — the atomic
  write replaces the inode, so a root write would leave the owner's
  configuration root-owned `0600`, unusable for the account §5.1 requires
  the service to run as. Absent configuration → refusal pointing at
  `quotameter init` (nothing to hang the hash on); invalid → problems
  verbatim, nothing changed; existing → `validateSettings` merges the hash
  over the canonical base and re-validates (the same boundary init uses),
  completing the §15.1 password-pending state as a side effect — the
  service starts on the file the completed run leaves.
- **Fail-secure revocation (§15.2)**: after the D-101 stale-guard re-read,
  every stored session is deleted through the repository's
  `deleteAllSessions` (read-write connection of the owner's data
  directory, behind the existence-probe discipline — no database means
  "no stored sessions to revoke") **before** the configuration is
  written. A failed revocation aborts with the password unchanged; the
  safe-direction residual (revoked, then the write fails) is reported
  exactly: sessions revoked, password unchanged, run passwd again. The
  settings PUT's password change follows the same order (the settings
  store revokes before its configuration mutation, D-184); the shared
  rationale lives in
  [docs/security/password-change-revocation.md](../../docs/security/password-change-revocation.md).
- **The reload advisory**: when D-112's lock read finds a live holder, the
  report names the pid and the `quotameter reload` step —
  `auth.passwordHash` is live-on-reload by D-026's classification (one of
  the two settings §6.4's own list does not name), so a running service
  keeps authenticating with the old password until it reloads. Every other
  lock state changes nothing about the completed write and is silent.
- **Exit codes (D-118)** — 0 exactly when the pair was confirmed, the
  sessions were revoked, and the file was written; every refusal or
  failure arm exits 1. The handler never throws.

Branch coverage: the full matrix is seam-driven in
`test/unit/cli-passwd.spec.ts` (the prompt-flow table, the renderers, the
handler arms with a marker password asserted absent from all output, the
real-filesystem revocation classification); the real-launcher routes — set
with a real migrated SQLite database whose seeded sessions are gone after
the run, change, pending completion (the file `loadConfigWithEnv` refused
before and accepts after), the too-short-then-success piped route, closed
stdin, no configuration, and `--help` — are pinned in
`test/integration/cli-passwd.spec.ts`; the encoding itself (format, salt
randomness, the known-answer recomputation from the exported constants) in
`test/unit/password-hash.spec.ts`.

## The `doctor` command (task 145, spec §5.5, decision D-119)

`doctor.ts` holds the §5.5 `quotameter doctor` handler — the diagnostics
command — whose product is the **check-result contract** the
done-condition names ("checks return actionable messages and a stable
exit status"). Every check yields one row with a closed status vocabulary
(**D-119**): `pass` (the fact it established), `fail` (a problem needing
operator attention — the summary plus indented detail lines name the next
step, a quotameter command or a system remedy), `unavailable` (the check
could not run; honest, and never failing the exit code — a non-diagnosis
is not a diagnosis, D-114's `unknown` stance applied to exit semantics),
and `skip` (a precondition was not met; the failing row carries the
remedy). **Exit code: 1 exactly when at least one check is `fail`** (or
the pre-flight owner/directory resolution failed, which renders the
standard failure lines and no report); otherwise 0 — doctor is the
attention-flagging command (the flutter/brew-doctor convention), so a
stopped service or an occupied port is a `fail` here, exactly the states
`status` (D-114) deliberately never fails on: different command, different
job. Each check composes the layer that owns its fact, never re-derived:

- **Runtime** — the found `process.versions.node` against
  `MINIMUM_NODE_VERSION` (imported lazily from `src/server/main.ts`, the
  D-098 mirror of `engines.node`, so the dispatch graph stays light),
  failing closed on an unparseable version; and `node:sqlite`
  availability through the storage layer's new probe
  (`src/storage/sqlite-availability.ts` — the layout gate keeps the
  `node:sqlite` import inside `src/storage/`, and the dynamic hop keeps
  the CLI graph free of it; the probe's ExperimentalWarning on every
  doctor run is intrinsic to §5.5's check).
- **Configuration** — the service's own `loadConfigWithEnv` pipeline (the
  D-112 precedent): valid (file or env-only, provenance stated), absent
  (fail with `quotameter init` — a machine doctor runs on should be
  configured), or invalid (the pipeline's field-addressed problems).
- **Permissions** — a **diagnostic-only** stat of the §6.3 objects (mode
  `0700`/`0600`, owner uid = the service owner's, no symlink, right
  type): doctor never chmods (`enforceConfigPermissions` is the fixing
  half; a diagnostic that mutates its subject lies about what it found) —
  the fail rows carry the `chmod`/`chown` remedy.
- **Time zone** — the configured display zone through the clock module's
  IANA gate (defense-in-depth total: the parser pre-validates).
- **Database** — the read-only storage sibling over an existing file plus
  `PRAGMA quick_check` (§5.5's own probe; absent = skip "not created
  yet", a refused open fails with D-114's hot-journal hint, problems
  quote the first rows). The same handle feeds `--raw`.
- **Accounts** — per-account `validateCredentials` through the §8.1
  contract (`createInitialAccountProvider` default, whose D-052 15 s
  deadline is deliberate for a diagnostic — U-054/D-179: the probe must
  behave identically whatever configuration it examines, while the running
  service's registry adapter re-reads the configured deadline per request),
  classified by
  init-account's secret-scrubbing `classifyTestFailure`: rejected → fail
  with the replacement remedy, inconclusive → unavailable (D-052's own
  distinction), disabled → skip, an `apiKeyEnv` missing from this shell →
  the D-112 residual (unavailable, never a verdict). Totality guards (the
  review round's P2s): a schema-valid-but-blank label or key is a fail
  row (whitespace is never a credential or label, D-011 — never a thrown
  `AccountContext` TypeError losing the report), and an account naming a
  provider this build does not carry is never probed with the bundled
  adapter (§15.4: a key must not travel to a provider its configuration
  never named).
- **Service** — two rows: the installed scope from D-110's disk probe
  (both units = the 139 mistake; unit content read through the §5.4
  parser, `ExecStart` compared against `serviceExecPaths()` — §5.4's
  stale-path detection with `service install` as the regeneration remedy
  — and the unit-kind structural validator, the system unit against the
  owner-scoped `ReadWritePaths` pair), and the state row (the exported
  D-114 `planManagerProbe`/`describeManagerState` for an installed unit —
  not active is a fail with the `quotameter start` next step, sudo-prefixed
  for a regular user facing a system unit; a unit-less machine through
  D-112's lock read — a live holder passes as the foreground run, absent
  or stale fails with the install/run steps).
- **Port** — a real ephemeral bind of the configured `host:port` (no
  `ss`/`lsof` subprocess, the D-107 well-known-path reasoning): free
  passes, in-use passes only when the running service holds it (the lock
  fact), a refusal fails with the unprivileged-port advice — and a
  privileged run binding a port below 1024 proves nothing about the
  unprivileged owner, so that combination fails too (the review round's
  caveat), as do the unbindable address errors (`EADDRNOTAVAIL` et al.).
- **Network/authentication** — §15.1's consistency verdict: valid
  configurations render the loopback/remote × auto/required × password
  classification (the parser already refuses the inconsistent ones);
  invalid ones get the D-101 placeholder-hash probe (via the additively
  exported `withPlaceholderHash`) through `parseConfigWithEnv`, so the
  password-pending state fails with its precise `quotameter passwd`
  remedy while any further defect stays the Configuration row's list.
- **Clock** — `timedatectl show --property=NTPSynchronized --property=NTP`
  parsed as `Key=value` (never the locale-dependent human table;
  `spawnServiceCommand` cannot serve — it ignores stdout, which is this
  check's product — so a local bounded-capture runner with a kill-timeout
  a wedged D-Bus cannot outwait): unsynchronized or synced-but-NTP-inactive
  fails with `sudo timedatectl set-ntp true`, an absent timedatectl (the
  systemd-less container) is unavailable.

`--raw <account>` (§7.4, D-067): after the checks, the report appends the
account's retained sanitized payloads through the 103 read path
(`readRawDiagnostics` + `renderRawDiagnostics`) over the same read-only
handle — the CLI-only exposure the raw-response gate enforces
structurally. The section is informational (never changes the exit code);
a blank account id is a handler failure naming the correct spelling; a
missing database or an unknown account renders its honest sentence (the
database is the source — payloads may outlive a removed account's config
entry); a read that fails over an open handle renders its failure
sentence instead of aborting the report; and the handle is released in a
`finally` on every path (the review round's P1 — an appendix must not be
able to lose the report).

Branch coverage: the full matrix is seam-driven in
`test/unit/cli-doctor.spec.ts` (every check × every D-119 status, the
renderer byte-pinned, the parser/classifier tables, the production opener
against real directories — kernel-genuine absent, real migrated
quick_check pass, corrupt refusal — and the real-socket bind probe);
`test/integration/cli-doctor.spec.ts` pins the real-launcher routes — the
bare machine (exit 1, the init and install/run next steps), the healthy
machine over a real migrated database with a real §5.6 lock naming a live
child (exit 0, foreground pid in the report), the env-key residual, the
seeded `--raw` payload, the invalid configuration, and `--help`.

## The `run` command (task U-050, spec §5.2/§5.6)

`run.ts` holds the §5.2 `quotameter run` handler — "Foreground execution
for systemd and debugging", the exact invocation the generated unit's
`ExecStart` pins (`<node> <cli> run`, §5.4). The handler is deliberately the
thinnest in the layer:

- **Lazy server import** — the handler imports `runServer`
  (`src/server/main.ts`, task 060's callable) dynamically, inside the
  handler, because `buildCommandTable()` loads for every CLI invocation: a
  static import would drag the composition root, Fastify, Pino, and
  `node:sqlite` (whose ExperimentalWarning would print on every unrelated
  command) into `--help`. The same discipline keeps doctor's
  `MINIMUM_NODE_VERSION` and the storage-opening commands' connection
  imports out of the dispatch graph. A failing dynamic import propagates to
  the dispatcher and is reported as the standard command failure
  (`quotameter run: <message>`, exit 1).
- **Exit-code forwarding, no output** — `runServer` owns the process
  semantics unchanged: the runtime gate, the §6.2 refuse-to-start (reported
  through its own `quotameter:` stderr channel), the §5.6 graceful
  SIGTERM/SIGINT shutdown, since U-052 the SIGHUP configuration reload
  (D-177), and U-022's best-effort stop on startup failure
  (D-095). The handler adds nothing: a foreground service's stdout is the
  §16 structured-log JSON stream journald collects. §5.2 defines no options
  and no positionals for the command.
- **Readiness for supervisors** — systemd needs no marker (`Type=exec` +
  journald); tests and embedders signal only after the service is
  observable, which for the real launcher is an answered `GET /api/health`
  — the listener is the last §5.6 component, and `runServer`'s signal
  handlers are installed in the synchronous microtask continuation right
  after `app.start()` settles, so an answered HTTP request can never
  precede them (the D-024 handshake invariant through the public surface;
  `onSignalsReady` itself stays a test/embedder seam production never
  passes).

Branch coverage: `test/unit/cli-run.spec.ts` (exit-code forwarding, import
failure propagation, the production import seam, and the full default path
hermetically in-process — `runCli(['run'])` over temp directories refuses
on the missing configuration and exits 1); `test/integration/cli-run.spec.ts`
runs the real launcher — the clean-SIGTERM proof over a temporary
configuration with a reserved port (health answered → SIGTERM → exit 0, the
§5.6 lock released, the fatal channel silent), the §6.2 invalid-configuration
refusal, and the lazy-graph pin (`--help` loads no `node:sqlite`); the
launcher-level help route is pinned in `test/integration/cli-bin.spec.ts`.
