/**
 * The service-owner and privilege decision layer (task 136, spec §5.3 steps
 * 1 and 7, decision D-105).
 *
 * Spec §5.3 step 1: init checks "whether the process is running as root. If
 * invoked through `sudo`, use `SUDO_USER` to determine the service owner."
 * Step 7 then splits the install paths by privilege: with root privileges
 * (for example `sudo quotameter init`) the system unit is installed with
 * `User=` set to the regular account and privileges are used for exactly
 * those privileged systemd operations; without sudo the user unit under the
 * owner's home is installed as that user. Spec §5.1/§15.6: the service must
 * never run as root — enforced here by construction: **there is no ok
 * outcome whose owner is root**, and a root process without a verifiable
 * `SUDO_USER` resolves to problems, never to a guessed account.
 *
 * This module is the pure decision half of that. It classifies the
 * invocation (regular user, or root reached through sudo), resolves the
 * service owner from the user database, and states which operations may use
 * privileges. It performs no installations and no privileged operations:
 * tasks 137 (fallback paths), 138 (linger guidance), and 139 (service
 * install/uninstall) consume this seam.
 *
 * Everything is injectable — the uid, the environment, and the user
 * database — so tests drive every context without privileges or sudo (the
 * container and CI images run unprivileged and ship no systemd). The only
 * default I/O is the `/etc/passwd` read; an unreadable user database
 * propagates as a thrown error (a broken system, not a diagnosable
 * invocation).
 */

import { readFileSync } from 'node:fs';

/** The user database the production seam reads (passwd(5)). */
export const ETC_PASSWD_PATH = '/etc/passwd';

/**
 * One user-database row, as parsed from `/etc/passwd` (passwd(5)). The
 * fields the service lifecycle needs are the account name (the generated
 * system unit's `User=`, spec §5.3 step 7), the numeric ids (ownership
 * checks), and the home directory (the user unit's and the §6.1 XDG paths'
 * base) — the password, gecos, and shell fields carry nothing this layer
 * uses and are dropped.
 */
export interface PasswdEntry {
  /** Account name. */
  name: string;
  /** Numeric user id; 0 is root. */
  uid: number;
  /** Numeric primary group id. */
  gid: number;
  /** Home directory. */
  home: string;
}

/**
 * Parses a plain-decimal id (uid/gid) that JavaScript can compare exactly.
 *
 * Values above `Number.MAX_SAFE_INTEGER` lose precision (`9007199254740993`
 * rounds to `9007199254740992`, so two *different* strings would compare
 * equal — a precision-collision that could verify a forged sudo id), and
 * long digit strings become `Infinity`; both are rejected as unparseable
 * (review round P2). Used for `/etc/passwd` fields and `SUDO_UID`/
 * `SUDO_GID` alike, so no id enters the layer through two grammars.
 */
function parseDecimalId(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Parses `/etc/passwd` content into {@link PasswdEntry} rows.
 *
 * One entry per line of exactly seven `:`-separated fields
 * (`name:passwd:uid:gid:gecos:home:shell`, passwd(5)) with a non-empty name
 * and plain-decimal uid/gid in the exactly-comparable integer range. Anything
 * else — blank lines, wrong field counts, empty names, non-numeric or unsafe
 * ids — is skipped, not reported: the file is root-owned and not ours to
 * diagnose, and a line that cannot parse can never match a lookup. Lookups
 * elsewhere take the **first** matching row (getpwnam/getpwuid semantics for
 * duplicated names or ids).
 */
export function parsePasswdFile(content: string): readonly PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  for (const line of content.split('\n')) {
    const fields = line.split(':');
    if (fields.length !== 7) continue;
    // The length guard makes the tuple total; the cast states it (the
    // src/cli/systemd-unit.ts ExecStart precedent — no defensive undefined
    // arms). Field 1 (password) and 4 (gecos) are unused.
    const [name, , uidField, gidField, , home] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (name === '') continue;
    const uid = parseDecimalId(uidField);
    const gid = parseDecimalId(gidField);
    if (uid === undefined || gid === undefined) continue;
    entries.push({ name, uid, gid, home });
  }
  return entries;
}

/**
 * The production user-database seam: reads and parses `/etc/passwd`.
 *
 * @throws the underlying filesystem error when the file cannot be read —
 *   a host without a readable user database cannot resolve any service
 *   owner, and that is a broken system rather than a diagnosable
 *   invocation.
 */
export function readEtcPasswd(): readonly PasswdEntry[] {
  return parsePasswdFile(readFileSync(ETC_PASSWD_PATH, 'utf8'));
}

/**
 * The operations for which privileges may be used (spec §5.3 step 7):
 * installing, enabling, starting, stopping, disabling, and removing the
 * **system** unit (writes under `/etc/systemd/system/` and commands against
 * the system service manager), the `daemon-reload` that makes a rewritten
 * system unit visible to it, and `loginctl enable-linger` (§5.3 step 7's
 * sudo-requiring command, task 138). Everything else a service setup
 * touches — creating the configuration/data directories, the provider
 * connection test, installing the user unit under the owner's home,
 * status and journalctl queries — runs as the service owner and must not
 * borrow privileges.
 */
