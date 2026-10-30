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

| File                                                  | Kind      | Purpose                                                                                                                                    |
| ----------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `synthetic/provider-usage-sample.json`                | synthetic | Well-formed usage snapshot example used by parsing tests.                                                                                  |
| `synthetic/provider-usage-empty.json`                 | synthetic | Provider success response with no quota data.                                                                                              |
| `sanitized/zai-quota-limit.json`                      | sanitized | Live capture 2026-10-30, redacted: `GET /api/monitor/usage/quota/limit` (limits + plan level).                                             |
| `sanitized/zai-subscription-list.json`                | sanitized | Live capture 2026-10-30, redacted: `GET /api/biz/subscription/list` (three subscription records).                                          |
| `sanitized/zai-customer-package-reset-list.json`      | sanitized | Live capture 2026-10-30, redacted: `GET /api/biz/customer-package-reset/list?targetType=PERSONAL`.                                         |
| `synthetic/zai-quota-limit-empty-limits.json`         | synthetic | Envelope-valid quota response with an empty `limits` array — no metrics to normalize.                                                      |
| `synthetic/zai-quota-limit-unknown-type.json`         | synthetic | Quota response whose only limit entry carries an unrecognized `type` — unknown-shape handling.                                             |
| `synthetic/zai-envelope-malformed.json`               | synthetic | Response violating the verified envelope (missing `code`/`data`) — envelope-validation failure.                                            |
| `synthetic/zai-envelope-code-string.json`             | synthetic | Success envelope with `code: "200"` (string spelling) — prototype tolerance variant.                                                       |
| `synthetic/zai-envelope-code-zero.json`               | synthetic | Success envelope with `code: 0` — the other accepted success value.                                                                        |
| `synthetic/zai-envelope-error.json`                   | synthetic | Failure envelope (non-success `code`, `msg` only, no `data`) — assumption-shape A2.                                                        |
| `synthetic/zai-quota-limit-weekly.json`               | synthetic | Response with a weekly `unit 6` entry (absolute values) beside the tokens entry — assumption-shapes A1 + A5.                               |
| `synthetic/zai-quota-limit-tokens-absolute.json`      | synthetic | `TOKENS_LIMIT` entry carrying absolute values and no `percentage`/reset — assumption-shape A5.                                             |
| `synthetic/zai-quota-limit-partial.json`              | synthetic | Response with only the monthly entry — partial limits payload.                                                                             |
| `synthetic/zai-quota-limit-different-plan.json`       | synthetic | Same shapes under `level: "lite"` — different-plan variant.                                                                                |
| `synthetic/zai-quota-limit-different-unit.json`       | synthetic | Known `type`, unseen `unit` (2) — unrecognized pair, skipped and logged.                                                                   |
| `synthetic/zai-quota-limit-duplicate-keys.json`       | synthetic | Two `unit 6` spellings plus a repeated pair — first-wins key-collision handling.                                                           |
| `synthetic/zai-quota-limit-invalid-entries.json`      | synthetic | Three recognized entries with unusable values — invalid metrics, never zero.                                                               |
| `synthetic/zai-quota-limit-reset-time-string.json`    | synthetic | Valid entry with a string `nextResetTime` — metadata defect, `resetsAt` omitted.                                                           |
| `synthetic/zai-quota-limit-renamed-fields.json`       | synthetic | Recognized entries whose value fields were renamed — changed-schema variant.                                                               |
| `synthetic/zai-quota-limit-extra-fields.json`         | synthetic | Verified shape plus extra unknown fields at every level — must parse unchanged.                                                            |
| `synthetic/zai-quota-limit-data-not-object.json`      | synthetic | `data` as an array where endpoints 1/3 expect an object — wrong-typed container.                                                           |
| `synthetic/zai-quota-limit-limits-not-array.json`     | synthetic | `limits` reshaped into an object — wrong-typed container.                                                                                  |
| `synthetic/zai-subscription-list-divergent.json`      | synthetic | Records where first-`VALID` and `inCurrentPeriod` rules diverge; distinct `productName`s make the winner observable — assumption-shape A9. |
| `synthetic/zai-subscription-list-data-not-array.json` | synthetic | `data` as an object where endpoint 2 expects an array — wrong-typed container.                                                             |
| `synthetic/zai-customer-package-reset-cards.json`     | synthetic | Non-empty reset-card arrays and both `last*ResetTime` fields set — assumption-shape A4.                                                    |
| `synthetic/zai-models.json`                           | synthetic | Invented body for `GET /api/coding/paas/v4/models` — status-based check only, never parsed.                                                |

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

## Synthetic Z.ai matrix — task 097 (decision D-049)

The 19 `synthetic/zai-*` fixtures added by task 097 complete the fixture matrix for the
[adapter contract](../../docs/providers/zai-coding-plan.md) (task 096 section): every contract
row that can appear as a parseable response body has a fixture; the sanitized set above already
covers every **verified** row and is deliberately unchanged. All values are invented — nothing
is derived from the 2026-10-30 capture (whose shape exemplars are quoted in the dossier) or
from the sanitized set's re-invented values.

