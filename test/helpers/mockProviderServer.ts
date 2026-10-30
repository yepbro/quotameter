import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local mock HTTP provider server (spec §7.2, §17.1).
 *
 * Reusable test support that simulates provider behavior without Internet
 * access: controlled response status, body, headers, delay, and abrupt
 * connection termination. It always binds to 127.0.0.1 so it works with the
 * no-network guard and never leaks outside the test machine.
 */

/** What the mock server should do with the next requests. */
export type ProviderBehavior =
  | {
      kind: 'respond';
      status: number;
      body?: string;
      headers?: Record<string, string>;
      /** Artificial response delay in milliseconds. */
      delayMs?: number;
    }
  /** Accept the connection, then destroy the socket without a response. */
  | { kind: 'abort' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockProviderServer {
  /** Base URL, e.g. `http://127.0.0.1:34567`. */
  url: string;
  /** TCP port actually bound (useful when 0 was requested). */
  port: number;
  /** Replace the behavior applied to every subsequent request. */
  setBehavior(behavior: ProviderBehavior): void;
  /**
   * Route one request path (exact match on the request target including its
   * query string) to its own behavior, overriding the global behavior for
   * that path — multi-endpoint provider cycles (task 099's Z.ai trio) need
   * different responses per endpoint on one server.
   */
  setPathBehavior(path: string, behavior: ProviderBehavior): void;
  /** Remove every path-specific behavior; the global behavior applies again. */
  clearPathBehaviors(): void;
  /** All requests received so far, in arrival order. */
  requests: RecordedRequest[];
  /** Stop listening and reset state. Safe to call twice. */
  close(): Promise<void>;
}

export async function startMockProviderServer(port = 0): Promise<MockProviderServer> {
  const requests: RecordedRequest[] = [];
  let behavior: ProviderBehavior = { kind: 'respond', status: 200, body: '{}' };
  const pathBehaviors = new Map<string, ProviderBehavior>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      // Capture the current behavior so TypeScript can narrow the union
      // inside this closure (`behavior` itself stays assignable outside).
      // A path-specific behavior wins over the global one.
      const current = pathBehaviors.get(req.url ?? '/') ?? behavior;
      if (current.kind === 'abort') {
        res.socket?.destroy();
        return;
      }

      const respond = () => {
        const body = current.body ?? '';
        res.writeHead(current.status, {
          'content-type': 'application/json',
          ...current.headers,
        });
        res.end(body);
      };

      if (current.delayMs && current.delayMs > 0) {
        setTimeout(respond, current.delayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    setBehavior(next: ProviderBehavior) {
      behavior = next;
    },
    setPathBehavior(path: string, next: ProviderBehavior) {
      pathBehaviors.set(path, next);
    },
    clearPathBehaviors() {
      pathBehaviors.clear();
    },
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err?: Error & { code?: string }) =>
          err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve(),
        ),
      );
    },
  };
}
