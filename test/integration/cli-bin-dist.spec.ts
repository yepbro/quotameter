import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hermeticChildEnv } from '../helpers/hermetic-child-env';

/**
 * The packaged CLI behind the installed `quotameter` command (task 185,
 * spec §5.1/§17.2; decision D-195).
 *
 * Three proofs, all through the REAL launcher as a child process:
 *
 * 1. **The compiled build resolves and runs.** `npm run build:cli` emits
 *    `dist/` into a fixture package root (bin + dist + package.json — the
 *    tarball's shape), and the launcher loads it with PLAIN Node: no jiti,
 *    no source checkout, no install-time build. The repository's
 *    `node_modules` is symlinked into the fixture root — the runtime
 *    dependency tree `npm install` provides to a real installation,
 *    supplied offline so the suite stays hermetic (the no-network guard's
 *    own rule); the genuinely clean global install (npm pack → clean
 *    prefix → `quotameter --help`) is the CI `install` job's step, which
 *    this suite mirrors. `--help` loads the entire compiled dispatch
 *    graph; its empty-stderr assertion pins the laziness discipline in the
 *    SHIPPED artifact (`node:sqlite` stays behind the dynamic storage
 *    imports, so no ExperimentalWarning on a command that opens no
 *    database — the D-116/D-161 discipline holding by construction in the
 *    emitted graph); `status` additionally exercises the lazy
 *    dynamic-import edges (lock reader, storage) through dist/.
 *
 * 2. **Every broken layout reports an actionable startup error** (§5.1:
 *    name the requirement and the fix), and the runtime gate still fires
 *    before any entry is loaded (D-098/D-161). The fixtures are fixture
 *    packages in the pattern of `cli-bin-version-gate.spec.ts`.
 *
 * 3. **The entry-mode override** (task 186, D-196):
 *    `QUOTAMETER_CLI_ENTRY` ('dist'/'source') pins the choice D-195's
 *    dist-first auto order would otherwise make. The mode is exercised
 *    with BOTH candidates present (the 'source' pin — the stale-dist
 *    remedy and the real-launcher suites' contract) and every forced
 *    mode's failure is actionable; jiti appears exactly once, for the
 *    forced-source fixture — the compiled-mode runs stay plain Node.
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
  /** Environment for the child; defaults to a minimal spawn environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Launcher to run; defaults to the fixture package's copy. */
  readonly binPath?: string;
  /** Value the child's `process.versions.node` is redefined to. */
  readonly fakeVersion?: string;
  /** Extra node arguments before the launcher path (e.g. jiti preloads). */
  readonly nodeArgs?: readonly string[];
}

/** Runs a launcher with `args`; resolves when output streams are drained. */
function runBin(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const cliArgs: string[] = [];
  if (options.fakeVersion !== undefined) {
    const script = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(
      options.fakeVersion,
    )}});`;
    cliArgs.push('--import', `data:text/javascript,${encodeURIComponent(script)}`);
  }
  if (options.nodeArgs !== undefined) {
    cliArgs.push(...options.nodeArgs);
  }
  cliArgs.push(options.binPath ?? BIN, ...args);
  const child = spawn(process.execPath, cliArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
  });
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

/** A fixture package root: bin + manifest, optionally with more entries. */
function fixturePackage(manifest: Record<string, unknown>): { dir: string; binPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quotameter-dist-'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(BIN, join(dir, 'bin/quotameter.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return { dir, binPath: join(dir, 'bin/quotameter.mjs') };
}

/** A manifest the runtime gate accepts on the test runtime. */
const PASSING_MANIFEST = {
  name: 'quotameter-fixture',
  version: '9.9.9',
  type: 'module',
  engines: { node: '>=20.0.0' },
};

describe('the real compiled build (npm run build:cli, plain Node)', () => {
  let pkgRoot: string;
  let binPath: string;

  beforeAll(async () => {
    pkgRoot = mkdtempSync(join(tmpdir(), 'quotameter-pkg-'));
    // The build redirects into the fixture root; bin and manifest beside it
    // give the launcher exactly the tarball's layout.
    const built = spawnSync('npm', ['run', 'build:cli'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, CLI_DIST_DIR: join(pkgRoot, 'dist') },
    });
    if (built.error !== undefined || built.status !== 0) {
      throw new Error(`npm run build:cli failed: ${built.stdout ?? ''}${built.stderr ?? ''}`);
    }
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true });
    copyFileSync(BIN, join(pkgRoot, 'bin/quotameter.mjs'));
    copyFileSync(join(REPO_ROOT, 'package.json'), join(pkgRoot, 'package.json'));
    // The dependency tree a real installation gets from npm — the
    // repository's own, symlinked so the suite stays offline.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(pkgRoot, 'node_modules'), 'dir');
    binPath = join(pkgRoot, 'bin/quotameter.mjs');
    expect(existsSync(join(pkgRoot, 'dist/cli/main.js')), 'the build emitted the entry').toBe(true);
  }, 120_000);

  afterAll(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it('--help loads the whole compiled dispatch graph with empty stderr', async () => {
    const result = await runBin(['--help'], { binPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: quotameter <command> [options]');
    for (const name of ['init', 'run', 'status', 'logs', 'service', 'passwd', 'doctor']) {
      expect(result.stdout, `help must mention '${name}'`).toContain(name);
    }
    // The laziness pin in the shipped artifact: a command that opens no
    // database must not even load node:sqlite (its ExperimentalWarning
    // would land here) — the dynamic-import discipline survived emission.
    expect(result.stderr).toBe('');
  }, 20_000);

  it('--version prints the manifest version through the fast path', async () => {
    const result = await runBin(['--version'], { binPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${PKG.version}\n`);
    expect(result.stderr).toBe('');
  }, 20_000);

  it('status runs a real command graph through the compiled dynamic imports', async () => {
    // status walks the lazy edges of the compiled graph (the §5.6 lock
    // reader, the storage island when a database exists) against an
    // isolated, unconfigured environment — the §5.2 "helpful next step"
    // shape, never a crash.
    const env = hermeticChildEnv();
    env.QUOTAMETER_CONFIG_DIR = join(pkgRoot, 'cfg');
    env.QUOTAMETER_DATA_DIR = join(pkgRoot, 'data');
    const result = await runBin(['status'], { binPath, env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Quotameter status');
    expect(result.stdout).toContain('not configured yet');
  }, 20_000);
});

