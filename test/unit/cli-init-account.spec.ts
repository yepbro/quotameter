import { describe, expect, it } from 'vitest';
import {
  assembleInitialAccount,
  classifyTestFailure,
  connectionTestGuidance,
  initialAccountId,
  renderAccountRow,
  runInitialAccountSetup,
  type AskQuestion,
} from '../../src/cli/init-account';
import type { InitAnswers } from '../../src/cli/init-questions';
import type { YesEnv } from '../../src/cli/init-yes';
import type { CliOutput } from '../../src/cli/output';
import type { AccountContext, QuotaProvider } from '../../src/providers/registry';

/**
 * The initial-account leg of `init` (task 133, spec §5.3 step 6, §6.3, §8.1;
 * decision D-102): the deterministic id, the §6.3 exactly-one assembly, the
 * outcome classification, and the setup step's contract — the connection
 * test through a fake provider, the §7.2/§8.1 failure explanations, the
 * interactive keep-or-drop offer, the `--yes` keep-on-failure, and the
 * §15.4 marker discipline (the key value never reaches any output in any
 * state — happy path, failures, declines, environment sourcing).
 */

/** The marker secret every output assertion is written against (§15.4). */
const MARKER = 'sk-marker-unit-key';

/** Fresh-run answers without any account fields. */
const BASE: InitAnswers = {
  timezone: 'UTC',
  host: '127.0.0.1',
  port: 8787,
  pollingIntervalSeconds: 300,
};

function withKey(label = 'work', key = MARKER): InitAnswers {
  return { ...BASE, accountLabel: label, accountApiKey: key };
}

function withEnvKey(label = 'work', name = 'ZAI_TEST_KEY'): InitAnswers {
  return { ...BASE, accountLabel: label, accountApiKeyEnv: name };
}

/** A recording output seam. */
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

/** A provider-shaped error carrying the provider-neutral `kind` field. */
function kindError(kind: string, message: string): Error {
  return Object.assign(new Error(message), { kind });
}

/** What the fake provider should do with one `validateCredentials` call. */
type ProviderBehavior = (account: AccountContext) => Promise<void>;

/** A fake provider that records every context it was handed. */
function fakeProvider(behavior: ProviderBehavior, contexts: AccountContext[] = []): QuotaProvider {
  return {
    id: 'zai-coding-plan',
    name: 'Fake Z.ai Coding Plan',
    async validateCredentials(account: AccountContext): Promise<void> {
      contexts.push(account);
      await behavior(account);
    },
    async fetchSnapshot(): Promise<never> {
      throw new Error('fetchSnapshot is not part of the initial account test');
    },
  };
}

/** A provider that accepts every key. */
const accepting = (): QuotaProvider => fakeProvider(async () => undefined);

/** A scripted `ask` seam: each response answers one question, then closed. */
function askScripted(responses: readonly (string | null)[]): {
  ask: AskQuestion;
  prompts: string[];
} {
  const remaining = [...responses];
  const prompts: string[] = [];
  return {
    ask: (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(remaining.shift() ?? null);
    },
    prompts,
  };
}

/** Runs the setup step with the given overrides, returning all observables. */
async function run(overrides: {
  answers: InitAnswers;
  behavior: ProviderBehavior;
  env?: YesEnv;
  ask?: AskQuestion;
}): Promise<{
  setup: Awaited<ReturnType<typeof runInitialAccountSetup>>['setup'];
  answers: InitAnswers;
  out: string;
  err: string;
  contexts: AccountContext[];
}> {
  const { output, out, err } = recorder();
  const contexts: AccountContext[] = [];
  const provider = fakeProvider(overrides.behavior, contexts);
  const prepared = await runInitialAccountSetup({
    answers: overrides.answers,
    output,
    provider,
    env: overrides.env ?? {},
    ...(overrides.ask === undefined ? {} : { ask: overrides.ask }),
  });
  return { setup: prepared.setup, answers: prepared.answers, out: out(), err: err(), contexts };
}

