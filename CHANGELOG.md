# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE` and attribution `NOTICE` files.
- Project documentation: technical specification, implementation task plan, decision log, contributing guide.
- Docker-based development environment pinned to Node.js 22.13.0 with isolated data volumes.
- Testing foundation: Vitest (unit, integration, component projects), Playwright E2E smoke and accessibility checks, fast-check property tests, local mock provider server, no-network guard.
- Quality gates: ESLint with security and i18n rules, strict TypeScript for server and UI, Prettier formatting, coverage thresholds, Stryker mutation testing.
- CI pipeline: Node.js matrix, Ubuntu/Debian clean-install containers, tarball allowlist check, unsupported-Node behavior test, Dependabot.
- Bootstrap `quotameter` CLI binary reporting the package version with a runtime version gate.
- Application package layout: layered `src/` modules (schemas, util, config, providers, storage, services, server, cli) with documented dependency rules enforced by a structural import-direction test.
- Server bootstrap: process entry point with a runtime gate (Node.js >= 22.13.0, non-root), signal-driven startup/shutdown, and the application lifecycle skeleton in `src/server/`.
- Normalized snapshot and metric model (spec §8.4) in `src/schemas/metrics.ts`: closed `LimitType`/`MetricUnit`/derived-field enums with runtime guards, `ProviderSnapshot`/`NormalizedMetric` types, and spec invariant checks shared by server, storage, API, and UI.
- Central typed configuration contract (spec §6.2) in `src/schemas/config.ts`: TypeBox schemas for server, app, auth, logging, providers (incl. peak-hours), and accounts, with derived types, spec defaults, and cross-field invariant checks; adds the `@sinclair/typebox` runtime dependency.
- XDG path resolution (spec §6.1) in `src/config/paths.ts`: config/data directories from `XDG_CONFIG_HOME`/`XDG_DATA_HOME` defaults with `QUOTAMETER_CONFIG_DIR`/`QUOTAMETER_DATA_DIR` overrides (decisions D-011, D-012).
- Published JSON Schema for `config.json` (spec §6.2, §18) at `schema/config.schema.json`: generated from the configuration contract, shipped in the npm tarball, documented for editor validation (decision D-015).
- Atomic configuration writes (spec §6.3) in `src/config/write.ts`: serialize, same-directory temp file (`O_EXCL`), `fsync`, `rename`, with the file mode pinned to `0600` on every write — interrupted writes can never promote a partial config (decision D-016).
- Provider contracts and `ProviderRegistry` (spec §8.1) in `src/providers/registry.ts`: the `QuotaProvider` interface over the normalized snapshot model, a branded `AccountContext` factory whose secret cannot travel into logs by accident, and a fail-fast registry (duplicate/unknown-id errors).
- Single-instance protection (spec §5.6) in `src/server/single-instance.ts`: an atomic lockfile per data directory (`createSingleInstanceLock` lifecycle component) that refuses a second process with an actionable error, breaks stale locks of dead pids, and releases on shutdown (decision D-017).
- Configuration loading and validation (spec §6.2) in `src/config/load.ts`: the `config.json` loader that compiles the TypeBox contract with Ajv (2020-12), rewords validation failures into field-addressed English problems that never echo secrets, and completes spec defaults into a canonical configuration — invalid configuration cannot silently reach runtime services (decision D-018).
- Configuration permission enforcement (spec §6.3, §15.4) in `src/config/permissions.ts`: startup creates the config directory `0700` (umask-proof at every level), verifies/fixes directory and file to exactly `0700`/`0600`, and refuses to start when unsafe permissions cannot be corrected — foreign ownership, symlinked objects, or an ineffective `chmod` (decision D-019).
- Graceful-shutdown coordination (spec §5.6) in `src/server/shutdown.ts`: a shared in-flight tracker plus the `graceful-drain` lifecycle component that waits for active work — bounded at 10 s — between scheduler shutdown and storage close (decision D-020).
- Environment-variable overrides (spec §6.3, §6.4) in `src/config/env.ts`: `QUOTAMETER_*` variables for the scalar settings apply on top of `config.json` (environment wins; environment-only configuration works when the file is absent), values fail through the same parser as the file, unknown `QUOTAMETER_*` names are rejected, and the result reports which fields and account secrets came from the environment for read-only UI marking (decision D-023).
