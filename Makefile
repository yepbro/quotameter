# Quotameter — development command surface.
#
# All routine development operations go through this Makefile so contributors
# use one consistent entry point regardless of host tooling. Targets run the
# Node.js 22 toolchain inside the Docker development environment; no
# host-installed Node.js is required.

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help
help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: build
build: ## Build (or rebuild) the development image
	docker compose build

.PHONY: up
up: ## Start the development container in the background
	docker compose up -d

.PHONY: down
down: ## Stop the development container (keeps volumes)
	docker compose down

.PHONY: restart
restart: ## Recreate the container after image or Compose changes
	docker compose up -d --build

.PHONY: shell
shell: ## Open an interactive shell in the development container
	docker compose run --rm dev

.PHONY: exec
exec: ## Run a one-off command in the container, e.g. make exec CMD="node -v"
	docker compose exec dev $(CMD)

.PHONY: status
status: ## Show development container status
	docker compose ps

.PHONY: clean
clean: ## Stop the container and remove volumes (dependencies, caches, data)
	docker compose down -v