describe('initialAccountId', () => {
  it('slugs plain labels to lowercase id chars', () => {
    expect(initialAccountId('work')).toBe('work');
    expect(initialAccountId('My Work')).toBe('my-work');
    expect(initialAccountId('ABC')).toBe('abc');
    expect(initialAccountId('team_dev-1')).toBe('team_dev-1');
  });

  it('trims separator-only heads and tails (the first char must be alphanumeric)', () => {
    expect(initialAccountId('-work-')).toBe('work');
    expect(initialAccountId('--  x  --')).toBe('x');
    // Underscores are id-legal — but never as the first character.
    expect(initialAccountId('_work')).toBe('work');
    expect(initialAccountId('--_x_--')).toBe('x');
    expect(initialAccountId('_')).toBe('account');
  });

  it('falls back to "account" when nothing usable survives', () => {
    expect(initialAccountId('Работа')).toBe('account');
    expect(initialAccountId('!!!')).toBe('account');
    expect(initialAccountId('')).toBe('account');
  });

  it('caps at the 64-character id limit without a trailing separator', () => {
    expect(initialAccountId('a'.repeat(100))).toHaveLength(64);
    expect(initialAccountId(`${'a'.repeat(100)}!`)).toHaveLength(64);
    // A capped body of separators only keeps its alphanumeric head.
    expect(initialAccountId(`a${'-'.repeat(100)}`)).toBe('a');
    expect(initialAccountId(`a${'_'.repeat(100)}`)).toBe('a');
  });

  it('the produced id always satisfies the schema/SQL id charset', () => {
    // The pattern from src/schemas/config.ts (ID_PATTERN), asserted over the
    // whole slug vocabulary the tests exercise.
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
    for (const label of [
      'work',
      'My Work',
      '-work-',
      '_work',
      '_',
      '--_x_--',
      '!!!',
      'Работа',
      `a${'_'.repeat(100)}`,
      'a'.repeat(100),
      'team_dev-1',
    ]) {
      expect(pattern.test(initialAccountId(label)), label).toBe(true);
    }
  });
});

describe('assembleInitialAccount', () => {
  it('a typed key becomes the stored-key account shape (§6.3, D-004)', () => {
    expect(assembleInitialAccount(withKey(), 'zai-coding-plan')).toEqual({
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'work',
      enabled: true,
      apiKey: MARKER,
    });
  });

  it('a flag-named variable becomes the apiKeyEnv account shape', () => {
    expect(assembleInitialAccount(withEnvKey(), 'zai-coding-plan')).toEqual({
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'work',
      enabled: true,
      apiKeyEnv: 'ZAI_TEST_KEY',
    });
  });

  it('a label without any key source assembles nothing (§6.3 exactly-one)', () => {
    expect(assembleInitialAccount({ ...BASE, accountLabel: 'work' }, 'zai-coding-plan')).toBe(
      undefined,
    );
  });

  it('no label assembles nothing', () => {
    expect(assembleInitialAccount(BASE, 'zai-coding-plan')).toBe(undefined);
  });
});

describe('classifyTestFailure', () => {
  it('reads the provider-neutral kind discriminant structurally', () => {
    expect(
      classifyTestFailure(kindError('credentials-rejected', 'refused (HTTP 401)'), 'x'),
    ).toEqual({ outcome: 'credentials-rejected', detail: 'refused (HTTP 401)' });
    expect(
      classifyTestFailure(kindError('provider-unavailable', 'could not complete'), 'x'),
    ).toEqual({ outcome: 'provider-unavailable', detail: 'could not complete' });
  });

  it('an error without a recognized kind classifies unavailable — never a crash', () => {
    expect(classifyTestFailure(new Error('surprise'), 'x')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'surprise',
    });
    expect(classifyTestFailure('a thrown string', 'x')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'a thrown string',
    });
  });

  it('hostile rejection shapes still classify (totality, review P1)', () => {
    // A null-prototype object cannot be stringified at all.
    const unprintable = Object.create(null) as { kind?: unknown };
    expect(classifyTestFailure(unprintable, 'x')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'the check failed with an error that cannot be displayed',
    });
    // A throwing `kind` getter degrades to unavailable with the printable message.
    const hostileKind = Object.create(Error.prototype, {
      message: { value: 'message survives' },
      kind: {
        get(): never {
          throw new Error('getter throws');
        },
      },
    }) as Error;
    expect(classifyTestFailure(hostileKind, 'x')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'message survives',
    });
    // A throwing `toString` on a non-Error falls back to the static detail.
    const hostileString = {
      kind: 'provider-unavailable',
      toString(): never {
        throw new Error('no primitives for you');
      },
    };
    expect(classifyTestFailure(hostileString, 'x')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'the check failed with an error that cannot be displayed',
    });
  });

  it('scrubs the known secret out of the detail (§15.4 defense in depth)', () => {
    const failure = classifyTestFailure(new Error(`provider echoed ${MARKER} back`), MARKER);
    expect(failure.detail).not.toContain(MARKER);
    expect(failure.detail).toContain('[REDACTED]');
  });

  it('without a secret to scrub the detail passes through verbatim', () => {
    expect(classifyTestFailure(new Error('plain detail'), '')).toEqual({
      outcome: 'provider-unavailable',
      detail: 'plain detail',
    });
  });
});

