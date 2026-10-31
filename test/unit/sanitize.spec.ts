import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_BYTES, sanitizeRawResponse } from '../../src/providers/sanitize';
import { REDACTED } from '../../src/util/logger';

/**
 * Example-based coverage for src/providers/sanitize.ts (spec §7.4, §15.4;
 * task 102). The done-condition is the marker matrix: marker secrets
 * injected at every nesting level are absent from the sanitized payload,
 * and the allowed usage `tokens` fields survive. Every absence assertion
 * checks the raw output string, not a parsed view, so a marker split
 * across structures cannot slip through.
 */

/** Synthetic marker secrets — no real credential (test fixture rule). */
const MARKER = 'sk-test-marker-a1b2c3d4';
const SECOND_MARKER = 'qq-marker-9e8d7c';

describe('sanitizeRawResponse: exact secret values', () => {
  it('removes marker secrets from every nesting level and keeps usage tokens', () => {
    const body = JSON.stringify({
      echo: MARKER,
      message: `request failed for ${MARKER} (trace ${SECOND_MARKER})`,
      nested: {
        deeper: {
          list: [MARKER, `mixed ${MARKER}`, { inner: `x${MARKER}y` }],
        },
      },
      [MARKER]: 'secret-as-object-key',
      usage: { tokens: 42, total_tokens: 4200 },
    });

    const out = sanitizeRawResponse(body, [MARKER, SECOND_MARKER]);

    expect(out.includes(MARKER)).toBe(false);
    expect(out.includes(SECOND_MARKER)).toBe(false);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.echo).toBe(REDACTED);
    expect(parsed.message).toBe(`request failed for ${REDACTED} (trace ${REDACTED})`);
    const nested = parsed.nested as { deeper: { list: unknown[] } };
    expect(nested.deeper.list[0]).toBe(REDACTED);
    expect(nested.deeper.list[1]).toBe(`mixed ${REDACTED}`);
    expect(nested.deeper.list[2]).toEqual({ inner: `x${REDACTED}y` });
    // A secret embedded in an object key cannot survive serialization.
    expect(parsed[REDACTED]).toBe('secret-as-object-key');
    expect(parsed.usage).toEqual({ tokens: 42, total_tokens: 4200 });
  });

  it('scrubs unparsable bodies as raw text (broken JSON echoing the key)', () => {
    const broken = `{"api_key": "${MARKER}",}`;
    const out = sanitizeRawResponse(broken, [MARKER]);
    expect(out.includes(MARKER)).toBe(false);
    expect(out).toBe(`{"api_key": "${REDACTED}",}`);
  });

  it('scrubs non-JSON bodies (HTML error page)', () => {
    const page = `<html><body>auth header ${MARKER} rejected</body></html>`;
    const out = sanitizeRawResponse(page, [MARKER]);
    expect(out.includes(MARKER)).toBe(false);
    expect(out).toBe(`<html><body>auth header ${REDACTED} rejected</body></html>`);
  });

  it('scrubs the JSON-escaped spelling of a secret inside unparsable text', () => {
    const secret = 'a"b\\c';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const body = `<error>{"echo": "${escaped}"}</error>`;
    const out = sanitizeRawResponse(body, [secret]);
    expect(out.includes(secret)).toBe(false);
    expect(out.includes(escaped)).toBe(false);
    expect(out).toBe(`<error>{"echo": "${REDACTED}"}</error>`);
  });

  it('ignores blank secret entries (a blank marker would redact nothing anyway)', () => {
    const body = '{"a":"b"}';
    expect(sanitizeRawResponse(body, ['', '   '])).toBe(body);
  });

  it('ignores blank secret entries exactly — whitespace runs stay verbatim (U-008)', () => {
    // The filter must drop blanks before the scrubber sees them: a kept
    // '   ' would replace ordinary space runs inside the stored text.
    const body = '{"a":"b   c"}';
    expect(sanitizeRawResponse(body, ['', '   '])).toBe(body);
    expect(sanitizeRawResponse('page with   spaces', [''])).toBe('page with   spaces');
  });
});

