#!/usr/bin/env node
/**
 * Quotameter CLI entry point (spec §5.2).
 *
 * Thin, build-free launcher: it gates the runtime, answers `--version`
 * without loading the command modules, and delegates everything else to
 * `src/cli/` (task 128). Plain JavaScript on purpose: the binary must run
 * from an npm installation without a build step, on any machine that
 * satisfies the declared minimum runtime.
 *
 * Runtime gate (task 129, spec §5.1, decision D-098): the declared minimum
 * is derived from the manifest's `engines.node` field — the single source
 * of truth, so the gate cannot drift from the declaration npm surfaces —
 * and a runtime below it (or one whose version string cannot be parsed) is
 * rejected with an actionable message before anything under `src/` loads.
 * The gate fails closed: an unreadable manifest, an unexpected `engines`
 * shape, or an unparseable `process.versions.node` all refuse to run.
 *
 * Delegation uses a dynamic import so the version gate above always runs
 * first (a static import would be evaluated before it), and resolves the
 * handler through `mod.runCli ?? mod.default`: under jiti (development and
 * tests) the TypeScript module arrives as a CommonJS namespace whose
 * exports sit on `default`, while the published build is real ESM with
 * named exports. The specifier is deliberately './'-prefixed ('./../'
 * instead of '../'): jiti's loader hook skips anything that does not start
 * with './' or 'file://', and a plain '../' would fall through to Node's
 * resolver, which cannot map the '.js' spelling onto the TypeScript source.
 * Until the packaging tasks ship compiled `src/` in the tarball, an
 * installation without command modules fails with a clear message instead
 * of a module-not-found stack trace.
 *
 * All exits set process.exitCode and let the event loop drain instead of
 * calling process.exit(): an immediate exit can truncate buffered pipe
 * writes, and nothing else keeps the loop alive here.
 */
import { readFileSync } from 'node:fs';

/**
 * Parses `engines.node`, which must declare exactly `>=X.Y.Z` — the
 * project's manifest contract (spec §20). Any other shape returns
 * `undefined` and the gate fails closed: a launcher that cannot determine
 * its own minimum must not run.
 */
function declaredMinimum(declared) {
  if (typeof declared !== 'string') return undefined;
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(declared.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Splits `process.versions.node` into numeric segments, or returns `null`
 * when it is not 1–3 dot-separated numeric segments after cutting an
 * optional prerelease/build suffix (the first `-` or `+` onward — the same
 * prefix ordering as `src/util/version.ts`, duplicated in plain JS because
 * the launcher runs before anything can be compiled; task 129 pins the
 * equivalence with the shared boundary matrix in
 * `test/helpers/nodeVersionGate.ts`). Missing segments count as zero.
 */
function numericSegments(version) {
  const cut = version.search(/[+-]/);
  const numeric = cut === -1 ? version : version.slice(0, cut);
  const parts = numeric.split('.');
  // Written without nested regex quantifiers on purpose: keeps the check
  // trivially auditable (the src/util/version.ts precedent).
  const valid = parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p));
  if (!valid) return null;
  return [0, 1, 2].map((i) => Number(parts[i] ?? 0));
}

function isBelowMinimum(current, minimum) {
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] !== minimum[i]) return current[i] < minimum[i];
  }
  return false;
}

const args = process.argv.slice(2);

let manifest;
try {
  manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
} catch {
  manifest = undefined;
}

// `manifest?.` (not `manifest === undefined ?`) on purpose: a manifest that
// parses to `null` is exactly as broken as one that failed to parse, and the
// optional chain routes both into the fail-closed branch (review P2).
const minimum = declaredMinimum(manifest?.engines?.node);
const current = numericSegments(process.versions.node);

if (minimum === undefined) {
  console.error(
    'quotameter: this installation has a broken package manifest ' +
      '(no readable package.json or no usable engines.node declaration); ' +
      'reinstall the quotameter package',
  );
  process.exitCode = 1;
} else if (current === null) {
  // Fail closed: a runtime whose version cannot be determined never passes.
  console.error(
    `quotameter cannot determine the Node.js version ` +
      `(process.versions.node is ${JSON.stringify(process.versions.node)}); ` +
      `quotameter requires Node.js >= ${minimum.join('.')}. ` +
      'Upgrade Node.js (for example via the official binaries or nvm) and try again.',
  );
  process.exitCode = 1;
} else if (isBelowMinimum(current, minimum)) {
  console.error(
    `quotameter requires Node.js >= ${minimum.join('.')} (found ${process.versions.node}). ` +
      'Upgrade Node.js (for example via the official binaries or nvm) and try again.',
  );
  process.exitCode = 1;
} else if (args[0] === '--version' || args[0] === '-v') {
  // Fast path with a fixed contract (CI install smoke): a leading --version
  // or -v prints exactly the package version. It must not load src/cli/, so
  // it also works from the pre-packaging tarball, which ships bin/ only.
  console.log(manifest.version);
  process.exitCode = 0;
} else {
  try {
    const mod = await import('./../src/cli/main.js');
    const runCli = mod.runCli ?? mod.default?.runCli;
    if (typeof runCli !== 'function') {
      console.error(
        `quotameter ${manifest.version} — this installation has an unusable CLI entry module; ` +
          'reinstall the quotameter package',
      );
      process.exitCode = 1;
    } else {
      process.exitCode = await runCli(args, { version: manifest.version });
    }
  } catch (error) {
    // A missing module means an installation that ships bin/ without the
    // compiled command modules (the tarball until the packaging tasks);
    // anything else is a real defect and must surface as itself.
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        `quotameter ${manifest.version} — this installation is missing the CLI command modules; ` +
          'reinstall the quotameter package',
      );
    } else {
      console.error(`quotameter: internal CLI error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}
