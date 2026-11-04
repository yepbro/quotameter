import { Agent, get } from 'node:http';
import { Agent as HttpsAgent, get as httpsGet } from 'node:https';
import { describe, expect, it } from 'vitest';
import { installNetworkGuard } from '../helpers/network-guard';
// The guard is installed by the project setup file; these tests prove it.

/**
 * Verifies the no-network guard (test/helpers/network-guard.ts): requests to
 * external hosts are blocked loudly, loopback stays available for the mock
 * provider server, and no fetch input shape passes the guard uninspected.
 */
describe('no-network guard', () => {
  it('blocks fetch to external hosts with an actionable error', async () => {
    await expect(fetch('https://api.z.ai/api/v1/usage')).rejects.toThrow(/no-network guard/u);
  });

  it('blocks fetch to external hosts via URL objects', async () => {
    await expect(fetch(new URL('https://example.com/'))).rejects.toThrow(/no-network guard/u);
  });

  it('blocks fetch to external hosts via Request objects', async () => {
    await expect(fetch(new Request('https://api.z.ai/api/v1/usage'))).rejects.toThrow(
      /no-network guard/u,
    );
  });

  it('rejects fetch inputs whose shape the guard cannot inspect', async () => {
    // A non-Request object is webidl-coerced by fetch via ToString: trusting
    // any of its properties would inspect a decoy host, so the guard refuses
    // the shape instead of guessing one.
    const coercible = { toString: () => 'https://example.com/' };
    await expect(fetch(coercible as unknown as Parameters<typeof fetch>[0])).rejects.toThrow(
      /unrecognized input/u,
    );
    await expect(fetch(42 as unknown as Parameters<typeof fetch>[0])).rejects.toThrow(
      /unrecognized input/u,
    );
  });

  it('blocks fetch to external hosts via tampered URL accessors', async () => {
    // The extraction reads what fetch reads — the stringified URL — not a
    // shadowable `hostname` accessor handing over a decoy loopback host.
    const url = new URL('https://example.com/');
    Object.defineProperty(url, 'hostname', { value: '127.0.0.1' });
    await expect(fetch(url)).rejects.toThrow(/no-network guard/u);
  });

  it('blocks fetch to external hosts via tampered Request url properties', async () => {
    // Same alignment: the internal-slot-backed prototype getter, never an
    // own `url` property shadowing it.
    const request = new Request('https://example.com/');
    Object.defineProperty(request, 'url', { value: 'http://127.0.0.1:9/' });
    await expect(fetch(request)).rejects.toThrow(/no-network guard/u);
  });

  it('allows loopback fetch to reach the network layer', async () => {
    // Nothing listens on this port: the guard must NOT be the failure reason.
    await expect(fetch('http://127.0.0.1:9/')).rejects.toThrow(/ECONNREFUSED|fetch failed/u);
  });

  it('allows loopback fetch via Request objects to reach the network layer', async () => {
    // Nothing listens on this port: the guard must NOT be the failure reason.
    await expect(fetch(new Request('http://127.0.0.1:9/'))).rejects.toThrow(
      /ECONNREFUSED|fetch failed/u,
    );
  });

  it('blocks node:http requests to external hosts', async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = get('http://192.0.2.1/');
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/no-network guard/u);
  });

  it('blocks node:http requests to external hosts with a per-request default agent', async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = get('http://192.0.2.1/', { agent: false });
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/no-network guard/u);
  });

  it('blocks node:http requests to external hosts through custom agents', async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = get('http://192.0.2.1/', { agent: new Agent() });
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/no-network guard/u);
  });

  it('blocks node:https requests to external hosts through custom agents', async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = httpsGet('https://192.0.2.1/', { agent: new HttpsAgent() });
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/no-network guard/u);
  });

  it('allows loopback node:http requests through custom agents to reach the network layer', async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = get('http://127.0.0.1:9/', { agent: new Agent() });
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/ECONNREFUSED/u);
  });

  it('allows loopback node:https requests through custom agents to reach the network layer', async () => {
    // The blocked-path tests never invoke the original https
    // createConnection; this pin proves the this-bound delegation works.
    const error = await new Promise<Error>((resolve) => {
      const req = httpsGet('https://127.0.0.1:9/', { agent: new HttpsAgent() });
      req.on('error', (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/ECONNREFUSED/u);
  });

  it('is idempotent: reinstalling leaves the guarded hooks untouched', async () => {
    const fetchBefore = globalThis.fetch;
    const httpCreateConnectionBefore = Agent.prototype.createConnection;
    const httpsCreateConnectionBefore = HttpsAgent.prototype.createConnection;
    await installNetworkGuard();
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(Agent.prototype.createConnection).toBe(httpCreateConnectionBefore);
    expect(HttpsAgent.prototype.createConnection).toBe(httpsCreateConnectionBefore);
  });
});
