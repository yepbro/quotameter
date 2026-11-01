import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliContext } from '../../src/cli/commands';
import { runInitCommand, type InitDeps } from '../../src/cli/init';
import { configFilePath } from '../../src/config/load';
import type { PromptHandle } from '../../src/cli/prompts';
import { ZaiCodingPlanProvider } from '../../src/providers/zai-coding-plan/provider';
import { startMockProviderServer, type MockProviderServer } from '../helpers/mockProviderServer';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The initial-account connection test end-to-end through the real adapter
 * (task 133, spec §5.3 step 6, §8.1, §8.3; decision D-102): the handler's
 * real wiring — real detection, real permission enforcement, real atomic
 * write in a temporary configuration directory — with the production
 * `ZaiCodingPlanProvider` pointed at the loopback mock provider server
 * (`codingBaseUrl` is the adapter's own test seam). The mock's behaviors
 * produce both §7.2/§8.1 failure classes and the accepted path; the
 * recorded requests prove the tested credentials are the collected ones;
 * and the marker key is asserted absent from every stdout/stderr line while
 * present exactly where §6.3/D-004 say it lives (the 0600 config file).
 */

/** The marker secret every output assertion is written against (§15.4). */
const MARKER = 'sk-integration-marker-key';

interface Recorded {
  code: number;
  out: string;
  err: string;
}

/** Runs the handler with a recording output, a scripted prompter, and deps. */
async function runHandler(
  deps: InitDeps,
  flags: Record<string, boolean | string>,
  answers: readonly string[],
): Promise<Recorded> {
  const outText: string[] = [];
  const errText: string[] = [];
  const remaining = [...answers];
  const step = (): Promise<string | null> => {
    const value = remaining.shift();
    return Promise.resolve(value === undefined ? null : value);
  };
  const prompter: PromptHandle = {
    ask: step,
    askSecret: step,
    close: () => undefined,
    interrupted: () => false,
  };
  const ctx: CliContext = {
    output: {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    },
    version: 'test',
    commandPath: ['init'],
    flags,
    positionals: [],
  };
  try {
    const code = await runInitCommand({ createPrompter: () => prompter, ...deps })(ctx);
    return { code, out: outText.join(''), err: errText.join('') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, out: outText.join(''), err: `quotameter init: ${message}\n` };
  }
}

/** Reads the run's configuration file as parsed JSON. */
async function readConfig(dir: TempDir): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configFilePath(dir.path), 'utf8')) as Record<string, unknown>;
}

/** Interactive fresh-run answers: settings, account label, key, offer. */
const FULL_WITH_KEY: readonly string[] = [
  'Europe/Berlin',
  '127.0.0.1',
  '8787',
  '300',
  'work',
  MARKER,
];

