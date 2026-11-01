import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createReadlinePrompter, type PromptHandle } from '../../src/cli/prompts';

/**
 * The production prompter (task 130, decision D-099) over in-process
 * PassThrough streams. The streams are dressed up as a TTY (`isTTY` plus a
 * `setRawMode` stub) so the interface runs in terminal mode — the only mode
 * in which readline performs the echo itself and muting can hide a secret;
 * that is the path production takes on a real terminal.
 */

interface Harness {
  prompter: PromptHandle;
  /** Everything that reached the "terminal". */
  terminal(): string;
  /** Everything typed into the "keyboard". */
  type(text: string): void;
  /** Closes the keyboard without a final line — the EOF path. */
  endInput(): void;
}

function harness(terminalMode: boolean): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  if (terminalMode) {
    const tty = input as PassThrough & { isTTY?: boolean; setRawMode?: () => void };
    tty.isTTY = true;
    tty.setRawMode = () => undefined;
  }
  // Flowing-mode collector: unlike read(), which drains, this keeps the full
  // transcript for repeated assertions.
  const seen: string[] = [];
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => seen.push(chunk));
  const prompter = createReadlinePrompter(input, output);
  return {
    prompter,
    terminal: () => seen.join(''),
    type: (text: string) => void input.write(text),
    endInput: () => void input.end(),
  };
}

describe('createReadlinePrompter (terminal mode)', () => {
  it('asks a question and echoes the answer', async () => {
    const h = harness(true);
    const answer = h.prompter.ask('Name: ');
    h.type('Alice');
    h.type('\r');
    await expect(answer).resolves.toBe('Alice');
    expect(h.terminal()).toContain('Name: ');
    expect(h.terminal()).toContain('Alice');
    h.prompter.close();
  });

  it('askSecret shows the prompt but never the typed value', async () => {
    const h = harness(true);
    const answer = h.prompter.askSecret('API key: ');
    h.type('sk-secret-value');
    h.type('\r');
    await expect(answer).resolves.toBe('sk-secret-value');
    const seen = h.terminal();
    expect(seen).toContain('API key: ');
    expect(seen).not.toContain('sk-secret-value');
    // The muted echo ate the newline; the prompter ends the line itself.
    expect(seen.endsWith('\n')).toBe(true);
    h.prompter.close();
  });

  it('echoing resumes after a secret question', async () => {
    const h = harness(true);
    const secret = h.prompter.askSecret('Key: ');
    h.type('k1\r');
    await expect(secret).resolves.toBe('k1');
    const next = h.prompter.ask('Host: ');
    h.type('example.local\r');
    await expect(next).resolves.toBe('example.local');
    expect(h.terminal()).toContain('example.local');
    h.prompter.close();
  });

  it('a Ctrl-C byte during terminal-mode input cancels the question and latches the interrupt', async () => {
    const h = harness(true);
    const answer = h.prompter.ask('Name: ');
    h.type('partial');
    h.type('\x03');
    await expect(answer).resolves.toBe(null);
    // The latch distinguishes Ctrl-C from piped EOF (task 133): a caller
    // with no pending question still sees that the user interrupted.
    expect(h.prompter.interrupted()).toBe(true);
    h.prompter.close();
  });

  it('plain EOF closes without latching an interrupt (piped automation is not a cancel)', async () => {
    const h = harness(false);
    const answer = h.prompter.ask('Name: ');
    h.endInput();
    await expect(answer).resolves.toBe(null);
    expect(h.prompter.interrupted()).toBe(false);
    h.prompter.close();
  });

  it('trims nothing — answers arrive verbatim', async () => {
    const h = harness(true);
    const answer = h.prompter.ask('Q: ');
    h.type('  spaced  \r');
    await expect(answer).resolves.toBe('  spaced  ');
    h.prompter.close();
  });

  it('a multi-answer paste is consumed but never echoed (future secret hidden)', async () => {
    const h = harness(true);
    const q1 = h.prompter.ask('Zone: ');
    h.type('UTC\r0.0.0.0\r9000\r');
    await expect(q1).resolves.toBe('UTC');
    await expect(h.prompter.ask('Host: ')).resolves.toBe('0.0.0.0');
    await expect(h.prompter.ask('Port: ')).resolves.toBe('9000');
    const seen = h.terminal();
    expect(seen).toContain('Zone: ');
    expect(seen).toContain('Port: ');
    // The whole chunk is muted before readline echoes it — a pasted key would
    // never reach the terminal.
    expect(seen).not.toContain('UTC');
    expect(seen).not.toContain('0.0.0.0');
    expect(seen).not.toContain('9000');
    h.prompter.close();
  });

  it('after type-ahead, later typed answers are not echoed either', async () => {
    const h = harness(true);
    const q1 = h.prompter.ask('One: ');
    h.type('a\rb\r');
    await expect(q1).resolves.toBe('a');
    await expect(h.prompter.ask('Two: ')).resolves.toBe('b');
    const q3 = h.prompter.ask('Three: ');
    h.type('typed-later\r');
    await expect(q3).resolves.toBe('typed-later');
    expect(h.terminal()).not.toContain('typed-later');
    h.prompter.close();
  });

  it('a line typed with no question pending latches the silent mode', async () => {
    const h = harness(true);
    // Typed before any question — its own characters may echo (the program
    // has not read it yet), but everything after stays silent.
    h.type('early\r');
    await expect(h.prompter.ask('Q: ')).resolves.toBe('early');
    const q2 = h.prompter.ask('R: ');
    h.type('late\r');
    await expect(q2).resolves.toBe('late');
    expect(h.terminal()).toContain('Q: ');
    expect(h.terminal()).not.toContain('late');
    h.prompter.close();
  });

  it('a secret question after type-ahead stays silent as well', async () => {
    const h = harness(true);
    const q1 = h.prompter.ask('One: ');
    h.type('a\rsk-quiet\r');
    await expect(q1).resolves.toBe('a');
    await expect(h.prompter.askSecret('Key: ')).resolves.toBe('sk-quiet');
    expect(h.terminal()).not.toContain('sk-quiet');
    h.prompter.close();
  });
});

