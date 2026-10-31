import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION } from '../../src/server/main';
import { MINIMUM_RUNTIME, VERSION_GATE_CASES } from '../helpers/nodeVersionGate';

/**
 * The runtime version gate of the real launcher as a process (task 129,
 * spec §5.1/§17.2, decision D-098): `bin/quotameter.mjs` runs without jiti
 * — the gate fires before any command module is loaded, which is exactly
 * the ordering under test. The child's `process.versions.node` is faked
 * through a data-URL `--import` preload (the property is non-writable but
 * configurable, verified on the pinned 22.13.0 runtime), so every boundary
 * of the shared matrix in `test/helpers/nodeVersionGate.ts` — including
 * versions this container cannot be — is exercised against the real gate
 * in `make check`. The same matrix pins `src/util/version.ts` in-process
 * (`test/unit/version.spec.ts`); the launcher keeps a plain-JS copy of the
 * comparison, so only this double consumption keeps the two equivalent.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(REPO_ROOT, 'bin/quotameter.mjs');
const PKG: { version: string; engines?: { node?: string } } = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
);

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /**
   * Value the child's `process.versions.node` is redefined to before the
   * launcher module evaluates; `undefined` leaves the real runtime.
   */
  readonly fakeVersion?: string;
  /** Launcher to run; defaults to the repository's, fixture tests override. */
  readonly binPath?: string;
}

