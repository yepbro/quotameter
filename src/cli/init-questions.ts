/**
 * The `init` question flow (task 130, spec §5.3; decisions D-099, D-101).
 *
 * The interactive half of §5.3 steps 2–3, in spec order: the explicit IANA
 * time zone, bind host, port, polling interval, and an optional initial
 * Z.ai account (label, then key). Every value is validated before it is
 * accepted; an invalid answer is a complaint on stderr and the same question
 * again, so a typo never aborts the flow.
 *
 * Interpretations pinned here (decision D-099):
 *
 * - **The time zone has no default.** §5.3 step 2 requires an explicit IANA
 *   name and forbids silently adopting the OS zone, so the empty answer is an
 *   error, not the hint. The system zone (from the injectable
 *   {@link InitQuestionDeps.systemTimeZone} seam) may appear inside the
 *   prompt text as a hint only; accepting it still means typing it.
 * - **Empty means the shown default** for host, port, and interval — the
 *   prompt names the default, so pressing Enter is an informed choice. The
 *   default values are `CONFIG_DEFAULTS` (spec §5.3, §7.1), never a second
 *   copy.
 * - **Empty on the account questions means skip** (spec §5.3 step 3: "The
 *   user may skip adding a key and add it later in the UI"); an answer that
 *   is blank but not empty is a complaint, because there blankness cannot
 *   mean "default" — it would silently skip an account the user tried to
 *   name.
 * - **Input closed cancels everything.** Any `null` from the prompter aborts
 *   the flow with `null` — nothing is half-collected and no value is ever
 *   defaulted out of a missing answer.
 *
 * Retain mode (task 132, decision D-101): when {@link InitQuestionDeps.existing}
 * carries the current validated configuration, each settings question names
 * the current value and the empty answer **keeps it** — the same informed-
 * Enter semantics as the shown default of a fresh run, now over a value the
 * user once chose explicitly (the anti-default rule of D-099 targets the
 * *system* zone silently adopted; retaining a validated explicit choice is
 * the consent §5.3's "keep or change" asks for). The account questions are
 * not asked in retain mode: the optional initial account is a first-run
 * step, existing accounts are displayed masked and kept verbatim, and
 * adding accounts after initialization is the web UI's job (§5.3 step 3).
 *
 * The per-value parsers are exported: `init --yes` (task 131) validates its
 * command-line values with the same functions — in both fresh and retain
 * mode ({@link retainOnEmpty}) — and `buildInitConfig` is the single
 * answers→`Config` assembly the follow-up tasks reuse. The `accounts` array
 * is assembled by `init-account.ts` (task 133's safe account setup: the
 * stable id and the §6.3 secret source), joined to this mapping by
 * `assembleInitConfig`.
 *
 * Secret discipline (spec §6.3, §15.4): the key travels only inside the
 * answers object; no complaint, prompt, or summary line in this module ever
 * contains it.
 */

import type { CanonicalConfig } from '../config/load';
import type { Config } from '../schemas/config';
import { CONFIG_DEFAULTS, isValidTimeZoneName } from '../schemas/config';
import type { CliOutput } from './output';
import type { Prompter } from './prompts';

/** Everything `askInitQuestions` collects, already validated. */
export interface InitAnswers {
  /** Canonical IANA name the user explicitly typed (spec §5.3 step 2). */
  readonly timezone: string;
  /** Bind host; the spec default `127.0.0.1` when the answer was empty. */
  readonly host: string;
  /** TCP port, 1–65535; the spec default `8787` when the answer was empty. */
  readonly port: number;
  /** Collection interval in seconds, 60–3600 (spec §7.1); default 300. */
  readonly pollingIntervalSeconds: number;
  /** Initial account label; `undefined` when no account was given. */
  readonly accountLabel?: string;
  /** Initial account API key; `undefined` when skipped (add later in the UI). */
  readonly accountApiKey?: string;
  /**
   * Environment variable supplying the initial account's key instead of a
   * stored value (spec §6.3 `apiKeyEnv`; decision D-100). Set only by
   * `init --yes --api-key-env` — the interactive flow asks for the value, so
   * this field and {@link accountApiKey} are mutually exclusive by
   * construction, and neither ever appears in output (spec §15.4; the name
   * alone is publishable — the value is checked for presence only and is
   * never stored or printed).
   */
  readonly accountApiKeyEnv?: string;
}

/** Injected collaborators of {@link askInitQuestions}. */
export interface InitQuestionDeps {
  /** Validation complaints go to stderr through the output seam. */
  readonly output: CliOutput;
  /** The question source; scripted in tests, readline in production. */
  readonly prompter: Prompter;
  /**
   * Yields the system's IANA zone for the prompt hint, or `undefined` when
   * none can be determined. Hint-only: the value is never adopted as an
   * answer (spec §5.3 step 2). Fresh runs only — a re-run shows the current
   * value instead (decision D-101).
   */
  readonly systemTimeZone: () => string | undefined;
  /**
   * The current validated configuration, when `init` runs against one
   * (task 132, spec §5.3, decision D-101): every settings question then
   * names the current value and an empty answer keeps it, and the account
   * questions are not asked — existing accounts are displayed and kept
   * verbatim by the caller.
   */
  readonly existing?: CanonicalConfig;
}

