/**
 * The init-side password collection (task U-042, spec §5.3 step 4, §15.2;
 * decision D-141).
 *
 * §15.2 names `init` as one of the three password setters, and §5.3 step 4
 * says when the password stops being optional: "If the selected bind host is
 * not loopback, require a password before starting the service." This module
 * is the interactive half of that collection — one muted question pair on
 * every fresh run, asked after the §5.3 step-3 questions and before the
 * account's connection test:
 *
 * - **Loopback bind** (the §15.1 default): the password is optional — the
 *   exactly-empty answer skips it, and completing init without one leaves
 *   `auth` at its §15.1 default (`mode: 'auto'`, no hash).
 * - **Non-loopback bind**: the question names the requirement and the empty
 *   answer is the too-short complaint like any other — a required question
 *   offers no skip, exactly like the mandatory time zone of §5.3 step 2.
 *
 * The pair mechanics (the §15.2 minimum, the confirmation, the bounded
 * attempts, the muted echo, the closed/interrupted distinction) are
 * `passwd`'s own `askNewPassword` (D-118) — one prompt-flow implementation,
 * no drift between the two commands that set passwords. The non-interactive
 * half lives in `init-yes.ts` as `--password-env` (D-141: the environment,
 * by name — never a value flag, §15.4's process-listing rule).
 *
 * Secret discipline (§15.2, §15.4): the password travels only from the
 * prompter's muted `askSecret` to the caller's return value — never into
 * `InitAnswers`, any prompt echo, complaint, summary, or log line. What the
 * configuration receives is the scrypt hash of `src/services/password-hash.ts`
 * (D-118/D-122), computed by the handler.
 */

import { isLoopbackHost } from '../schemas/config';
import { MIN_PASSWORD_LENGTH } from '../services/config-validation';
import { askNewPassword } from './passwd';
import type { CliOutput } from './output';
import type { PromptHandle } from './prompts';

/** The optional-password prompt of a loopback bind (Enter keeps none). */
export const LOOPBACK_PASSWORD_PROMPT =
  `Web password (at least ${MIN_PASSWORD_LENGTH} characters; ` +
  'Enter for none — set one later with quotameter passwd): ';

/** The required-password prompt of a non-loopback bind (§5.3 step 4). */
export const REQUIRED_PASSWORD_PROMPT =
  `Web password (at least ${MIN_PASSWORD_LENGTH} characters — ` +
  'required before the service starts on a non-loopback bind): ';

/** How asking the init password ended, in the handler's vocabulary. */
export type InitPasswordOutcome =
  /** A validated, confirmed password — the handler hashes and stores it. */
  | { readonly state: 'provided'; readonly password: string }
  /** No password (loopback only): the run completes in the §15.1 default. */
  | { readonly state: 'skipped' }
  /**
   * The input ended or was interrupted (Ctrl-C) — the D-044 uniform
   * cancellation: the dispatcher has no separate interrupt rendering, so
   * both settle into the handler's one "input closed" failure.
   */
  | { readonly state: 'cancelled' }
  /** Every pair attempt was rejected (§15.2 minimum or confirmation). */
  | { readonly state: 'aborted' };

/** Injected collaborators of {@link askInitPassword}. */
export interface InitPasswordDeps {
  /** Validation complaints go to stderr through the output seam. */
  readonly output: CliOutput;
  /** The question source; the handler's open prompt handle. */
  readonly prompter: PromptHandle;
  /** The collected bind host — §5.3 step 4's loopback test decides the mode. */
  readonly host: string;
  /** The complaint prefix (`quotameter init`), passwd's convention. */
  readonly errorPrefix: string;
}

/**
 * Asks the §5.3 step-4 password pair: `passwd`'s `askNewPassword` with the
 * prompt and the skip chosen by the bind host. The returned password is the
 * raw untrimmed input (secrets are never trimmed, D-022); every rejection
 * the user can provoke drew its secret-free stderr complaint inside the
 * shared flow already.
 */
export async function askInitPassword(deps: InitPasswordDeps): Promise<InitPasswordOutcome> {
  const loopback = isLoopbackHost(deps.host);
  const outcome = await askNewPassword(deps.errorPrefix, deps.output, deps.prompter, {
    prompt: loopback ? LOOPBACK_PASSWORD_PROMPT : REQUIRED_PASSWORD_PROMPT,
    skippable: loopback,
  });
  switch (outcome.state) {
    case 'provided':
      return { state: 'provided', password: outcome.password };
    case 'skipped':
      return { state: 'skipped' };
    case 'aborted':
      return { state: 'aborted' };
    // `closed` and `interrupted` collapse into the handler's one
    // cancellation — the dispatcher renders both identically (D-044).
    // Every union member is spelled: a future state fails compilation
    // here instead of silently reading as a cancellation (review round P3).
    case 'closed':
    case 'interrupted':
      return { state: 'cancelled' };
  }
}
