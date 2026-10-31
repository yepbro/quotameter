/**
 * Response payload sanitization (spec §7.4, §15.4; task 102, decision D-041).
 *
 * The persistence-side counterpart of the redacting logger (D-025): the
 * logger guards the process-exit side, this module guards what a failed
 * parse leaves behind. Spec §7.2 orders a sanitized response retained on
 * `Format changed`, §7.4 caps it at 64 KiB, and §15.4 is absolute — the
 * account key must never appear in a stored provider response.
 *
 * Contract: string in, string out (D-041). {@link sanitizeRawResponse} takes
 * the response body exactly as the transport received it plus the known
 * secret values for the call (the account key and any tokens discovered
 * meanwhile) and returns text safe to persist (the `raw_responses` store,
 * task 086) and to display (`quotameter doctor --raw`, task 103). Three
 * guarantees:
 *
 * - **Exact secret values are gone** — wherever they occur: string values
 *   at any depth, array elements, substrings inside larger strings, object
 *   keys, and raw unparsable bodies alike (§7.4 "exact occurrences"), in
 *   both the literal and the JSON-escaped spelling of each secret.
 * - **Sensitive named fields are emptied** — keys matching the logger's
 *   `SENSITIVE_KEY_NAMES` vocabulary by normalized equality carry
 *   `[REDACTED]` as their value. Importing the logger's list keeps the two
 *   sanitizers from drifting; §7.4's eight names all normalize into it, the
 *   logger's extras err on the side of redaction, and usage-count fields
 *   (`tokens`, `total_tokens`, …) survive because matching is by normalized
 *   *equality*, never by substring (§7.4 forbids redacting every
 *   `token`-containing name).
 * - **The output is capped** at {@link MAX_PAYLOAD_BYTES} of UTF-8,
 *   truncation marker included (D-041).
 *
 * Sanitization runs before truncation, so the scrubber always sees the
 * complete payload; a byte-level cut can only remove text, never re-expose
 * what was replaced.
 */

import { Buffer } from 'node:buffer';
import { REDACTED, SENSITIVE_KEY_NAMES } from '../util/logger';

/* ── Vocabulary (shared with the logger, D-025/D-041) ─────────────────── */

/**
 * The payload cap of spec §7.4: 64 KiB = 65536 bytes of UTF-8, measured
 * with `Buffer.byteLength`, truncation marker included — a hard storage
 * bound the `raw_responses` consumer (task 086) can rely on.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Every value a `JSON.parse` of a response body can yield. Freshly parsed
 * JSON is acyclic and free of `undefined`, functions, and symbols by
 * construction, so the walk below needs neither the cycle tracking nor the
 * hostile-getter guards the live-object logger sanitizer carries (D-025).
 */
type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const sensitiveKeys = new Set<string>(SENSITIVE_KEY_NAMES);

/**
 * Sensitive-key test by normalized equality (lowercase, non-alphanumerics
 * stripped) — the logger's rule, applied verbatim so `apiKey`, `API_KEY`,
 * and `api-key` all hit while `tokens` never does.
 */
function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * The spellings a secret can take inside stored text: its literal value,
 * plus its JSON-escaped form (`JSON.stringify` unquoted) when distinct —
 * a secret containing quotes or backslashes looks like the escaped
 * spelling inside a raw JSON body embedded in unparsable text.
 */
function secretSpellings(secret: string): readonly string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  // Stryker disable next-line ConditionalExpression: the → false variant is equivalent (scrubbing twice when the spellings coincide is a no-op); the → true variant drops the JSON-escaped spelling and is killed by the escaped-spelling test — co-excluded by line granularity
  return escaped === secret ? [secret] : [secret, escaped];
}

/**
 * Replaces every exact occurrence of every known secret, in every
 * spelling. The twin of the logger's value scrubber (D-025), kept local
 * because `util/logger.ts` is landed and this module must not grow it a
 * new export; string-literal `replaceAll` needs no regex escaping.
 */
function scrubSecrets(value: string, secrets: readonly string[]): string {
  let scrubbed = value;
  for (const secret of secrets) {
    for (const spelling of secretSpellings(secret)) {
      scrubbed = scrubbed.replaceAll(spelling, REDACTED);
    }
  }
  return scrubbed;
}

/* ── Structure walk (parsed bodies) ────────────────────────────────────── */

/**
 * Deeply sanitizes a parsed JSON value: strings (and object keys) lose
 * their embedded secrets, sensitive-named fields collapse to
 * {@link REDACTED}, containers are rebuilt — the input is never mutated.
 * The name rule examines the key as it appeared; the value rule scrubs the
 * stored spelling, so an object key that embeds a secret cannot survive
 * serialization either. Entries are re-attached as own properties: a
 * `__proto__` key from `JSON.parse` must stay an own enumerable entry
 * (plain assignment would set the prototype and silently drop the field).
 * Distinct keys whose scrubbed spellings collide keep the last entry —
 * inherent to value-based key scrubbing, the logger's Layer B alike.
 */
function sanitizeJsonValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') {
    return scrubSecrets(value, secrets);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => sanitizeJsonValue(element, secrets));
  }
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(record, scrubSecrets(key, secrets), {
      value: isSensitiveKey(key) ? REDACTED : sanitizeJsonValue(entry, secrets),
      enumerable: true,
      // Stryker disable next-line BooleanLiteral: descriptor flags are unobservable through the public API — the record is JSON.stringify-ed immediately
      writable: true,
      // Stryker disable next-line BooleanLiteral: descriptor flags are unobservable through the public API — the record is JSON.stringify-ed immediately
      configurable: true,
    });
  }
  return record;
}

/* ── Size cap (spec §7.4) ──────────────────────────────────────────────── */

/**
 * Proper prefixes of {@link REDACTED}, longest first — what a byte-level
 * cut can leave dangling at the end of a truncated payload.
 */
// Stryker disable next-line MethodExpression: prefix order is irrelevant — only one prefix length can be a suffix at a time, and the loop repeats until stable (co-excludes killed line-mates)
const PARTIAL_REDACTED_PREFIXES: readonly string[] = Array.from(
  { length: REDACTED.length - 1 },
  (_, index) => REDACTED.slice(0, index + 1),
).reverse();

/**
 * Drops dangling partial `[REDACTED]` prefixes left by the cut (cosmetic,
 * but a half marker misleads). Repeats until stable: payload text can end
 * in a run like `[REDACTED[REDACT`, where one pass leaves `[REDACTED`
 * behind.
 */
function trimPartialRedactionMarker(head: string): string {
  let trimmed = head;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PARTIAL_REDACTED_PREFIXES) {
      if (trimmed.endsWith(prefix)) {
        trimmed = trimmed.slice(0, trimmed.length - prefix.length);
        changed = true;
        break;
      }
    }
  }
  return trimmed;
}

/**
 * Caps the sanitized payload at {@link MAX_PAYLOAD_BYTES} UTF-8 bytes,
 * marker included. The deterministic marker reports both the cap and the
 * pre-truncation size so `doctor --raw` readers know what they are looking
 * at. The cut backs up over UTF-8 continuation bytes (never splitting a
 * codepoint or surrogate pair) and never leaves half a `[REDACTED]`.
 */
function capPayload(sanitized: string): string {
  // Stryker disable next-line StringLiteral: Node normalizes the empty encoding name to UTF-8 (verified)
  const originalBytes = Buffer.byteLength(sanitized, 'utf8');
  if (originalBytes <= MAX_PAYLOAD_BYTES) {
    return sanitized;
  }
  const marker = `[TRUNCATED at ${MAX_PAYLOAD_BYTES} of ${originalBytes} bytes]`;
  // Stryker disable next-line StringLiteral: Node normalizes the empty encoding name to UTF-8 (verified)
  const bytes = Buffer.from(sanitized, 'utf8');
  // Stryker disable next-line StringLiteral: Node normalizes the empty encoding name to UTF-8 (verified)
  let end = MAX_PAYLOAD_BYTES - Buffer.byteLength(marker, 'utf8');
  // Stryker disable next-line ConditionalExpression, EqualityOperator: valid UTF-8 always exposes a lead byte before index 0 matters, so both bound variants exit at the same end (co-excludes killed line-mates)
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1;
  }
  const head = trimPartialRedactionMarker(bytes.subarray(0, end).toString('utf8'));
  return head + marker;
}

/* ── Public API ────────────────────────────────────────────────────────── */

/**
 * Sanitizes a raw provider response body for storage and CLI display
 * (spec §7.4, §15.4; decision D-041).
 *
 * A body that parses as JSON is walked structurally and re-serialized
 * compactly, so a payload whose sanitized form fits the cap stays valid
 * JSON. An
 * unparsable body — half the point of a parse-failure diagnostic — is
 * scrubbed as raw text: value-based secret removal needs no fields to
 * exist, which keeps the §15.4 guarantee (the configured key never
 * appears) independent of parsability. Blank `secrets` entries are ignored
 * (a blank marker would redact everything and nothing). Deterministic:
 * identical inputs yield identical outputs.
 */
export function sanitizeRawResponse(body: string, secrets: readonly string[]): string {
  const known = secrets.filter((secret) => secret.trim() !== '');
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return capPayload(scrubSecrets(body, known));
  }
  return capPayload(JSON.stringify(sanitizeJsonValue(parsed, known)));
}
