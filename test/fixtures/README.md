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

| File | Kind | Purpose |
| ---- | ---- | ------- |
| `synthetic/provider-usage-sample.json` | synthetic | Well-formed usage snapshot example used by parsing tests. |
| `synthetic/provider-usage-empty.json` | synthetic | Provider success response with no quota data. |
