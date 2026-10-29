# Quotameter — development command surface.
#
# Every project command runs inside a Docker development environment managed
# by docktree: each git worktree gets its own isolated compose project
# (unique container names, volumes — including node_modules — and ports), so
# parallel worktrees never interfere. Dependencies are synchronized
# automatically before commands run. Start with `make image up` on a fresh
# checkout; afterwards any target brings the container up itself.

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Non-interactive command execution inside the worktree's container.
RUN = docktree exec -T dev --
# Interactive execution (TTY) for shells and watch modes.
RUN_TTY = docktree exec dev --

#@ ─ Container lifecycle ───────────────────────────────────────────────

.PHONY: image
image: ## Build (or rebuild) the development image
	docktree build

.PHONY: up
up: ## Start this worktree's development container
	docktree --json up 2>/dev/null

.PHONY: down
down: ## Stop this worktree's development container (volumes are kept)
	docktree --json down 2>/dev/null

.PHONY: restart
restart: ## Recreate the container after image or Compose changes
	docktree --json up --build 2>/dev/null

.PHONY: status
status: ## Show this worktree's development container status
	docktree --json status 2>/dev/null || true
	@docktree ps --format 'table {{ .Name }}\t{{ .Status }}' 2>/dev/null || true

.PHONY: clean
clean: ## Stop this worktree's container and remove its volumes
	docktree --json down --volumes 2>/dev/null

#@ ─ Interactive ────────────────────────────────────────────────────────

.PHONY: shell
shell: ## Open an interactive shell in the development container
	docktree run --rm dev

.PHONY: exec
exec: ## Run a one-off command, e.g. make exec CMD="node -v"
	$(RUN_TTY) $(CMD)

#@ ─ Everyday checks ───────────────────────────────────────────────────

.PHONY: check
check: format-check lint typecheck test ## Minimal gate: format, lint, types, tests

.PHONY: check-all
check-all: ## Full CI parity: every check CI runs, locally in the container
	@set -e; \
	$(MAKE) --no-print-directory format-check lint typecheck audit licenses; \
	$(RUN) npm run test:ci; \
	$(MAKE) --no-print-directory build; \
	$(RUN) npm run test:e2e; \
	$(RUN) npm run test:mutation; \
	$(MAKE) --no-print-directory package; \
	echo "All checks passed."

#@ ─ Tests ─────────────────────────────────────────────────────────────

.PHONY: test
test: deps ## Run the full Vitest suite (unit, integration, component)
	@$(RUN) npm run test

.PHONY: test-unit
test-unit: deps ## Run only unit tests
	@$(RUN) npm run test:unit

.PHONY: test-integration
test-integration: deps ## Run only integration tests
	@$(RUN) npm run test:integration

.PHONY: test-component
test-component: deps ## Run only Vue component tests
	@$(RUN) npm run test:component

.PHONY: test-coverage
test-coverage: deps ## Run tests with coverage report and thresholds
	@$(RUN) npm run test:coverage

.PHONY: test-ci
test-ci: deps ## Run tests in CI mode (coverage + JUnit report)
	@$(RUN) npm run test:ci

.PHONY: test-e2e
test-e2e: deps build ## Run Playwright E2E against a locally built UI
	@$(RUN) npm run test:e2e

.PHONY: test-watch
test-watch: deps ## Watch mode for local development (interactive)
	$(RUN_TTY) npm run test:watch

#@ ─ Code quality ──────────────────────────────────────────────────────

.PHONY: lint
lint: deps ## Lint source, tests, and configs
	@$(RUN) npm run lint

.PHONY: lint-fix
lint-fix: deps ## Lint and auto-fix where possible
	@$(RUN) npm run lint:fix

.PHONY: format
format: deps ## Rewrite formatting across the tree (Prettier)
	@$(RUN) npm run format

.PHONY: format-check
format-check: deps ## Verify formatting without changing files
	@$(RUN) npm run format:check

.PHONY: typecheck
typecheck: deps ## Type-check the server/Node project
	@$(RUN) npm run typecheck

.PHONY: typecheck-ui
typecheck-ui: deps ## Type-check the UI project (vue-tsc)
	@$(RUN) npm run typecheck:ui

.PHONY: typecheck-all
typecheck-all: deps ## Type-check server and UI projects
	@$(RUN) npm run typecheck:all

#@ ─ Project hygiene ───────────────────────────────────────────────────

.PHONY: audit
audit: deps ## Audit production dependencies (npm audit --omit=dev)
	@$(RUN) npm run audit:prod

.PHONY: licenses
licenses: deps ## Verify dependency licenses against the allowlist
	@$(RUN) npm run license:check

.PHONY: mutation
mutation: deps ## Run Stryker mutation testing
	@$(RUN) npm run test:mutation

.PHONY: package
package: deps ## Check npm tarball contents against the allowlist
	@$(RUN) npm run check:package

.PHONY: schema
schema: deps ## Regenerate the published JSON config schema (schema/)
	@set -e; \
	$(RUN) env SCHEMA_DIR=/var/lib/quotameter/schema npm run schema:generate; \
	mkdir -p schema; \
	$(RUN) cat /var/lib/quotameter/schema/config.schema.json > schema/config.schema.json; \
	echo "regenerated schema/config.schema.json"

.PHONY: build
build: deps ## Build the UI and verify expected artifacts
	@set -e; \
	$(RUN) npm run build:ui; \
	$(RUN) npm run verify:build

.PHONY: verify-runtime
verify-runtime: container ## Verify minimum Node version and node:sqlite
	@$(RUN) node scripts/verify-runtime.mjs

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} \
	  /^#@/ {sub(/^#@ ?/, ""); print "\n" $$0; next} \
	  /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Internal helpers: bring the container up and keep container dependencies in
# sync with the lockfile. Not exposed in `make help`.
.PHONY: container
container:
	@docktree --json up 2>/dev/null || { \
	  echo "Docktree environment is not available. Run: make image && make up" >&2; exit 1; }

.PHONY: deps
deps: container
	@$(RUN) sh -c 'stamp=/var/lib/quotameter/.deps-stamp; \
	  if [ ! -f "$$stamp" ] || [ package-lock.json -nt "$$stamp" ]; then \
	    npm ci --no-fund --no-audit && mkdir -p /var/lib/quotameter && touch "$$stamp"; \
	  fi'
