/**
 * The initial-account leg of `init` (task 133, spec §5.3 step 6, §6.3, §8.1;
 * decision D-102).
 *
 * Tasks 130–132 collect the optional account (`InitAnswers.accountLabel` /
 * `accountApiKey` / `accountApiKeyEnv`) but deliberately persist nothing:
 * the stable id and the §6.3 secret-source assembly are this module's. It
 * owns three pieces:
 *
 * - **Assembly** ({@link assembleInitialAccount}): the answers become the
 *   persisted `AccountConfig` — a deterministic id derived from the label
 *   ({@link initialAccountId}, always inside the schema/SQL charset), the
 *   injected provider's own id, `enabled: true`, and exactly one secret
 *   source (§6.3: `apiKey` from the typed answer or `apiKeyEnv` from the
 *   flag — the two collection modes are mutually exclusive by construction,
 *   D-099/D-100). A label collected without any key assembles **nothing**:
 *   §6.3's "exactly one of `apiKey`/`apiKeyEnv`" makes a keyless account
 *   invalid configuration, so the run states plainly that the account is
 *   added later in the web UI (spec §5.3 step 3's skip path).
 * - **The connection test** ({@link runInitialAccountSetup}): §5.3 step 6
 *   tests the initial provider connection through the §8.1 contract —
 *   `provider.validateCredentials(account)` with the secret sealed inside a
 *   {@link createAccountContext} context (non-enumerable, never printed).
 *   The outcome is classified into the §7.2/§8.1 vocabulary by reading the
 *   provider-neutral error's `kind` field *structurally* (the CLI cannot
 *   import adapter types): `credentials-rejected` (the provider refused the
 *   key) or `provider-unavailable` (inconclusive — network, timeout, 5xx, …);
 *   an error without a recognized `kind` classifies as unavailable, because
 *   init's contract is that **a failed test never aborts the run**. As
 *   defense in depth the known secret is scrubbed from every detail line, so
 *   even a contract-violating provider cannot smuggle the key into output
 *   (§15.4).
 * - **The failure contract**: the failure is explained on stderr (the
 *   provider-neutral detail plus one class-specific guidance line), then —
 *   interactive mode only — the user is offered to keep the account (spec
 *   §5.3: "offer to continue with the account in an error state"): Enter or
 *   `y` keeps it, `n` drops it for this run (the answers lose the account
 *   fields, init continues, nothing needs rewriting), a closed input cancels
 *   exactly like a closed question (D-099). `init --yes` has no prompter by
 *   construction (D-100), so it always keeps the account and prints the
 *   explanation.
 *
 * The step runs **before** the configuration write: a dropped account is
 * simply absent from the single consented write, and the stale-detection
 * guard still re-reads the file immediately before it (D-101).
 */

import {
  createAccountContext,
  type AccountContext,
  type QuotaProvider,
} from '../providers/registry';
import type { AccountConfig } from '../schemas/config';
import type { CliOutput } from './output';
import type { InitAnswers } from './init-questions';
import type { YesEnv } from './init-yes';

/* ── The stable id ─────────────────────────────────────────────────────── */

/**
 * The deterministic account id of the initial account: a slug of its label —
 * lowercased, every run of characters outside the id charset collapsed to
 * one `-`, separator-only heads/tails removed (underscores too: the id
 * charset's first character must be alphanumeric, `ID_PATTERN`), capped at
 * the schema/SQL id length of 64, and separator-trimmed again after the cap
 * (the first character is alphanumeric by construction, so neither trim can
 * empty it). A label with no usable characters (any non-latin script,
 * punctuation only) falls back to `account`. Deterministic keeps
 * `init --yes` reproducible (D-100) and the id stable for the
 * configuration's lifetime — it is written once, and later renames (the
 * UI's §8.2 rename) change only the label.
 */
export function initialAccountId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '');
  if (slug === '') return 'account';
  return slug.slice(0, 64).replace(/[-_]+$/gu, '');
}

/* ── Assembly (spec §6.2, §6.3 — secrets in config, decision D-004) ────── */

