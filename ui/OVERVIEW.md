# Quotameter web UI

> Why not `README.md`: npm's pack walker drags any README-basename file of a
> partially-packed directory into the tarball (un-excludable, even by `!`
> negation in `files`), and only `ui/dist/` ships — so this directory must
> hold no README basename (task 184, decision D-194; pinned by
> `test/unit/package-manifest.spec.ts`).

The browser frontend of the Quotameter service (spec §3, §14): a Vue 3
application bundled by Vite and served — already built — by the
application's Fastify server from `ui/dist`. The UI never talks to
providers directly; all data flows through the HTTP API (spec §13, §14).

## Stack

- **Vue 3** single-file components (`<script setup lang="ts">`, strict
  TypeScript — `ui/tsconfig.json` extends the root config).
- **Vue Router** (`createWebHistory`) for the shell's pages, wired in the
  composition root; route components are lazy-loaded so each view is its
  own external chunk (see the route table below).
- **Vite** for the production bundle; no dev-server-specific behavior is
  relied upon at runtime.
- **Vue Test Utils + happy-dom** for component tests (the Vitest
  `component` project, `test/component/`).
- **vue-i18n** for every user-facing string: the English catalog
  (`src/i18n/en.ts`) installed through `createAppI18n()` in the
  composition root (task 167).
