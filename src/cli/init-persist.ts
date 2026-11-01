/**
 * The idempotent-`init` support layer (task 132, spec §5.3, §6.1–§6.3;
 * decision D-101).
 *
 * Spec §5.3: "`init` must be idempotent: on subsequent runs, display current
 * settings and let the user keep or change them." This module owns the three
 * pieces behind that sentence, composed from the landed layers rather than
 * re-derived:
 *
 * - **Detection** ({@link readExistingConfig}): the resolved configuration
 *   file is either absent (a fresh first run — the task 130/131 flows
 *   unchanged), a valid configuration (the idempotent flow), or present but
 *   unusable — and the third state is a hard refusal. Overwriting a file
 *   whose contents cannot be read and validated is never consented to
 *   (§6.2's "refuse to start and explain the problem", applied to the
 *   writer's side); the user must fix or remove the file first.
 * - **Display** ({@link renderExistingSettings}): the current settings with
 *   accounts masked to their secret state — a stored key never appears, and
 *   an environment-sourced key names only its variable (§6.3's write-only
 *   rule, the same vocabulary the fresh-run summary uses).
 * - **Merge and write** ({@link assembleInitConfig}, {@link writeInitConfig}):
 *   the answers are mapped by `buildInitConfig` (task 130's assembly) and
 *   merged over the current configuration by `validateSettings` (task 073's
 *   §5.3 keep-or-change layer: field-wise object merge, canonical result),
 *   then written through the landed permission enforcement (directory
 *   `0700`) and atomic write path (file `0600`, temp file + fsync + rename).
 *
 * §5.3 step 5's database half lands with the storage-consuming init steps
 * (task 133+): this task writes the configuration artifact init is
 * idempotent about, and creating a database nothing in init consumes yet
 * would couple the CLI to the storage composition ahead of its task
 * (decision D-101).
 */

import { readFile } from 'node:fs/promises';
import { parseConfig, parseJson, type CanonicalConfig } from '../config/load';
import { enforceConfigPermissions } from '../config/permissions';
import { jsonEquals } from '../config/reload';
import { writeConfigFile } from '../config/write';
import type { Validated } from '../schemas/boundary';
import type { AccountConfig, Config } from '../schemas/config';
import { isLoopbackHost } from '../schemas/config';
import { validateSettings } from '../services/config-validation';
import { buildInitConfig, type InitAnswers } from './init-questions';

/* ── Detection (spec §6.1 path, §6.2 validation) ───────────────────────── */

/** What looking for an existing configuration at the resolved path found. */
export type ExistingConfig =
  | { readonly state: 'none' }
  | {
      readonly state: 'existing';
      readonly config: CanonicalConfig;
      /**
       * True when the configuration is the one state §15.1 describes as
       * configurable-but-not-startable: remote binding (or `required`
       * mode) without a password hash. Init reads and rewrites that state;
       * the *service* refuses to start on it until `quotameter passwd`
       * completes it (decision D-101).
       */
      readonly passwordPending: boolean;
    }
  | { readonly state: 'invalid'; readonly problems: readonly string[] };

/** Reads configuration file text; injectable so classification is testable. */
export type ConfigTextReader = (targetPath: string) => Promise<string>;

const realReader: ConfigTextReader = (targetPath) => readFile(targetPath, 'utf8');

/**
 * Classifies the configuration file at `targetPath`
 * (`configFilePath(resolveConfigDir(env))` at the call site).
 *
 * The pipeline is the loader's own exported stages — `parseJson` then
 * `parseConfig` — so "existing" means exactly what the service would accept
 * at startup (§6.2), no second validator to drift, with one deliberate
 * tolerance (decision D-101): a file whose only defect is §15.1's missing
 * password counts as existing — the spec's own wording binds *starting*
 * ("If remote binding is configured without a password, refuse to start"),
 * §15.2 names `passwd` as the completer, and refusing would strand a
 * configuration only hand-editing could recover. The tolerance is probed
 * structurally, with a placeholder hash (D-022's technique — never by
 * matching problem wording); any further defect still makes the file
 * invalid. A missing file is the fresh-install state; everything else
 * unusable becomes `invalid` with the stages' own secret-free problem
 * messages (§15.4: nothing read from the file is ever echoed). Within the
 * tolerance, "missing" means absent: a present-but-malformed hash (empty,
 * non-string) or a non-object `auth` section is a defect the probe never
 * masks — such a file stays invalid and is never rewritten (see
 * {@link withPlaceholderHash}).
 */
