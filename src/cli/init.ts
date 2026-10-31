/**
 * The `init` command handler (task 130, spec §5.3; decision D-099).
 *
 * Wires the question flow to the command table: run
 * {@link askInitQuestions} over the real terminal streams, then print a
 * summary of the validated values. The steps after the questions of §5.3 —
 * writing the configuration and database (idempotent flow, task 132) and the
 * initial account's connection test (task 133) — land next; until then the
 * summary states plainly that nothing has been written, so an exit code of 0
 * never implies a configured service.
 *
 * Cancellation: input closing before the questions complete (EOF, Ctrl-C, a
 * closed pipe) throws out of the handler and is rendered by the dispatcher's
 * standard failure path (`quotameter init: <message>`, exit 1 — decision
 * D-044's failure code; there is no separate interrupt code in the contract).
 */

import { isLoopbackHost } from '../schemas/config';
import type { CliContext, CliHandler } from './commands';
import { askInitQuestions, defaultSystemTimeZone, type InitAnswers } from './init-questions';
import { createReadlinePrompter, type PromptHandle } from './prompts';

/** Injectable collaborators; every one has a production default. */
export interface InitDeps {
  /** Builds the prompter; production uses the process terminal streams. */
  readonly createPrompter?: () => PromptHandle;
  /** The system-zone hint seam (hint-only — see `init-questions.ts`). */
  readonly systemTimeZone?: () => string | undefined;
}

/**
 * Builds the `init` handler. Tests inject a scripted prompter and a fixed
 * hint; the dispatcher needs no special casing.
 */
export function runInitCommand(deps: InitDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
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

/** The production prompter: the process terminal streams. */
function defaultPrompter(): PromptHandle {
  return createReadlinePrompter(process.stdin, process.stdout);
}

/**
 * Renders the post-question summary. The API key appears only as a state
 * word (`hidden`/`skipped`) — never as a value (spec §6.3, §15.4).
 */
export function renderInitSummary(answers: InitAnswers): string {
  const account =
    answers.accountLabel === undefined
      ? 'none (add one later in the UI)'
      : answers.accountApiKey === undefined
        ? `'${answers.accountLabel}' (API key skipped — add it later in the UI)`
        : `'${answers.accountLabel}' (API key configured, hidden)`;
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
