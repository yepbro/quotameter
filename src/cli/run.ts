/**
 * The `run` command handler (task U-050, spec §5.2/§5.6).
 *
 * `quotameter run` is the foreground service command — the one §5.2 names
 * "for systemd and debugging" and the one the generated unit's `ExecStart`
 * pins (`<node> <cli> run`, §5.4): it starts the real server through
 * `runServer` (task 060's callable — the runtime gate, the composed
 * application, SIGTERM/SIGINT graceful shutdown) and forwards its exit code.
 *
 * The server entry point is imported LAZILY, inside the handler, on purpose:
 * `buildCommandTable()` loads for every CLI invocation, and a static import
 * would drag the whole server graph — the composition root, Fastify, Pino,
 * `node:sqlite` (whose ExperimentalWarning would then print on every
 * `quotameter status`) — into `--help` and every unrelated command. The same
 * discipline keeps `doctor`'s `MINIMUM_NODE_VERSION` and the storage-opening
 * commands' connection imports out of the dispatch graph. A failing dynamic
 * import (a broken installation's ERR_MODULE_NOT_FOUND) needs no handler
 * code: it propagates to the dispatcher, which reports it as the standard
 * command failure (`quotameter run: <message>`, exit 1).
 *
 * The handler deliberately writes NOTHING through the CLI output seam: a
 * foreground service's stdout is the §16 structured-log JSON stream journald
 * collects, and startup refusals are already explained on stderr by
 * `runServer` itself (`quotameter: <message>`, the pre-logger fatal channel).
 */

import type { CliHandler } from './commands';

/** Options of {@link runRunCommand}; every member is an injection seam. */
export interface RunCommandDeps {
  /**
   * Loads the server entry point module; defaults to the lazy dynamic
   * import ({@link defaultImportServerMain}). Tests inject a double to pin
   * the handler without running a real server. The type names exactly what
   * the handler consumes — `runServer` — so a minimal double is assignable.
   */
  readonly importServerMain?: () => Promise<Pick<typeof import('../server/main'), 'runServer'>>;
}

/**
 * The production import seam: loads `src/server/main.ts` — and nothing else
 * in this module's import graph — when the `run` handler is invoked.
 */
export function defaultImportServerMain(): Promise<typeof import('../server/main')> {
  return import('../server/main');
}

/**
 * Builds the §5.2 `run` handler: start the server, return its exit code —
 * `0` after a clean signal-driven shutdown, `1` when the runtime gate or the
 * startup sequence failed (§5.2, §5.6; U-022's best-effort stop on startup
 * failure stays `runServer`'s own contract, unchanged here). §5.2 defines no
 * options and no positional arguments for the command, so the handler reads
 * nothing from its context.
 */
export function runRunCommand(deps: RunCommandDeps = {}): CliHandler {
  return async () => {
    const serverMain = await (deps.importServerMain ?? defaultImportServerMain)();
    return serverMain.runServer();
  };
}
