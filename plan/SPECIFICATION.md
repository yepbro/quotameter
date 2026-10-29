# Quotameter — Technical Specification

**Document version:** 1.0 (final)  
**Project/package/CLI name:** `quotameter`  
**Application type:** Self-hosted personal web service for a Linux VPS  
**Primary runtime:** Node.js `>=22.13.0` + TypeScript (`strict`)  
**Repository:** Public GitHub repository  
**Package distribution:** Public npm package with CLI and bundled web UI  
**Author attribution for the original prototype:** Den Brooks, `denis@yepbro.pro`  
**Specification date:** 28 October 2026

## 1. Purpose and scope

Quotameter monitors usage quotas for AI subscriptions. It periodically retrieves quota snapshots from supported providers, stores history locally, detects reset events and collection gaps, and visualizes current values and historical changes in a web interface.

Version 1.0 supports **Z.ai Coding Plan**. A user may configure multiple subscriptions/accounts, including multiple accounts belonging to the same provider. The architecture must allow future providers to be added through isolated adapters without rewriting the polling engine, persistence, history API, or charts.

The application is installed and operated by one person on their own Linux VPS. It is not a hosted service. It has no registration, user directory, roles, or multi-user features. Configuration, credentials, and history remain on the user's server.

### 1.1 In scope for MVP

- Public npm package named `quotameter`, a CLI, and a bundled responsive web UI.
- Linux systems with `systemd`; primary targets are Ubuntu LTS and Debian stable.
- Node.js `>=22.13.0`, TypeScript, Fastify, Vue 3, and the built-in `node:sqlite` module.
- One or more Z.ai Coding Plan accounts; account management, connection tests, periodic collection, state reporting, history, charts, quota reset markers, collection-error markers, and configured peak-hour highlighting.
- Secure local configuration, optional password-based remote access, hardened `systemd` service, CLI diagnostics, migrations, retention, backups, automated tests, CI, and English documentation.

### 1.2 Out of scope for version 1.0

- User registration, multiple users, roles, or a public hosted/cloud service.
- macOS or Windows support.
- Providers other than Z.ai Coding Plan (the architecture must remain extensible).
- Notifications or messenger integrations.
- Automatic quota reset, quota purchases, or other account actions at the provider.
- Usage forecasts.
- CSV/JSON history export.
- Editing the provider's peak-hours schedule in the web UI; the schedule is configured in the local configuration file and is read-only in the UI.

## 2. Product principles

1. **User-owned data:** all settings, secrets, and historical records live on the user's VPS; no developer-operated server is involved.
2. **Background collection:** collection continues while the browser is closed.
3. **Simple installation:** no external database, message broker, compiler, or native dependency build is required on the target host.
4. **Provider isolation:** each provider implements a common adapter interface.
5. **Measurement integrity:** missing, malformed, or unknown data is never silently converted to zero. Collection errors are visible and previous valid values remain available.
6. **Explicit time zones:** the user's display time zone is chosen explicitly and is independent of the VPS and browser time zones.
7. **Small attack surface:** secure defaults, minimal runtime dependencies, no public binding by default, and careful secret handling.
8. **English-only project artifacts:** source comments, commits, documentation, CLI messages, API errors, logs, and UI copy are in English. The UI has i18n infrastructure from the beginning.

## 3. Technology and packaging

