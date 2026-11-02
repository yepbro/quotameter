import eslint from '@eslint/js';
import globals from 'globals';
import pluginSecurity from 'eslint-plugin-security';
import pluginVue from 'eslint-plugin-vue';
import pluginVueI18n from '@intlify/eslint-plugin-vue-i18n';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat configuration.
 *
 * Lints TypeScript (application, tests, scripts, configs) and Vue single-file
 * components. Security-oriented rules layer on top (task 034); i18n checks
 * for Vue templates land with task 036.
 */
export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'ui/dist/**',
      '.agents/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Vue single-file components: recommended template + script rules, with the
  // TypeScript parser inside <script lang="ts"> blocks.
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  // Node-facing code: application sources, tests, scripts, and configs.
  {
    files: [
      'src/**/*.ts',
      'test/**/*.ts',
      'scripts/**/*.mjs',
      'bin/**/*.mjs',
      '*.config.ts',
      '*.config.mjs',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Browser-facing UI code.
  {
    files: ['ui/**/*.ts', 'ui/**/*.vue', 'test/component/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  {
    rules: {
      // The project's own conventions.
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'log'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },

  // Security-oriented rules for application code (spec §15, §17.3).
  {
    files: ['src/**/*.{ts,vue}', 'ui/**/*.{ts,vue}'],
    ...pluginSecurity.configs.recommended,
    rules: {
      ...pluginSecurity.configs.recommended.rules,
      // Application code must not print to stdout/stderr directly: secrets and
      // provider payloads may only travel through the structured logger with
      // redaction (spec §15.4). The logger module enforces this from task 072.
      'no-console': 'error',
      // Exception: object-member access driven by data is pervasive in mapping
      // tables and validated at runtime boundaries (task 041 schemas); the
      // rule's signal-to-noise ratio on typed code is too low to keep on.
      'security/detect-object-injection': 'off',
      // Exception: non-literal fs calls are the configuration write path and
      // are always built from validated, schema-checked path components.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  // I18n checks for browser-facing templates (task 036; re-tightened by
  // task 167): user-facing strings must come from the English vue-i18n
  // catalog instead of raw text in templates (spec §14.1). The rule runs
  // with NO text exemptions — the bootstrap strings moved into the catalog
  // with the i18n task — and the `attributes` option extends it past its
  // text-node-only default: a static literal in a user-facing attribute is
  // raw text too (D-131's aria-label blind spot; bound forms
  // `:attr="t('…')"` are expressions and stay legal). The attribute list
  // is pinned against the completeness spec (no drift). Only the
  // no-raw-text rule is enabled: the rest of the preset assumes the
  // locale-directory layout this project replaces with the typed catalog
  // module (decision D-132).
  {
    files: ['ui/**/*.vue'],
    plugins: {
      '@intlify/vue-i18n': pluginVueI18n,
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          attributes: {
            '/.*/': [
              'abbr',
              'alt',
              'aria-description',
              'aria-label',
              'aria-placeholder',
              'aria-roledescription',
              'aria-valuetext',
              'label',
              'placeholder',
              'title',
            ],
          },
        },
      ],
    },
  },
);
