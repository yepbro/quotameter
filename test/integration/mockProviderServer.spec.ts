import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProviderServer, startMockProviderServer } from '../helpers/mockProviderServer';

/**
 * Integration tests for the mock provider server itself: every provider
 * failure shape required by spec §7.2 must be reproducible locally.
 */
describe('mock provider server', () => {
  let server: MockProviderServer;

  beforeAll(async () => {
    server = await startMockProviderServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves a controlled JSON response and records the request', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: JSON.stringify({ quota: { used: 10 } }),
    });

    const response = await fetch(`${server.url}/v1/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: 'day' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quota: { used: 10 } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/usage',
      body: JSON.stringify({ range: 'day' }),
    });
  });

  it('serves a controlled error status', async () => {
    server.setBehavior({ kind: 'respond', status: 503 });

    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(503);
  });

  it('delays the response beyond a client timeout', async () => {
    server.setBehavior({ kind: 'respond', status: 200, delayMs: 500 });

    await expect(fetch(`${server.url}/`, { signal: AbortSignal.timeout(50) })).rejects.toThrow(
      /timeout/i,
    );
  });

  it('terminates the connection without a response', async () => {
    server.setBehavior({ kind: 'abort' });

    await expect(fetch(`${server.url}/`)).rejects.toThrow();
  });

  it('routes per-path behaviors, overriding the global one (task 099)', async () => {
    server.setBehavior({ kind: 'respond', status: 500, body: 'global' });
    server.setPathBehavior('/api/monitor/usage/quota/limit', {
      kind: 'respond',
      status: 200,
      body: 'primary',
    });
    server.setPathBehavior('/api/biz/subscription/list?targetType=PERSONAL', {
      kind: 'respond',
      status: 200,
      body: 'with-query',
    });

    const primary = await fetch(`${server.url}/api/monitor/usage/quota/limit`);
    expect(primary.status).toBe(200);
    expect(await primary.text()).toBe('primary');

    // Exact match includes the query string.
    const withQuery = await fetch(`${server.url}/api/biz/subscription/list?targetType=PERSONAL`);
    expect(await withQuery.text()).toBe('with-query');
    const withoutQuery = await fetch(`${server.url}/api/biz/subscription/list`);
    expect(withoutQuery.status).toBe(500);

    // Clearing restores the global behavior everywhere.
    server.clearPathBehaviors();
    const afterClear = await fetch(`${server.url}/api/monitor/usage/quota/limit`);
    expect(afterClear.status).toBe(500);
  });
});
