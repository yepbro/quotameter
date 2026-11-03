/**
 * The `quotameter passwd` command handler (task 144, spec §5.2/§15.2/§6.3;
 * decision D-118).
 *
 * §5.2: "`quotameter passwd` — Set or change the web password"; §15.2 adds
 * the rules this handler enforces: minimum length 12, a scrypt hash with a
 * random salt stored **only** as `auth.passwordHash` in the `0600`
 * configuration file, and revocation of every stored session when the
 * password changes. The handler is composed from landed layers — the
 * D-101 detection/staleness layer (`init-persist.ts`), the D-022 settings
 * boundary (`validateSettings` re-validates the merged configuration), the
 * §6.3 permission/atomic-write path, the D-105 owner resolution with the
 * D-108 owner-scoped directories, the D-112 lock read for the reload
 * advisory, and the repository's `deleteAllSessions` for the revocation.
 *
 * **Never a value on the terminal** (§15.2, §15.4): both questions go
 * through the prompter's muted `askSecret`, and no stdout/stderr line —
 * complaint, guidance, or report — ever contains the typed password. What
 * the file receives is the encoded hash of `src/services/password-hash.ts`;
 * the raw password exists only in process memory between the prompt and
 * the hashing call.
 *
 * **Fail-secure ordering**: the stale-detection guard runs, then sessions
 * are revoked, and only then is the configuration written. The reverse
 * order would leave old sessions valid under a password the user believes
 * changed; this order's worst case — the write fails after a successful
 * revocation — leaves the password unchanged and everyone logged out,
 * which the report states exactly.
 *
 * Exit codes: 0 exactly when a valid password pair was entered, the
 * sessions were revoked (or none existed), and the configuration was
 * written; every other
 * outcome — owner problems, a privileged invocation (below), unusable
 * directories, a missing or invalid configuration, cancelled input,
 * exhausted attempts, a drift alarm from the boundary, a failed hash, a
 * failed revocation, or a failed write — exits 1 with the failure on
 * stderr and actionable steps on stdout. The handler never throws.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Validated } from '../schemas/boundary';
import type { Config } from '../schemas/config';
import { configFilePath, type CanonicalConfig } from '../config/load';
import type { PathEnv } from '../config/paths';
import {
  MIN_PASSWORD_LENGTH,
  validateSettings,
  type SettingsValidationResult,
} from '../services/config-validation';
import { hashPassword } from '../services/password-hash';
import { isProcessAlive, lockFilePath } from '../server/single-instance';
import type { CliContext, CliHandler } from './commands';
import {
  readExistingConfig,
  sameDetectionState,
  writeInitConfig,
  type ExistingConfig,
  type PersistInitConfig,
} from './init-persist';
import { createReadlinePrompter, type PromptHandle } from './prompts';
import type { ServiceOwnerResolution } from './service-owner';
import { ownerUnitDirectories, resolveOwnerForCommand } from './service-install';
import { readServiceLock, type ServiceLockRead } from './service-reload';
import { failureLine, thrownMessage } from './service-setup';

/* ── The prompt flow (spec §15.2 minimum, §5.2 set-or-change) ──────────── */

/** How many times the password/confirmation pair may be asked (passwd(1) style). */
const MAX_PASSWORD_ATTEMPTS = 3;

/** The question pair; the §15.2 minimum travels with the first prompt. */
export const NEW_PASSWORD_PROMPT = `New password (at least ${MIN_PASSWORD_LENGTH} characters): `;
export const CONFIRM_PASSWORD_PROMPT = 'Confirm password: ';

/** How {@link askNewPassword} may be tailored by a caller (init, U-042). */
export interface AskPasswordOptions {
  /**
   * The first question's text, overriding {@link NEW_PASSWORD_PROMPT}. The
   * caller owns its wording (init names the skip/require consequence of the
   * bind host, §5.3 step 4); the confirmation always keeps the shared
   * {@link CONFIRM_PASSWORD_PROMPT}.
   */
  readonly prompt?: string;
  /**
   * When true, an exactly-empty first answer is a deliberate skip instead
   * of the length complaint — init's password is optional on a loopback
   * bind (§15.1 default), so Enter must be able to mean "none". Any other
   * answer flows through the shared checks unchanged (a whitespace-only
   * answer is simply too short; secrets are never trimmed).
   */
  readonly skippable?: boolean;
}

