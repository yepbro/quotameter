# Quotameter

Self-hosted personal web service that monitors usage quotas for AI subscriptions. Quotameter periodically retrieves quota snapshots from supported providers, stores history locally in SQLite, detects reset events and collection gaps, and visualizes current values and historical changes in a bundled web UI.

Designed to be installed and operated by one person on their own Linux VPS: distributed as a public npm package with a CLI and a bundled responsive web interface. Version 1.0 supports **Z.ai Coding Plan**; the adapter architecture allows future providers to be added without touching the polling engine, persistence, or charts.

## Key documentation

- [Technical Specification](plan/SPECIFICATION.md) — full requirements: architecture, providers, persistence, security, testing, and release process
- [Implementation Task Plan](plan/tasks.md) — staged, independently reviewable task breakdown with acceptance conditions
- [Decision Log](DECISIONS.md) — key technical and business decisions, their reasons, and consequences
- [Contributing guide](CONTRIBUTING.md) — commit convention, pull-request rules, and repository workflow

## Project status

The project is in the bootstrapping stage: the specification and the task plan are complete, and implementation work follows [plan/tasks.md](plan/tasks.md) in order. A reproducible Docker-based development environment and setup instructions arrive with Stage 1 of the plan; until then, `plan/SPECIFICATION.md` is the single source of truth for every design decision.

