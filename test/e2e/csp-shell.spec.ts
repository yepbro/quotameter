/// <reference lib="dom" />
// (The DOM lib reference exists because this spec runs in-page assertions
// — `window`/`document` in the init script and the violation probe — while
// the project's tsconfig is the Node-only server config.)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import type { DestinationStream } from 'pino';
import { buildHttpServer } from '../../src/server/http';
import { createLogger } from '../../src/util/logger';

/**
 * The browser-level half of task 158's done-condition (spec §15.5, §17.1;
 * decision D-127): "the UI still runs" under the served policy. The rest
 * of the e2e suite drives `vite preview`, which never passes through the
 * application server — so this spec boots the real construction
 * (`buildHttpServer`) over the built UI and loads it in a real Chromium:
 * the §15.5 headers are asserted on the main response, and the page must
 * render its shell without one CSP violation event or console error.
 *
 * Runs after `make build` (the Playwright leg of `make check-all` /
 * `make test-e2e`); container runs find the built UI through DIST_DIR
 * (see compose.yaml), host/CI runs through `ui/dist` at the repo root.
 */

/**
 * The exact §15.5 CSP wire string — the same byte pin as the integration
 * suite (`test/integration/security-headers.spec.ts`), asserted here on a
 * real socket response, not an injection.
 */
const CSP_WIRE_VALUE =
  "default-src 'none';" +
  "script-src 'self';" +
  "style-src 'self';" +
  "img-src 'self';" +
  "font-src 'self';" +
  "connect-src 'self';" +
  "base-uri 'none';" +
  "form-action 'none';" +
  "frame-ancestors 'none';" +
  "object-src 'none'";

/** The built UI this spec serves: DIST_DIR in the container, ui/dist elsewhere. */
function resolveBuiltUiDist(): string {
  const dist = process.env.DIST_DIR ?? join(process.cwd(), 'ui', 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error(
      `no built UI at ${dist} — run \`make build\` before the CSP shell spec ` +
        '(the spec serves the real built bundle, not a fixture)',
    );
  }
  return dist;
}

/** A sink that discards records — the server logs nothing in a happy run. */
const discardSink: DestinationStream = { write: () => true };

let baseUrl = '';
let closeServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const server = buildHttpServer({
    host: '127.0.0.1',
    port: 0,
    logger: createLogger({ level: 'warn', destination: discardSink }),
    staticRoot: resolveBuiltUiDist(),
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => server.close();
});

test.afterAll(async () => {
  await closeServer?.();
});

/**
 * Installs both violation nets on the page — the `securitypolicyviolation`
 * DOM listener from document start (init script) and the console error
 * collector (Chromium logs each CSP refusal) — and resolves the check that
 * asserts both stayed empty. Both e2e tests run it: a policy violation
 * that appears only on a deep link must fail there too.
 */
async function expectNoCspViolations(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as { __cspViolations?: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return async () => {
    const violations = await page.evaluate(
      () => (window as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
    expect(violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  };
}

test('the shell loads and renders under the served CSP — no violations', async ({ page }) => {
  const assertNoViolations = await expectNoCspViolations(page);

  const response = await page.goto(`${baseUrl}/`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toBe(CSP_WIRE_VALUE);
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  // The static side of the D-127 caching split (revalidate-always).
  expect(response?.headers()['cache-control']).toBe('public, max-age=0');

  await expect(page.getByRole('heading', { name: 'Quotameter' })).toBeVisible();
  await assertNoViolations();
});

test('a SPA deep link serves the shell under the same policy', async ({ page }) => {
  const assertNoViolations = await expectNoCspViolations(page);
  const response = await page.goto(`${baseUrl}/accounts`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toBe(CSP_WIRE_VALUE);
  await expect(page.getByRole('heading', { name: 'Quotameter' })).toBeVisible();
  await assertNoViolations();
});
