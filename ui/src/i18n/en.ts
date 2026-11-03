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
    // The account-overview page (task 172, spec §14.3/§14.6; decision
    // D-137): the shared loads' transient states, the selector, the
    // identity card's fact labels, the §14.6 status vocabulary, the
    // §7.2 error-outcome phrases, and the metric-card field vocabulary.
    // Task 173 (D-138) adds the empty/initial guidance: the
    // no-accounts block and the attention notice vocabulary.
    loading: 'Loading the overview…',
    // One retry label per data-defining load (distinct accessible names —
    // a screen-reader user must tell which load failed from the control).
    retryList: 'Retry loading accounts',
    retryStatus: 'Retry loading statuses',
    retryQuota: 'Retry loading values',
    selector: {
      label: 'Account',
      // The archived marker in the selector's option text — a text
      // signal, never color alone (§14.1).
      archivedOption: 'Archived',
    },
    empty: {
      // The page-level no-accounts guidance (task 173, spec §14.3):
      // a titled block whose link is the actionable next step. The
      // wording harmonizes with the accounts page's own empty state
      // (task 170); the keys stay namespace-distinct (D-132).
      noAccountsTitle: 'No accounts yet',
      noAccountsHint:
        'Add one on the Accounts page — you can skip the API key at first and set it later.',
      cta: 'Go to Accounts',
      noSnapshot: 'No successful collection yet — values appear after the first successful poll.',
      // The same absent snapshot under an account-level blocker (no
      // key, polling off, archived): the waiting sentence's promise
      // would be false — the attention notice above the region
      // carries the actionable why (task 173, D-138).
      noSnapshotBlocked: 'No usage values yet — collection is not running for this account.',
      // A snapshot that succeeded but recognized no metric rows (the
      // adapter's skip path) — a different fact from no snapshot.
      noMetrics: 'The latest successful collection reported no quota values.',
    },
    // The account-level attention notice (task 173, spec §14.3/§14.6;
    // D-138): why collection is not running for the selected account
    // and what to do about it — the link renders exactly where the
    // remedy is a UI action.
    attention: {
      archived:
        'This account is archived: polling is stopped and its collected history is retained. Manage or purge it on the Accounts page.',
      disabled:
        'Polling is disabled for this account. Enable it on the Accounts page to resume collection.',
      // An environment-sourced key is read-only through the API
      // (§6.3) — the remedy is server-side, so no link renders.
      keylessEnvironment:
        'The API key for this account comes from an environment variable that is not set where the service runs. Set that variable and restart the service.',
      keyless:
        'No API key is configured for this account. Set the API key on the Accounts page so collection can run.',
      cta: 'Go to Accounts',
    },
    // The §14.6 status vocabulary (rendered by AccountStatusBadge).
    status: {
      fresh: 'Fresh',
      collecting: 'Collecting',
      unreachable: 'Unreachable',
      authRejected: 'Auth rejected',
      stale: 'Stale',
      formatChanged: 'Format changed',
      disabled: 'Disabled',
      notConfigured: 'Not configured',
    },
    card: {
      provider: 'Provider',
      plan: 'Plan',
      // A null plan name is the explicit unknown — never a guess.
      planUnknown: 'Unknown',
      // A status row that is absent (load in flight or failed) — the
      // explicit unknown, never asserted collection facts.
      unknown: 'Unknown',
      status: 'Status',
      lastSuccess: 'Last successful collection',
      never: 'Never — no successful collection yet',
      // The rendered fact phrases (punctuation lives here, not in the
      // templates — raw text nodes are lint-forbidden, D-132).
      lastSuccessValue: '{absolute} ({relative})',
      lastError: 'Last error',
      noError: 'None',
      lastErrorValue: '{absolute} ({relative}) · {outcome} · {message}',
      lastErrorValueNoMessage: '{absolute} ({relative}) · {outcome}',
    },
    error: {
      // The §11.2 failure-outcome classes of a status row's lastError.
      outcome: {
        authError: 'Authentication error',
        rateLimited: 'Rate limited',
        networkError: 'Network error',
        timeout: 'Timeout',
        serverError: 'Server error',
        parseError: 'Response format error',
      },
    },
    metric: {
      limitType: {
        rollingWindow: 'Rolling window',
        daily: 'Daily',
        weekly: 'Weekly',
        monthly: 'Monthly',
        other: 'Other',
      },
      windowHours: '{count}-hour window',
      used: 'Used',
      remaining: 'Remaining',
      limit: 'Limit',
      // The explicit absence marker — the §7.2 never-zero discipline.
      unknown: 'Unknown',
      invalidValue: 'Invalid reading: {reason}',
      resetsAtValue: 'Resets: {absolute} ({relative})',
      collectedAtValue: 'Collected: {absolute} ({relative})',
      unit: {
        tokens: 'tokens',
        credits: 'credits',
        requests: 'requests',
        percent: 'percent',
      },
    },
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
