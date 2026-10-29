#!/usr/bin/env node
/**
 * Quotameter CLI entry point.
 *
 * Bootstrap stage: verifies the runtime and reports the package version.
 * The full command surface (init, service control, status, logs, passwd,
 * doctor) is implemented by the CLI stages of the task plan (Stage 11).
 *
 * Plain JavaScript on purpose: the binary must run from an npm installation
 * without a build step, on any machine that satisfies the declared minimum
 * runtime.
 */
import { readFileSync } from "node:fs";

const MINIMUM = [22, 13, 0];

function isBelowMinimum(version, minimum) {
  const current = version.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    const a = current[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

if (isBelowMinimum(process.versions.node, MINIMUM)) {
  console.error(
    `quotameter requires Node.js >= 22.13.0 (found ${process.versions.node}). ` +
      'Upgrade Node.js (for example via the official binaries or nvm) and try again.',
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (process.argv.includes("--version")) {
  console.log(pkg.version);
} else {
  console.log(`quotameter ${pkg.version} — the CLI is not implemented yet (bootstrap stage)`);
}