| Concern                         | Required implementation                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Runtime                         | Node.js `>=22.13.0`; `engines` field must enforce the minimum                                 |
| Language                        | TypeScript, `strict: true`                                                                    |
| HTTP server                     | Fastify, `@fastify/static`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`       |
| Schemas / validation            | TypeBox + Ajv; JSON Schema is the source for runtime validation and OpenAPI                   |
| Database                        | Built-in `node:sqlite`; SQLite WAL mode                                                       |
| Migrations                      | Migration library, preferably Umzug; migrations are forward-only and recorded in the database |
| Time zones                      | Luxon on the server; `Intl.DateTimeFormat` in the browser                                     |
| UI                              | Vue 3, Vite, Vue Router, `vue-i18n`; Pinia only if it proves useful                           |
| Charts                          | Apache ECharts, modular imports                                                               |
| Logs                            | Pino through Fastify, JSON to stdout/stderr and journald                                      |
| Unit/component tests            | Vitest, Vue Test Utils, `fast-check`                                                          |
| Browser E2E                     | Playwright; accessibility smoke checks with axe                                               |
| Formatting / lint / type checks | ESLint, TypeScript compiler, Prettier                                                         |
| CI                              | GitHub Actions                                                                                |

`node:sqlite` is still an evolving/experimental API in the supported Node 22 line. All database access must be isolated behind a storage module/interface. Test its behavior under every supported Node version. Suppress the expected `ExperimentalWarning` through a documented, supported runtime mechanism only; do not hide unrelated warnings. Use `node:test` for storage tests if the chosen Vitest configuration cannot safely load `node:sqlite`.

The frontend must be built before package publication. The npm tarball includes the ready-to-serve `dist/` output, so the user does not need to build the frontend during installation. Do not use `postinstall` scripts or native modules. Support x64 and arm64 without compilation. Pin dependencies through the lockfile and keep runtime dependencies minimal.

## 4. Repository, language, licensing, and release process

### 4.1 Public repository and language

The source repository is public on GitHub. All repository artefacts use English: branch names, issues, pull requests, commit subjects and bodies, source comments, docs, UI strings, CLI output, API errors, and logs. Use Conventional Commits. Protect the default branch and require successful CI before merging.

### 4.2 Package name

Use `quotameter` as the intended npm package name and CLI command. Recheck npm name availability immediately before reserving/publishing; a previous check recorded in the draft must not be treated as a permanent reservation. Use `QUOTAMETER_*` for environment variables and `quotameter` for service/config/data paths.

### 4.3 License and attribution

Use the MIT License, subject to verifying compatibility with the license of any inherited prototype code and every included third-party component. Include `LICENSE` and `NOTICE`, with attribution to the original prototype author: Den Brooks, `denis@yepbro.pro`. Do not copy prototype code unless its provenance and license compatibility have been checked.

### 4.4 CI/CD and supply-chain safeguards

GitHub Actions must run formatting checks, linting, type checks, tests, coverage, build, package-content checks, `npm pack`, dependency vulnerability checks, and clean-install smoke tests. The CI matrix must cover Node.js 22 (minimum supported minor), Node.js 24, and the current Node.js LTS when available; use containers for Ubuntu 22.04, Ubuntu 24.04, and Debian targets where applicable. Validate package installation and startup on the declared minimum runtime.

Publish to public npm **only from CI** on a `vX.Y.Z` Git tag using trusted publishing/provenance. Follow semantic versioning and maintain a `CHANGELOG.md`. Configure npm account 2FA. Use a restrictive `files` allowlist in `package.json`; do not ship tests, local secrets, temporary files, or development-only artefacts. Run `npm audit --omit=dev` and dependency-license checks in CI. Enable Dependabot or Renovate for dependency updates.

## 5. Installation, CLI, and service lifecycle

### 5.1 Supported environment

Install with `npm install -g quotameter` on Linux with `systemd` and Node.js `>=22.13.0`. Ubuntu LTS and Debian stable are the supported targets; other `systemd` distributions may work without a guarantee. The service must never run as root.

### 5.2 CLI commands

| Command                                    | Purpose                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `quotameter init`                          | First-time configuration and service setup                                          |
| `quotameter run`                           | Foreground execution for systemd and debugging                                      |
| `quotameter start`, `stop`, `restart`      | Control an installed service through systemd                                        |
| `quotameter reload`                        | Reload configuration on SIGHUP without restarting where supported                   |
| `quotameter status`                        | Show service status, latest collection, and last error for each account             |
| `quotameter logs`                          | Convenient `journalctl` wrapper for system or user service                          |
| `quotameter service install` / `uninstall` | Install or remove the service independently of `init`                               |
| `quotameter passwd`                        | Set or change the web password                                                      |
| `quotameter doctor`                        | Diagnose runtime, configuration, database, network, credentials, and service issues |

Systemd provides daemonization; do not implement a custom double-fork or PID-file mechanism. If service control is requested before installation, display a helpful next step instead of failing cryptically.

### 5.3 `init` workflow

`init` must be idempotent: on subsequent runs, display current settings and let the user keep or change them.

1. Check Node.js version, availability of systemd, and whether the process is running as root. If invoked through `sudo`, use `SUDO_USER` to determine the service owner.
2. Require the user to explicitly provide an IANA time zone; validate it. The OS/server time zone may be displayed as a hint but must never be silently adopted.
3. Ask for bind host (default `127.0.0.1`), port (default `8787`), polling interval (default 300 seconds), and an optional initial Z.ai account label/API key. The user may skip adding a key and add it later in the UI.
4. If the selected bind host is not loopback, require a password before starting the service.
5. Create configuration/data directories with mode `0700`, configuration file with mode `0600`, and the database.
6. Test the initial provider connection. If it fails, explain the error and offer to continue with the account in an error state.
7. Install and enable a service when possible:
   - With root privileges (for example `sudo quotameter init`), or with the user's consent to invoke `sudo` only for the privileged operation, install `/etc/systemd/system/quotameter.service`. Set `User=` to the regular account, enable/start the service, then verify `systemctl is-active` and `/api/health`.
   - Without sudo, install a user unit under `~/.config/systemd/user/` and run `systemctl --user enable --now`. If linger is disabled, print the exact `sudo loginctl enable-linger <user>` command and explain why it is needed for operation after logout/reboot.
   - If systemd is unavailable or installation fails, provide exact manual-run instructions.
8. Print a summary with the URL, SSH tunnel instructions, `status`/`logs` commands, and configuration/database paths.

Support non-interactive mode through `--yes` and explicit command-line options such as `--timezone`, `--host`, and `--port`. API keys may be supplied through an environment variable. `--timezone` is mandatory in non-interactive mode; absence is an error, not an invitation to use the machine's time zone.

### 5.4 systemd unit requirements

Use absolute paths to the current Node binary (`process.execPath`) and CLI entry point because Node may be installed through nvm or NodeSource. Set `Restart=on-failure`, configurable `RestartSec`, `After=network-online.target`, `Wants=network-online.target`, and `Environment=NODE_ENV=production`. For system units, apply compatible hardening including `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`, and `ReadWritePaths` limited to application config/data directories. Use a compatible minimal hardening set for user units. Never put secrets in unit files. Send output to journald.

`doctor` must detect stale Node/CLI paths in an installed unit. `quotameter service install` must regenerate the unit.

### 5.5 `doctor`

Check Node version and `node:sqlite`, configuration-schema validity, secret/config directory permissions, IANA time zone, database open and `PRAGMA quick_check`, connectivity for each account, service state and unit freshness, port occupancy, consistency between network/authentication settings, and system clock/NTP status via `timedatectl`. `quotameter doctor --raw <account>` may show sanitized provider responses stored for parse failures; this diagnostic is CLI-only.

### 5.6 Process lifecycle, backups, and upgrades

On SIGTERM, stop scheduling new polls, wait up to 10 seconds for an in-progress request, close the database, and checkpoint WAL. Prevent a second process from using the same data directory at the same time. Before any schema migration, create a database backup using `VACUUM INTO`; retain the three most recent automatic backups. Upgrade with `npm update -g quotameter` followed by `quotameter restart`.

## 6. Configuration and secrets

### 6.1 Paths

Use XDG paths:

- Configuration: `$XDG_CONFIG_HOME/quotameter/config.json`, default `~/.config/quotameter/config.json`.
- Data: `$XDG_DATA_HOME/quotameter/`, default `~/.local/share/quotameter/`.
- Overrides: `QUOTAMETER_CONFIG_DIR` and `QUOTAMETER_DATA_DIR`.

### 6.2 Configuration contract

Configuration is JSON and is validated at startup and reload against a published JSON Schema. On invalid startup configuration, refuse to start and explain the problem. On invalid reload, retain the last valid in-memory configuration and report the error.

The final schema must cover `server` (host/port), `app` (explicit IANA time zone, polling interval, history retention), `auth`, `logging`, provider configuration including `peakHours`, and an array of accounts (stable id, provider id, label, enabled state, and secret source). Document the definitive format and publish an example. Example keys from this specification are illustrative, not an additional contract.

### 6.3 Secret storage and writes

API keys and the password hash are stored in the config file, not the database. The config file must have mode `0600` and its directory `0700`. On startup, verify permissions; fix them when possible, otherwise refuse to continue. Allow `apiKeyEnv` as an alternative to `apiKey`, but exactly one may be set for an account. Environment-defined values take precedence and are read-only in the UI.

A key may be entered in the UI, but the form is write-only: neither the saved value nor the API response may reveal it. Show only a mask and whether a key is configured. Write configuration atomically using a temporary file, `fsync`, and `rename`, while preserving permissions.

### 6.4 Change application

The polling interval, display time zone, retention period, account list/labels/keys/enabled states, and provider peak-hour schedule apply after a successful reload without a process restart. Changes to `server.host`, `server.port`, or authentication mode require a restart; the UI must label them “restart required” and show `quotameter restart`.

## 7. Periodic data collection and failures

### 7.1 Polling

- Default interval: **300 seconds (5 minutes)**. Valid range: 60–3600 seconds, checked both in UI/CLI inputs and configuration loading.
- Run the first collection immediately after service startup and immediately after every process restart.
- Never run overlapping requests for the same account. Poll accounts sequentially with random jitter up to 10% of the configured interval.
- Measure intervals using monotonic time; store actual wall-clock collection timestamps in the database.
- Do not backfill collection cycles missed while the service was stopped and never insert synthetic values for them.

### 7.2 Retry and error behavior

Default HTTP request timeout is 15 seconds; configurable range is 5–60 seconds.

| Failure                                                              | Required behavior                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network failure, timeout, HTTP 5xx                                   | Up to three retries with exponential delays of 2, 4, and 8 seconds plus jitter within the current cycle. Store one collection-run record with the total attempt count.                                       |
| HTTP 429                                                             | Do not retry within the current cycle. Respect `Retry-After` up to one hour and do not poll before that time.                                                                                                |
| HTTP 401/403                                                         | Do not retry within the current cycle. Set `Auth rejected`; pause normal polling for that account until the key changes or a manual test is requested. Perform a verification attempt once every 60 minutes. |
| Invalid JSON, unexpected response schema, or missing required fields | Set `Format changed`, do not write metric values, and retain a sanitized response for CLI diagnostics.                                                                                                       |

A failure for one account/provider must not stop other accounts. Retain and display the latest valid values and their collection time after an error. Missing data and provider errors must never be represented as zero. The UI must show the most recent successful collection and most recent error for each account.

### 7.3 Account status precedence

When choosing the primary displayed status, use this order:

1. `Auth rejected`
2. `Format changed`
3. `Unreachable` (latest cycle failed due to network issue, timeout, or 5xx)
4. `Stale` (no successful collection for more than three configured collection intervals)
5. `Collecting`
6. `Fresh` (latest successful collection is no older than three configured intervals)

Also support `Disabled` and `Not configured` as separate states.

### 7.4 Sanitized raw responses

Store a provider response only when parsing/schema validation fails. Sanitize it before storage, cap each response at 64 KiB, retain no more than 20 responses per account and no more than 30 days, and expose these responses only through `quotameter doctor --raw <account>` (never over HTTP or in the web UI).

Sanitization must replace exact occurrences of each configured secret value with `[REDACTED]`, and remove fields named `api_key`, `apiKey`, `authorization`, `secret`, `password`, `access_token`, `refresh_token`, or `cookie` case-insensitively as appropriate. Do **not** redact every field whose name contains `token`, because legitimate quota payloads may include `tokens`.

## 8. Provider architecture and Z.ai adapter

### 8.1 Provider interface

Implement a common interface equivalent to:

```ts
interface QuotaProvider {
  readonly id: string;
  readonly name: string;
  validateCredentials(account: AccountContext): Promise<void>;
  fetchSnapshot(account: AccountContext, signal: AbortSignal): Promise<ProviderSnapshot>;
}
```

`AccountContext` contains the stable account id, label, and provider secret. Secrets must remain in process memory and must not be logged. Core services include `ProviderRegistry`, `PollingService`, `QuotaRepository`, `HistoryService`, `EventService`, `PeakHoursService`, `ConfigService`, and `AuthService`.

Adding a provider must require implementing/registering an adapter and must not require rewriting the scheduler, persistence, history endpoints, or chart components.

### 8.2 Accounts

An account consists of provider, label, and secret. Support multiple accounts per provider. Each account has its own collection history, state, and errors. The UI/API must support add, rename, enable/disable, replace key, test connection, and archive/delete. Deleting an account archives it while retaining history; purging history requires a separate explicit action with confirmation. Peak-hours configuration is shared by all accounts of a provider.

### 8.3 Z.ai Coding Plan integration contract

Implement `ZaiCodingPlanProvider` using verified Z.ai Coding Plan usage/quota behavior. Official documentation references:

- [Z.ai Developer Documentation — Coding Plan Overview](https://docs.z.ai/devpack/overview) — plan allowance, credit calculation, reset rules, supported models, peak-hours and off-peak credit rate.
- [Z.ai API / Coding Plan documentation entry point](https://docs.z.ai/) — use the documentation current at implementation time for authentication and supported API endpoints.
- [Z.ai / ZCode connection configuration](https://zcode.z.ai/en/docs/configuration) — describes Z.ai Coding Plan API-key mode and the coding API base URL. That base URL is for model requests; it must **not** be assumed to be a quota-statistics endpoint.

The public documentation located during specification finalization describes quota policies but does not provide a verified, stable quota-statistics response schema in the Coding Plan overview. During implementation, first inspect the original prototype and confirm the actual usage-statistics endpoint and authentication against available provider documentation or a sanitized live response. Document the verified request/response contract and its source. Do not invent undocumented endpoints, fields, or sample responses. If no officially documented statistics endpoint exists, clearly document the integration's verified source and limitations before claiming the adapter complete.

Create `docs/providers/zai-coding-plan.md` containing the verified endpoint/method, authentication/header handling, request parameters, response structure, metric mapping, units, percentages, reset timestamps, plan-name extraction, limitations, and the documentation/reference URLs with retrieval date. Use fixtures for sanitized real responses where available and synthetic fixtures for partial/unknown/error cases. Keep all provider-specific response parsing inside this adapter.

Collect every supported metric returned by the verified usage endpoint, including where available: rolling 5-hour quota, weekly quota, monthly tool/MCP quotas, used/remaining/limit values, percentages, next reset time, and plan name. Not every plan necessarily exposes every field. Never combine incompatible units (tokens, credits, requests/calls, percentages).

### 8.4 Normalized snapshot and metric model

Use a provider-neutral snapshot equivalent to:

```ts
interface ProviderSnapshot {
  providerId: string;
  collectedAt: number; // UTC epoch milliseconds
  planName?: string;
  metrics: NormalizedMetric[];
}

