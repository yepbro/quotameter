/**
 * The `init` command handler (tasks 130–132, spec §5.3; decisions D-099,
 * D-100, D-101).
 *
 * Two modes share this handler: the interactive question flow (task 130)
 * and the non-interactive `--yes` layer (task 131, `init-yes.ts`), which
 * takes every value from explicit options. The `--yes` branch runs before a
 * prompter is ever constructed — there is provably no prompt fallback — and
 * any value option without `--yes` is a clear failure instead of a silently
 * ignored flag. After validation, both modes print the same masked summary.
 *
 * Idempotency (task 132, `init-persist.ts`): the resolved configuration
 * file is classified first. Absent → the fresh flows above, and this run
 * writes the configuration (directory `0700`, file `0600`, atomic write —
 * §5.3 step 5's configuration half; the database half lands with the
 * storage-consuming steps, task 133+). Present and valid → §5.3's
 * subsequent-run flow: current settings are displayed (masked), every
 * question offers its current value (Enter keeps it; an absent `--yes`
 * option keeps it), and **nothing is written unless a setting actually
 * changes** — change requires an explicit typed answer or an explicit flag.
 * Immediately before any write the file is re-read and the run refused when
 * its state changed meanwhile (the stale-detection guard): a configuration
 * created or edited after the display is never overwritten by that run,
 * fresh runs included; the short re-read-to-rename window that remains is
 * accepted (decision D-101).
 * Present but invalid → a hard refusal: the problems are reported and the
 * file is left untouched, because overwriting a configuration whose
 * contents cannot be validated is never consented to (§6.2).
 *
 * The initial account stays unpersisted for now: a stable id and the §6.3
 * secret-source assembly belong to task 133's safe account setup, so a
 * fresh run that collects an account states plainly that its storage
 * follows.
 *
 * Cancellation (interactive mode only): input closing before the questions
 * complete (EOF, Ctrl-C, a closed pipe) throws out of the handler and is
 * rendered by the dispatcher's standard failure path (`quotameter init:
 * <message>`, exit 1 — decision D-044's failure code; there is no separate
 * interrupt code in the contract).
 */

import { configFilePath } from '../config/load';
import { resolvePaths, type PathEnv } from '../config/paths';
import type { CliContext, CliHandler } from './commands';
import {
  assembleInitConfig,
  initSettingsChanged,
  passwordRequirementNote,
  sameDetectionState,
  type ExistingConfig,
  type PersistInitConfig,
  readExistingConfig,
  renderExistingSettings,
  renderUpdateSummary,
  writeInitConfig,
} from './init-persist';
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
  /** The environment the XDG paths resolve from; production `process.env`. */
  readonly pathEnv?: PathEnv;
  /** Existing-configuration detection; production reads the resolved file. */
  readonly readExisting?: (targetPath: string) => Promise<ExistingConfig>;
  /** The consented write; production enforces permissions, then writes. */
  readonly persistConfig?: PersistInitConfig;
}

/**
 * Builds the `init` handler. Tests inject a scripted prompter, a fixed hint,
 * an environment snapshot, and (for the idempotent flow) detection and
 * persistence seams; the dispatcher needs no special casing.
 */
export function runInitCommand(deps: InitDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const paths = resolvePaths(deps.pathEnv ?? process.env);
    const configFile = configFilePath(paths.configDir);
    const existing = await (deps.readExisting ?? readExistingConfig)(configFile);
    if (existing.state === 'invalid') {
      reportInvalidExisting(ctx, configFile, existing.problems);
      return 1;
    }
    if (ctx.flags.yes === true) {
      return runYesInit(ctx, deps, paths.configDir, configFile, existing);
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
    if (existing.state === 'existing') {
      ctx.output.out(renderExistingSettings(existing.config, configFile));
      if (existing.passwordPending) {
        ctx.output.out(
          'No password is configured yet — the service will not start until ' +
            'quotameter passwd sets one.',
        );
      }
      ctx.output.out('Press Enter at a question to keep the current value.');
    }
    const prompter = deps.createPrompter?.() ?? defaultPrompter();
    let answers: InitAnswers | null;
    try {
      answers = await askInitQuestions({
        output: ctx.output,
        prompter,
        systemTimeZone: deps.systemTimeZone ?? defaultSystemTimeZone,
        existing: existing.state === 'existing' ? existing.config : undefined,
      });
    } finally {
      prompter.close();
    }
    if (answers === null) {
      throw new Error('input closed before the questions were answered — initialization cancelled');
    }
    return finishInit(ctx, deps, paths.configDir, configFile, existing, answers);
  };
}

/**
 * The `--yes` path: validate the flags against the environment (retaining
 * current values for absent options when a configuration exists), report
 * every problem as its own prefixed stderr line, and finish like the
 * interactive flow. No prompter exists here — stdin is never opened or
 * read, so `init --yes` works with input closed.
 */