/** Runs the launcher with `args`; resolves when output streams are drained. */
function runBin(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const cliArgs: string[] = [];
  if (options.fakeVersion !== undefined) {
    const script = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(
      options.fakeVersion,
    )}});`;
    cliArgs.push('--import', `data:text/javascript,${encodeURIComponent(script)}`);
  }
  cliArgs.push(options.binPath ?? BIN, ...args);
  const child = spawn(process.execPath, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<RunResult>((resolve, reject) => {
    // 'close' (not 'exit'): both streams are drained by then.
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.once('error', reject);
  });
}

describe('bin/quotameter.mjs runtime gate (child process)', () => {
  it('rejects every below-minimum version with the actionable message', async () => {
    for (const { version, outcome } of VERSION_GATE_CASES) {
      if (outcome !== 'reject') continue;
      const result = await runBin(['--version'], { fakeVersion: version });
      expect(result.code, `exit 1 for ${version}`).toBe(1);
      expect(result.stdout, `empty stdout for ${version}`).toBe('');
      expect(result.stderr, `names the minimum for ${version}`).toContain(
        `quotameter requires Node.js >= ${MINIMUM_RUNTIME}`,
      );
      expect(result.stderr, `names the found version for ${version}`).toContain(`found ${version}`);
      expect(result.stderr, `suggests an upgrade for ${version}`).toContain('Upgrade Node.js');
    }
  }, 20_000);

  it('fails closed with a dedicated message when the version is unparseable', async () => {
    for (const { version } of VERSION_GATE_CASES.filter(({ outcome }) => outcome === 'invalid')) {
      const result = await runBin(['--version'], { fakeVersion: version });
      expect(result.code, `exit 1 for ${JSON.stringify(version)}`).toBe(1);
      expect(result.stderr, `explains the refusal for ${JSON.stringify(version)}`).toContain(
        'cannot determine the Node.js version',
      );
      expect(result.stderr, `echoes the raw value for ${JSON.stringify(version)}`).toContain(
        JSON.stringify(version),
      );
    }
  }, 20_000);

  it('accepts every supported version and reaches the --version fast path', async () => {
    for (const { version, outcome } of VERSION_GATE_CASES) {
      if (outcome !== 'pass') continue;
      const result = await runBin(['--version'], { fakeVersion: version });
      expect(result.code, `exit 0 for ${version}`).toBe(0);
      expect(result.stdout, `package version for ${version}`).toBe(`${PKG.version}\n`);
      expect(result.stderr, `empty stderr for ${version}`).toBe('');
    }
  }, 20_000);

  it('rejects before any command module is loaded', async () => {
    // `doctor` would delegate to src/cli/ (jiti, command dispatch); on a
    // below-minimum runtime the process must stop at the gate instead —
    // neither the missing-modules fallback nor any module error may appear.
    const result = await runBin(['doctor'], { fakeVersion: '22.12.9' });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `quotameter requires Node.js >= ${MINIMUM_RUNTIME} (found 22.12.9). ` +
        'Upgrade Node.js (for example via the official binaries or nvm) and try again.\n',
    );
    expect(result.stderr).not.toContain('missing the CLI command modules');
    expect(result.stderr).not.toContain('internal CLI error');
  }, 20_000);

  it('does not bypass the gate for --version (task 054 CI contract)', async () => {
    const result = await runBin(['--version'], { fakeVersion: '20.18.0' });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`quotameter requires Node.js >= ${MINIMUM_RUNTIME}`);
  }, 20_000);
});

describe('the gate derives its minimum from engines.node', () => {
  /** A fixture package: the copyable root and its launcher path. */
  interface FixturePackage {
    readonly dir: string;
    readonly binPath: string;
  }

  /** Creates a fixture package with a copied launcher; returns its paths. */
  function fixturePackage(rawManifest: string): FixturePackage {
    const dir = mkdtempSync(join(tmpdir(), 'quotameter-gate-'));
    try {
      // The launcher resolves '../package.json' against its own file, so
      // the copy must sit in a bin/ subdirectory of the fixture root.
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      copyFileSync(BIN, join(binDir, 'quotameter.mjs'));
      writeFileSync(join(dir, 'package.json'), rawManifest);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, binPath: join(dir, 'bin', 'quotameter.mjs') };
  }

  it('rejects a runtime below a raised declaration, naming the raised minimum', async () => {
    const { dir, binPath } = fixturePackage(
      JSON.stringify({
        name: 'quotameter-fixture',
        version: '9.9.9',
        engines: { node: '>=22.14.0' },
      }),
    );
    try {
      const result = await runBin(['--version'], { fakeVersion: '22.13.0', binPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('quotameter requires Node.js >= 22.14.0');
      expect(result.stderr).toContain('found 22.13.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('accepts a runtime above a relaxed declaration and still prints the manifest version', async () => {
    const { dir, binPath } = fixturePackage(
      JSON.stringify({
        name: 'quotameter-fixture',
        version: '9.9.9',
        engines: { node: '>=20.0.0' },
      }),
    );
    try {
      const result = await runBin(['--version'], { fakeVersion: '22.13.0', binPath });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('9.9.9\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('fails closed on a manifest without a usable engines.node declaration', async () => {
    // 'null' is the regression case for the review P2: valid JSON that is
    // not an object must reach the broken-manifest message, not a TypeError.
    const brokenManifests = [
      'null',
      '{}',
      '{"engines":{"node":"*"}}',
      '{"engines":{"node":"^22.13.0 || >=24.0.0"}}',
    ];
    for (const raw of brokenManifests) {
      const { dir, binPath } = fixturePackage(raw);
      try {
        const result = await runBin(['--version'], { binPath });
        expect(result.code, `exit 1 for manifest ${raw}`).toBe(1);
        expect(result.stderr, `names the manifest for ${raw}`).toContain('broken package manifest');
        expect(result.stderr, `no stack trace for ${raw}`).not.toContain('TypeError');
        expect(result.stderr).toContain('engines.node');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it('declares the same minimum the server gate mirrors', () => {
    // The engines field is the gate's single source of truth; the server's
    // MINIMUM_NODE_VERSION constant is its documented mirror (src/ cannot
    // import package.json), pinned here so the three can never diverge.
    expect(PKG.engines?.node).toBe(`>=${MINIMUM_RUNTIME}`);
    expect(MINIMUM_NODE_VERSION).toBe(MINIMUM_RUNTIME);
  });
});
