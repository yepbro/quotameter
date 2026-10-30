# `src/providers/` — provider adapters behind one interface

The provider architecture (spec §8): files directly in this directory are the
shared core — the `QuotaProvider`/`AccountContext` contracts and
`ProviderRegistry` in [`registry.ts`](registry.ts) (task 070), the HTTP
transport wrapper (task 104), and response sanitization (task 102). One
subdirectory per provider holds its adapter and all provider-specific parsing
(`zai-coding-plan/`, Stage 9).

**Rules:** adapters may import only the shared core, `src/schemas/`, and
`src/util/` — never each other, and never services/storage/server. Adapters
are registered by the composition root (`src/server/`) only. Adding a provider
means adding a subdirectory and registering it; nothing else may change.

## The registry contract (task 070, spec §8.1)

`registry.ts` exports everything a provider integration needs:

- **`QuotaProvider`** — the spec §8.1 interface: `id`, `name`,
  `validateCredentials(account)`, `fetchSnapshot(account, signal)`. Snapshots
  are the normalized model from `src/schemas/metrics.ts` (spec §8.4) —
  providers never invent their own shapes.
- **`AccountContext` / `createAccountContext(accountId, label, secret)`** —
  the account handed to adapters. The type is branded (the `Validated<T>`
  pattern from `src/schemas/boundary.ts`), so contexts are created only by
  the factory, which rejects blank fields, keeps `secret` non-enumerable and
  read-only, and freezes the object: `JSON.stringify`, `util.inspect`, and
  object spreading carry only `accountId` and `label`. Reading `.secret`
  explicitly is the single sanctioned access path, and secrets never appear in
  error messages (spec §8.1, §15.4).
- **`ProviderRegistry`** — `register` / `get` / `has` / `list`. Duplicate ids,
  blank or whitespace-padded ids, blank names, non-function methods, and
  unknown-id lookups throw (decision D-013): wiring mistakes must fail at
  startup, not silently shadow a provider or surface at first poll. `list()`
  returns a fresh array in registration order.

## Response sanitization (task 102, spec §7.4, §15.4)

`sanitize.ts` is the persistence-side twin of the redacting logger (D-025):
the logger guards what leaves the process, this module guards what a failed
parse leaves behind. One entry point, string in / string out (D-041):

```ts
sanitizeRawResponse(body: string, secrets: readonly string[]): string
```

Called with the response body exactly as the transport received it and the
call's known secret values (the account key plus any discovered tokens), it
returns text safe to persist (the `raw_responses` store, task 086) and to
display (`quotameter doctor --raw`, task 103 — never HTTP/UI, §7.4).
Guarantees:

- **Exact secret values are redacted everywhere** — any depth, array
  elements, substrings inside larger strings, object keys, and raw
  unparsable bodies alike, in both the literal and the JSON-escaped
  spelling of each secret (`[REDACTED]` replaces each occurrence).
- **Sensitive named fields are emptied** — the logger's `SENSITIVE_KEY_NAMES`
  vocabulary, matched by normalized equality (lowercase, non-alphanumerics
  stripped), is imported from `src/util/logger.ts` so the two sanitizers
  cannot drift. Usage-count fields (`tokens`, `total_tokens`,
  `promptTokens`, …) survive: matching is equality, never substring, which
  is exactly §7.4's "do not redact every field whose name contains `token`".
- **Capped at `MAX_PAYLOAD_BYTES` (64 KiB = 65536 UTF-8 bytes), marker
  included** — a hard bound the storage consumer can rely on. Bodies that
  parse as JSON are walked structurally and re-serialized compactly (valid
  JSON in, valid JSON out when the sanitized form fits); unparsable bodies
  are scrubbed as raw text — half the point of a parse-failure diagnostic.
  Oversized payloads are cut after sanitization at a codepoint boundary (no
  split surrogate pairs, no partial `[REDACTED]`) and end with a
  deterministic `[TRUNCATED at 65536 of <original> bytes]` marker reporting
  the pre-truncation size.

Blank `secrets` entries are ignored; output is deterministic.
