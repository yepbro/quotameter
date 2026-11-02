/**
 * The English message catalog (spec §14.1, decision D-132): the only
 * shipped locale, and the single home of every user-facing UI string —
 * components render exclusively through `t()` lookups into this object.
 *
 * Structure: nested by surface, with flat dot paths at the call sites.
 * `app` and `nav` own the shell chrome; each route page owns its
 * namespace, so a content task rewrites its page's keys (replacing the
 * placeholder status entries) without touching any other surface.
 * Identical values in different namespaces stay distinct keys — the
 * contexts differ (`nav.overview` labels a link, `overview.title` a
 * page heading) and may diverge later.
 *
 * Message syntax: values are vue-i18n message format — `{`, `}`, `@`,
 * and `|` are special and must be written as literal escapes
 * (`{'@'}`) when a string needs them verbatim.
 */
export const en = {
  app: {
    title: 'Quotameter',
    // The shell-level theme control (§14.1; D-133).
    theme: {
      label: 'Theme',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
    },
  },
  nav: {
    ariaLabel: 'Primary',
    overview: 'Overview',
    accounts: 'Accounts',
    settings: 'Settings',
  },
  overview: {
    title: 'Overview',
    // The bootstrap status line the smoke contract asserts (D-129).
    status: 'Setup in progress — the interface is not implemented yet.',
  },
  accounts: {
    title: 'Accounts',
    status: 'Not implemented yet.',
  },
  settings: {
    title: 'Settings',
    status: 'Not implemented yet.',
  },
  login: {
    title: 'Login',
    status: 'Not implemented yet.',
  },
} as const;