/** The system-zone lookup used when no seam is injected. */
export function defaultSystemTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // An unusable default locale makes Intl throw; no hint is better than
    // a crashed wizard.
    return undefined;
  }
}

/** Either a validated value or a complaint that names the problem. */
type Parsed<T> = { readonly value: T } | { readonly problem: string };

/* ── Per-value validation (reused by `init --yes`, task 131) ───────────── */

/**
 * Validates the time-zone answer (spec §5.3 step 2).
 *
 * Empty is an error — never a default. Accepted names are canonicalized
 * through `Intl` (`utc` → `UTC`; aliases such as `Asia/Calcutta` are kept),
 * using the same resolver family the display path trusts.
 */
export function parseTimeZone(raw: string): Parsed<string> {
  const name = raw.trim();
  if (name === '') {
    return {
      problem:
        'Time zone is required: Quotameter never applies the system time zone ' +
        'automatically. Enter an explicit IANA name, for example Europe/Berlin.',
    };
  }
  if (!isValidTimeZoneName(name)) {
    return {
      problem:
        `'${name}' is not a valid IANA time zone name. Use an Area/Locality ` +
        'name such as Europe/Berlin or America/New_York, or UTC.',
    };
  }
  return { value: canonicalTimeZone(name) };
}

/** Casing-canonical form of an already-validated IANA name. */
function canonicalTimeZone(name: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
}

/**
 * Validates the bind-host answer; empty takes the spec default `127.0.0.1`
 * (shown in the prompt). A host is accepted as typed — the configuration
 * contract only requires a non-empty string — but whitespace inside is
 * always a mistake, so it is rejected.
 */
export function parseHost(raw: string): Parsed<string> {
  const host = raw.trim();
  if (host === '') return { value: CONFIG_DEFAULTS.server.host };
  if (/\s/.test(host)) {
    return { problem: `Bind host cannot contain whitespace (got '${host}').` };
  }
  return { value: host };
}

/**
 * Validates the port answer; empty takes the spec default `8787`, otherwise
 * an integer 1–65535 (the configuration contract's bounds).
 */
export function parsePort(raw: string): Parsed<number> {
  const text = raw.trim();
  if (text === '') return { value: CONFIG_DEFAULTS.server.port };
  return wholeNumberInRange(text, 1, 65535, 'Port');
}

/**
 * Validates the interval answer; empty takes the spec default 300 seconds,
 * otherwise an integer in the §7.1 range 60–3600.
 */
export function parseIntervalSeconds(raw: string): Parsed<number> {
  const text = raw.trim();
  if (text === '') return { value: CONFIG_DEFAULTS.app.pollingIntervalSeconds };
  return wholeNumberInRange(text, 60, 3600, 'Polling interval');
}

/** An unsigned whole number inside `[min, max]`, with a `what`-addressed error. */
function wholeNumberInRange(text: string, min: number, max: number, what: string): Parsed<number> {
  if (!/^\d+$/.test(text)) {
    return { problem: `${what} must be a whole number (got '${text}').` };
  }
  const value = Number(text);
  if (value < min || value > max) {
    return { problem: `${what} must be between ${min} and ${max} (got '${text}').` };
  }
  return { value };
}

/**
 * Validates the optional account label. An empty line skips the account;
 * blank-but-not-empty input is a complaint, because skip is what empty must
 * mean here and a stray space should not silently skip a named account.
 */
export function parseAccountLabel(raw: string): Parsed<string | undefined> {
  return optionalTrimmed(raw, 'Account label');
}

/**
 * Validates the optional API key. An empty line skips it (spec §5.3: add it
 * later in the UI); blank-but-not-empty input is a complaint. The complaint
 * never contains the typed value (spec §15.4).
 */
export function parseApiKey(raw: string): Parsed<string | undefined> {
  return optionalTrimmed(raw, 'API key');
}

/** Shared shape of the two optional answers: empty = skip, blank = error. */
function optionalTrimmed(raw: string, what: string): Parsed<string | undefined> {
  const value = raw.trim();
  if (value === '') {
    if (raw === '') return { value: undefined };
    return {
      problem: `${what} cannot be blank — type a value or leave the line empty to skip.`,
    };
  }
  return { value };
}

/**
 * A retain-mode parser over an existing configuration (task 132, decision
 * D-101): the empty answer keeps `current` — the prompt names it, so
 * pressing Enter is the same informed choice as taking a shown default —
 * and any other answer goes through the shared parser unchanged. Exported
 * because `init --yes` (task 131) applies the identical retain semantics to
 * its absent optional flags.
 */
