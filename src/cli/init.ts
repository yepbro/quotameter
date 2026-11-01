/**
 * The `init` command handler (tasks 130–133, spec §5.3; decisions D-099,
 * D-100, D-101, D-102).
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
 * storage-consuming steps). Present and valid → §5.3's subsequent-run
 * flow: current settings are displayed (masked), every question offers its
 * current value (Enter keeps it; an absent `--yes` option keeps it), and
 * **nothing is written unless a setting actually changes** — change
 * requires an explicit typed answer or an explicit flag. Immediately
 * before any write the file is re-read and the run refused when its state
 * changed meanwhile (the stale-detection guard): a configuration created
 * or edited after the display is never overwritten by that run, fresh runs
 * included; the short re-read-to-rename window that remains is accepted
 * (decision D-101). Present but invalid → a hard refusal: the problems are
 * reported and the file is left untouched, because overwriting a
 * configuration whose contents cannot be validated is never consented to
 * (§6.2).
 *
 * The initial account is real since task 133 (`init-account.ts`, D-102):
 * on a fresh run whose answers carry a secret source, the account is
 * assembled (stable id, §6.3 exactly-one secret source) and its provider
 * connection tested through `validateCredentials` (§8.1) **before** the
 * write. A failed test never aborts the run — it is explained on stderr
 * with its §7.2/§8.1 outcome class, and the account is kept (in `--yes`
 * mode unconditionally; interactively through the §5.3 offer, where
 * declining drops it from this run's write). The key value never reaches
 * any output at any stage (§15.4).
 *
 * Service setup (task 137, `service-setup.ts`, D-106): the owner context of
 * §5.3 step 1 is resolved first and fails fast on problems; after a fresh
 * run's write, step 7 routes by privilege and machine capabilities — the
 * user unit installs without sudo, unavailable installation prints the
 * exact manual steps, and a privileged run renders the system-unit plan
 * (the privileged operations themselves are task 139's machinery).
 *
 * Cancellation (interactive mode only): input closing before the questions
 * or the failure offer complete (EOF, Ctrl-C, a closed pipe) throws out of
 * the handler and is rendered by the dispatcher's standard failure path
 * (`quotameter init: <message>`, exit 1 — decision D-044's failure code;
 * there is no separate interrupt code in the contract).
 */

import { configFilePath } from '../config/load';
import { resolvePaths, type PathEnv } from '../config/paths';
import type { QuotaProvider } from '../providers/registry';
import { createInitialAccountProvider } from '../server/providers';
import type { CliContext, CliHandler } from './commands';
import {
  runInitialAccountSetup,
  renderAccountRow,
  type InitialAccountSetup,
  type PreparedAccount,
} from './init-account';
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
import {
  resolveServiceOwner,
  type ServiceOwnerContext,
  type ServiceOwnerResolution,
} from './service-owner';
import {
  probeServiceCapabilities,
  runServiceSetupStep,
  type ServiceCapabilities,
  type ServiceCommandRunner,
  type ServiceExecPaths,
  type ServiceUnitWriter,
} from './service-setup';

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
  /**
   * The provider behind the initial account's connection test (§5.3 step 6,
   * §8.1); production uses the composition root's factory (`src/server/`
   * is the one layer allowed to import concrete adapters — the CLI stays
   * provider-neutral, `src/cli/README.md`).
   */
  readonly provider?: QuotaProvider;
  /**
   * The service-owner resolution of §5.3 step 1 (task 136's layer, D-105):
   * init resolves it before anything else and fails fast on problems.
   * Production `resolveServiceOwner`.
   */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /** The §5.3 step 1 capability probe; production `probeServiceCapabilities`. */
  readonly probeCapabilities?: () => ServiceCapabilities;
  /** The §5.3 step 7 service-command executor; production `spawnServiceCommand`. */
  readonly runServiceCommand?: ServiceCommandRunner;
  /** The §5.3 step 7 unit-file writer; production `writeUnitFileToDisk`. */
  readonly writeServiceUnitFile?: ServiceUnitWriter;
  /** The absolute paths pinned into the generated unit; production `serviceExecPaths`. */
  readonly serviceExecPaths?: () => ServiceExecPaths;
}

/**
 * Builds the `init` handler. Tests inject a scripted prompter, a fixed hint,
 * an environment snapshot, and (for the idempotent flow) detection and
 * persistence seams; the dispatcher needs no special casing.
 */