/**
 * The assembled initial account: exactly one secret source (§6.3), by
 * construction — the interactive flow can produce only `apiKey` and
 * `init --yes` only `apiKeyEnv` (D-099/D-100). The union makes the
 * exclusivity a type fact, so the test below reads its secret source
 * without a defensive third branch. Structurally a valid `AccountConfig`.
 */
export type AssembledAccount =
  | {
      readonly id: string;
      readonly providerId: string;
      readonly label: string;
      readonly enabled: true;
      readonly apiKey: string;
    }
  | {
      readonly id: string;
      readonly providerId: string;
      readonly label: string;
      readonly enabled: true;
      readonly apiKeyEnv: string;
    };

/**
 * Assembles the persisted account the answers describe, or `undefined` when
 * there is nothing persistable: no label, or a label without any secret
 * source (§6.3's exactly-one rule — such a run stores no account and says
 * so). The secret source is the typed key (`apiKey`) or the flag's variable
 * name (`apiKeyEnv`).
 */
export function assembleInitialAccount(
  answers: InitAnswers,
  providerId: string,
): AssembledAccount | undefined {
  const label = answers.accountLabel;
  if (label === undefined) return undefined;
  const id = initialAccountId(label);
  if (answers.accountApiKey !== undefined) {
    return { id, providerId, label, enabled: true, apiKey: answers.accountApiKey };
  }
  const apiKeyEnv = answers.accountApiKeyEnv;
  if (apiKeyEnv !== undefined) {
    return { id, providerId, label, enabled: true, apiKeyEnv };
  }
  return undefined;
}

/* ── The connection test (spec §5.3 step 6, §8.1) ──────────────────────── */

/** Why the connection test failed, in the §7.2/§8.1 outcome vocabulary. */
export type ConnectionTestFailureClass = 'credentials-rejected' | 'provider-unavailable';

/** A failed check: the outcome class plus its secret-free detail line. */
export interface ConnectionTestFailure {
  readonly outcome: ConnectionTestFailureClass;
  readonly detail: string;
}

/** One connection-test result: passed, or failed with a named class. */
export type ConnectionTestOutcome = { readonly outcome: 'passed' } | ConnectionTestFailure;

/** What the replacement `[REDACTED]` marker stands in for (§15.4). */
const REDACTED = '[REDACTED]';

/**
 * Classifies a `validateCredentials` rejection into the outcome vocabulary.
 * The `kind` field is read structurally — the provider-neutral discriminant
 * consumers without adapter imports read (task 098's contract) — and any
 * error without a recognized `kind` classifies as `provider-unavailable`:
 * init must explain and continue on every test failure, not crash on an
 * unexpected shape. Totality extends to hostile shapes (review round): both
 * the `kind` read and the detail stringification can themselves throw (a
 * null-prototype thrown object, a throwing getter or `toString`), so each
 * is guarded and a failure of either degrades to the other — worst case a
 * static, secret-free fallback detail. The detail is the error's own
 * message (adapter errors are static English by D-042/D-052) with the known
 * secret scrubbed as defense in depth, so a provider that echoes the key
 * back inside an error still cannot get it printed (§15.4).
 */
export function classifyTestFailure(error: unknown, secret: string): ConnectionTestFailure {
  let kind: unknown = undefined;
  let rawDetail: string | undefined = undefined;
  try {
    kind = (error as { kind?: unknown } | null)?.kind;
  } catch {
    // A throwing `kind` getter: an unprintable rejection shape, not a class.
  }
  try {
    rawDetail = error instanceof Error ? error.message : String(error);
  } catch {
    // A null-prototype object (or a throwing `toString`) cannot be
    // stringified; the fallback detail below stays secret-free.
  }
  const detail =
    rawDetail === undefined
      ? 'the check failed with an error that cannot be displayed'
      : secret === ''
        ? rawDetail
        : rawDetail.split(secret).join(REDACTED);
  if (kind === 'credentials-rejected') {
    return { outcome: 'credentials-rejected', detail };
  }
  return { outcome: 'provider-unavailable', detail };
}

