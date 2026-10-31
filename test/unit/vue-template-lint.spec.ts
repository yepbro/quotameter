import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the Vue template linting contract (task 035): malformed templates
 * must fail the lint command. Runs the project's real ESLint binary against
 * an erroneous template via stdin, exactly like a developer would. Each
 * test carries an explicit timeout: spawning ESLint takes 2–7 s under
 * parallel worker load, which strays past Vitest's 5 s default and made
 * these time out flakily (spec §17.3 forbids flaky tests).
 */
function lintStdin(filename: string, source: string): { status: number; stdout: string } {
  const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint');
  const result = spawnSync(eslintBin, ['--stdin', '--stdin-filename', filename], {
    input: source,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

describe('vue template linting', () => {
  it('fails on a duplicate template attribute', { timeout: 30_000 }, () => {
    const { status, stdout } = lintStdin(
      'BrokenPlaceholder.vue',
      '<template>\n  <div id="a" id="b"></div>\n</template>\n',
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/no-duplicate-attributes/u);
  });

  it('fails on v-if combined with v-for on the same element', { timeout: 30_000 }, () => {
    const { status, stdout } = lintStdin(
      'BrokenPlaceholder.vue',
      '<script setup lang="ts">\nconst items: string[] = [];\n</script>\n<template>\n  <li v-for="item of items" v-if="items.length">{{ item }}</li>\n</template>\n',
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/no-use-v-if-with-v-for/u);
  });

  it('passes on a well-formed component', { timeout: 30_000 }, () => {
    const { status } = lintStdin(
      'ValidPlaceholder.vue',
      '<script setup lang="ts">\nconst label = "ok";\n</script>\n<template>\n  <p>{{ label }}</p>\n</template>\n',
    );
    expect(status).toBe(0);
  });
});