describe('sanitizeRawResponse: sensitive field names', () => {
  it('empties every spec §7.4 spelling and its case/separator variants', () => {
    const body = JSON.stringify({
      api_key: 'value-1',
      apiKey: 'value-2',
      API_KEY: 'value-3',
      'api-key': 'value-4',
      authorization: 'Bearer abc',
      secret: 'value-5',
      password: 'value-6',
      access_token: 'value-7',
      refresh_token: 'value-8',
      refreshToken: 'value-9',
      cookie: 'value-10',
      SESSION_ID: 'value-11',
      plan: 'Pro',
    });

    const out = sanitizeRawResponse(body, []);

    expect(JSON.parse(out)).toEqual({
      api_key: REDACTED,
      apiKey: REDACTED,
      API_KEY: REDACTED,
      'api-key': REDACTED,
      authorization: REDACTED,
      secret: REDACTED,
      password: REDACTED,
      access_token: REDACTED,
      refresh_token: REDACTED,
      refreshToken: REDACTED,
      cookie: REDACTED,
      SESSION_ID: REDACTED,
      plan: 'Pro',
    });
  });

  it('retains usage token-count fields while redacting auth-shaped ones', () => {
    const body = JSON.stringify({
      usage: { tokens: 1234, total_tokens: 5678, promptTokens: 90, completion_tokens: 11 },
      quota: { tokens_used: 5, token_reset_at: '2026-11-01T00:00:00Z' },
      auth: { token: 'bare-token', access_token: 'nested-token' },
    });

    const out = sanitizeRawResponse(body, []);

    expect(JSON.parse(out)).toEqual({
      usage: { tokens: 1234, total_tokens: 5678, promptTokens: 90, completion_tokens: 11 },
      quota: { tokens_used: 5, token_reset_at: '2026-11-01T00:00:00Z' },
      auth: { token: REDACTED, access_token: REDACTED },
    });
  });
});

