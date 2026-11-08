import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../helpers/isolation';

/**
 * The build contract's own test (spec §3, §17.2; decisions D-127, D-129):
 * `scripts/verify-build.mjs` is what turns a silently broken or
 * CSP-incompatible frontend build into a failing `make build`. The
 * script is judged in real child processes (the `tz-verify-script.spec.ts`
 * pattern) against synthetic dist trees, so both halves of the contract
 * are pinned — expected artifacts exist, and the served policy's shape
 * holds: external hashed bundles only, no inline scripts or style
 * attributes, no `data:` URIs (D-127).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/verify-build.mjs');

/** One completed child run: exit code plus both output streams. */
interface ScriptRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the verifier against `distDir` (DIST_DIR) and collects its output. */
async function runVerifyBuild(distDir: string, cliDir?: string): Promise<ScriptRun> {
  // Since task 185 (D-195) the verifier also requires the compiled CLI.
  // Tests that judge the UI half supply a valid CLI tree automatically at
  // a companion path INSIDE distDir — withTempDir's cleanup removes the
  // whole root, so nothing leaks into the container /tmp (the review
  // round measured 90 leaked sibling dirs from the `${distDir}-cli`
  // placement this replaces); CLI-specific tests pass their own (possibly
  // empty) dir. CLI_DIST_DIR is always set explicitly — the repo-root
  // default must never decide a test's outcome.
  const resolvedCliDir = cliDir ?? join(distDir, 'cli-companion');
  if (cliDir === undefined) {
    await mkdir(join(resolvedCliDir, 'cli'), { recursive: true });
    await writeFile(join(resolvedCliDir, 'cli', 'main.js'), 'export const runCli = 0;\n');
    await writeFile(join(resolvedCliDir, 'cli', 'commands.js'), 'export const table = [];\n');
  }
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, DIST_DIR: distDir, CLI_DIST_DIR: resolvedCliDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    // 'close' (not 'exit'): stdio is drained by then, so output is complete.
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

/** A realistic Vite build tree: index.html referencing hashed external bundles. */
async function writeBuildTree(
  dist: string,
  indexHtml: string,
  css = 'body{margin:0}\n',
  js = "console.log('app')\n",
): Promise<void> {
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), indexHtml);
  await writeFile(join(dist, 'assets', 'index-Cw5pB7Xy.css'), css);
  await writeFile(join(dist, 'assets', 'index-D9rQkZ2m.js'), js);
}

/** The shape Vite emits today: external module script + external stylesheet. */
const HAPPY_INDEX = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-Cw5pB7Xy.css">',
  '  </head>',
  '  <body>',
  '    <div id="app"></div>',
  '    <script type="module" crossorigin src="/assets/index-D9rQkZ2m.js"></script>',
  '  </body>',
  '</html>',
].join('\n');

describe('verify-build script', () => {
  it('rejects a missing compiled CLI entry (dist/cli/main.js)', async () => {
    // Task 185 (D-195): the installed command resolves dist/cli/main.js —
    // a build that emitted no CLI must fail verification, not publish a
    // tarball whose command can only print --version.
    await withTempDir(async (dir) => {
      await writeBuildTree(dir.path, HAPPY_INDEX);
      const cliDir = join(dir.path, 'cli-out');
      await mkdir(join(cliDir, 'cli'), { recursive: true }); // exists, empty

      const run = await runVerifyBuild(dir.path, cliDir);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('missing expected build artifact');
      expect(run.stderr).toContain('cli/main.js');
    });
  });

  it('accepts a build with external hashed bundles only', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(dir.path, HAPPY_INDEX);

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(0);
      expect(run.stdout).toContain('build artifacts verified');
    });
  });

  it('rejects a missing index.html', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir.path, 'assets'), { recursive: true });
      await writeFile(join(dir.path, 'assets', 'index-Cw5pB7Xy.css'), 'body{}');
      await writeFile(join(dir.path, 'assets', 'index-D9rQkZ2m.js'), '');

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('missing expected build artifact');
      expect(run.stderr).toContain('index.html');
    });
  });

  it('rejects a build with no CSS bundle', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir.path, 'assets'), { recursive: true });
      await writeFile(join(dir.path, 'index.html'), HAPPY_INDEX);
      await writeFile(join(dir.path, 'assets', 'index-D9rQkZ2m.js'), '');

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('build artifact glob matched nothing');
      expect(run.stderr).toContain('assets/*.css');
    });
  });

  it('rejects an inline script in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(dir.path, `${HAPPY_INDEX}\n<script>console.log(1)</script>`);

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('inline <script> without src');
    });
  });

  it('rejects an inline style block in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(dir.path, `${HAPPY_INDEX}\n<style>body{margin:0}</style>`);

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('inline <style> block');
    });
  });

  it('rejects a style attribute in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX.replace('<div id="app">', '<div id="app" style="color: red">'),
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('style= attribute');
    });
  });

  it('rejects an unquoted style attribute (minified HTML form)', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX.replace('<div id="app">', '<div id="app" style=color:red>'),
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('style= attribute');
    });
  });

  it('rejects a self-closing style block in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(dir.path, `${HAPPY_INDEX}\n<style/>`);

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('inline <style> block');
    });
  });

  it('rejects an inline event handler in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX.replace(
          '<div id="app"></div>',
          '<div id="app"><img src="/assets/x.png" onerror="alert(1)" alt=""></div>',
        ),
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('inline event handler');
    });
  });

  it('rejects a javascript: URI in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX.replace(
          '<div id="app"></div>',
          '<div id="app"><a href="javascript:alert(1)">x</a></div>',
        ),
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('javascript: URI');
    });
  });

  it('rejects a data: URI in index.html', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX.replace(
          '<div id="app"></div>',
          '<div id="app"><img src="data:image/png;base64,AAAA" alt=""></div>',
        ),
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('data: URI');
      expect(run.stderr).toContain('index.html');
    });
  });

  it('rejects a data: URI inside an emitted stylesheet', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX,
        'body{background:url("data:image/png;base64,AAAA")}\n',
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('data: URI');
      expect(run.stderr).toContain('.css');
    });
  });

  it('rejects a data: URI inside an emitted JavaScript bundle', async () => {
    // Vite's asset inlining lands JS-imported assets (import img from
    // './x.png') inside the JS chunk — the regression class the check
    // exists for, and the reason assetsInlineLimit is pinned to 0.
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX,
        'body{margin:0}\n',
        'const img = "data:image/png;base64,AAAA";\n',
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('data: URI');
      expect(run.stderr).toContain('.js');
    });
  });

  it('rejects an external url() reference inside a stylesheet', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX,
        'body{background:url(https://cdn.example.com/x.png)}\n',
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('external url()');
    });
  });

  it('accepts a same-origin asset url() in a stylesheet', async () => {
    await withTempDir(async (dir) => {
      await writeBuildTree(
        dir.path,
        HAPPY_INDEX,
        'body{background:url("/assets/mark-Cw5pB7Xy.woff2")}\n',
      );

      const run = await runVerifyBuild(dir.path);

      expect(run.code).toBe(0);
    });
  });
});