interface NormalizedMetric {
  key: string; // stable, adapter-defined identifier
  label: string; // English display label
  limitType: "ROLLING_WINDOW" | "DAILY" | "WEEKLY" | "MONTHLY" | "OTHER";
  unit: "TOKENS" | "CREDITS" | "REQUESTS" | "PERCENT";
  windowSeconds?: number;
  used?: number;
  remaining?: number;
  limit?: number;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: number; // UTC epoch milliseconds
  isValid: boolean;
  invalidReason?: string;
  derivedFields?: string[];
}
```

Rules:

- `limitType` and `unit` are closed enums. Adding an enum value requires a code change and a database migration.
- `unit` applies to `used`, `remaining`, and `limit`; percentage fields are always percentage values. If only percentage values are returned, use `unit: 'PERCENT'` and leave absolute fields empty.
- Store both used and remaining when the provider supplies both.
- A missing value may be derived only when the required original fields are supplied (for example `remaining = limit - used`). List derived field names in `derivedFields`. Never derive token counts from percentages.
- Validity is per metric. An invalid metric is stored without numeric values (not as zero) and includes `invalidReason`.

## 9. Peak-hours schedule

### 9.1 Official Z.ai schedule

As checked on 28 October 2026, the official [Z.ai Coding Plan Overview](https://docs.z.ai/devpack/overview) specifies peak hours as **Monday through Friday, 14:00–18:00 Singapore Standard Time (UTC+8)**. Outside these hours, model usage is charged at **50% of the standard credit rate**. Saturday and Sunday are therefore off-peak under the published schedule. Record the documentation URL and verification date in `docs/providers/zai-coding-plan.md`.

Represent the schedule as provider configuration shared by its accounts. Use `Asia/Singapore` as the schedule time zone. The configured `multiplier` represents the quota-credit rate relative to the standard rate: `1.0` during peak windows and `0.5` outside peak windows (`offPeakMultiplier`). This is descriptive schedule metadata; the application must not rewrite collected provider values or infer new quota values from these multipliers.

The rate schedule does not mean that every model has the same base credit cost. Base model and MCP pricing is separate. The current UI may show the temporal rate schedule only; it must not claim to calculate exact per-model cost unless the provider supplies enough model-level usage data.

### 9.2 Configuration and validation

The schedule belongs to `providers.<providerId>.peakHours` and applies to all provider accounts. In the web UI it is read-only; the user edits the JSON file and runs `quotameter reload`.

Configuration fields include `timezone`, `offPeakMultiplier`, and an array of windows with stable `id`, human-readable `name`, `days`, `start`, `end`, and `multiplier`. A sample for the documented schedule:

```json
"peakHours": {
  "timezone": "Asia/Singapore",
  "offPeakMultiplier": 0.5,
  "windows": [
    {
      "id": "zai-weekday-peak",
      "name": "Z.ai Coding Plan peak hours",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "14:00",
      "end": "18:00",
      "multiplier": 1.0
    }
  ]
}
```

Validation rules:

- `timezone` must be a valid IANA identifier and is independent from the user's display time zone.
- `days` is a subset of `mon` through `sun`; calendar day selection uses the schedule time zone.
- `start` and `end` use `HH:mm`; `end` may be `24:00`; `start` must be earlier than `end`.
- A window cannot cross midnight. Represent cross-midnight periods as separate windows assigned to their respective calendar days.
- Windows for the same day may not overlap.
- Multipliers must be positive numbers. If omitted, `offPeakMultiplier` defaults to `1.0`; for the Z.ai schedule it must explicitly be `0.5`.
- If no verified schedule is available for a future provider, use an empty `windows` array and show “Peak-hours schedule is not configured”. Never invent a schedule.

### 9.3 Schedule calculation and display

`PeakHoursService` must return UTC intervals for the requested time span together with the window name, multiplier, and local time in the schedule time zone. The browser must not calculate windows independently. A window represents the actual interval between local start/end instants, so duration can differ around daylight-saving transitions in time zones that observe DST. Handle nonexistent local times by shifting forward by the gap and ambiguous local times by selecting the first occurrence. Document and test these rules.

Peak-hour highlighting is for visual comparison only. It must not modify measured values or create synthetic data points. Forecasting is out of scope.

## 10. Time and time zones

- Maintain two independent settings: the user display time zone (`app.timezone`) and the peak-hours schedule time zone.
- The user time zone is mandatory and explicitly selected during `init`; it must never silently inherit the server/OS time zone. The app must work consistently under any `TZ` environment setting.
- Store all timestamps as UTC Unix epoch milliseconds (`INTEGER`) in SQLite. API timestamps use ISO 8601 UTC ending in `Z`. Format timestamps in the client with `Intl.DateTimeFormat` and the configured display time zone.
- “Last N hours/days” means a rolling interval ending now. Compute and pass explicit `from`/`to` bounds to the server; filter history server-side.
- Changing `app.timezone` changes presentation only and must not rewrite records.
- Assume that VPS time is synchronized by NTP; `doctor` warns if the system clock is not synchronized.

## 11. Persistence, schema, retention, and migrations

### 11.1 Database settings

Database path: `<data>/quotameter.sqlite`; create it automatically. Configure `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and `synchronous=NORMAL`. Configuration, account secrets, and password hash remain in the config file; the database stores history, collection metadata, events, sanitized parse-error responses, sessions, and service metadata. Store all timestamps as integer UTC epoch milliseconds.

