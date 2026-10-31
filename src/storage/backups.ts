/**
 * Automatic database backups — §5.6/§11.4's `VACUUM INTO` primitive (task
 * 092, decision D-065).
 *
 * Spec §5.6: "Before any schema migration, create a database backup using
 * `VACUUM INTO`; retain the three most recent automatic backups." §11.4
 * repeats both halves. This module is that backup concern alone — creating
 * one automatic backup file and enforcing the retention window — with no
 * knowledge of migrations; the startup operation that decides *when* a
 * backup is due (`src/storage/startup-migrations.ts`) composes it before
 * applying anything.
 *
 * It is deliberately a sibling of `maintenance.ts`, not part of it: D-063
 * placed the WAL checkpoint and `incremental_vacuum` in their own module
 * because they are maintenance of the live file, and a backup is a
 * different operation entirely — a standalone copy written *before* a
 * risky change, kept *after* it. Like `runStorageMaintenance`, it takes
 * the raw `DatabaseSync` (the facade rightly never hands a connection
 * back, D-058) and like every storage module it issues its SQL itself.
 *
 * Pinned interpretations (D-065):
 *
 * - **Bound parameter, never interpolated SQL.** The target filename is
 *   bound to `VACUUM INTO ?` — a data directory path may contain quotes,
 *   and string-splicing it into the statement literal is the classic
 *   injection-shaped bug the storage layer has no reason to risk. Verified
 *   on the pinned runtime (Node 22.13.0): the statement prepares, and the
 *   driver binds the path as TEXT.
 * - **`VACUUM INTO` refuses to overwrite, so names must be fresh.** SQLite
 *   errors with "output file already exists" when the target is present
 *   (verified). The instant's candidate is `backup-<now>.sqlite`; on
 *   collision — two backups inside one clock reading, which a fixed test
 *   clock or a repeated startup at the same millisecond produces — a
 *   `-<seq>` suffix (1, 2, …) finds the first unused name instead.
 * - **Ordering is parsed `(timestampMs, seq)`, never lexicographic.** The
 *   retention decision must rank by the timestamp encoded in the name;
 *   raw name sort would evict `…-1` before `…-9` at the same instant
 *   invertedly across widths, and a future date-style name width would
 *   break it outright. `seq` breaks same-instant ties in creation order
 *   (no suffix reads as 0, the first of its instant). The comparison is
 *   `util`'s compound-key ordering family (D-096), exact at any finite
 *   magnitude — and both keys are finite by construction here: the
 *   creation path validates `now` as a non-negative integer, and on the
 *   listing side the file system's 255-byte name cap bounds a digit run
 *   at 241 digits (~1e241; a run that parses non-finite needs 309), so
 *   no name a supported file system can hold yields a non-finite key.
 * - **Only automatic backups are ever retained or evicted.** §11.4 says
 *   "retain the three most recent automatic backups": the naming grammar
 *   (`backup-<digits>[-<seq>].sqlite`) is therefore the retention scope —
 *   a foreign or operator-placed file in the directory is invisible to
 *   both listing and eviction, and cannot be deleted by this module.
 * - **Evict after the new backup exists — and never the new backup
 *   itself.** Creation failure (a full disk) must not cost the existing
 *   generations: the new file is complete on disk before any older one
 *   is unlinked. The just-created backup is additionally exempt from its
 *   own retention pass: ordering is by the timestamp parsed from the
 *   name, and a clock that reads *earlier* than the retained window (an
 *   NTP step-back — a shape `src/util/clock.ts` explicitly acknowledges —
 *   or a same-instant revisit after the unsuffixed name was evicted)
 *   would sort the fresh image oldest and delete it, migrating with zero
 *   pre-migration backups exactly when the safety net matters (review
 *   finding, reproduced). The window keeps `RETAINED_COUNT` total — the
 *   new backup plus the newest `RETAINED_COUNT − 1` others — and
 *   converges back to the plain three-newest rule on subsequent runs.
 *   An eviction failure propagates unwrapped (the D-058 style); the next
 *   migration re-runs retention over the same directory.
 * - **Sync `node:fs`, like the layer it lives in.** `DatabaseSync` makes
 *   the layer synchronous; the one-off startup call has nothing to gain
 *   from a promise. The backups subdirectory is created as this
 *   operation's own artifact (the same auto-create carve-out §11.1 grants
 *   the database file), single-level and EEXIST-tolerant: a missing data
 *   directory is an operator problem reported loudly by the `ENOENT`
 *   instead of silently re-created at the umask default (the D-030
 *   "no directory creation" posture; task 074's lock path owns the data
 *   directory, at its own `0700` mode).
 */

