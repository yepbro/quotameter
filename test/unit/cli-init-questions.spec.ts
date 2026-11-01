import { describe, expect, it } from 'vitest';
import { parseConfig, type CanonicalConfig } from '../../src/config/load';
import {
  askInitQuestions,
  buildInitConfig,
  parseAccountLabel,
  parseApiKey,
  parseHost,
  parseIntervalSeconds,
  parsePort,
  parseTimeZone,
  retainOnEmpty,
  type InitQuestionDeps,
} from '../../src/cli/init-questions';
import type { CliOutput } from '../../src/cli/output';
import type { Prompter } from '../../src/cli/prompts';

/**
 * The `init` question flow (task 130, spec §5.3; decision D-099) against a
 * scripted prompter: every question's invalid answers, the empty-answer
 * semantics (default where a default is shown, loud error where none is),
 * the no-silent-default time-zone rule, and cancellation when input closes.
 */

const NO_HINT = (): undefined => undefined;

/** The complaint of a rejected parse; `''` when the parse succeeded. */
function problemOf(outcome: { readonly value?: unknown } | { readonly problem?: string }): string {
  return 'problem' in outcome ? (outcome.problem ?? '') : '';
}

/** Records output lines exactly the way `systemOutput` would emit them. */
function recorder(): { output: CliOutput; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    output: {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

interface ScriptedPrompter extends Prompter {
  /** Every prompt text, suffixed with the question kind. */
  prompts(): string[];
}

/**
 * Answers in order; an exhausted script resolves `null` — the same contract
 * as a closed stdin, so EOF mid-flow is one line of setup.
 */
function script(answers: readonly string[]): ScriptedPrompter {
  const remaining = [...answers];
  const asked: string[] = [];
  const step = (kind: 'ask' | 'secret', prompt: string): Promise<string | null> => {
    asked.push(`${kind}: ${prompt}`);
    const value = remaining.shift();
    return Promise.resolve(value === undefined ? null : value);
  };
  return {
    ask: (prompt: string) => step('ask', prompt),
    askSecret: (prompt: string) => step('secret', prompt),
    prompts: () => asked,
  };
}

/** Deps with the given answers, system-zone hint, and a shared recorder. */
function flow(
  answers: readonly string[],
  systemTimeZone: () => string | undefined = NO_HINT,
): { deps: InitQuestionDeps; out(): string; err(): string; prompts(): string[] } {
  const sink = recorder();
  const prompter = script(answers);
  return {
    deps: { output: sink.output, prompter, systemTimeZone },
    out: sink.out,
    err: sink.err,
    prompts: prompter.prompts,
  };
}

describe('parseTimeZone (spec §5.3 step 2)', () => {
  it('accepts an IANA name and canonicalizes only the casing', () => {
    expect(parseTimeZone('Europe/Berlin')).toEqual({ value: 'Europe/Berlin' });
    expect(parseTimeZone(' utc ')).toEqual({ value: 'UTC' });
    expect(parseTimeZone('Asia/Calcutta')).toEqual({ value: 'Asia/Calcutta' });
  });

  it('rejects the empty answer loudly — never a default', () => {
    expect(parseTimeZone('')).toEqual({
      problem: expect.stringContaining('Time zone is required'),
    });
    expect(parseTimeZone('')).toEqual({
      problem: expect.stringContaining('never applies the system time zone'),
    });
    expect(parseTimeZone('   ')).toEqual({ problem: expect.stringContaining('required') });
  });

  it('rejects invalid names and offset identifiers, naming the value', () => {
    expect(parseTimeZone('Europe/Berlin/Extra')).toEqual({
      problem: expect.stringContaining("'Europe/Berlin/Extra' is not a valid IANA time zone"),
    });
    for (const bad of ['+03:00', '-05:00', 'EST5EDT?no', 'Not_A_Zone']) {
      expect(problemOf(parseTimeZone(bad))).toContain(bad);
    }
  });
});

describe('parseHost', () => {
  it('empty takes the shown default 127.0.0.1', () => {
    expect(parseHost('')).toEqual({ value: '127.0.0.1' });
    expect(parseHost('   ')).toEqual({ value: '127.0.0.1' });
  });

  it('accepts a typed host and rejects inner whitespace', () => {
    expect(parseHost('0.0.0.0')).toEqual({ value: '0.0.0.0' });
    expect(parseHost(' 192.168.1.5 ')).toEqual({ value: '192.168.1.5' });
    expect(parseHost('my host')).toEqual({ problem: expect.stringContaining('whitespace') });
  });
});

describe('parsePort', () => {
  it('empty takes the shown default 8787', () => {
    expect(parsePort('')).toEqual({ value: 8787 });
  });

  it('accepts integers in 1–65535 and rejects everything else', () => {
    expect(parsePort('1')).toEqual({ value: 1 });
    expect(parsePort('65535')).toEqual({ value: 65535 });
    expect(parsePort('0')).toEqual({ problem: expect.stringContaining('between 1 and 65535') });
    expect(parsePort('65536')).toEqual({
      problem: expect.stringContaining('between 1 and 65535'),
    });
    expect(parsePort('8787.5')).toEqual({ problem: expect.stringContaining('whole number') });
    expect(parsePort('abc')).toEqual({ problem: expect.stringContaining('whole number') });
    expect(parsePort('-1')).toEqual({ problem: expect.stringContaining('whole number') });
  });
});

describe('parseIntervalSeconds (spec §7.1 range)', () => {
  it('empty takes the shown default 300', () => {
    expect(parseIntervalSeconds('')).toEqual({ value: 300 });
  });

  it('accepts 60 and 3600, rejects the outsides and non-integers', () => {
    expect(parseIntervalSeconds('60')).toEqual({ value: 60 });
    expect(parseIntervalSeconds('3600')).toEqual({ value: 3600 });
    expect(parseIntervalSeconds('59')).toEqual({
      problem: expect.stringContaining('between 60 and 3600'),
    });
    expect(parseIntervalSeconds('3601')).toEqual({
      problem: expect.stringContaining('between 60 and 3600'),
    });
    expect(parseIntervalSeconds('5m')).toEqual({
      problem: expect.stringContaining('whole number'),
    });
  });
});

describe('parseAccountLabel / parseApiKey (optional answers)', () => {
  it('an empty line skips; blank-but-not-empty is an error', () => {
    expect(parseAccountLabel('')).toEqual({ value: undefined });
    expect(parseAccountLabel('work')).toEqual({ value: 'work' });
    expect(parseAccountLabel('  ')).toEqual({
      problem: expect.stringContaining('Account label cannot be blank'),
    });
    expect(parseApiKey('')).toEqual({ value: undefined });
    expect(parseApiKey('sk-1234')).toEqual({ value: 'sk-1234' });
    expect(parseApiKey('\t')).toEqual({
      problem: expect.stringContaining('API key cannot be blank'),
    });
  });

  it('the key complaint never contains the typed value, and padding is trimmed', () => {
    // A pasted key with stray surrounding whitespace is accepted, trimmed.
    expect(parseApiKey('   sk-secret-xyz   ')).toEqual({ value: 'sk-secret-xyz' });
    // A blank answer is an error whose text cannot leak anything typed.
    expect(problemOf(parseApiKey('   '))).toContain('API key cannot be blank');
  });
});

describe('askInitQuestions', () => {
  it('collects every answer in §5.3 order (happy path)', async () => {
    const f = flow(['Europe/Berlin', '0.0.0.0', '9000', '120', 'work', 'sk-live-key']);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toEqual({
      timezone: 'Europe/Berlin',
      host: '0.0.0.0',
      port: 9000,
      pollingIntervalSeconds: 120,
      accountLabel: 'work',
      accountApiKey: 'sk-live-key',
    });
    expect(f.err()).toBe('');
    expect(f.prompts()[0]).toContain('IANA time zone');
    expect(f.prompts()[5]).toMatch(/^secret: API key for 'work'/);
  });

  it('prompts for the key through the secret channel', async () => {
    const f = flow(['UTC', '', '', '', 'personal', 'sk-live-key']);
    await askInitQuestions(f.deps);
    const secretPrompt = f.prompts().find((p) => p.startsWith('secret:'));
    expect(secretPrompt).toContain("API key for 'personal'");
    expect(secretPrompt).toContain('input hidden');
  });

  it('empty lines take the shown defaults and skip the account entirely', async () => {
    const f = flow(['UTC', '', '', '', '']);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toEqual({
      timezone: 'UTC',
      host: '127.0.0.1',
      port: 8787,
      pollingIntervalSeconds: 300,
    });
    // No label means no key question at all.
    expect(f.prompts().some((p) => p.startsWith('secret:'))).toBe(false);
  });

  it('asks the key hidden, and an empty key answer means "add later"', async () => {
    const f = flow(['UTC', '', '', '', 'personal', '']);
    const answers = await askInitQuestions(f.deps);
    expect(answers?.accountLabel).toBe('personal');
    expect(answers?.accountApiKey).toBeUndefined();
    const secretPrompt = f.prompts().find((p) => p.startsWith('secret:'));
    expect(secretPrompt).toContain("API key for 'personal'");
    expect(secretPrompt).toContain('input hidden');
  });

  it('an invalid answer is a stderr complaint and the same question again', async () => {
    const f = flow([
      'Not_A_Zone', // invalid tz
      'Europe/Berlin', // valid tz
      'my host', // invalid host
      '', // default host
      'abc', // invalid port
      '0', // invalid port
      '9000', // valid port
      '59', // invalid interval
      '', // default interval
      '  ', // blank label
      'work', // valid label
      '  ', // blank key → complaint (never echoed)
      'sk-key', // valid key
    ]);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toMatchObject({ timezone: 'Europe/Berlin', host: '127.0.0.1', port: 9000 });
    expect(answers?.accountApiKey).toBe('sk-key');
    const complaints = f.err();
    expect(complaints).toContain("'Not_A_Zone' is not a valid IANA time zone");
    expect(complaints).toContain('Bind host cannot contain whitespace');
    expect(complaints).toContain("Port must be a whole number (got 'abc')");
    expect(complaints).toContain('Port must be between 1 and 65535');
    expect(complaints).toContain('Polling interval must be between 60 and 3600');
    expect(complaints).toContain('Account label cannot be blank');
    expect(complaints).toContain('API key cannot be blank');
    // The rejected key value never appears anywhere.
    expect(complaints).not.toContain('sk-key');
  });

  it('the system zone is a hint in the prompt only — empty still fails loudly', async () => {
    const f = flow(['', 'Europe/Moscow', '', '', '', ''], () => 'Asia/Novosibirsk');
    const answers = await askInitQuestions(f.deps);
    expect(answers?.timezone).toBe('Europe/Moscow');
    expect(f.prompts()[0]).toContain("'Asia/Novosibirsk'");
    expect(f.prompts()[0]).toContain('never applied automatically');
    expect(f.err()).toContain('Time zone is required');
  });

  it('typing the hinted zone explicitly accepts it (adoption requires typing)', async () => {
    const f = flow(['Asia/Novosibirsk', '', '', '', ''], () => 'Asia/Novosibirsk');
    const answers = await askInitQuestions(f.deps);
    expect(answers?.timezone).toBe('Asia/Novosibirsk');
    expect(f.err()).toBe('');
  });

  it('canonicalizes a differently-cased valid answer', async () => {
    const f = flow(['utc', '', '', '', '']);
    expect((await askInitQuestions(f.deps))?.timezone).toBe('UTC');
  });

  it.each([0, 1, 2, 3, 4, 5])('input closed at question %i cancels with null', async (index) => {
    const answers = ['UTC', '', '', '', 'work', 'sk-key'].slice(0, index);
    const f = flow(answers);
    await expect(askInitQuestions(f.deps)).resolves.toBeNull();
    // The closing question was asked (and recorded); none after it.
    expect(f.prompts()).toHaveLength(Math.min(index + 1, 6));
  });
});

describe('askInitQuestions (retain mode — task 132, decision D-101)', () => {
  /** A current configuration the re-run asks about. */
  const EXISTING: CanonicalConfig = (() => {
    const parsed = parseConfig({
      server: { host: '127.0.0.1', port: 9000 },
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
    });
    if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.problems.join('; ')}`);
    return parsed.value as CanonicalConfig;
  })();

  /** A retain-mode flow: the existing config plus a scripted prompter. */
  function retainFlow(answers: readonly string[]): {
    deps: InitQuestionDeps;
    out(): string;
    err(): string;
    prompts(): string[];
  } {
    const sink = recorder();
    const prompter = script(answers);
    return {
      deps: { output: sink.output, prompter, systemTimeZone: NO_HINT, existing: EXISTING },
      out: sink.out,
      err: sink.err,
      prompts: prompter.prompts,
    };
  }

  it('Enter keeps every current value — four questions, no account questions', async () => {
    const f = retainFlow(['', '', '', '']);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toEqual({
      timezone: 'Europe/Berlin',
      host: '127.0.0.1',
      port: 9000,
      pollingIntervalSeconds: 120,
    });
    expect(f.prompts()).toHaveLength(4);
    expect(f.prompts().some((p) => p.startsWith('secret:'))).toBe(false);
    expect(f.err()).toBe('');
  });

  it('each prompt names the value Enter keeps', async () => {
    const f = retainFlow(['', '', '', '']);
    await askInitQuestions(f.deps);
    expect(f.prompts()[0]).toBe('ask: IANA time zone (Enter to keep Europe/Berlin): ');
    expect(f.prompts()[1]).toBe('ask: Bind host (Enter to keep 127.0.0.1): ');
    expect(f.prompts()[2]).toBe('ask: Port (Enter to keep 9000): ');
    expect(f.prompts()[3]).toBe('ask: Polling interval in seconds (Enter to keep 120): ');
  });

  it('typing a value changes exactly that setting', async () => {
    const f = retainFlow(['UTC', '', '9001', '']);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toEqual({
      timezone: 'UTC',
      host: '127.0.0.1',
      port: 9001,
      pollingIntervalSeconds: 120,
    });
  });

  it('an invalid typed answer is a complaint and the same question again', async () => {
    // tz keeps; host invalid then keeps; port keeps; interval invalid then keeps.
    const f = retainFlow(['', 'my host', '', '', '59', '']);
    const answers = await askInitQuestions(f.deps);
    expect(answers).toEqual({
      timezone: 'Europe/Berlin',
      host: '127.0.0.1',
      port: 9000,
      pollingIntervalSeconds: 120,
    });
    expect(f.err()).toContain('Bind host cannot contain whitespace');
    expect(f.err()).toContain('Polling interval must be between 60 and 3600');
  });

  it('the system-zone hint is not consulted in retain mode', async () => {
    const sink = recorder();
    const prompter = script(['', '', '', '']);
    const deps: InitQuestionDeps = {
      output: sink.output,
      prompter,
      systemTimeZone: () => {
        throw new Error('the hint has no role once a configuration exists');
      },
      existing: EXISTING,
    };
    await expect(askInitQuestions(deps)).resolves.toMatchObject({ timezone: 'Europe/Berlin' });
  });

  it.each([0, 1, 2, 3])('input closed at question %i cancels with null', async (index) => {
    const f = retainFlow(['', '', '', ''].slice(0, index));
    await expect(askInitQuestions(f.deps)).resolves.toBeNull();
    expect(f.prompts()).toHaveLength(index + 1);
  });
});

describe('retainOnEmpty (the shared retain parser, decision D-101)', () => {
  it('empty and blank input keep the current value; anything else parses', () => {
    const parse = retainOnEmpty(9000, parsePort);
    expect(parse('')).toEqual({ value: 9000 });
    expect(parse('   ')).toEqual({ value: 9000 });
    expect(parse('9001')).toEqual({ value: 9001 });
    expect(parse('abc')).toEqual({ problem: expect.stringContaining('whole number') });
  });
});

describe('buildInitConfig', () => {
  it('maps answers onto the server and app sections', () => {
    expect(
      buildInitConfig({
        timezone: 'Europe/Berlin',
        host: '0.0.0.0',
        port: 9000,
        pollingIntervalSeconds: 120,
        accountLabel: 'work',
        accountApiKey: 'sk-key',
      }),
    ).toEqual({
      server: { host: '0.0.0.0', port: 9000 },
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120 },
    });
  });
});