export type PrivilegedSystemdOperation =
  | 'install-system-unit'
  | 'remove-system-unit'
  | 'daemon-reload'
  | 'enable-system-unit'
  | 'disable-system-unit'
  | 'start-system-unit'
  | 'stop-system-unit'
  | 'enable-linger';

/** The frozen vocabulary of {@link PrivilegedSystemdOperation} values. */
export const PRIVILEGED_SYSTEMD_OPERATIONS: readonly PrivilegedSystemdOperation[] = [
  'install-system-unit',
  'remove-system-unit',
  'daemon-reload',
  'enable-system-unit',
  'disable-system-unit',
  'start-system-unit',
  'stop-system-unit',
  'enable-linger',
];

/**
 * True exactly for the privileged systemd operations — the single
 * classification point the install flows (tasks 137/139) consult before
 * routing an operation through the privileged seam; every other operation
 * runs as the service owner.
 */
export function isPrivilegedSystemdOperation(operation: string): boolean {
  return (PRIVILEGED_SYSTEMD_OPERATIONS as readonly string[]).includes(operation);
}

/** How the process reached its current identity. */
export type ServiceOwnerKind =
  /** A regular account running the CLI directly (never root). */
  | 'regular-user'
  /** Root reached through sudo; the owner is the sudo-invoking account. */
  | 'sudo';

/** The environment the sudo variables are read from; production `process.env`. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

/**
 * The resolved invocation context. `privileges: 'held'` means the process
 * itself carries root privileges, so the privileged systemd operations may
 * run in-process as this process (spec §5.3 step 7's `sudo quotameter
 * init` shape); `'none'` means they are not held, and the flow's remaining
 * route for them is §5.3 step 7's "user's consent to invoke sudo only for
 * the privileged operation" (task 137's branch). In ok outcomes
 * `privileges === 'held'` holds exactly when `kind === 'sudo'`.
 */
export interface ServiceOwnerContext {
  readonly kind: ServiceOwnerKind;
  readonly privileges: 'held' | 'none';
  /** The service owner — a regular account, never root (§5.1, §15.6). */
  readonly user: PasswdEntry;
}

/**
 * Result of {@link resolveServiceOwner}: the context, or every problem
 * found in one pass (the `parseUnitFile`/`findConfigProblems` style — a
 * diagnosing caller wants the complete picture, never a throw).
 */
export type ServiceOwnerResolution =
  | { readonly state: 'ok'; readonly context: ServiceOwnerContext }
  | { readonly state: 'problems'; readonly problems: readonly string[] };

/** Injectable collaborators; every one has a production default. */
export interface ServiceOwnerSeams {
  /** Running user id; defaults to `process.getuid` (non-POSIX → undefined). */
  readonly getuid?: () => number | undefined;
  /** The environment `SUDO_USER`/`SUDO_UID`/`SUDO_GID` are read from. */
  readonly env?: EnvSnapshot;
  /** The user database; production reads `/etc/passwd`. */
  readonly passwd?: () => readonly PasswdEntry[];
}

/**
 * Resolves the service owner and the privilege context of this invocation
 * (spec §5.3 steps 1 and 7, decision D-105).
 *
 * - **Regular user** (`uid !== 0`) — the owner is the first user-database
 *   entry with that uid, and the name must resolve back to that same entry
 *   (duplicate account names with different ids make a generated `User=`
 *   ambiguous — systemd takes the first name match, possibly root — so an
 *   ambiguous database is refused). `SUDO_*` is deliberately not consulted:
 *   any user can export those names, so at a non-root uid they are untrusted
 *   leftovers (`sudo -u otheruser` lands here too, with the target account
 *   as the owner). `privileges: 'none'`.
 * - **Root with `SUDO_USER`** — the owner is the account sudo recorded, and
 *   the sudo environment must verify against the user database: the
 *   variable is an own, non-empty property (`Object.hasOwn`, the
 *   init-yes.ts `process.env` precedent — inherited names never count),
 *   names an existing account that is not root (a `SUDO_USER` of `root` is
 *   a sudo chain invoked by root — §5.1 refuses it), and `SUDO_UID`/
 *   `SUDO_GID` are set, numeric, and equal to the account's database uid/
 *   gid. sudo itself guarantees that consistency, so any deviation means
 *   the environment is not a genuine sudo invocation. `privileges: 'held'`.
 * - **Root without a verifiable `SUDO_USER`** — problems, never a guess:
 *   §5.3's only owner-determination mechanism for a root process is
 *   `SUDO_USER`, so the message says how to run instead (sudo from a
 *   regular account, or a regular user's user-level service).
 */