import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { compareByEpochMs } from '../util/compare-epoch-ms';

/**
 * The subdirectory of the data directory automatic backups live in (spec
 * §6.1 data-path conventions: next to `quotameter.sqlite`). Part of the
 * on-disk contract: moving it strands existing backups.
 */
export const AUTOMATIC_BACKUP_DIRNAME = 'backups';

/**
 * How many automatic backups are retained (spec §5.6, §11.4: "the three
 * most recent"): after each successful backup, older generations beyond
 * this count are evicted.
 */
export const AUTOMATIC_BACKUP_RETAINED_COUNT = 3;

/** The automatic-backup naming grammar's fixed prefix and suffix. */
const NAME_PREFIX = 'backup-';
const NAME_SUFFIX = '.sqlite';

/** One or more ASCII digits and nothing else (the grammar's number text). */
const DIGITS_ONLY = /^\d+$/;

/**
 * Parses an automatic backup file name — `backup-<epoch-ms>[-<seq>].sqlite`
 * — into its instant and same-instant sequence (0 for the unsuffixed
 * form), or `undefined` for any name outside the grammar (which is what
 * keeps retention's scope exactly "automatic backups"). Written as two
 * anchored steps rather than one pattern so each number is matched by a
 * single-quantifier regex.
 */
function parseAutomaticBackupName(name: string): { timestampMs: number; seq: number } | undefined {
  if (!name.startsWith(NAME_PREFIX) || !name.endsWith(NAME_SUFFIX)) {
    return undefined;
  }
  const middle = name.slice(NAME_PREFIX.length, name.length - NAME_SUFFIX.length);
  const separator = middle.indexOf('-');
  const timestamp = separator === -1 ? middle : middle.slice(0, separator);
  const sequence = separator === -1 ? '0' : middle.slice(separator + 1);
  if (!DIGITS_ONLY.test(timestamp) || !DIGITS_ONLY.test(sequence)) {
    return undefined;
  }
  return { timestampMs: Number(timestamp), seq: Number(sequence) };
}

/** One automatic backup file, as the listing parsed it. */
export interface AutomaticBackup {
  /** Absolute (or backupDir-relative joined) path of the file. */
  readonly path: string;
  /** File name inside the backup directory. */
  readonly name: string;
  /** The epoch-ms timestamp encoded in the name (the caller's `now`). */
  readonly timestampMs: number;
  /** The same-instant sequence number; 0 for the unsuffixed form. */
  readonly seq: number;
}

/** Options for {@link createAutomaticBackup}. */
export interface AutomaticBackupOptions {
  /** An open database; the backup reads it (WAL content included). */
  readonly database: DatabaseSync;
  /** Backup directory — {@link automaticBackupsDir} of the data directory. */
  readonly backupDir: string;
  /** The backup's timestamp and name seed (§11.1 epoch ms, D-021). */
  readonly now: number;
}

/** What one {@link createAutomaticBackup} call did. */
export interface AutomaticBackupResult {
  /** The backup just written. */
  readonly backup: AutomaticBackup;
  /** Generations evicted to honor {@link AUTOMATIC_BACKUP_RETAINED_COUNT}. */
  readonly evicted: ReadonlyArray<AutomaticBackup>;
}

/** Oldest-first ordering: instant, then same-instant sequence (D-096). */
const byInstant = compareByEpochMs(
  (backup: AutomaticBackup) => backup.timestampMs,
  (backup: AutomaticBackup) => backup.seq,
);

