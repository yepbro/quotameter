/**
 * The non-interactive `init --yes` layer (task 131, spec §5.3; decision D-100).
 *
 * `quotameter init --yes` takes every value from explicit command-line
 * options — no questions, no prompter, no stdin dependency (the handler in
 * `init.ts` branches here before a prompter is ever constructed, so a prompt
 * fallback is impossible by construction). Validation is **reused, not
 * re-derived**: every value flows through the task-130 exported parsers, and
 * an absent optional flag is fed to its parser as an empty input, so "flag
 * omitted" inherits the parsers' own "empty takes the shown default"
 * semantics (decision D-099) — one set of rules for both modes.
 *
 * Interpretations pinned here (decision D-100):
 *
 * - **`--timezone` is mandatory** (spec §5.3: "absence is an error, not an
 *   invitation to use the machine's time zone"). An absent or empty flag is
 *   one dedicated problem naming the flag; a present-but-invalid value goes
 *   through `parseTimeZone` and fails exactly like the interactive answer.
 *   Service-load environment overrides (`QUOTAMETER_APP_TIMEZONE`, …) play no
 *   role at collection time — init writes explicit values, so none of them
 *   satisfies the missing flag.
 * - **The API key enters only through the environment, by name.** There is
 *   deliberately no `--api-key <value>` option: a value flag would put the
 *   secret in the process listing and shell history (spec §15.4). Instead
 *   `--api-key-env <variable>` names the variable (spec §6.3's `apiKeyEnv`
 *   mechanism — the configuration layer has no `QUOTAMETER_*` secret channel
 *   by design), and only the **name** is ever recorded: init proves the
 *   variable is set and records the name. The value is consulted exactly
 *   once — for the non-empty check — and never retained, echoed, or logged.
 *   No `--api-key-env` problem ever contains the supplied argument: a
 *   mistyped key (the variable pasted instead of its name — an
 *   underscore-only key passes the name-shape check) must never reach
 *   stderr (spec §15.4; review-round finding on the first version, which
 *   echoed it). Task 133 consumes the name for the connection test and the
 *   secret-source decision.
 * - **All value problems are reported at once** — one line each on stderr,
 *   then a single exit 1. The interactive flow complains per question because
 *   it can re-ask; a script gets the complete diagnosis in one run.
 */

import { API_KEY_ENV_NAME_PATTERN } from '../schemas/config';
import type { InitAnswers } from './init-questions';
import {
  parseAccountLabel,
  parseHost,
  parseIntervalSeconds,
  parsePort,
  parseTimeZone,
} from './init-questions';

/**
 * The value options of `init`, as the dispatch table declares them (without
 * dashes). Any of them without `--yes` is a clear failure — the interactive
 * wizard is the task-130 flow unchanged, and §5.3 defines no half-prefilled
 * middle mode.
 */
export const INIT_VALUE_OPTIONS = [
  'timezone',
  'host',
  'port',
  'polling-interval',
  'account-label',
  'api-key-env',
] as const;

/** The environment read through by `--api-key-env`; injectable for tests. */
export type YesEnv = Readonly<Record<string, string | undefined>>;

/** What {@link buildYesAnswers} yields: complete answers, or every problem. */
export type YesInput = { readonly answers: InitAnswers } | { readonly problems: readonly string[] };

