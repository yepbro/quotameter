#!/usr/bin/env node
/**
 * Quotameter CLI entry point (spec §5.2).
 *
 * Thin, build-free launcher: it gates the runtime, answers `--version`
 * without loading the command modules, and delegates everything else to
 * the compiled CLI under `dist/` — or, in a source checkout, to `src/cli/`
 * through jiti (task 128, task 185, decision D-195). Plain JavaScript on
 * purpose: the binary must run from an npm installation without a build
 * step, on any machine that satisfies the declared minimum runtime.
 *
 * Runtime gate (task 129, spec §5.1, decision D-098): the declared minimum
 * is derived from the manifest's `engines.node` field — the single source
 * of truth, so the gate cannot drift from the declaration npm surfaces —
 * and a runtime below it (or one whose version string cannot be parsed) is
 * rejected with an actionable message before any command module loads
 * (decision D-161's ordering, kept for both entry kinds below). The gate
 * fails closed: an unreadable manifest, an unexpected `engines` shape, or
 * an unparseable `process.versions.node` all refuse to run.
 *
 * Delegation (task 185, D-195) tries two candidates in order, after the
 * gate, through a dynamic import so the gate always runs first (a static
 * import would be evaluated before it):
 *
 *  1. `../dist/cli/main.js` — the packaged build: real Node ESM emitted by
 *     `npm run build:cli` (release builds, CI packs, or a local build), no
 *     jiti, no TypeScript sources. Dist-first is deliberate: the installed
 *     package carries only this form, and a source checkout that also has
 *     a built dist/ should exercise the packaged shape.
 *  2. `../src/cli/main.js` — the source checkout, resolved through jiti
 *     (`node --import jiti/register`, the development contract). The
 *     existence probe looks for the TypeScript file; the './'-prefixed
 *     '.js' spelling is jiti's loader-hook requirement (a plain '../'
 *     falls through to Node's resolver, which cannot map it onto the .ts).
 *
 * Every failure is actionable (spec §5.1: name the requirement and the
 * fix): a missing entry names both locations and the reinstall; a dist/
 * whose entry loaded but whose graph is broken is a damaged installation
 * to reinstall; a source checkout without jiti names the loader and the
 * build command.
 *
 * All exits set process.exitCode and let the event loop drain instead of
 * calling process.exit(): an immediate exit can truncate buffered pipe
 * writes, and nothing else keeps the loop alive here.
 */
import { existsSync, readFileSync } from 'node:fs';

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
  // or -v prints exactly the package version. It must not load the CLI
  // modules, so it also works from a tarball whose dist/ was never built.
  console.log(manifest.version);
  process.exitCode = 0;
} else {
  // Candidate resolution (D-195): the packaged build first, the source
  // checkout second. Existence is probed with URLs; the imports keep the
  // './'-prefixed relative specifier strings — jiti's loader-hook contract
  // for the source candidate (an absolute file:// URL falls into its CJS
  // require, which cannot load one), and plain Node resolves both forms
  // against this module regardless.
  const distEntryUrl = new URL('./../dist/cli/main.js', import.meta.url);
  const sourceEntryUrl = new URL('./../src/cli/main.ts', import.meta.url);
  let entrySpecifier;
  let entryKind;
  if (existsSync(distEntryUrl)) {
    entrySpecifier = './../dist/cli/main.js';
    entryKind = 'dist';
  } else if (existsSync(sourceEntryUrl)) {
    // The '.js' spelling over the '.ts' file is jiti's loader contract.
    entrySpecifier = './../src/cli/main.js';
    entryKind = 'source';
  } else {
    console.error(
      `quotameter ${manifest.version} — this installation is missing the CLI entry point ` +
        '(neither dist/cli/main.js nor src/cli/main.ts is present); ' +
        'reinstall the quotameter package',
    );
    process.exitCode = 1;
    entrySpecifier = undefined;
  }

  if (entrySpecifier !== undefined) {
    try {
      const mod = await import(entrySpecifier);
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
      const moduleNotFound =
        error &&
        (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
      if (moduleNotFound) {
        // The entry itself was probed above, so a module-not-found (or a
        // directory-import refusal — a damaged layout where a directory
        // sits at a module's path) is a broken graph behind the entry,
        // never a wrong candidate choice.
        if (entryKind === 'dist') {
          console.error(
            `quotameter ${manifest.version} — this installation is damaged: ` +
              'a module of the compiled CLI is missing; reinstall the quotameter package',
          );
        } else {
          console.error(
            `quotameter ${manifest.version} — this source checkout's CLI modules ` +
              'could not be loaded (jiti is missing from this environment, or a module ' +
              'of the checkout is absent); run through the development environment ' +
              '(node --import jiti/register) or build the packaged CLI ' +
              'with npm run build:cli',
          );
        }
      } else {
        console.error(`quotameter: internal CLI error: ${String(error)}`);
      }
      process.exitCode = 1;
    }
  }
}