describe('connectionTestGuidance', () => {
  it('names the class meaning: refused key vs inconclusive check', () => {
    expect(connectionTestGuidance({ outcome: 'credentials-rejected', detail: 'd' })).toContain(
      'the provider refused the key',
    );
    expect(connectionTestGuidance({ outcome: 'provider-unavailable', detail: 'd' })).toContain(
      'inconclusive',
    );
  });
});

describe('runInitialAccountSetup', () => {
  it('no account named: nothing tested, nothing explained', async () => {
    const result = await run({ answers: BASE, behavior: async () => undefined });
    expect(result.setup).toEqual({ kind: 'none' });
    expect(result.contexts).toHaveLength(0);
    expect(result.out).toBe('');
    expect(result.err).toBe('');
  });

  it('a label without a key is the §5.3 step-3 skip: no account, no test', async () => {
    const result = await run({
      answers: { ...BASE, accountLabel: 'work' },
      behavior: async () => undefined,
    });
    expect(result.setup).toEqual({ kind: 'no-key', label: 'work' });
    expect(result.contexts).toHaveLength(0);
    expect(result.err).toBe('');
  });

  it('a passed test stores the account and reports the pass', async () => {
    const result = await run({ answers: withKey(), behavior: async () => undefined });
    expect(result.setup.kind).toBe('stored');
    expect(result.out).toContain("the provider accepted the credentials for 'work'");
    expect(result.out + result.err).not.toContain(MARKER);
    // The tested credentials are the collected ones (§8.1 context).
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]?.accountId).toBe('work');
    expect(result.contexts[0]?.label).toBe('work');
    expect(result.contexts[0]?.secret).toBe(MARKER);
  });

  it('a rejected key is explained with its class and the offer keeps it', async () => {
    const { ask, prompts } = askScripted(['y']);
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw kindError(
          'credentials-rejected',
          'the provider rejected the account credentials (HTTP 401)',
        );
      },
      ask,
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain("the initial connection test for 'work' failed:");
    expect(result.err).toContain('the provider rejected the account credentials (HTTP 401)');
    expect(result.err).toContain('the provider refused the key');
    expect(prompts[0]).toContain("Keep 'work' configured anyway?");
    expect(result.out + result.err).not.toContain(MARKER);
  });

  it('Enter at the offer keeps the account (the shown default)', async () => {
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw kindError('provider-unavailable', 'the check could not be completed');
      },
      ask: askScripted(['']).ask,
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain('the check was inconclusive');
  });

  it('declining drops the account: answers lose the account fields', async () => {
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw kindError('credentials-rejected', 'refused (HTTP 403)');
      },
      ask: askScripted(['n']).ask,
    });
    expect(result.setup).toMatchObject({ kind: 'dropped', label: 'work' });
    expect(result.answers.accountLabel).toBeUndefined();
    expect(result.answers.accountApiKey).toBeUndefined();
    expect(result.answers.accountApiKeyEnv).toBeUndefined();
    expect(result.out).toContain("The initial account 'work' was not created");
    expect(result.out + result.err).not.toContain(MARKER);
  });

  it('an invalid offer answer complains and is asked again', async () => {
    const { ask, prompts } = askScripted(['x', 'yes']);
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw kindError('credentials-rejected', 'refused');
      },
      ask,
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain('Answer y or n (Enter keeps the account).');
    expect(prompts).toHaveLength(2);
  });

  it('closed input at the offer cancels like a closed question (D-099)', async () => {
    const { ask } = askScripted([null]);
    await expect(
      run({
        answers: withKey(),
        behavior: async () => {
          throw kindError('credentials-rejected', 'refused');
        },
        ask,
      }),
    ).rejects.toThrow(
      'input closed while deciding whether to keep the failed account — initialization cancelled',
    );
  });

  it('without an ask seam (--yes) a failed test keeps the account', async () => {
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw kindError('credentials-rejected', 'refused (HTTP 401)');
      },
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain('the provider refused the key');
    expect(result.out + result.err).not.toContain(MARKER);
  });

  it('a contract-violating plain error is explained as unavailable and kept', async () => {
    const result = await run({
      answers: withKey(),
      behavior: async () => {
        throw new Error(`broken adapter echoed ${MARKER}`);
      },
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.setup).toMatchObject({ test: { outcome: 'provider-unavailable' } });
    expect(result.err).toContain('[REDACTED]');
    expect(result.out + result.err).not.toContain(MARKER);
  });

  it('an environment-sourced key tests the variable value, prints only the name', async () => {
    const result = await run({
      answers: withEnvKey(),
      behavior: async () => undefined,
      env: { ZAI_TEST_KEY: MARKER },
    });
    expect(result.setup.kind).toBe('stored');
    expect(result.contexts[0]?.secret).toBe(MARKER);
    expect(result.out).not.toContain(MARKER);
    expect(result.err).not.toContain(MARKER);
  });

  it('a variable that vanished before the test fails explained, provider untouched', async () => {
    const result = await run({
      answers: withEnvKey(),
      behavior: async () => undefined,
      env: {},
    });
    expect(result.contexts).toHaveLength(0);
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain("'ZAI_TEST_KEY' that supplies the API key");
    expect(result.err).toContain('inconclusive');
  });

  it('an empty variable value counts as vanished (the D-011 uniform rule)', async () => {
    const result = await run({
      answers: withEnvKey(),
      behavior: async () => undefined,
      env: { ZAI_TEST_KEY: '' },
    });
    expect(result.contexts).toHaveLength(0);
    expect(result.err).toContain("'ZAI_TEST_KEY' that supplies the API key");
  });

  it('a whitespace-only variable value is unusable, not a thrown context error', async () => {
    // Review P1: a blank value must fail the explained way — handing it to
    // the account context would throw outside the guarded test and abort.
    const result = await run({
      answers: withEnvKey(),
      behavior: async () => undefined,
      env: { ZAI_TEST_KEY: '   ' },
    });
    expect(result.contexts).toHaveLength(0);
    expect(result.setup.kind).toBe('stored');
    expect(result.err).toContain("'ZAI_TEST_KEY' that supplies the API key");
    expect(result.err).toContain('not set to a usable value');
  });

  it('the vanished-variable account can be dropped like any failed check', async () => {
    const result = await run({
      answers: withEnvKey(),
      behavior: async () => undefined,
      env: {},
      ask: askScripted(['no']).ask,
    });
    expect(result.setup).toMatchObject({ kind: 'dropped', label: 'work' });
    expect(result.out).toContain("The initial account 'work' was not created");
  });
});

