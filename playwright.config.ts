import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E configuration.
 *
 * The suite runs against a locally built UI: `ui/` is bundled by Vite and
 * served by `vite preview` on a fixed port. The application server replaces
 * the preview server in later stages; the contract tested here is the page
 * the user opens in a browser.
 */
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'reports/e2e-junit.xml' }]]
    : 'list',
  // Container runs write artifacts into the isolated data volume (see
  // compose.yaml) to avoid ownership conflicts with host-generated output.
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview:ui',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
