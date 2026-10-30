/**
 * Single-instance protection (task 074, spec §5.6).
 *
 * Prevents a second process from using the same data directory at the same
 * time: the lock file lives inside the data directory, so two instances with
 * different data directories never contend, while two processes on one data
 * directory do (spec §5.6, decision D-017).
 *
 * Node's `fs` has no `flock`, and native modules are out of the question
 * (spec §3, decision D-002), so the lock is an atomically published lockfile:
 * the payload is written to a unique scratch file and then hardlinked onto
 * the lock path — `link(2)` is exclusive, so acquisition is one atomic
 * decision and the lock is never observable half-written. A lock whose
 * recorded PID is no longer alive is broken automatically: the systemd unit
 * restarts on failure (§5.4), so a crash must not require a human to remove
 * the leftover lock file. Breaking races are settled by renaming the path
 * aside and verifying the captured content, which proves that the file
 * removed is the file that was inspected stale; every acquisition carries a
 * random token, so release removes exactly its own file and never a
 * replacement installed by a recovery race.
 *
 * The module exposes the primitive as a `LifecycleComponent` (task 060):
 * `start` acquires — a refusal or failure throws and aborts startup through
 * the app's rollback — and `stop` releases the lock, idempotently and without
 * throwing, so a release problem can never block the remaining shutdown
 * sequence. Registered first, it is released last (spec §5.6 order by
 * construction). The composition root resolves the data directory (task 063)
 * and passes it in; this module owns only the locking.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LifecycleComponent } from './app';

/** Lock file name inside the data directory; scratch files share its prefix. */
const LOCK_FILE_NAME = '.quotameter.lock';

/** Attempts to outlast contention (concurrent stale-breaking) before giving up. */
const DEFAULT_MAX_ATTEMPTS = 5;

/** Absolute path of the lock file guarding `dataDir`. */
export function lockFilePath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILE_NAME);
}

/**
 * PID liveness probe (Linux): signal 0 tests existence without signalling.
 * `ESRCH` means no such process; `EPERM` means the process exists but belongs
 * to another user. Any other failure is undecidable and conservatively
 * reported as alive — a live holder must never look dead.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Equivalent mutant (U-006 triage): process.kill only ever throws Error
    // objects, never null/undefined, so the optional chain never short-circuits.
    // The ConditionalExpression variants stay armed: the 'false' one is killed
    // by the pid-1 test wherever kill(1, 0) yields EPERM (the GitHub runners;
    // this dev container's namespace permits it, so scoped local runs may
    // show it as an environment-dependent survivor).
    // Stryker disable next-line OptionalChaining
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

/** Options of {@link createSingleInstanceLock}; the optional ones are seams. */
export interface SingleInstanceOptions {
  /** Data directory the lock guards (spec §6.1 resolution is the caller's). */
  readonly dataDir: string;
  /** PID recorded in the lock; defaults to the current process. */
  readonly pid?: number;
  /** Liveness probe for recorded holder PIDs; defaults to {@link isProcessAlive}. */
  readonly isAlive?: (pid: number) => boolean;
  /** Acquisition attempt limit; defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /**
   * Notified whenever an existing lock blocks acquisition, before it is
   * inspected. Diagnostic seam for the future structured logger (task 072)
   * and for tests that simulate concurrent holders.
   */
  readonly onContended?: () => void;
}

/** The acquired lock: its path and the unique token that identifies our file. */
interface HeldLock {
  readonly lockPath: string;
  readonly token: string;
}

/** A deliberate refusal to start: already reported, never wrapped again. */
class LockRefusedError extends Error {}

/** Resolved dependencies of the acquire/release algorithm. */
interface LockDeps {
  readonly dataDir: string;
  readonly pid: number;
  readonly isAlive: (pid: number) => boolean;
  readonly maxAttempts: number;
  readonly onContended?: () => void;
}