describe('createReadlinePrompter (piped mode)', () => {
  it('reads piped lines with terminal-mode disabled', async () => {
    const h = harness(false);
    const answer = h.prompter.ask('Name: ');
    h.type('Bob\n');
    await expect(answer).resolves.toBe('Bob');
    h.prompter.close();
  });

  it('askSecret still never writes the typed value to the output', async () => {
    const h = harness(false);
    const answer = h.prompter.askSecret('Key: ');
    h.type('piped-secret\n');
    await expect(answer).resolves.toBe('piped-secret');
    expect(h.terminal()).not.toContain('piped-secret');
    h.prompter.close();
  });
});

describe('input closed — an answer, not a hang', () => {
  it('answers that arrive before their question are queued, not dropped', async () => {
    const h = harness(false);
    // The one-chunk piped-input shape: several lines are already in the
    // stream (or the interface buffer) before any question is asked.
    h.type('UTC\n127.0.0.1\n');
    await expect(h.prompter.ask('Zone: ')).resolves.toBe('UTC');
    await expect(h.prompter.ask('Host: ')).resolves.toBe('127.0.0.1');
    h.prompter.close();
  });

  it('EOF without a line settles the pending question as null', async () => {
    const h = harness(false);
    const answer = h.prompter.ask('Name: ');
    h.endInput();
    await expect(answer).resolves.toBe(null);
  });

  it('EOF with a final line delivers that line, then closes', async () => {
    const h = harness(false);
    const first = h.prompter.ask('One: ');
    h.type('value\n');
    await expect(first).resolves.toBe('value');
    const second = h.prompter.ask('Two: ');
    h.endInput();
    await expect(second).resolves.toBe(null);
  });

  it('a final partial line (no newline) is delivered before the close', async () => {
    const h = harness(false);
    const answer = h.prompter.ask('Zone: ');
    h.type('UTC');
    h.endInput();
    await expect(answer).resolves.toBe('UTC');
    await expect(h.prompter.ask('Next: ')).resolves.toBe(null);
  });

  it('a question after close resolves null immediately', async () => {
    const h = harness(false);
    h.prompter.close();
    await expect(h.prompter.ask('Late: ')).resolves.toBe(null);
    await expect(h.prompter.askSecret('Late key: ')).resolves.toBe(null);
  });

  it('close() is idempotent and settles pending questions', async () => {
    const h = harness(false);
    const answer = h.prompter.ask('Name: ');
    h.prompter.close();
    h.prompter.close();
    await expect(answer).resolves.toBe(null);
  });
});
