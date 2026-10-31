/**
 * Single-instance protection (task 074, spec §5.6).
 *
 * Prevents a second process from using the same data directory at the same
 * time: the lock file lives inside the data directory, so two instances with
 * different data directories never contend, while two processes on one data
 * directory do (spec §5.6, decision D-017, recovery protocol D-086).
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
 * D-017's rename-aside had a stranding window (D-086): between the rename and
 * the restore, the lock path is vacant, and a third process could publish its
 * own lock into the vacancy — the restore then hit `EEXIST`, the displaced
 * (possibly live) holder stayed stranded in the aside file, and two processes
 * shared the data directory. The recovery protocol now serializes every
 * path-vacating span (break, release) against every path-occupying operation
 * (publication) with a recovery guard — `.quotameter.lock.guard`, acquired by
 * the same atomic hardlink trick: a breaker holds the guard across the whole
 * rename→verify→restore/remove span, and a publisher holds it across its
 * `link(2)` attempt. There is no check-then-act window on either side, so no
 * publisher can interleave into a breaker's vacancy and the restoring link
 * always finds the path vacant. A guard holder that crashed mid-span is
 * detected by its recorded pid: the stale guard is broken (same
 * capture-then-decide primitive, one level down), and once under the guard
 * any capture aside left behind by the crashed span is recovered — restored
 * to the vacant path it was displaced from, so a live holder's lock survives
 * even a crash of the process that was recovering it.
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

/**
 * Recovery guard file name inside the data directory (D-086): serializes
 * path-vacating recovery spans against publications of a new lock.
 */
const GUARD_FILE_NAME = '.quotameter.lock.guard';

/** Capture-aside file prefix: `<lock>.aside.<uuid>` files left mid-recovery. */
const ASIDE_PREFIX = `${LOCK_FILE_NAME}.aside.`;

/** Attempts to outlast contention (concurrent stale-breaking) before giving up. */
const DEFAULT_MAX_ATTEMPTS = 5;

/** Total time one guard acquisition waits out a live guard holder. */
const DEFAULT_GUARD_TIMEOUT_MS = 1000;

/** Delay between guard acquisition attempts while the holder is live. */
const DEFAULT_GUARD_POLL_MS = 5;

/** Absolute path of the lock file guarding `dataDir`. */
export function lockFilePath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILE_NAME);
}

/** Absolute path of the recovery guard file of `dataDir` (D-086). */
export function guardFilePath(dataDir: string): string {
  return path.join(dataDir, GUARD_FILE_NAME);
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
   * Total time one recovery-guard acquisition waits out a live guard holder
   * before giving up (the attempt then counts as contention); defaults to
   * {@link DEFAULT_GUARD_TIMEOUT_MS}.
   */
  readonly guardTimeoutMs?: number;
  /** Delay between guard acquisition attempts; defaults to {@link DEFAULT_GUARD_POLL_MS}. */
  readonly guardPollMs?: number;
  /**
   * Notified whenever an existing lock blocks acquisition, before it is
   * inspected. Diagnostic seam for the future structured logger (task 072)
   * and for tests that simulate concurrent holders.
   */
  readonly onContended?: () => void;
  /**
   * Notified with the captured content while a break or release holds the
   * recovery guard, before the captured file is removed or restored.
   * Diagnostic seam for the future structured logger (task 072) and for
   * tests that pause the recovery at the captured-file decision point.
   */
  readonly onCaptured?: (capturedContent: string) => void | Promise<void>;
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
  readonly guardTimeoutMs: number;
  readonly guardPollMs: number;
  readonly onContended?: () => void;
  readonly onCaptured?: (capturedContent: string) => void | Promise<void>;
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
    guardTimeoutMs: options.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS,
    guardPollMs: options.guardPollMs ?? DEFAULT_GUARD_POLL_MS,
    onContended: options.onContended,
    onCaptured: options.onCaptured,
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
      await releaseLock(deps, current);
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
      await removeIfIdentifiedBy(lockPath, (captured) => captured === inspected.content, deps);
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
 * can be reused by a same-path delete-and-recreate). The link runs under the
 * recovery guard (D-086), so it can never land in the vacancy a concurrent
 * breaker is holding a captured file aside for. Returns `null` when
 * contended — including when the guard never freed up in time, which the
 * bounded attempt loop turns into the contention refusal.
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
    const linked = await withGuard(deps, async () => {
      await recoverOrphanAsides(lockPath);
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
        if (errnoIs(error, 'EEXIST')) return false;
        throw error;
      }
      return true;
    });
    return linked === true ? { lockPath, token } : null;
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

