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

## The HTTP transport (task 104, spec §7.2, §17.1)

`transport.ts` exports `providerFetch(request, options)` — the one HTTP seam
every adapter calls instead of `fetch` directly. It centralizes the
cross-cutting request concerns so adapters stay pure parsing:

- **One total deadline (D-042)** — `timeoutMs` (§7.2 default 15 s) bounds
  DNS, connect, TLS, headers, _and_ the full body read as one exchange,
  implemented with `AbortSignal.timeout` composed with the caller's §8.1
  signal via `AbortSignal.any`. A deadline expiry throws
  `TransportTimeoutError`; a caller abort throws `TransportAbortError`.
  Signal state — not the rejection shape — is the classification authority,
  and it is consulted on the success returns too (U-007, D-072): a body
  read that ends `done` or a bodiless 2xx is delivered only while both
  signals are quiet, because undici can lose the abort-vs-read race and
  close an aborted stream as `done`. Delivered non-2xx, content-type, and
  over-cap observations keep their classes even when a signal raced them.
- **Bounded body (D-042)** — responses are read streamed and rejected the
  moment they exceed `MAX_RESPONSE_BODY_BYTES` (64 KiB, aligned with §7.4's
  sanitized-response cap), with a `Content-Length` fast path; a body of
  exactly the cap is delivered.
- **Content-type gate (D-042)** — 2xx responses must be `application/json`
  (media type, parameters ignored) or the transport throws
  `TransportContentTypeError`; adapters therefore only ever parse bodies the
  provider declared as JSON.
- **Sanitized taxonomy (D-042)** — every failure is a `TransportError` with
  a `kind` discriminant (`timeout`, `aborted`, `dns`, `connection`,
  `socket`, `network`, `http-status`, `response-too-large`, `content-type`)
  that task 105 maps to §7.2 collection outcomes. Non-2xx responses are
  _observations_: `TransportStatusError` carries the status, the scrubbed
  status text, and the raw `Retry-After` value — this layer never retries
  and never parses. The §7.2 retry loop itself is a cycle-level wrapper in
  `src/services/polling-retry.ts` (task 106, decision D-059), consuming the
  taxonomy downstream through task 105's `retryable` flag; `Retry-After`
  parsing stays task 107's. Errors never contain the URL, the
  request headers, or the raw cause: only the machine `causeCode` (e.g.
  `ECONNREFUSED`) survives, and the few retained server strings are
  scrubbed against the request's own credential material, so a provider
  echoing a key back cannot smuggle it into an error (§15.4). Marker-secret
  tests pin the whole surface.
- **GET-only, `redirect: 'error'`** — the verified provider endpoints are
  stable GETs; refusing redirects removes any cross-origin
  credential-forwarding question. The seam is deliberately minimal (no
  method or body parameters); widening it is a successor decision.

`fetchImpl` is injectable for tests that pin classification against exact
runtime failure shapes (the logger-destination pattern); production always
uses the Node 22 global.

## The Z.ai Coding Plan adapter (tasks 098–100, spec §8.3)

`zai-coding-plan/` is the first adapter island. Task 098 delivered its
credential validation; task 099 the `fetchSnapshot` collection cycle with the
§8.4 metric mapping; task 100 verified that mapping against every fixture row
(exact-equality recognition rows plus a §8.4 unit-discipline matrix — no
semantic change, decision D-047/D-053 stand). The implementation contract is
the [adapter-contract section of the provider
dossier](../../docs/providers/zai-coding-plan.md)
(task 096, decision D-047); the task-098 specifics are decision D-052, the
task-099 specifics decision D-053.

- **The check** — `ZaiCodingPlanProvider.validateCredentials(account)` sends
  exactly one signal-less `Authorization: Bearer <key>` GET to the dossier's
  endpoint 4 — `{codingBaseUrl}/models`, production default
  `https://api.z.ai/api/coding/paas/v4/models` — through `providerFetch`
  (never `fetch` directly, never retried; D-042). No other header is sent
  (dossier assumption A7). The response body is never parsed: it was never
  captured, so the check reads only the status the verified flow delivers
  (fixture `synthetic/zai-models.json` exists purely as a stand-in).
