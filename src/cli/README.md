# `src/cli/` — command implementations

The `quotameter` command surface (spec §5.2, Stage 11): `init`, `run`,
`start`/`stop`/`restart`, `reload`, `status`, `logs`, `service`
(`install`/`uninstall`), `passwd`, and `doctor`. `bin/quotameter.mjs` stays
a thin, build-free launcher that dispatches here (compiled at publish time
— no install-time build, spec §3).

**Rule:** a top-level consumer — it may import any layer except concrete
provider adapters. Nothing under `src/` imports this module; only `bin/` does.

## Dispatch skeleton (task 128, decision D-044)

| File                   | Owns                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`              | `runCli(argv, deps)` — global flags, dispatch, exit codes; never calls `process.exit`                                                          |
| `commands.ts`          | the §5.2 command table (`buildCommandTable`), handler/context types, the shared `notImplemented` stub                                          |
| `parser.ts`            | `node:util` `parseArgs` in strict mode; options per command; `UsageError`                                                                      |
| `help.ts`              | pure help renderers (general, command, group)                                                                                                  |
| `output.ts`            | the `CliOutput` writer seam (`systemOutput` → `process.stdout`/`stderr`)                                                                       |
| `prompts.ts`           | the interactive prompt seam: readline prompter with a line queue, EOF-safe questions, muted secrets                                            |
| `init-questions.ts`    | the §5.3 question flow: per-value validation, empty-answer semantics, answers→config assembly                                                  |
| `init-yes.ts`          | the §5.3 non-interactive layer: `--yes` flags → answers through the same parsers, env key channel                                              |
| `init-account.ts`      | the §5.3 step-6 account leg: id/secret-source assembly, the connection test, the failure offer                                                 |
| `init-persist.ts`      | the §5.3 idempotent layer: existing-config detection, masked display, merge, consented atomic write                                            |
| `init.ts`              | the `init` handler: mode branch, detection outcomes, the account step, cancellation, masked summaries                                          |
| `raw-diagnostics.ts`   | the §7.4 diagnostic read path behind `doctor --raw <account>` (task 103)                                                                       |
| `systemd-unit.ts`      | the §5.4 system unit generator, unit-file parser, and structural validator (task 134)                                                          |
| `systemd-user-unit.ts` | the §5.3/§5.4 user unit generator and structural validator (task 135)                                                                          |
| `service-owner.ts`     | the §5.3 ownership/privilege decision layer: invocation context, service-owner resolution, privileged-operation routing (task 136)             |
| `service-setup.ts`     | the §5.3 step-7 branch layer: capability probes, the route matrix, the no-sudo user-unit install, the manual-steps fallbacks (task 137)        |
| `service-linger.ts`    | the §5.3 linger detection + guidance layer: flag-file tri-state probe, the enable-linger command with the logout/reboot consequence (task 138) |
| `service-install.ts`   | the §5.2 `service install`/`uninstall` handlers: idempotent unit lifecycle on both unit kinds, through the 136/137 seams (task 139)            |

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
  provider-neutral).
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
  canonical file at `0600` atomically (§5.3 step 5's configuration half;
  the database lands with the storage-consuming steps, task 133+). Since
  task 133 a fresh run with a key source also stores the initial account
  (see the account-setup section above) — tested, offered on failure, and
  persisted with its secret inside the `0600` file.
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
  the container and CI images ship no systemd (`systemd-analyze` is absent —
  verified on the pinned image), so a generated unit's done-condition is
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

- **Probes** — `probeServiceCapabilities` reads two well-known facts, no
  commands: `/run/systemd/system` (the marker systemd itself creates when
  it is the init system) for `systemd`, and an own, non-empty
  `XDG_RUNTIME_DIR` whose `systemd` runtime directory exists for
  `userManager` — the same reachability signal `systemctl --user` uses
  (own-property read: an inherited `XDG_RUNTIME_DIR` is not a session).
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
  enabled/started (plus `is-active` on the system route); uninstall exits 0 exactly when
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

Branch coverage: every route and failure path is seam-driven in
`test/unit/cli-service-install.spec.ts` (the container and CI images ship no systemd);
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
