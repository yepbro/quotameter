import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main';
import type { CliOutput } from '../../src/cli/output';
import { readRawDiagnostics, renderRawDiagnostics } from '../../src/cli/raw-diagnostics';
import { RAW_RESPONSE_MAX_PER_ACCOUNT } from '../../src/storage/raw-response-retention';
import type { QuotaRepository, RawResponseRecord } from '../../src/storage/repository';
import { toUtcIso } from '../../src/util/clock';

/**
 * The §7.4 diagnostic read path (task 103, decision D-067): the renderer is
 * pure string-building (asserted exactly, English-only contract), the read
 * is the bounded `listRawResponses` call (asserted through a fake facade),
 * and the `doctor --raw <account>` dispatch surface — declared on the stub
 * until task 145 — parses per spec §5.5. Dispatch conventions follow
 * `test/unit/cli-dispatch.spec.ts` (injected recorder, real command table).
 */

const VERSION = '9.9.9-unit';

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

/** Runs the CLI in-process and returns code plus captured output. */
async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const sink = recorder();
  const code = await runCli(argv, { version: VERSION, output: sink.output });
  return { code: code, out: sink.out(), err: sink.err() };
}

/** A diagnostic record fixture — sanitized synthetic payload (D-049 discipline). */
function record(overrides: Partial<RawResponseRecord> = {}): RawResponseRecord {
  return {
    runId: 42,
    accountId: 'work',
    capturedAt: 1_761_000_000_000,
    httpStatus: 200,
    contentType: 'application/json',
    body: '{"seq": 1}',
    ...overrides,
  };
}

describe('readRawDiagnostics (spec §7.4 bounded read)', () => {
  it("asks the facade for the account's newest payloads, bounded by the cap", () => {
    const listRawResponses = vi
      .fn()
      .mockReturnValue([record()] as ReadonlyArray<RawResponseRecord>);
    const repository = { listRawResponses } as unknown as QuotaRepository;

    const records = readRawDiagnostics(repository, 'work');

    expect(listRawResponses).toHaveBeenCalledWith('work', {
      limit: RAW_RESPONSE_MAX_PER_ACCOUNT,
    });
    expect(records).toHaveLength(1);
  });

  it('rejects a blank accountId before reading anything', () => {
    const repository = {} as QuotaRepository;
    expect(() => readRawDiagnostics(repository, '  ')).toThrow(/non-blank/);
  });
});

describe('renderRawDiagnostics (the doctor --raw text)', () => {
  it('reports an empty retention state in one line', () => {
    expect(renderRawDiagnostics([])).toBe('No sanitized raw responses retained.');
  });

  it('renders a header per record with the body indented below it', () => {
    const text = renderRawDiagnostics([record()]);
    expect(text).toBe(
      [
        'Sanitized raw responses: 1 shown (newest first)',
        '',
        `run 42  captured ${toUtcIso(1_761_000_000_000)}  HTTP 200  application/json`,
        '  {"seq": 1}',
      ].join('\n'),
    );
  });

  it('names absent evidence columns instead of inventing values', () => {
    const text = renderRawDiagnostics([
      record({ runId: 7, httpStatus: null, contentType: null, body: '' }),
    ]);
    expect(text).toContain(
      `run 7  captured ${toUtcIso(1_761_000_000_000)}  no HTTP status  unknown content type`,
    );
    // An empty body adds no body lines — the header is the whole block.
    expect(text.endsWith('unknown content type')).toBe(true);
  });

  it('indents every line of a multi-line body and separates records', () => {
    const text = renderRawDiagnostics([
      record({ runId: 2, body: 'line one\nline two' }),
      record({ runId: 1, body: 'older' }),
    ]);
    expect(text).toContain('Sanitized raw responses: 2 shown (newest first)');
    expect(text).toContain('  line one\n  line two');
    expect(text).toContain('\n\nrun 1  captured');
  });
});

describe('doctor --raw dispatch surface (spec §5.5, until task 145)', () => {
  it('declares the option with its description in doctor help', async () => {
    const result = await cli(['doctor', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('--raw <value>');
    expect(result.out).toContain(
      'Show sanitized provider responses stored for parse failures of <account>',
    );
  });

  it('parses doctor --raw <account> (still a stub: exit 1, not a usage error)', async () => {
    const result = await cli(['doctor', '--raw', 'work']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('quotameter doctor: not implemented yet\n');
  });

  it('rejects a valueless --raw as a usage error (exit 2)', async () => {
    const result = await cli(['doctor', '--raw']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--raw');
    expect(result.err).toContain("Try 'quotameter doctor --help'");
  });
});
