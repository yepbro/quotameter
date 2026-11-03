import { describe, expect, it } from 'vitest';
import type { PromptHandle } from '../../src/cli/prompts';
import {
  askInitPassword,
  LOOPBACK_PASSWORD_PROMPT,
  REQUIRED_PASSWORD_PROMPT,
} from '../../src/cli/init-password';
import { MIN_PASSWORD_LENGTH } from '../../src/services/config-validation';

/**
 * The init-side password collection (task U-042, spec §5.3 step 4, §15.2;
 * decision D-141): the interactive question pair's mode selection by bind
 * host — optional (Enter skips) on loopback, required-shaped on everything
 * else — over `passwd`'s shared `askNewPassword` flow (D-118), with the
 * outcome translated into the handler's cancellation vocabulary. The
 * handler-level wiring (hashing, storage, marker discipline over the whole
 * run) is pinned by `test/unit/cli-init.spec.ts`; the real-launcher runs
 * by `test/integration/cli-init.spec.ts`.
 */

/** The marker password every no-leak assertion hunts for (§15.2 minimum). */
const MARKER_PASSWORD = 'init-marker-password-42';

/** An output seam that records lines. */
function recorder() {
  const lines: string[] = [];
  return {
    lines: () => lines,
    output: {
      out: (text: string) => void lines.push(text),
      err: (text: string) => void lines.push(text),
    },
  };
}

/** A prompter that answers from a script; `null` = input closed. */
function scriptedPrompter(
  answers: readonly (string | null)[],
  options?: { readonly interrupted?: boolean },
) {
  const queue = [...answers];
  const asked: string[] = [];
  const handle: PromptHandle = {
    async ask(prompt) {
      asked.push(prompt);
      return queue.shift() ?? null;
    },
    async askSecret(prompt) {
      asked.push(prompt);
      return queue.shift() ?? null;
    },
    close() {},
    interrupted: () => options?.interrupted === true,
  };
  return { handle, asked: () => asked };
}

/** The deps of one ask, over the given host and answer script. */
function askWith(
  host: string,
  answers: readonly (string | null)[],
  options?: { readonly interrupted?: boolean },
) {
  const rec = recorder();
  const prompter = scriptedPrompter(answers, options);
  return {
    rec,
    prompter,
    run: () =>
      askInitPassword({
        output: rec.output,
        prompter: prompter.handle,
        host,
        errorPrefix: 'quotameter init',
      }),
  };
}

describe('askInitPassword (loopback — the optional §15.1 default)', () => {
  it('asks with the skip prompt; the exactly-empty first answer skips', async () => {
    const { rec, prompter, run } = askWith('127.0.0.1', ['']);
    expect(await run()).toEqual({ state: 'skipped' });
    expect(prompter.asked()).toEqual([LOOPBACK_PASSWORD_PROMPT]);
    expect(rec.lines()).toEqual([]);
  });

  it('a confirmed pair is provided verbatim, untrimmed', async () => {
    // Leading/trailing spaces are part of the secret (D-022: secrets are
    // never trimmed) — the returned value keeps them and the confirmation
    // must repeat them exactly.
    const padded = `  ${MARKER_PASSWORD}  `;
    const { rec, prompter, run } = askWith('127.0.0.1', [padded, padded]);
    expect(await run()).toEqual({ state: 'provided', password: padded });
    // The pair shares passwd's confirmation prompt (D-118) — one flow, no
    // drift between the two commands that set passwords.
    expect(prompter.asked()).toEqual([LOOPBACK_PASSWORD_PROMPT, 'Confirm password: ']);
    expect(rec.lines()).toEqual([]);
  });

  it('the §15.2 minimum is exact: 12 characters accepted, 11 rejected', async () => {
    const atMinimum = 'a'.repeat(MIN_PASSWORD_LENGTH);
    const accepted = askWith('127.0.0.1', [atMinimum, atMinimum]);
    expect(await accepted.run()).toEqual({ state: 'provided', password: atMinimum });
    expect(accepted.rec.lines()).toEqual([]);
    const belowMinimum = 'b'.repeat(MIN_PASSWORD_LENGTH - 1);
    const rejected = askWith('127.0.0.1', [belowMinimum, atMinimum, atMinimum]);
    expect(await rejected.run()).toEqual({ state: 'provided', password: atMinimum });
    expect(rejected.rec.lines()).toEqual([
      `quotameter init: the password must be at least ${MIN_PASSWORD_LENGTH} characters long — try again`,
    ]);
  });

  it('a whitespace-only answer is not a skip — it fails the §15.2 minimum', async () => {
    const { rec, run } = askWith('localhost', ['   ', MARKER_PASSWORD, MARKER_PASSWORD]);
    expect(await run()).toEqual({ state: 'provided', password: MARKER_PASSWORD });
    expect(rec.lines()).toEqual([
      `quotameter init: the password must be at least ${MIN_PASSWORD_LENGTH} characters long — try again`,
    ]);
  });

  it('the skip stays available after a mismatching pair restart', async () => {
    const { run } = askWith('127.0.0.1', [MARKER_PASSWORD, 'other-long-enough', '']);
    expect(await run()).toEqual({ state: 'skipped' });
  });
});

describe('askInitPassword (non-loopback — §5.3 step 4 requires one)', () => {
  it('asks with the required prompt; the empty answer is the length complaint', async () => {
    const { rec, prompter, run } = askWith('0.0.0.0', ['', MARKER_PASSWORD, MARKER_PASSWORD]);
    expect(await run()).toEqual({ state: 'provided', password: MARKER_PASSWORD });
    expect(prompter.asked()[0]).toBe(REQUIRED_PASSWORD_PROMPT);
    expect(rec.lines()).toEqual([
      `quotameter init: the password must be at least ${MIN_PASSWORD_LENGTH} characters long — try again`,
    ]);
  });

  it('there is no skip: three rejected pairs abort', async () => {
    const { rec, run } = askWith('192.168.1.10', ['', '', '']);
    expect(await run()).toEqual({ state: 'aborted' });
    expect(rec.lines()).toHaveLength(3);
  });
});

describe('askInitPassword (cancellation and prompts)', () => {
  it('closed input at either question becomes the handler cancellation', async () => {
    const first = askWith('127.0.0.1', [null]);
    expect(await first.run()).toEqual({ state: 'cancelled' });
    const second = askWith('0.0.0.0', [MARKER_PASSWORD, null]);
    expect(await second.run()).toEqual({ state: 'cancelled' });
  });

  it('an interrupt becomes the same cancellation (D-044 renders both alike)', async () => {
    const { run } = askWith('127.0.0.1', [null], { interrupted: true });
    expect(await run()).toEqual({ state: 'cancelled' });
  });

  it('both mode prompts name the §15.2 minimum and their consequence', async () => {
    const loopback = askWith('127.0.0.1', ['']);
    expect(await loopback.run()).toEqual({ state: 'skipped' });
    expect(loopback.prompter.asked()).toEqual([LOOPBACK_PASSWORD_PROMPT]);
    // The required mode re-asks the first question while the answer is
    // rejected — there is no skip to reach a confirmation with here.
    const required = askWith('0.0.0.0', ['', '', '']);
    expect(await required.run()).toEqual({ state: 'aborted' });
    expect(required.prompter.asked()).toEqual([
      REQUIRED_PASSWORD_PROMPT,
      REQUIRED_PASSWORD_PROMPT,
      REQUIRED_PASSWORD_PROMPT,
    ]);
    for (const prompt of [...loopback.prompter.asked(), ...required.prompter.asked()]) {
      expect(prompt).toContain(`at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  });
});