export function resolveServiceOwner(seams: ServiceOwnerSeams = {}): ServiceOwnerResolution {
  const getuid = seams.getuid ?? (() => process.getuid?.());
  const env = seams.env ?? process.env;
  const passwd = seams.passwd ?? readEtcPasswd;

  const uid = getuid();
  if (uid === undefined) {
    return {
      state: 'problems',
      problems: [
        'cannot determine the uid of the running process — the service owner cannot be resolved',
      ],
    };
  }

  if (uid !== 0) {
    const entries = passwd();
    const owner = entries.find((candidate) => candidate.uid === uid);
    if (owner === undefined) {
      return {
        state: 'problems',
        problems: [
          `cannot resolve the service owner: the current user (uid ${uid}) has no entry in the user database`,
        ],
      };
    }
    if (owner.name === 'root') {
      return {
        state: 'problems',
        problems: [
          `the current user (uid ${uid}) is named "root" in the user database — the service must never run as root`,
        ],
      };
    }
    // Name round-trip (review round P0): the system unit carries only the
    // owner's *name* (`User=`, spec §5.4/§5.3 step 7), and systemd resolves
    // that name to the FIRST matching database entry — getpwnam, not this
    // uid lookup. When duplicate names exist, the first-by-name entry can
    // differ from the uid-selected one (another account, or root by an
    // earlier alias), and the generated unit would run as that other
    // account. The name must resolve back to the very entry selected, or
    // the database is ambiguous and ownership is refused. The sudo branch
    // needs no twin check: it selects by name in the first place, so the
    // name resolves back to its own selection by construction.
    const byName = entries.find((candidate) => candidate.name === owner.name);
    if (byName !== owner) {
      return {
        state: 'problems',
        problems: [
          `the user database is ambiguous: account ${JSON.stringify(owner.name)} (uid ${owner.uid}) ` +
            'is listed more than once with different ids, so a generated User= could select the wrong ' +
            'account (possibly root) — fix the duplicate entries in the user database',
        ],
      };
    }
    return { state: 'ok', context: { kind: 'regular-user', privileges: 'none', user: owner } };
  }

  const sudoUser = readOwnEnv(env, 'SUDO_USER');
  if (sudoUser === undefined) {
    return {
      state: 'problems',
      problems: [
        'the process is running as root without SUDO_USER — the service owner cannot be determined; ' +
          'run "sudo quotameter init" from your regular account so sudo identifies the owner, ' +
          'or run "quotameter init" as a regular user to install a user-level service',
      ],
    };
  }
  if (sudoUser === '') {
    return {
      state: 'problems',
      problems: [
        'SUDO_USER is set but empty — the service owner cannot be determined; ' +
          'run "sudo quotameter init" from your regular account',
      ],
    };
  }
  const owner = passwd().find((candidate) => candidate.name === sudoUser);
  if (owner === undefined) {
    return {
      state: 'problems',
      problems: [
        `SUDO_USER names an unknown account: ${JSON.stringify(sudoUser)} — the service owner cannot be resolved`,
      ],
    };
  }
  if (owner.name === 'root' || owner.uid === 0) {
    return {
      state: 'problems',
      problems: [
        'SUDO_USER resolves to root — the service must never run as root; ' +
          'run "sudo quotameter init" from your regular account',
      ],
    };
  }
  const problems = [
    checkSudoId(env, 'SUDO_UID', owner, 'uid'),
    checkSudoId(env, 'SUDO_GID', owner, 'gid'),
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    return { state: 'problems', problems };
  }
  return { state: 'ok', context: { kind: 'sudo', privileges: 'held', user: owner } };
}

/**
 * Reads one environment variable as an own property only (the init-yes.ts
 * `process.env` precedent): a bare bracket read sees inherited
 * `Object.prototype` names, so an inherited `SUDO_USER` would masquerade
 * as a sudo invocation.
 */
function readOwnEnv(env: EnvSnapshot, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

/**
 * Verifies one sudo id variable (`SUDO_UID`/`SUDO_GID`) against the
 * owner's user-database entry: present, plain-decimal in the
 * exactly-comparable integer range, and equal. Returns the problem string
 * when it is not, else null.
 */
function checkSudoId(
  env: EnvSnapshot,
  variable: 'SUDO_UID' | 'SUDO_GID',
  owner: PasswdEntry,
  id: 'uid' | 'gid',
): string | null {
  const value = readOwnEnv(env, variable);
  if (value === undefined) {
    return `${variable} is not set while SUDO_USER is — the sudo environment is incomplete, cannot verify the service owner`;
  }
  const parsed = parseDecimalId(value);
  if (parsed === undefined) {
    return `${variable} is not a valid numeric id: ${JSON.stringify(value)} — cannot verify the service owner`;
  }
  if (parsed !== owner[id]) {
    return (
      `${variable} (${value}) disagrees with the user database (${owner[id]}) ` +
      `for account ${JSON.stringify(owner.name)} — the environment does not look like a genuine sudo invocation`
    );
  }
  return null;
}
