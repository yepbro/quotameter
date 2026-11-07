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
    // The header's session control (§14.6; task 180, D-159).
    session: {
      signOut: 'Sign out',
      signOutPending: 'Signing out…',
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
    // One retry per range-keyed load (the distinct-accessible-name rule
    // above; task 174). The per-metric series retries live under
    // `chart.retry` below (task 175); the timeline's and the schedule's
    // are the page-level loads'.
    retryEvents: 'Retry loading the timeline',
    retryPeakHours: 'Retry loading the peak-hours schedule',
    // The §14.4 rolling-range control (task 174; decision D-147): the
    // five history ranges, the retention-driven disabling explanation
    // (real text beside the disabled option — never color alone), and
    // the refresh that re-anchors the rolling window.
    range: {
      label: 'History range',
      hours24: '24 hours',
      days3: '3 days',
      days7: '7 days',
      days14: '14 days',
      days30: '30 days',
      disabledReason: 'Exceeds the {days}-day history retention',
      // The auto-fallback's announcement (a polite live region): the
      // selection moved because retention demands it — heard, not only
      // seen (§14.1).
      fallbackNotice:
        'The selected range is beyond the configured retention — showing the last 7 days instead.',
      refresh: 'Refresh',
    },
    // The §14.4 metric charts (task 175, decision D-148): the region's
    // title, the per-chart states (loading, empty, the range-report
    // notices), the percent/absolute toggle, the series labels, and the
    // aria summary that states the chart's latest facts as text (§14.1:
    // never color alone).
    //
    // Task 176 (D-149) adds the annotation vocabulary: the band/marker
    // tooltip templates (composed by the pure option builder over the
    // served §9.3/§12.2 facts), the reset marker's on-line label, the
    // failed-collections strip's legend name, and the aria summary's mark
    // counts — every user-facing string of the annotations lives here.
    chart: {
      regionTitle: 'History charts',
      loading: 'Loading history…',
      empty: 'No collected values in this range yet.',
      // The range report's outcomes (D-139/D-147): a rejected range is
      // entirely before the retention horizon; a real truncation names
      // where the retained window starts.
      rejected: 'The requested range is outside the configured history retention.',
      truncatedNotice:
        'Values in this range start {time} — older values are outside the configured history retention.',
      // A series of only invalid rows and gap markers — a different fact
      // from an empty range (the empty wording promises values a working
      // collector would have delivered).
      noValidValues: 'No valid values were collected in this range.',
      retry: 'Retry loading the {metric} history',
      viewLabel: 'Values shown',
      viewAbsolute: 'Absolute values',
      viewPercent: 'Percentages',
      seriesUsed: 'Used',
      seriesRemaining: 'Remaining',
      // The chart's accessible name carries the metric (several chart
      // images share one page — each must say which metric it is).
      summaryAbsolute: '{metric}: latest {used} used, {remaining} remaining {unit} at {time}',
      summaryPercent: '{metric}: latest {used} used, {remaining} remaining at {time}',
      // Appended to the aria summary when the range carries annotations —
      // the markers are facts, stated as text (§14.1). The count-first
      // phrasing stays grammatical at any count.
      summaryMarks: '— in range: {marks}',
      marksResets: '{count} quota resets',
      marksGaps: '{count} collection gaps',
      marksStopped: '{count} stopped periods',
      marksErrors: '{count} failed collections',
      // The §14.4 annotation tooltips (task 176, D-149): composed by the
      // pure builder from the served facts — the peak head names the
      // window and its rate multiplier (§9.3), the times line renders in
      // both the display and the schedule zone (the schedule pair is the
      // server's own local-time rendering, verbatim per §9.3/D-142).
      peakHead: 'Peak · {name} ×{multiplier}',
      offPeakHead: 'Off-peak ×{multiplier}',
      bandTimes: '{start} – {end} ({zone})',
      gapHead: 'Collection gap',
      gapBody: 'No successful collection for {duration}',
      stoppedHead: 'Service stopped',
      stoppedBody: 'No collection records for {duration}',
      stoppedLabel: 'Service stopped',
      resetTooltip: 'Quota reset at {time}',
      resetLabel: 'Reset',
      bandsSeries: 'Schedule areas',
      errorsSeries: 'Failed collections',
      errorAttempts: 'attempts: {count}',
      errorStatus: 'HTTP {status}',
      errorRetryAfter: 'retry after {seconds} s',
      // The §14.4 cursor/zoom sync (task 178, D-153): the page-level reset
      // (a keyboard-operable native button, rendered exactly while a zoom
      // window is live) and the polite live region that announces the
      // zoom transitions — one sentence per transition, never per wheel
      // tick (§14.1).
      resetZoom: 'Reset zoom',
      zoomApplied: 'Charts zoomed to {from} – {to}.',
      zoomReset: 'Zoom reset — charts show the full selected range.',
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
  // The settings page (task 179, spec §14.5; decision D-156): the
  // read-only server/auth facts with their §6.4 annotations, the
  // §6.4-live editable scalars, the theme row (the same controller the
  // header select drives), the §15.2 password change with its session
  // consequence, the §9.2 read-only peak schedule, and the §6.1 paths.
  settings: {
    title: 'Settings',
    loading: 'Loading settings…',
    // The retry beside a failed settings load (D-135's failed-load rule).
    retry: 'Retry loading settings',
    // The §6.4 restart-requiring trio: values render read-only, each row
    // carrying the marker and the §6.4 remedy line below the section.
    facts: {
      heading: 'Server and authentication',
      host: 'Bind address',
      port: 'Port',
      authMode: 'Authentication mode',
      // §6.4's own label, verbatim — the marker is text, never color
      // alone (§14.1).
      restartRequired: 'restart required',
      // §6.4's remedy, shown beside every restart-required row.
      restartHint:
        'These settings apply after a process restart: edit the configuration file, then run quotameter restart.',
      // The §6.3 read-only marking for environment-supplied values.
      environment: 'Set by the environment — read-only',
    },
    // The §6.4-live editable scalars (the PUT's runtime-modification set,
    // D-130): field errors are per-field (D-134 presentation applies to
    // API failures; client guards keep the request honest).
    general: {
      heading: 'General',
      timezone: 'Display time zone',
      timezoneHint: 'An explicit IANA zone — type to search, then pick a match.',
      // The suggestion list's accessible name (task 181, D-164): the
      // input's aria-controls points here.
      timezoneSuggestions: 'Matching time zones',
      timezoneBlank: 'A display time zone is required.',
      timezoneInvalid: 'Enter a valid IANA time-zone name.',
      interval: 'Polling interval (seconds)',
      intervalInvalid: 'Enter a whole number between {min} and {max}.',
      retention: 'History retention (days)',
      // The D-147 interplay stated where it is decided: retention bounds
      // the ranges the Overview page offers.
      retentionHint: 'Also decides which history ranges the Overview page offers.',
      retentionInvalid: 'Enter a whole number between {min} and {max}.',
      // §11.3's reduce-retention warning (D-178): a draft below the window
      // the last cleanup applied means the records between the two windows
      // go at the NEXT cleanup — {days} is the drafted new window.
      retentionReduceWarning: 'History older than {days} days will be removed at the next cleanup.',
      level: 'Log level',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Settings saved.',
      // A non-empty PUT outcome restartRequired list: the process's
      // pending file changes, never this request's doing (D-130).
      restartPending: 'Waiting for a restart to apply: {fields}. Run quotameter restart.',
    },
    // The theme row — the same useTheme() controller the header select
    // drives (D-133's hand-off: one source of truth, page-owned keys).
    theme: {
      label: 'Theme',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
    },
    // The §15.2 password change (the PUT's auth.password channel; the
    // change revokes every session — D-124/D-126 — stated up front and
    // again on success). Rendered in both auth modes: `auto` uses a
    // password on the remote paths (§15.1), so the section must not
    // vanish for an operator who set one.
    password: {
      heading: 'Password',
      configured: 'A password is set.',
      notSet: 'No password is set.',
      field: 'New password',
      hint: 'Write-only, at least {min} characters. Changing it signs out every session, including this one.',
      errorShort: 'The password must be at least {min} characters.',
      submit: 'Change password',
      pending: 'Changing…',
      changed: 'Password changed. All sessions were revoked — sign in again when prompted.',
    },
    // The §9.2 peak-hours schedule, read-only with its own time zone:
    // window names, days, and times are the served configuration's own
    // strings, rendered verbatim (trusted server data).
    schedule: {
      heading: 'Peak-hours schedule',
      readOnly: 'Read-only — edit the configuration file and run quotameter reload.',
      providerZone: 'Schedule time zone',
      offPeak: 'Off-peak rate',
      windowName: 'Window',
      windowDays: 'Days',
      windowTime: 'Local time',
      windowTimeValue: '{start}–{end}',
      windowRate: 'Rate',
      rateValue: '×{rate}',
      // §9.2's exact sentence for the null schedule and the empty
      // windows array alike — never an invented schedule.
      notConfigured: 'Peak-hours schedule is not configured.',
      noProviders: 'No provider is available in this build.',
    },
    // The §6.1 paths display — informational facts of the running
    // process, read-only.
    paths: {
      heading: 'Paths',
      config: 'Configuration file',
      data: 'Data directory',
    },
  },
  // The §14.6 login page (task 180, spec §15.1/§15.2; decision D-159):
  // the mode-agnostic password form. The three failure sentences are
  // the login endpoint's own wire arms (D-146) selected by the
  // envelope's `details.reason` — catalog-only presentation (D-134);
  // the delay hint states §15.2's own budget behavior, which the wire
  // deliberately does not distinguish (delays are invisible: the answer
  // is simply slow).
  login: {
    title: 'Sign in',
    field: 'Password',
    errorBlank: 'Enter the password.',
    submit: 'Sign in',
    pending: 'Signing in…',
    delayHint:
      'After several failed attempts the service deliberately slows each sign-in — if this takes a while, wait rather than retry.',
    errors: {
      incorrect: 'That password is incorrect.',
      busy: 'Another sign-in attempt from your address is still in progress. Wait for it to finish, then try again.',
      failed: 'Sign-in failed. Try again.',
    },
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
      // Task 180 (D-159): this branch is the presentation an
      // UNAUTHENTICATED answer keeps WHILE the session layer's redirect
      // (the named `login` route, destination preserved) takes the page
      // away — the interception itself lives in the client's
      // `onUnauthenticated` hook, the one path every request takes.
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
