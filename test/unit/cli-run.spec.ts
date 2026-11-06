import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuotameterEnv } from '../helpers/hermeticEnv';
import { createTempDir } from '../helpers/isolation';
import { runCli } from '../../src/cli/main';
import type { CliContext } from '../../src/cli/commands';
import { defaultImportServerMain, runRunCommand } from '../../src/cli/run';
import type { CliOutput } from '../../src/cli/output';

/**
 * The `run` command handler (task U-050, spec §5.2/§5.6): a thin leaf whose
 * whole contract is (1) import the server entry point lazily — so no
 * unrelated CLI invocation loads the server graph — and (2) forward
 * `runServer`'s exit code, adding no output of its own (stdout belongs to
 * the §16 JSON log stream; refusals are explained by `runServer` on stderr).
 *
 * The graceful-shutdown semantics themselves (signals, exit codes, U-022's
 * best-effort stop) are `runServer`'s, pinned by `server-main.spec.ts`; the
 * real-launcher SIGTERM proof — `bin/quotameter.mjs run` through a child
 * process over a temporary configuration — is
 * `test/integration/cli-run.spec.ts`.
 */

/** Records writes exactly the way `systemOutput` would emit them. */
function recorder(): { output: CliOutput; out(): string; err(): string } {
  const outText: string[] = [];
  const errText: string[] = [];
  return {
    output: {
      out: (text: string) => void outText.push(`${text}\n`),
      err: (text: string) => void errText.push(`${text}\n`),
    },
    out: () => outText.join(''),
    err: () => errText.join(''),
  };
}

/** A fake `src/server/main` module for the injection seam. */
function serverMainDouble(
  code: number,
  calls: number[] = [],
): {
  runServer: () => Promise<number>;
} {
  return {
    runServer: async () => {
      calls.push(code);
      return code;
    },
  };
}

/** A minimal handler context over a recorder (the handler ignores it). */
function context(): CliContext {
  return {
    output: recorder().output,
    version: '9.9.9-unit',
    commandPath: ['run'],
    flags: {},
    positionals: [],
  };
}

describe('runRunCommand', () => {
  it('starts the server once and forwards its exit code (0 clean, 1 failed)', async () => {
    for (const code of [0, 1]) {
      const calls: number[] = [];
      const handler = runRunCommand({
        importServerMain: () => Promise.resolve(serverMainDouble(code, calls)),
      });
      await expect(handler(context())).resolves.toBe(code);
      expect(calls).toEqual([code]);
    }
  });

  it('propagates a failing module import to the dispatcher (exit-1 class)', async () => {
    const handler = runRunCommand({
      importServerMain: () => Promise.reject(new Error('Cannot find module')),
    });
    // runLeaf's catch reports this as `quotameter run: …` and exits 1 —
    // pinned in cli-dispatch.spec.ts; here the contract is propagation.
    await expect(handler(context())).rejects.toThrow('Cannot find module');
  });

  it('defaultImportServerMain resolves the server entry point module', async () => {
    // Covers the production import arm without running anything: loading
    // src/server/main.ts has no side effects (the callable only runs when
    // called). Proves the lazy specifier resolves to the module that owns
    // `runServer`.
    const serverMain = await defaultImportServerMain();
    expect(serverMain.runServer).toBeTypeOf('function');
  });
});

describe('the full default path through runCli (hermetic, §6.2 refusal)', () => {
  /** Captures fatal diagnostics written to stderr; restores on `restore()`. */
  function captureStderr(): { lines(): string; restore(): void } {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      lines: () => spy.mock.calls.map((call) => String(call[0])).join(''),
      restore: () => spy.mockRestore(),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches `run` to the real handler, which refuses to start without a configuration and exits 1', async () => {
    // No `importServerMain` injection: the handler's production lazy import
    // runs for real, in-process, and `runServer` refuses on §6.2 grounds —
    // the configuration file does not exist — before any socket or database
    // is opened. This is the dispatch-level proof that the stub era ended:
    // the table's `run` row reaches the actual server entry point.
    const dir = await createTempDir('qm-run-unit-u050-');
    const stderr = captureStderr();
    try {
      const configDir = join(dir.path, 'config');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      const sink = recorder();
      let code = -1;
      await withQuotameterEnv(
        { QUOTAMETER_CONFIG_DIR: configDir, QUOTAMETER_DATA_DIR: join(dir.path, 'data') },
        async () => {
          code = await runCli(['run'], { version: '9.9.9-unit', output: sink.output });
        },
      );
      expect(code).toBe(1);
      // runServer's own fatal channel explains the refusal (§6.2); the CLI
      // output seam stays unused — the handler adds no chatter. The second
      // assertion is the behavioral anti-stub pin at dispatch level: the
      // retired stub answered exactly this message through this seam.
      expect(stderr.lines()).toMatch(/quotameter: /);
      expect(stderr.lines()).toMatch(/configuration file not found/);
      expect(sink.err()).not.toContain('not implemented yet');
      expect(sink.out()).toBe('');
    } finally {
      stderr.restore();
      await dir.remove();
    }
  });
});