- **Three distinct results (status-based, dossier A3)** — a delivered 2xx
  resolves (credentials valid); HTTP 401/403 rejects with
  `CredentialsRejectedError` (`kind: 'credentials-rejected'`, the only
  rejection statuses — Z.ai's real auth-rejection shape is an assumption);
  every other transport failure of any kind (network, timeout, DNS, 5xx,
  429, other statuses, and 2xx responses the transport gates refused —
  wrong content type, over the byte cap) rejects with
  `ProviderUnavailableError` (`kind: 'provider-unavailable'`): the check
  was inconclusive, which callers must not read as a verdict on the key.
  Both extend `CredentialCheckError`, whose `kind` field is the structural
  discriminator — consumers that cannot import adapter types (services)
  discriminate on it without an `instanceof` against the island, per the 070
  contract's "provider-neutral error" wording.
- **The collection cycle (`snapshot.ts`, task 099)** —
  `fetchSnapshot(account, signal)` runs three sequential GETs through
  `providerFetch`, each with the Bearer credential, the caller's §8.1 abort
  signal (D-042 composes it into every exchange), and its own §7.2 deadline:
  endpoint 1 `GET {apiBaseUrl}/api/monitor/usage/quota/limit` (primary),
  endpoint 2 `GET {apiBaseUrl}/api/biz/subscription/list` (soft plan-name
  context), endpoint 3 `GET {apiBaseUrl}/api/biz/customer-package-reset/list?targetType=PERSONAL`
  (soft; the body is never parsed — endpoint 3 maps nothing in v1,
  D-047.6). The default `apiBaseUrl` is `https://api.z.ai`: the quota
  surface lives on the monitor/biz paths, _not_ under the coding base
  (spec §8.3's warning). Failures surface exactly two ways: an endpoint-1
  transport failure re-throws the D-042 `TransportError` unchanged (task
  105 classifies the kind), and an endpoint-1 parse failure throws
  `SnapshotParseError` — `reason` (static English) and `httpStatus` feed
  105's `classifyParseFailure`, `sanitizedPayload` is the §7.4 hand-off
  (task 102's sanitizer run over the raw body with the account secret;
  storage 086/103 persists it, the adapter only carries it), and
  `envelopeMessage` retains a non-success envelope's `msg`, sanitized (A2).
  Every endpoints-2/3 failure — transport, parse violation, or a caller
  abort mid-cycle — is soft: logged through the injected logger and
  degraded, never cycle-fatal (D-047: metric values originate only on
  endpoint 1).
- **The metric mapping (`mapping.ts`, tasks 099/100)** — the pure translation
  of endpoint 1 into the §8.4 model per the D-047 tables: recognition by
  `(type, unit)` (`mcp-monthly` `MONTHLY`/`REQUESTS`; `tokens-5h`
  `ROLLING_WINDOW` with `windowSeconds = number × 3600`; `weekly-quota`
  `WEEKLY` on either type spelling), unknown pairs and first-wins key
  collisions skipped and reported (`skips`, logged at warn by the cycle), the
  D-047.1 value semantics (`usage` → `limit`, `currentValue` → `used`,
  `remaining` → `remaining`, with the supplied-triple arithmetic check), the
  D-047.2 integer-percent pass-through (`percentRemaining` always derived so
  the two sum to exactly 100; `percentUsed` derived only from _supplied_
  `used`+`limit` — derivations never chain, §8.4), unit choice
  `CREDITS`/`PERCENT` by present fields (A5), metadata (`resetsAt`,
  `windowSeconds`) surviving invalid readings (D-010), and entries with
  unusable values emitted invalid — never zero — with the pinned
  `invalidReason` strings. Task 100 contract-tested every row: each
  recognition identity is pinned by an exact full-object equality assertion
  (labels, field presence _and_ absence), and every parseable fixture body is
  checked for §8.4 unit discipline (closed enum, no absolutes on `PERCENT`
  metrics, exact percent sums, invariant-clean snapshots).
- **Subscription context (A9)** — endpoint 2 is envelope-soft-checked
  (`data` must be an array), the record with `inCurrentPeriod === true` is
  selected (else the first `status === 'VALID'`), and its `productName` is
  used only as the `planName` fallback when endpoint 1's `data.level` is
  absent or not a usable string. Nothing else from a subscription record
  travels — account-linked and monetary values stay out of snapshots
  (fixture policy D-040).
- **Key discipline (§8.1, §15.4)** — `account.secret` is read only inside
  the cycle, into the shared `Authorization` header and the sanitizer's
  known-secrets list (both in-memory, never logged). Errors are composed
  only from static English and transport fields D-042 already scrubbed
  against the request's own credential material, plus payload text — §7.4
  hand-off, envelope diagnostic, skip reports — passed through task 102's
  sanitizer; marker tests pin every failure path key-free while proving
  the key actually traveled.
- **Options** — `ZaiCodingPlanProviderOptions` carries `codingBaseUrl` and
  `apiBaseUrl` (injectable so tests point the adapter at the loopback mock
  provider server), `timeoutMs` (§7.2's per-request deadline; the 5–60 s
  configuration range is enforced where configuration enters), `logger` (a
  `Pick<Logger, 'warn'>` sink for skips and soft failures; absent means
  silent — the composition root passes the application logger), and `clock`
  (stamps `collectedAt`; defaults to the system clock). All are validated
  at construction with echo-free `TypeError`s — wiring mistakes fail fast
  (D-013's spirit).
- **Not yet** — registration in the composition root is a later assembly
  task — nothing in this island edits `src/server/**`.
