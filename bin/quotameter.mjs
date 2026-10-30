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
 */
import { readFileSync } from 'node:fs';

const MINIMUM = [22, 13, 0];

function isBelowMinimum(version, minimum) {
  const current = version.split('.').map(Number);
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

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);

// Fast path with a fixed contract (CI install smoke): a leading --version
// or -v prints exactly the package version. It must not load src/cli/, so
// it also works from the pre-packaging tarball, which ships bin/ only.
// All exits below set process.exitCode and let the event loop drain
// instead of calling process.exit(): an immediate exit can truncate
// buffered pipe writes, and nothing else keeps the loop alive here.
if (args[0] === '--version' || args[0] === '-v') {
  console.log(pkg.version);
  process.exitCode = 0;
} else {
  try {
    const mod = await import('./../src/cli/main.js');
    const runCli = mod.runCli ?? mod.default?.runCli;
    if (typeof runCli !== 'function') {
      console.error(
        `quotameter ${pkg.version} — this installation has an unusable CLI entry module; ` +
          'reinstall the quotameter package',
      );
      process.exitCode = 1;
    } else {
      process.exitCode = await runCli(args, { version: pkg.version });
    }
  } catch (error) {
    // A missing module means an installation that ships bin/ without the
    // compiled command modules (the tarball until the packaging tasks);
    // anything else is a real defect and must surface as itself.
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        `quotameter ${pkg.version} — this installation is missing the CLI command modules; ` +
          'reinstall the quotameter package',
      );
    } else {
      console.error(`quotameter: internal CLI error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}