/** How the prompt flow ended. */
export type PasswordPromptOutcome =
  /** A validated, confirmed password. */
  | { readonly state: 'provided'; readonly password: string }
  /** An exactly-empty first answer in {@link AskPasswordOptions.skippable} mode. */
  | { readonly state: 'skipped' }
  /** The input ended (EOF) before the pair was complete. */
  | { readonly state: 'closed' }
  /** The user interrupted (Ctrl-C). */
  | { readonly state: 'interrupted' }
  /** Every attempt was rejected — no usable password was confirmed. */
  | { readonly state: 'aborted' };

/**
 * The outcome a caller that passes no {@link AskPasswordOptions} can see —
 * the `skipped` state is exclusive to `skippable` mode, so the no-options
 * overload narrows it away and `passwd`'s outcome handling stays
 * type-exhaustive over exactly its own states (review round P3).
 */
export type RequiredPasswordOutcome = Exclude<PasswordPromptOutcome, { readonly state: 'skipped' }>;

/**
 * Asks for the new password twice and validates what arrived. A blank or
 * too-short first answer and a mismatching confirmation each draw one
 * secret-free stderr complaint and restart the pair, up to
 * {@link MAX_PASSWORD_ATTEMPTS} times; closed input or an interrupt ends
 * the flow without a password. The complaint for a blank answer is the
 * length complaint: zero characters is the shortest way to fail the §15.2
 * minimum, and a distinct wording would add a branch without adding
 * information.
 *
 * The overloads keep the two call shapes honest: without options the
 * `skipped` state is impossible and the result type says so
 * ({@link RequiredPasswordOutcome}); with options (init's §5.3 step-4 leg,
 * U-042/D-141) every state is reachable.
 */
export async function askNewPassword(
  errorPrefix: string,
  output: CliContext['output'],
  prompter: PromptHandle,
): Promise<RequiredPasswordOutcome>;
export async function askNewPassword(
  errorPrefix: string,
  output: CliContext['output'],
  prompter: PromptHandle,
  options: AskPasswordOptions,
): Promise<PasswordPromptOutcome>;
export async function askNewPassword(
  errorPrefix: string,
  output: CliContext['output'],
  prompter: PromptHandle,
  options: AskPasswordOptions = {},
): Promise<PasswordPromptOutcome> {
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
    // The answer is `raw` until it validates — the init-questions naming
    // convention for prompt answers.
    const raw = await prompter.askSecret(options.prompt ?? NEW_PASSWORD_PROMPT);
    if (raw === null) {
      return prompter.interrupted() ? { state: 'interrupted' } : { state: 'closed' };
    }
    // The skip is the exactly-empty line only (U-042): a blank-but-not-empty
    // answer stays an answer and fails the length check below like any
    // other too-short one.
    if (options.skippable === true && raw === '') {
      return { state: 'skipped' };
    }
    // Raw length, never a trimmed one — secrets are never trimmed (D-022).
    if (raw.length < MIN_PASSWORD_LENGTH) {
      output.err(
        `${errorPrefix}: the password must be at least ${MIN_PASSWORD_LENGTH} characters long — try again`,
      );
      continue;
    }
    const confirmation = await prompter.askSecret(CONFIRM_PASSWORD_PROMPT);
    if (confirmation === null) {
      return prompter.interrupted() ? { state: 'interrupted' } : { state: 'closed' };
    }
    if (!sameSecretValue(raw, confirmation)) {
      output.err(`${errorPrefix}: the passwords do not match — try again`);
      continue;
    }
    return { state: 'provided', password: raw };
  }
  return { state: 'aborted' };
}

/**
 * Whether the confirmation repeats the password, compared
 * constant-time. Strictly, this is a same-process check of two fresh
 * user inputs — not a secret-verification oracle §15.2's constant-time
 * clause is about — but the comparison gets the same discipline for
 * free, and the length guard keeps `timingSafeEqual`'s equal-length
 * precondition honest (a length mismatch is a mismatch).
 */