Always store a snapshot for every successful collection even if no values changed. Store a run record for every collection cycle, successful or unsuccessful. Write the snapshot, its metric rows, and associated events in one transaction.

### 11.2 Required logical tables

The implementation may refine physical details and indexes, but must preserve these entities and semantics:

- `accounts`: stable account id, provider id, label, optional plan, active/archived status, created/archived timestamps; synced from configuration. Credentials are not stored here.
- `collection_runs`: one record per polling cycle; account, start/end, interval in effect, outcome (`success`, `auth_error`, `rate_limited`, `network_error`, `timeout`, `server_error`, or `parse_error`), HTTP status, sanitized error information, attempts, and retry-after seconds.
- `snapshots`: one row per successful run, account, run id, collection time, plan name.
- `metric_values`: one row per metric per snapshot, denormalized account/time for series queries, metric key, `limit_type`, `unit`, window size, used/remaining/limit, percentages, reset time, validity, invalid reason, and derived fields.
- `quota_events`: account, metric key, type (`RESET` in version 1), event time, optional snapshot id, and JSON details.
- `raw_responses`: only sanitized provider payloads for parse failures; one per run; timestamp, HTTP status, content type, body.
- `sessions`: hash of the session token, created/last-seen/expiry times; never store the raw cookie token.
- `meta`: key/value service state, including cleanup metadata as needed.
- Migration metadata maintained by the migration library.

