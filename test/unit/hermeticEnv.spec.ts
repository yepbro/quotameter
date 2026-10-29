import { describe, expect, it } from 'vitest';
import { withQuotameterEnv } from '../helpers/hermeticEnv';

/**
 * Pins the hermeticity the helper promises (decision D-028): the
 * `QUOTAMETER_*` slice of `process.env` is fully restored — prior values,
 * previously absent keys, and when the body throws — while everything else
 * stays untouched. These properties are load-bearing for the
 * default-environment tests, so they are proven, not assumed.
 */

/** The `QUOTAMETER_*` variables currently visible in `process.env`. */
function quotameterVars(): Record<string, string | undefined> {
  const seen: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('QUOTAMETER_')) seen[name] = process.env[name];
  }
  return seen;
}

/** Runs `probe` inside the helper with a hermetic baseline set up and torn down. */
async function withBaseline(
  probe: (during: () => Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const AMBIENT = 'ambient-value';
  const previous = process.env.QUOTAMETER_TEST_BASELINE;
  process.env.QUOTAMETER_TEST_BASELINE = AMBIENT;
  try {
    await withQuotameterEnv({ QUOTAMETER_TEST_SET: 'set-value' }, async () => {
      await probe(quotameterVars);
    });
  } finally {
    if (previous === undefined) delete process.env.QUOTAMETER_TEST_BASELINE;
    else process.env.QUOTAMETER_TEST_BASELINE = previous;
  }
}

describe('withQuotameterEnv', () => {
  it('shows exactly the given variables among QUOTAMETER_* inside the body', async () => {
    await withBaseline(async (during) => {
      expect(during()).toEqual({ QUOTAMETER_TEST_SET: 'set-value' });
    });
  });

  it('restores prior values and previously absent keys afterwards', async () => {
    const before = quotameterVars();
    await withBaseline(() => Promise.resolve());
    expect(quotameterVars()).toEqual(before);
  });

  it('restores the prior state even when the body throws', async () => {
    const before = quotameterVars();
    await expect(
      withQuotameterEnv({ QUOTAMETER_TEST_SET: 'x' }, async () => {
        throw new Error('body exploded');
      }),
    ).rejects.toThrow('body exploded');
    expect(quotameterVars()).toEqual(before);
  });

  it('leaves non-QUOTAMETER_* environment entries untouched', async () => {
    const marker = 'hermetic-env-spec-marker';
    const previous = process.env[marker];
    process.env[marker] = 'untouched';
    try {
      await withQuotameterEnv({ QUOTAMETER_TEST_SET: 'x' }, () => Promise.resolve());
      expect(process.env[marker]).toBe('untouched');
    } finally {
      if (previous === undefined) delete process.env[marker];
      else process.env[marker] = previous;
    }
  });

  it('refuses non-QUOTAMETER_* variable names without touching the environment', async () => {
    const before = quotameterVars();
    const nodeEnvBefore = process.env.NODE_ENV;
    await expect(withQuotameterEnv({ NODE_ENV: 'test' }, () => Promise.resolve())).rejects.toThrow(
      /accepts only QUOTAMETER_\* variables, got 'NODE_ENV'/,
    );
    // The refusal happens before any write: NODE_ENV keeps whatever the
    // ambient environment (including Vitest itself) gave it.
    expect(process.env.NODE_ENV).toBe(nodeEnvBefore);
    expect(quotameterVars()).toEqual(before);
  });
});