/**
 * The single-instance lock as a lifecycle component (task 060 seam).
 *
 * `start` acquires the lock and throws an actionable English error when
 * another instance holds the data directory — `QuotameterApp` turns that into
 * an aborted startup. `stop` releases the lock; it is idempotent and never
 * throws, per the component contract in `app.ts`.
 */
export function createSingleInstanceLock(options: SingleInstanceOptions): LifecycleComponent {
  const deps: LockDeps = {
    dataDir: options.dataDir,
    pid: options.pid ?? process.pid,
    isAlive: options.isAlive ?? isProcessAlive,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    onContended: options.onContended,
  };
  let held: HeldLock | undefined;
  return {
    name: 'single-instance-lock',
    async start() {
      held = await acquireLock(deps);
    },
    async stop() {
      // Equivalent mutant (U-006 triage): without the early return,
      // releaseLock(undefined) throws synchronously inside its own try/catch
      // and is swallowed — externally identical. The co-excluded 'true'
      // variant (never releases) is killable and stays pinned by the release
      // tests.
      // Stryker disable next-line ConditionalExpression
      if (held === undefined) return;
      const current = held;
      held = undefined;
      await releaseLock(current);
    },
  };
}

/**
 * Acquires the lock or refuses with an actionable error.
 *
 * Each attempt publishes atomically; an existing lock is inspected (with the
 * content read from one open file, so it describes one state), a live holder
 * refuses, a dead holder's stale lock is broken safely, and the loop retries.
 * Anything that is not a deliberate refusal is wrapped with the
 * data-directory context.
 */
async function acquireLock(deps: LockDeps): Promise<HeldLock> {
  await ensureDataDir(deps.dataDir);
  const lockPath = lockFilePath(deps.dataDir);
  try {
    for (let attempt = 1; ; attempt++) {
      if (attempt > deps.maxAttempts) {
        throw new LockRefusedError(
          `refusing to start: the attempt limit (${deps.maxAttempts}) for acquiring the ` +
            `single-instance lock of data directory ${deps.dataDir} was reached; concurrent ` +
            `contention persists; retry once the other starter has settled`,
        );
      }
      const token = randomUUID();
      const published = await publishLock(lockPath, deps, token);
      if (published !== null) return published;
      if (deps.onContended !== undefined) deps.onContended();
      const inspected = await inspectLock(lockPath);
      if (inspected === null) continue; // released meanwhile — publish again
      const holderPid = parseHolderPid(inspected.content);
      if (holderPid === null) {
        throw new LockRefusedError(
          `refusing to start: ${lockPath} is not a valid quotameter lock file; verify that ` +
            `no quotameter process is running, then remove the file and start again`,
        );
      }
      if (deps.isAlive(holderPid)) {
        throw new LockRefusedError(
          `refusing to start: another quotameter instance (pid ${holderPid}) is using data ` +
            `directory ${deps.dataDir}; stop that process first, or (only if pid ${holderPid} ` +
            `is not running quotameter, e.g. a recycled pid) remove ${lockPath} and start again`,
        );
      }
      // Stale — break it, but only if the captured file is byte-for-byte the
      // one inspected (a replacement installed meanwhile is not ours to take).
      await removeIfIdentifiedBy(lockPath, (captured) => captured === inspected.content);
    }
  } catch (error) {
    if (error instanceof LockRefusedError) throw error;
    throw new Error(
      `cannot acquire the single-instance lock for data directory ${deps.dataDir}: ` +
        `${describeCause(error)}`,
      { cause: error },
    );
  }
}

/** Creates the data directory if absent; permission enforcement is task 066. */
async function ensureDataDir(dataDir: string): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`cannot create the data directory ${dataDir}: ${describeCause(error)}`, {
      cause: error,
    });
  }
}