/** A present string flag's value, or `undefined` when absent (booleans count). */
function flagValue(
  flags: Readonly<Record<string, boolean | string>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** One parsed optional flag: absent feeds the parser `''` (its default path). */
function parseFlag<T>(
  flags: Readonly<Record<string, boolean | string>>,
  name: string,
  parse: (raw: string) => { readonly value: T } | { readonly problem: string },
  problems: string[],
): T | undefined {
  const raw = flagValue(flags, name) ?? '';
  const parsed = parse(raw);
  if ('value' in parsed) return parsed.value;
  problems.push(parsed.problem);
  return undefined;
}

/**
 * Assembles the non-interactive answers from the parsed `init` flags and an
 * environment snapshot. Pure: same flags and environment, same result — the
 * reproducibility behind "a valid invocation is reproducible" (the summary
 * rendered from the answers contains no timestamps, hints, or randomness).
 *
 * The returned problems never contain a secret: the key's value is never
 * retained or echoed, and `--api-key-env` problems name the flag and the
 * rule, never the supplied argument.
 */
export function buildYesAnswers(
  flags: Readonly<Record<string, boolean | string>>,
  env: YesEnv,
): YesInput {
  const problems: string[] = [];

  // Time zone: the one mandatory value in non-interactive mode (spec §5.3).
  const timezoneRaw = flagValue(flags, 'timezone');
  let timezone: string | undefined;
  if (timezoneRaw === undefined || timezoneRaw.trim() === '') {
    problems.push(
      '--timezone is required with --yes: Quotameter never applies the ' +
        'system time zone automatically. Pass an explicit IANA name, for ' +
        'example --timezone Europe/Berlin.',
    );
  } else {
    const parsed = parseTimeZone(timezoneRaw);
    if ('value' in parsed) timezone = parsed.value;
    else problems.push(parsed.problem);
  }

  const host = parseFlag(flags, 'host', parseHost, problems);
  const port = parseFlag(flags, 'port', parsePort, problems);
  const interval = parseFlag(flags, 'polling-interval', parseIntervalSeconds, problems);
  const label = parseFlag(flags, 'account-label', parseAccountLabel, problems);

  const apiKeyEnv = parseApiKeyEnvFlag(flags, env, label !== undefined, problems);

  // `problems.length` is the real gate; the value disjuncts exist for the
  // type narrowing — every undefined above has pushed its problem, so the
  // two conditions never disagree on the outcome.
  if (
    problems.length > 0 ||
    timezone === undefined ||
    host === undefined ||
    port === undefined ||
    interval === undefined
  ) {
    return { problems };
  }
  return {
    answers: {
      timezone,
      host,
      port,
      pollingIntervalSeconds: interval,
      ...(label === undefined ? {} : { accountLabel: label }),
      ...(apiKeyEnv === undefined ? {} : { accountApiKeyEnv: apiKeyEnv }),
    },
  };
}

/**
 * Validates `--api-key-env <variable>`: the shape the account schema will
 * persist (one exported pattern, no drift), no reserved `QUOTAMETER_` prefix
 * (the service's environment scan rejects such names once set — fail here,
 * at the input boundary, with the remedy), and a variable that is actually
 * set (an empty value counts as unset, the D-011 uniform rule; inherited
 * object properties do not count — `Object.hasOwn` keeps `toString`-shaped
 * names from passing as set variables). A key source without
 * `--account-label` names no account and is a problem. No problem contains
 * the supplied argument (spec §15.4): the argument may be a mistyped key.
 */
function parseApiKeyEnvFlag(
  flags: Readonly<Record<string, boolean | string>>,
  env: YesEnv,
  hasLabel: boolean,
  problems: string[],
): string | undefined {
  const raw = flagValue(flags, 'api-key-env');
  if (raw === undefined) return undefined;
  if (!hasLabel) {
    problems.push(
      '--api-key-env requires --account-label: the key belongs to the ' +
        'initial account, and an account needs a name.',
    );
  }
  const name = raw.trim();
  if (name === '') {
    problems.push('--api-key-env cannot be blank — pass a variable name or omit the option.');
    return undefined;
  }
  if (!new RegExp(API_KEY_ENV_NAME_PATTERN).test(name)) {
    problems.push(
      '--api-key-env expects an environment variable name such as ZAI_API_KEY. ' +
        'The given argument is not echoed — a mistyped key must never reach output.',
    );
    return undefined;
  }
  if (name.startsWith('QUOTAMETER_')) {
    problems.push(
      '--api-key-env must not use the reserved QUOTAMETER_ prefix: the ' +
        'service rejects unknown QUOTAMETER_* variables at startup — point ' +
        'the account at a name outside the prefix.',
    );
    return undefined;
  }
  // Own property only: an inherited `toString`-shaped lookup is not a set
  // variable (verified on the pinned runtime — `process.env` resolves
  // prototype properties).
  if (!Object.hasOwn(env, name) || env[name] === undefined || env[name] === '') {
    problems.push(
      '--api-key-env names an environment variable that is not set in this ' +
        'environment (an empty value counts as unset). Export the API key ' +
        'there and run init again.',
    );
    return undefined;
  }
  // Set and non-empty: the name is the answer; the value is never retained.
  return name;
}
