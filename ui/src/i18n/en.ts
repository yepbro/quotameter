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
  // The shared error surface (task 169, D-134): every key is rendered by
  // ApiErrorNotice.vue's explicit branches — kind messages for transport
  // failures, per-code messages for the §13 envelope's registry codes,
  // and the `unknown` fallback for any code this build does not know.
  // These are the ONLY strings an API failure may put on screen; the
  // envelope's own message/details never render (unvouched provenance).
  errors: {
    network: 'Cannot reach the Quotameter service. Check that it is running and reload the page.',
    timeout: 'The Quotameter service did not respond in time. Try again.',
    unexpected:
      'The Quotameter service answered in an unexpected format. Reload the page or check the server setup.',
    aborted: 'The request was cancelled.',
    codes: {
      validation: 'The request was rejected as invalid.',
      // Task 180's seam: the UNAUTHENTICATED branch is where the login
      // redirect (the named `login` route) will hook in; until then this
      // message is the branch's whole presentation.
      unauthenticated: 'Sign-in is required to use this page.',
      forbidden: 'The request was refused.',
      notFound: 'The requested item was not found.',
      payloadTooLarge: 'The request was too large.',
      uriTooLong: 'The request address was too long.',
      unsupportedMediaType: 'The request format is not supported.',
      internal: 'The Quotameter service reported an internal error. Try again later.',
      unknown: 'The Quotameter service reported an error.',
    },
  },
} as const;
