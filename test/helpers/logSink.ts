import type { DestinationStream } from 'pino';

/**
 * In-memory log sink for logger tests (task 072).
 *
 * Implements Pino's `DestinationStream` so `createLogger({ destination })`
 * captures records without touching `process.stdout` — the testing
 * convention of capturing via injected streams, never patched globals.
 * Pino writes each record as one line synchronously, so every helper here
 * is safe to call immediately after a log call.
 */
export interface MemoryLogSink extends DestinationStream {
  /** Every emitted record as a raw JSON line, in emission order. */
  lines(): string[];
  /** Every emitted record parsed from JSON, in emission order. */
  records(): Record<string, unknown>[];
  /** The only emitted line; throws when the logger emitted more or fewer. */
  singleLine(): string;
  /** The only emitted record parsed from JSON; throws on any other count. */
  singleRecord(): Record<string, unknown>;
}

/** Creates a sink that accumulates the JSON lines a logger emits. */
export function createMemoryLogSink(): MemoryLogSink {
  const chunks: string[] = [];
  return {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    lines(): string[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '');
    },
    records(): Record<string, unknown>[] {
      return this.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    singleLine(): string {
      return single(this.lines(), 'line');
    },
    singleRecord(): Record<string, unknown> {
      return single(this.records(), 'record');
    },
  };
}

function single<T>(items: T[], what: string): T {
  if (items.length !== 1) {
    throw new Error(`expected exactly one log ${what}, got ${items.length}`);
  }
  return items[0] as T;
}

/** A sink whose writes throw — for proving emitters never propagate failures. */
export function createThrowingLogSink(): DestinationStream {
  return {
    write(): boolean {
      throw new Error('sink is broken');
    },
  };
}
