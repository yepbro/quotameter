import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the Vue template linting contract (task 035): malformed templates
 * must fail the lint command. Runs the project's real ESLint binary against
 * an erroneous template via stdin, exactly like a developer would.
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
  it('fails on a duplicate template attribute', () => {
    const { status, stdout } = lintStdin(
      'BrokenPlaceholder.vue',
      '<template>\n  <div id="a" id="b"></div>\n</template>\n',
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/no-duplicate-attributes/u);
  });

  it('fails on v-if combined with v-for on the same element', () => {
    const { status, stdout } = lintStdin(
      'BrokenPlaceholder.vue',
      '<script setup lang="ts">\nconst items: string[] = [];\n</script>\n<template>\n  <li v-for="item of items" v-if="items.length">{{ item }}</li>\n</template>\n',
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/no-use-v-if-with-v-for/u);
  });

  it('passes on a well-formed component', () => {
    const { status } = lintStdin(
      'ValidPlaceholder.vue',
      '<script setup lang="ts">\nconst label = "ok";\n</script>\n<template>\n  <p>{{ label }}</p>\n</template>\n',
    );
    expect(status).toBe(0);
  });
});