describe('entry resolution and actionable startup errors (fixture packages)', () => {
  it('prefers dist/ and runs it under plain Node (no jiti, no src/)', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'dist/cli/main.js'),
        [
          "import { side } from './side.js';",
          'export async function runCli() {',
          '  console.log(`dist-marker:${side}`);',
          '  return 7;',
          '}',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'dist/cli/side.js'), "export const side = 'present';\n");
      const result = await runBin(['anything'], { binPath });
      expect(result.code).toBe(7);
      expect(result.stdout).toBe('dist-marker:present\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('prefers dist/ over a present source tree (D-195 ordering, both entries)', async () => {
    // The decision point itself: a layout with BOTH candidates must run
    // the packaged build, never the source fallback — the property that
    // makes whatever a developer or CI packs exercise the installed
    // artifact's shape (and the recorded stale-dist footgun's cause).
    // Without this pin, inverting the launcher's if/else keeps the whole
    // suite green: every other fixture has only one candidate present.
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      mkdirSync(join(dir, 'src/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'dist/cli/main.js'),
        [
          'export async function runCli() {',
          "  console.log('chosen:dist');",
          '  return 0;',
          '}',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'src/cli/main.ts'),
        [
          'export async function runCli() {',
          "  console.log('chosen:source');",
          '  return 0;',
          '}',
        ].join('\n'),
      );
      const result = await runBin(['anything'], { binPath });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('chosen:dist\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a directory sitting at the dist entry path as a damaged installation', async () => {
    // existsSync() is true for directories; importing one refuses with
    // ERR_UNSUPPORTED_DIR_IMPORT — the review round reproduced the raw
    // internal-error leak this arm closes (D-195: every broken layout
    // names the problem and the remedy).
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli/main.js'), { recursive: true });
      const result = await runBin(['--help'], { binPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('damaged');
      expect(result.stderr).toContain('reinstall the quotameter package');
      expect(result.stderr).not.toContain('internal CLI error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a missing entry point naming both locations and the reinstall', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      const result = await runBin(['--help'], { binPath });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('missing the CLI entry point');
      expect(result.stderr).toContain('dist/cli/main.js');
      expect(result.stderr).toContain('src/cli/main.ts');
      expect(result.stderr).toContain('reinstall the quotameter package');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports an unusable entry module (no runCli export)', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      writeFileSync(join(dir, 'dist/cli/main.js'), 'export const notTheCli = 1;\n');
      const result = await runBin(['--help'], { binPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unusable CLI entry module');
      expect(result.stderr).toContain('reinstall the quotameter package');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reports a damaged installation when the dist graph is broken behind the entry', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      // The entry exists and was chosen; its graph is missing a module —
      // the partial-install class the launcher must name as damage.
      writeFileSync(
        join(dir, 'dist/cli/main.js'),
        "import { side } from './side.js';\nexport const keep = typeof side;\n",
      );
      const result = await runBin(['--help'], { binPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('damaged');
      expect(result.stderr).toContain('reinstall the quotameter package');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('tells a jiti-less source checkout how to run or build', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'src/cli'), { recursive: true });
      writeFileSync(join(dir, 'src/cli/main.ts'), 'export const x = 1;\n');
      const result = await runBin(['--help'], { binPath });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('jiti');
      expect(result.stderr).toContain('build:cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a below-minimum runtime before the dist entry is ever loaded', async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      // If the gate ever loaded this entry after a rejected version, the
      // child would die on the syntax error, not the gate message.
      writeFileSync(join(dir, 'dist/cli/main.js'), 'this is not javascript at all\n');
      const result = await runBin(['--help'], { binPath, fakeVersion: '19.9.0' });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('quotameter requires Node.js >= 20.0.0');
      expect(result.stderr).not.toContain('SyntaxError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('entry-mode override (QUOTAMETER_CLI_ENTRY, task 186, D-196)', () => {
  /** A fixture with BOTH candidates present, each identifying itself. */
  function bothEntriesFixture(): { dir: string; binPath: string } {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    mkdirSync(join(dir, 'dist/cli'), { recursive: true });
    writeFileSync(
      join(dir, 'dist/cli/main.js'),
      [
        'export async function runCli() {',
        "  console.log('chosen:dist');",
        '  return 0;',
        '}',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'src/cli'), { recursive: true });
    writeFileSync(
      join(dir, 'src/cli/main.ts'),
      [
        'export async function runCli() {',
        "  console.log('chosen:source');",
        '  return 0;',
        '}',
      ].join('\n'),
    );
    return { dir, binPath };
  }

  it("'source' pins the source tree over a present dist/ (the stale-dist remedy)", async () => {
    // The inverse of the auto-order pin above: with both candidates
    // present, the override must WIN over dist-first — the property the
    // real-launcher suites rely on to test the source contract next to a
    // built dist/, and the D-195 footgun's explicit remedy.
    const { dir, binPath } = bothEntriesFixture();
    try {
      const result = await runBin(['anything'], {
        binPath,
        nodeArgs: ['--import', 'jiti/register'],
        env: { ...hermeticChildEnv(), QUOTAMETER_CLI_ENTRY: 'source' },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('chosen:source\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("'dist' pins the packaged build even when only dist/ exists (explicit mode)", async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'dist/cli/main.js'),
        [
          'export async function runCli() {',
          "  console.log('chosen:dist');",
          '  return 0;',
          '}',
        ].join('\n'),
      );
      const result = await runBin(['anything'], {
        binPath,
        env: { ...hermeticChildEnv(), QUOTAMETER_CLI_ENTRY: 'dist' },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('chosen:dist\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("names the remedy when 'dist' is forced but dist/ is missing", async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'src/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'src/cli/main.ts'),
        'export async function runCli() {\n  return 0;\n}\n',
      );
      const result = await runBin(['anything'], {
        binPath,
        env: { ...hermeticChildEnv(), QUOTAMETER_CLI_ENTRY: 'dist' },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'QUOTAMETER_CLI_ENTRY=dist is set but dist/cli/main.js is missing',
      );
      expect(result.stderr).toContain('build:cli');
      expect(result.stderr).toContain('unset the override');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("names the remedy when 'source' is forced but the source tree is missing", async () => {
    const { dir, binPath } = fixturePackage(PASSING_MANIFEST);
    try {
      mkdirSync(join(dir, 'dist/cli'), { recursive: true });
      writeFileSync(
        join(dir, 'dist/cli/main.js'),
        'export async function runCli() {\n  return 0;\n}\n',
      );
      const result = await runBin(['anything'], {
        binPath,
        env: { ...hermeticChildEnv(), QUOTAMETER_CLI_ENTRY: 'source' },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'QUOTAMETER_CLI_ENTRY=source is set but src/cli/main.ts is missing',
      );
      expect(result.stderr).toContain('unset the override');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses an unrecognized value instead of silently resolving auto', async () => {
    // A typo'd pin must fail loudly (the §5.1 fail-closed house rule) —
    // falling back to auto would make the override a silent no-op.
    const { dir, binPath } = bothEntriesFixture();
    try {
      const result = await runBin(['anything'], {
        binPath,
        env: { ...hermeticChildEnv(), QUOTAMETER_CLI_ENTRY: 'src' },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("QUOTAMETER_CLI_ENTRY must be 'dist' or 'source'");
      expect(result.stderr).toContain('"src"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