export async function readExistingConfig(
  targetPath: string,
  readFileText: ConfigTextReader = realReader,
): Promise<ExistingConfig> {
  let text: string;
  try {
    text = await readFileText(targetPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { state: 'none' };
    return {
      state: 'invalid',
      problems: [
        `cannot read the existing configuration file ${targetPath}: ${describeReadError(error)}`,
      ],
    };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return { state: 'invalid', problems: parsed.problems };
  const direct = parseConfig(parsed.value);
  if (direct.ok) {
    // The cast states D-018's invariant: defaults completion materialized
    // every section.
    return { state: 'existing', config: direct.value as CanonicalConfig, passwordPending: false };
  }
  const probed = parseConfig(withPlaceholderHash(parsed.value));
  if (probed.ok) {
    return {
      state: 'existing',
      config: withoutPasswordHash(probed.value as CanonicalConfig),
      passwordPending: true,
    };
  }
  return { state: 'invalid', problems: direct.problems };
}

/**
 * Whether two detections describe the same on-disk state — the predicate of
 * the handler's stale-detection guard (`init.ts` re-reads immediately before
 * writing and refuses when this is false, so a configuration created or
 * changed after the display can never be overwritten by that run; decision
 * D-101). The fresh state compares by tag; an existing configuration
 * compares structurally — the canonical values are what consent was given
 * against, and a reformatted-but-unchanged file (different bytes, same
 * values) is not a change — with `passwordPending` compared alongside
 * (equal configurations yield equal flags by construction, the same probe
 * having decided both); two invalid detections compare by their problems.
 */
export function sameDetectionState(a: ExistingConfig, b: ExistingConfig): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'existing' && b.state === 'existing') {
    return a.passwordPending === b.passwordPending && jsonEquals(a.config, b.config);
  }
  if (a.state === 'invalid' && b.state === 'invalid') {
    return (
      a.problems.length === b.problems.length &&
      a.problems.every((problem, index) => problem === b.problems[index])
    );
  }
  return true;
}

/**
 * A stand-in password hash for the §15.1 tolerance probe — the same device
 * D-022 sanctioned (any non-empty string is hash-shaped for the invariant,
 * which checks presence only). Never persisted: the probe's only consumer
 * strips it again (see {@link withoutPasswordHash}).
 */
const PLACEHOLDER_HASH = '__quotameter-password-probe__';

/** The submission-shaped twin for the write-side probe (§15.2 minimum applies). */
const PLACEHOLDER_PASSWORD = 'quotameter-init-probe';

/**
 * `input` with a placeholder `auth.passwordHash`, the §15.1 probe state.
 * The probe applies **only to the state the tolerance is defined over** — a
 * plain object whose `auth.passwordHash` is absent: a present hash
 * (malformed or not) and a non-object `auth` are passed through untouched,
 * so the probe re-fails and the file classifies as invalid (review finding
 * on the first version, which replaced whatever it found and thereby
 * "repaired" corrupt auth data into the pending state).
 */
function withPlaceholderHash(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  if (input.auth === undefined) {
    return { ...input, auth: { passwordHash: PLACEHOLDER_HASH } };
  }
  if (!isPlainObject(input.auth) || input.auth.passwordHash !== undefined) return input;
  return { ...input, auth: { ...input.auth, passwordHash: PLACEHOLDER_HASH } };
}

/** The probe password added to a submission (§15.2's minimum respected). */
function withProbePassword(submission: unknown): unknown {
  if (!isPlainObject(submission)) return submission;
  return { ...submission, auth: { password: PLACEHOLDER_PASSWORD } };
}

