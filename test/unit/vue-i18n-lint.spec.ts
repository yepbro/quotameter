import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the i18n linting contract (task 036; re-tightened by task 167):
 * user-facing raw strings in Vue templates must be caught — with no
 * exemptions left, the bootstrap strings the shell carried before the
 * catalog are errors exactly like any other raw text (spec §14.1,
 * decision D-132). Runs the project's real ESLint binary via stdin; each
 * test carries an explicit timeout because spawning ESLint can take
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

  it(
    'catches the formerly exempt bootstrap strings too (no ignore list left)',
    { timeout: 30_000 },
    () => {
      // Task 167 removed the task-036 exception together with the raw
      // strings it allowed: the shell now renders these through the
      // catalog, so a regression back to raw text — including the exact
      // pre-167 spellings — must fail lint again.
      const { status, stdout } = lintVueStdin(
        'ui/SomePanel.vue',
        '<script setup lang="ts">\nconst enabled = true;\n</script>\n<template>\n  <h1>Quotameter</h1>\n  <p>Not implemented yet.</p>\n</template>\n',
      );
      expect(status).toBe(1);
      expect(stdout).toMatch(/no-raw-text/u);
      expect(stdout).toMatch(/Quotameter/u);
      expect(stdout).toMatch(/Not implemented yet\./u);
    },
  );

  it(
    'catches a static attribute literal but not its bound form (attributes option)',
    { timeout: 30_000 },
    () => {
      // The `attributes` option (D-132) extends the rule past text nodes —
      // D-131's blind spot: `title="Go home"` is raw text, while the bound
      // `:aria-label="t('…')"` expression stays legal. Exactly one raw-text
      // error in the fixture pins both halves at once.
      const { status, stdout } = lintVueStdin(
        'ui/SomePanel.vue',
        '<script setup lang="ts">\nconst t = (key: string) => key;\n</script>\n<template>\n  <nav :aria-label="t(\'nav.ariaLabel\')">\n    <a href="/x" title="Go home">{{ t(\'nav.home\') }}</a>\n  </nav>\n</template>\n',
      );
      expect(status).toBe(1);
      expect(stdout).toMatch(/no-raw-text/u);
      expect(stdout).toMatch(/Go home/u);
      expect((stdout.match(/no-raw-text/gu) ?? []).length).toBe(1);
    },
  );

  it('accepts catalog lookups instead of raw text', { timeout: 30_000 }, () => {
    const { status } = lintVueStdin(
      'ui/SomePanel.vue',
      '<script setup lang="ts">\nconst t = (key: string) => key;\n</script>\n<template>\n  <button type="button">{{ t(\'panel.save\') }}</button>\n</template>\n',
    );
    expect(status).toBe(0);
  });
});
