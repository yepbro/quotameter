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
