/**
 * The `init` command handler (tasks 130–133 + U-059, spec §5.3; decisions
 * D-099, D-100, D-101, D-102, D-187).
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
 * §5.3 step 5's configuration half; the database half is `init-database.ts`
 * since U-059, D-187). Present and valid → §5.3's subsequent-run
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
 * The §15.2 web password is collected on fresh runs since task U-042
 * (`init-password.ts`, D-141) — §5.3 step 4's step: one muted question pair
 * after the step-3 questions (optional on a loopback bind, Enter keeps
 * none; required-shaped on a non-loopback one), or `--password-env
 * <variable>` in `--yes` mode (the environment by name — never a value
 * flag, §15.4). Only the scrypt hash through `hashPassword` (D-118/D-122)
 * is stored, as `auth.passwordHash` inside the `0600` file; completing init
 * without a password keeps the §15.1 default (`mode: 'auto'`, no hash).
 * When the data directory still holds a database, storing the password
 * revokes its sessions first (`passwd`'s fail-secure order — review round
 * P1: "fresh" is fresh about the configuration file only). Re-runs collect
 * no password — `quotameter passwd` owns changes (D-118's fail-secure
 * session revocation) and the pending state's remedy (D-101).
 *
 * Service setup (task 137, `service-setup.ts`, D-106): the owner context of
 * §5.3 step 1 is resolved first and fails fast on problems; after a fresh
 * run's write, step 7 routes by privilege and machine capabilities — the
 * user unit installs without sudo, unavailable installation prints the
 * exact manual steps, and a privileged run renders the system-unit plan
 * (the privileged operations themselves are task 139's machinery). The
 * user-unit outcomes carry detected linger guidance (task 138,
 * `service-linger.ts`, D-107): the exact `sudo loginctl enable-linger
 * <owner>` command with the logout/reboot consequence unless linger is
 * already on — unknown never silently counts as enabled.
 *
 * The remaining §5.3 step-5/7/8 halves landed with U-059 (D-187), making a
 * fresh run's finalization an explicit lifecycle —
 * `write-config → database → service-setup → health-check → summary`, in
 * that order, with exactly one abort rule: the database step. A failed
 * configuration write aborts as before (nothing was written); a failed
 * database creation aborts **after** the write (the configuration file is
 * a valid artifact and explicitly kept, but the environment cannot start
 * a service, so installing one would be harmful — the §5.3 step-6
 * connection-test tolerance does not extend here: a bad key harms one
 * account, a bad data directory harms the whole service). The service
 * setup and health check are contained failures (§5.3's manual steps are
 * the designed fallback, and a still-booting service is legitimate): the
 * step reports which of its outcomes happened, and only a service this
 * run actually started (and a non-pending configuration — §15.1 refuses
 * that start by design) is health-probed by the bounded loopback
 * `GET /api/health`; a failed probe never fails the run. The lifecycle
 * closes with §5.3 step 8's block: the effective URL, the SSH-tunnel
 * access for a loopback bind, the `status`/`logs` commands, and the
 * configuration and data paths.
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
import { hashPassword } from '../services/password-hash';
import { isLoopbackHost } from '../schemas/config';
import type { CliContext, CliHandler } from './commands';
import {
  runInitialAccountSetup,
  renderAccountRow,
  type InitialAccountSetup,
  type PreparedAccount,
} from './init-account';
import { createInitDatabase, type InitDatabaseStep } from './init-database';
import { askInitPassword } from './init-password';
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
import { revokeAllSessions, type SessionRevocation } from './passwd';
import { createReadlinePrompter, type PromptHandle } from './prompts';
import {
  resolveServiceOwner,
  type ServiceOwnerContext,
  type ServiceOwnerResolution,
} from './service-owner';
import {
  bracketHostForUrl,
  failureLine,
  healthProbeTarget,
  HEALTH_CHECK_DEADLINE_MS,
  probeServiceCapabilities,
  renderHealthCheckGuidance,
  renderHealthVerificationPassed,
  runServiceSetupStep,
  thrownMessage,
  verifyServiceHealth,
  type CapabilityProbe,
  type ServiceCapabilities,
  type ServiceCommandRunner,
  type ServiceExecPaths,
  type ServiceHealthCheck,
  type ServiceUnitWriter,
} from './service-setup';
import type { UserLingerProbe } from './service-linger';

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
  /**
   * The §5.3 step 1 capability probe; production `probeServiceCapabilities`
   * (async since D-160 — a claimed manager is verified with a real query).
   */
  readonly probeCapabilities?: CapabilityProbe;
  /**
   * The §5.3 step 7 service-command executor; production `spawnServiceCommand`.
   */
  readonly runServiceCommand?: ServiceCommandRunner;
  /** The §5.3 step 7 unit-file writer; production `writeUnitFileToDisk`. */
  readonly writeServiceUnitFile?: ServiceUnitWriter;
  /** The absolute paths pinned into the generated unit; production `serviceExecPaths`. */
  readonly serviceExecPaths?: () => ServiceExecPaths;
  /**
   * The §5.3 step 7 user-linger state probe behind the detected guidance
   * (task 138, D-107); production `probeUserLinger` (the flag-file stat
   * under `/var/lib/systemd/linger`).
   */
  readonly probeUserLinger?: UserLingerProbe;
  /**
   * The §15.2 hashing behind the collected password (task U-042, D-141);
   * production `hashPassword` (D-118's scrypt encoding). Only the hash
   * ever reaches the assembled configuration.
   */
  readonly hash?: (password: string) => Promise<string>;
  /**
   * The §15.2 revocation a collected password owes a surviving database
   * (task U-042, D-141; review round P1): production `revokeAllSessions`
   * (`passwd`'s own probe — only `ENOENT` reads as absence, every other
   * failure fails the run before anything is stored).
   */
  readonly revokeSessions?: (dataDir: string) => Promise<SessionRevocation>;
  /**
   * The §5.3 step-5 database half of a fresh run (U-059, D-187): creates
   * the data directory (`0700`) and brings the database to the current
   * schema through the storage composition's own open/migrate pair;
   * production `createInitDatabase` (`init-database.ts`). Runs after the
   * consented configuration write; a failure aborts the run.
   */
  readonly createDatabase?: InitDatabaseStep;
  /**
   * The §5.3 step-7 health verification a started service owes (U-059,
   * D-187): production `verifyServiceHealth` (`service-setup.ts`) — a
   * bounded loopback `GET /api/health` poll. Consulted only when this
   * run's service-setup step actually started a service and the written
   * configuration is not password-pending (§15.1 refuses that start by
   * design); a failure is reported honestly but never fails the run.
   */
  readonly checkServiceHealth?: ServiceHealthCheck;
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
    const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
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
        paths.dataDir,
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
    let password: string | undefined;
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
      // §5.3 step 4 (task U-042, D-141): the web password, a fresh run's
      // last collection — asked after the step-3 questions and before the
      // account's connection test; optional on a loopback bind (Enter
      // keeps none, §15.1's default), required-shaped on a non-loopback
      // one. Re-runs collect no password: changing one is `quotameter
      // passwd`'s contract (D-118 owns the fail-secure session-revocation
      // ordering such a change requires), and a password-pending re-run
      // keeps its passwd remedy (D-101).
      if (existing.state !== 'existing') {
        const passwordOutcome = await askInitPassword({
          output: ctx.output,
          prompter,
          host: asked.host,
          errorPrefix: 'quotameter init',
        });
        if (passwordOutcome.state === 'cancelled') {
          throw new Error(
            'input closed before the password was answered — initialization cancelled',
          );
        }
        if (passwordOutcome.state === 'aborted') {
          throw new Error('too many unsuccessful password attempts — initialization cancelled');
        }
        password = passwordOutcome.state === 'provided' ? passwordOutcome.password : undefined;
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
      paths.dataDir,
      configFile,
      existing,
      prepared,
      ownerResolution.context,
      capabilities,
      password,
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
  dataDir: string,
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
  return finishInit(
    ctx,
    deps,
    configDir,
    dataDir,
    configFile,
    existing,
    prepared,
    owner,
    capabilities,
    result.password,
  );
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
 *
 * `password` (task U-042, D-141) is the collected §15.2 password of a fresh
 * run — `undefined` on every re-run (no collection there) and on a fresh
 * run that skipped or did not pass one. It exists in plaintext only until
 * the hash below; only `hashPassword`'s scrypt hash reaches the assembled
 * configuration and the write (§15.2), and neither the password nor its
 * hash ever reaches an output line. When the data directory still holds a
 * database (a configuration deleted or re-pointed while the database
 * survived), storing the password revokes its sessions first — §15.2's
 * revocation sentence in `passwd`'s fail-secure order (review round P1).
 */
async function finishInit(
  ctx: CliContext,
  deps: InitDeps,
  configDir: string,
  dataDir: string,
  configFile: string,
  existing: ExistingConfig,
  prepared: PreparedAccount,
  owner: ServiceOwnerContext,
  capabilities: ServiceCapabilities,
  password: string | undefined,
): Promise<number> {
  const { answers, setup } = prepared;
  const base = existing.state === 'existing' ? existing.config : undefined;
  if (base !== undefined && !initSettingsChanged(base, answers)) {
    ctx.output.out('No changes — the existing configuration is kept as shown above.');
    return 0;
  }
  // §15.2/D-141: the collected password becomes the stored hash here —
  // the plaintext's journey ends at the hashing seam, and only the opaque
  // string reaches the assembled configuration below. No password
  // collected (skip or absent flag) stores no hash: the §15.1 default.
  let passwordHash: string | undefined;
  if (password === undefined) {
    passwordHash = undefined;
  } else {
    try {
      passwordHash = await (deps.hash ?? hashPassword)(password);
    } catch (error) {
      ctx.output.err(
        failureLine('quotameter init', 'hashing the password failed', thrownMessage(error)),
      );
      return 1;
    }
  }
  const assembled = assembleInitConfig(
    answers,
    base,
    setup.kind === 'stored' ? setup.account : undefined,
    passwordHash,
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
  // §15.2's "changing the password revokes all sessions" (review round P1
  // on the first version): a fresh run is fresh about the **configuration
  // file** only — the data directory may still hold a database whose
  // sessions were minted under a previous installation's password (a
  // deleted configuration — init's own invalid-file remedy says "remove
  // the file, then run init again" — or a re-pointed QUOTAMETER_CONFIG_DIR).
  // Setting a password over such a database revokes them in `passwd`'s
  // fail-secure order: revoke **before** the write, a failed revocation
  // aborts with nothing stored (the shared rationale of every
  // password-writing path: docs/security/password-change-revocation.md,
  // D-184). A fresh machine's probe reads absence and
  // is silent.
  let revocation: SessionRevocation | undefined;
  if (passwordHash !== undefined) {
    revocation = await (deps.revokeSessions ?? revokeAllSessions)(dataDir);
    if (revocation.state === 'failed') {
      ctx.output.err(
        failureLine(
          'quotameter init',
          'revoking the sessions of the existing database failed',
          revocation.detail,
        ),
      );
      ctx.output.out(
        'The password was not stored — the configuration file was left untouched. ' +
          'Fix the database problem, then run init again.',
      );
      return 1;
    }
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
    ctx.output.out(renderInitSummary(answers, setup, passwordHash !== undefined));
    ctx.output.out(`Configuration written to ${configFile}.`);
    // Honest reporting of the P1 revocation above (passwd's report
    // discipline): sessions existed and are gone — state it, never
    // silently.
    if (revocation?.state === 'revoked' && revocation.count > 0) {
      const noun = revocation.count === 1 ? 'session' : 'sessions';
      const verb = revocation.count === 1 ? 'was' : 'were';
      ctx.output.out(
        `All ${revocation.count} stored ${noun} of the previous installation ${verb} revoked.`,
      );
    }
    // §5.3 step 5's database half (U-059, D-187): with the configuration
    // written, the run creates the data directory and brings the database
    // to the current schema — the one step-5 artifact whose failure is an
    // environment the service cannot start in (an unwritable data
    // directory, a corrupt file at the path, a newer schema), so the run
    // aborts here: installing an auto-restarting unit over a database that
    // cannot open would be the harmful alternative. The written file stays
    // — re-running init does not retry this step (it is fresh-run-only),
    // the service's own start does.
    const database = await (deps.createDatabase ?? createInitDatabase)(dataDir);
    if (database.state === 'failed') {
      ctx.output.err(
        failureLine('quotameter init', 'creating the database failed', database.detail),
      );
      ctx.output.out(
        'The configuration file was written and stays. Fix the reported problem, then start ' +
          'the service with quotameter run — it creates the database at startup.',
      );
      return 1;
    }
    ctx.output.out(`Database ready at ${database.databasePath}.`);
    // §5.3 step 7 (task 137): with the configuration written, set the
    // service up along the routed path — user unit without sudo, manual
    // steps when installation is unavailable, or the system-unit plan.
    // Fresh runs only: re-runs keep their update trailers, and
    // re-installation belongs to `quotameter service install` (task 139).
    // The user-unit outcomes carry task 138's detected linger guidance.
    const setupOutcome = await runServiceSetupStep(ctx.output, owner, capabilities, {
      runCommand: deps.runServiceCommand,
      writeUnitFile: deps.writeServiceUnitFile,
      execPaths: deps.serviceExecPaths,
      probeLinger: deps.probeUserLinger,
    });
    // §5.3 step 7's verification half (U-059, D-187): a service this run
    // actually started gets the bounded loopback health probe — skipped
    // for a password-pending configuration, which §15.1 by design refuses
    // to start (the pending remedy line above already says so; waiting out
    // the probe budget for a start that cannot happen helps nobody). A
    // failed probe is reported honestly but never fails the run: the
    // configuration is written and the unit installed, and the service may
    // legitimately still be starting.
    if (setupOutcome.serviceStarted && !assembled.passwordPending) {
      const { url } = healthProbeTarget(answers.host, answers.port);
      const health = await (deps.checkServiceHealth ?? verifyServiceHealth)(
        answers.host,
        answers.port,
      );
      if (health.state === 'healthy') {
        ctx.output.out(renderHealthVerificationPassed(url));
      } else {
        ctx.output.err(
          failureLine(
            'quotameter init',
            'the installed service did not pass the health check',
            health.detail,
          ),
        );
        ctx.output.out(renderHealthCheckGuidance(url, HEALTH_CHECK_DEADLINE_MS));
      }
    }
    // §5.3 step 8 (U-059, D-187): the closing block — URL, tunnel access
    // for a loopback bind, the status/logs commands, and the paths.
    ctx.output.out(renderInitNextSteps(answers, { configFile, dataDir }));
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
 *
 * The Password row (task U-042) is state-only like the Account row: `set`
 * means a scrypt hash was stored, never the value or the hash itself
 * (§15.2, §15.4). The §5.3 step-4 requirement note renders only when no
 * password was set — a stored hash satisfies the requirement.
 */
export function renderInitSummary(
  answers: InitAnswers,
  setup: InitialAccountSetup,
  passwordSet: boolean,
): string {
  const lines = [
    'Initial configuration collected and validated:',
    `  Time zone:         ${answers.timezone}`,
    `  Bind host:         ${answers.host}`,
    `  Port:              ${answers.port}`,
    `  Polling interval:  ${answers.pollingIntervalSeconds} seconds`,
    `  Account:           ${renderAccountRow(setup)}`,
    `  Password:          ${passwordSet ? 'set (only a scrypt hash is stored)' : 'none'}`,
  ];
  if (!passwordSet) {
    const note = passwordRequirementNote(answers.host);
    if (note !== undefined) lines.push(note);
  }
  return lines.join('\n');
}

/**
 * Renders §5.3 step 8's closing summary of a fresh run (U-059, D-187):
 * the effective URL, the SSH-tunnel access, the `status`/`logs` commands,
 * and the configuration and data paths. The scheme is always `http` —
 * §15.1's service itself never terminates TLS (a reverse proxy in front
 * of it may), and an IPv6-literal bind host is bracketed for the URL
 * grammar. A **wildcard** bind (`0.0.0.0`, `::`) has no client-usable URL
 * of its own — the placeholder names the machine's address, with the
 * every-interface fact stated (review round P3).
 *
 * The tunnel access renders **exactly for a loopback bind**: only a
 * loopback URL is unreachable from another machine, and the SSH tunnel is
 * §15.5's recommended remote-access method for exactly that world — on a
 * local machine the URL works as printed and the line is conditional
 * noise at worst, on a remote one it is the only way in. A non-loopback
 * bind is directly reachable on the network (its password requirement
 * note has already rendered; publishing guidance for that world is
 * §15.5's documentation job, not a fresh-run summary's).
 */
export function renderInitNextSteps(
  answers: InitAnswers,
  options: { readonly configFile: string; readonly dataDir: string },
): string {
  const configured = answers.host.trim().toLowerCase();
  const urlHost = bracketHostForUrl(configured);
  const wildcard = configured === '0.0.0.0' || configured === '::';
  const lines = [
    'Service access:',
    wildcard
      ? `  URL:               http://<this-machine's-address>:${answers.port} (the service listens on every interface)`
      : `  URL:               http://${urlHost}:${answers.port}`,
  ];
  if (isLoopbackHost(configured)) {
    lines.push(
      '  Remote access:    on another machine, reach the loopback bind through an SSH tunnel:',
      `    ssh -N -L ${answers.port}:${urlHost}:${answers.port} user@<this-host>`,
    );
  }
  lines.push(
    '  Status:           quotameter status',
    '  Logs:             quotameter logs',
    `  Configuration:    ${options.configFile}`,
    `  Data directory:   ${options.dataDir}`,
  );
  return lines.join('\n');
}
