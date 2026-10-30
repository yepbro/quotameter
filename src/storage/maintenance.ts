/**
 * Post-cleanup storage maintenance — the WAL checkpoint and
 * `incremental_vacuum` step (spec §11.3; task 091, decision D-063).
 *
 * Spec §11.3 closes the cleanup sentence with "Then checkpoint WAL and run
 * `incremental_vacuum` where supported/configured", and spec §5.6 asks the
 * shutdown path to "close the database, and checkpoint WAL". This module is
 * that maintenance as one primitive over the raw `DatabaseSync` — the
 * connection (task 079) owns the §11.1 pragmas, and a maintenance call is
 * not a pragma policy but an operation, so it lives beside the repository
 * as another storage-internal seam. It is deliberately **not** a repository
 * facade method: the facade hands out typed rows and never a connection
 * handle (D-058), while a checkpoint is a statement about the database
 * file, not about any table.
 *
 * Pinned interpretations (D-063):
 *
 * - **`wal_checkpoint(TRUNCATE)`, and its outcome is data.** TRUNCATE is
 *   the mode that actually returns the disk the WAL accumulated — the
 *   reason §11.3 wants the checkpoint after a cleanup at all — and it
 *   reports `{busy, log, checkpointed}`. `busy` means another connection
 *   held a read snapshot (the single-instance service has one connection
 *   of its own, but `quotameter doctor` or an operator's shell can hold
 *   another); that is a reportable outcome, not an error, so it maps into
 *   the result instead of throwing — though on a §11.1 connection the
 *   checkpoint first waits out the `busy_timeout` budget through SQLite's
 *   busy handler before reporting it. Only a driver-level failure (a broken
 *   connection) throws, and it propagates unwrapped (the D-058 style).
 * - **`incremental_vacuum` runs unconditionally; SQLite decides.** The
 *   §11.1 pragma set configures no `auto_vacuum`, so a Quotameter database
 *   defaults to `auto_vacuum = NONE`, where SQLite documents the pragma as
 *   a no-op (verified empirically on the pinned runtime). "Where
 *   supported/configured" is therefore expressed by running the call and
 *   reporting the database's actual `auto_vacuum` mode: on an
 *   operator-configured `INCREMENTAL` file it returns freed pages to the
 *   OS, on the service's own default it costs nothing. Gateing the call on
 *   a mode readback instead would duplicate SQLite's own decision.
 * - **The checkpoint runs before the vacuum** — §11.3's own order — so the
 *   vacuum operates on a database that already absorbed the WAL.
 */

import type { DatabaseSync } from 'node:sqlite';

/** The database's `auto_vacuum` mode, as `PRAGMA auto_vacuum` reports it. */
export type AutoVacuumMode = 'none' | 'full' | 'incremental';

/** What `PRAGMA wal_checkpoint(TRUNCATE)` reported for one maintenance run. */
export interface WalCheckpointOutcome {
  /**
   * `true` when another connection's read snapshot blocked the checkpoint
   * from completing — a reportable outcome, not an error: the next cleanup
   * (§11.3 runs it at startup and daily) checkpoints again. On a §11.1
   * connection (`busy_timeout = 5000`, task 079) the checkpoint first waits
   * out that budget through SQLite's busy handler before reporting `busy`,
   * so a caller on the hot path should expect up to ~5 s of synchronous
   * stall when `doctor` or an operator shell holds a stale snapshot.
   */
  readonly busy: boolean;
  /** Pages in the WAL when the pragma ran (SQLite's `log` column). */
  readonly walPages: number;
  /** Pages copied into the database by this checkpoint (SQLite's column). */
  readonly checkpointedPages: number;
}

/** What one maintenance run did — §11.3's post-cleanup step as data. */
export interface StorageMaintenanceResult {
  readonly walCheckpoint: WalCheckpointOutcome;
  /**
   * The `auto_vacuum` mode the call ran against — `'none'` on the
   * service's §11.1-configured default (where `incremental_vacuum` is a
   * documented no-op), `'full'`/`'incremental'` on operator-configured
   * files where it returns freed pages to the OS.
   */
  readonly autoVacuumMode: AutoVacuumMode;
}

/** The `PRAGMA auto_vacuum` value each mode name maps to (SQLite's enum). */
const AUTO_VACUUM_MODES = ['none', 'full', 'incremental'] as const;

/**
 * Runs §11.3's maintenance step: checkpoint the WAL (TRUNCATE mode — the
 * one that resets the `-wal` file, giving the disk back a cleanup's
 * deleted pages have already freed in the main database), then
 * `incremental_vacuum`. Returns what happened; never throws for a SQLite
 * outcome, only for a driver-level failure.
 */
export function runStorageMaintenance(database: DatabaseSync): StorageMaintenanceResult {
  // One row, three integer columns: busy, log, checkpointed. The prepared
  // statement is cheap and the call is rare (startup, daily, shutdown).
  const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  };

  const modeValue = (
    database.prepare('PRAGMA auto_vacuum').get() as { readonly auto_vacuum: number }
  ).auto_vacuum;

  // A no-op on auto_vacuum = NONE (the §11.1 default) — verified on the
  // pinned runtime; real work only on an operator-configured file.
  database.exec('PRAGMA incremental_vacuum');

  return {
    walCheckpoint: {
      busy: checkpoint.busy !== 0,
      walPages: checkpoint.log,
      checkpointedPages: checkpoint.checkpointed,
    },
    // The mode enum is SQLite's own 0/1/2; an out-of-range readback (a
    // future SQLite revision) fails loudly rather than guessing.
    autoVacuumMode: AUTO_VACUUM_MODES[modeValue] ?? unknownAutoVacuumMode(modeValue),
  };
}

/** Names an out-of-range `auto_vacuum` readback — not a value to guess. */
function unknownAutoVacuumMode(modeValue: number): AutoVacuumMode {
  throw new Error(
    `runStorageMaintenance: PRAGMA auto_vacuum reported ${modeValue}, ` +
      'which is none of the documented modes 0 (none), 1 (full), 2 (incremental)',
  );
}
