/**
 * No-network guard for the default automated suite (spec §17).
 *
 * Registered as a setup file for every Vitest project (and via `--import`
 * in spawned CLI test processes). Outbound requests to non-loopback hosts
 * fail immediately with a clear error instead of silently reaching real
 * provider endpoints: the suite must run without credentials and without
 * Internet access. Tests that need HTTP use the loopback mock provider
 * server (test/helpers/mockProviderServer.ts).
 *
 * What is guarded (U-031, decision D-154):
 * - `fetch`: `string`, `URL`, and `Request` inputs are inspected; any other
 *   input shape is rejected outright, never passed through uninspected.
 * - `node:http` / `node:https` at `Agent.prototype.createConnection`: the
 *   default global agents and any agent that does not carry its own
 *   `createConnection` (custom `new Agent()` instances included).
 *
 * Deliberately NOT guarded (documented in docs/agents/gotchas.md): a
 * `createConnection` passed as a request or agent option, direct
 * `node:net` / `node:tls` sockets, direct `undici` module calls,
 * `node:dns`, and fetch redirect following (undici follows `Location`
 * after the initial input is inspected — keep `redirect: 'error'` in
 * test fetches, as the provider transport does) — closing those would
 * mean intercepting socket creation or response processing process-wide,
 * which §17's accidental-use tripwire does not demand.
 *
 * Allowed hosts: `localhost`, `127.0.0.0/8`, `::1`, and the empty host
 * (relative URLs used by component tests).
 */

const NO_NETWORK_MESSAGE = (host: string) =>
  `Blocked outbound network request to "${host}" by the test no-network guard. ` +
  `Use the local mock provider server (test/helpers/mockProviderServer.ts) instead.`;

const UNRECOGNIZED_INPUT_MESSAGE = (kind: string) =>
  `Blocked fetch call with an unrecognized input (${kind}) by the test no-network guard. ` +
  `Pass a string, URL, or Request so the host can be inspected.`;

function isLoopback(host: string | undefined): boolean {
  if (!host || host === '') return true; // relative URL / default
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(\.\d+){3}$/.test(normalized);
}

function assertAllowedHost(host: string): void {
  if (!isLoopback(host)) {
    throw new Error(NO_NETWORK_MESSAGE(host));
  }
}

type FetchLike = typeof globalThis.fetch;
type FetchInput = Parameters<FetchLike>[0];

/**
 * WHATWG fetch accepts `string | URL | Request` and webidl-coerces anything
 * else via `ToString` at the call boundary. Inspecting a coerced host would
 * trust the wrong source — an object whose `toString()` yields an external
 * URL while its properties look loopback is a decoy the guard must not
 * guess past — so every other shape fails closed here.
 */
function hostnameOfFetchInput(input: FetchInput): string {
  if (typeof input === 'string') return new URL(input, 'http://localhost').hostname;
  // The instance branches read what fetch itself reads — fetch stringifies
  // a URL at the call boundary and reads a Request's internal-slot-backed
  // prototype getter — because public accessors (`hostname`, an own `url`)
  // can be shadowed and would hand the guard a decoy host.
  if (input instanceof URL) return new URL(String(input)).hostname;
  if (typeof Request === 'function' && input instanceof Request) {
    // Base-less parsing (a URL's href and `Request#url` are
    // spec-guaranteed absolute) keeps a spec-violating relative value a
    // loud failure instead of a silent pass-through.
    return new URL(String(Reflect.get(Request.prototype, 'url', input))).hostname;
  }
  throw new Error(UNRECOGNIZED_INPUT_MESSAGE(typeof input));
}

type GuardableCreateConnection = (
  this: unknown,
  options: { host?: string; hostname?: string },
  callback: (err: Error | null, socket?: unknown) => void,
) => unknown;

export async function installNetworkGuard(): Promise<void> {
  // Guard `fetch`.
  const originalFetch: FetchLike | undefined = globalThis.fetch;
  if (originalFetch && !('__quotameterGuarded' in originalFetch)) {
    const guardedFetch: FetchLike & { __quotameterGuarded?: boolean } = async (
      input: FetchInput,
      init?: Parameters<FetchLike>[1],
    ) => {
      assertAllowedHost(hostnameOfFetchInput(input));
      return originalFetch(
        input as Parameters<FetchLike>[0],
        init as Parameters<FetchLike>[1] | undefined,
      );
    };
    guardedFetch.__quotameterGuarded = true;
    globalThis.fetch = guardedFetch as typeof globalThis.fetch;
  }

  // Guard `node:http` / `node:https` clients. ESM namespaces of built-in
  // modules are read-only, so requests are intercepted at the agents'
  // socket-creation layer instead: external hosts never get a socket. The
  // patch sits on `Agent.prototype` — not only the global agents — so custom
  // `new Agent()` instances inherit it; an agent or request carrying its own
  // `createConnection` option is the documented gap named in the docblock.
  // `http.Agent` is patched before `https.Agent` so an inherited (rather
  // than own) https `createConnection` is skipped by the marker instead of
  // double-wrapping.
  const [{ Agent: HttpAgent }, { Agent: HttpsAgent }] = await Promise.all([
    import('node:http'),
    import('node:https'),
  ]);
  for (const agentClass of [HttpAgent, HttpsAgent]) {
    const prototype = agentClass.prototype as unknown as Record<
      string,
      GuardableCreateConnection | undefined
    >;
    const originalCreateConnection = prototype.createConnection;
    if (
      typeof originalCreateConnection !== 'function' ||
      '__quotameterGuarded' in originalCreateConnection
    ) {
      continue;
    }
    const guardedCreateConnection: GuardableCreateConnection & { __quotameterGuarded?: boolean } =
      function (options, callback) {
        const host = options?.host ?? options?.hostname;
        if (!isLoopback(host)) {
          callback(new Error(NO_NETWORK_MESSAGE(host ?? '<unknown>')));
          return undefined;
        }
        return originalCreateConnection.call(this, options, callback);
      };
    guardedCreateConnection.__quotameterGuarded = true;
    prototype.createConnection = guardedCreateConnection;
  }
}

await installNetworkGuard();
