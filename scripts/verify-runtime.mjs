#!/usr/bin/env node
/**
 * Runtime verification for the minimum supported environment (spec §3, §20).
 *
 * Checks that the current Node.js process:
 *  1. satisfies the declared minimum version (>= 22.13.0), and
 *  2. can import the built-in `node:sqlite` module without the
 *     `--experimental-sqlite` flag and run a trivial query.
 *
 * Exits non-zero with an actionable message when either check fails.
 */
import { DatabaseSync } from "node:sqlite";

const MINIMUM = "22.13.0";

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const current = process.versions.node;
if (compareVersions(current, MINIMUM) < 0) {
  console.error(
    `quotameter requires Node.js >= ${MINIMUM} (found ${current}). ` +
      `Upgrade Node.js or use the development container: make shell`,
  );
  process.exit(1);
}

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
db.prepare("INSERT INTO probe (value) VALUES (?)").run("ok");
const row = db.prepare("SELECT value FROM probe WHERE id = ?").get(1);
db.close();

if (row?.value !== "ok") {
  console.error("node:sqlite verification failed: unexpected query result.");
  process.exit(1);
}

console.log(`runtime ok: node ${current}, node:sqlite available without flags`);
