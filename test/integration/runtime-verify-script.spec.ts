import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MINIMUM_RUNTIME, VERSION_GATE_CASES } from '../helpers/nodeVersionGate';

/**
 * The runtime-verification script's own contract (task U-036, spec §5.1,
 * §17.2; decision D-161): `scripts/verify-runtime.mjs` must gate the
 * declared minimum BEFORE importing `node:sqlite` — the module is exactly
 * the unsupported feature the gate exists to withhold, so a static import
 * would crash a module-less runtime before the actionable message could
 * print. Task 129's suites pin the same boundary for `bin/quotameter.mjs`
 * and `src/util/version.ts`; this spec makes the script the third consumer
 * of the shared matrix in `test/helpers/nodeVersionGate.ts`, which is what
 * pins its deliberate plain-JS comparator copy equivalent to the canonical
 * rules (the script runs under plain `node` — no jiti, no build — and
 * cannot import `src/`).
 *
 * Both paths run against the real script as a child process: the child's
 * `process.versions.node` is faked through a data-URL `--import` preload
 * (the `cli-bin-version-gate.spec.ts` seam), and the module-less runtime
 * is simulated by registering an ESM resolve hook that throws for
 * `node:sqlite` — verified live: under that hook a static import dies
 * before any module body runs, while the correctly-gated script still
 * prints its refusal, proving the ordering behaviorally rather than by
 * text alone (the U-032 lesson). Text pins remain only for the shapes
 * execution cannot reach: the resolve hook does not intercept
 * `createRequire` requires, so the CJS sidestep and the static-import
 * spellings are banned on the source directly.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/verify-runtime.mjs');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The hook's failure marker — its absence proves the hook never fired. */
const BLOCK_MARKER = 'SIMULATED-NO-SQLITE';

/** Temp directory holding the resolve hook; created once, removed afterAll. */
let hookDir: string | undefined;
/** file:// URL of the hook module, for `module.register()` from the preload. */
let hookUrl: string | undefined;

beforeAll(() => {
  hookDir = mkdtempSync(join(tmpdir(), 'quotameter-runtime-verify-'));
  const hookPath = join(hookDir, 'block-sqlite.mjs');
  writeFileSync(
    hookPath,
    [
      `export async function resolve(specifier, context, next) {`,
      `  if (specifier === 'node:sqlite') {`,
      `    throw new Error('${BLOCK_MARKER}: node:sqlite resolve blocked');`,
      `  }`,
      `  return next(specifier, context);`,
      `}`,
      '',
    ].join('\n'),
  );
  hookUrl = pathToFileURL(hookPath).href;
});