describe('sanitizeRawResponse: 64 KiB cap', () => {
  it('keeps a payload of exactly MAX_PAYLOAD_BYTES unchanged (single-byte text)', () => {
    const body = 'x'.repeat(MAX_PAYLOAD_BYTES);
    const out = sanitizeRawResponse(body, []);
    expect(out).toBe(body);
    expect(Buffer.byteLength(out)).toBe(MAX_PAYLOAD_BYTES);
    expect(out.includes('[TRUNCATED')).toBe(false);
  });

  it('truncates one byte over the cap to exactly MAX_PAYLOAD_BYTES, marker included', () => {
    const body = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
    const out = sanitizeRawResponse(body, []);
    const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${MAX_PAYLOAD_BYTES + 1} bytes]`;
    expect(out).toBe('x'.repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(marker)) + marker);
    expect(Buffer.byteLength(out)).toBe(MAX_PAYLOAD_BYTES);
  });

  it('keeps two-byte text of exactly MAX_PAYLOAD_BYTES unchanged', () => {
    const body = 'é'.repeat(MAX_PAYLOAD_BYTES / 2);
    const out = sanitizeRawResponse(body, []);
    expect(out).toBe(body);
    expect(Buffer.byteLength(out)).toBe(MAX_PAYLOAD_BYTES);
  });

  it('never splits a multi-byte codepoint when cutting (two-byte text)', () => {
    const body = 'é'.repeat(32_769); // 65538 bytes, cut lands on a continuation byte
    const out = sanitizeRawResponse(body, []);
    const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${Buffer.byteLength(body)} bytes]`;
    expect(out).toBe('é'.repeat(32_750) + marker);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('never splits an astral codepoint when cutting (four-byte emoji)', () => {
    const body = 'x'.repeat(65_498) + '😀' + 'y'.repeat(60); // 65562 bytes
    const out = sanitizeRawResponse(body, []);
    const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${Buffer.byteLength(body)} bytes]`;
    expect(out).toBe('x'.repeat(65_498) + marker);
    expect(out.includes('\uFFFD')).toBe(false);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('never leaves a partial [REDACTED] at the cut point', () => {
    // Scrubbed layout: 65495 bytes of 'A' + 10-byte [REDACTED] + 200 bytes
    // of 'A' = 65705 bytes; the cut budget lands inside the marker.
    const body = 'A'.repeat(65_495) + MARKER + 'A'.repeat(200);
    const scrubbedBytes = 65_495 + Buffer.byteLength(REDACTED) + 200;
    const out = sanitizeRawResponse(body, [MARKER]);
    const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${scrubbedBytes} bytes]`;
    expect(out).toBe('A'.repeat(65_495) + marker);
    expect(out.includes('[RED')).toBe(false);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('keeps a complete [REDACTED] that ends exactly at the cut point (U-008)', () => {
    // The partial-prefix list is built one entry short of the full marker
    // on purpose: a redaction that happens to end flush with the cut is a
    // complete marker and must survive. The filler length is solved as a
    // fixed point over the marker's own byte length so the scrubbed head
    // ends exactly at the marker boundary.
    let filler = 0;
    for (let round = 0; round < 5; round += 1) {
      const total = filler + Buffer.byteLength(REDACTED, 'utf8') + 200_000;
      const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${total} bytes]`;
      filler =
        MAX_PAYLOAD_BYTES - Buffer.byteLength(marker, 'utf8') - Buffer.byteLength(REDACTED, 'utf8');
    }
    const total = filler + Buffer.byteLength(REDACTED, 'utf8') + 200_000;
    const body = 'A'.repeat(filler) + 'SK' + 'A'.repeat(200_000);
    const out = sanitizeRawResponse(body, ['SK']);
    expect(out).toBe(
      'A'.repeat(filler) + REDACTED + `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${total} bytes]`,
    );
    expect(Buffer.byteLength(out)).toBe(MAX_PAYLOAD_BYTES);
  });

  it('trims repeated marker-like runs at the cut point until stable', () => {
    // Payload text can end in a run like `[REDACTED[REDACT`: one trimming
    // pass would leave `[REDACTED` behind before the truncation marker.
    const body = 'A'.repeat(65_485) + '[REDACTED[REDACT' + 'B'.repeat(300);
    const out = sanitizeRawResponse(body, []);
    const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${Buffer.byteLength(body)} bytes]`;
    expect(out).toBe('A'.repeat(65_485) + marker);
    expect(out.includes('[REDACT')).toBe(false);
  });

  it('reports the pre-truncation size in the marker', () => {
    const body = `{"data":"${'v'.repeat(70_000)}"}`;
    const out = sanitizeRawResponse(body, []);
    expect(out.endsWith(`of ${Buffer.byteLength(body)} bytes]`)).toBe(true);
  });
});

describe('sanitizeRawResponse: structure, determinism, degenerate inputs', () => {
  it('re-serializes valid JSON compactly and preserves its structure', () => {
    const body = '  { "plan" : "Pro" , "n" : -12.5e2 , "b" : false , "z" : null }  ';
    expect(sanitizeRawResponse(body, [])).toBe('{"plan":"Pro","n":-1250,"b":false,"z":null}');
  });

  it('sanitizes top-level arrays and bare JSON primitives', () => {
    expect(sanitizeRawResponse(`["${MARKER}","a"]`, [MARKER])).toBe(`["[REDACTED]","a"]`);
    expect(sanitizeRawResponse('42', [])).toBe('42');
    expect(sanitizeRawResponse('true', [])).toBe('true');
    expect(sanitizeRawResponse('null', [])).toBe('null');
    expect(sanitizeRawResponse('"quoted"', [])).toBe('"quoted"');
  });

  it('is deterministic for repeated calls (text and JSON paths, truncated or not)', () => {
    const cases: readonly string[] = [
      `{"a":"${MARKER}"}`,
      `broken ${MARKER} text`,
      `{"pad":"${'z'.repeat(70_000)}"}`,
      'z'.repeat(70_000),
    ];
    for (const body of cases) {
      expect(sanitizeRawResponse(body, [MARKER])).toBe(sanitizeRawResponse(body, [MARKER]));
    }
  });

  it('preserves __proto__ keys as ordinary entries (no silent drop, no prototype effect)', () => {
    const out = sanitizeRawResponse('{"__proto__":{"evil":1},"b":2}', []);
    expect(out).toBe('{"__proto__":{"evil":1},"b":2}');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['__proto__', 'b']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(sanitizeRawResponse('{"__proto__":1}', [])).toBe('{"__proto__":1}');
  });

  it('handles empty and whitespace-only bodies unchanged', () => {
    expect(sanitizeRawResponse('', [MARKER])).toBe('');
    expect(sanitizeRawResponse('   ', [])).toBe('   ');
  });
});
