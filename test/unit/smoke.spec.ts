import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION } from '../../src/server/main';
import { satisfiesMinimum } from '../../src/util/version';

/**
 * Smoke test: proves the Vitest pipeline executes TypeScript specs on the
 * current runtime, that the runtime satisfies the declared minimum Node.js
 * version (spec §3), and — since task 129 — that every minimum declaration
 * names the same version: the launcher derives its gate from `engines.node`
 * (the single source of truth), and the server gate's constant mirrors it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('test environment', () => {
  it('runs TypeScript specs', () => {
    const answer: number = 6 * 7;
    expect(answer).toBe(42);
  });

  it('runs on the minimum supported Node.js version', () => {
    expect(satisfiesMinimum(process.versions.node, MINIMUM_NODE_VERSION)).toBe(true);
  });

  it('declares one runtime minimum everywhere', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });
});