/** The class-specific guidance line printed under a failure's detail. */
export function connectionTestGuidance(failure: ConnectionTestFailure): string {
  return failure.outcome === 'credentials-rejected'
    ? 'quotameter init: the provider refused the key — the account will start in ' +
        'an error state; you can replace the key later in the web UI.'
    : 'quotameter init: the check was inconclusive (a network or provider problem, ' +
        'not a verdict on the key) — the service will retry the account on its schedule.';
}

/* ── The setup step ────────────────────────────────────────────────────── */

/**
 * What happened to the optional initial account of a fresh run:
 * `none` (not named), `no-key` (named without a secret — nothing stored),
 * `stored` (persisted, with the connection-test outcome), or `dropped`
 * (failed the test and the user declined to keep it — nothing stored).
 */
export type InitialAccountSetup =
  | { readonly kind: 'none' }
  | { readonly kind: 'no-key'; readonly label: string }
  | {
      readonly kind: 'stored';
      readonly account: AccountConfig;
      readonly test: ConnectionTestOutcome;
    }
  | { readonly kind: 'dropped'; readonly label: string; readonly test: ConnectionTestFailure };

/** One interactive question through the prompter's `ask` seam. */
export type AskQuestion = (prompt: string) => Promise<string | null>;

/** Injected collaborators of {@link runInitialAccountSetup}. */
export interface InitialAccountDeps {
  /** The collected answers; the account fields drive everything. */
  readonly answers: InitAnswers;
  /** The output seam — notes to stdout, explanations and complaints to stderr. */
  readonly output: CliOutput;
  /** The provider whose `validateCredentials` runs the test (§8.1). */
  readonly provider: QuotaProvider;
  /** The environment `apiKeyEnv` reads; production uses `process.env`. */
  readonly env: YesEnv;
  /**
   * The interactive question seam (`prompter.ask`), present only in the
   * interactive flow — it is what makes the §5.3 "offer to continue" a
   * question. `init --yes` passes nothing (no prompter exists there,
   * D-100) and the failure path keeps the account unconditionally.
   */
  readonly ask?: AskQuestion;
}

/** What {@link runInitialAccountSetup} hands to the write path. */
export interface PreparedAccount {
  /** The setup vocabulary the summary renders from. */
  readonly setup: InitialAccountSetup;
  /**
   * The answers the run persists: identical to the input except that a
   * dropped account's fields are stripped, so the write stores no account.
   */
  readonly answers: InitAnswers;
}

/**
 * Runs the §5.3 step-6 account leg over the collected answers: assemble,
 * test, explain, and — interactive only — offer to keep. Never throws
 * except for a closed interactive input (the same cancellation contract as
 * the questions themselves, D-099); a failed connection test always ends in
 * a `stored` (kept) or `dropped` outcome the caller continues from.
 */
export async function runInitialAccountSetup(deps: InitialAccountDeps): Promise<PreparedAccount> {
  const { answers } = deps;
  const label = answers.accountLabel;
  if (label === undefined) return { setup: { kind: 'none' }, answers };

  const account = assembleInitialAccount(answers, deps.provider.id);
  if (account === undefined) {
    // §6.3: a label without any secret source is not a persistable account
    // (spec §5.3 step 3's skip path — added later in the web UI, not stored).
    return { setup: { kind: 'no-key', label }, answers };
  }

  // The secret: the typed key, or the flag-named variable read once (the
  // value travels only into the account context — §15.4). A variable that
  // vanished between input and test is a check that cannot run, never a
  // reason to abort the run: its `apiKeyEnv` account is valid
  // configuration, so it fails the ordinary way — explained, offered, and
  // kept or dropped like any rejected check.
  let secret: string;
  if ('apiKey' in account) {
    secret = account.apiKey;
  } else {
    const value = deps.env[account.apiKeyEnv];
    // A blank value counts as gone (the D-011 uniform rule): whitespace is
    // never a credential, and handing it to the account context would throw
    // outside the guarded test — so it fails the ordinary explained way.
    if (value === undefined || value.trim() === '') {
      return failureOutcome(deps, account, {
        outcome: 'provider-unavailable',
        detail:
          `the environment variable '${account.apiKeyEnv}' that supplies the API key ` +
          'is not set to a usable value in this environment anymore',
      });
    }
    secret = value;
  }

  const context: AccountContext = createAccountContext(account.id, account.label, secret);
  try {
    await deps.provider.validateCredentials(context);
  } catch (error) {
    return failureOutcome(deps, account, classifyTestFailure(error, secret));
  }
  deps.output.out(
    `Connection test passed — the provider accepted the credentials for '${account.label}'.`,
  );
  return { setup: { kind: 'stored', account, test: { outcome: 'passed' } }, answers };
}