/** A lock file observation: the content read from one open file descriptor. */
interface InspectedLock {
  readonly content: string;
}

/**
 * Reads the current lock or guard file, or `null` if it vanished (the holder
 * released it between our failed publish and this read). The content comes
 * from one open file, so it always describes a single state even if the path
 * is replaced concurrently.
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

/** Resolves after `ms` milliseconds — the guard wait's poll delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Publishes the guard payload atomically (the same scratch+`link(2)` trick as
 * the lock): `EEXIST` means a live-or-stale guard is in the way. Returns
 * `false` when contended.
 */
async function publishGuard(guardPath: string, deps: LockDeps): Promise<boolean> {
  const scratch = `${guardPath}.tmp.${deps.pid}.${randomUUID()}`;
  try {
    await fs.writeFile(scratch, `${JSON.stringify({ pid: deps.pid, id: randomUUID() })}\n`, {
      // Stryker disable next-line StringLiteral
      encoding: 'utf8',
      mode: 0o600,
      // Stryker disable next-line StringLiteral
      flag: 'wx',
    });
    try {
      await fs.link(scratch, guardPath);
    } catch (error) {
      // Same shape as the publish contention branch: only EEXIST means
      // "someone holds the guard"; every other failure is a filesystem
      // failure and propagates to be wrapped with the data-directory context.
      // Stryker disable next-line ConditionalExpression
      if (errnoIs(error, 'EEXIST')) return false;
      throw error;
    }
    return true;
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

/**
 * Acquires the recovery guard (D-086): one atomic hardlink, retried while a
 * live holder keeps it. A guard whose recorded pid is no longer alive belongs
 * to a process that crashed inside its recovery span — it is broken with the
 * same capture-then-decide primitive applied to the guard path (no guard one
 * level down; the recursion ends here). Payload that does not parse is
 * breakable too: guard publication is atomic, so damaged content can never be
 * a guard this protocol wrote. Returns `null` when the bounded wait ran out.
 */
async function acquireGuard(deps: LockDeps): Promise<true | null> {
  const guardPath = guardFilePath(deps.dataDir);
  const deadline = Date.now() + deps.guardTimeoutMs;
  for (;;) {
    if (await publishGuard(guardPath, deps)) return true;
    if (Date.now() >= deadline) return null;
    const inspected = await inspectLock(guardPath);
    if (inspected === null) {
      // The holder released between our failed publish and this read — race
      // for the now-vacant guard path, without hot-spinning on it.
      await sleep(deps.guardPollMs);
      continue;
    }
    const holderPid = parseHolderPid(inspected.content);
    if (holderPid !== null && deps.isAlive(holderPid)) {
      await sleep(deps.guardPollMs);
      continue;
    }
    // The onCaptured seam stays lock-only (its contract says "while a break
    // or release holds the recovery guard"): a guard-path capture happens
    // before this process holds anything.
    await captureAndDecide(guardPath, (captured) => {
      const pid = parseHolderPid(captured);
      return pid === null || !deps.isAlive(pid);
    });
  }
}

/**
 * Runs `critical` while holding the recovery guard (D-086): the only
 * operations that may vacate the lock path (break, release) and the only
 * operation that may occupy it (publication) all run inside this guard, so a
 * captured file can always be restored into the provably vacant path it was
 * displaced from. Returns `null` when the guard could not be acquired in
 * time — callers treat that as contention or abandon the (best-effort)
 * operation; errors of `critical` propagate unchanged.
 */
async function withGuard<T>(deps: LockDeps, critical: () => Promise<T>): Promise<T | null> {
  if ((await acquireGuard(deps)) === null) return null;
  try {
    return await critical();
  } finally {
    await fs.rm(guardFilePath(deps.dataDir), { force: true });
  }
}

/**
 * Recovers capture-aside files orphaned by a crashed recovery span. Only
 * called with the guard held: no live recovery span can coexist, so any
 * `<lock>.aside.<uuid>` file present was left behind by a process that died
 * between its rename and its decision. Each orphan is restored to the lock
 * path it was displaced from — it may be a live holder's only artefact —
 * unless the path is occupied. An occupied path drops the aside name only
 * when it carries byte-identical content (a restore that crashed between
 * its link and the aside removal — provably the only case while guard
 * mutual exclusion holds); divergent content is possible only through
 * D-086's accepted residual or a protocol violator, and the captured file
 * is then kept aside for a later recovery — never destroyed.
 */
async function recoverOrphanAsides(lockPath: string): Promise<void> {
  const dataDir = path.dirname(lockPath);
  for (const name of await fs.readdir(dataDir)) {
    if (!name.startsWith(ASIDE_PREFIX)) continue;
    const aside = path.join(dataDir, name);
    const asideContent = await fs.readFile(aside, 'utf8');
    let restored = false;
    try {
      await fs.link(aside, lockPath);
      restored = true;
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error;
    }
    if (restored) {
      await fs.rm(aside, { force: true });
      continue;
    }
    const at = await inspectLock(lockPath);
    // An unreadable path (out-of-protocol writer) keeps the aside too.
    if (at !== null && at.content === asideContent) {
      await fs.rm(aside, { force: true });
    }
  }
}

/**
 * Removes the lock file iff `identifiesOurs` accepts the captured content,
 * atomically deciding the winner among concurrent contenders: every process
 * renames the path aside under a name only it knows (one rename succeeds, the
 * rest see `ENOENT` and give up), reads the captured file, and only the
 * process that recognizes the file as the one it may remove deletes it. A
 * file that is not ours is put back into the path — under the recovery guard
 * (D-086) the path is guaranteed vacant at that moment, because no publisher
 * can acquire it mid-span; if it is taken anyway (a protocol violator), the
 * captured file stays aside — deleting it could destroy a live holder's only
 * artefact. One primitive serves both stale-breaking (same content as
 * inspected) and release (our token).
 */
async function removeIfIdentifiedBy(
  lockPath: string,
  identifiesOurs: (capturedContent: string) => boolean,
  deps: LockDeps,
): Promise<boolean> {
  const outcome = await withGuard(deps, async () => {
    await recoverOrphanAsides(lockPath);
    return captureAndDecide(lockPath, identifiesOurs, deps.onCaptured);
  });
  return outcome === true;
}

/**
 * The raw capture-then-decide step shared by the lock protocol (under the
 * recovery guard) and the guard's own stale-break (unguarded — the recursion
 * ends here, see {@link acquireGuard}): rename `targetPath` aside, read the
 * captured file, notify `onCaptured`, then remove the file iff
 * `identifiesRemovable` accepts the captured content, or restore it.
 */
async function captureAndDecide(
  targetPath: string,
  identifiesRemovable: (capturedContent: string) => boolean,
  onCaptured?: (capturedContent: string) => void | Promise<void>,
): Promise<boolean> {
  const aside = `${targetPath}.aside.${randomUUID()}`;
  try {
    await fs.rename(targetPath, aside);
  } catch {
    // Nothing to take (or the path is unreachable) — the caller retries or
    // reports; never throw past a component hook.
    return false;
  }
  const captured = await fs.readFile(aside, 'utf8');
  if (onCaptured !== undefined) await onCaptured(captured);
  if (identifiesRemovable(captured)) {
    await fs.rm(aside, { force: true });
    return true;
  }
  try {
    // Restore the captured file; under the recovery guard the path is
    // provably vacant (D-086). If it is taken anyway, the file stays aside —
    // never destroyed: a later guard holder recovers it, or (one level down,
    // on the guard path) it is accepted crash residue, like D-016's temp
    // files.
    await fs.link(aside, targetPath);
    await fs.rm(aside, { force: true });
  } catch {
    // Best effort: the path is owned by a newer file.
  }
  return false;
}

/**
 * Releases the held lock: the path is removed only while it still carries
 * this acquisition's unique token, so a replacement installed by a recovery
 * race is left to whoever installed it. Infallible by the component contract
 * — when the guard cannot be acquired (a wedged live recovery), the release
 * is abandoned and the lock file stays for the next starter's stale-break.
 */
async function releaseLock(deps: LockDeps, held: HeldLock): Promise<void> {
  try {
    await removeIfIdentifiedBy(
      held.lockPath,
      (captured) => lockTokenOf(captured) === held.token,
      deps,
    );
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
