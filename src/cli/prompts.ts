/**
 * The interactive prompt seam (task 130, spec §5.3; decision D-099).
 *
 * `init` needs to ask the user questions on a terminal. Production uses
 * {@link createReadlinePrompter} — one `node:readline` interface over the
 * process streams — while tests inject a scripted {@link Prompter}, so the
 * question flow (`init-questions.ts`) stays pure orchestration.
 *
 * Three contracts live here and are pinned by tests:
 *
 * - **No answer is ever dropped.** `readline`'s `question()` consumes one
 *   line and silently discards every further `line` event that fires while
 *   no question is pending — which is exactly what happens when piped input
 *   delivers several answers in one chunk (the first question's callback
 *   resolves in a microtask, the remaining lines are already gone). This
 *   prompter therefore never calls `question()`: it keeps the interface for
 *   what it is good at (raw-mode line editing, echo, keypress decoding) and
 *   owns the line queue itself, so answers survive any chunking.
 * - **Input closed is an answer, not a hang.** `readline`'s `question()`
 *   never settles when the input ends without a final line (verified on the
 *   pinned runtime); here a closed interface settles every pending question
 *   with `null`, and a question after close resolves `null` immediately —
 *   `quotameter init < /dev/null` aborts cleanly instead of hanging.
 * - **Secret answers are never echoed.** `askSecret` shows the question,
 *   then mutes the echo path while the answer is typed. On a TTY this
 *   requires the interface to run in terminal (raw) mode — there readline
 *   performs the echo itself through the output stream, which the echo gate
 *   swallows; with `terminal: false` the kernel line discipline would echo
 *   regardless of any output muting. Piped input has no echo to suppress,
 *   so the gate is a no-op there. Either way the typed value never reaches
 *   the terminal while its question is active.
 * - **Type-ahead never echoes either** (code-review round, task 130). A user
 *   may paste all answers in one chunk instead of typing them one by one —
 *   and readline echoes every character as it decodes them, so a pasted API
 *   key would hit the terminal long before the key question muted anything.
 *   A `data` listener attached before the interface counts line endings per
 *   chunk and mutes the gate before readline processes any chunk carrying
 *   more than one answer; a line that arrives with no question pending
 *   latches the same state (once the user is ahead of the wizard, echo stays
 *   off for the rest of the flow — the prompts and the summary remain the
 *   feedback). The one boundary no reader can close: a single line typed
 *   into an earlier, non-secret prompt is echoed before the program can
 *   know it will later be classified as a key — the program never prints
 *   such a value itself (complaints for the secret question never name it),
 *   the terminal echoes what the user types there like any other input.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/**
 * A question source. Resolves the typed line verbatim (trimming is the
 * caller's validation concern) or `null` when the input closed before a line
 * arrived — EOF, an interrupt, or a prior close.
 */
export interface Prompter {
  /** Asks one question; the answer is echoed while typed (normal input). */
  ask(prompt: string): Promise<string | null>;
  /**
   * Asks one question whose answer is a secret: the prompt is shown, the
   * typed characters are not (spec §6.3, §15.4 — a key must never appear on
   * the terminal or in any log).
   */
  askSecret(prompt: string): Promise<string | null>;
}

/** A {@link Prompter} whose underlying interface the caller can close. */
export type PromptHandle = Prompter & { close(): void };

/**
 * Builds the production prompter over the given streams.
 *
 * The interface runs in terminal mode exactly when the input is a TTY: that
 * is where raw-mode line editing (backspace, cursor keys) and echo exist, and
 * the only mode in which output muting can hide typed secrets. Prompt text is
 * written by this module, not by the interface (`setPrompt('')`), so prompts
 * render identically in both modes while the interface handles only input.
 */
export function createReadlinePrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): PromptHandle {
  const gate = new EchoGate(output);
  /**
   * Latches when the user is ahead of the wizard: a multi-answer chunk (a
   * paste) or a line with no question pending. From then on echo stays off —
   * a future secret line must never be echoed on the strength of a normal
   * question being active.
   */
  let typeAhead = false;

  // Attached BEFORE the interface so it runs before readline's own chunk
  // processing: muting here suppresses the echo of the whole chunk, including
  // characters readline would otherwise echo while decoding it.
  input.on('data', (chunk: string | Buffer) => {
    if (countLineEndings(chunk.toString('utf8')) >= 2) {
      typeAhead = true;
      gate.mute();
    }
  });

  const iface = readline.createInterface({
    input,
    output: gate,
    terminal: isTty(input),
  });
  iface.setPrompt('');

  /** Lines already delivered by the interface, waiting for their question. */
  const queued: string[] = [];
  /** Questions waiting for their line (resolved with `null` on close). */
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  iface.on('line', (line: string) => {
    const deliver = waiters.shift();
    if (deliver === undefined) {
      queued.push(line);
      typeAhead = true;
      gate.mute();
    } else {
      deliver(line);
    }
  });
  iface.on('close', () => {
    closed = true;
    for (const deliver of waiters.splice(0)) deliver(null);
  });
  // Ctrl-C on a TTY reaches the interface as a SIGINT event only in terminal
  // mode; closing the interface settles any pending question as `null`, so an
  // interrupt cancels the flow through the same path as EOF.
  iface.on('SIGINT', () => {
    iface.close();
  });

  /** The next answer line, or `null` — buffered lines first, then a wait. */
  const nextLine = (): Promise<string | null> => {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  return {
    async ask(prompt: string): Promise<string | null> {
      // Echo only while the user answers question by question; after any
      // type-ahead the whole flow stays silent (a pasted or queued future
      // secret must not be echoed).
      if (!typeAhead) gate.unmute();
      output.write(prompt);
      return nextLine();
    },
    async askSecret(prompt: string): Promise<string | null> {
      // The question itself must stay visible; only the echo is muted.
      output.write(prompt);
      gate.mute();
      const line = await nextLine();
      if (!typeAhead) gate.unmute();
      // The interface's own newline echo was muted; end the line manually so
      // following output starts on a fresh line.
      output.write('\n');
      return line;
    },
    close(): void {
      iface.close();
    },
  };
}

/**
 * Line endings in `text`: `\r\n` counts once, like a lone `\r` or `\n` —
 * a Windows-style single-line chunk is one answer, not two.
 */
function countLineEndings(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

/** True when the stream is a teletype — the gate for terminal mode. */
function isTty(stream: NodeJS.ReadableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

/**
 * A `Writable` view of the real output that can be muted: while muted, every
 * byte the interface writes (typed-character echoes, line-editing escapes,
 * the trailing newline) is dropped instead of forwarded, which is what keeps
 * a typed secret off the terminal. Terminal metadata (`columns`) is forwarded
 * so readline wraps lines as the real terminal would.
 */
class EchoGate extends Writable {
  private muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
    Object.defineProperty(this, 'columns', {
      get: () => (target as { columns?: number }).columns,
    });
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}
