/**
 * No-network guard for the default automated suite (spec §17).
 *
 * Registered as a setup file for every Vitest project. Outbound requests to
 * non-loopback hosts fail immediately with a clear error instead of silently
 * reaching real provider endpoints: the suite must run without credentials
 * and without Internet access. Tests that need HTTP use the loopback mock
 * provider server (test/helpers/mockProviderServer.ts).
 *
 * Allowed hosts: `localhost`, `127.0.0.0/8`, `::1`, and the empty host
 * (relative URLs used by component tests).
 */

const NO_NETWORK_MESSAGE = (host: string) =>
  `Blocked outbound network request to "${host}" by the test no-network guard. ` +
  `Use the local mock provider server (test/helpers/mockProviderServer.ts) instead.`;

function isLoopback(host: string | undefined): boolean {
  if (!host || host === '') return true; // relative URL / default
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(\.\d+){3}$/.test(normalized);
}

function assertAllowedHost(host: string | undefined): void {
  if (!isLoopback(host)) {
    throw new Error(NO_NETWORK_MESSAGE(host ?? '<unknown>'));
  }
}

type FetchLike = typeof globalThis.fetch;

export async function installNetworkGuard(): Promise<void> {
  // Guard `fetch`.
  const originalFetch: FetchLike | undefined = globalThis.fetch;
  if (originalFetch && !('__quotameterGuarded' in originalFetch)) {
    const guardedFetch: FetchLike & { __quotameterGuarded?: boolean } = async (
      input: Parameters<FetchLike>[0],
      init?: Parameters<FetchLike>[1],
    ) => {
      const url =
        typeof input === 'string'
          ? new URL(input, 'http://localhost').hostname
          : input instanceof URL
            ? input.hostname
            : undefined;
      assertAllowedHost(url);
      return originalFetch!(
        input as Parameters<FetchLike>[0],
        init as Parameters<FetchLike>[1] | undefined,
      );
    };
    guardedFetch.__quotameterGuarded = true;
    globalThis.fetch = guardedFetch as typeof globalThis.fetch;
  }

  // Guard `node:http` / `node:https` clients. ESM namespaces of built-in
  // modules are read-only, so requests are intercepted at the default agents'
  // socket-creation layer instead: external hosts never get a socket.
  const [{ globalAgent: httpAgent }, { globalAgent: httpsAgent }] = await Promise.all([
    import('node:http'),
    import('node:https'),
  ]);
  for (const agent of [httpAgent, httpsAgent]) {
    const originalCreateConnection = agent.createConnection.bind(agent);
    agent.createConnection = (
      options: { host?: string; hostname?: string },
      callback: (err: Error | null, socket?: unknown) => void,
    ) => {
      const host = options.host ?? options.hostname;
      if (!isLoopback(host)) {
        callback(new Error(NO_NETWORK_MESSAGE(host ?? '<unknown>')));
        return undefined as unknown as ReturnType<typeof originalCreateConnection>;
      }
      return originalCreateConnection(options, callback);
    };
  }
}

await installNetworkGuard();
