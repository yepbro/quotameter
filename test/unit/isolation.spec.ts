import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir, deferList, withFakeTimers, withTempDir } from "../helpers/isolation";

describe("isolation helpers", () => {
  it("withTempDir provides a unique writable directory and removes it", async () => {
    let seen: string | undefined;
    await withTempDir(async (dir) => {
      seen = dir.path;
      writeFileSync(dir.sqlitePath("db.sqlite"), "x");
      expect(existsSync(join(dir.path, "db.sqlite"))).toBe(true);
    });
    expect(seen).toBeDefined();
    expect(existsSync(seen!)).toBe(false);
  });

  it("withTempDir removes the directory even when the body throws", async () => {
    let seen: string | undefined;
    await expect(
      withTempDir(async (dir) => {
        seen = dir.path;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen!)).toBe(false);
  });

  it("createTempDir returns distinct directories and remove() is idempotent", async () => {
    const a = await createTempDir();
    const b = await createTempDir();
    expect(a.path).not.toBe(b.path);
    await a.remove();
    await a.remove(); // twice must not throw
    await b.remove();
  });

  it("deferList flushes in reverse order exactly once", async () => {
    const order: number[] = [];
    const cleanup = deferList();
    cleanup.defer(() => {
      order.push(1);
    });
    cleanup.defer(() => {
      order.push(2);
    });
    await cleanup.flush();
    await cleanup.flush(); // second call is a no-op
    expect(order).toEqual([2, 1]);
    expect(() => cleanup.defer(() => {})).toThrow(/already ran/);
  });

  it("withFakeTimers restores real timers even on failure", async () => {
    const spy = vi.fn();
    await expect(
      withFakeTimers(async (clock) => {
        setTimeout(spy, 1_000);
        clock.advanceMs(1_000);
        expect(spy).toHaveBeenCalledTimes(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Real timers again: a short real timeout fires without advancing.
    const realSpy = vi.fn();
    setTimeout(realSpy, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(realSpy).toHaveBeenCalledTimes(1);
  });
});