/** The configuration without the probe hash — the state actually persisted. */
function withoutPasswordHash(config: CanonicalConfig): CanonicalConfig {
  return { ...config, auth: { mode: config.auth.mode } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The errno code of a filesystem failure, when it carries one. */
function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** A read-failure reason without ever echoing file content. */
function describeReadError(error: unknown): string {
  const code = errnoCode(error);
  if (code !== undefined) return code;
  return error instanceof Error ? error.message : String(error);
}

/* ── Display (spec §5.3 "display current settings", §6.3 masking) ──────── */

/**
 * The §5.3 step 4 note, shared by every settings block init renders: a
 * non-loopback bind host requires a password before the service starts.
 */
export function passwordRequirementNote(host: string): string | undefined {
  return isLoopbackHost(host)
    ? undefined
    : '  Note: a non-loopback bind host requires a password before the service ' +
        'starts (set one with quotameter passwd).';
}

/**
 * One account of an existing configuration, masked to its secret state: a
 * stored key is "configured, hidden" and an environment-sourced key names
 * only its variable — exactly-one-of-them is a validated invariant
 * (`findConfigProblems`), and neither value ever appears (spec §6.3, §15.4).
 */
export function renderAccountSummary(account: AccountConfig): string {
  const secret =
    account.apiKeyEnv !== undefined
      ? `API key from environment variable '${account.apiKeyEnv}'`
      : 'API key configured, hidden';
  const state = account.enabled === false ? 'disabled, ' : '';
  return `'${account.label}' (${state}${secret})`;
}

/** The Accounts row of a settings block: every account, or the empty state. */
function renderAccountsLine(accounts: readonly AccountConfig[]): string {
  if (accounts.length === 0) return 'none (managed in the web UI)';
  return accounts.map(renderAccountSummary).join('; ');
}

/** The settings rows shared by the display and update blocks. */
function settingsLines(config: CanonicalConfig): string[] {
  const lines = [
    valueLine('Time zone:', config.app.timezone),
    valueLine('Bind host:', config.server.host),
    valueLine('Port:', String(config.server.port)),
    valueLine('Polling interval:', `${config.app.pollingIntervalSeconds} seconds`),
    valueLine('Accounts:', renderAccountsLine(config.accounts)),
  ];
  // The §5.3 step 4 note belongs to the state where the password is still
  // missing — a stored hash satisfies the requirement.
  const note =
    config.auth.passwordHash === undefined
      ? passwordRequirementNote(config.server.host)
      : undefined;
  if (note !== undefined) lines.push(note);
  return lines;
}

/** A column-aligned `  <label><value>` row, the fresh summary's layout. */
function valueLine(label: string, value: string): string {
  return `  ${label.padEnd(19)}${value}`;
}

/**
 * The "current settings" block §5.3 requires on subsequent runs: where the
 * configuration lives and what it says, secrets masked to their state.
 */
export function renderExistingSettings(config: CanonicalConfig, targetPath: string): string {
  return [`Existing configuration found at ${targetPath}:`, ...settingsLines(config)].join('\n');
}

/** The settings block of a re-run that changes something. */
export function renderUpdateSummary(config: CanonicalConfig): string {
  return ['Configuration settings after this run:', ...settingsLines(config)].join('\n');
}

/* ── Merge, change detection, and the consented write ──────────────────── */

/** What {@link assembleInitConfig} yields: the config, or problems. */
export type InitAssembled =
  | { readonly ok: true; readonly config: CanonicalConfig; readonly passwordPending: boolean }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Assembles the configuration the answers produce: `buildInitConfig`'s
 * `server`/`app` mapping — plus, on a fresh run with a stored initial
 * account (task 133), that account as the configuration's `accounts` array
 * — merged over `base` by `validateSettings` (task 073's §5.3 keep-or-change
 * layer — omitted fields keep the base value, object sections merge
 * field-wise, and the result is the canonical, re-validated configuration
 * the write path persists).
 *
 * The `account` argument is fresh-run-only by construction: re-runs never
 * collect an account (the questions are not asked and the flags are
 * rejected, D-101), so a defined `account` always means no `base`, and the
 * merge never has to reconcile a submitted account array against existing
 * ones (arrays replace wholesale in the merge — unreachable here).
 *
 * One state is tolerated as pending (decision D-101): a non-loopback bind
 * or `required` mode without a password — the only §15.1 defect — is
 * probed with a placeholder password (D-022's technique, never problem
 * wording matching) and persisted hash-less: §15.1's own sentence binds
 * *starting* ("refuse to start"), §15.2 names `quotameter passwd` as the
 * completer, and the password-collection step lands with the scrypt tasks.
 * Everything else that fails is a real alarm: it fires loudly if a parser
 * and the configuration contract ever drift apart, instead of letting init
 * write a file the service would refuse for another reason (§6.2). Total,
 * like the layers it composes — problems, never a throw, never a secret.
 */
export function assembleInitConfig(
  answers: InitAnswers,
  base?: CanonicalConfig,
  account?: AccountConfig,
): InitAssembled {
  const mapped = buildInitConfig(answers);
  const submission = account === undefined ? mapped : { ...mapped, accounts: [account] };
  // The base feeds only the merge (every field is re-validated on the
  // merged result), so the brand assertion states the pipeline origin of a
  // canonical configuration — including the probe-validated pending one.
  const brandedBase = base as Validated<Config> | undefined;
  const direct = validateSettings(submission, brandedBase);
  if (!direct.ok) {
    const probed = validateSettings(withProbePassword(submission), brandedBase);
    if (probed.ok) {
      // `probed.config` carries no hash (the placeholder is stripped inside
      // the boundary, D-022) — exactly the pending state to persist.
      return { ok: true, config: probed.config as CanonicalConfig, passwordPending: true };
    }
    return { ok: false, problems: direct.problems };
  }
  // The pendingPassword variant cannot occur here: the submission carries no
  // auth section, and a pending password is extracted from the submission
  // alone (D-022). The cast states D-018's canonical invariant.
  return { ok: true, config: direct.config as CanonicalConfig, passwordPending: false };
}

/**
 * Whether the answers change any setting the questions own (spec §5.3 keep
 * or change): the merge touches exactly these four fields, so equality on
 * them means the run is a no-op and nothing is written.
 */
export function initSettingsChanged(existing: CanonicalConfig, answers: InitAnswers): boolean {
  return (
    existing.app.timezone !== answers.timezone ||
    existing.server.host !== answers.host ||
    existing.server.port !== answers.port ||
    existing.app.pollingIntervalSeconds !== answers.pollingIntervalSeconds
  );
}

/** Where and what {@link writeInitConfig} writes. */
export interface WriteInitConfigOptions {
  /** Configuration directory (spec §6.1 resolution is the caller's). */
  readonly configDir: string;
  /** Configuration file path inside `configDir`. */
  readonly configFile: string;
  /** The (possibly password-pending) configuration to persist. */
  readonly config: CanonicalConfig;
}

/** The consented write as an injectable seam (`InitDeps.persistConfig`). */
export type PersistInitConfig = (options: WriteInitConfigOptions) => Promise<void>;

/**
 * Persists a consented configuration: first the landed startup verifier —
 * which creates the configuration directory with mode `0700` level by level
 * and corrects or refuses anything it cannot make safe (spec §6.3, §15.4) —
 * then the landed atomic write (mode `0600`, temp file + fsync + rename).
 * A refusal from the verifier is rethrown in init's vocabulary: its
 * "refusing to start:" prefix is the server startup's wording, wrong for a
 * CLI that has not started anything (see {@link toInitFailure}).
 */
export async function writeInitConfig(options: WriteInitConfigOptions): Promise<void> {
  try {
    await enforceConfigPermissions({
      configDir: options.configDir,
      configFile: options.configFile,
    });
  } catch (error) {
    throw new Error(toInitFailure(error), { cause: error });
  }
  await writeConfigFile(options.configFile, options.config);
}

/** The permission refusals' fixed wrapper prefix (permissions.ts). */
const REFUSAL_PREFIX = 'refusing to start: ';

/**
 * An error message fit for the init handler: the permission verifier's
 * startup-flavored prefix is stripped (anchored — the wrapper is a fixed
 * literal), everything else passes through verbatim.
 */
export function toInitFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(REFUSAL_PREFIX) ? message.slice(REFUSAL_PREFIX.length) : message;
}