Use strict SQLite tables where feasible and constraints for enum values. Required indexes include series access `(account_id, metric_key, collected_at)`, snapshots by account/time, runs by account/start and account/outcome/start, events by account/metric/time, and sessions by expiry. Use cascading deletion consistently for purged account history. Invalid metric rows must store `NULL` numeric fields and an `invalid_reason`, never zero placeholders. A valid metric row must include at least one usable numeric metric value.

### 11.3 Retention and cleanup

Default retention is 180 days; accepted range is 7–3650 days. Cleanup runs at startup and daily: delete expired runs, snapshots, metric values, events, expired sessions, and out-of-policy raw responses. Then checkpoint WAL and run `incremental_vacuum` where supported/configured. Do not delete configuration, account metadata needed for current state, or connection settings. When a user reduces retention, warn that older records will be removed at the next cleanup.

At a five-minute interval, expect approximately 52,000 snapshots per account per 180 days, plus one metric row per metric in each snapshot. History queries must be indexed and should remain usable at that scale.

### 11.4 Migrations and backup behavior

Use a migration library such as Umzug; migrations are forward-only and tracked in the database. Before applying migrations, create a backup using `VACUUM INTO` and retain the three most recent automatic backups. Apply migrations automatically at startup. If the database schema is newer than the running application supports, refuse to start and leave the database unchanged. Each schema release must have a migration-forward test from the previous supported schema.

## 12. Events, reset detection, and missing data

### 12.1 Quota reset events

Compare each new snapshot with the previous **valid** point for the same account and metric. Record a `RESET` event when either condition is met:

1. Usage (`used` or `percentUsed`) decreases, or remaining quota (`remaining` or `percentRemaining`) increases by more than the allowed rounding tolerance.
2. The previous point's declared `resetsAt` has passed and the new point reports a later `resetsAt`.

If `resetsAt` from the previous point lies between the two snapshots, use that timestamp as the event time; otherwise use the new snapshot timestamp. Store the detection evidence in `details`.

Use the **conservative approach** for rolling windows: their quota can replenish gradually, so tune thresholds/exceptions against fixtures. Do not create a reset event when evidence is ambiguous. Invalid points do not participate in comparisons. Document the algorithm and test real sanitized and synthetic sequences, including false-positive cases.

### 12.2 Collection gaps and errors

A gap is the interval between adjacent successful snapshots for a metric when the elapsed time exceeds **three polling intervals**, using the `interval_s` in effect at the relevant collection time. Break the chart line across a gap (`connectNulls: false`) and include an explicit empty point between gap edges; do not interpolate values.

Show separate timeline indicators for (a) failed collection cycles, taken from `collection_runs` with a non-success outcome, with distinct symbol/tooltip per error type, and (b) periods with no collection-run records, shown as a hatched area indicating the service was stopped. Provide the event/interval data through `GET /api/events`.

