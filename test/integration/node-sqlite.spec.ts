import { describe, expect, it } from "vitest";
import { withTempDir } from "../helpers/isolation";

/**
 * Proves the built-in `node:sqlite` module works under Vitest on the minimum
 * supported runtime (spec §3, §17.1): open a real file-backed database,
 * create a table, run a transaction, and read the result back.
 *
 * If this ever becomes unstable under a future runner configuration, storage
 * tests must move to `node:test` per the task plan; the accepted state is
 * that this spec passes on Node.js 22.13.0 inside the development container.
 */
describe("node:sqlite compatibility", () => {
  it("persists data across connections in a file-backed database", async () => {
    await withTempDir(async (dir) => {
      const { DatabaseSync } = await import("node:sqlite");
      const dbPath = dir.sqlitePath("compat.sqlite");

      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE probe (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          value REAL NOT NULL
        );
      `);

      const insert = db.prepare("INSERT INTO probe (name, value) VALUES (?, ?)");
      db.exec("BEGIN");
      insert.run("requests", 42);
      insert.run("tokens", 1_000.5);
      db.exec("COMMIT");

      const row = db.prepare("SELECT COUNT(*) AS n, SUM(value) AS total FROM probe").get() as {
        n: number;
        total: number;
      };
      expect(row.n).toBe(2);
      expect(row.total).toBeCloseTo(1042.5, 6);
      db.close();

      // A second connection sees the same data.
      const db2 = new DatabaseSync(dbPath);
      const persisted = db2.prepare("SELECT name FROM probe ORDER BY id").all() as Array<{
        name: string;
      }>;
      expect(persisted.map((r) => r.name)).toEqual(["requests", "tokens"]);
      db2.close();
    });
  });
});