async function runYesInit(
  ctx: CliContext,
  deps: InitDeps,
  configDir: string,
  configFile: string,
  existing: ExistingConfig,
): Promise<number> {
  if (existing.state === 'existing') {
    ctx.output.out(renderExistingSettings(existing.config, configFile));
    if (existing.passwordPending) {
      ctx.output.out(
        'No password is configured yet — the service will not start until ' +
          'quotameter passwd sets one.',
      );
    }
    ctx.output.out('Options that are not passed keep the current values.');
  }
  const result = buildYesAnswers(
    ctx.flags,
    deps.env ?? process.env,
    existing.state === 'existing' ? existing.config : undefined,
  );
  if ('problems' in result) {
    for (const problem of result.problems) {
      ctx.output.err(`quotameter init: ${problem}`);
    }
    return 1;
  }
  return finishInit(ctx, deps, configDir, configFile, existing, result.answers);
}

/**
 * Assembles, consent-checks, and — only when something changes — writes the
 * final configuration, then prints the outcome. The write always precedes
 * the summary: a "written" line is only ever printed after the write
 * succeeded, and an unchanged re-run writes nothing at all (the §5.3
 * done-condition: nothing is overwritten without consent).
 */
async function finishInit(
  ctx: CliContext,
  deps: InitDeps,
  configDir: string,
  configFile: string,
  existing: ExistingConfig,
  answers: InitAnswers,
): Promise<number> {
  const base = existing.state === 'existing' ? existing.config : undefined;
  if (base !== undefined && !initSettingsChanged(base, answers)) {
    ctx.output.out('No changes — the existing configuration is kept as shown above.');
    return 0;
  }
  const assembled = assembleInitConfig(answers, base);
  if (!assembled.ok) {
    for (const problem of assembled.problems) {
      ctx.output.err(`quotameter init: ${problem}`);
    }
    return 1;
  }
  // Stale-detection guard (review finding on the first version): the
  // question session can run for minutes, and this run's write must never
  // clobber a configuration created or changed after the display. The file
  // is re-read immediately before the write — a fresh run requires it to
  // still be absent (the no-clobber half: a file created after the initial
  // `none` result is never replaced), a re-run requires the same
  // configuration that was shown; anything else refuses with nothing
  // written. The residual window between this re-read and the rename is
  // accepted (decision D-101): a lock would serialize only cooperating
  // init processes, not the hand edits and foreign writers the guard
  // exists for.
  const nowExisting = await (deps.readExisting ?? readExistingConfig)(configFile);
  if (!sameDetectionState(existing, nowExisting)) {
    ctx.output.err(
      'quotameter init: the configuration changed while init was running — ' +
        'nothing was written. Run init again to see the current values.',
    );
    return 1;
  }
  await (deps.persistConfig ?? writeInitConfig)({
    configDir,
    configFile,
    config: assembled.config,
  });
  if (assembled.passwordPending) {
    ctx.output.out(
      'A password is required before the service starts: set one with quotameter passwd.',
    );
  }
  if (base === undefined) {
    ctx.output.out(renderInitSummary(answers));
    ctx.output.out(`Configuration written to ${configFile}.`);
    ctx.output.out(
      answers.accountLabel === undefined
        ? 'Service setup follows.'
        : 'The initial account is collected but not stored yet — account setup ' +
            'and the connection test follow.',
    );
  } else {
    ctx.output.out(renderUpdateSummary(assembled.config));
    ctx.output.out(`Configuration updated at ${configFile}.`);
  }
  return 0;
}

/** The existing-but-invalid refusal: report, never overwrite (§6.2). */
function reportInvalidExisting(
  ctx: CliContext,
  configFile: string,
  problems: readonly string[],
): void {
  ctx.output.err(
    `quotameter init: an existing configuration was found at ${configFile} ` +
      'but it is invalid — nothing was changed:',
  );
  for (const problem of problems) {
    ctx.output.err(`quotameter init:   ${problem}`);
  }
  ctx.output.err('quotameter init: fix or remove the file, then run init again.');
}

/** The production prompter: the process terminal streams. */
function defaultPrompter(): PromptHandle {
  return createReadlinePrompter(process.stdin, process.stdout);
}

/**
 * Renders the post-question summary of a fresh run. The API key appears
 * only as a state word (`hidden`/`from environment variable …`/`skipped`)
 * — never as a value (spec §6.3, §15.4); an environment-sourced key names
 * its variable (not a secret — it is what the account will persist), and
 * its value is neither stored nor printed. What happened to the file is
 * the handler's trailer, not part of the values.
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
  const note = passwordRequirementNote(answers.host);
  if (note !== undefined) lines.push(note);
  return lines.join('\n');
}