afterAll(() => {
  if (hookDir !== undefined) rmSync(hookDir, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /**
   * Value the child's `process.versions.node` is redefined to before the
   * script module evaluates; `undefined` leaves the real runtime.
   */
  readonly fakeVersion?: string;
  /** Registers the resolve hook that refuses to resolve `node:sqlite`. */
  readonly blockSqlite?: boolean;
  /** Script to run; defaults to the repository's, fixture tests override. */
  readonly scriptPath?: string;
}

/** Builds the `--import` preload body, or `undefined` when no seam is asked for. */
function preloadBody(options: RunOptions): string | undefined {
  const lines: string[] = [];
  if (options.blockSqlite) {
    if (hookUrl === undefined) throw new Error('the resolve hook was not created in beforeAll');
    lines.push(`import { register } from 'node:module';`);
    lines.push(`register(${JSON.stringify(hookUrl)});`);
  }
  if (options.fakeVersion !== undefined) {
    lines.push(
      `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(
        options.fakeVersion,
      )}});`,
    );
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** Runs the script as a real child process; resolves when output is drained. */
function runScript(options: RunOptions = {}): Promise<RunResult> {
  const nodeArgs: string[] = [];
  const preload = preloadBody(options);
  if (preload !== undefined) {
    nodeArgs.push('--import', `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  nodeArgs.push(options.scriptPath ?? SCRIPT);
  const child = spawn(process.execPath, nodeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<RunResult>((resolve, reject) => {
    // 'close' (not 'exit'): both streams are drained by then.
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.once('error', reject);
  });
}

describe('scripts/verify-runtime.mjs — the runtime gate (task U-036)', () => {
  it('accepts the real runtime, confirming flagless node:sqlite', async () => {
    const result = await runScript();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `runtime ok: node ${process.versions.node}, node:sqlite available without flags\n`,
    );
    // stderr carries node:sqlite's ExperimentalWarning on this runtime —
    // expected (docs/agents/gotchas.md), never pinned empty.
  }, 20_000);

  it('accepts every supported matrix version (faked), reporting the faked version', async () => {
    for (const { version, outcome } of VERSION_GATE_CASES) {
      if (outcome !== 'pass') continue;
      const result = await runScript({ fakeVersion: version });
      expect(result.code, `exit 0 for ${version}`).toBe(0);
      expect(result.stdout, `success line for ${version}`).toBe(
        `runtime ok: node ${version}, node:sqlite available without flags\n`,
      );
    }
  }, 20_000);

  it('rejects every below-minimum matrix version with the actionable message', async () => {
    for (const { version, outcome } of VERSION_GATE_CASES) {
      if (outcome !== 'reject') continue;
      const result = await runScript({ fakeVersion: version });
      expect(result.code, `exit 1 for ${version}`).toBe(1);
      expect(result.stdout, `empty stdout for ${version}`).toBe('');
      expect(result.stderr, `names the minimum for ${version}`).toContain(
        `quotameter requires Node.js >= ${MINIMUM_RUNTIME}`,
      );
      expect(result.stderr, `names the found version for ${version}`).toContain(`found ${version}`);
      expect(result.stderr, `suggests the container for ${version}`).toContain('make shell');
    }
  }, 20_000);

  it('fails closed with a dedicated message when the version is unparseable', async () => {
    for (const { version } of VERSION_GATE_CASES.filter(({ outcome }) => outcome === 'invalid')) {
      const result = await runScript({ fakeVersion: version });
      expect(result.code, `exit 1 for ${JSON.stringify(version)}`).toBe(1);
      expect(result.stderr, `explains the refusal for ${JSON.stringify(version)}`).toContain(
        'cannot determine the Node.js version',
      );
      expect(result.stderr, `echoes the raw value for ${JSON.stringify(version)}`).toContain(
        JSON.stringify(version),
      );
    }
  }, 20_000);

  it('gates before node:sqlite loads: a runtime without the module still gets the message', async () => {
    // The resolve hook simulates the runtimes this script exists to reject:
    // one where `node:sqlite` does not exist. A static import would die on
    // the hook before any module body runs (verified live); the correctly
    // gated script must instead print its refusal and exit 1 with the hook
    // never having fired.
    const result = await runScript({ fakeVersion: '22.12.9', blockSqlite: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`quotameter requires Node.js >= ${MINIMUM_RUNTIME}`);
    expect(result.stderr).toContain('found 22.12.9');
    expect(result.stderr, 'the gate must exit before the import is initiated').not.toContain(
      BLOCK_MARKER,
    );
  }, 20_000);

  it('the supported path genuinely imports node:sqlite through the resolver', async () => {
    // Non-vacuity: with the module blocked, the supported runtime must fail
    // on the blocked import — proving the probe really loads `node:sqlite`
    // rather than printing a hollow success line.
    const result = await runScript({ blockSqlite: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(BLOCK_MARKER);
    expect(result.stdout).not.toContain('runtime ok');
  }, 20_000);

  it('loads node:sqlite only through the post-gate dynamic import (source pin)', () => {
    // The ESM resolve hook cannot intercept `createRequire` requires or
    // `process.getBuiltinModule` lookups (both verified live to bypass it),
    // so those sidesteps and the static spellings are banned on the source
    // directly — the only source-text pins in this suite (everything else
    // is proven by execution above).
    const source = readFileSync(SCRIPT, 'utf8');
    expect(
      source.match(/await import\('node:sqlite'\)/g)?.length,
      'exactly one dynamic node:sqlite import must exist — the post-gate ' +
        'probe; a second (e.g. a pre-gate swallowed copy) is the U-036 defect class',
    ).toBe(1);
    expect(
      source,
      'a static node:sqlite import would evaluate before the gate on every ' +
        'runtime — the U-036 defect class; keep the dynamic post-gate import',
    ).not.toMatch(/^\s*import\s+[^(\n]*from\s+['"]node:sqlite['"]/m);
    expect(source, 'a bare side-effect import is the same defect').not.toMatch(
      /^\s*import\s+['"]node:sqlite['"]/m,
    );
    expect(
      source,
      'createRequire would sidestep the ESM resolve hook this suite simulates ' +
        'module-less runtimes through',
    ).not.toContain('createRequire');
    expect(
      source,
      'process.getBuiltinModule bypasses the ESM resolve hook (verified live ' +
        'under this suite hook) — the same sidestep createRequire is banned for',
    ).not.toContain('getBuiltinModule');
  });

  it('is wired as the verify:runtime npm script, and the make target runs it', () => {
    expect(PKG.scripts['verify:runtime']).toBe('node scripts/verify-runtime.mjs');
    const recipe = readFileSync(join(REPO_ROOT, 'Makefile'), 'utf8').match(
      /^verify-runtime:.*$\n\t(.*)$/m,
    )?.[1];
    expect(
      recipe,
      'the make verify-runtime target must invoke the npm script — the ' +
        'sibling invocation shape (make build runs npm run verify:build)',
    ).toBe('@$(RUN) npm run verify:runtime');
  });
});

describe('the script fails closed on a broken manifest', () => {
  /** A fixture package: the temp root and the copied script's path. */
  interface FixturePackage {
    readonly dir: string;
    readonly scriptPath: string;
  }

  /**
   * Creates a fixture with a copied script; the manifest sits at its root.
   * `rawManifest === undefined` writes no package.json at all (the
   * unreadable-manifest arm: the read itself throws).
   */
  function fixtureScript(rawManifest?: string): FixturePackage {
    const dir = mkdtempSync(join(tmpdir(), 'quotameter-runtime-manifest-'));
    try {
      // The script resolves '../package.json' against its own file, so the
      // copy must sit in a scripts/ subdirectory of the fixture root.
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(SCRIPT, join(dir, 'scripts', 'verify-runtime.mjs'));
      if (rawManifest !== undefined) {
        writeFileSync(join(dir, 'package.json'), rawManifest);
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, scriptPath: join(dir, 'scripts', 'verify-runtime.mjs') };
  }

  it('refuses without a usable engines.node declaration', async () => {
    // 'null' is valid JSON that is not an object: it must reach the
    // manifest message, not a TypeError (the launcher review's P2 class).
    // The last two arms are the unreadable manifest itself: no file, and a
    // file that does not parse (the script's read/parse catch branch).
    const brokenManifests = [
      'null',
      '{}',
      '{"engines":{"node":"*"}}',
      '{"engines":{"node":"^22.13.0 || >=24.0.0"}}',
      '{not json',
    ];
    const cases: Array<string | undefined> = [...brokenManifests, undefined];
    for (const raw of cases) {
      const { dir, scriptPath } = fixtureScript(raw);
      try {
        const result = await runScript({ scriptPath });
        const label = raw === undefined ? '(no package.json)' : raw;
        expect(result.code, `exit 1 for manifest ${label}`).toBe(1);
        expect(result.stdout, `empty stdout for ${label}`).toBe('');
        expect(result.stderr, `names the manifest contract for ${label}`).toContain('engines.node');
        expect(result.stderr, `demands the fix for ${label}`).toContain('fix the manifest');
        expect(result.stderr, `no stack trace for ${label}`).not.toContain('TypeError');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 20_000);
});

describe('the gate derives its minimum from engines.node (fixture packages)', () => {
  /** A fixture package: the temp root and the copied script's path. */
  interface FixturePackage {
    readonly dir: string;
    readonly scriptPath: string;
  }

  /** Creates a fixture with a copied script and the given raw manifest. */
  function fixtureScript(rawManifest: string): FixturePackage {
    const dir = mkdtempSync(join(tmpdir(), 'quotameter-runtime-declare-'));
    try {
      // The script resolves '../package.json' against its own file, so the
      // copy must sit in a scripts/ subdirectory of the fixture root.
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(SCRIPT, join(dir, 'scripts', 'verify-runtime.mjs'));
      writeFileSync(join(dir, 'package.json'), rawManifest);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, scriptPath: join(dir, 'scripts', 'verify-runtime.mjs') };
  }

  it('follows a raised declaration, ordering at the patch level', async () => {
    // A non-zero patch minimum is the arm the shared matrix cannot
    // provide against the real manifest (whose patch is 0): it pins that
    // the comparator really orders the patch segment, not just
    // major.minor, and that the message names the raised minimum.
    const { dir, scriptPath } = fixtureScript('{"engines":{"node":">=22.13.5"}}');
    try {
      const below = await runScript({ fakeVersion: '22.13.4', scriptPath });
      expect(below.code).toBe(1);
      expect(below.stderr).toContain('quotameter requires Node.js >= 22.13.5');
      expect(below.stderr).toContain('found 22.13.4');

      const at = await runScript({ fakeVersion: '22.13.5', scriptPath });
      expect(at.code).toBe(0);
      expect(at.stdout).toBe('runtime ok: node 22.13.5, node:sqlite available without flags\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a runtime below a raised minor declaration', async () => {
    const { dir, scriptPath } = fixtureScript('{"engines":{"node":">=22.14.0"}}');
    try {
      const result = await runScript({ fakeVersion: '22.13.0', scriptPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('quotameter requires Node.js >= 22.14.0');
      expect(result.stderr).toContain('found 22.13.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('accepts a runtime above a relaxed declaration', async () => {
    const { dir, scriptPath } = fixtureScript('{"engines":{"node":">=20.0.0"}}');
    try {
      const result = await runScript({ fakeVersion: '22.13.0', scriptPath });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('runtime ok: node 22.13.0, node:sqlite available without flags\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
