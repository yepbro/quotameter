import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/schemas/config';
import { parseConfig } from '../../src/config/load';
import { ENV_OVERRIDES } from '../../src/config/env';
import type { EnvironmentSources } from '../../src/config/env';
import {
  attemptedSettingsFields,
  blankAttemptedSettingsFields,
  settingsViewOf,
} from '../../src/server/api/settings';

/**
 * The pure half of task 160's settings composition (decision D-130): how a
 * validated configuration plus its environment marking render as the §14.5
 * annotated view — which fields are restart-required, where the environment
 * marking lands, what the defaults-completion fallbacks read — and which
 * field paths a PUT body attempts. Pinned here so the endpoint suites pin
 * wire behavior only.
 */

/** Builds a validated configuration through the parser (its only sanctioned construction site). */
function validated(input: unknown): Config {
  const parsed = parseConfig(input);
  if (!parsed.ok) throw new Error(`fixture config invalid: ${parsed.problems.join('; ')}`);
  return parsed.value;
}

const NO_ENV: EnvironmentSources = Object.freeze({ fields: [], accountSecrets: [] });

/** A fully materialized base configuration. */
const BASE = validated({
  server: { host: '127.0.0.1', port: 8787 },
  app: { timezone: 'Europe/Berlin', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
  auth: { mode: 'auto' },
  logging: { level: 'warn' },
});

describe('settingsViewOf (§14.5 annotations)', () => {
  it('renders the file-sourced view with §6.4 flags on host/port/mode only', () => {
    const view = settingsViewOf(BASE, NO_ENV);
    expect(view).toEqual({
      server: {
        host: { value: '127.0.0.1', source: 'file', restartRequired: true },
        port: { value: 8787, source: 'file', restartRequired: true },
      },
      app: {
        timezone: { value: 'Europe/Berlin', source: 'file', restartRequired: false },
        pollingIntervalSeconds: { value: 300, source: 'file', restartRequired: false },
        historyRetentionDays: { value: 180, source: 'file', restartRequired: false },
      },
      auth: {
        mode: { value: 'auto', source: 'file', restartRequired: true },
        passwordConfigured: false,
      },
      logging: {
        level: { value: 'warn', source: 'file', restartRequired: false },
      },
    });
  });

  it('marks environment-supplied fields read-only — §6.3 on the wire', () => {
    const sources: EnvironmentSources = {
      fields: ['app.timezone', 'logging.level', 'auth.mode'],
      accountSecrets: [],
    };
    const view = settingsViewOf(BASE, sources);
    expect(view.app.timezone.source).toBe('environment');
    expect(view.logging.level.source).toBe('environment');
    expect(view.auth.mode.source).toBe('environment');
    // Unmarked fields stay file-sourced; the marking never spreads.
    expect(view.app.pollingIntervalSeconds.source).toBe('file');
    expect(view.server.host.source).toBe('file');
    // An environment-marked field keeps its §6.4 class — the two markings
    // are independent facts the UI renders together (§14.5).
    expect(view.auth.mode.restartRequired).toBe(true);
  });

  it('reports the password as configured presence, never the hash', () => {
    const withPassword = validated({
      app: { timezone: 'UTC' },
      auth: { passwordHash: 'scrypt$N=65536,r=8,p=1,keylen=64$c2FsdA$aGFzaA' },
    });
    expect(settingsViewOf(withPassword, NO_ENV).auth.passwordConfigured).toBe(true);
    expect(settingsViewOf(BASE, NO_ENV).auth.passwordConfigured).toBe(false);
  });

  it('reads the spec defaults when the parser-materialized sections are absent', () => {
    // The parser always materializes the optional sections; this pins the
    // fallback for the declared `Config` type's honesty (and covers the
    // defensive arms executably instead of trusting that invariant).
    const sparse = { app: { timezone: 'UTC' } } as unknown as Config;
    const view = settingsViewOf(sparse, NO_ENV);
    expect(view.server.host.value).toBe('127.0.0.1');
    expect(view.server.port.value).toBe(8787);
    expect(view.auth.mode.value).toBe('auto');
    expect(view.logging.level.value).toBe('warn');
    expect(view.app.pollingIntervalSeconds.value).toBe(300);
    expect(view.app.historyRetentionDays.value).toBe(180);
  });
});

describe('attemptedSettingsFields (the refusal candidate set)', () => {
  it('collects attempted paths in canonical order', () => {
    expect(
      attemptedSettingsFields({
        app: { timezone: 'UTC' },
        logging: { level: 'info' },
      }),
    ).toEqual(['app.timezone', 'logging.level']);
    expect(attemptedSettingsFields({ server: { port: 9999 }, auth: { mode: 'auto' } })).toEqual([
      'server.port',
      'auth.mode',
    ]);
  });

  it('never lists the sanctioned password write, and empty sections attempt nothing', () => {
    expect(attemptedSettingsFields({ auth: { password: 'a-long-password' } })).toEqual([]);
    expect(attemptedSettingsFields({ app: {} })).toEqual([]);
    expect(attemptedSettingsFields({ auth: { passwordHash: 'scrypt$marker' } })).toEqual([]);
  });

  it('is exactly the environment-override field set — the no-drift row (review P3)', () => {
    // Every attemptable field is env-overridable and the restart trio is a
    // subset; a body field or an ENV_OVERRIDES row added without the other
    // fails here instead of silently narrowing the PUT refusals.
    expect([...attemptedSettingsFields(ALL_FIELDS_BODY)].sort()).toEqual(
      [...ENV_OVERRIDES].map((spec) => spec.field).sort(),
    );
  });
});

/** A body supplying every attemptable field at once. */
const ALL_FIELDS_BODY = {
  server: { host: '127.0.0.1', port: 8787 },
  app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
  auth: { mode: 'auto' as const },
  logging: { level: 'info' as const },
};

describe('blankAttemptedSettingsFields (the D-011 blank rule, request-side)', () => {
  it('lists every supplied blank-after-trim free-text field', () => {
    expect(
      blankAttemptedSettingsFields({
        app: { timezone: '   ' },
        auth: { password: '   ' },
      }),
    ).toEqual(['app.timezone', 'auth.password']);
    expect(blankAttemptedSettingsFields({ server: { host: ' ' } })).toEqual(['server.host']);
  });

  it('accepts real values and blank-free bodies untouched', () => {
    expect(blankAttemptedSettingsFields(ALL_FIELDS_BODY)).toEqual([]);
    expect(blankAttemptedSettingsFields({ auth: { password: 'a-long-password' } })).toEqual([]);
    // Whitespace inside a value is not a blank value.
    expect(blankAttemptedSettingsFields({ app: { timezone: ' UTC ' } })).toEqual([]);
  });
});
