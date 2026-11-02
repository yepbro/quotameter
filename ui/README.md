# Quotameter web UI

The browser frontend of the Quotameter service (spec §3, §14): a Vue 3
application bundled by Vite and served — already built — by the
application's Fastify server from `ui/dist`. The UI never talks to
providers directly; all data flows through the HTTP API (spec §13, §14).

## Stack

- **Vue 3** single-file components (`<script setup lang="ts">`, strict
  TypeScript — `ui/tsconfig.json` extends the root config).
- **Vite** for the production bundle; no dev-server-specific behavior is
  relied upon at runtime.
- **Vue Test Utils + happy-dom** for component tests (the Vitest
  `component` project, `test/component/`).
- Vue Router, `vue-i18n`, and theming arrive with the UI implementation
  stages (tasks 166–168); `src/main.ts` is the single composition seam
  they plug into.

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
- `src/main.ts` — composition root: creates and mounts the app; plugin
  seams for the later stages live here.
- `src/App.vue` — application shell root (mount-level structure).
- `src/assets/base.css` — design tokens (`--qm-*` custom properties with
  a `prefers-color-scheme` dark block) and document-level base styles;
  theme selection (task 168) builds on these names.

## Strings and language

Repository artifacts are English-only (spec §4.1). Every user-facing
string must eventually live in the `vue-i18n` English catalog (spec
§14.1, task 167); until the catalog exists, the two placeholder strings
in `src/App.vue` are the documented ESLint exception
(`@intlify/vue-i18n/no-raw-text` ignore list in `eslint.config.ts`).
