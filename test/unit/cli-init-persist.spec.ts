import { describe, expect, it } from 'vitest';
import { parseConfig, type CanonicalConfig } from '../../src/config/load';
import {
  assembleInitConfig,
  initSettingsChanged,
  passwordRequirementNote,
  readExistingConfig,
  renderAccountSummary,
  renderExistingSettings,
  renderUpdateSummary,
  sameDetectionState,
  toInitFailure,
} from '../../src/cli/init-persist';
import type { InitAnswers } from '../../src/cli/init-questions';

/**
 * The idempotent-init support layer (task 132, spec §5.3, §6.1–§6.3;
 * decision D-101): detection classification (through the injected reader —
 * no filesystem here), the §15.1 password-pending tolerance on both the
 * read and the write side, the masked current-settings display, the merge
 * over an existing configuration, change detection, and the failure
 * vocabulary.
 */

/** A canonical fixture through the real parser (no hand brands). */
function canonical(input: unknown): CanonicalConfig {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw new Error(`fixture configuration rejected: ${parsed.problems.join('; ')}`);
  return parsed.value as CanonicalConfig;
}

/** The pending (§15.1) fixture through the production write-side probe. */
function pendingConfig(answers: InitAnswers): CanonicalConfig {
  const assembled = assembleInitConfig(answers);
  if (!assembled.ok || !assembled.passwordPending) {
    throw new Error('fixture answers did not produce a password-pending configuration');
  }
  return assembled.config;
}

