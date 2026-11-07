import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Spec §17.3 (decision D-085): critical modules are held at 100% on every
// axis, judged per matching file (`perFile`) so a shortfall fails the run
// naming the exact file and axis, while the top-level numbers keep judging
// the aggregate of all files. Category → module map: time-zone logic —
// clock and rolling ranges (§10); peak-hours — the `peak-hours*` family
// (§9.3), so service files still landing join as they appear; sanitization
// — the response sanitizer (§7.4); secret-handling (§15.4) — the redacting
// logger, config permission enforcement, and atomic config writes; since
// U-060 (decision D-188) also the §15.2 auth/session/hashing quartet —
// `src/services/password-hash.ts`, `sessions.ts`, `session-cookie.ts`,
// `login-rate-limit.ts` — the secret-handling modules D-085's
// consequences said must carry their own key, each measured at its
// maximum (100 on every axis) before the key was added because the
// landed suites already exercise every arm; and since U-016 (decision
// D-089) the configuration-loading mechanics — `src/config/env.ts`,
// `load.ts`, `reload.ts` — and the shared transport
// `src/providers/transport.ts`, each lifted to its measured maximum
// first.
// Three single-branch arms inside those files are unreachable by
// construction and are the only sanctioned exceptions (D-089): their keys
// pin the achievable maximum instead of 100, so any NEW uncovered arm
// (dropping the file 0.86–2.78 pp below its pinned maximum) still fails
// the gate —
// • `env.ts` branches 97.67 — the unknown-name sort comparator's equal-key
//   arm: object keys are unique (the Proxy ownKeys invariant enforces it
//   too) and string `<`/`>` is a total order, so "neither less nor
//   greater" is impossible;
// • `load.ts` branches 99.13 — the schema-growth fallback "must be one of
//   the allowed values": every ConfigSchema union is literal-only today,
//   so Ajv always emits const line-mates for a failed anyOf;
// • `reload.ts` branches 97.22 — the `?? CONFIG_DEFAULTS.logging.level`
//   fallback: the canonical parser always materializes `logging.level`
//   and no injection seam bypasses it.
//
// The UI tree participates since U-060 (decision D-188): `include`
// covers `ui/src/**/*.ts` and `ui/src/**/*.vue` (v8 remaps the SFCs
// through the vue plugin's sourcemaps, so per-file numbers are real),
// and the `ui/src/**` key judges that tree's own aggregate at §17.3's
// floor — 90 on every axis — so server coverage cannot mask UI decay.
// A threshold key without `perFile` is judged as one group over the
// files it matches (verified in the installed runner's
// `resolveThresholds`); the measured baseline at adoption was
// statements 95.15 / branches 90.49 / functions 96.84 / lines 96.35,
// branches being the tightest margin. UI files are deliberately held
// at the aggregate floor, not the per-file 100% set: the UI is not a
// D-085 critical-module class, and its weak spots (the bootstrap
// `main.ts`, the chart runtime wrapper) count honestly inside the
// aggregate.
const criticalModuleThreshold = {
  statements: 100,
  branches: 100,
  functions: 100,
  lines: 100,
  perFile: true,
} as const;

// Spec §17.3's overall floor applied to the UI tree as its own judged
// group (U-060, decision D-188): without `perFile` the runner judges the
// aggregate of the matched files, so this is the UI's own gate beside
// the global axes, which judge `src` and `ui/src` combined.
const uiAggregateThreshold = {
  statements: 90,
  branches: 90,
  functions: 90,
  lines: 90,
} as const;

/**
 * Vitest configuration.
 *
 * Projects: `unit` and `integration` run in the plain Node environment;
 * `component` runs Vue component tests under happy-dom. All projects run
 * against the pinned minimum runtime inside the development container.
 * E2E browser tests use Playwright separately (playwright.config.ts).
 */
export default defineConfig({
  test: {
    sequence: {
      // Deterministic by default: stable file/suite ordering.
      shuffle: false,
    },
    coverage: {
      provider: 'v8',
      // Spec §17.3's gate reads on the whole product (U-060, decision
      // D-188): the server tree and the UI tree both participate — the
      // UI's `.vue` files remap through the vue plugin's sourcemaps.
      include: ['src/**/*.ts', 'ui/src/**/*.ts', 'ui/src/**/*.vue'],
      // Container runs write into the isolated data volume (see compose.yaml)
      // so host- and container-generated reports never fight over ownership.
      reportsDirectory: process.env.COVERAGE_DIR ?? 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      // Spec §17.3: the overall project target is 90%; the critical-module
      // list is held at 100% (or the documented per-axis maximum — see the
      // U-016 exception notes above and decision D-089); the UI tree's own
      // aggregate is held at 90% (U-060, decision D-188).
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        'src/util/clock.ts': criticalModuleThreshold,
        'src/util/rolling-ranges.ts': criticalModuleThreshold,
        'src/services/peak-hours*.ts': criticalModuleThreshold,
        'src/providers/sanitize.ts': criticalModuleThreshold,
        'src/util/logger.ts': criticalModuleThreshold,
        'src/config/permissions.ts': criticalModuleThreshold,
        'src/config/write.ts': criticalModuleThreshold,
        'src/providers/transport.ts': criticalModuleThreshold,
        // §15.2 auth/session/hashing, measured at 100 on every axis
        // before the keys were added (U-060, decision D-188).
        'src/services/password-hash.ts': criticalModuleThreshold,
        'src/services/sessions.ts': criticalModuleThreshold,
        'src/services/session-cookie.ts': criticalModuleThreshold,
        'src/services/login-rate-limit.ts': criticalModuleThreshold,
        // Branch maxima below 100: one unreachable arm each (D-089).
        'src/config/env.ts': { ...criticalModuleThreshold, branches: 97.67 },
        'src/config/load.ts': { ...criticalModuleThreshold, branches: 99.13 },
        'src/config/reload.ts': { ...criticalModuleThreshold, branches: 97.22 },
        // The UI tree's own aggregate gate (U-060, decision D-188).
        'ui/src/**': uiAggregateThreshold,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'component',
          environment: 'happy-dom',
          include: ['test/component/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
    ],
  },
});