**Origin labels.** Most files are invented edge shapes. Four carry assumption shapes —
`zai-quota-limit-weekly.json` (A1: the weekly `unit 6` entry, documented quota but unobserved
response; absolutes → `CREDITS` per A5), `zai-quota-limit-tokens-absolute.json` (A5: absolute
values on a `TOKENS_LIMIT` entry, percentage-only observed), `zai-customer-package-reset-cards.json`
(A4: card objects `{available, expireTime}` known only from the prototype source; a non-null
`lastWeekResetTime` is likewise unobserved), and `zai-envelope-error.json` (A2: no error sample
exists — `code`/`msg` failure envelopes, and the `success: false` spelling, are invented).
`zai-subscription-list-divergent.json` exercises the **assumed** A9 selection rule with records
where the candidate rules disagree (the first `VALID` record is not the `inCurrentPeriod` one;
an `EXPIRED` status value is likewise invented — only `VALID` was observed). Each record
carries a distinct `productName` (`GLM Coding Pro` / `GLM Coding Max` / `GLM Coding Lite` —
beyond the observed `GLM Coding Pro`, invented compositions of the documented Lite/Pro/Max
tier names) so the selection winner is observable through the only mapped field, the
`planName` fallback.
`zai-models.json` is a pure stand-in: the `/models` body was never captured, credential
validation is status-based (D-047), and no code may ever parse this file's shape.

**Row → fixture map** (096 contract section → files):

| Contract row                                                                | Fixtures                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(TIME_LIMIT, 5)` / `(TOKENS_LIMIT, 3)` percentage-only — verified          | `sanitized/zai-quota-limit.json` (unchanged)                                                                                                                                                                                       |
| `unit 6` weekly entry (A1)                                                  | `zai-quota-limit-weekly.json`, `zai-quota-limit-duplicate-keys.json` (both type spellings)                                                                                                                                         |
| Absolute values → `CREDITS` + partial-triple derivation (A5)                | `zai-quota-limit-tokens-absolute.json` (derives `remaining` and `percentUsed`; also the absent-`nextResetTime` case)                                                                                                               |
| Invalid metrics, never zero                                                 | `zai-quota-limit-invalid-entries.json` (no values; `currentValue + remaining ≠ usage`; string `percentage`) — one entry per metric key so none is lost to first-wins                                                               |
| Metadata defect on a valid entry                                            | `zai-quota-limit-reset-time-string.json` (string `nextResetTime` → `resetsAt` omitted)                                                                                                                                             |
| Envelope success spellings                                                  | `zai-envelope-code-string.json` (`"200"`), `zai-envelope-code-zero.json` (`0`); numeric `200` is every sanitized fixture; `"0"` is an in-test mutation away                                                                        |
| Envelope failure shapes (A2)                                                | `zai-envelope-error.json` (non-success `code` + `msg`, no `data`); `zai-envelope-malformed.json` (missing `code`/`data`; also the `msg`-only envelope)                                                                             |
| Wrong-typed containers                                                      | `zai-quota-limit-data-not-object.json` (endpoints 1 and 3), `zai-quota-limit-limits-not-array.json`, `zai-subscription-list-data-not-array.json` (endpoint 2)                                                                      |
| Unknown pair / different unit — skipped and logged                          | `zai-quota-limit-unknown-type.json` (unknown `type`; also the all-unknown → zero-metric snapshot), `zai-quota-limit-different-unit.json` (known `type`, unseen `unit`)                                                             |
| Empty limits — valid zero-metric snapshot                                   | `zai-quota-limit-empty-limits.json`                                                                                                                                                                                                |
| Key collisions — first-wins                                                 | `zai-quota-limit-duplicate-keys.json` (repeat pair + both `unit 6` types; the duplicate pair carries different values so the survivor is observable)                                                                               |
| §17.1 vocabulary: partial / different-plan / unknown-field / changed-schema | `zai-quota-limit-partial.json`, `zai-quota-limit-different-plan.json`, `zai-quota-limit-extra-fields.json`, `zai-quota-limit-renamed-fields.json`                                                                                  |
| Subscription record selection (A9)                                          | `sanitized/zai-subscription-list.json` (rules coincide), `zai-subscription-list-divergent.json` (rules diverge; distinct `productName`s make the winner observable); the no-`inCurrentPeriod` fallback is an in-test mutation away |
| Reset-card context (A4)                                                     | `sanitized/zai-customer-package-reset-list.json` (empty arrays), `zai-customer-package-reset-cards.json` (non-empty arrays)                                                                                                        |
| Credential check body (098)                                                 | `zai-models.json` — status-based only, never parsed                                                                                                                                                                                |

**Deliberately unfixtured rows** (recorded here instead of forcing files, per the task brief):

- HTTP-level failures — 401/403 (A3), 429, 5xx, timeout, oversized body, wrong content type —
  have no JSON fixture: the transport (D-042) rejects non-2xx responses and transport errors
  before any parsing, so no code path would ever consume such a body. The task-026 mock server
  produces these scenarios (§17.1 transport bullet).
- Trivial cross-cells — `code: "0"`, a non-string `data.level`, and a subscription list with no
  `inCurrentPeriod` record — are one mutation away from shipped fixtures and stay in-test, as
  are three more envelope/container mutations: a success-code envelope with `success: false`
  (the field is not interpreted), a wrong-typed `code` (`null`/`true` — parse error, mutation
  of the error envelope), and an absent `limits` key or `data: null` (mutations of the
  wrong-typed-container fixtures).

**Consumer notes.** Synthetic values are git-stable, so tests may assert them (unlike the
sanitized set). A shared "baseline healthy monthly entry" (`usage` 1200, `currentValue` 60,
`remaining` 1140, `percentage` 5, `nextResetTime` 1799486400000) recurs across the partial,
extra-fields, reset-time-string, duplicate-keys, and renamed-fields files — with each file's
specific deviation applied (the string `nextResetTime` in reset-time-string, the renamed
spellings in renamed-fields) — so that differences between those files are meaningful; the
invalid-entries and different-plan files deliberately use other numbers. The synthetic account
id `customerId: 52714903` is shared by the divergent subscription and reset-card fixtures (one
invented account) and is unrelated to the sanitized set's account.