/**
 * The failure tail shared by every failed check: explain on stderr (detail
 * plus the class guidance), then keep — asking first in the interactive
 * flow, unconditionally without an `ask` seam (`--yes`).
 */
async function failureOutcome(
  deps: InitialAccountDeps,
  account: AssembledAccount,
  failure: ConnectionTestFailure,
): Promise<PreparedAccount> {
  const label = account.label;
  deps.output.err(
    `quotameter init: the initial connection test for '${label}' failed: ${failure.detail}`,
  );
  deps.output.err(connectionTestGuidance(failure));
  if (deps.ask !== undefined && !(await askToKeep(deps.ask, deps.output, label))) {
    deps.output.out(`The initial account '${label}' was not created — add it later in the web UI.`);
    return {
      setup: { kind: 'dropped', label, test: failure },
      answers: withoutAccount(deps.answers),
    };
  }
  return { setup: { kind: 'stored', account, test: failure }, answers: deps.answers };
}

/**
 * The §5.3 "offer to continue with the account in an error state", asked
 * until answered: Enter or `y` keeps the account, `n`/`no` drops it, a
 * closed input throws the cancellation the dispatcher renders (D-099 — no
 * decision is ever defaulted out of a missing answer).
 */
async function askToKeep(ask: AskQuestion, output: CliOutput, label: string): Promise<boolean> {
  for (;;) {
    const raw = await ask(
      `Keep '${label}' configured anyway? It will start in an error state ` +
        '(Enter or y keeps it, n drops it): ',
    );
    if (raw === null) {
      throw new Error(
        'input closed while deciding whether to keep the failed account — initialization cancelled',
      );
    }
    const answer = raw.trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    output.err('Answer y or n (Enter keeps the account).');
  }
}

/** The answers without the account fields — the dropped-account write. */
function withoutAccount(answers: InitAnswers): InitAnswers {
  return {
    timezone: answers.timezone,
    host: answers.host,
    port: answers.port,
    pollingIntervalSeconds: answers.pollingIntervalSeconds,
  };
}

/* ── Summary rendering (spec §6.3 masking, §15.4) ─────────────────────── */

/**
 * The Account row of the fresh-run summary: every state in words, the key
 * only ever as a secret-state phrase, an environment source naming only its
 * variable (D-100's publishable name), and the connection-test outcome.
 */
export function renderAccountRow(setup: InitialAccountSetup): string {
  switch (setup.kind) {
    case 'none':
      return 'none (add one later in the UI)';
    case 'no-key':
      return `none ('${setup.label}' was named without an API key — add the account in the web UI)`;
    case 'dropped':
      return `none ('${setup.label}' was dropped after the failed connection test — add it later in the web UI)`;
    case 'stored': {
      const source =
        setup.account.apiKeyEnv !== undefined
          ? `API key from environment variable '${setup.account.apiKeyEnv}', value never stored or printed`
          : 'API key configured, hidden';
      const test =
        setup.test.outcome === 'passed'
          ? 'connection test passed'
          : `connection test failed: ${setup.test.outcome} — stored in error state`;
      return `'${setup.account.label}' (${source}; ${test})`;
    }
  }
}
