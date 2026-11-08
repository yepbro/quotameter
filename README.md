# Quotameter

[![CI](https://github.com/yepbro/quotameter/actions/workflows/ci.yml/badge.svg)](https://github.com/yepbro/quotameter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.13.0-brightgreen.svg)](https://nodejs.org/en/about/previous-releases)
[![Platform: Linux](https://img.shields.io/badge/platform-linux-blue.svg)](https://github.com/yepbro/quotameter#development-environment)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Self-hosted personal web service that monitors usage quotas for AI subscriptions. Quotameter periodically retrieves quota snapshots from supported providers, stores history locally in SQLite, detects reset events and collection gaps, and visualizes current values and historical changes in a bundled web UI.

Designed to be installed and operated by one person on their own Linux VPS: distributed as a public npm package with a CLI and a bundled responsive web interface. The 1.0 milestone — the release closing the MVP acceptance criteria; public releases start at `v0.1.0` and iterate toward it ([release policy](docs/release.md)) — supports **Z.ai Coding Plan**; the adapter architecture allows future providers to be added without touching the polling engine, persistence, or charts.

## Key documentation

- [Technical Specification](plan/SPECIFICATION.md) — full requirements: architecture, providers, persistence, security, testing, and release process
- [Implementation Task Plan](plan/tasks.md) — staged, independently reviewable task breakdown with acceptance conditions
- [Decision Log](DECISIONS.md) — key technical and business decisions, their reasons, and consequences
- [Contributing guide](CONTRIBUTING.md) — commit convention, pull-request rules, and repository workflow
- [Configuration reference](docs/configuration.md) — every `config.json` field: type, default, validation, environment override, and restart requirement, drift-guarded against the shipped schema
- [Configuration JSON Schema](docs/config-schema.md) — the published `config.json` schema, editor validation, and regeneration
- [HTTP API reference](docs/api.md) — the published OpenAPI document (`docs/openapi.json`), generated from the same TypeBox contracts the routes validate through
- [Package layout](docs/architecture/package-layout.md) — module map and dependency rules for `src/`, `ui/`, and `bin/`

## Install and operate

Everything needed to run Quotameter on a fresh Linux VPS, in the order you need it: install, first-time setup, accounts, service management, remote access, configuration changes, backups, updates, and troubleshooting. The [configuration reference](docs/configuration.md) documents every `config.json` field; this section stays on the operational path.

### Requirements

- Linux with systemd — Ubuntu LTS and Debian stable are the supported targets; other systemd distributions may work without a guarantee.
- Node.js `>= 22.13.0`. A system-wide install (NodeSource, distro package) or a per-user nvm install both work — the generated service unit pins absolute paths at install time. The CLI refuses to run below the minimum.
- A regular user account. The service itself never runs as root; root (via `sudo`) is only used to install the system-wide service unit.

### Install the package

```bash
npm install -g quotameter
quotameter --help
```

Installation runs no build step and no install-time lifecycle scripts, and the dependency tree is pure JavaScript with no native modules — verified on compiler-free Ubuntu 22.04/24.04 and Debian stable containers ([decision D-196](DECISIONS.md), spec §3/§17.2).

### First-time setup: `quotameter init`

`quotameter init` is an idempotent interactive setup; re-running it shows the current settings and lets you keep or change each one:

1. Environment checks: Node version, systemd availability, and root detection — under `sudo`, the `SUDO_USER` account becomes the service owner.
2. **Time zone (required).** An explicit IANA zone such as `Europe/Berlin`; the machine's local zone may be shown as a hint but is never silently adopted.
3. Bind host (default `127.0.0.1`), port (default `8787`), polling interval (default `300` seconds).
4. An optional first Z.ai account (label + API key) — skippable, you can add it later in the web UI.
5. Web password: optional on a loopback bind (press Enter to keep none), required on a non-loopback bind before the service will start. Minimum length is 12 characters.
6. Directories are created with mode `0700`, the configuration file with `0600`, and the SQLite database is initialized.
7. The initial account's connection is tested; on failure the error is explained and the account is stored in an error state you can fix later.
8. The service is installed and started when possible (see [service scope](#service-scope-system-or-user-and-linger)), then a summary prints the URL, SSH-tunnel access, the `status`/`logs` commands, and the configuration/data paths.

Non-interactive mode takes every value from options:

| Option                   | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `--yes`                  | non-interactive mode                                        |
| `--timezone <zone>`      | IANA time zone — **required** with `--yes`                  |
| `--host <host>`          | bind host (default `127.0.0.1`)                             |
| `--port <port>`          | bind port, 1–65535 (default `8787`)                         |
| `--polling-interval <s>` | seconds, 60–3600 (default `300`)                            |
| `--account-label <name>` | label of the optional initial account                       |
| `--api-key-env <name>`   | environment **variable name** supplying the initial API key |
| `--password-env <name>`  | environment **variable name** supplying the web password    |

A missing `--timezone` under `--yes` is an error, not a fallback to the machine's zone. Secrets are never passed as flag values — only by variable name:

```bash
export ZAI_KEY='…'        # the key itself, referenced by name below
quotameter init --yes --timezone Europe/Berlin \
  --account-label personal --api-key-env ZAI_KEY
```

The interactive flow (or the web UI) takes the simpler road: it stores the key itself in the `0600` configuration file. `--api-key-env` keeps the key out of any file, but a systemd service does **not** inherit your shell's exports — the variable must reach the service manager's environment, or the account stays `Not configured`:

- **System unit:** `sudo systemctl edit quotameter.service` and add

  ```ini
  [Service]
  EnvironmentFile=/etc/quotameter.env
  ```

  with the variable in `/etc/quotameter.env` (mode `0600`, readable by your service account), then `sudo quotameter restart`.

- **User unit:** put the variable in `~/.config/environment.d/quotameter.conf` (mode `0600`), then `systemctl --user import-environment ZAI_KEY` (or log in again) and `quotameter restart`.

These delivery mechanisms are standard systemd facilities the in-container walkthrough of this guide cannot exercise; the generated unit itself never carries the value (spec §5.4 forbids secrets in unit files).

### Get a Z.ai Coding Plan API key

Quotameter's first provider is the Z.ai Coding Plan. With an active subscription, create a key in the Z.ai console's [API key list](https://z.ai/manage-apikey/apikey-list). Verified endpoint behavior and the peak-hours source are documented in [docs/providers/zai-coding-plan.md](docs/providers/zai-coding-plan.md).

### Accounts

- Add more accounts at any time: in the web UI, or by editing the `accounts` array in `config.json` followed by `quotameter reload` — account changes apply live.
- Each account stores its key either as `apiKey` (kept in the `0600` configuration file) or as `apiKeyEnv` (a variable name read from the service's environment at runtime, read-only in the UI — see the delivery step above). At most one of the two may be set (they are mutually exclusive), and a keyless account is valid — key it later.
- Key fields are write-only in the UI: it shows only a mask and whether a key is configured; values are never sent back to the browser.
- Accounts can be disabled (polling stops, history is kept). Removing an account through the API archives it rather than deleting its history.

### Command reference

| Command                        | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `quotameter init`              | First-time configuration and service setup                                          |
| `quotameter run`               | Foreground execution for systemd and debugging                                      |
| `quotameter start`             | Start an installed service through systemd                                          |
| `quotameter stop`              | Stop an installed service through systemd                                           |
| `quotameter restart`           | Restart an installed service through systemd                                        |
| `quotameter reload`            | Reload configuration on SIGHUP without restarting where supported                   |
| `quotameter status`            | Show service status, latest collection, and last error for each account             |
| `quotameter logs`              | Convenient `journalctl` wrapper for system or user service                          |
| `quotameter service install`   | Install the systemd service unit                                                    |
| `quotameter service uninstall` | Remove the installed systemd service unit                                           |
| `quotameter passwd`            | Set or change the web password                                                      |
| `quotameter doctor`            | Diagnose runtime, configuration, database, network, credentials, and service issues |

Every command accepts `-h, --help`; the CLI itself accepts `-v, --version`. `service install`/`service uninstall` manage the unit independently of `init`. Frequently used options:

- `quotameter logs`: `-f, --follow`; `-n, --lines <n|all>` (default `100`); `-o, --output <format>` (default `short-precise`; e.g. `cat`, `json`, `json-pretty`, `verbose`).
- `quotameter service install`: `--restart-sec <seconds>` (default `5`). Re-running install is idempotent and **regenerates the unit file** — the remedy after Node or the package moved (see [troubleshooting](#troubleshooting)).
- `quotameter doctor --raw <account>`: print the sanitized provider responses retained from parse failures (a CLI-only diagnostic).
- `quotameter passwd`: prompts for the new password, stores only a scrypt hash, and revokes every existing session.

Service-control commands operate on whichever unit is installed (system or user scope); when none is installed they print the next step instead of failing cryptically.

### Service scope: system or user, and linger

Two installation scopes:

- **System service** — the supported sequence is a regular-account `init` followed by the privileged install. Do **not** run `init` itself under `sudo`: it would write the configuration under root's home, owned by root, where the service cannot read it, and it installs nothing (it only prints the plan below):

  ```bash
  quotameter init                   # your regular account: config + data with your ownership
  quotameter service uninstall      # remove the user unit init installed, if you want the system service
  sudo quotameter service install   # writes /etc/systemd/system/quotameter.service with User=<you>
  ```

  The generated system unit carries the hardening set of spec §5.4 (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths` limited to the config/data directories), `Restart=on-failure`, and ordering after `network-online.target`; install enables and starts the service and verifies `systemctl is-active` plus a loopback `GET /api/health`. Controlling a system service afterwards needs sudo: `sudo quotameter restart`, `sudo quotameter stop`.

- **User service** — `quotameter init` without sudo: writes `~/.config/systemd/user/quotameter.service` and runs `systemctl --user enable --now`. The user unit carries the compatible minimal hardening (`NoNewPrivileges`) — the mount-namespace directives require privileges the user manager does not have.

A **user service stops when its owner logs out** unless lingering is enabled for the account. `init` checks the linger state and prints the exact command when it is off:

```bash
sudo loginctl enable-linger <user>
```

With linger enabled, the user service keeps running across logout and reboots.

Where systemd is unavailable (some containers, WSL without systemd), `init` says so and prints the exact manual instructions — `quotameter run` in the foreground.

### Remote access

The default bind is `127.0.0.1`: the service is reachable only on the server itself. Two supported ways in from another machine:

#### SSH tunnel (recommended)

From your own machine:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@your-server
```

Then open <http://127.0.0.1:8787> locally. The tunnel forwards a plain loopback connection — nothing new is exposed on the network, and passwordless `auto` mode keeps working. This is the recommended access method for a single-operator deployment.

#### TLS reverse proxy (nginx or Caddy)

For permanent browser access at a name like `https://quotameter.example.com`, put a TLS-terminating proxy in front and make three settings changes:

1. **`auth.mode: required` plus a password** (`quotameter passwd`). Requests arriving through a proxy are recognized by their `Forwarded`/`X-Real-IP`/`X-Forwarded-*` headers and always demand a password — a passwordless service answers such requests with `403` and instructions. `required` is the recommended mode for published deployments (spec §15.1).
2. **Set `server.host` to the public hostname, and pin the name to loopback on the server.** The service validates every request's `Host` header against exactly `localhost`, `127.0.0.1`, `[::1]`, and the configured host, and the login request's `Origin` must match that same host — so the proxy must pass the public name through unchanged, and the name must be the configured host. Pin the name in `/etc/hosts` (`127.0.0.1 quotameter.example.com`): the service then binds loopback — nothing extra is exposed, and the install-time health check passes — while the Host/Origin rules still see the public name. A non-loopback `server.host` also requires a password at startup; the service refuses to start otherwise.
3. **Forward the protocol.** The service never terminates TLS itself. The session cookie — always `HttpOnly` and `SameSite=Strict` — is additionally marked `Secure` when the request rode TLS or the proxy signals it with `X-Forwarded-Proto: https` (or an RFC 7239 `Forwarded` header).

Example nginx site (certificate management via certbot):

```nginx
server {
    listen 443 ssl;
    server_name quotameter.example.com;
    # ssl_certificate / ssl_certificate_key — managed by certbot

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Example Caddyfile (automatic HTTPS):

```caddy
quotameter.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

The two `proxy_set_header` lines matter: nginx's defaults pass neither the original `Host` nor the scheme, while Caddy preserves `Host` and adds `X-Forwarded-Proto` on its own.

With the loopback pin above, port 8787 is never reachable from outside — still keep everything but 22/80/443 closed in your firewall. If you instead let the public name resolve to the server's public address, the service binds that interface: plain-HTTP requests naming the host would pass the `Host` check (the firewall becomes load-bearing), and the install-time health check falsely reports failure because it probes loopback — prefer the pin.

The proxy blocks above are configuration templates: the walkthrough verifying this guide exercises the CLI and the service's request-security contract, not a live nginx or Caddy deployment.

#### Direct non-loopback binding

Binding straight to one concrete non-loopback address works (that address is the configured host, so it passes the `Host` check, and a password is mandatory) but is not recommended: the service speaks plain HTTP, and every client must target that exact address. A wildcard bind (`0.0.0.0`, `::`) is not usable at all — the `Host` validation then rejects requests addressed to any concrete interface name. Use the tunnel or the proxy.

### Configuration changes: live reload vs restart

Edit `config.json` (or use the web UI's settings page), then apply:

```bash
quotameter reload
```

The command validates the file with the same checks the service applies, delivers SIGHUP to the running service, and reports the live-vs-restart classification; the authoritative record of what applied is the service's own `configuration reloaded` log line (`quotameter logs`). Live without a restart: accounts, display time zone, polling interval, retention, the provider peak-hours schedule, the log level, and the web password. Requiring `quotameter restart`: `server.host`, `server.port`, and `auth.mode`. The field-by-field table, including each field's apply class, is in the [configuration reference](docs/configuration.md#applying-changes).

### Files on disk

| Path                                                | Contents                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `~/.config/quotameter/config.json`                  | configuration, account keys, password hash — mode `0600` inside a `0700` directory |
| `~/.local/share/quotameter/quotameter.sqlite`       | the history database (WAL mode: `-wal`/`-shm` files live beside it)                |
| `~/.local/share/quotameter/backups/backup-*.sqlite` | automatic pre-migration backups (internal; the three most recent are kept)         |

Both roots honor `XDG_CONFIG_HOME`/`XDG_DATA_HOME` and the `QUOTAMETER_CONFIG_DIR`/`QUOTAMETER_DATA_DIR` overrides ([paths and precedence](docs/configuration.md#file-locations-and-permissions)). The configuration file plus the data directory are the service's complete state.

### Backups and restore

Back up **both** the configuration file and the data directory. The database runs in WAL mode, so copying only the `.sqlite` file while the service is running can miss recent writes — either stop the service first, or take a consistent snapshot with SQLite itself (`sqlite3`'s `.backup` and `VACUUM INTO` are equivalent for this purpose; the service uses the latter before migrations):

```bash
sqlite3 ~/.local/share/quotameter/quotameter.sqlite ".backup '/home/you/quotameter-backup.sqlite'"
cp ~/.config/quotameter/config.json /home/you/quotameter-config.json
```

Restore:

```bash
quotameter stop        # or Ctrl-C on a foreground run
# restore ~/.config/quotameter/config.json and ~/.local/share/quotameter/
# ownership: the service account; modes are enforced again at startup
quotameter start       # or quotameter run in the foreground
```

Restoring an **older** database alongside a newer package is safe — migrations run forward automatically at startup, taking an automatic backup first. Restoring a **newer** database (for example after downgrading the package) makes the service refuse to start and leave the database untouched — upgrade the package instead.

### Updates

```bash
npm update -g quotameter        # sudo where your npm prefix requires it
quotameter service install      # regenerate the unit with fresh absolute Node/CLI paths
quotameter restart
```

The unit kind an invocation manages follows its privileges: a regular user regenerates the **user** unit, `sudo` the **system** unit. For a system deployment the last two lines are therefore `sudo quotameter service install` and `sudo quotameter restart` — a plain `service install` beside an installed system unit would warn and create a second (user-unit) service over the same data.

The middle step is the one that keeps the unit correct: the generated unit pins the absolute Node and CLI paths from when it was generated, so after a Node upgrade (nvm, NodeSource) or a package reinstall the old unit goes stale. `quotameter doctor` detects exactly this; `quotameter service install` regenerates the unit (idempotent, in the scope the invocation's privileges select). Schema migrations run automatically at startup with a pre-migration backup; see above for the downgrade guard.

### Troubleshooting

Start with the three diagnostic commands:

```bash
quotameter doctor    # runtime, node:sqlite, configuration schema + permissions, time zone,
                     # database (PRAGMA quick_check), per-account connectivity, unit
                     # freshness, port occupancy, network/auth consistency, clock/NTP
quotameter status    # service state; per-account status, latest collection, last error
quotameter logs -f   # the journal, following
```

`doctor` exits `1` when a check fails (or the pre-flight itself fails), and every `[fail]` row names its next step; checks that cannot run (for example `timedatectl` without systemd) are reported `[unavailable]` and never fail the run. `status` additionally warns when the service is running but no account has collected anything for over three polling intervals — the polling engine may have stopped.

| Symptom                                                 | Cause and remedy                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser gets `401` everywhere                           | A password is required — `auth.mode: required`, a non-loopback bind, or a proxied request all demand one. Set it with `quotameter passwd`.                                                                                                                  |
| `403` with instructions in the browser                  | A proxied request reached a passwordless service (spec §15.1). Set a password, then `quotameter reload`.                                                                                                                                                    |
| Signed out everywhere after a password change           | By design: changing the password revokes every session. Log in again with the new password.                                                                                                                                                                 |
| Login slow after repeated failures                      | The limiter applies increasing delays (five failed attempts per source address within 15 minutes) but never rejects — wait, or verify from the server itself. A persistent `401` with a password you believe is correct: reset it with `quotameter passwd`. |
| Account shows `Not configured`                          | Its key comes from an environment variable the service does not see — a shell `export` never reaches a systemd unit. Deliver the variable to the service manager ([the delivery step](#first-time-setup-quotameter-init)) and restart.                      |
| Accounts stop updating; `status` shows `Format changed` | The provider's response format may have changed. `quotameter doctor --raw <account>` prints the sanitized stored response; check [the provider dossier](docs/providers/zai-coding-plan.md) and update the package.                                          |
| Service does not start; the port is occupied            | `doctor`'s port check names the occupancy. Change `server.port` and restart, or stop the other listener.                                                                                                                                                    |
| User service dies when you log out                      | Linger is off for the account: `sudo loginctl enable-linger <user>`.                                                                                                                                                                                        |
| Service fails to start after a Node upgrade             | The unit pins the absolute Node path, which no longer exists. Regenerate with `quotameter service install` (`sudo` for a system unit), then restart; `doctor` detects the stale paths.                                                                      |
| Startup refuses over file modes or ownership            | The configuration directory must be `0700` and the file `0600`, owned by the service account. Startup fixes them when it can, otherwise refuses naming the exact path; `doctor` diagnoses without changing anything.                                        |
| `status` prints the dead-engine warning                 | The service is running but nothing has been collected for over three intervals — the polling engine may have stopped. Check `quotameter logs`, then `quotameter restart`.                                                                                   |

## Project status

Implementation follows [plan/tasks.md](plan/tasks.md) in order, one task per commit. Stages 0–13 have landed: the Docker development environment and quality gates, the layered server architecture with configuration and SQLite storage, the Z.ai Coding Plan provider with polling and retries, time-zone and peak-hours handling with reset detection and history gaps, the CLI, the secured HTTP API, and the Vue web interface with E2E acceptance tests. Remaining plan work is Stage 14 — packaging, final documentation, MVP validation, and the first npm release — plus ongoing hardening tracked as unplanned tasks; no release has been published yet. [plan/SPECIFICATION.md](plan/SPECIFICATION.md) remains the single source of truth for every design decision.

## Development environment

All routine work runs inside a Docker container with the pinned minimum runtime (Node.js 22.13.0); no host-installed Node.js is required. Environments are managed by [docktree](docktree.yml): **each git worktree gets its own isolated compose project** — unique container names, unique volumes (including `node_modules`), and its own port allocations — so parallel worktrees never interfere with each other. The command surface is the [`Makefile`](Makefile): every project command runs in the worktree's container, brings it up automatically, and synchronizes dependencies from the lockfile when it changes. On a fresh checkout run `make image up` once; afterwards any target works on its own.

`make help` prints the same list with one-line descriptions.

### Parallel worktrees

Work on multiple tasks at once by creating a git worktree and starting it the same way:

```bash
git worktree add -b my-feature ~/worktrees/quotamonitor/my-feature
cd ~/worktrees/quotamonitor/my-feature
make up        # isolated containers + volumes for this worktree only
```

Everything works inside the worktree exactly as in the main tree (`make check`, `make test`, …), simultaneously with other worktrees. Useful docktree commands alongside the Make targets:

| Command                           | Effect                                               |
| --------------------------------- | ---------------------------------------------------- |
| `docktree --json status`          | Is anything running for this worktree?               |
| `docktree --json ports [--all]`   | Allocated ports for this (or all) worktree(s)        |
| `docktree --json clean --dry-run` | Preview removal of stale worktree instances          |
| `docktree --json down --volumes`  | Tear down this worktree's containers **and volumes** |

### Container lifecycle

| Command                 | Effect                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `make image`            | Build (or rebuild) the development image                                               |
| `make up` / `make down` | Start / stop this worktree's container (volumes are kept)                              |
| `make restart`          | Recreate the container after image or Compose changes                                  |
| `make status`           | Show this worktree's container status                                                  |
| `make clean`            | Stop this worktree's container and remove **its** volumes (dependencies, caches, data) |

### Interactive

| Command                   | Effect                                     |
| ------------------------- | ------------------------------------------ |
| `make shell`              | Open an interactive shell in the container |
| `make exec CMD="node -v"` | Run a one-off command in the container     |

### Checks

| Command          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make check`     | **Minimal gate** before committing: format check, lint, type checks for server and UI (the exact `typecheck:all` run CI's static job makes, decision D-092), full Vitest suite with coverage and thresholds (~60 s for the suite — the exact `test:ci` run CI's test job makes, including the §17.3 global and critical-module thresholds)                                                                                                                                                                                                                 |
| `make check-all` | **Full CI parity**: everything the required CI job runs — static checks, audit, licenses, tests with coverage and JUnit report, the §17.1 time-zone matrix (`test-time-matrix`: the time/peak-hours suite under all nine zones), UI build with artifact verification, Playwright E2E, tarball allowlist check. Mutation testing runs daily via [`.github/workflows/mutation.yml`](.github/workflows/mutation.yml) and reports to a rolling issue ([how it works and how to triage](docs/mutation-testing.md), D-045); run it manually with `make mutation` |

### Individual commands

| Command                                                           | Effect                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `make test` / `test-unit` / `test-integration` / `test-component` | Run the whole Vitest suite / one project                                                                                          |
| `make test-time`                                                  | The time/peak-hours suite; `ZONE=<iana-zone>` verifies the zone facts first and runs under it (task 126)                          |
| `make test-time-matrix`                                           | The same suite under all nine §17.1 matrix zones, zone-facts guard first (the CI `timezone` job's loop; part of `make check-all`) |
| `make test-coverage` / `test-ci`                                  | Tests with coverage thresholds / CI mode (coverage + JUnit)                                                                       |
| `make test-e2e`                                                   | Playwright E2E against a locally built UI                                                                                         |
| `make test-watch`                                                 | Watch mode (interactive)                                                                                                          |
| `make lint` / `lint-fix`                                          | Lint / lint and auto-fix                                                                                                          |
| `make format` / `format-check`                                    | Rewrite formatting / verify without touching files                                                                                |
| `make typecheck` / `typecheck-ui` / `typecheck-all`               | Type-check server / UI / both                                                                                                     |
| `make audit`                                                      | `npm audit --omit=dev` (policy: [vulnerability policy](docs/security/vulnerability-policy.md))                                    |
| `make licenses`                                                   | Dependency license check against the allowlist                                                                                    |
| `make mutation`                                                   | Stryker mutation testing                                                                                                          |
| `make package`                                                    | npm tarball contents against the packaging allowlist                                                                              |
| `make schema` / `make openapi`                                    | Regenerate the published JSON config schema (`schema/`) / the published OpenAPI document (`docs/openapi.json`)                    |
| `make build`                                                      | Build the UI and the compiled CLI (`dist/`, task 185/D-195), verify the expected artifacts of both                                |
| `make verify-runtime`                                             | Confirm Node `>= 22.13.0` and flagless `node:sqlite`                                                                              |

Layout inside the container:

- `/app` — the repository, bind-mounted for live editing (host changes are visible immediately, no rebuild needed);
- `/app/node_modules` — a named volume shadowing the host path, so host and container dependencies never conflict;
- `/var/lib/quotameter/config` and `/var/lib/quotameter/data` — isolated development paths (`QUOTAMETER_CONFIG_DIR`, `QUOTAMETER_DATA_DIR`) so secrets, SQLite databases, and logs never appear in tracked directories;
- `/home/node/.cache` — a named volume with the npm/Playwright caches to speed up rebuilds.

Data-volume handling:

- `make down` keeps this worktree's dependency, cache, and data volumes; `make up` afterwards restores the previous state.
- `make clean` removes this worktree's volumes, including development configuration and any local SQLite history. This is the supported way to reset the environment to a pristine state; it never touches other worktrees or files outside Docker volumes.
- To point the development data elsewhere, copy [`.env.example`](.env.example) to `.env` and adjust the paths (container-side only; the volumes must stay out of the source tree).

Run `make verify-runtime` after the first build to confirm the minimum runtime: it checks Node.js `>= 22.13.0` and that `node:sqlite` imports without `--experimental-sqlite`.

## Project structure

The application separates server, CLI, provider adapters, services, database access, and shared schemas into layered modules; the frontend (`ui/`) talks only to the HTTP API. The full map with dependency rules is in [docs/architecture/package-layout.md](docs/architecture/package-layout.md) — a structural test (`test/unit/package-layout.spec.ts`) enforces the import directions.

```
bin/            quotameter launcher (plain JS, no build step)
src/
  schemas/      TypeBox contracts (config, API) + the §8.4 model (leaf)
  util/         cross-cutting helpers: clock, logger, version (leaf)
  config/       configuration mechanics: XDG paths, loading, atomic writes
  providers/    provider core (registry, transport) + one <id>/ dir per adapter
  storage/      all node:sqlite access: migrations, QuotaRepository
  services/     PollingService, HistoryService, EventService, PeakHoursService, …
  server/       composition root: Fastify app, HTTP API, lifecycle
  cli/          quotameter commands (init, run, status, doctor, …)
ui/             Vue 3 + Vite frontend (own build)
test/           unit / integration / component / e2e tests, fixtures, helpers
docs/           architecture, provider, security, and release documentation
```
