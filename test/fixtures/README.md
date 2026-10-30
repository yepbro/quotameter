# Test fixtures

Static data for tests lives here in two directories with different provenance rules.

## `sanitized/` — redacted real payloads

Real provider responses captured from actual accounts, with **all secrets removed before committing**. A payload may land here only after an explicit sanitization pass.

**Forbidden in any fixture, without exception:**

- API keys, tokens, cookies, `Authorization` headers, session identifiers;
- passwords or password hashes;
- personal account data: real names, emails, account numbers, invoice or payment identifiers;
- anything that can identify a person or their subscription beyond what the test needs.

When adding a sanitized fixture:

1. Replace every secret-looking value with an obviously fake placeholder (`REDACTED`, `0000…`, synthetic UUIDs).
2. Replace personal identifiers with synthetic ones.
3. Record the capture date and source endpoint in this README's index below.

## `synthetic/` — invented payloads

Hand-written payloads that never came from a real account. Prefer synthetic fixtures whenever the test does not depend on exact real-world formatting; use them for partial, empty, unknown, and changed-schema shapes by design.

## Index

| File                                             | Kind      | Purpose                                                                                            |
| ------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------- |
| `synthetic/provider-usage-sample.json`           | synthetic | Well-formed usage snapshot example used by parsing tests.                                          |
| `synthetic/provider-usage-empty.json`            | synthetic | Provider success response with no quota data.                                                      |
| `sanitized/zai-quota-limit.json`                 | sanitized | Live capture 2026-10-30, redacted: `GET /api/monitor/usage/quota/limit` (limits + plan level).     |
| `sanitized/zai-subscription-list.json`           | sanitized | Live capture 2026-10-30, redacted: `GET /api/biz/subscription/list` (three subscription records).  |
| `sanitized/zai-customer-package-reset-list.json` | sanitized | Live capture 2026-10-30, redacted: `GET /api/biz/customer-package-reset/list?targetType=PERSONAL`. |
| `synthetic/zai-quota-limit-empty-limits.json`    | synthetic | Envelope-valid quota response with an empty `limits` array — no metrics to normalize.              |
| `synthetic/zai-quota-limit-unknown-type.json`    | synthetic | Quota response whose only limit entry carries an unrecognized `type` — unknown-shape handling.     |
| `synthetic/zai-envelope-malformed.json`          | synthetic | Response violating the verified envelope (missing `code`/`data`) — envelope-validation failure.    |

## Sanitized provenance — the `zai-*.json` set

All three `sanitized/zai-*.json` files derive from **one live capture of the real Z.ai Coding
Plan endpoints on 2026-10-30** (redacted; approval and sanitization policy in
[docs/providers/zai-coding-plan.md](../../docs/providers/zai-coding-plan.md), task 095 section;
decision D-040). The files keep the capture's structure, field names, JSON types, and closed
vocabularies (limit types, window-unit enums, MCP `modelCode`s, status/payment/billing/channel
tokens, plan titles, the response envelope) and **re-invent every account-linked value**:
identifiers, dates, prices, quota-state numbers, reset timestamps, product SKUs, and marketing
copy are synthetic. Notes for consumers:

- The monthly quota's consumed fraction intentionally sits at one per-mille of its allowance —
  the capture's exact ratio — because the `percentage` scale (percent vs per-mille) is an open
  contract question the fixture must not resolve; every other quota-state number differs from
  the capture.
- Internal arithmetic is preserved (`currentValue + remaining = usage`; `usageDetails` sum to
  `currentValue`) so parsing tests can rely on the capture's observed consistency.
- The subscription records preserve the capture's observed renewal shape: the annual record's
  `valid` window starts at `nextRenewTime` (with `currentRenewTime` one period earlier, beside
  `paymentType: "WAIT_PAY"`), the monthly records' `valid` spans
  `currentRenewTime`→`nextRenewTime`, and the monthly chain starts where the annual record's
  next renewal lands. The annual offset is part of the observed shape, not an inconsistency —
  its interpretation stays open with 096.
- `customerId` is the same synthetic value in the subscription and reset-card fixtures (one
  account, three endpoints). The capture's redaction markers overwrote identifier types, so
  typings at those positions (numeric `customerId`, UUID-shaped record `id`) are plausible
  reconstructions, not observations.
- Trivial enum-like values (`autoRenew: 0`, `banStatus: 0`, nulls, empty reset-card arrays) and
  small-integer counters (`currentPeriod`, mirroring the observed pending-renewal record
  pattern) coincide with the capture by nature: they carry no account linkage.

Tests must not assert the specific values in the sanitized set — values may be re-invented again
if a future capture replaces it. Assert shapes, vocabulary, and arithmetic instead.
