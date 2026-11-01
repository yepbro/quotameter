import { describe, expect, it } from 'vitest';
import { parseConfig, type CanonicalConfig } from '../../src/config/load';
import type { CliContext } from '../../src/cli/commands';
import { renderInitSummary, runInitCommand, type InitDeps } from '../../src/cli/init';
import type { WriteInitConfigOptions } from '../../src/cli/init-persist';
import type { InitAnswers } from '../../src/cli/init-questions';
import type { PromptHandle } from '../../src/cli/prompts';

/**
 * The `init` command handler (tasks 130–132, spec §5.3; decisions D-099,
 * D-101): exit codes, the cancellation path, the summary's secret masking,
 * and the idempotent flow — detection outcomes, retain-on-Enter, the
 * consented write, and the unchanged no-op — with the prompter, detection,
 * and persistence seams injected (no filesystem here; the real wiring is
 * pinned by `test/integration/cli-init-idempotent.spec.ts`).
 */

function context(flags: Record<string, boolean | string> = {}): {
  ctx: CliContext;
  out(): string;
  err(): string;
} {
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
      flags,
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

/** A validated canonical fixture through the real parser. */
function canonical(input: unknown): CanonicalConfig {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw new Error(`fixture configuration rejected: ${parsed.problems.join('; ')}`);
  return parsed.value as CanonicalConfig;
}

/** The configuration the double-init scenarios start from (§5.3 re-run). */
const EXISTING: CanonicalConfig = canonical({
  server: { host: '127.0.0.1', port: 9000 },
  app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
  accounts: [{ id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-configured-key' }],
});

/** Deps scripted for a fresh run: no existing config, captured writes. */
function freshDeps(prompterAnswers: readonly string[]): {
  deps: InitDeps;
  writes(): readonly WriteInitConfigOptions[];
} {
  const writes: WriteInitConfigOptions[] = [];
  return {
    deps: {
      createPrompter: () => prompterWith(prompterAnswers),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async (options) => {
        writes.push(options);
      },
    },
    writes: () => writes,
  };
}

/** Deps scripted for a re-run against EXISTING. */
function existingDeps(prompterAnswers: readonly string[]): InitDeps {
  return {
    createPrompter: () => prompterWith(prompterAnswers),
    readExisting: async () => ({
      state: 'existing' as const,
      config: EXISTING,
      passwordPending: false,
    }),
    persistConfig: async () => {
      throw new Error('persistConfig must not run for this scenario');
    },
  };
}

const FULL: readonly string[] = [
  'Europe/Berlin',
  '0.0.0.0',
  '9000',
  '120',
  'work',
  'sk-live-key-abc123',
];

describe('runInitCommand (fresh run, task 130)', () => {
  it('exit 0 with the validated summary and the written-file trailer', async () => {
    const h = context();
    const { deps, writes } = freshDeps(FULL);
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.err()).toBe('');
    expect(h.out()).toContain('Time zone:         Europe/Berlin');
    expect(h.out()).toContain('Bind host:         0.0.0.0');
    expect(h.out()).toContain('Port:              9000');
    expect(h.out()).toContain('Polling interval:  120 seconds');
    expect(h.out()).toContain("'work' (API key configured, hidden)");
    expect(h.out()).toContain('Configuration written to');
    expect(writes()).toHaveLength(1);
  });

  it('persists the canonical configuration without the account (task 133 owns it)', async () => {
    const h = context();
    const { deps, writes } = freshDeps(FULL);
    await runInitCommand(deps)(h.ctx);
    const written = writes()[0];
    expect(written).toBeDefined();
    if (written !== undefined) {
      expect(written.config.server).toEqual({ host: '0.0.0.0', port: 9000 });
      expect(written.config.app.timezone).toBe('Europe/Berlin');
      expect(written.config.accounts).toEqual([]);
      expect(JSON.stringify(written.config)).not.toContain('sk-live-key-abc123');
    }
    // …and says so plainly next to the collected account.
    expect(h.out()).toContain('not stored yet — account setup');
  });

  it('a run without an account states that service setup follows', async () => {
    const h = context();
    const { deps } = freshDeps(['UTC', '', '', '', '']);
    await runInitCommand(deps)(h.ctx);
    expect(h.out()).toContain('Service setup follows.');
    expect(h.out()).not.toContain('not stored yet');
  });

  it('never writes the key to stdout or stderr', async () => {
    const h = context();
    const { deps } = freshDeps(FULL);
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(0);
    expect(h.out() + h.err()).not.toContain('sk-live-key-abc123');
  });

  it('closed input throws the cancellation the dispatcher renders as exit 1', async () => {
    const h = context();
    const { deps, writes } = freshDeps(['Europe/Berlin']);
    await expect(runInitCommand(deps)(h.ctx)).rejects.toThrow(
      'input closed before the questions were answered — initialization cancelled',
    );
    expect(writes()).toHaveLength(0);
  });

  it('a failed write propagates as the handler failure (never a written claim)', async () => {
    const h = context();
    const deps: InitDeps = {
      createPrompter: () => prompterWith(['UTC', '', '', '', '']),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async () => {
        throw new Error('configuration directory /x is a symbolic link');
      },
    };
    await expect(runInitCommand(deps)(h.ctx)).rejects.toThrow('symbolic link');
    expect(h.out()).not.toContain('Configuration written to');
  });

  it('warns about the password requirement for a non-loopback host (§5.3 step 4)', async () => {
    const h = context();
    const { deps } = freshDeps(['Europe/Berlin', '192.168.1.10', '9000', '120', 'work', 'k']);
    await runInitCommand(deps)(h.ctx);
    expect(h.out()).toContain('requires a password before the service');
    expect(h.out()).toContain('quotameter passwd');
  });

  it('no password warning on the loopback default', async () => {
    const h = context();
    const { deps } = freshDeps(['UTC', '', '', '', '']);
    await runInitCommand(deps)(h.ctx);
    expect(h.out()).not.toContain('requires a password');
  });
});

describe('runInitCommand (existing configuration, task 132, decision D-101)', () => {
  it('displays the current settings masked, then keeps everything on Enter — no write', async () => {
    const h = context();
    const code = await runInitCommand(existingDeps(['', '', '', '']))(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('Existing configuration found at');
    expect(h.out()).toContain('Press Enter at a question to keep the current value.');
    expect(h.out()).toContain('Time zone:         Europe/Berlin');
    expect(h.out()).toContain("Accounts:          'work' (API key configured, hidden)");
    expect(h.out()).toContain('No changes — the existing configuration is kept');
    // The §6.3 invariant: the stored key is never displayed.
    expect(h.out() + h.err()).not.toContain('sk-configured-key');
  });

  it('changes only the typed setting; everything else and the accounts are preserved', async () => {
    const h = context();
    const writes: WriteInitConfigOptions[] = [];
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['', '', '9001', '']),
      readExisting: async () => ({
        state: 'existing' as const,
        config: EXISTING,
        passwordPending: false,
      }),
      persistConfig: async (options) => {
        writes.push(options);
      },
    })(h.ctx);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    const written = writes[0];
    if (written !== undefined) {
      expect(written.config.server.port).toBe(9001);
      expect(written.config.server.host).toBe('127.0.0.1');
      expect(written.config.app.timezone).toBe('Europe/Berlin');
      expect(written.config.app.pollingIntervalSeconds).toBe(120);
      expect(written.config.app.historyRetentionDays).toBe(90);
      expect(written.config.accounts).toEqual(EXISTING.accounts);
    }
    expect(h.out()).toContain('Configuration settings after this run:');
    expect(h.out()).toContain('Port:              9001');
    expect(h.out()).toContain('Configuration updated at');
  });

  it('asks exactly the four settings questions in retain mode', async () => {
    const prompts: string[] = [];
    const prompter: PromptHandle = {
      ask: (prompt) => {
        prompts.push(`ask: ${prompt}`);
        return Promise.resolve('');
      },
      askSecret: (prompt) => {
        prompts.push(`secret: ${prompt}`);
        return Promise.resolve('');
      },
      close: () => undefined,
    };
    const h = context();
    await runInitCommand({ ...existingDeps([]), createPrompter: () => prompter })(h.ctx);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain('IANA time zone (Enter to keep Europe/Berlin)');
    expect(prompts[1]).toContain('Bind host (Enter to keep 127.0.0.1)');
    expect(prompts[2]).toContain('Port (Enter to keep 9000)');
    expect(prompts[3]).toContain('Polling interval in seconds (Enter to keep 120)');
  });

  it('a remote bind without a password is written pending, with the passwd remedy (§15.1, D-101)', async () => {
    const h = context();
    const writes: WriteInitConfigOptions[] = [];
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '0.0.0.0', '', '', '']),
      readExisting: async () => ({ state: 'none' }),
      persistConfig: async (options) => {
        writes.push(options);
      },
    })(h.ctx);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    const written = writes[0];
    if (written !== undefined) {
      expect(written.config.server.host).toBe('0.0.0.0');
      expect(written.config.auth.passwordHash).toBeUndefined();
    }
    expect(h.out()).toContain('Configuration written to');
    expect(h.out()).toContain(
      'A password is required before the service starts: set one with quotameter passwd.',
    );
  });

  it('changing to a remote bind on a re-run without a stored hash is pending too', async () => {
    const h = context();
    const writes: WriteInitConfigOptions[] = [];
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['', '0.0.0.0', '', '']),
      readExisting: async () => ({ state: 'existing', config: EXISTING, passwordPending: false }),
      persistConfig: async (options) => {
        writes.push(options);
      },
    })(h.ctx);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    if (writes[0] !== undefined) {
      expect(writes[0].config.server.host).toBe('0.0.0.0');
      expect(writes[0].config.auth.passwordHash).toBeUndefined();
    }
    expect(h.out()).toContain('Configuration updated at');
    expect(h.out()).toContain('set one with quotameter passwd');
  });

  it('a pending existing configuration is displayed with its remedy and kept', async () => {
    const h = context();
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['', '', '', '']),
      readExisting: async () => ({
        state: 'existing',
        config: { ...EXISTING, server: { ...EXISTING.server, host: '0.0.0.0' } },
        passwordPending: true,
      }),
      persistConfig: async () => {
        throw new Error('persistConfig must not run for a no-change run');
      },
    })(h.ctx);
    expect(code).toBe(0);
    expect(h.out()).toContain('Existing configuration found at');
    expect(h.out()).toContain(
      'No password is configured yet — the service will not start until quotameter passwd sets one.',
    );
    expect(h.out()).toContain('No changes — the existing configuration is kept');
  });

  it('closed input during a re-run cancels and writes nothing', async () => {
    const h = context();
    await expect(runInitCommand(existingDeps(['Europe/Berlin', '']))(h.ctx)).rejects.toThrow(
      'input closed before the questions were answered — initialization cancelled',
    );
  });

  it('an existing-but-invalid configuration is refused and never overwritten', async () => {
    const h = context();
    const deps: InitDeps = {
      createPrompter: () => {
        throw new Error('a prompter must not be constructed for a refusal');
      },
      readExisting: async () => ({
        state: 'invalid',
        problems: ['server.port: must be <= 65535'],
      }),
      persistConfig: async () => {
        throw new Error('persistConfig must not run for a refusal');
      },
    };
    const code = await runInitCommand(deps)(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('quotameter init: an existing configuration was found at');
    expect(h.err()).toContain('but it is invalid — nothing was changed:');
    expect(h.err()).toContain('quotameter init:   server.port: must be <= 65535');
    expect(h.err()).toContain('quotameter init: fix or remove the file, then run init again.');
    expect(h.out()).toBe('');
  });
});