## 13. HTTP API

The API is internal to the web interface. Define every request and response through TypeBox/JSON Schema and generate OpenAPI from the same schema. All endpoints require authentication when authentication is enabled, except the public health response as described below.

| Method   | Path                                  | Purpose                                                                                                                      |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                         | Unauthenticated response contains only `{ "status": "ok" }`; authenticated response may include process/database diagnostics |
| `GET`    | `/api/status`                         | Service state and each account's status, last success, and last error                                                        |
| `GET`    | `/api/providers`                      | Available provider types and read-only peak-hour schedules                                                                   |
| `GET`    | `/api/accounts`                       | Accounts, with keys masked                                                                                                   |
| `POST`   | `/api/accounts`                       | Add an account; key is write-only                                                                                            |
| `PATCH`  | `/api/accounts/:id`                   | Change label, enable state, or key                                                                                           |
| `DELETE` | `/api/accounts/:id`                   | Archive; `?purgeHistory=true` explicitly purges history                                                                      |
| `POST`   | `/api/accounts/:id/test`              | Test provider connection                                                                                                     |
| `GET`    | `/api/quota`                          | Latest successful snapshot for `accountId`                                                                                   |
| `GET`    | `/api/history`                        | Metric series by `accountId`, `metric`, `from`, `to`, `maxPoints`                                                            |
| `GET`    | `/api/events`                         | Resets, gaps, and collection failures by account/time/metric                                                                 |
| `GET`    | `/api/peak-hours`                     | UTC peak/off-peak intervals for `accountId`, `from`, `to`                                                                    |
| `GET`    | `/api/settings`                       | Safe settings view with secrets omitted/masked                                                                               |
| `PUT`    | `/api/settings`                       | Update settings allowed for runtime modification                                                                             |
| `POST`   | `/api/auth/login`, `/api/auth/logout` | Login and logout                                                                                                             |
| `GET`    | `/api/auth/session`                   | Current session and auth-mode information                                                                                    |

API requirements:

- `from` and `to` are required ISO 8601 UTC values for history, events, and peak-hours. Reject or explicitly truncate requested ranges beyond retention and state that in the response.
- `GET /api/history` returns series with unit, limit type, and validity; missing intervals are represented by empty points.
- `maxPoints` defaults to 1500 and accepts 100–5000. If a range has more points, aggregate into time buckets while preserving each bucket's minimum, maximum, first, and last points. Reset events and gap boundaries must not be lost. Include the effective resolution in the response.
- Use a common error envelope: `{ "error": { "code": "...", "message": "...", "details": ... } }`. `code` is stable and machine-readable. Messages must not reveal secrets or internal filesystem paths.
- All state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) require Origin/Fetch Metadata validation and a mandatory custom header as described in §15.3. CORS must remain disabled.
- Never return API keys. Return only a mask and a boolean indicating whether the key is configured.
- Document and test all request/response formats. Generate and publish OpenAPI.

## 14. Web interface

### 14.1 General UI requirements

Create a minimal, responsive interface that works from 360 px wide and is suitable for continuous use. The only shipped language is English, but all strings must live in the `en` locale catalog through `vue-i18n`; hardcoded strings in components are prohibited and checked by lint/tests. Format dates and numbers with `Intl` using the configured display time zone.

Support `system`, `light`, and `dark` themes. Persist the choice in browser storage and style charts for both light and dark modes. Meet WCAG AA contrast, support keyboard navigation, and never rely on color alone to communicate state (combine colors with labels/shapes). Do not call third-party domains from the UI; bundle fonts and assets locally. Fastify serves static resources from `dist/` and provides SPA fallback to `index.html`.

### 14.2 Account management

Provide an account selector and management page to add, rename, enable/disable, replace the API key, test connection, archive, or purge history with explicit confirmation. The API-key input is masked/write-only. Show connection-test results immediately.

### 14.3 Account overview

Show provider name, account label, and plan name. Render one card per metric showing the quota type and label; used/remaining/limit or percentages according to available provider data; an explicit unit; and the next reset time, if available, in the configured display time zone and relative to current time. Show last successful collection time, current status, and last error. Provide helpful empty states when no accounts or snapshots exist. Never mix units in one value.

### 14.4 History charts

Support rolling ranges of 24 hours, 3 days, 7 days (default), 14 days, and 30 days. Disable ranges that exceed the configured retention period and explain why. Render a separate chart for each quota metric and keep each chart to one compatible unit. If both percentages and absolute values are available for a metric, allow switching between `%` and absolute values; do not use separate axes for incompatible units. If only percentages are supplied, show percentages and do not infer token counts.

Charts must show:

- Used and remaining values.
- Peak/off-peak schedule areas with a tooltip showing interval name, time in both the display and schedule time zones, and the configured rate multiplier.
- Vertical labeled quota-reset markers.
- Collection gaps as line breaks and hatched regions; failed collection attempts as markers on a lower timeline strip.
- Tooltips with date/time and metric values.
- Synchronized cursor and zoom across charts on the same page.

ECharts' time axis uses local time or UTC only. Use a numeric axis based on epoch milliseconds with an `Intl.DateTimeFormat` formatter and tick placement aligned to hour/day boundaries in the configured display zone, including DST-transition days (23- and 25-hour days).

### 14.5 Settings

Expose polling interval (60–3600 seconds), display time-zone search over IANA zones, history-retention days, theme, and account management/connection tests. Show the peak-hours schedule read-only with schedule time zone, windows, and multipliers. Allow password changes in modes that use a password. Show configuration/data paths read-only. Clearly mark settings requiring a process restart, environment-overridden fields as read-only, and all secrets as masked.

