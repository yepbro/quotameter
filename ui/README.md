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

## Routes

The server serves `index.html` for every non-`/api` path (spec §14.1 SPA
fallback), and the router resolves the URL client-side — deep links work
without server-side route tables.

| Path        | Name       | View                             | Content task |
| ----------- | ---------- | -------------------------------- | ------------ |
| `/`         | `overview` | `src/views/OverviewView.vue`     | 172–174      |
| `/accounts` | `accounts` | `src/views/AccountsView.vue`     | 170+         |
| `/settings` | `settings` | `src/views/SettingsView.vue`     | 179          |
| `/login`    | `login`    | `src/views/LoginView.vue`        | 180          |
| any other   | —          | redirect to `/` (decision D-131) | —            |

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

## Layout

- `index.html` — document shell (language, viewport, color-scheme, mount
  point, entry module).
- `src/main.ts` — composition root: creates the app, installs the
  router, the i18n instance, and the theme controller, and mounts after
  the initial navigation resolved (a direct deep link renders the right
  view on the first paint).
- `src/router/index.ts` — route table and `createAppRouter` factory.
- `src/i18n/` — the `en` message catalog (`en.ts`) and the
  `createAppI18n()` factory; see [Strings and the i18n
  catalog](#strings-and-the-i18n-catalog).
- `src/theme.ts` — the theme controller plugin: `createAppTheme()`,
  `useTheme()`, the storage key, and the validation guard (see
  [Theming](#theming)).
- `src/App.vue` — application shell: site header (title, primary nav,
  theme control) and the single `main` landmark the router renders into.
- `src/views/*.vue` — routed page components (placeholders until their
  content tasks land).
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