describe('runInitCommand (stale-detection guard, review round P1)', () => {
  /**
   * The guard's contract: the file is re-read immediately before any
   * write, and a run whose detection is no longer current refuses with
   * nothing written — the deterministic interleave is a `readExisting`
   * seam whose second call (the guard's re-read) reports the mutated
   * state, exactly what a foreign writer landing between the display and
   * the persistence produces. The real-filesystem twins (foreign bytes
   * preserved) live in `test/integration/cli-init-idempotent.spec.ts`.
   */
  it('refuses when the configuration changes between display and write', async () => {
    const h = context();
    let reads = 0;
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['', '', '9001', '']),
      readExisting: async () => {
        reads += 1;
        return reads === 1
          ? { state: 'existing' as const, config: EXISTING, passwordPending: false }
          : {
              state: 'existing' as const,
              config: { ...EXISTING, server: { ...EXISTING.server, port: 4242 } },
              passwordPending: false,
            };
      },
      persistConfig: async () => {
        throw new Error('persistConfig must not run over a changed configuration');
      },
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('quotameter init: the configuration changed while init was running');
    expect(h.err()).toContain('nothing was written');
    expect(h.err()).toContain('Run init again to see the current values.');
    expect(h.out()).not.toContain('Configuration updated at');
  });

  it('a fresh run refuses when the file is created before the write (no clobber)', async () => {
    const h = context();
    let reads = 0;
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['UTC', '', '', '', '']),
      readExisting: async () => {
        reads += 1;
        return reads === 1
          ? { state: 'none' as const }
          : { state: 'existing' as const, config: EXISTING, passwordPending: false };
      },
      persistConfig: async () => {
        throw new Error('persistConfig must not run over a foreign file');
      },
    })(h.ctx);
    expect(code).toBe(1);
    expect(h.err()).toContain('the configuration changed while init was running');
    expect(h.out()).not.toContain('Configuration written to');
  });

  it('a re-read of the same configuration in a fresh object does not refuse', async () => {
    // The guard compares structurally, not by identity — a second read
    // yielding equal values (a fresh parse of an untouched file) lets the
    // consented write proceed.
    const h = context();
    const writes: WriteInitConfigOptions[] = [];
    let reads = 0;
    const code = await runInitCommand({
      createPrompter: () => prompterWith(['', '', '9001', '']),
      readExisting: async () => {
        reads += 1;
        return {
          state: 'existing' as const,
          config: reads === 1 ? EXISTING : structuredClone(EXISTING),
          passwordPending: false,
        };
      },
      persistConfig: async (options) => {
        writes.push(options);
      },
    })(h.ctx);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(h.out()).toContain('Configuration updated at');
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