- **Theme controller** (`createAppTheme()` in `src/theme.ts`, task 168):
  the `system`/`light`/`dark` preference, its browser-storage
  persistence, and the live `data-theme` application — see
  [Theming](#theming).
- **Apache ECharts** (task 175, D-148): the §14.4 metric charts, a
  devDependency (bundled by Vite like every other UI library) imported
  modularly — see
  [The metric charts (task 175, decision D-148)](#the-metric-charts-task-175-decision-d-148).
- **API client** (`src/api/`, task 169): the typed same-origin data
  layer over the §13 HTTP API, with the shared error taxonomy and the
  `ApiErrorNotice` presentation — see [The API client and error
  presentation](#the-api-client-and-error-presentation).

## Routes

The server serves `index.html` for every non-`/api` path (spec §14.1 SPA
fallback), and the router resolves the URL client-side — deep links work
without server-side route tables.

| Path        | Name       | View                             | Content task            |
| ----------- | ---------- | -------------------------------- | ----------------------- |
| `/`         | `overview` | `src/views/OverviewView.vue`     | 172–175 (done), 176–177 |
| `/accounts` | `accounts` | `src/views/AccountsView.vue`     | 170 (done)              |
| `/settings` | `settings` | `src/views/SettingsView.vue`     | 179 (done)              |
| `/login`    | `login`    | `src/views/LoginView.vue`        | 180                     |
| any other   | —          | redirect to `/` (decision D-131) | —                       |

The route table and the `createAppRouter(history)` factory (memory-history
seam for component tests) live in `src/router/index.ts`. The route table
itself carries no navigation guard: the session handling (task 180,
decision D-159) installs its guard through `installSessionRouting` from
`src/session.ts` in the composition root, so the factory stays pure
routing and component tests mount it guard-free — see [Login, logout,
and the session layer (task 180)](#login-logout-and-the-session-layer-task-180).

## Building

```sh
make build            # inside the container: build + verify artifacts
npm run build:ui      # equivalent direct form (writes $DIST_DIR when set, ui/dist otherwise)
npm run preview:ui    # serve the built UI on 127.0.0.1:4173 (Playwright)
```

Build output goes to `ui/dist`, or to `$DIST_DIR` when set — the
development container redirects it into the isolated data volume so build
output never lands in the host-owned tree
(`docs/agents/environment.md`). `$DIST_DIR` must name a directory
dedicated to build output: every build empties it before writing. The
served directory is resolved by the server (`src/server/http.ts`).

`npm run verify:build` (`scripts/verify-build.mjs`) runs after every
build and fails it when an expected artifact is missing or when the
output violates the served Content-Security-Policy shape — see below.

## CSP constraints for contributors (D-127)

The server serves a strict, fail-closed policy: `default-src 'none'`
with same-origin allowances only, **no inline scripts, no inline
stylesheets, no `style=` attributes, no `unsafe-eval`, and no `data:`
URIs**. For this directory that means:

- Reference assets normally (fonts, images); never inline them as data
  URIs — `build.assetsInlineLimit: 0` in `vite.config.ts` enforces it at
  build time, and `verify:build` asserts it on the output.
- Write styles in stylesheets (global tokens in
  `src/assets/base.css`, scoped styles in components), never in `style=`
  attributes; libraries that style through the `style` attribute are not
  usable (the ECharts notes in `DECISIONS.md` D-127 cover the chart
  configuration the later stages must use).
- Keep fonts and assets local (spec §14.1): no third-party domains, no
  CDN links in `index.html`.

## The API client and error presentation

Task 169 (decision D-134) added the UI's data layer: one typed client over
the same-origin §13 HTTP API, one error taxonomy, and one presentation
component every page shares.

### Architecture

| Module                              | Owns                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`                 | `createApiClient({fetchImpl?, baseUrl?, timeoutMs?})` and the endpoint families (`health`, `status`, `quota`, `providers`, `accounts`, `settings`, `history`, `events`) — pure TypeScript, no Vue. |
| `src/api/error.ts`                  | the `ApiClientError` taxonomy and the loose §13-envelope recognizer.                                                                                                                               |
| `src/api/index.ts`                  | the Vue half: `createApiClientPlugin()` (provide) / `useApi()` (inject), `useApiCall()` (the per-request composable), and the re-exports pages import.                                             |
| `src/components/ApiErrorNotice.vue` | the one presentation surface: an inline `role="alert"` region (`data-testid="api-error"`) rendering catalog sentences per taxonomy class.                                                          |

Request and response types come from the server's own TypeBox contracts
(`src/schemas/api/*`) through **type-only imports** — erased at build time,
so the browser bundle carries no schema/TypeBox/Fastify code. Success
bodies are trusted casts (the same-origin server serializes through the
same closed schemas; a non-JSON body is caught as an error). The one
runtime string that matters — the §15.3 mutation header
`X-Quotameter-Request` — is a UI-local constant (`API_MUTATION_HEADER`)
pinned against the server's `API_MUTATION_HEADER_NAME` by
`test/component/api-client.spec.ts`.

Every state-changing method (POST/PUT/PATCH/DELETE) attaches the mutation
header, and `Content-Type: application/json` exactly when it sends a body
(the server's content-type leg is body-bound, decision D-117); GETs carry
neither. Every call runs under a deadline (default 15 s, overridable) and
accepts an `AbortSignal`; the client composes both onto one controller and
keeps them armed through the whole exchange — the headers phase **and**
the body read — so a stalled body is bounded and a mid-body cancellation
is honored, with a deliberate cancellation (`aborted`) staying
distinguishable from the client's own `timeout`.

### The error taxonomy

| Kind         | Means                                                                   | Carries                       |
| ------------ | ----------------------------------------------------------------------- | ----------------------------- |
| `network`    | `fetch` rejected — service unreachable                                  | —                             |
| `timeout`    | the client's deadline fired                                             | —                             |
| `aborted`    | the caller's signal fired (deliberate cancellation)                     | —                             |
| `unexpected` | a response arrived whose body is not the §13 envelope / not usable JSON | `status`                      |
| `rejected`   | the §13 envelope answered                                               | `status`, `code`, the payload |

**The presentation rule:** only catalog sentences render. `ApiErrorNotice`
maps `kind` (and, for `rejected`, the envelope's `code` — with a fallback
for unknown codes) onto `errors.*` keys in the i18n catalog. The envelope's
own `message` and `details` are kept on the error object as
`serverMessage`/`serverDetails` for programmatic use but **never reach the
DOM**: the client cannot vouch for what actually answered, so a hostile or
misrouted responder gets no text channel into the page (the marker test in
`test/component/api-error-notice.spec.ts` pins this executably).
`Error.message` is likewise a fixed per-kind sentence.

### The page contract (tasks 170+)

```vue
<script setup lang="ts">
import ApiErrorNotice from "../components/ApiErrorNotice.vue";
import { useApi, useApiCall } from "../api";

const api = useApi();
const { data, error, pending, execute } = useApiCall(() => api.accounts.list());
void execute();
</script>

<template>
  <ApiErrorNotice v-if="error" :error="error" />
</template>
```

One `useApiCall` per request; `execute()` re-runs it (retry, changed
arguments). The call resolves the data on success and `null` on a taxonomy
failure (the error is in `error`); anything the call throws that is not an
`ApiClientError` rethrows — programming errors stay loud. Two deliberate
non-failures also resolve `null` without touching `error`: a caller
cancellation (`aborted` — not a failure to present; previously loaded
data survives) and a superseded run (only the newest `execute()` writes
state, so overlapping calls cannot race). `reset()` (task 170) clears
`data`/`error`/`pending` and supersedes any in-flight run — the
dismissal seam for presented failures a surface wants gone without a new
request (closing a confirmation panel, hiding a form). Until their
content tasks land, the three placeholder views carry exactly this wiring
against the public health probe, which is the task-169 done-condition:
errors are handled consistently across pages, through the one surface.
The accounts page (task 170) is the first real consumer — see
[The accounts page (task 170)](#the-accounts-page-task-170).

Future families join as methods on the client — the `history`/`events`
families landed with task 174 (the range-bearing GETs: ISO-8601
`from`/`to` boundaries, D-139's grammar) and the `auth` family with
task 180 (see below). **The session signal (task 180, D-159):** the
`onUnauthenticated` client option fires whenever a response is
classified as the §13 envelope with `code === 'UNAUTHENTICATED'` — at
the taxonomy's own boundary, so every request reports it whatever
dispatched it. `ApiErrorNotice`'s `UNAUTHENTICATED` branch remains the
_presentation_ of such an answer while the session layer's redirect
takes the page away (the error object's `code` field is still the
programmatic signal for anyone who needs it).

### `vite preview` note

The e2e suite serves the built UI statically (`vite preview`) with no API
behind it: `/api/*` answers the SPA-fallback HTML, so every page honestly
renders the `unexpected` notice there. Against the application server
(Fastify serving both), the health probe succeeds and no notice renders.

## The accounts page (task 170)

`/accounts` (spec §14.2/§8.2; decision D-135) is the management surface
over the §13 accounts API — the first real page, and the reference shape
for the content tasks that follow.

### Architecture

| Module                                 | Owns                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/views/AccountsView.vue`           | the two loads (`accounts.list`, `providers.list` — one `useApiCall` each), the selector, the empty state, the reconciliation, composition |
| `src/components/AccountManageCard.vue` | the selected account's facts and one action group per §14.2 verb — six own `useApiCall`s with scoped notices                              |
| `src/components/AccountAddForm.vue`    | the create form: provider select, label, optional §5.3 key (write-only), client-side blank guards                                         |
| `src/account-selection.ts`             | the cross-page selected-account store (see below)                                                                                         |

Every successful mutation reloads the list once (the server's list is
the single source of truth); the card is keyed by the account id, so a
selection switch is a fresh instance — no per-account state leaks
across cards. A failed load is never a fake empty state (D-135's
failed-load rule): the view keeps the last successful list — a failed
reload leaves the previous surface rendered beside the failure notice
and a retry — and the empty state renders only when a completed load
answered zero accounts. Labels are sent trimmed (the canonical stored
label is what the purge gate's typed compare shows), and the typed
purge gate trims both sides, so a padded label — however it came to
exist — can never make an account unpurgeable from the UI. A
confirmation panel's cancel also `reset()`s its call: a previous
attempt's failure notice cannot re-announce itself when the panel
re-opens, and a successful key replacement clears the previous test
verdict (it described the credential that no longer exists).

### The action → API map (the done-condition, executable)

| UI action       | Client call                                      | Gate                                                             |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| add             | `accounts.create({providerId, label[, apiKey]})` | blank label/key refused client-side; key omitted when empty      |
| rename          | `accounts.update(id, {label})`                   | inline form; the label is prefilled (not a secret)               |
| enable/disable  | `accounts.update(id, {enabled})`                 | —                                                                |
| replace key     | `accounts.update(id, {apiKey})`                  | masked write-only field; not offered for env-sourced keys (§6.3) |
| test connection | `accounts.test(id)`                              | outcome + §13 `message` render immediately (`role="status"`)     |
| archive         | `accounts.remove(id)`                            | two-step inline confirm; **no** `purgeHistory` flag at all       |
| purge history   | `accounts.remove(id, {purgeHistory: true})`      | the account's exact label must be typed (trimmed compare)        |

§8.2's terminal semantics show through: an archived account renders no
mutation controls (the server refuses `account-archived`) except the
purge — the follow-up that removes the retained history.

### The write-only key proof map (task 171, D-136)

"The key is never returned to the browser" (§6.3/§14.2/§15.4) is pinned as
a three-link chain, each link executable:

| Link (what the browser gets)                             | Pin                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| response bodies (the wire)                               | `test/integration/api-accounts.spec.ts` / `api-settings.spec.ts` / `api-status.spec.ts` — marker-secret scans over every flow per route family (the providers listing carries no secret structurally); compositionally, `test/integration/accounts-real-surface.spec.ts` drives the real `/api` stack through the real API client for a full §14.2 session plus one refused create, scanning every captured response body and request URL against both markers |
| the client's parsed values (what components render from) | `accounts-real-surface.spec.ts` scans every client-resolved value of the session — successes and the thrown error's `serverMessage`/`serverDetails` alike — and pins that the markers left the browser only through the two write channels (the create POST and the replace-key PATCH), never a GET or DELETE body                                                                                                                                             |
| the rendered DOM                                         | `test/component/accounts-view.spec.ts` — masked `type="password"` + `autocomplete="new-password"` from first paint, never prefilled, cleared after every submit attempt (success and refusal alike), the constant mask rendered verbatim, the typed value absent from input value and rendered text                                                                                                                                                            |

The real-surface bridge (the client's injectable fetch seam served by the
real routes over `app.inject`) closes the seam between the per-family
server pins and the key-free-by-construction component fixtures: it is the
one test where real serializers, real guards, and the real client pipeline
carry marker secrets end to end. It lives in the integration project
because the component project's happy-dom environment container cannot
host the server's `node:*` module graph (D-136's recorded boundary).

### The selected-account store (consumed by tasks 170 and 172)

`createAccountSelection()` (installed in the composition root beside the
other factory plugins; `useAccountSelection()` in the consumer) holds
the selected account id and persists it best-effort under the
`localStorage` key **`quotameter.selected-account`** (absent/empty reads
as `null`; a cleared selection persists as the empty string). The store
deliberately knows nothing about accounts beyond ids — which ids exist
is list data consumers already load. **The reconciliation rule every
consumer re-runs on a completed list load:** keep the stored id while it
is listed, else select the first account, else `null`. The accounts page
does this on every list (re)load; the overview (task 172) consumes
`useAccountSelection()` the same way against its own list load and adds
its own selector on the same store — the two pages share one selection.

The shell nav stays as landed (task 166): §14.2 puts the selector on
the management page, and the overview's own control is 172's call.

## The overview page (task 172)

`/` (spec §14.3/§14.6; decision D-137) is the account overview: the
selected account's identity and §7.3/§7.2 facts plus one card per metric
of its last-valid quota row set (D-077 — each card shows its own
collection stamp, because rows of one account may come from different
snapshots).

### Architecture

| Module                                      | Owns                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/views/OverviewView.vue`                | the six page-level loads (one `useApiCall` each), the selector, the reconciliation, the last-good copies, the attention wiring, the range wiring, the per-metric chart targets |
| `src/components/AccountOverviewCard.vue`    | the identity facts: provider name, label, plan (`Unknown` when absent), the status badge, last success / last error (`Never`/`None`)                                           |
| `src/components/AccountStatusBadge.vue`     | the nine statuses (the §14.6/§7.3 vocabulary plus the `archived` lifecycle token, D-191) as text + tone class + CSS-drawn shape marker (§14.1: never color alone)              |
| `src/components/AccountAttentionNotice.vue` | the account-level attention notice (task 173): the remedy sentence plus a link exactly where the remedy is a UI action                                                         |
| `src/components/MetricCard.vue`             | one metric: label, quota type (+ rolling window), per-field values with explicit units, reset and collection stamps                                                            |
| `src/components/HistoryRangeControls.vue`   | the §14.4 rolling-range radio group (task 174, D-147): five options, retention-aware disabling with the explanation as text                                                    |
| `src/components/MetricHistoryChart.vue`     | one metric's §14.4 history chart card (task 175, D-148): its own per-metric series load, the percent/absolute toggle, the states, the ECharts instance                         |
| `src/account-attention.ts`                  | the pure attention classifier (task 173, D-138): archived → disabled → keyless-environment → keyless → `null`                                                                  |
| `src/history-range.ts`                      | the pure §14.4 range vocabulary and boundary arithmetic (task 174, D-147), drift-pinned against the server's rolling-ranges module                                             |
| `src/format.ts`                             | the pure `Intl` helpers (`formatEpochMs`, `formatRelative`, `formatQuotaNumber`, `formatChartDate`, `windowHours`) — the charts reuse these                                    |
| `src/charts/`                               | the ECharts surface (task 175, D-148): see [The metric charts](#the-metric-charts-task-175-decision-d-148)                                                                     |

The five data-defining loads: `accounts.list`, `providers.list` (display names **and**
the metric-label catalog), `status.get`, `settings.get` (the configured
display time zone, §14.1, **and** the history retention, §14.4), and
`quota.get(selectedId)` — re-run on every selection change. The selection
store is shared with the accounts page (`quotameter.selected-account`): the
overview adds its own selector on the same store and re-runs the same
reconciliation rule on every completed list load. The quota target is
**list-validated** — the selected id dispatches only once a completed list
load vouches for it, so a stale stored id (purged elsewhere) earns no
flashing 404 — and switching the selection **clears** the previous
account's quota before the new load: one account's values can never render
as another's. A failed load is never a fake empty state: each call keeps
its last-good copy beside its `ApiErrorNotice`; the data-defining loads
(accounts, status, quota), the account-level timeline (task 174; its
rendering is task 176's), and — inside their cards — the per-metric series
loads (task 175) carry retries with distinct accessible names, the two
that degrade gracefully (providers → raw ids/keys, settings → the
browser's time zone and unknown retention) render their notice alone. A
status row that is absent (load in flight or failed) renders its slots as
`Unknown` — "Never"/"None" state collection history only a loaded row
vouches for.

### Honesty rules (the task's done-condition, spec §7.2/§8.4)

- Per metric field (used/remaining/limit): the absolute value with its
  **explicit unit** when present, else its percentage (`42%`, a
  different unit, labeled as such — §14.3's "or percentages"), else an
  explicit `Unknown` — never zero, never blank. A **genuine zero
  renders as `0 credits`** (pinned against the null case with hostile
  zero-plausible fixtures in `overview-view.spec.ts`).
- A percent-only metric (`unit: 'PERCENT'`, §8.4) renders percentages
  only — token counts are never inferred from them.
- An invalid metric renders its `invalidReason` (trusted server data)
  and **no** value lines — §8.4 stores invalid metrics without numeric
  values; the reset/window metadata may legitimately survive (D-010).
- No snapshot yet (`collectedAt: null`): identity + status render, the
  metrics region states it — told apart from a snapshot that recognized
  no metric rows (a collection stamp with `metrics: []`, the adapter's
  skip path), which states its own different fact. The no-snapshot
  wording is attention-aware (see below).
- Absent `resetsAt` omits the reset line (§14.3's own "if available").
- Times render absolute (in the configured display zone) plus relative,
  computed when data arrives (no live ticker — a reload re-renders).

### Empty, initial, and attention states (task 173, decision D-138)

The fresh-install contract: **every cell of the matrix renders guidance
or its honest degraded content, never a blank or broken region**. The
matrix is pinned cell-by-cell in `overview-view.spec.ts` against mocked
backends (each cell asserts its surface renders AND no `api-error`
notice does — guidance that appears only beside a failure would be the
broken page in disguise), and the two guidance surfaces (the
no-accounts block, the attention notice) are axe-scanned in the real
browser through route interception in `test/e2e/a11y.spec.ts` — the
preview server has no API behind it, so the fresh-install bodies are
served by `page.route`.

| State                | Condition                                 | Renders                                                                            |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| initial load         | list load in flight                       | the loading line alone (distinct from error/empty, D-134's pending semantics)      |
| quota pending        | selected, quota load in flight            | the identity card + the quota-loading line; no absence wording (absence is loaded) |
| load failed          | any of the seven loads                    | its own notice (+ retry where carried) — never a fake empty state                  |
| **no accounts**      | a completed list answered zero            | the titled guidance block + a link to `/accounts`                                  |
| account attention    | archived / disabled / keyless (see below) | the attention notice between the identity card and the metrics region              |
| no snapshot, blocked | `collectedAt` null **and** attention      | the honest line — the notice above says what is keeping values from appearing      |
| no snapshot, waiting | `collectedAt` null, no blocker            | the waiting sentence — values appear after the first successful poll               |
| zero-metric snapshot | stamp set, `metrics: []`                  | its own different fact (the adapter's skip path)                                   |
| registry-empty build | providers list answers `[]`               | raw provider ids and metric keys verbatim (D-137's documented fallback)            |

The registry-empty row is a degradation case, not a fresh-install
state: a real install registers its adapters.

**The attention precedence** (the pure classifier `accountAttentionOf`
in `src/account-attention.ts`, fed the account view AND its §7.3
status row) consumes the server classifier's own verdict over the wire
(D-191, task FSM-2): the archived/disabled branches read the status
row's token first — the canonical precedence `archived → disabled →
not-configured → the working statuses` decided server-side — with the
accounts surface's raw facts (the storage lifecycle field, the enable
switch — the very inputs the server feeds the same ranks) kept beside
them as the row-absent fallback and the cross-load-race tie-breaker in
both directions (a stale list cannot outvote a fresher verdict, nor
the reverse). The notice and the badge agree whenever both loads are
current:

1. **archived** — history retained; manage or purge on
   the Accounts page (+ link). An archived account's wire shape reads
   `enabled: false, hasKey: false, keySource: 'none'` when the archive
   removed the entry (§8.2's usual end state) — and the hand-re-add
   shape (D-191) keeps `enabled: true, keySource: 'file'` beside the
   archived row, matching the `archived` status token §7.3 now derives
   for both (the lifecycle fact outranks the whole precedence list,
   D-180). The storage row is the authoritative fact even
   in the transient window after a partial archive (the row retired,
   the entry removal still retrying server-side): the row IS retired.
2. **disabled** — enable polling on the Accounts page (+ link).
3. **keyless-environment** — the reachable `Not configured` shape: an
   account whose `apiKeyEnv` names a variable the process does not
   provide. `hasKey` on the §13 accounts surface is
   **declaration-level** (a source is configured, §6.3's exactly-one
   rule), so this account reads `hasKey: true, keySource:
'environment'` and the unresolvable-key signal is the §7.3 row's
   `not-configured` — which is what the classifier reads. The remedy
   is server-side (§6.3 makes environment keys read-only through the
   API), so the wording names the variable and the restart — **no
   link**, because nothing on the linked page fixes it. A status row
   that is absent (load in flight or failed) vouches for nothing: no
   keyless notice renders beside it.
4. **keyless** (`hasKey: false` on an active account) — the
   schema-total fallback no current composition produces (the config
   contract rejects sourceless accounts), answered honestly with the
   fix-here wording (+ link).

Wording rules (D-138): the empty states' values harmonize with the
accounts page's own empty state (task 170) while the keys stay
namespace-distinct (D-132); every guidance names the next step, and the
next step is a `RouterLink` exactly where the UI can perform it; the
blocked line never repeats the link — the actionable advice lives once,
in the notice.

### Metric labels (decision D-137)

§14.3 requires each card to show "the quota type and label"; the label
is §8.4 adapter-owned data, not UI chrome. `/api/providers` therefore
carries each adapter's declared `metrics` catalog
(`{metricKey, label}`), single-sourced from the Z.ai mapping's own
recognition table (`ZAI_METRIC_CATALOG`). The UI resolves
`(providerId, metricKey) → label` with the **raw metric key as the
documented fallback** — a stable adapter-defined identifier rendered
verbatim when the provider declares no catalog or no entry. A new
provider arrives with its labels; no UI rewrite (§8.1).

### The rolling-range controls (task 174, decision D-147)

The §14.4 filters — 24 hours, 3 days, 7 days (default), 14 days, 30
days — render between the identity card (and its attention notice) and
the metrics region, as a radio group (`HistoryRangeControls.vue`):
fieldset + legend and five radios sharing one `name`, so keyboard
support is native, and every retention-disabled option carries its
explanation as real text beside its label ("Exceeds the N-day history
retention") — never color alone.

- **Disabling semantics.** Retention comes from the settings load the
  page already performs (`app.historyRetentionDays`). A range is
  disabled when its exact duration **strictly exceeds** the retention
  (`durationMs > retentionDays × 86 400 000`); an exactly-equal range
  stays selectable, which keeps the 7-day default available under the
  §11.3 minimum retention. An unknown retention (settings pending or
  failed) disables nothing — the server's own range report (D-139's
  200-with-report) stays the authority — and a selection that becomes
  disabled once retention arrives reverts to the default.
- **The boundary rule: no zone anchors a request.** The selected range
  is passed as D-139's grammar — ISO-8601 UTC `Z` boundaries
  recomputed on every dispatch (`to = now`, `from = now − duration`),
  D-068's exact absolute-duration arithmetic mirrored in
  `src/history-range.ts` (UI-local constants **and union**, drift-pinned
  both directions against the server's `src/util/rolling-ranges.ts` —
  nothing from `src/**` crosses into the UI). The display time zone
  never participates in a request (§10 — presentation only).
- **The range-keyed loads.** The client's `history`/`events` families
  carry the windows: the account-level §12.2 timeline and the §9.3
  peak-hours schedule key on the validated target and the range (their
  rendering is task 176's — the chart cards receive both as props);
  since task 175 the metric series render as **one chart card per quota
  metric key** (`MetricHistoryChart.vue`, below) — no snapshot ⇒ no
  metric vocabulary ⇒ no series requests. The refresh button beside the
  control re-runs the account's data loads with a fresh "now" — it
  re-anchors the rolling window by bumping a token the chart cards
  watch, keeping last-good charts rendered until fresh data arrives
  (D-135's keep-last-good rule).

### The metric charts (task 175, decision D-148)

One chart per quota metric, below the metric cards: the used/remaining
line pair over the selected rolling range, with the percent/absolute
toggle where the data carries both views. Task 176 (decision D-149)
renders the §12.2/§9.3 annotations on the same charts: reset markers,
peak/off-peak bands, gap/stopped hatch regions, and the failed-cycle
strip.

| Module                                  | Owns                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/charts/runtime.ts`                 | the ONLY module importing ECharts: modular `echarts/core` + the line/scatter/custom/grid/tooltip/legend/markLine/dataZoom-inside/axisPointer/canvas pieces, the `ChartHandle` structural seam (incl. the sync-relevant `on`/`dispatchAction`), the injectable `ChartRuntime` (`useChartRuntime()`, `createChart(element, {syncGroup})` joins a `connect` group), and the production `cssTokenReader` |
| `src/charts/sync.ts`                    | the §14.4 cursor/zoom coordinator (task 178, D-153): the page-minted `connect` group id, the shared zoom state (`zoomed`/`zoomWindow`), the empty-group-forgets and late-joiner-adopts identity rules, and the dispatch-to-every-handle reset — echarts-free                                                                                                                                         |
| `src/charts/ticks.ts`                   | the pure §14.4 tick engine (task 177, D-150): local hour/day/month boundary walks in the configured display zone (DST-exact, `Intl`-only), the density ladder over the measured plot width, and the per-tick labels incl. the DST zone-name disambiguation                                                                                                                                           |
| `src/charts/tokens.ts`                  | the pure `--qm-*` token → `ChartTokens` mapping (`chartTokensOf(read)`); the single list of token names all theme blocks must carry                                                                                                                                                                                                                                                                  |
| `src/charts/annotations.ts`             | the pure §12.2/§9.3 mapping: the account timeline → one metric's resets/gaps/errors/stopped (per-metric vs account-level split), the served peak intervals → bands, the outcome → symbol map                                                                                                                                                                                                         |
| `src/charts/series.ts`                  | the pure adapter: D-139 wire kinds → `ChartSample`s, availability/`resolveViewMode`, the D-147 sliver-thresholded `rangeNoticeOf`, and `buildMetricChartOption` (one mode, one unit, one value y-axis, the annotation series)                                                                                                                                                                        |
| `src/components/MetricHistoryChart.vue` | the card: its own per-metric `useApiCall`, the toggle (native radios, one group per card), the states, the ECharts instance lifecycle, the aria summary with the annotation counts                                                                                                                                                                                                                   |

- **ECharts.** A devDependency mirroring `vue`/`vue-i18n`/`vue-router`
  (the shipped tarball carries the prebuilt bundle; spec §3 keeps
  runtime dependencies minimal), imported **modularly** (spec §3): the
  bundle carries only the registered pieces. The renderer is
  **canvas with `tooltip.renderMode: 'richText'`** — D-127's constraint
  (ECharts' SVG renderer and HTML tooltips style through the `style=`
  attribute the CSP blocks); the canvas painter and rich-text tooltip
  draw without DOM styling.
- **Unit segregation is structural.** The option builder takes one view
  mode and one unit and emits ONE value y-axis — incompatible units
  cannot share an axis because no input shape expresses it. The toggle
  renders only where the data carries BOTH views; percentage-only
  metrics stay on their bounded 0–100 `%` axis (§14.4: no inferred token
  counts); the used/remaining pair distinguishes itself by legend text
  and solid-vs-dashed lines (never color alone).
- **Wire kinds.** Points render verbatim (invalid rows' nulls stay
  null); §12.2 gap empty points become line breaks (`connectNulls:
false`); D-081 downsampling buckets render as their `first`/`last`
  endpoints — real observed points, the honest minimal render of a
  bucketed response.
- **The annotations (task 176, D-149).** Reset instants are vertical
  labeled markLines; peak/off-peak/gap/stopped spans are rect bands of
  one custom series (the only ECharts primitive whose `decal` hatching
  renders — marker components skip the decal visual stage); failed
  cycles are scatter markers on a lower strip grid with a distinct
  symbol per §11.2 outcome. Resets/gaps filter to their metric; errors
  and stopped regions are account-level and render on every chart. All
  bands/markers are silent and every tooltip flows through the one
  axis-trigger richText formatter, which states — for the hovered
  instant — the values, the covering schedule band (§14.4: name, times
  in both zones, multiplier), the gap/stopped region, and the resets
  inside the snapped sample interval (per-element item tooltips race
  the axis channel). Never color alone: fill presence, border style,
  hatch direction, on-line labels, per-outcome shapes, and the legend's
  strip name all carry meaning beside color.
- **Theme.** Colors come only from token lookups (`--qm-chart-used`,
  `--qm-chart-remaining`, the `--qm-chart-peak`/`-reset`/`-gap`/
  `-stopped` annotation tokens, and the shell's existing tokens); the
  option computed reads `resolvedTheme`, so a mode flip re-reads the
  cascade and re-sets the option live (D-133).
- **The x-axis** is the numeric epoch-ms axis §14.4 prescribes (ECharts'
  time axis is local/UTC only) with `Intl.DateTimeFormat` labels in the
  configured display zone. Tick PLACEMENT (task 177, D-150) is computed
  by the pure `src/charts/ticks.ts` engine: instants aligned to LOCAL
  hour/day/month boundaries of the configured zone — DST transition days
  included (a 23-hour day's skipped wall hour has no tick; a 25-hour
  day's duplicated hour ticks twice, zone-suffixed "1 AM EDT"/"1 AM
  EST"), a +05:45 zone's hours align at their own :15 phase, and a
  ±30-minute zone (Lord Howe) follows its actual offsets — delivered
  through ECharts' `axisLabel`/`axisTick` `customValues` on BOTH x-axes,
  at a density chosen from the measured canvas width (§14.1's 360 px is
  the unmeasured floor). Both grids share fixed left/right insets (no
  `containLabel`), so the main plot and the strip align by construction.
- **The range report.** A `truncated` clamp within 60 s stays quiet (the
  D-147 clock-skew sliver); a real truncation names the retained
  window's start; a rejected range states that instead of a chart.
- **Cursor and zoom are synchronized across the page's charts (task 178,
  D-153).** Every chart card is created into one ECharts `connect` group
  (a page-minted id): hovering one chart relays the hovered instant to
  every other chart — each renders its own tooltip and axis pointer at
  the same instant — and a zoom on one chart relays the same percent
  window to all (the percent names identical instants because every
  chart's x-extent is the same requested-bounds window). The zoom is an
  `inside` dataZoom over both x-axes (drag to pan, Shift+wheel to zoom —
  the plain wheel keeps scrolling the page), floored at a one-hour span
  (the tick ladder's own floor), and it never widens past the loaded
  range: the range radios stay the load authority, a refresh re-anchors
  the window and resets the zoom, and a range switch starts the new
  window unzoomed. While a zoom is live the charts header carries a
  keyboard-operable **Reset zoom** button, and a polite live region
  announces each transition (the applied window's instants in the
  display zone, or the reset). Option updates merge
  (`replaceMerge` over the series/axes/grids families) so the zoom and
  legend interaction state survive data, theme, and tick updates —
  D-148's deferred follow-through.
- **Testing seam.** ECharts cannot boot under happy-dom (zrender
  measures text through a real canvas 2d context), so component tests
  inject a recording `ChartRuntime` through `useChartRuntime()` — every
  option the card builds is asserted through the fake handle, while the
  token reader stays the production one over live inline custom
  properties. The band renderer is a pure `renderItem` factory asserted
  against a stubbed api. ECharts itself renders only in real browsers —
  the e2e sync cell drives the real relay (Shift+wheel over one canvas)
  but asserts only DOM state, never canvas pixels.

## The settings page (task 179)

`/settings` (spec §14.5; decision D-156) is the settings surface over the
§13 annotated settings view — only what §6.4 permits at runtime is
editable; everything else renders read-only with the annotation the
server carries.

### Architecture

| Module                                       | Owns                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/views/SettingsView.vue`                 | the two loads (`settings.get`, `providers.list`), last-good copies, the read-only facts and paths, the theme row, composition                                   |
| `src/components/SettingsGeneralForm.vue`     | the §6.4-live scalars: time-zone search, interval, retention, log level; the minimal-write PUT; the saved/pending-restart notices                               |
| `src/components/SettingsPasswordForm.vue`    | the §15.2 password change (the PUT's `auth.password` channel) with the session-revocation consequence                                                           |
| `src/components/SettingsScheduleSection.vue` | the §9.2 peak-hours schedule, read-only in its own time zone                                                                                                    |
| `src/settings-fields.ts`                     | the UI-local validated ranges, the log-level enum, the §15.2 minimum, the §6.4 restart-field labels (D-193) — drift-pinned against the server constants by test |
| `src/timezones.ts`                           | the pure zone helpers: validity (the server check's mirror), the engine list seam, the suggestion filter with the canonical-twin match                          |

### The editability contract

| Field                        | Control                                                             | Environment-sourced renders       |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| `server.host`                | none — value + "restart required" + the `quotameter restart` remedy | value + the read-only annotation  |
| `server.port`                | same                                                                | same                              |
| `auth.mode`                  | same                                                                | same                              |
| `app.timezone`               | search input + suggestions                                          | disabled input + annotation       |
| `app.pollingIntervalSeconds` | number input, 60–3600                                               | disabled input + annotation       |
| `app.historyRetentionDays`   | number input, 7–3650                                                | disabled input + annotation       |
| `logging.level`              | select over the four levels                                         | disabled select + annotation      |
| `auth.password`              | write-only masked input                                             | — (never environment-overridable) |

The annotations are the served contract's own (`source`, `restartRequired`
— D-130): the page never re-derives precedence knowledge. The PUT body
carries **only the changed fields**; a save reloads the served truth and
the drafts re-adopt it. A non-empty PUT outcome `restartRequired` list
renders the pending-restart notice — the process's hand-edited-file
state, never the request's doing. Since FSM-5 (D-193) the facts section
also renders the **live** half of the same state from the GET's
`pendingRestart`: a per-row "restart pending" marker beside exactly the
named fields plus a section notice with the `quotameter restart` remedy,
appearing and disappearing with the served value — §14.5's distinction
between fields whose class requires a restart and values currently
pending one, both truths visible at once.

### The time-zone search

The vocabulary is the browser's own IANA list
(`Intl.supportedValuesOf('timeZone')`) — the same resolver that formats
every date in the UI. Matching is a case-insensitive substring filter
(capped, collapsed on an exact pick), plus a **canonical-twin match**:
engines list CLDR-canonical names, so a fully typed tzdb primary
(`Asia/Kolkata`) surfaces its listed twin (`Asia/Calcutta`). §5.3's
explicit-choice rule holds: no silent defaults — a blank or non-IANA
zone is a field error, and validity never depends on list membership
(both spellings save; the server's own check agrees, drift-pinned).

### The password change

Rendered in **both** auth modes with the configured/not-set state line —
`auto` mode uses a password on the remote paths (§15.1), so the section
must not vanish for an operator who set one. The field follows the
write-only discipline (masked, never prefilled, cleared after every
dispatched attempt); the §15.2 minimum is guarded client-side; and the
D-124/D-126 consequence is stated before the change (the hint) and as
the success notice: changing the password revokes every session,
including the one that made it.

## Login, logout, and the session layer (task 180)

Spec §14.6/§15.1/§15.2; decision D-159. The `/login` page is the §14.6
password form and the shell header carries the sign-out button; both are
driven by `src/session.ts`.

### Mode-agnostic by construction

The UI never learns the §15.1 auth mode: the mode-fact surfaces it could
read are either themselves protected under `required` (`/api/settings` —
chicken-and-egg for the visitor the login page exists for) or deliberately
left unconsumed: `GET /api/auth/session` now exists (U-055, D-182 — it
serves non-UI clients of the published contract), and the tri-state below
still takes no probe of it (D-182's recorded reconciliation: the session
cookie rides every request, so the first protected load discovers the
truth with no extra round trip — a boot probe would tax the common
`auto`-loopback world for a fact its own loads reveal for free, and
consuming the endpoint for exact sign-out visibility or deep-link
pre-seeding stays a future UI task). The session state is a
tri-state, in-memory only (the cookie is the session's only truth; a
reload honestly restarts at `unknown`):

- `unknown` — no signal this SPA lifetime. Protected pages render and
  load optimistically; in `auto` + loopback no 401 ever arrives, nothing
  forces `/login`, and the login page stays reachable by URL — exactly
  §14.6/§15.1's semantics for the mode that requires no password.
- `authenticated` — a login succeeded this SPA lifetime.
- `unauthenticated` — the wire answered the §13 envelope's
  `UNAUTHENTICATED` code (through the client's `onUnauthenticated`
  hook, fired at the classification boundary so every session-bearing
  request reports it — an error whose notice never mounts still flips
  the state; the login arm alone is exempt: its 401s judge the
  candidate password, never the session, so a mistype cannot demote
  navigation in the passwordless `auto`-loopback world).
- `signOut()` sets `unknown`, not `unauthenticated`: under
  `auto`-loopback the overview keeps working after a sign-out.

### Redirects and destination preservation

`installSessionRouting(router, session)` — called in the composition
root before the initial navigation — installs a `beforeEach` guard plus
a reactive watcher on the state:

- an **authenticated** visit to `/login` bounces to the preserved
  destination (or `/`) as a string location — vue-router parses query
  and hash out of string locations but drops them from a `{ path }`
  object, and a preserved destination may carry either;
- an **unauthenticated** navigation to a protected target redirects to
  `/login?redirect=<fullPath>` — no API round trip, no flash of the
  protected page;
- a flip to `unauthenticated` while a protected page is already rendered
  navigates the same way, never from the login route itself;
- `loginReturnTarget(redirect)` validates the `redirect` query (attacker-
  influenceable like any URL input): same-origin paths only — leading
  `/`, no `//` (the protocol-relative open-redirect escape), no
  backslash (browsers normalize `\` to `/` — the same escape's twin),
  nothing resolving onto the login route in any casing or slash form;
  everything else collapses to `/`.

### The login form

Deliberately **load-free** (zero fetch on mount — the §14.6 page must
render before any credential exists; the csp-shell e2e deep link stands
on this). The password field is write-only (§15.4): masked, never
prefilled, cleared AT DISPATCH (the request body is built synchronously,
so the attempted candidate never lingers in the field through the
possibly minutes-long pending window), sent verbatim — never trimmed
(§15.2's 12-character minimum binds whoever _sets_ a password, never
the verifier). Failures are catalog sentences selected
by the envelope's `details.reason` — `invalid-credentials` and
`source-busy` (D-146's two distinguishable arms) get their own
sentences, anything else the generic failure; the payload never renders
(D-134). §15.2's budget delays are invisible on the wire (delays, never
rejections), so the form states the behavior up front and the request
carries its own deadline — `LOGIN_TIMEOUT_MS` (250 s, above the
server's 240 s sleep clamp, below the 300 s socket bound, pinned by
test) — so the honest verdict is waited out, not raced into a
doubled-delay retry.

### Sign-out

The header button is visible unless the wire said `unauthenticated` or
the current route is the login page (an authenticated visitor never sits
there — the guard bounces them — so on that page the control would be
noise about an unproven session). A failed sign-out's shared notice is
cleared on the next completed navigation: the shell persists across
routes, and the notice belongs to the sign-out interaction (a retry
re-presents a condition that still holds).
A successful logout resets the store and **reloads the document** to
`/` — a router push would be deduped when the current route already is
`/` (no remount, no fresh loads, no 401 to drive the redirect under
`required`), while the reload restarts the SPA at `unknown` and the
next wire answers decide the world: under `required` the fresh overview
load's 401 redirects to `/login?redirect=/`; under `auto`-loopback the
overview simply renders. Every in-memory artifact of the authenticated
session dies with the document. A 401 logout answer needs no notice
(the hook fires and the watcher navigates); other failures ride the
shared `ApiErrorNotice` in the shell.

## Layout

- `index.html` — document shell (language, viewport, color-scheme, mount
  point, entry module).
- `src/main.ts` — composition root: creates the app, installs the
  router, the i18n instance, the theme controller, the API client, and
  the account-selection store, and mounts after
  the initial navigation resolved (a direct deep link renders the right
  view on the first paint).
- `src/router/index.ts` — route table and `createAppRouter` factory.
- `src/api/` — the typed API client, its error taxonomy, and the
  provide/inject + composable glue (see [The API client and error
  presentation](#the-api-client-and-error-presentation)).
- `src/account-selection.ts` — the selected-account store:
  `createAccountSelection()`, `useAccountSelection()`, the storage key
  (see [The accounts page (task 170)](#the-accounts-page-task-170)).
- `src/components/ApiErrorNotice.vue` — the shared inline error region
  every page presents API failures through.
- `src/components/AccountAddForm.vue`, `src/components/AccountManageCard.vue` —
  the accounts page's form and card (task 170).
- `src/components/AccountOverviewCard.vue`, `src/components/AccountStatusBadge.vue`,
  `src/components/MetricCard.vue` — the overview page's identity card,
  status badge, and metric cards (task 172; see
  [The overview page (task 172)](#the-overview-page-task-172)).
- `src/account-attention.ts` — the pure attention classifier (task 173,
  D-138; see [The overview page (task 172)](#the-overview-page-task-172)).
- `src/components/AccountAttentionNotice.vue` — the overview's
  account-level attention notice (task 173).
- `src/history-range.ts` + `src/components/HistoryRangeControls.vue` — the
  §14.4 rolling-range vocabulary/boundary arithmetic and its control
  (task 174, D-147; see
  [The overview page (task 172)](#the-overview-page-task-172)).
- `src/charts/` — the ECharts runtime seam, the token mapping, the pure
  series adapter/option builder (task 175, D-148), the cursor/zoom
  coordinator (task 178, D-153), beside
  `src/components/MetricHistoryChart.vue` — the per-metric chart card
  (see [The metric charts (task 175, decision
  D-148)](#the-metric-charts-task-175-decision-d-148)).
- `src/settings-fields.ts` + `src/timezones.ts` + the settings components
  (`src/components/SettingsGeneralForm.vue`,
  `SettingsPasswordForm.vue`, `SettingsScheduleSection.vue`) — the
  settings page's validated-vocabulary constants, pure zone helpers, and
  section components (task 179, D-156; see
  [The settings page (task 179)](#the-settings-page-task-179)).
- `src/format.ts` — the pure `Intl` formatting helpers (task 172).
- `src/i18n/` — the `en` message catalog (`en.ts`) and the
  `createAppI18n()` factory; see [Strings and the i18n
  catalog](#strings-and-the-i18n-catalog).
- `src/theme.ts` — the theme controller plugin: `createAppTheme()`,
  `useTheme()`, the storage key, and the validation guard (see
  [Theming](#theming)).
- `src/App.vue` — application shell: site header (title, primary nav,
  theme control, sign-out button) and the single `main` landmark the
  router renders into.
- `src/views/*.vue` — routed page components (every page is implemented —
  overview 172+, accounts 170, settings 179, login 180).
- `src/session.ts` — the session state plugin and its routing (task 180);
  see [Login, logout, and the session layer (task 180)](#login-logout-and-the-session-layer-task-180).
- `src/assets/base.css` — design tokens (`--qm-*` custom properties; the
  single color source) and document-level base styles; the theme blocks
  are described under [Theming](#theming).

## Theming

Spec §14.1 requires `system`, `light`, and `dark` themes with the choice
persisted in browser storage. The implementation (task 168, decision
D-133):

- **Mechanism** — a `data-theme` attribute on the document element,
  flipped by the controller; `src/assets/base.css` maps it onto the
  `--qm-*` tokens:

  | State                       | Tokens come from                                                   |
  | --------------------------- | ------------------------------------------------------------------ |
  | attribute absent (`system`) | the `prefers-color-scheme` block (guarded by `:not([data-theme])`) |
  | `data-theme="light"`        | the light block (outspecifies an OS dark preference)               |
  | `data-theme="dark"`         | the dark block (regardless of the OS preference)                   |

  The attribute flip re-cascades the tokens live — no reload, no
  rebuild, and no inline `style` anywhere (the CSP constraints above).
  `color-scheme` rides the same blocks so UA widgets (form controls,
  scrollbars) follow the mode.

- **Persistence** — `localStorage`, key **`quotameter.theme`**, values
  exactly `system` / `light` / `dark`. An absent or invalid stored value
  reads as `system` (silently; nothing is written back until the user
  picks a mode). Both directions are best-effort: a browser where
  storage access throws or writes fail (locked-down Safari, full quota)
  still gets a fully working session-scoped theme.

- **Control surface** — a labeled `<select>` in the shell header
  (`App.vue`); the settings page (task 179, D-133's hand-off) renders a
  second select on the same controller with its own page-owned strings
  under `settings.theme.*` — one source of truth, two controls. The
  header's strings live under `app.theme.*` in the i18n catalog.

- **Consuming themes correctly (the rule for every later component and
  the 175/176 charts)** — the tokens are the **only** color source:
  read colors from `var(--qm-…)` in CSS or
  `getComputedStyle(document.documentElement).getPropertyValue('--qm-…')`
  from script (never hardcode a color), and re-render on theme changes
  by watching `resolvedTheme` from `useTheme()` (explicit modes resolve
  verbatim; `system` resolves through the OS preference). This is why
  the CSS `light-dark()` function is not used in the tokens: a custom
  property would keep the unresolved wrapper, not a usable color.

- **Known limitation** — a stored explicit mode applies when the app's
  JavaScript runs, so a first paint in a differing system scheme may
  flash once before switching. The usual fix (an inline pre-render
  script) is impossible under the served CSP (D-127: no inline
  scripts); the flash is accepted.

## Accessibility and responsive behavior

Spec §14.1's four demands — WCAG AA contrast, keyboard operation,
never color alone, and working from 360 px — are verified as a standing
layer (task 181, decision D-164), not left to per-component care:

- **Axe scans** (`test/e2e/a11y.spec.ts`, WCAG 2.1/2.2 AA tags through
  `@axe-core/playwright`): every page's populated surface is scanned in
  both explicit themes with the tokens verified applied (the explicit
  `data-theme` states assert themselves before each scan; `system`
  computes the identical cascade, pinned by the raw-token reads in
  `test/e2e/theme.spec.ts`). Data-backed surfaces are served through
  route interception — including the charts region with its full
  annotation vocabulary (the chart `role="img"`, its aria summary with
  the annotation counts, the percent/absolute toggle, a live ECharts
  canvas in the scanned host), the populated accounts page with the
  purge confirm panel open, and the login failure surface. Contrast
  never rides a tone pair: status badge text stays
  `--qm-color-foreground` in every tone, and the chart/annotation
  tokens keep ≥ 3:1 against the mode background (non-text) beside
  their text signals.
- **Keyboard operation** (`test/e2e/keyboard.spec.ts`): the shell's Tab
  order and Enter navigation, the arrow-operated theme select, the
  login round trip by keyboard alone, the §14.4 range switch through
  the native radio group (proven by the re-dispatched history window),
  the inline panels' dismissal, and the time-zone suggestion seams
  below. Interactive controls are native (buttons, radios, selects,
  real anchors) so the platform's keyboard support applies by
  construction.
- **The designed focus indicator**: one global `:focus-visible` rule in
  `src/assets/base.css` (a 2 px `--qm-color-foreground` outline with
  offset) — the ring every keyboard-reached control paints, pinned by
  computed-style assertions in the keyboard spec (solid outline on a
  Tab-focused nav link; the outline COLOR flipping with the mode on a
  focused select, so the token resolution — light and dark; system
  resolves to one of the two per the theme spec's pins — is exercised).
- **Panel dismissal** (`AccountManageCard.vue`): the four inline
  surfaces (rename, replace-key, archive confirm, purge confirm) close
  on Escape and return focus to the opener button — focus moves IN on
  open (the archive confirm lands on the safe control) and BACK on
  dismissal and on a successful save alike (a removed account hands
  focus to the accounts selector from the parent). Escape during a
  pending mutation is ignored: the dispatched request owns its panel
  until it settles (resetting mid-flight would suppress the outcome
  while the request still applies). IME composition owns the Escape
  key while active. Component arms pin the contract per panel.
- **The time-zone suggestion list** (task 179's declined combobox
  follow-up): the field keeps the native-controls stance — the
  suggestions are real focusable buttons — and carries the
  ARIA-1.2-legal linkage (`aria-describedby` to the search hint,
  `aria-autocomplete="list"`, and `aria-controls` rendered only while
  the list exists; `aria-expanded` is prohibited on a plain textbox
  and stays with the full combobox contract the project declined).
  ArrowDown focuses the first suggestion; Enter picks one and returns
  focus to the field (the picked button unmounts with the list);
  Escape reverts the edit to the served value from the field or a
  suggestion button.
- **360 px**: all four pages pin `scrollWidth ≤ clientWidth` at a 360 px
  viewport — the charts grid carries a `minmax(min(100%, …))` floor;
  the other grids and tables (the metric cards, the facts rows, the
  schedule table) simply fit the 360 px content column.
- **Recorded residuals** (D-164): the chart zoom-in gesture is
  pointer-only — the chart is a `role="img"` text alternative over data
  fully available as text, the zoom **reset** is keyboard-operable, and
  ECharts ships no keyboard dataZoom; full combobox semantics for the
  zone search stay declined.

## Strings and the i18n catalog

Repository artifacts are English-only (spec §4.1), and every user-facing
UI string lives in the `vue-i18n` English catalog (spec §14.1): the
typed module `src/i18n/en.ts`, installed by `createAppI18n()` and read
through `t()` from `useI18n()`. Components never carry string literals.

- **Structure** (decision D-132): nested by surface, flat dot paths at
  the call sites. `app` and `nav` own the shell chrome; each route page
  owns one namespace (`overview`, `accounts`, `settings`, `login`) — a
  content task adds its keys under the page's namespace and replaces the
  placeholder `status` entries there, touching no other surface.
  Identical values in different namespaces stay distinct keys: the
  contexts differ and may diverge (`nav.overview` labels a link,
  `overview.title` a page heading).
- **Completeness is executable, in both directions**
  (`test/component/i18n-catalog.spec.ts`): a `t()` key missing from the
  catalog fails; a catalog key referenced nowhere fails (dead keys die
  with their pages — there are no reserved namespaces); a `t()` call
  whose argument is not a static string literal fails (dynamic keys
  would be invisible to both directions). Since task 182 (decision
  D-165) the interpolation seam is proven too: every `{placeholder}` a
  message carries is supplied at EVERY call site (or by the closed
  chart-template table — the keys `MetricHistoryChart` renders raw and
  the chart builder interpolates itself), no supplied name is dead, and
  every key renders through the real composer (paramless verbatim,
  parameterized without residual braces) — a drifted or half-supplied
  placeholder fails the suite instead of rendering literal braces on
  screen.
- **The attribute blind spot is closed twice** (decision D-131 recorded
  it, D-132 closes it): ESLint's `@intlify/vue-i18n/no-raw-text` reads
  text nodes only, so it is configured with the rule's `attributes`
  option — a static literal in a user-facing attribute (`aria-label`,
  `title`, `alt`, `placeholder`, `label`, `abbr`, and the other
  text-bearing ARIA attributes — a closed list) is a lint error, while
  bound expressions (`:aria-label="t('nav.ariaLabel')"`) stay legal —
  and `test/component/i18n-catalog.spec.ts` pins the same set over the
  real components (no drift between the two lists) plus the disguise
  lint cannot see: a bound attribute whose expression is exactly a
  string literal (`:title="'Save'"`) fails the spec too.
- **Lint has no exceptions** since task 167: the task-036 bootstrap
  ignore list is gone, and `test/unit/vue-i18n-lint.spec.ts` pins that
  even the former bootstrap spellings fail lint as raw text, and that
  the attribute check fires (static `title` fails, the bound `t()` form
  passes).
- **Message syntax**: values are vue-i18n message format — `{`, `}`,
  `@`, and `|` are special; write them as literal escapes (`{'@'}`) when
  a string needs them verbatim.
- The document `<title>` in `index.html` is the one deliberate
  non-catalog string: the static document shell outside Vue, not a
  component string.