/**
 * The backup directory inside a data directory:
 * `<data>/${AUTOMATIC_BACKUP_DIRNAME}`, resolved the `databaseFilePath`
 * way — the caller (task 079 seam) passes the already-resolved data
 * directory; storage never re-resolves XDG paths.
 */
export function automaticBackupsDir(dataDir: string): string {
  return path.resolve(dataDir, AUTOMATIC_BACKUP_DIRNAME);
}

/**
 * Every automatic backup in `backupDir`, oldest first by
 * `(timestampMs, seq)`. A missing directory is an empty list — nothing has
 * been backed up yet — while any other read failure propagates. Foreign
 * files (names outside the grammar) are ignored: they are not this
 * module's to list, order, or delete.
 */
export function listAutomaticBackups(backupDir: string): ReadonlyArray<AutomaticBackup> {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const backups: AutomaticBackup[] = [];
  for (const name of entries) {
    const parsed = parseAutomaticBackupName(name);
    if (parsed === undefined) {
      continue;
    }
    backups.push({ path: path.join(backupDir, name), name, ...parsed });
  }
  return backups.sort(byInstant);
}

/**
 * Writes one automatic backup of the open database and enforces the
 * three-generation retention window (spec §5.6, §11.4).
 *
 * The file is a complete standalone database image — `VACUUM INTO` reads
 * the live database including committed-but-uncheckpointed WAL frames and
 * emits a compact copy (verified on the pinned runtime; the image carries
 * no `-wal` sidecar). Runs outside any transaction: SQLite refuses
 * `VACUUM` from within one, so the caller orders the backup before the
 * migration runner's transactions — `runStartupMigrations` guarantees
 * that. On any failure (directory unwritable, disk full, driver error)
 * nothing was evicted and the error propagates unwrapped.
 */
export function createAutomaticBackup(options: AutomaticBackupOptions): AutomaticBackupResult {
  const { database, backupDir, now } = options;
  // A non-integer or negative `now` would mint a name outside the grammar
  // ('backup--5.sqlite') — invisible to listing, hence to retention. Fail
  // fast at the boundary (the D-013 style) instead.
  if (!Number.isInteger(now) || now < 0) {
    throw new Error(`automatic backup timestamp must be a non-negative integer, got ${now}`);
  }

  // Ensure the backups directory exists — one level, EEXIST-tolerant: a
  // missing parent (the data directory) still fails loudly with ENOENT
  // rather than being re-created (the D-030 posture), while an existing
  // backups directory is the normal second-call case.
  try {
    mkdirSync(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const taken = new Set(listAutomaticBackups(backupDir).map((backup) => backup.name));
  let seq = 0;
  let name = backupName(now, seq);
  while (taken.has(name)) {
    seq += 1;
    name = backupName(now, seq);
  }

  const created: AutomaticBackup = {
    path: path.join(backupDir, name),
    name,
    timestampMs: now,
    seq,
  };
  // Bound parameter: the module comment's injection-shaped-bug avoidance.
  database.prepare('VACUUM INTO ?').run(created.path);

  // Retention over the directory as it now stands, with the just-created
  // backup exempt from its own pass (the module comment's clock-step-back
  // case): the window keeps RETAINED_COUNT total — the new backup plus
  // the newest RETAINED_COUNT − 1 of the others — so eviction only ever
  // removes generations that predate the one this call exists to protect.
  const others = listAutomaticBackups(backupDir).filter((backup) => backup.name !== created.name);
  const evicted = others.slice(
    0,
    Math.max(0, others.length - (AUTOMATIC_BACKUP_RETAINED_COUNT - 1)),
  );
  for (const victim of evicted) {
    unlinkSync(victim.path);
  }
  return { backup: created, evicted };
}

/** The candidate backup file name for one instant and sequence number. */
function backupName(timestampMs: number, seq: number): string {
  return seq === 0 ? `backup-${timestampMs}.sqlite` : `backup-${timestampMs}-${seq}.sqlite`;
}