describe('renderAccountRow', () => {
  it('states the no-account and skip states in words', () => {
    expect(renderAccountRow({ kind: 'none' })).toBe('none (add one later in the UI)');
    expect(renderAccountRow({ kind: 'no-key', label: 'work' })).toBe(
      "none ('work' was named without an API key — add the account in the web UI)",
    );
    expect(
      renderAccountRow({
        kind: 'dropped',
        label: 'work',
        test: { outcome: 'credentials-rejected', detail: 'd' },
      }),
    ).toBe(
      "none ('work' was dropped after the failed connection test — add it later in the web UI)",
    );
  });

  it('a stored account masks the key source and states the test outcome', () => {
    expect(
      renderAccountRow({
        kind: 'stored',
        account: { id: 'work', providerId: 'p', label: 'work', enabled: true, apiKey: 'sk-x' },
        test: { outcome: 'passed' },
      }),
    ).toBe("'work' (API key configured, hidden; connection test passed)");
    expect(
      renderAccountRow({
        kind: 'stored',
        account: {
          id: 'work',
          providerId: 'p',
          label: 'work',
          enabled: true,
          apiKeyEnv: 'ZAI_KEY',
        },
        test: { outcome: 'passed' },
      }),
    ).toBe(
      "'work' (API key from environment variable 'ZAI_KEY', value never stored or printed; connection test passed)",
    );
    expect(
      renderAccountRow({
        kind: 'stored',
        account: { id: 'work', providerId: 'p', label: 'work', enabled: true, apiKey: 'sk-x' },
        test: { outcome: 'credentials-rejected', detail: 'd' },
      }),
    ).toBe(
      "'work' (API key configured, hidden; connection test failed: credentials-rejected — stored in error state)",
    );
    expect(
      renderAccountRow({
        kind: 'stored',
        account: { id: 'work', providerId: 'p', label: 'work', enabled: true, apiKey: 'sk-x' },
        test: { outcome: 'provider-unavailable', detail: 'd' },
      }),
    ).toBe(
      "'work' (API key configured, hidden; connection test failed: provider-unavailable — stored in error state)",
    );
  });
});

describe('runInitialAccountSetup (provider wiring)', () => {
  it('the provider used is the injected one; its id becomes providerId', async () => {
    const { output } = recorder();
    const provider: QuotaProvider = {
      ...accepting(),
      id: 'zai-coding-plan',
    };
    const prepared = await runInitialAccountSetup({
      answers: withKey(),
      output,
      provider,
      env: {},
    });
    expect(prepared.setup).toMatchObject({
      kind: 'stored',
      account: { providerId: 'zai-coding-plan', id: 'work' },
    });
  });
});
