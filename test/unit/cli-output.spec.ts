import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemOutput } from '../../src/cli/output';

/**
 * The production CLI output sink (task 128, spec §5.2; decision D-044).
 *
 * `systemOutput` is `runCli`'s default whenever no `deps.output` is
 * injected — the path the real launcher takes across the process boundary
 * (`test/integration/cli-bin.spec.ts`). Every in-process dispatch test
 * injects a recorder instead, which left this module without a single
 * in-process execution: Stryker's per-test analysis can neither attribute
 * coverage from, nor activate mutants in, a jiti-loaded child process, so
 * the file reported 0% (issue #6, eleven no-coverage mutants — six here).
 * This suite executes the sink in-process, intercepting the stream writes
 * the way `test/integration/server-main.spec.ts` spies on `process.stderr`.
 */

/** Installs a recorder on `stream`; the returned function restores the
 * stream and returns everything written while it was installed. */
function interceptWrites(stream: NodeJS.WriteStream): () => string[] {
  const spy = vi.spyOn(stream, 'write').mockImplementation(() => true);
  return () => {
    const chunks = spy.mock.calls.map((call) => String(call[0]));
    spy.mockRestore();
    return chunks;
  };
}

describe('systemOutput (the production CLI sink)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('out writes the text to stdout followed by exactly one newline', () => {
    const written = interceptWrites(process.stdout);
    systemOutput().out('quotameter 1.2.3');
    expect(written()).toEqual(['quotameter 1.2.3\n']);
  });

  it('err writes the text to stderr followed by exactly one newline', () => {
    const written = interceptWrites(process.stderr);
    systemOutput().err('quotameter: unknown command');
    expect(written()).toEqual(['quotameter: unknown command\n']);
  });

  it('keeps multi-line text intact and appends only the final newline', () => {
    const stdoutWritten = interceptWrites(process.stdout);
    const stderrWritten = interceptWrites(process.stderr);
    const sink = systemOutput();
    sink.out('Usage: quotameter <command>\n\nRun --help');
    sink.err('line one\nline two');
    expect(stdoutWritten()).toEqual(['Usage: quotameter <command>\n\nRun --help\n']);
    expect(stderrWritten()).toEqual(['line one\nline two\n']);
  });
});