### 14.6 Statuses and authentication screens

Distinguish `Fresh`, `Collecting`, `Unreachable`, `Auth rejected`, `Stale`, `Format changed`, `Disabled`, and `Not configured`. Show last successful collection and the last error for each account. Provide a login page when the active authentication mode requires a password.

## 15. Security

### 15.1 Network and authentication modes

Bind to `127.0.0.1` by default. There is one user, no username, no registration, and no roles; the only credential is a password when required.

- `auth.mode: auto` (default): direct loopback requests do not require a password. A password is required when the server binds to a non-loopback address or the request contains reverse-proxy indicators (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`).
- `auth.mode: required`: a password is always required; recommend it for reverse-proxy exposure.
- If remote binding is configured without a password, refuse to start. If a request indicates a proxy but no password is configured, return `403` with instructions.

Proxy headers indicate a potential remote access path, because a reverse proxy on the same host would otherwise make the service appear local to external clients.

### 15.2 Passwords and sessions

Set the password via `init`, `quotameter passwd`, or the UI; minimum length is 12 characters. Store only a password hash made with `scrypt` from `node:crypto`, with documented parameters, a random salt, and constant-time comparison. Store the hash in the `0600` config file.

Use a random 256-bit session token in a cookie with `HttpOnly` and `SameSite=Strict`; set `Secure` for HTTPS based on the public URL/reverse-proxy configuration. Store only SHA-256 of the token in SQLite. Sessions expire after 7 days of inactivity and no later than 30 days after creation. Changing the password revokes all sessions. Rate-limit authentication to no more than five failed attempts per source address within 15 minutes, then apply increasing delays. Log failed attempts at `warn` without logging passwords.

### 15.3 CSRF, DNS rebinding, and Host validation

Apply these protections in **all modes, including passwordless loopback access**:

- Validate the `Host` header against `localhost`, `127.0.0.1`, `[::1]`, and the configured host; reject any other host.
- On state-changing requests, validate `Origin`/`Sec-Fetch-Site` and require a dedicated nonstandard header. Accept only `application/json`. Do not enable CORS.

### 15.4 Secret protection

API keys must only reach server-side code and must never appear in HTML, JavaScript bundles, URLs, logs, error messages, diagnostic endpoints, or stored provider responses. UI inputs for keys/passwords are write-only; display masked state only. Configure Pino redaction for secret-bearing fields. Never log keys, including at debug level. Enforce configuration directory `0700`, config file `0600`, and atomic writes.

### 15.5 Headers and limits

Use a strict Content Security Policy without inline scripts or external sources, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` for API responses. Limit request bodies to 64 KiB and configure connection/request timeouts. Settings must not be writable without authentication where authentication is required.

### 15.6 Operational security

Run the service as a regular user, never root, and harden the system unit. Document SSH tunneling as the recommended access method, reverse-proxy publication with TLS through nginx or Caddy using `auth.mode: required`, and firewall configuration.

## 16. Logging and diagnostics

Use Pino JSON logs on stdout/stderr, collected by journald. Do not create application-managed log files or rotation. Default log level is `warn`; supported levels are `error`, `warn`, `info`, and `debug`. At `info`, log only lifecycle events such as startup, shutdown, configuration reload, and migrations. HTTP request logging is disabled except at `debug`. All messages are in English and must not contain secrets. `quotameter logs` wraps `journalctl` conveniently.

## 17. Automated testing and quality gates

Tests must not require a real API key or internet access. Use fixtures and a local mock HTTP server. Keep all test results deterministic; flaky tests are not acceptable.

### 17.1 Required test coverage

- **Z.ai adapter:** sanitized real fixtures where available plus synthetic full, partial, empty, unknown-field, changed-schema, different-plan, and different-unit responses; invalid values never become zero.
- **HTTP transport:** mock server scenarios for timeout, connection reset, 401, 403, 429 with `Retry-After`, 5xx, invalid JSON, slow body, and oversized body.
- **Polling:** fake timers; no overlap per account; retry/backoff/jitter bounds; 401/403 suspension; immediate startup poll; monotonic interval scheduling; clean SIGTERM shutdown.
- **Time zones:** ranges, calendar boundaries, peak windows, DST transitions over `America/New_York`, `Europe/London`, `Asia/Shanghai`, `Asia/Kolkata`, `Australia/Lord_Howe`, `Pacific/Chatham`, and `UTC`; `24:00`; 23/25-hour days; run under different `TZ` values; property tests using fast-check.
- **Storage:** repository operations, transaction atomicity, cascades, retention cleanup, indexes, WAL, single-instance lock, migrations from every supported prior schema, refusal of newer schema, and backup before migration.
- **Events:** both reset conditions, rolling-window false-positive avoidance, three-interval gap threshold, and interval changes.
- **Downsampling:** preserve bucket extrema, first/last points, reset markers, and gap boundaries.
- **Configuration:** schema validation, environment override precedence, permissions, atomic write, and reload with invalid JSON/config.
- **Secrets:** marker-secret scenario tests verifying that the marker is absent from logs, API responses, client bundle, error text, sanitized payloads, and database contents where not allowed.
- **Security:** matrix of bind address × proxy headers × password presence; Host allowlist; CSRF/Origin rejection; login rate limits; session expiry/revocation; scrypt settings; CSP and security headers.
- **CLI:** interactive init via PTY and non-interactive init; mandatory time zone; system/user unit snapshots; sudo/no-sudo/no-systemd paths with mocked commands; `doctor`, `status`, service commands, and `passwd`.
- **API:** every endpoint through `fastify.inject` using a real `node:sqlite` database in a temporary directory; verify schemas, errors, validation, and auth.
- **UI:** component tests with Vitest/Vue Test Utils, i18n-key completeness, and Playwright E2E against the built package and mock provider.

E2E scenarios must include initial empty state; adding an account and masked key entry; all account statuses; time ranges and disabled range controls; peak/reset/gap/error chart markers; light/dark themes; responsive screen sizes; login/logout; and automated accessibility checks with axe. Add chart visual-regression tests where reliable and maintainable.

### 17.2 Installation/package tests

Build an npm tarball with `npm pack` and install it globally in clean Ubuntu 22.04, Ubuntu 24.04, and Debian containers with Node 22 and 24. Verify no native compilation and no `postinstall`, check the tarball allowlist, run the `bin` command, and verify that Node versions below the declared minimum receive a clear error. Run `init --yes` non-interactively. In a systemd-capable test environment, verify install/start, restart after failure, reboot enablement, and user service with linger.

### 17.3 Enforced quality thresholds

- TypeScript `strict`, ESLint (including security rules), and Prettier are required in CI.
- At least 90% line and branch coverage overall. Target 100% for time-zone logic, peak-hours, sanitization, and secret-handling modules.
- Run Stryker mutation testing on critical modules (reset detection, peak-hours, sanitization, and downsampling) with a threshold configured in CI.
- Run `npm audit --omit=dev` and dependency-license checks.
- No flaky tests. A manual smoke test using a real Z.ai key is optional and is not run in CI.

## 18. Documentation deliverables

All docs must be in English and included in the public repository/package as appropriate:

- `README.md`: installation, `init` prompts (including required time zone), obtaining a Z.ai Coding Plan key, configuring multiple accounts, service lifecycle/status/logs, system vs user service and linger, VPS deployment, SSH tunnel access, nginx/Caddy TLS reverse proxy with `auth.mode: required`, time-zone and polling changes, config/database paths, backups/restores (`VACUUM INTO` or `sqlite3 .backup`), updates, and troubleshooting (auth rejected, format changed, occupied port, missing user-service linger, changed Node path, and permissions).
- Configuration reference, published JSON Schema, and sample config.
- `docs/providers/zai-coding-plan.md` with verified API/usage-statistics behavior and peak-hours source.
- Example system and user systemd unit files.
- `CONTRIBUTING.md`, Conventional Commit rules, `CHANGELOG.md`, `LICENSE`, and `NOTICE`.
- Generated OpenAPI documentation.

## 19. MVP acceptance criteria

The MVP is complete only when all criteria are met:

1. The public npm package installs and runs on supported Linux/systemd targets using Node.js `>=22.13.0`, verified in clean containers.
2. `quotameter init` requires an explicit IANA time zone and configures the application/service. It installs a system unit with appropriate privileges, a user unit without sudo, or provides exact manual instructions.
3. One or more Z.ai Coding Plan accounts can be added through CLI or UI and tested independently.
4. The service collects on a five-minute default interval, supports runtime interval changes, and performs a collection immediately after startup/restart.
5. Historical data persists in SQLite through `node:sqlite`; migrations run through the selected migration library with pre-migration backups.
6. The English UI supports light/dark/system themes, current values, and separate metric charts for 24 hours, 3, 7, 14, and 30 days; ranges outside retention are disabled.
7. Charts show reset markers, gaps, collection errors, and configured peak/off-peak intervals with correct time-zone/DST handling.
8. API failures preserve the last valid values and are visible in the UI. Parse failures retain sanitized diagnostic responses.
9. Collection works without an open browser. The service restarts after failure and machine reboot.
10. Remote access is protected by a password. Direct loopback access may be passwordless in `auto` mode. CSRF/Origin and Host/DNS-rebinding protections operate in all modes.
11. API keys do not leak to browser assets, logs, APIs, errors, or diagnostic interfaces, and config permissions are enforced.
12. All repository artefacts and documentation are in English and all documentation in §18 is present.
13. Tests pass in CI; lint, type checks, format checks, coverage, package audit/license checks, package build, `npm pack`, and clean installation tests pass. npm publication occurs from GitHub Actions with provenance.
14. The verified Z.ai quota-data source and payload contract are documented with links and fixtures; unsupported or undocumented response fields are not guessed.

## 20. Final decisions and external references

The following customer questions have been resolved:

| Topic                     | Final decision                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original prototype author | Den Brooks, `denis@yepbro.pro`                                                                                                                                                                                |
| Peak-hours                | Mon–Fri 14:00–18:00 Asia/Singapore (UTC+8); off-peak rate is 0.5× standard according to official docs, checked 2026-10-28                                                                                     |
| Package name              | `quotameter`; recheck npm availability immediately before reservation/publication                                                                                                                             |
| API examples              | Start from the official docs linked in §8.3. The quota overview does not itself establish a stable quota-statistics response contract; verify the real endpoint and response before implementing the adapter  |
| Rolling-window resets     | Conservative detection; do not create an event when ambiguous                                                                                                                                                 |
| Repository/CI             | Public GitHub repository and GitHub Actions                                                                                                                                                                   |
| Node.js                   | Node.js `>=22.13.0`; run CI on Node 22, 24, and current LTS. `22.13.0` is the minimum because `node:sqlite` no longer requires the experimental flag from 22.13 onward, although the API remains experimental |

External references:

- [Z.ai Developer Documentation — Coding Plan Overview](https://docs.z.ai/devpack/overview) (plan credits, reset rules, supported models, peak/off-peak policy).
- [Z.ai Developer Documentation](https://docs.z.ai/) (current API documentation root).
- [ZCode configuration docs](https://zcode.z.ai/en/docs/configuration) (Coding Plan connection configuration and coding API base URL; not a quota-statistics endpoint contract).
- [Node.js 22 SQLite documentation](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html) (`node:sqlite` availability and experimental status).
- [Node.js release status](https://nodejs.org/en/about/previous-releases) (supported release lines).