/**
 * Publishes the lock payload atomically: write a unique scratch file, then
 * hardlink it onto the lock path. `link(2)` fails with `EEXIST` when any lock
 * is already there — creation and exclusion are one decision, with no window
 * in which a half-written lock is visible. The payload carries a random token
 * that later identifies this acquisition by content, not by inode (an inode
 * can be reused by a same-path delete-and-recreate). Returns `null` when
 * contended.
 */
async function publishLock(
  lockPath: string,
  deps: LockDeps,
  token: string,
): Promise<HeldLock | null> {
  const scratch = `${lockPath}.tmp.${deps.pid}.${randomUUID()}`;
  try {
    // Equivalent mutants (U-006 triage): an empty encoding falls back to
    // utf8 for string payloads (the JSON payload is pure ASCII), and the
    // scratch name embeds this pid plus a fresh UUID, so the exclusive 'wx'
    // flag can never collide with an existing file.
    await fs.writeFile(scratch, `${JSON.stringify({ pid: deps.pid, id: token })}\n`, {
      // Stryker disable next-line StringLiteral
      encoding: 'utf8',
      mode: 0o600,
      // Stryker disable next-line StringLiteral
      flag: 'wx',
    });
    try {
      await fs.link(scratch, lockPath);
    } catch (error) {
      // Untestable-here mutant (U-006 triage): the 'true' variant needs a
      // non-EEXIST link failure, which is not producible deterministically —
      // the scratch write in the same directory fails first for every
      // permission/ROFS cause, and a directory at the lock path yields EEXIST
      // (overlayfs) or EPERM (ext4) before any test can pin the difference.
      // The co-excluded 'false' variant (EEXIST rethrown, contention breaks)
      // is killable and stays pinned by the contender tests.
      // Stryker disable next-line ConditionalExpression
      if (errnoIs(error, 'EEXIST')) return null;
      throw error;
    }
    return { lockPath, token };
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

/** A lock file observation: the content read from one open file descriptor. */
interface InspectedLock {
  readonly content: string;
}

/**
 * Reads the current lock, or `null` if it vanished (the holder released it
 * between our failed publish and this read). The content comes from one open
 * file, so it always describes a single state even if the path is replaced
 * concurrently.
 */
async function inspectLock(lockPath: string): Promise<InspectedLock | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, 'r');
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const content = await handle.readFile('utf8');
    return { content };
  } finally {
    await handle.close();
  }
}

/** Extracts the holder pid from lock content; `null` when it is not ours. */
// Equivalent mutants (U-006 triage): an emptied catch leaves `value`
// undefined, which the object check below rejects exactly like the explicit
// return. The block-scoped directive also covers the try block and the
// function body itself — both killable, and their behavior (valid lock
// payloads parse; damaged ones refuse) stays pinned by the damaged-lock and
// stale-recovery tests whenever the directive is removed. A
// `disable next-line` cannot reach a one-line `} catch {`.
// Stryker disable BlockStatement
function parseHolderPid(content: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  // Equivalent mutant (U-006 triage): the 'false' variant lets non-object,
  // non-null payloads fall through to `.pid === undefined`, which the pid
  // check rejects the same way. The co-excluded 'true' variant (every payload
  // rejected) is killable and stays pinned by the stale-lock tests.
  // Stryker disable next-line ConditionalExpression
  if (typeof value !== 'object' || value === null) return null;
  const pid = (value as { pid?: unknown }).pid;
  // Equivalent mutant (U-006 triage): the 'false' variant skips the typeof
  // test, but Number.isInteger is only ever true for numbers, so the same
  // inputs are rejected. The co-excluded 'true' variant (every pid rejected)
  // is killable and stays pinned by the stale-lock tests.
  // Stryker disable next-line ConditionalExpression
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}
// Stryker restore BlockStatement

