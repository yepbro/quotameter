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
  // The account-management page (task 170, spec §14.2; decision D-135):
  // the selector, the identity facts of the selected account, one action
  // group per §14.2 verb, the two confirmation affordances, and the
  // connection-test outcome vocabulary.
  accounts: {
    title: 'Accounts',
    loading: 'Loading accounts…',
    // The retry beside a failed list load (D-135's failed-load rule).
    retry: 'Retry loading accounts',
    // The selector above the selected account's management card.
    selector: {
      label: 'Account',
    },
    // Helpful empty state (§14.2): what the page shows with no accounts.
    empty: {
      title: 'No accounts yet',
      hint: 'Add your first account below — you can skip the API key and set it later.',
    },
    // The selected account's identity and management facts.
    card: {
      provider: 'Provider',
      status: 'Status',
      statusActive: 'Active',
      statusArchived: 'Archived',
      polling: 'Polling',
      pollingOn: 'Enabled',
      pollingOff: 'Disabled',
      key: 'API key',
      keyNone: 'Not set',
      keyEnvironment: 'From the environment — read-only here',
      archivedNotice:
        'This account is archived. Its history is retained; only purging is available.',
    },
    actions: {
      test: 'Test connection',
      testPending: 'Testing…',
      rename: 'Rename',
      renameField: 'New label',
      save: 'Save',
      cancel: 'Cancel',
      disablePolling: 'Disable polling',
      enablePolling: 'Enable polling',
      replaceKey: 'Replace API key',
      keyField: 'New API key',
      keyHint: 'Write-only: the key is stored, never displayed.',
      archive: 'Archive account',
    },
    test: {
      ok: 'Connection test passed.',
      rejected: 'Connection test failed: the provider rejected the API key.',
      unavailable: 'Connection test was inconclusive.',
    },
    archive: {
      title: 'Archive this account?',
      body: 'Archiving stops polling and keeps the collected history. Archiving cannot be undone.',
      confirm: 'Archive',
    },
    purge: {
      action: 'Purge history',
      title: 'Purge this account and its history?',
      body: 'Purging permanently deletes the account and every collected history row. This cannot be undone.',
      typeLabel: 'Type the account label “{label}” to confirm:',
      confirm: 'Purge permanently',
    },
    add: {
      title: 'Add account',
      provider: 'Provider',
      label: 'Label',
      key: 'API key (optional)',
      keyHint: 'Optional now — you can set the key later on this page.',
      submit: 'Add account',
      pending: 'Adding…',
      noProviders: 'No provider is available in this build; accounts cannot be added.',
    },
    form: {
      errorLabelRequired: 'A label is required.',
      errorKeyBlank: 'The API key must not be blank.',
    },
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
