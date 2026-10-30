/**
 * The CLI output seam (task 128, spec §5.2; decision D-044).
 *
 * `console` is banned in `src/**` (ESLint; secrets and provider payloads may
 * only travel through the structured logger, spec §15.4) — but a CLI's own
 * stdout/stderr output is its product. The sanctioned mechanism is therefore
 * direct stream writes through this injectable seam: production uses
 * {@link systemOutput} (`process.stdout`/`process.stderr`, the same precedent
 * as the pre-logger fatal diagnostics in `src/server/main.ts`), tests inject
 * a recorder, and no `src/` code ever touches `console`.
 *
 * The seam is line-oriented: renderers pass complete text (possibly
 * multi-line, without a trailing newline) and the sink appends exactly one
 * final newline.
 */

/** Injected by `runCli`; the only way CLI code reaches the terminal. */
export interface CliOutput {
  /** Writes `text` to stdout followed by one newline. */
  out(text: string): void;
  /** Writes `text` to stderr followed by one newline. */
  err(text: string): void;
}

/** The production sink: real process streams, never `console`. */
export function systemOutput(): CliOutput {
  return {
    out(text: string): void {
      process.stdout.write(`${text}\n`);
    },
    err(text: string): void {
      process.stderr.write(`${text}\n`);
    },
  };
}
