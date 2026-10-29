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
