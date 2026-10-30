import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { MAX_PAYLOAD_BYTES, sanitizeRawResponse } from '../../src/providers/sanitize';

/**
 * Property-based coverage for src/providers/sanitize.ts (spec §7.4, §17.1;
 * task 102). The secret is sentinel-wrapped (`«inner»`) so absence is
 * provable for arbitrary inner text: the replacement marker contains no
 * `«`, so the exact secret sequence can only re-form inside untouched
 * input — and `replaceAll` leaves no untouched occurrence. Reproduce a
 * failure with `FC_SEED=<printed seed>`.
 */

/** Wraps generated text into a secret no JSON serialization artifact can mimic. */
const secretArb = fc.string({ maxLength: 24 }).map((inner) => `«${inner}»`);

describe('sanitizeRawResponse properties', () => {
  it('an injected secret is absent from the output, which fits the cap', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), secretArb, fc.nat(), (text, secret, offset) => {
        const at = offset % (text.length + 1);
        const body = text.slice(0, at) + secret + text.slice(at);
        const out = sanitizeRawResponse(body, [secret]);
        expect(out.includes(secret)).toBe(false);
        expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      }),
    );
  });

  it('oversized bodies are capped and report truncation', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300_000 }), (text) => {
        const out = sanitizeRawResponse(text, []);
        expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
          expect(out.includes('[TRUNCATED at ')).toBe(true);
        }
      }),
    );
  });

  it('identical inputs produce identical outputs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2000 }),
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 3 }),
        (body, secrets) => {
          expect(sanitizeRawResponse(body, secrets)).toBe(sanitizeRawResponse(body, secrets));
        },
      ),
    );
  });

  it('valid JSON that fits the cap sanitizes to valid JSON', () => {
    fc.assert(
      fc.property(
        fc
          .jsonValue()
          .filter((value) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') <= 60_000),
        (value) => {
          const out = sanitizeRawResponse(JSON.stringify(value ?? null), ['«prp»']);
          expect(() => JSON.parse(out)).not.toThrow();
        },
      ),
    );
  });
});
