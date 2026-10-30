# `src/cli/` — command implementations

The `quotameter` command surface (spec §5.2, Stage 11): `init`, `run`,
`start`/`stop`/`restart`, `reload`, `status`, `logs`, `service`
(`install`/`uninstall`), `passwd`, and `doctor`. `bin/quotameter.mjs` stays
a thin, build-free launcher that dispatches here (compiled at publish time
— no install-time build, spec §3).

**Rule:** a top-level consumer — it may import any layer except concrete
provider adapters. Nothing under `src/` imports this module; only `bin/` does.

## Dispatch skeleton (task 128, decision D-044)

| File          | Owns                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `main.ts`     | `runCli(argv, deps)` — global flags, dispatch, exit codes; never calls `process.exit`                 |
| `commands.ts` | the §5.2 command table (`buildCommandTable`), handler/context types, the shared `notImplemented` stub |
| `parser.ts`   | `node:util` `parseArgs` in strict mode; options per command; `UsageError`                             |
| `help.ts`     | pure help renderers (general, command, group)                                                         |
| `output.ts`   | the `CliOutput` writer seam (`systemOutput` → `process.stdout`/`stderr`)                              |

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

### Launcher notes (`bin/quotameter.mjs`)

The launcher gates the runtime first, answers a leading `--version`/`-v`
itself (a fixed CI contract: exactly the package version on stdout), then
delegates via a dynamic import with `mod.runCli ?? mod.default?.runCli`
(jiti mounts the TypeScript module as CommonJS during development and
tests; the published build is real ESM). An installation without the
compiled command modules (`ERR_MODULE_NOT_FOUND`) fails with a clear
message until the packaging tasks (184–186) ship them; any other module
failure surfaces as itself. Exits set `process.exitCode` and let the
event loop drain rather than calling `process.exit()`, so buffered pipe
output cannot be truncated.
