import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { RELOAD_FIELDS, RESTART_REQUIRED_FIELDS } from '../../src/config/reload';
import {
  SETTINGS_APPLY_FIELDS,
  SETTINGS_RESTART_FIELDS,
  SettingsResponseSchema,
  SettingsViewSchema,
  UpdateSettingsBodySchema,
  UpdateSettingsResponseSchema,
  type SettingsView,
} from '../../src/schemas/api/settings';

/**
 * The §13 settings contract tables (task 160, decision D-130): the closed
 * view (the structural no-secret guard — no `apiKey`, no `passwordHash`,
 * anywhere), the annotated-field grammar, the PUT body's structural-only
 * vocabulary (the refusable declarations included so their refusals are
 * reachable), and the no-drift rows that keep the wire vocabularies
 * identical to D-026's §6.4 classification.
 */

/** A complete, valid settings view — the base every case spreads. */
const VALID_VIEW: SettingsView = {
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
};

describe('SettingsViewSchema (§13/§14.5 safe view)', () => {
  it('accepts the complete view', () => {
    const validate = new Ajv2020().compile(SettingsViewSchema);
    expect(validate(VALID_VIEW)).toBe(true);
  });

  it('accepts the environment marking — the §6.3 read-only form', () => {
    const validate = new Ajv2020().compile(SettingsViewSchema);
    expect(
      validate({
        ...VALID_VIEW,
        app: {
          ...VALID_VIEW.app,
          timezone: { value: 'UTC', source: 'environment', restartRequired: false },
        },
      }),
    ).toBe(true);
  });

  it('rejects secret-bearing and malformed shapes — the closed guard', () => {
    const validate = new Ajv2020().compile(SettingsViewSchema);
    const rejected: unknown[] = [
      { ...VALID_VIEW, auth: { ...VALID_VIEW.auth, passwordHash: 'scrypt$marker' } },
      { ...VALID_VIEW, auth: { ...VALID_VIEW.auth, apiKey: 'sk-marker-secret' } },
      { ...VALID_VIEW, secret: 'sk-marker-secret' },
      { ...VALID_VIEW, accounts: [] },
      { ...VALID_VIEW, providers: {} },
      { ...VALID_VIEW, app: { ...VALID_VIEW.app, timezone: { value: 'UTC' } } },
      {
        ...VALID_VIEW,
        server: {
          ...VALID_VIEW.server,
          port: { value: 8787, source: 'env', restartRequired: true },
        },
      },
      { ...VALID_VIEW, auth: { mode: VALID_VIEW.auth.mode } },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('marks restart exactly on the §6.4 closed list — the no-drift row', () => {
    // The done-condition's identification half, pinned against D-026's own
    // table: the schema's restart flags are a contract fact, so a §6.4
    // classification change must flow through here visibly.
    const flagged: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (
        'restartRequired' in node &&
        typeof (node as { restartRequired: unknown }).restartRequired === 'boolean'
      ) {
        if ((node as { restartRequired: boolean }).restartRequired) flagged.push(path);
        return;
      }
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    };
    walk(VALID_VIEW, '');
    expect(flagged.map((field) => field.replace(/^\./, '')).sort()).toEqual(
      [...RESTART_REQUIRED_FIELDS].sort(),
    );
  });
});

describe('SettingsResponseSchema (the GET envelope)', () => {
  it('accepts the view plus the read-only paths block', () => {
    const validate = new Ajv2020().compile(SettingsResponseSchema);
    expect(
      validate({
        settings: VALID_VIEW,
        paths: {
          configPath: '/home/u/.config/quotameter/config.json',
          dataDir: '/home/u/.local/share/quotameter',
        },
      }),
    ).toBe(true);
    expect(validate({ settings: VALID_VIEW, paths: { configPath: '/x' } })).toBe(false);
    expect(validate({ settings: VALID_VIEW })).toBe(false);
  });
});

describe('UpdateSettingsBodySchema (§13 PUT body, structural only)', () => {
  it('accepts single-section updates and every sanctioned field', () => {
    const validate = new Ajv2020().compile(UpdateSettingsBodySchema);
    const accepted: unknown[] = [
      { app: { timezone: 'UTC' } },
      { app: { pollingIntervalSeconds: 300, historyRetentionDays: 90 } },
      { logging: { level: 'debug' } },
      { auth: { password: 'a-long-password' } },
      { app: { timezone: 'UTC' }, logging: { level: 'info' } },
      // Structural-only by design (D-130): ranges ride validateSettings, so
      // an out-of-range integer passes the schema and fails validation with
      // the parser's field-addressed problem instead.
      { app: { pollingIntervalSeconds: 1 } },
      // Declared so the refusal is reachable with the stable reason.
      { server: { host: '0.0.0.0' } },
      { server: { port: 9999 } },
      { auth: { mode: 'required' } },
      { auth: { passwordHash: 'scrypt$marker' } },
    ];
    for (const value of accepted) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects the empty body, file-only sections, and unknown fields', () => {
    const validate = new Ajv2020().compile(UpdateSettingsBodySchema);
    const rejected: unknown[] = [
      {},
      // §9.2 keeps the schedule file-only; accounts have their own surface.
      { providers: { 'zai-coding-plan': { peakHours: { timezone: 'UTC', windows: [] } } } },
      { accounts: [{ id: 'work', providerId: 'zai-coding-plan', label: 'X', apiKey: 'k' }] },
      { app: { timezone: 'UTC', pollingIntervalSeconds: '300' } },
      { auth: { mode: 'always' } },
      { logging: { level: 'trace' } },
      { server: { host: '127.0.0.1', port: '8787' } },
      { app: { timezone: 'UTC' }, theme: 'dark' },
      [],
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('UpdateSettingsResponseSchema and the §6.4 drift rows', () => {
  it('accepts D-026 vocabulary lists and rejects foreign fields', () => {
    const validate = new Ajv2020().compile(UpdateSettingsResponseSchema);
    expect(validate({ applied: ['app.timezone'], restartRequired: [] })).toBe(true);
    expect(
      validate({
        applied: ['app.timezone', 'auth.passwordHash'],
        restartRequired: ['server.port'],
      }),
    ).toBe(true);
    const rejected: unknown[] = [
      { applied: ['server.port'], restartRequired: [] },
      { applied: [], restartRequired: ['app.timezone'] },
      { applied: ['theme'], restartRequired: [] },
      { applied: [] },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('SETTINGS_APPLY_FIELDS is exactly D-026’s live list', () => {
    const live = RELOAD_FIELDS.filter((spec) => spec.applies === 'live').map((spec) => spec.field);
    expect([...SETTINGS_APPLY_FIELDS].sort()).toEqual([...live].sort());
  });

  it('SETTINGS_RESTART_FIELDS is exactly D-026’s restart list', () => {
    expect([...SETTINGS_RESTART_FIELDS]).toEqual([...RESTART_REQUIRED_FIELDS]);
  });
});
