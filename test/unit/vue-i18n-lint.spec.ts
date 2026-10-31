import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the i18n linting contract (task 036): user-facing raw strings in
 * Vue templates must be caught unless they are explicitly exempted
 * placeholder content. Runs the project's real ESLint binary via stdin;
 * each test carries an explicit timeout because spawning ESLint can take
 * 2–7 s under parallel worker load, past Vitest's 5 s default (the same
 * §17.3 flakiness the vue-template-lint spec documents).
 */
function lintVueStdin(filename: string, source: string): { status: number; stdout: string } {
  const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint');
  const result = spawnSync(eslintBin, ['--stdin', '--stdin-filename', filename], {
    input: source,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

describe('vue-i18n raw-text linting', () => {
  it('catches a hardcoded UI label', { timeout: 30_000 }, () => {
    const { status, stdout } = lintVueStdin(
      // The filename mimics the ui/ path so the scoped i18n rule applies.
      'ui/SomePanel.vue',
      '<script setup lang="ts">\nconst enabled = true;\n</script>\n<template>\n  <button type="button">Save changes</button>\n</template>\n',
    );
    expect(status).toBe(1);
    expect(stdout).toMatch(/no-raw-text/u);
    expect(stdout).toMatch(/Save changes/u);
  });

  it('accepts catalog lookups instead of raw text', { timeout: 30_000 }, () => {
    const { status } = lintVueStdin(
      'ui/SomePanel.vue',
      '<script setup lang="ts">\nconst t = (key: string) => key;\n</script>\n<template>\n  <button type="button">{{ t(\'panel.save\') }}</button>\n</template>\n',
    );
    expect(status).toBe(0);
  });
});