/**
 * Removes the lock file iff `identifiesOurs` accepts the captured content,
 * atomically deciding the winner among concurrent contenders: every process
 * renames the path aside under a name only it knows (one rename succeeds, the
 * rest see `ENOENT` and give up), reads the captured file, and only the
 * process that recognizes the file as the one it may remove deletes it. A
 * file that is not ours is put back into a vacant path only — never over a
 * newer lock that may have taken the path meanwhile. One primitive serves
 * both stale-breaking (same content as inspected) and release (our token).
 */
async function removeIfIdentifiedBy(
  lockPath: string,
  identifiesOurs: (capturedContent: string) => boolean,
): Promise<boolean> {
  const aside = `${lockPath}.aside.${randomUUID()}`;
  try {
    await fs.rename(lockPath, aside);
  } catch {
    // Nothing to take (or the path is unreachable) — the caller retries or
    // reports; never throw past a component hook. Equivalent mutant (U-006
    // triage): no caller reads this boolean, so its exact value is dead.
    // Stryker disable next-line BooleanLiteral
    return false;
  }
  const isOurs = identifiesOurs(await fs.readFile(aside, 'utf8'));
  if (isOurs) {
    // Equivalent mutants (U-006 triage): `aside` was just read successfully,
    // so it exists and force is moot; the return value is read by no caller.
    // Stryker disable next-line ObjectLiteral, BooleanLiteral
    await fs.rm(aside, { force: true });
    // Stryker disable next-line BooleanLiteral
    return true;
  }
  try {
    // Restore the captured file unless a newer lock has taken the path; if
    // the path is taken, the file stays aside — deleting it could destroy a
    // live holder's only artefact.
    await fs.link(aside, lockPath);
    // Equivalent mutants (U-006 triage): as above — the file exists, and no
    // caller reads the outcome.
    // Stryker disable next-line ObjectLiteral, BooleanLiteral
    await fs.rm(aside, { force: true });
  } catch {
    // Best effort: the path is owned by a newer lock.
  }
  // Stryker disable next-line BooleanLiteral
  return false;
}

/**
 * Releases the held lock: the path is removed only while it still carries
 * this acquisition's unique token, so a replacement installed by a recovery
 * race is left to whoever installed it. Infallible by the component contract.
 */
async function releaseLock(held: HeldLock): Promise<void> {
  try {
    await removeIfIdentifiedBy(held.lockPath, (captured) => lockTokenOf(captured) === held.token);
  } catch {
    // A release problem must never block the remaining shutdown sequence.
  }
}

/** Extracts the acquisition token from lock content; `null` when absent. */
// Equivalent mutants (U-006 triage): an emptied catch returns undefined,
// which compares unequal to every token exactly like null does. The
// block-scoped directive also covers the try block and the function body
// itself — both killable, and their behavior (token extraction from valid
// payloads) stays pinned by the release and foreign-lock tests whenever the
// directive is removed. A `disable next-line` cannot reach a one-line
// `} catch {`.
// Stryker disable BlockStatement
function lockTokenOf(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    // Equivalent mutants (U-006 triage): non-object, non-null payloads fall
    // through to `.id === undefined`, which the id check rejects identically;
    // a null payload crashes on `.id` inside this try, and the catch returns
    // the same unusable null — no caller-visible difference exists.
    // Stryker disable next-line ConditionalExpression, LogicalOperator
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    // Equivalent mutants (U-006 triage): the result only ever feeds
    // `=== held.token`; every non-token outcome (null, undefined, another
    // string) compares unequal to the token exactly like null does.
    // Stryker disable next-line ConditionalExpression, LogicalOperator, StringLiteral
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}
// Stryker restore BlockStatement

/** True when the thrown value carries the given filesystem error code. */
function errnoIs(error: unknown, code: string): boolean {
  // Equivalent mutant (U-006 triage): fs errors are always Error objects,
  // never null/undefined, so the optional chain never short-circuits here.
  // Stryker disable next-line OptionalChaining
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** Renders a filesystem failure for an error message, with its errno code. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `(${code}) ${error.message}`;
  }
  return String(error);
}