describe('init initial account (real adapter, loopback mock provider)', () => {
  let mock: MockProviderServer;
  let dir: TempDir;

  beforeEach(async () => {
    mock = await startMockProviderServer();
    dir = await createTempDir('qm-init-133-');
  });

  afterEach(async () => {
    await mock.close();
    await dir.remove();
  });

  /** Deps with the real adapter against the mock and the temp config dir. */
  function realAdapterDeps(): InitDeps {
    return {
      pathEnv: { QUOTAMETER_CONFIG_DIR: dir.path },
      provider: new ZaiCodingPlanProvider({ codingBaseUrl: mock.url }),
    };
  }

  it('an accepted key: tested on the wire, stored in the file, never printed', async () => {
    mock.setBehavior({ kind: 'respond', status: 200, body: '{}' });
    const run = await runHandler(realAdapterDeps(), {}, FULL_WITH_KEY);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain('Connection test passed');
    expect(run.out).toContain("'work' (API key configured, hidden; connection test passed)");
    expect(run.out + run.err).not.toContain(MARKER);
    // The credential check is the dossier's endpoint 4 against the coding
    // base, carrying exactly the collected key (§8.1, §8.3).
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.url).toBe('/models');
    expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${MARKER}`);
    // §6.3/D-004: the secret's destination is the 0600 config file.
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([
      {
        id: 'work',
        providerId: 'zai-coding-plan',
        label: 'work',
        enabled: true,
        apiKey: MARKER,
      },
    ]);
  });

  it('a rejected key (HTTP 401) is explained with its class, offered, and kept', async () => {
    mock.setBehavior({ kind: 'respond', status: 401, body: '{}' });
    const run = await runHandler(realAdapterDeps(), {}, [...FULL_WITH_KEY, 'y']);
    expect(run.code).toBe(0);
    expect(run.err).toContain("the initial connection test for 'work' failed:");
    expect(run.err).toContain('the provider rejected the account credentials (HTTP 401)');
    expect(run.err).toContain('the provider refused the key');
    expect(run.out).toContain(
      'connection test failed: credentials-rejected — stored in error state',
    );
    expect(run.out + run.err).not.toContain(MARKER);
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([expect.objectContaining({ id: 'work', apiKey: MARKER })]);
  });

  it('declining after a rejected key writes the configuration without the account', async () => {
    mock.setBehavior({ kind: 'respond', status: 403, body: '{}' });
    const run = await runHandler(realAdapterDeps(), {}, [...FULL_WITH_KEY, 'n']);
    expect(run.code).toBe(0);
    expect(run.err).toContain('credentials (HTTP 403)');
    expect(run.out).toContain("The initial account 'work' was not created");
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([]);
  });

  it('a destroyed connection is the unavailable class: explained, kept, written', async () => {
    mock.setBehavior({ kind: 'abort' });
    const run = await runHandler(realAdapterDeps(), {}, [...FULL_WITH_KEY, '']);
    expect(run.code).toBe(0);
    expect(run.err).toContain('the check was inconclusive');
    expect(run.out).toContain(
      'connection test failed: provider-unavailable — stored in error state',
    );
    expect(run.out + run.err).not.toContain(MARKER);
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([expect.objectContaining({ id: 'work', apiKey: MARKER })]);
  });

  it('init --yes with an environment key: value tested once, name stored', async () => {
    mock.setBehavior({ kind: 'respond', status: 200, body: '{}' });
    const run = await runHandler(
      {
        ...realAdapterDeps(),
        env: { ZAI_133_KEY: MARKER },
        createPrompter: () => {
          throw new Error('a prompter must not be constructed in --yes mode');
        },
      },
      {
        yes: true,
        timezone: 'UTC',
        'account-label': 'ci',
        'api-key-env': 'ZAI_133_KEY',
      },
      [],
    );
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain(
      "'ci' (API key from environment variable 'ZAI_133_KEY', value never " +
        'stored or printed; connection test passed)',
    );
    expect(run.out + run.err).not.toContain(MARKER);
    expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${MARKER}`);
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([
      {
        id: 'ci',
        providerId: 'zai-coding-plan',
        label: 'ci',
        enabled: true,
        apiKeyEnv: 'ZAI_133_KEY',
      },
    ]);
  });

  it('init --yes keeps the account through a failed test without any prompt', async () => {
    mock.setBehavior({ kind: 'respond', status: 500, body: '{}' });
    const run = await runHandler(
      {
        ...realAdapterDeps(),
        env: { ZAI_133_KEY: MARKER },
        createPrompter: () => {
          throw new Error('a prompter must not be constructed in --yes mode');
        },
      },
      {
        yes: true,
        timezone: 'UTC',
        'account-label': 'ci',
        'api-key-env': 'ZAI_133_KEY',
      },
      [],
    );
    expect(run.code).toBe(0);
    expect(run.err).toContain('the initial connection test for');
    expect(run.err).toContain('inconclusive');
    expect(run.out).toContain('Configuration written to');
    expect(run.out + run.err).not.toContain(MARKER);
    const config = await readConfig(dir);
    expect(config.accounts).toEqual([expect.objectContaining({ apiKeyEnv: 'ZAI_133_KEY' })]);
  });
});
