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
