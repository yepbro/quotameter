# Quotameter web UI

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
- **API client** (`src/api/`, task 169): the typed same-origin data
  layer over the §13 HTTP API, with the shared error taxonomy and the
  `ApiErrorNotice` presentation — see [The API client and error
  presentation](#the-api-client-and-error-presentation).

## Routes

The server serves `index.html` for every non-`/api` path (spec §14.1 SPA
fallback), and the router resolves the URL client-side — deep links work
without server-side route tables.

| Path        | Name       | View                             | Content task        |
| ----------- | ---------- | -------------------------------- | ------------------- |
| `/`         | `overview` | `src/views/OverviewView.vue`     | 172 (done), 173–174 |
| `/accounts` | `accounts` | `src/views/AccountsView.vue`     | 170 (done)          |
| `/settings` | `settings` | `src/views/SettingsView.vue`     | 179                 |
| `/login`    | `login`    | `src/views/LoginView.vue`        | 180                 |
| any other   | —          | redirect to `/` (decision D-131) | —                   |

The route table and the `createAppRouter(history)` factory (memory-history
seam for component tests) live in `src/router/index.ts`. The `/login`
route has no navigation guard yet — task 180 adds the auth-state
handling, and the login nav entry with it.

## Building

```sh
make build            # inside the container: build + verify artifacts
npm run build:ui      # equivalent direct form (writes $DIST_DIR when set, ui/dist otherwise)
npm run preview:ui    # serve the built UI on 127.0.0.1:4173 (Playwright)
```

Build output goes to `ui/dist`, or to `$DIST_DIR` when set — the
development container redirects it into the isolated data volume so the
container (uid 1000) never writes into the host-owned tree
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

| Module                              | Owns                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/client.ts`                 | `createApiClient({fetchImpl?, baseUrl?, timeoutMs?})` and the endpoint families (`health`, `status`, `quota`, `providers`, `accounts`, `settings`) — pure TypeScript, no Vue. |
| `src/api/error.ts`                  | the `ApiClientError` taxonomy and the loose §13-envelope recognizer.                                                                                                          |
| `src/api/index.ts`                  | the Vue half: `createApiClientPlugin()` (provide) / `useApi()` (inject), `useApiCall()` (the per-request composable), and the re-exports pages import.                        |
| `src/components/ApiErrorNotice.vue` | the one presentation surface: an inline `role="alert"` region (`data-testid="api-error"`) rendering catalog sentences per taxonomy class.                                     |

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

Future families join as methods on the client: `history`/`events`
(task 161), `peakHours` (162), and `auth` (180). **The task-180 seam:**
`ApiErrorNotice`'s `UNAUTHENTICATED` branch is where the login redirect
(the named `login` route) hooks in; the error object's `code` field is the
programmatic signal, so the guard can intercept `code === 'UNAUTHENTICATED'`
before presentation.

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

| Module                                   | Owns                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/views/OverviewView.vue`             | the five loads (one `useApiCall` each), the selector, the reconciliation, the last-good copies, the 174 seam                         |
| `src/components/AccountOverviewCard.vue` | the identity facts: provider name, label, plan (`Unknown` when absent), the status badge, last success / last error (`Never`/`None`) |
| `src/components/AccountStatusBadge.vue`  | the eight §14.6/§7.3 statuses as text + tone class + CSS-drawn shape marker (§14.1: never color alone)                               |
| `src/components/MetricCard.vue`          | one metric: label, quota type (+ rolling window), per-field values with explicit units, reset and collection stamps                  |
| `src/format.ts`                          | the pure `Intl` helpers (`formatEpochMs`, `formatRelative`, `formatQuotaNumber`, `windowHours`) — 174+ reuse these                   |

The five loads: `accounts.list`, `providers.list` (display names **and**
the metric-label catalog), `status.get`, `settings.get` (exactly the
configured display time zone, §14.1), and `quota.get(selectedId)` —
re-run on every selection change. The selection store is shared with
the accounts page (`quotameter.selected-account`): the overview adds its
own selector on the same store and re-runs the same reconciliation rule
on every completed list load. The quota target is **list-validated** —
the selected id dispatches only once a completed list load vouches for
it, so a stale stored id (purged elsewhere) earns no flashing 404 — and
switching the selection **clears** the previous account's quota before
the new load: one account's values can never render as another's. A
failed load is never a fake empty state: each call keeps its last-good
copy beside its `ApiErrorNotice`; the data-defining loads (accounts,
status, quota) carry retries with distinct accessible names, the two
that degrade gracefully (providers → raw ids/keys, settings → the
browser's time zone) render their notice alone. A status row that is
absent (load in flight or failed) renders its slots as `Unknown` —
"Never"/"None" state collection history only a loaded row vouches for.

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
  skip path), which states its own different fact; task 173 owns the
  fuller guidance.
- Absent `resetsAt` omits the reset line (§14.3's own "if available").
- Times render absolute (in the configured display zone) plus relative,
  computed when data arrives (no live ticker — a reload re-renders).

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

### Task 174's layout seam

The metric cards flow in a responsive grid inside
`[data-testid="overview-metrics"]`; the rolling-range controls (spec
§14.4, task 174) mount between the account card and that region — no
placeholder UI is shipped for them. The charts (175+) read colors only
through the token lookups (D-133) and reuse `src/format.ts`.

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
- `src/format.ts` — the pure `Intl` formatting helpers (task 172).
- `src/i18n/` — the `en` message catalog (`en.ts`) and the
  `createAppI18n()` factory; see [Strings and the i18n
  catalog](#strings-and-the-i18n-catalog).
- `src/theme.ts` — the theme controller plugin: `createAppTheme()`,
  `useTheme()`, the storage key, and the validation guard (see
  [Theming](#theming)).
- `src/App.vue` — application shell: site header (title, primary nav,
  theme control) and the single `main` landmark the router renders into.
- `src/views/*.vue` — routed page components (placeholders until their
  content tasks land; each already carries the shared error wiring of
  task 169).
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
  (`App.vue`); the settings page (task 179) reuses the same
  `useTheme()` seam. All control strings live under `app.theme.*` in the
  i18n catalog.

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
  would be invisible to both directions).
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
