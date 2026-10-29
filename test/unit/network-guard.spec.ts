import { get } from "node:http";
import { describe, expect, it } from "vitest";
// The guard is installed by the project setup file; these tests prove it.

/**
 * Verifies the no-network guard (test/helpers/network-guard.ts): requests to
 * external hosts are blocked loudly, loopback stays available for the mock
 * provider server.
 */
describe("no-network guard", () => {
  it("blocks fetch to external hosts with an actionable error", async () => {
    await expect(fetch("https://api.z.ai/api/v1/usage")).rejects.toThrow(
      /no-network guard/u,
    );
  });

  it("blocks fetch to external hosts via URL objects", async () => {
    await expect(fetch(new URL("https://example.com/"))).rejects.toThrow(/no-network guard/u);
  });

  it("allows loopback fetch to reach the network layer", async () => {
    // Nothing listens on this port: the guard must NOT be the failure reason.
    await expect(fetch("http://127.0.0.1:9/")).rejects.toThrow(
      /ECONNREFUSED|fetch failed/u,
    );
  });

  it("blocks node:http requests to external hosts", async () => {
    const error = await new Promise<Error>((resolve) => {
      const req = get("http://93.184.216.34/");
      req.on("error", (err) => resolve(err as Error));
    });
    expect(error.message).toMatch(/no-network guard/u);
  });
});
