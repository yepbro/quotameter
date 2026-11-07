import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The U-054 wiring pin: `composeApplication`'s registry default must be the
 * live-configured factory. The wiring is not behaviorally observable in the
 * test environment — every composition suite injects its own `providers`
 * (the no-network guard forces them to own the HTTP boundary), and the
 * default adapter's production base URLs are unreachable under the guard —
 * so reverting the default to `createInitialAccountProvider()` (the exact
 * finding U-054 fixes) would leave every behavioral suite green. The line
 * is therefore pinned textually, the ci-workflow/playwright-junit precedent
 * for wiring the test environment cannot exercise (review round P2).
 */

describe("composeApplication's provider default is the live-configured factory (U-054)", () => {
  const source = readFileSync(new URL('../../src/server/composition.ts', import.meta.url), 'utf8');

  it('constructs the default from the live configuration over the shared services', () => {
    expect(source).toContain(
      'createConfiguredZaiProvider({ config: currentConfig, clock, logger })',
    );
  });

  it('never falls back to the CLI pre-configuration defaults factory', () => {
    expect(source).not.toContain('createInitialAccountProvider');
  });
});
