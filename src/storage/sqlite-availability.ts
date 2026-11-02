/**
 * The `node:sqlite` availability probe (task 145, spec §5.5; decision
 * D-119).
 *
 * Spec §5.5 has `doctor` check "Node version and `node:sqlite`", and the
 * package layout's storage gate keeps every form of the `node:sqlite`
 * import inside `src/storage/` — so the probe lives here, in the layer
 * that owns the built-in. `doctor.ts` reaches it dynamically, which keeps
 * its own static graph (it is statically imported by the dispatch table)
 * free of any storage module: the ExperimentalWarning belongs to
 * invocations that actually touch SQLite, exactly the D-116 discipline the
 * CLI modules follow.
 *
 * The module's import of `node:sqlite` is itself dynamic so that merely
 * importing this probe loads nothing: availability is answered by trying
 * the built-in, not by assuming it.
 */

/** True when this Node.js build carries the built-in SQLite module. */
export async function probeNodeSqlite(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
