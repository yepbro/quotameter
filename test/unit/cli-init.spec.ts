import { describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { renderInitSummary, runInitCommand } from '../../src/cli/init';
import type { InitAnswers } from '../../src/cli/init-questions';
import type { PromptHandle } from '../../src/cli/prompts';

/**
 * The `init` command handler (task 130, spec §5.3; decision D-099): exit
 * codes, the cancellation path, and the summary's secret masking — with the
 * prompter and system-zone hint injected.
 */

function context(): { ctx: CliContext; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    ctx: {
      output: {
        out: (text: string) => void outText.push(`${text}\n`),
        err: (text: string) => void errText.push(`${text}\n`),
      },
      version: 'test',
      commandPath: ['init'],
      flags: {},
      positionals: [],
    },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

/** A prompter that answers everything from a script; null = input closed. */
function prompterWith(answers: readonly string[]): PromptHandle {
  const remaining = [...answers];
  const step = (): Promise<string | null> => {
    const value = remaining.shift();
    return Promise.resolve(value === undefined ? null : value);
  };
  return { ask: step, askSecret: step, close: () => undefined };
}

const FULL: readonly string[] = [
  'Europe/Berlin',
  '0.0.0.0',
  '9000',
  '120',
  'work',
  'sk-live-key-abc123',
];

/** Full script with host overridden, for the warning variants. */
function FILL(host: string): readonly string[] {
  return ['Europe/Berlin', host, '9000', '120', 'work', 'sk-live-key-abc123'];
}

describe('runInitCommand', () => {
  it('exit 0 with the validated summary on stdout (happy path)', async () => {
    const h = context();
    const code = await runInitCommand({ createPrompter: () => prompterWith(FULL) })(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toContain('Time zone:         Europe/Berlin');
    expect(h.out()).toContain('Bind host:         0.0.0.0');
    expect(h.out()).toContain('Port:              9000');
    expect(h.out()).toContain('Polling interval:  120 seconds');
    expect(h.out()).toContain("'work' (API key configured, hidden)");
  });

  it('never writes the key to stdout or stderr', async () => {
    const h = context();
    const code = await runInitCommand({ createPrompter: () => prompterWith(FULL) })(h.ctx);
    expect(code).toBe(0);
    expect(h.out() + h.err()).not.toContain('sk-live-key-abc123');
  });

  it('closed input throws the cancellation the dispatcher renders as exit 1', async () => {
    const h = context();
    const handler = runInitCommand({ createPrompter: () => prompterWith(['Europe/Berlin']) });
    await expect(handler(h.ctx)).rejects.toThrow(
      'input closed before the questions were answered — initialization cancelled',
    );
  });

  it('warns about the password requirement for a non-loopback host (§5.3 step 4)', async () => {
    const h = context();
    await runInitCommand({ createPrompter: () => prompterWith(FILL('192.168.1.10')) })(h.ctx);
    expect(h.out()).toContain('requires a password before the service');
    expect(h.out()).toContain('quotameter passwd');
  });

  it('no password warning on the loopback default', async () => {
    const h = context();
    await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '', '', '', '']),
    })(h.ctx);
    expect(h.out()).not.toContain('requires a password');
    expect(h.out()).toContain('Nothing has been written yet');
  });

  it('says plainly that nothing has been written yet', async () => {
    const h = context();
    await runInitCommand({ createPrompter: () => prompterWith(FULL) })(h.ctx);
    expect(h.out()).toContain('Nothing has been written yet');
  });
});

describe('renderInitSummary', () => {
  const base: InitAnswers = {
    timezone: 'UTC',
    host: '127.0.0.1',
    port: 8787,
    pollingIntervalSeconds: 300,
  };

  it('no account is stated explicitly', () => {
    expect(renderInitSummary(base)).toContain('Account:           none (add one later in the UI)');
  });

  it('a skipped key says to add it later in the UI', () => {
    expect(renderInitSummary({ ...base, accountLabel: 'personal' })).toContain(
      "'personal' (API key skipped — add it later in the UI)",
    );
  });

  it('a configured key reports hidden, and the value never appears', () => {
    const summary = renderInitSummary({
      ...base,
      accountLabel: 'personal',
      accountApiKey: 'sk-x',
    });
    expect(summary).toContain("'personal' (API key configured, hidden)");
    expect(summary).not.toContain('sk-x');
  });
});
