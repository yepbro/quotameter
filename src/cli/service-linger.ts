/**
 * The user-service linger detection and guidance layer (task 138, spec
 * §5.3 step 7's user-unit bullet, decision D-107).
 *
 * §5.3 step 7: without sudo a user unit is installed and enabled, and "if
 * linger is disabled, print the exact `sudo loginctl enable-linger <user>`
 * command and explain why it is needed for operation after logout/reboot."
 * Task 137 printed that note unconditionally (its documented minimum,
 * D-106); this module supplies the **detection** that makes it
 * state-driven, and renders the guidance per detected state.
 *
 * **Detection reads the persistent linger flag file** (D-107):
 * `/var/lib/systemd/linger/<name>` is where `loginctl enable-linger`
 * records the state and where logind reads it back — the `Linger`
 * D-Bus property of a user object ("shows whether lingering is enabled
 * for this user", org.freedesktop.login1(5) — the property
 * `loginctl show-user --property=Linger` prints) is exactly this file's
 * presence. That is the same idiom the §5.3 step 1 capability probe uses
 * for machine facts (`/run/systemd/system`): consult the well-known path
 * systemd itself maintains instead of spawning a systemd tool — no
 * subprocess, no stdout parsing, no loginctl-in-PATH dependency, and no
 * version-dependent `show-user` behavior for never-logged-in users.
 *
 * **The state is tri-state and fails safe.** A stat error other than
 * `ENOENT` (an unreadable `/var/lib/systemd` on a hardened machine, say)
 * is `unknown`, and unknown is never treated as enabled: the guidance
 * then prints the enable-linger command exactly as for `disabled`, led
 * by a sentence saying the status could not be determined. Advising
 * `sudo loginctl enable-linger <owner>` when linger is already on is an
 * idempotent no-op; withholding the advice when linger is off would
 * silently stop the service at the owner's logout — the exact §5.3
 * consequence the guidance exists to prevent.
 *
 * The owner's name is interpolated into the flag path only after the
 * step's POSIX-grammar guard (`unsafeOwnerNameProblem`, task 137) has
 * passed; this module documents that precondition instead of re-checking
 * it (the project rule against defensively unreachable branches).
 *
 * Everything is injectable. The development container and CI images ship
 * no systemd, so their `/var/lib/systemd/linger` does not exist —
 * `ENOENT` classifies as `disabled`, deterministically — and tests
 * additionally drive the production stat classifier against real temp
 * directories.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The directory logind keeps per-user linger flag files in: the on-disk
 * state `loginctl enable-linger`/`disable-linger` write and logind's
 * `Linger` property reads ("the user linger state is persistently stored
 * on disk", org.freedesktop.login1(5)).
 */
export const LINGER_FLAG_DIR = '/var/lib/systemd/linger';

/** What one look at the owner's linger flag file established (D-107). */
export type LingerFlagPresence = 'present' | 'absent' | 'stat-error';

/** The §5.3 linger state of the service owner's account. */
export type LingerState = 'enabled' | 'disabled' | 'unknown';

/**
 * The linger probe the service-setup step consults; production is
 * {@link probeUserLinger}. Takes the owner's account name (already past
 * the step's POSIX-grammar guard at every call site).
 */
export type UserLingerProbe = (ownerName: string) => LingerState;

/**
 * The production flag-file classifier: one `statSync` with the errno
 * tri-state — success is `present`, `ENOENT` is the definite no-flag-file
 * answer (a missing flag directory included: no user has a flag then),
 * and any other error (`EACCES` on a hardened path, `EIO`, …)
 * establishes nothing.
 */
export function statLingerFlagPresence(path: string): LingerFlagPresence {
  try {
    statSync(path);
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'stat-error';
  }
}

/** Injectable collaborators of {@link probeUserLinger}. */
export interface LingerSeams {
  /** The flag-file classifier; production {@link statLingerFlagPresence}. */
  readonly presence?: (path: string) => LingerFlagPresence;
}

/**
 * Probes the owner's linger state (spec §5.3 step 7, decision D-107):
 * the flag file under {@link LINGER_FLAG_DIR} decides, and only a
 * non-`ENOENT` stat failure degrades to `unknown`. Never throws — the
 * production classifier turns every stat error into a presence.
 */
export function probeUserLinger(ownerName: string, seams: LingerSeams = {}): LingerState {
  const presence = (seams.presence ?? statLingerFlagPresence)(join(LINGER_FLAG_DIR, ownerName));
  if (presence === 'present') return 'enabled';
  if (presence === 'absent') return 'disabled';
  return 'unknown';
}

/**
 * Renders the §5.3 linger guidance for the detected state. `disabled` is
 * task 137's sentence verbatim — the exact `sudo loginctl enable-linger
 * <owner>` command with the logout/reboot consequence; `unknown` prepends
 * an honesty lead and prints the same command (never silently treated as
 * enabled); `enabled` confirms the consequence and prints no command.
 */
export function renderLingerGuidance(ownerName: string, state: LingerState): string {
  if (state === 'enabled') {
    return (
      `Linger is already enabled for ${ownerName} — ` +
      'the user service keeps running after logout and reboot.'
    );
  }
  const lead =
    state === 'unknown'
      ? `The linger status for ${ownerName} could not be determined, so it is treated as disabled. `
      : '';
  return (
    `${lead}User services stop when their owner logs out. ` +
    'To keep the service running after logout or reboot, run:\n' +
    `  sudo loginctl enable-linger ${ownerName}`
  );
}
