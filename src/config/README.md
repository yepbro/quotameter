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

**Rule:** may import only `src/schemas/` and `src/util/` — no services,
storage, providers, or server code.