function sameSecretValue(password: string, confirmation: string): boolean {
  const first = Buffer.from(password, 'utf8');
  const second = Buffer.from(confirmation, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

/* ── Session revocation (spec §15.2 "changing the password revokes all") ─ */

/** What revoking the data directory's sessions established. */
export type SessionRevocation =
  /** Every stored session row was deleted; `count` is how many. */
  | { readonly state: 'revoked'; readonly count: number }
  /** No database file — nothing was ever stored, nothing to revoke. */
  | { readonly state: 'none' }
  /** The database exists but could not be opened or written. */
  | { readonly state: 'failed'; readonly detail: string };

/**
 * The on-disk database name inside a data directory — storage's
 * `DATABASE_FILENAME` contract, restated (as task 142 did) so the
 * existence probe runs **before** any storage module loads:
 * `node:sqlite`'s ExperimentalWarning then belongs to invocations that
 * actually open a database. The duplication is pinned behaviorally by the
 * integration suite, which revokes in a database created through the
 * landed connection module.
 */
const DATABASE_FILENAME = 'quotameter.sqlite';

/**
 * Deletes every session of the database in `dataDir` — §15.2's revocation,
 * through the repository's own `deleteAllSessions`. The existence probe is
 * a `stat` that classifies **only `ENOENT`** as absence: every other probe
 * failure (an unsearchable data directory, an I/O error) is the `failed`
 * state, because this probe decides whether a §15.2 security control runs
 * — an unreadable directory must fail the command, never read as "no
 * sessions" while sessions stay valid behind the error (review round P2;
 * the D-114 status probe may treat the same states as absence because it
 * is diagnostic, not gating). A data directory without a database file
 * reads as `none` (no service ever opened it, so no session exists); the
 * open/delete failures beyond the probe become `failed` with the error
 * message, which the handler renders exactly like the sibling handlers
 * render their seam failures.
 */
export async function revokeAllSessions(dataDir: string): Promise<SessionRevocation> {
  try {
    statSync(join(dataDir, DATABASE_FILENAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'none' };
    }
    return { state: 'failed', detail: thrownMessage(error) };
  }
  try {
    const { openStorageConnection } = await import('../storage/connection');
    const { createQuotaRepository } = await import('../storage/repository');
    const connection = openStorageConnection({ dataDir });
    try {
      const count = createQuotaRepository({ database: connection.database }).deleteAllSessions();
      return { state: 'revoked', count };
    } finally {
      connection.close();
    }
  } catch (error) {
    return { state: 'failed', detail: thrownMessage(error) };
  }
}

/* ── Outcome renderers ─────────────────────────────────────────────────── */

/** The no-configuration refusal: the password lives in the configuration. */
export function renderNoConfigSteps(): string {
  return [
    'The password is stored in the configuration file, so initialize first:',
    '  quotameter init',
  ].join('\n');
}

/** The privileged-invocation refusal: the file must stay owner-owned. */
export function renderPrivilegedSteps(ownerName: string): string {
  return [
    "The configuration file must stay owned by the service owner's account — a privileged write would leave it root-owned and unusable.",
    `Run the command from ${ownerName}'s regular account:`,
    '  quotameter passwd',
  ].join('\n');
}

/** The success report; `changed` distinguishes set from change (§5.2). */
export function renderSuccessReport(options: {
  readonly changed: boolean;
  readonly configFile: string;
  readonly revocation: SessionRevocation;
}): string {
  const lines = [
    options.changed ? 'Web password changed.' : 'Web password set.',
    `Only the scrypt hash is stored — in ${options.configFile}.`,
  ];
  // An empty sessions table and no database at all are the same user-facing
  // state (review round P3): nothing to revoke is stated as such, never as
  // "0 sessions revoked". The revoked line states the fact only — which
  // password a re-login needs is the reload advisory's nuance, printed
  // separately when a running service still holds the old one.
  if (options.revocation.state === 'revoked' && options.revocation.count > 0) {
    const noun = options.revocation.count === 1 ? 'session' : 'sessions';
    const verb = options.revocation.count === 1 ? 'was' : 'were';
    lines.push(`All ${options.revocation.count} stored ${noun} ${verb} revoked.`);
  } else {
    lines.push('No stored sessions to revoke.');
  }
  return lines.join('\n');
}

/**
 * The §6.4 advisory for a running service: `auth.passwordHash` is a
 * live-on-reload field (D-026 — one of the two settings §6.4's own list
 * does not name), so a running instance keeps authenticating with the old
 * password until it reloads (or restarts).
 */
export function renderReloadAdvisory(pid: number): string {
  return [
    `A running service (pid ${pid}) keeps the old password until it reloads — apply the change with:`,
    '  quotameter reload',
  ].join('\n');
}

/* ── The handler ───────────────────────────────────────────────────────── */

/** Injectable collaborators; every one has a production default. */
export interface PasswdDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /**
   * The environment the owner-scoped §6.1 directories resolve from;
   * production `process.env`. `HOME` is forced to the owner's home inside
   * the directory resolution (a privileged run must resolve the owner's
   * paths, never root's — and this handler refuses those runs anyway).
   */
  readonly pathEnv?: PathEnv;
  /** Builds the prompter; production uses the process terminal streams. */
  readonly createPrompter?: () => PromptHandle;
  /** Existing-configuration detection; production reads the resolved file. */
  readonly readExisting?: (targetPath: string) => Promise<ExistingConfig>;
  /** The §15.2 hashing; production `hashPassword`. */
  readonly hash?: (password: string) => Promise<string>;
  /** The D-022 settings boundary; production `validateSettings`. */
  readonly validate?: (submission: unknown, base?: Validated<Config>) => SettingsValidationResult;
  /** The §15.2 revocation; production {@link revokeAllSessions}. */
  readonly revokeSessions?: (dataDir: string) => Promise<SessionRevocation>;
  /** The consented write; production enforces permissions, then writes. */
  readonly persistConfig?: PersistInitConfig;
  /** Reads the single-instance lock; production `readServiceLock`. */
  readonly readLock?: (lockPath: string) => Promise<ServiceLockRead>;
  /** Liveness probe for a lock's holder pid; production `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Builds the §5.2 `quotameter passwd` handler (task 144, D-118). Resolves
 * the owner and the owner-scoped configuration/data directories, detects
 * the existing configuration, asks for the new password twice through the
 * muted seam, hashes it, revokes every stored session, and writes the
 * hash into the configuration atomically. Never throws; returns the
 * process exit code.
 */
export function runPasswdCommand(deps: PasswdDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }
    // A privileged run would rewrite the owner's configuration as root:
    // the atomic write replaces the inode, leaving the file root-owned
    // `0600` — unusable for the regular account §5.1 requires the service
    // to run as. The password needs no privileges, so the regular account
    // is the right place (D-105's vocabulary has no privileged variant of
    // "write the owner's configuration").
    if (owner.privileges === 'held') {
      ctx.output.err(
        `${errorPrefix}: this command writes ${owner.user.name}'s configuration file and must run from the regular account, not under sudo`,
      );
      ctx.output.out(renderPrivilegedSteps(owner.user.name));
      return 1;
    }
    const env = deps.pathEnv ?? process.env;
    let directories: { readonly configDir: string; readonly dataDir: string };
    try {
      directories = ownerUnitDirectories(owner.user, env);
    } catch (error) {
      ctx.output.err(
        failureLine(errorPrefix, 'resolving the service directories failed', thrownMessage(error)),
      );
      return 1;
    }

    const configFile = configFilePath(directories.configDir);
    const readExisting = deps.readExisting ?? readExistingConfig;
    const existing = await readExisting(configFile);
    if (existing.state === 'none') {
      ctx.output.err(
        `${errorPrefix}: there is no configuration file at ${configFile} — nothing to store the password in`,
      );
      ctx.output.out(renderNoConfigSteps());
      return 1;
    }
    if (existing.state === 'invalid') {
      ctx.output.err(
        `${errorPrefix}: an existing configuration was found at ${configFile} ` +
          'but it is invalid — nothing was changed:',
      );
      for (const problem of existing.problems) {
        ctx.output.err(`${errorPrefix}:   ${problem}`);
      }
      ctx.output.err(`${errorPrefix}: fix or remove the file, then run passwd again.`);
      return 1;
    }

    const prompter = deps.createPrompter?.() ?? defaultPrompter();
    let outcome: PasswordPromptOutcome;
    try {
      outcome = await askNewPassword(errorPrefix, ctx.output, prompter);
    } finally {
      prompter.close();
    }
    if (outcome.state !== 'provided') {
      const reason =
        outcome.state === 'closed'
          ? 'input closed before the password was confirmed'
          : outcome.state === 'interrupted'
            ? 'interrupted'
            : 'too many unsuccessful attempts';
      ctx.output.err(`${errorPrefix}: ${reason} — password change cancelled`);
      return 1;
    }

    let hash: string;
    try {
      hash = await (deps.hash ?? hashPassword)(outcome.password);
    } catch (error) {
      ctx.output.err(failureLine(errorPrefix, 'hashing the password failed', thrownMessage(error)));
      return 1;
    }

    // The submission carries only the hash — the D-022 boundary re-runs
    // the merge and the parser over the merged result, so what gets
    // written is a canonical configuration the loader will accept. The
    // `pendingPassword` variant cannot occur: no plaintext password is
    // submitted. The cast states D-018's canonical invariant.
    const assembled = (deps.validate ?? validateSettings)(
      { auth: { passwordHash: hash } },
      existing.config as Validated<Config>,
    );
    if (!assembled.ok) {
      // A drift alarm (the boundary rejecting a hash this module just
      // produced), not a user error — reported loudly, nothing written.
      for (const problem of assembled.problems) {
        ctx.output.err(`${errorPrefix}: ${problem}`);
      }
      return 1;
    }
    const nextConfig = assembled.config as CanonicalConfig;

    // Stale-detection guard (D-101's device, shared with init): the file
    // is re-read immediately before any effect — a configuration changed
    // after this run's read is never overwritten, and no session is
    // revoked for a change that will not happen.
    const nowExisting = await readExisting(configFile);
    if (!sameDetectionState(existing, nowExisting)) {
      ctx.output.err(
        `${errorPrefix}: the configuration changed while the password was being entered — ` +
          'nothing was written and no session was revoked. Run passwd again.',
      );
      return 1;
    }

    // Fail-secure order: revoke first (§15.2), write second. A failed
    // revocation aborts with the password unchanged; the reverse failure
    // (revoked, then an unwritable configuration) is reported exactly.
    const revocation = await (deps.revokeSessions ?? revokeAllSessions)(directories.dataDir);
    if (revocation.state === 'failed') {
      ctx.output.err(failureLine(errorPrefix, 'revoking the sessions failed', revocation.detail));
      ctx.output.out(
        'The password was not changed — the configuration file was left untouched. Fix the database problem, then run passwd again.',
      );
      return 1;
    }

    try {
      await (deps.persistConfig ?? writeInitConfig)({
        configDir: directories.configDir,
        configFile,
        config: nextConfig,
      });
    } catch (error) {
      ctx.output.err(
        failureLine(errorPrefix, 'writing the configuration failed', thrownMessage(error)),
      );
      ctx.output.out(
        revocation.state === 'revoked'
          ? `The password was not changed, but ${revocation.count} stored ${revocation.count === 1 ? 'session' : 'sessions'} had already been revoked — the next sign-in still needs the current password. Run passwd again to change it.`
          : 'The password was not changed — the configuration file was left untouched. Run passwd again.',
      );
      return 1;
    }

    ctx.output.out(
      renderSuccessReport({
        changed: existing.config.auth.passwordHash !== undefined,
        configFile,
        revocation,
      }),
    );

    // Advisory only: a live lock holder is a running service that still
    // authenticates with the old password until it reloads
    // (`auth.passwordHash` is live-on-reload by D-026's classification —
    // one of the two settings §6.4's own list does not name). Every other
    // lock state — absent, stale, unreadable, invalid — changes nothing
    // about the completed write, so none of them fails or decorates the
    // command.
    const lock = await (deps.readLock ?? readServiceLock)(lockFilePath(directories.dataDir));
    if (lock.state === 'held' && (deps.isAlive ?? isProcessAlive)(lock.pid)) {
      ctx.output.out(renderReloadAdvisory(lock.pid));
    }
    return 0;
  };
}

/** The production prompter: the process terminal streams. */
function defaultPrompter(): PromptHandle {
  return createReadlinePrompter(process.stdin, process.stdout);
}