export function retainOnEmpty<T>(
  current: T,
  parse: (raw: string) => Parsed<T>,
): (raw: string) => Parsed<T> {
  return (raw) => (raw.trim() === '' ? { value: current } : parse(raw));
}

/* ── The flow ───────────────────────────────────────────────────────────── */

/**
 * Asks the §5.3 questions in order and returns the validated answers, or
 * `null` when the input closed before every question was answered.
 *
 * Fresh runs ask all six questions with the D-099 empty-answer semantics.
 * Runs against an existing configuration ({@link InitQuestionDeps.existing})
 * ask the four settings questions in retain mode — each prompt names the
 * current value, empty keeps it — and skip the account questions (decision
 * D-101).
 */
export async function askInitQuestions(deps: InitQuestionDeps): Promise<InitAnswers | null> {
  const current = deps.existing;

  const timezone = await askValidated(
    deps,
    current === undefined
      ? timeZonePrompt(deps.systemTimeZone())
      : keepPrompt('IANA time zone', current.app.timezone),
    false,
    current === undefined ? parseTimeZone : retainOnEmpty(current.app.timezone, parseTimeZone),
  );
  if (timezone === null) return null;

  const host = await askValidated(
    deps,
    current === undefined
      ? 'Bind host (Enter for 127.0.0.1): '
      : keepPrompt('Bind host', current.server.host),
    false,
    current === undefined ? parseHost : retainOnEmpty(current.server.host, parseHost),
  );
  if (host === null) return null;

  const port = await askValidated(
    deps,
    current === undefined ? 'Port (Enter for 8787): ' : keepPrompt('Port', current.server.port),
    false,
    current === undefined ? parsePort : retainOnEmpty(current.server.port, parsePort),
  );
  if (port === null) return null;

  const interval = await askValidated(
    deps,
    current === undefined
      ? 'Polling interval in seconds (Enter for 300): '
      : keepPrompt('Polling interval in seconds', current.app.pollingIntervalSeconds),
    false,
    current === undefined
      ? parseIntervalSeconds
      : retainOnEmpty(current.app.pollingIntervalSeconds, parseIntervalSeconds),
  );
  if (interval === null) return null;

  if (current !== undefined) {
    return { timezone, host, port, pollingIntervalSeconds: interval };
  }

  const label = await askValidated(
    deps,
    'Initial Z.ai account label (Enter to skip adding an account): ',
    false,
    parseAccountLabel,
  );
  if (label === null) return null;

  let apiKey: string | undefined;
  if (label !== undefined) {
    const key = await askValidated(
      deps,
      `API key for '${label}' (input hidden; Enter to skip and add it later in the UI): `,
      true,
      parseApiKey,
    );
    if (key === null) return null;
    apiKey = key;
  }

  return {
    timezone,
    host,
    port,
    pollingIntervalSeconds: interval,
    ...(label === undefined ? {} : { accountLabel: label }),
    ...(apiKey === undefined ? {} : { accountApiKey: apiKey }),
  };
}

/** A retain-mode prompt: names the value Enter keeps (decision D-101). */
function keepPrompt(what: string, current: string | number): string {
  return `${what} (Enter to keep ${current}): `;
}

/**
 * One question asked until a valid answer arrives: prompt → validate →
 * complaint on stderr and repeat. A closed prompter (`null`) propagates
 * immediately; the loop is bounded by the input itself, which either yields
 * a valid line or ends.
 */
async function askValidated<T>(
  deps: InitQuestionDeps,
  prompt: string,
  secret: boolean,
  parse: (raw: string) => Parsed<T>,
): Promise<T | null> {
  for (;;) {
    const raw = secret ? await deps.prompter.askSecret(prompt) : await deps.prompter.ask(prompt);
    if (raw === null) return null;
    const parsed = parse(raw);
    if ('value' in parsed) return parsed.value;
    deps.output.err(parsed.problem);
  }
}

/** The time-zone prompt; the system zone appears as a hint, never a default. */
function timeZonePrompt(hint: string | undefined): string {
  return hint === undefined
    ? 'IANA time zone to use (required, e.g. Europe/Berlin — never taken from the system): '
    : `IANA time zone to use (required; this system appears to use '${hint}' — a hint only, never applied automatically): `;
}

/* ── Assembly (reused by `init --yes` and the idempotent flow) ──────────── */

/**
 * Assembles the configuration sections the questions own: `server` and
 * `app`. `auth` stays with its defaults (`auto`, §15.1) and `accounts` is
 * `init-account.ts`'s concern (task 133: stable id + §6.3 secret source),
 * joined to this mapping by `assembleInitConfig` in `init-persist.ts`.
 */
export function buildInitConfig(answers: InitAnswers): Pick<Config, 'server' | 'app'> {
  return {
    server: { host: answers.host, port: answers.port },
    app: {
      timezone: answers.timezone,
      pollingIntervalSeconds: answers.pollingIntervalSeconds,
    },
  };
}
