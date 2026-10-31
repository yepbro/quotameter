/**
 * The `init` command handler (tasks 130–131, spec §5.3; decisions D-099,
 * D-100).
 *
 * Two modes share this handler: the interactive question flow (task 130) and
 * the non-interactive `--yes` layer (task 131, `init-yes.ts`), which takes
 * every value from explicit options. The `--yes` branch runs before a
 * prompter is ever constructed — there is provably no prompt fallback — and
 * any value option without `--yes` is a clear failure instead of a silently
 * ignored flag. After validation, both modes print the same masked summary.
 * The steps after collection in §5.3 — writing the configuration and
 * database (idempotent flow, task 132) and the initial account's connection
 * test (task 133) — land next; until then the summary states plainly that
 * nothing has been written, so an exit code of 0 never implies a configured
 * service.
 *
 * Cancellation (interactive mode only): input closing before the questions
 * complete (EOF, Ctrl-C, a closed pipe) throws out of the handler and is
 * rendered by the dispatcher's standard failure path (`quotameter init:
 * <message>`, exit 1 — decision D-044's failure code; there is no separate
 * interrupt code in the contract).
 */

import { isLoopbackHost } from '../schemas/config';
import type { CliContext, CliHandler } from './commands';
import { askInitQuestions, defaultSystemTimeZone, type InitAnswers } from './init-questions';
import { buildYesAnswers, INIT_VALUE_OPTIONS, type YesEnv } from './init-yes';
import { createReadlinePrompter, type PromptHandle } from './prompts';

/** Injectable collaborators; every one has a production default. */
export interface InitDeps {
  /** Builds the prompter; production uses the process terminal streams. */
  readonly createPrompter?: () => PromptHandle;
  /** The system-zone hint seam (hint-only — see `init-questions.ts`). */
  readonly systemTimeZone?: () => string | undefined;
  /** The environment `--api-key-env` reads; production uses `process.env`. */
  readonly env?: YesEnv;
}

/**
 * Builds the `init` handler. Tests inject a scripted prompter, a fixed hint,
 * and an environment snapshot; the dispatcher needs no special casing.
 */
export function runInitCommand(deps: InitDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    if (ctx.flags.yes === true) {
      return runYesInit(ctx, deps);
    }
    const stray = INIT_VALUE_OPTIONS.find((name) => ctx.flags[name] !== undefined);
    if (stray !== undefined) {
      ctx.output.err(
        `quotameter init: --${stray} requires --yes (non-interactive mode). ` +
          'Pass --yes with explicit options, or run init without options to ' +
          'answer the questions instead.',
      );
      return 1;
    }
    const prompter = deps.createPrompter?.() ?? defaultPrompter();
    let answers: InitAnswers | null;
    try {
      answers = await askInitQuestions({
        output: ctx.output,
        prompter,
        systemTimeZone: deps.systemTimeZone ?? defaultSystemTimeZone,
      });
    } finally {
      prompter.close();
    }
    if (answers === null) {
      throw new Error('input closed before the questions were answered — initialization cancelled');
    }
    ctx.output.out(renderInitSummary(answers));
    return 0;
  };
}

/**
 * The `--yes` path: validate the flags against the environment, report every
 * problem as its own prefixed stderr line, and print the same summary the
 * interactive flow produces. No prompter exists here — stdin is never opened
 * or read, so `init --yes` works with input closed.
 */
function runYesInit(ctx: CliContext, deps: InitDeps): number {
  const result = buildYesAnswers(ctx.flags, deps.env ?? process.env);
  if ('problems' in result) {
    for (const problem of result.problems) {
      ctx.output.err(`quotameter init: ${problem}`);
    }
    return 1;
  }
  ctx.output.out(renderInitSummary(result.answers));
  return 0;
}

/** The production prompter: the process terminal streams. */
function defaultPrompter(): PromptHandle {
  return createReadlinePrompter(process.stdin, process.stdout);
}

/**
 * Renders the post-question summary. The API key appears only as a state
 * word (`hidden`/`from environment variable …`/`skipped`) — never as a value
 * (spec §6.3, §15.4); an environment-sourced key names its variable (not a
 * secret — it is what the account will persist), and its value is neither
 * stored nor printed.
 */
export function renderInitSummary(answers: InitAnswers): string {
  const account =
    answers.accountLabel === undefined
      ? 'none (add one later in the UI)'
      : answers.accountApiKey !== undefined
        ? `'${answers.accountLabel}' (API key configured, hidden)`
        : answers.accountApiKeyEnv !== undefined
          ? `'${answers.accountLabel}' (API key from environment variable ` +
            `'${answers.accountApiKeyEnv}', value never stored or printed)`
          : `'${answers.accountLabel}' (API key skipped — add it later in the UI)`;
  const lines = [
    'Initial configuration collected and validated:',
    `  Time zone:         ${answers.timezone}`,
    `  Bind host:         ${answers.host}`,
    `  Port:              ${answers.port}`,
    `  Polling interval:  ${answers.pollingIntervalSeconds} seconds`,
    `  Account:           ${account}`,
  ];
  if (!isLoopbackHost(answers.host)) {
    lines.push(
      '  Note: a non-loopback bind host requires a password before the service ' +
        'starts (set one with quotameter passwd).',
    );
  }
  lines.push('Nothing has been written yet — configuration and service setup follow.');
  return lines.join('\n');
}