/** A filesystem error like `node:fs` would throw it. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

const EXISTING = (): CanonicalConfig =>
  canonical({
    server: { host: '127.0.0.1', port: 9000 },
    app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
  });

describe('readExistingConfig', () => {
  it('a missing file (ENOENT) is the fresh-install state', async () => {
    const reader = async () => {
      throw errnoError('ENOENT', 'no such file or directory');
    };
    expect(await readExistingConfig('/x/config.json', reader)).toEqual({ state: 'none' });
  });

  it('a valid file loads through the real pipeline and canonicalizes defaults', async () => {
    const reader = async () => '{"app":{"timezone":"UTC"}}';
    const found = await readExistingConfig('/x/config.json', reader);
    expect(found.state).toBe('existing');
    if (found.state === 'existing') {
      // D-018's canonical completion: the omitted server section is the
      // spec default, not absent.
      expect(found.config.server).toEqual({ host: '127.0.0.1', port: 8787 });
      expect(found.config.app.timezone).toBe('UTC');
      expect(found.passwordPending).toBe(false);
    }
  });

  it('the §15.1 pending state counts as existing — probed, never wording-matched (D-101)', async () => {
    const reader = async () => '{"app":{"timezone":"UTC"},"server":{"host":"0.0.0.0"}}';
    const found = await readExistingConfig('/x/config.json', reader);
    expect(found.state).toBe('existing');
    if (found.state === 'existing') {
      expect(found.passwordPending).toBe(true);
      expect(found.config.server.host).toBe('0.0.0.0');
      // The probe hash never survives into the configuration init uses.
      expect(found.config.auth.passwordHash).toBeUndefined();
    }
  });

  it('`required` mode without a password is the same pending state', async () => {
    const reader = async () => '{"app":{"timezone":"UTC"},"auth":{"mode":"required"}}';
    const found = await readExistingConfig('/x/config.json', reader);
    expect(found).toMatchObject({ state: 'existing', passwordPending: true });
  });

  it('a stored hash makes the remote bind a regular existing configuration', async () => {
    const reader = async () =>
      '{"app":{"timezone":"UTC"},"server":{"host":"0.0.0.0"},"auth":{"passwordHash":"scrypt$1"}}';
    const found = await readExistingConfig('/x/config.json', reader);
    expect(found).toMatchObject({ state: 'existing', passwordPending: false });
  });

  it('malformed JSON is invalid with the loader’s own problem', async () => {
    const found = await readExistingConfig('/x/config.json', async () => '{not json');
    expect(found.state).toBe('invalid');
    if (found.state === 'invalid') {
      expect(found.problems).toHaveLength(1);
      expect(found.problems[0]).toContain('invalid JSON');
      // V8's message snippet never carries file content into the problem.
      expect(found.problems[0]).not.toContain('not json');
    }
  });

  it('a schema violation is invalid with a field-addressed problem', async () => {
    const found = await readExistingConfig(
      '/x/config.json',
      async () => '{"app":{"timezone":"UTC"},"server":{"port":70000}}',
    );
    expect(found.state).toBe('invalid');
    if (found.state === 'invalid') {
      expect(found.problems.join('\n')).toContain('server.port');
    }
  });

  it('a cross-field violation is invalid (exactly one secret source)', async () => {
    const found = await readExistingConfig(
      '/x/config.json',
      async () =>
        '{"app":{"timezone":"UTC"},"accounts":[{"id":"a","providerId":"zai","label":"x",' +
        '"apiKey":"k","apiKeyEnv":"K"}]}',
    );
    expect(found.state).toBe('invalid');
    if (found.state === 'invalid') {
      expect(found.problems.join('\n')).toContain('mutually exclusive');
    }
  });

  it('an unreadable file is invalid with the errno code, never file content', async () => {
    const reader = async () => {
      throw errnoError('EACCES', 'permission denied');
    };
    const found = await readExistingConfig('/x/config.json', reader);
    expect(found.state).toBe('invalid');
    if (found.state === 'invalid') {
      expect(found.problems[0]).toContain(
        'cannot read the existing configuration file /x/config.json',
      );
      expect(found.problems[0]).toContain('EACCES');
    }
  });

  it('a present-but-malformed password hash is invalid — the probe never repairs it', async () => {
    // Review-round regression (P1 on the first version): the §15.1
    // tolerance masks a hash that is ABSENT, never one that is present and
    // broken — the first probe replaced whatever it found and thereby
    // "repaired" corrupt auth data into the pending state.
    for (const text of [
      '{"app":{"timezone":"UTC"},"auth":{"passwordHash":""}}',
      '{"app":{"timezone":"UTC"},"auth":{"passwordHash":123}}',
      '{"app":{"timezone":"UTC"},"auth":{"passwordHash":null}}',
    ]) {
      const found = await readExistingConfig('/x/config.json', async () => text);
      expect(found.state, text).toBe('invalid');
    }
  });

  it('a non-object auth section is invalid, never pending', async () => {
    // Same regression family: synthesizing `{}` over a non-object `auth`
    // classified arrays, strings, and nulls as the pending state.
    for (const text of [
      '{"app":{"timezone":"UTC"},"auth":[]}',
      '{"app":{"timezone":"UTC"},"auth":"required"}',
      '{"app":{"timezone":"UTC"},"auth":null}',
    ]) {
      const found = await readExistingConfig('/x/config.json', async () => text);
      expect(found.state, text).toBe('invalid');
    }
  });

  it('the probe tolerance still covers exactly the absent-hash states', async () => {
    // `auth` absent entirely and a plain-object `auth` without the hash
    // remain the two shapes the tolerance is defined over.
    for (const text of [
      '{"app":{"timezone":"UTC"},"server":{"host":"0.0.0.0"}}',
      '{"app":{"timezone":"UTC"},"auth":{"mode":"required"}}',
    ]) {
      const found = await readExistingConfig('/x/config.json', async () => text);
      expect(found.state, text).toBe('existing');
      if (found.state === 'existing') expect(found.passwordPending, text).toBe(true);
    }
  });
});

describe('sameDetectionState (the stale-detection guard predicate)', () => {
  it('the fresh state matches only itself', () => {
    expect(sameDetectionState({ state: 'none' }, { state: 'none' })).toBe(true);
    expect(
      sameDetectionState(
        { state: 'none' },
        { state: 'existing', config: EXISTING(), passwordPending: false },
      ),
    ).toBe(false);
    expect(
      sameDetectionState(
        { state: 'existing', config: EXISTING(), passwordPending: false },
        { state: 'none' },
      ),
    ).toBe(false);
  });

  it('existing compares structurally: key order is not data, identity is not required', () => {
    // The same values parsed from a differently ordered file (or a fresh
    // object from a second read) are the same state — consent was given
    // against the values shown, not the bytes.
    const reordered = canonical({
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
      server: { host: '127.0.0.1', port: 9000 },
    });
    expect(
      sameDetectionState(
        { state: 'existing', config: EXISTING(), passwordPending: false },
        { state: 'existing', config: reordered, passwordPending: false },
      ),
    ).toBe(true);
  });

  it('a changed value or a pending flip is a different state', () => {
    const changed = { ...EXISTING(), server: { ...EXISTING().server, port: 4242 } };
    expect(
      sameDetectionState(
        { state: 'existing', config: EXISTING(), passwordPending: false },
        { state: 'existing', config: changed, passwordPending: false },
      ),
    ).toBe(false);
    expect(
      sameDetectionState(
        { state: 'existing', config: EXISTING(), passwordPending: false },
        { state: 'existing', config: EXISTING(), passwordPending: true },
      ),
    ).toBe(false);
  });

  it('a file that became invalid after detection is a different state', () => {
    expect(
      sameDetectionState(
        { state: 'existing', config: EXISTING(), passwordPending: false },
        { state: 'invalid', problems: ['server.port: must be <= 65535'] },
      ),
    ).toBe(false);
    expect(
      sameDetectionState({ state: 'none' }, { state: 'invalid', problems: ['cannot read …'] }),
    ).toBe(false);
    // Two invalid detections compare by their problems (totality — the
    // handler refuses at the first invalid detection and never writes).
    expect(
      sameDetectionState(
        { state: 'invalid', problems: ['a', 'b'] },
        { state: 'invalid', problems: ['a', 'b'] },
      ),
    ).toBe(true);
    expect(
      sameDetectionState(
        { state: 'invalid', problems: ['a'] },
        { state: 'invalid', problems: ['b'] },
      ),
    ).toBe(false);
  });
});

describe('renderExistingSettings / renderUpdateSummary (§5.3 display, §6.3 masking)', () => {
  it('shows where the configuration lives and the four settings', () => {
    const text = renderExistingSettings(EXISTING(), '/tmp/qm/config.json');
    expect(text).toContain('Existing configuration found at /tmp/qm/config.json');
    expect(text).toContain('Time zone:         Europe/Berlin');
    expect(text).toContain('Bind host:         127.0.0.1');
    expect(text).toContain('Port:              9000');
    expect(text).toContain('Polling interval:  120 seconds');
  });

  it('a stored API key is masked to its state — the value never appears', () => {
    const config = canonical({
      app: { timezone: 'UTC' },
      accounts: [{ id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-stored-secret-xyz' }],
    });
    const text = renderExistingSettings(config, '/x/config.json');
    expect(text).toContain("Accounts:          'work' (API key configured, hidden)");
    expect(text).not.toContain('sk-stored-secret-xyz');
  });

  it('an environment-sourced key names the variable only', () => {
    const config = canonical({
      app: { timezone: 'UTC' },
      accounts: [{ id: 'ci', providerId: 'zai', label: 'ci', apiKeyEnv: 'ZAI_KEY' }],
    });
    const text = renderExistingSettings(config, '/x/config.json');
    expect(text).toContain("'ci' (API key from environment variable 'ZAI_KEY')");
  });

  it('a disabled account is labeled disabled; several accounts are listed', () => {
    const config = canonical({
      app: { timezone: 'UTC' },
      accounts: [
        { id: 'a', providerId: 'zai', label: 'work', apiKey: 'sk-x', enabled: false },
        { id: 'b', providerId: 'zai', label: 'home', apiKeyEnv: 'ZAI_HOME' },
      ],
    });
    const text = renderExistingSettings(config, '/x/config.json');
    expect(text).toContain("'work' (disabled, API key configured, hidden);");
    expect(text).toContain("'home' (API key from environment variable 'ZAI_HOME')");
  });

  it('no accounts is stated explicitly', () => {
    expect(renderExistingSettings(EXISTING(), '/x')).toContain(
      'Accounts:          none (managed in the web UI)',
    );
  });

  it('a non-loopback host carries the §5.3 step 4 note while no hash exists; a hash satisfies it', () => {
    const loopback = renderExistingSettings(canonical({ app: { timezone: 'UTC' } }), '/x');
    expect(loopback).not.toContain('requires a password');

    // No hash yet (§15.1 pending, D-101): the note states the requirement.
    const pending = renderExistingSettings(
      pendingConfig({
        timezone: 'UTC',
        host: '0.0.0.0',
        port: 8787,
        pollingIntervalSeconds: 300,
      }),
      '/x',
    );
    expect(pending).toContain('requires a password before the service');
    expect(pending).toContain('quotameter passwd');

    // A stored hash satisfies §15.1 — no note.
    const satisfied = renderExistingSettings(
      canonical({
        app: { timezone: 'UTC' },
        server: { host: '0.0.0.0' },
        auth: { passwordHash: 'scrypt$1' },
      }),
      '/x',
    );
    expect(satisfied).not.toContain('requires a password');
  });

  it('the update block has its own header and the same rows', () => {
    const text = renderUpdateSummary(EXISTING());
    expect(text).toContain('Configuration settings after this run:');
    expect(text).toContain('Port:              9000');
  });
});

describe('renderAccountSummary / passwordRequirementNote', () => {
  it('masking vocabulary per secret source', () => {
    expect(renderAccountSummary({ id: 'a', providerId: 'zai', label: 'x', apiKey: 'sk-1' })).toBe(
      "'x' (API key configured, hidden)",
    );
    expect(
      renderAccountSummary({ id: 'a', providerId: 'zai', label: 'x', apiKeyEnv: 'ZAI_X' }),
    ).toBe("'x' (API key from environment variable 'ZAI_X')");
  });

  it('the note exists exactly for non-loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(passwordRequirementNote(host)).toBeUndefined();
    }
    expect(passwordRequirementNote('0.0.0.0')).toContain('quotameter passwd');
  });
});

describe('assembleInitConfig', () => {
  const ANSWERS: InitAnswers = {
    timezone: 'UTC',
    host: '127.0.0.1',
    port: 8787,
    pollingIntervalSeconds: 300,
  };

  it('fresh: canonical result with defaults completed', () => {
    const assembled = assembleInitConfig(ANSWERS);
    expect(assembled).toMatchObject({ ok: true, passwordPending: false });
    if (assembled.ok) {
      expect(assembled.config.server).toEqual({ host: '127.0.0.1', port: 8787 });
      expect(assembled.config.app).toEqual({
        timezone: 'UTC',
        pollingIntervalSeconds: 300,
        historyRetentionDays: 180,
      });
      expect(assembled.config.accounts).toEqual([]);
      expect(assembled.config.auth.mode).toBe('auto');
    }
  });

  it('re-run: the four settings are replaced, everything else is preserved', () => {
    const base = canonical({
      server: { host: '127.0.0.1', port: 9000 },
      app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 120, historyRetentionDays: 90 },
      logging: { level: 'info' },
      providers: {
        zai: {
          peakHours: {
            timezone: 'UTC',
            windows: [{ id: 'peak', name: 'Peak', days: ['mon'], start: '14:00', end: '18:00' }],
          },
        },
      },
      accounts: [{ id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-keep' }],
    });
    const assembled = assembleInitConfig(
      { ...ANSWERS, port: 9001, pollingIntervalSeconds: 600, timezone: 'Europe/Berlin' },
      base,
    );
    expect(assembled).toMatchObject({ ok: true, passwordPending: false });
    if (assembled.ok) {
      expect(assembled.config.server).toEqual({ host: '127.0.0.1', port: 9001 });
      expect(assembled.config.app.timezone).toBe('Europe/Berlin');
      expect(assembled.config.app.pollingIntervalSeconds).toBe(600);
      // Not asked about ⇒ kept verbatim (enabled materialized by the
      // canonical completion, D-018).
      expect(assembled.config.app.historyRetentionDays).toBe(90);
      expect(assembled.config.logging.level).toBe('info');
      expect(assembled.config.accounts).toEqual([
        { id: 'work', providerId: 'zai', label: 'work', apiKey: 'sk-keep', enabled: true },
      ]);
    }
  });

  it('a remote bind without a password is assembled hash-less and pending (§15.1, D-101)', () => {
    const assembled = assembleInitConfig({ ...ANSWERS, host: '0.0.0.0' });
    expect(assembled).toMatchObject({ ok: true, passwordPending: true });
    if (assembled.ok) {
      expect(assembled.config.server.host).toBe('0.0.0.0');
      expect(assembled.config.auth.passwordHash).toBeUndefined();
    }
  });

  it('a base password hash survives a change to a remote bind — not pending', () => {
    const base = canonical({
      server: { host: '127.0.0.1', port: 8787 },
      app: { timezone: 'UTC' },
      auth: { passwordHash: 'scrypt$1' },
    });
    const assembled = assembleInitConfig({ ...ANSWERS, host: '0.0.0.0' }, base);
    expect(assembled).toMatchObject({ ok: true, passwordPending: false });
    if (assembled.ok) expect(assembled.config.auth.passwordHash).toBe('scrypt$1');
  });

  it('a pending base stays pending through a change that keeps the remote bind', () => {
    const base = pendingConfig({ ...ANSWERS, host: '0.0.0.0', port: 9000 });
    const assembled = assembleInitConfig({ ...ANSWERS, host: '0.0.0.0', port: 9001 }, base);
    expect(assembled).toMatchObject({ ok: true, passwordPending: true });
    if (assembled.ok) {
      expect(assembled.config.server.port).toBe(9001);
      expect(assembled.config.auth.passwordHash).toBeUndefined();
    }
  });

  it('the drift alarm: answers the parsers would reject yield problems, never a write input', () => {
    // InitAnswers is a type, not a runtime guarantee — a future parser/
    // contract drift arrives here as data. The alarm must fire loudly (the
    // §15.1 probe does not mask anything else).
    const bad = assembleInitConfig({ ...ANSWERS, port: 70000 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join('\n')).toContain('server.port');

    const badZone = assembleInitConfig({ ...ANSWERS, timezone: 'Nope/Zone' });
    expect(badZone.ok).toBe(false);
    if (!badZone.ok) expect(badZone.problems.join('\n')).toContain('app.timezone');
  });

  it('fresh run with a stored account: the account joins the configuration (task 133)', () => {
    const assembled = assembleInitConfig(ANSWERS, undefined, {
      id: 'work',
      providerId: 'zai-coding-plan',
      label: 'work',
      enabled: true,
      apiKey: 'sk-stored-by-133',
    });
    expect(assembled).toMatchObject({ ok: true, passwordPending: false });
    if (assembled.ok) {
      expect(assembled.config.accounts).toEqual([
        {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'work',
          enabled: true,
          apiKey: 'sk-stored-by-133',
        },
      ]);
    }
  });

  it('no account leaves the fresh configuration accountless as before', () => {
    const assembled = assembleInitConfig(ANSWERS);
    expect(assembled.ok).toBe(true);
    if (assembled.ok) expect(assembled.config.accounts).toEqual([]);
  });
});

describe('initSettingsChanged', () => {
  it('retained answers are not a change', () => {
    const existing = EXISTING();
    expect(
      initSettingsChanged(existing, {
        timezone: 'Europe/Berlin',
        host: '127.0.0.1',
        port: 9000,
        pollingIntervalSeconds: 120,
      }),
    ).toBe(false);
  });

  it('each of the four settings alone is a change', () => {
    const existing = EXISTING();
    const keep = {
      timezone: 'Europe/Berlin',
      host: '127.0.0.1',
      port: 9000,
      pollingIntervalSeconds: 120,
    } as const;
    expect(initSettingsChanged(existing, { ...keep, timezone: 'UTC' })).toBe(true);
    expect(initSettingsChanged(existing, { ...keep, host: '0.0.0.0' })).toBe(true);
    expect(initSettingsChanged(existing, { ...keep, port: 9001 })).toBe(true);
    expect(initSettingsChanged(existing, { ...keep, pollingIntervalSeconds: 121 })).toBe(true);
  });
});

describe('toInitFailure', () => {
  it('strips the permission refusals’ startup prefix', () => {
    expect(
      toInitFailure(new Error('refusing to start: configuration directory /x is a symbolic link')),
    ).toBe('configuration directory /x is a symbolic link');
  });

  it('leaves every other message verbatim, including embedded occurrences', () => {
    expect(toInitFailure(new Error('Failed to atomically write configuration file /x'))).toBe(
      'Failed to atomically write configuration file /x',
    );
    expect(toInitFailure(new Error('first; then refusing to start: later'))).toBe(
      'first; then refusing to start: later',
    );
  });

  it('non-Error values are stringified', () => {
    expect(toInitFailure(42)).toBe('42');
  });
});
