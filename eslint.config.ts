import eslint from "@eslint/js";
import globals from "globals";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

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
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "reports/**",
      "test-results/**",
      "playwright-report/**",
      "ui/dist/**",
      ".agents/**",
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // Vue single-file components: recommended template + script rules, with the
  // TypeScript parser inside <script lang="ts"> blocks.
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  // Node-facing code: application sources, tests, scripts, and configs.
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Browser-facing UI code.
  {
    files: ["ui/**/*.ts", "ui/**/*.vue", "test/component/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  {
    rules: {
      // The project's own conventions.
      "no-console": ["error", { allow: ["warn", "error", "info", "log"] }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
);
