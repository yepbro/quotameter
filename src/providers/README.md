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