export function runInitCommand(deps: InitDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    // §5.3 step 1, first: classify the invocation and resolve the service
    // owner (task 136's layer). Problems fail fast — before any questions,
    // writes, or prompts: a root-without-sudo run would otherwise collect a
    // configuration into root's own XDG home, and D-105's problems already
    // say how to run instead.
    const ownerResolution = (deps.resolveOwner ?? resolveServiceOwner)();
    if (ownerResolution.state === 'problems') {
      for (const problem of ownerResolution.problems) {
        ctx.output.err(`quotameter init: ${problem}`);
      }
      return 1;
    }
    const capabilities = (deps.probeCapabilities ?? probeServiceCapabilities)();
    const paths = resolvePaths(deps.pathEnv ?? process.env);
    const configFile = configFilePath(paths.configDir);
    const existing = await (deps.readExisting ?? readExistingConfig)(configFile);
    if (existing.state === 'invalid') {
      reportInvalidExisting(ctx, configFile, existing.problems);
      return 1;
    }
    if (ctx.flags.yes === true) {
      return runYesInit(
        ctx,
        deps,
        paths.configDir,
        configFile,
        existing,
        ownerResolution.context,
        capabilities,
      );
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
    // The prompter stays open through the account step: the §5.3 failure
    // offer (task 133) is asked on the same seam as the questions, and a
    // closed input there cancels exactly like a closed question (D-099).
    let prepared: PreparedAccount;
    try {
      const asked = await askInitQuestions({
        output: ctx.output,
        prompter,
        systemTimeZone: deps.systemTimeZone ?? defaultSystemTimeZone,
        existing: existing.state === 'existing' ? existing.config : undefined,
      });
      if (asked === null) {
        throw new Error(
          'input closed before the questions were answered — initialization cancelled',
        );
      }
      prepared = await runInitialAccountSetup({
        answers: asked,
        output: ctx.output,
        provider: deps.provider ?? createInitialAccountProvider(),
        env: deps.env ?? process.env,
        ask: (prompt) => prompter.ask(prompt),
      });
      // A Ctrl-C during the connection-test wait (no question is pending
      // there, so the prompter's close settles nothing) must cancel the run
      // before the write — piped EOF is exempt by design: automation that
      // delivered every answer ends its input, and that is not a cancel
      // (review round; D-099's uniform cancellation, the `interrupted`
      // latch added for exactly this window).
      if (prompter.interrupted()) {
        throw new Error(
          'input closed while the connection test was running — initialization cancelled',
        );
      }
    } finally {
      prompter.close();
    }
    return finishInit(
      ctx,
      deps,
      paths.configDir,
      configFile,
      existing,
      prepared,
      ownerResolution.context,
      capabilities,
    );
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
  owner: ServiceOwnerContext,
  capabilities: ServiceCapabilities,
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
  // No `ask` seam: `--yes` has no prompter (D-100), so a failed connection
  // test is explained and the account kept — never re-asked (task 133).
  const prepared = await runInitialAccountSetup({
    answers: result.answers,
    output: ctx.output,
    provider: deps.provider ?? createInitialAccountProvider(),
    env: deps.env ?? process.env,
  });
  return finishInit(ctx, deps, configDir, configFile, existing, prepared, owner, capabilities);
}

/**
 * Assembles, consent-checks, and — only when something changes — writes the
 * final configuration, then prints the outcome. The write always precedes
 * the summary: a "written" line is only ever printed after the write
 * succeeded, and an unchanged re-run writes nothing at all (the §5.3
 * done-condition: nothing is overwritten without consent). The prepared
 * account step (task 133) has already run by now: its `stored` account
 * joins the assembled configuration, its dropped/no-key outcomes join
 * nothing, and its connection-test outcome renders in the summary.
 */
async function finishInit(
  ctx: CliContext,
  deps: InitDeps,
  configDir: string,
  configFile: string,
  existing: ExistingConfig,
  prepared: PreparedAccount,
  owner: ServiceOwnerContext,
  capabilities: ServiceCapabilities,
): Promise<number> {
  const { answers, setup } = prepared;
  const base = existing.state === 'existing' ? existing.config : undefined;
  if (base !== undefined && !initSettingsChanged(base, answers)) {
    ctx.output.out('No changes — the existing configuration is kept as shown above.');
    return 0;
  }
  const assembled = assembleInitConfig(
    answers,
    base,
    setup.kind === 'stored' ? setup.account : undefined,
  );
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
    ctx.output.out(renderInitSummary(answers, setup));
    ctx.output.out(`Configuration written to ${configFile}.`);
    // §5.3 step 7 (task 137): with the configuration written, set the
    // service up along the routed path — user unit without sudo, manual
    // steps when installation is unavailable, or the system-unit plan.
    // Fresh runs only: re-runs keep their update trailers, and
    // re-installation belongs to `quotameter service install` (task 139).
    await runServiceSetupStep(ctx.output, owner, capabilities, {
      runCommand: deps.runServiceCommand,
      writeUnitFile: deps.writeServiceUnitFile,
      execPaths: deps.serviceExecPaths,
    });
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
 * Renders the post-question summary of a fresh run. The Account row comes
 * from the account step's own renderer (task 133): the key appears only as
 * a state word (`hidden`/`from environment variable …`/`none`), never as a
 * value (spec §6.3, §15.4); an environment-sourced key names its variable
 * (not a secret — it is what the account will persist), and the
 * connection-test outcome is stated in words. What happened to the file is
 * the handler's trailer, not part of the values.
 */
export function renderInitSummary(answers: InitAnswers, setup: InitialAccountSetup): string {
  const lines = [
    'Initial configuration collected and validated:',
    `  Time zone:         ${answers.timezone}`,
    `  Bind host:         ${answers.host}`,
    `  Port:              ${answers.port}`,
    `  Polling interval:  ${answers.pollingIntervalSeconds} seconds`,
    `  Account:           ${renderAccountRow(setup)}`,
  ];
  const note = passwordRequirementNote(answers.host);
  if (note !== undefined) lines.push(note);
  return lines.join('\n');
}
