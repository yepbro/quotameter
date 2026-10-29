# `src/providers/` — provider adapters behind one interface

The provider architecture (spec §8): files directly in this directory are the
shared core — the `QuotaProvider`/`AccountContext` contracts and
`ProviderRegistry` (task 070), the HTTP transport wrapper (task 104), and
response sanitization (task 102). One subdirectory per provider holds its
adapter and all provider-specific parsing (`zai-coding-plan/`, Stage 9).

**Rules:** adapters may import only the shared core, `src/schemas/`, and
`src/util/` — never each other, and never services/storage/server. Adapters
are registered by the composition root (`src/server/`) only. Adding a provider
means adding a subdirectory and registering it; nothing else may change.
