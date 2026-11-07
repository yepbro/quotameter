import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../../src/schemas/config';
import { LOG_LEVELS as SERVER_LOG_LEVELS } from '../../src/schemas/config';
import { MIN_PASSWORD_LENGTH as SERVER_MIN_PASSWORD_LENGTH } from '../../src/services/config-validation';
import type { ProviderView } from '../../src/schemas/api/providers';
import type { SettingsResponse } from '../../src/schemas/api/settings';
import App from '../../ui/src/App.vue';
import SettingsView from '../../ui/src/views/SettingsView.vue';
import { createAccountSelection } from '../../ui/src/account-selection';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';
import { createAppRouter } from '../../ui/src/router';
import { createSession } from '../../ui/src/session';
import {
  MIN_PASSWORD_LENGTH,
  POLLING_INTERVAL_MAX_SECONDS,
  POLLING_INTERVAL_MIN_SECONDS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  LOG_LEVELS,
} from '../../ui/src/settings-fields';
import { createAppTheme } from '../../ui/src/theme';
import { FakeFetch, jsonResponse, type RecordedCall } from '../helpers/api';
import { FakeThemeMedia, MemoryThemeStorage } from '../helpers/theme';

/**
 * The task-179 done-condition, executable: only the §6.4-permitted
 * settings are editable (and validated), the §14.5 annotations render
 * from the served contract, the password change is write-only with its
 * session consequence stated, the peak schedule renders read-only, and
 * the theme row agrees with the header control (one controller). The
 * page is mounted against a miniature settings backend on the injectable
 * fetch seam (the D-134 hermetic pattern).
 */

/* ── Drift pins: the UI-local vocabulary vs its server counterparts ────── */

describe('the UI-local settings constants (drift pins, D-156)', () => {
  it('mirror the server ranges the D-022 boundary enforces', () => {
    const interval = AppConfigSchema.properties.pollingIntervalSeconds as {
      minimum: number;
      maximum: number;
    };
    const retention = AppConfigSchema.properties.historyRetentionDays as {
      minimum: number;
      maximum: number;
    };
    expect(POLLING_INTERVAL_MIN_SECONDS).toBe(interval.minimum);
    expect(POLLING_INTERVAL_MAX_SECONDS).toBe(interval.maximum);
    expect(RETENTION_MIN_DAYS).toBe(retention.minimum);
    expect(RETENTION_MAX_DAYS).toBe(retention.maximum);
  });

  it('mirrors the server log-level enum and the §15.2 password minimum', () => {
    expect([...LOG_LEVELS]).toEqual([...SERVER_LOG_LEVELS]);
    expect(MIN_PASSWORD_LENGTH).toBe(SERVER_MIN_PASSWORD_LENGTH);
  });
});

/* ── Fixtures ─────────────────────────────────────────────────────────── */

type FieldSource = 'file' | 'environment';

/** Which annotated fields the fixture serves as environment-supplied. */
type EnvironmentField =
  | 'server.host'
  | 'server.port'
  | 'auth.mode'
  | 'app.timezone'
  | 'app.pollingIntervalSeconds'
  | 'app.historyRetentionDays'
  | 'logging.level';

interface SettingsOverrides {
  readonly environment?: ReadonlyArray<EnvironmentField>;
  readonly passwordConfigured?: boolean;
  /** Whether the restart trio carries its §6.4 marker (default true). */
  readonly restartTrio?: boolean;
  /** The applied-retention marker's value (default null — no cleanup yet). */
  readonly appliedRetentionDays?: number | null;
}

function settingsResponse(overrides: SettingsOverrides = {}): SettingsResponse {
  const env = new Set<EnvironmentField>(overrides.environment ?? []);
  const restartTrio = overrides.restartTrio ?? true;
  // Generic over the value so each field's literal type (string, number,
  // or a closed union member) survives into the served shape.
  const annotated = <T extends string | number>(
    value: T,
    source: FieldSource,
    restart: boolean,
  ) => ({
    value,
    source,
    restartRequired: restart,
  });
  return {
    settings: {
      server: {
        host: annotated('127.0.0.1', env.has('server.host') ? 'environment' : 'file', restartTrio),
        port: annotated(8642, env.has('server.port') ? 'environment' : 'file', restartTrio),
      },
      app: {
        timezone: annotated('UTC', env.has('app.timezone') ? 'environment' : 'file', false),
        pollingIntervalSeconds: annotated(
          300,
          env.has('app.pollingIntervalSeconds') ? 'environment' : 'file',
          false,
        ),
        historyRetentionDays: annotated(
          180,
          env.has('app.historyRetentionDays') ? 'environment' : 'file',
          false,
        ),
      },
      auth: {
        mode: annotated('auto', env.has('auth.mode') ? 'environment' : 'file', restartTrio),
        passwordConfigured: overrides.passwordConfigured ?? false,
      },
      logging: {
        level: annotated('warn', env.has('logging.level') ? 'environment' : 'file', false),
      },
    },
    paths: {
      configPath: '/home/op/.config/quotameter/config.json',
      dataDir: '/home/op/.local/share/quotameter',
    },
    appliedRetentionDays: overrides.appliedRetentionDays ?? null,
  };
}

/** The §9.1 documented schedule, as the providers listing serves it. */
const ZAI_SCHEDULE: NonNullable<ProviderView['peakHours']> = {
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  windows: [
    {
      id: 'zai-weekday-peak',
      name: 'Z.ai Coding Plan peak hours',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '14:00',
      end: '18:00',
      multiplier: 1,
    },
  ],
};

const PROVIDERS: ProviderView[] = [
  {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    peakHours: ZAI_SCHEDULE,
    metrics: [{ metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' }],
  },
  {
    id: 'future-provider',
    name: 'Future Provider',
    peakHours: null,
    metrics: [],
  },
];

/** The §13 error-envelope response shape (D-113). */
function envelope(
  status: number,
  code: string,
  details: unknown = null,
): ReturnType<typeof jsonResponse> {
  return jsonResponse(status, { error: { code, message: 'fixture message', details } });
}

/**
 * A miniature settings service: serves the two GETs, applies PUTs to the
 * in-memory settings state (so a reload after save carries the saved
 * truth), and records every dispatch.
 */
class FakeSettingsBackend {
  readonly fake: FakeFetch;
  state: SettingsResponse;
  providers: ProviderView[];
  /** The outcome the next successful PUT answers. */
  putOutcome: { applied: string[]; restartRequired: string[] } = {
    applied: [],
    restartRequired: [],
  };
  /** A one-shot refusal for the next matching call (the error arms). */
  refuseNext: ((call: RecordedCall) => ReturnType<typeof jsonResponse> | undefined) | null = null;
  /** While set, the settings route waits for this promise (the initial-state arm). */
  settingsGate: Promise<void> | null = null;

  constructor(
    settings: SettingsResponse = settingsResponse(),
    providers: ProviderView[] = PROVIDERS,
  ) {
    this.state = settings;
    this.providers = providers;
    this.fake = new FakeFetch((call) => this.answer(call));
  }

  /** The gated settings answer: while `settingsGate` is held, the page's
   * initial load stays pending (the loading-line arm). */
  private async answer(call: RecordedCall): Promise<ReturnType<typeof jsonResponse>> {
    if (call.method === 'GET' && call.input === '/api/settings' && this.settingsGate !== null) {
      await this.settingsGate;
    }
    return this.route(call);
  }

  get impl(): FakeFetch['impl'] {
    return this.fake.impl;
  }

  get calls(): RecordedCall[] {
    return this.fake.calls;
  }

  private route(call: RecordedCall): ReturnType<typeof jsonResponse> {
    const refusal = this.refuseNext?.(call);
    if (refusal !== undefined) {
      this.refuseNext = null;
      return refusal;
    }
    if (call.method === 'GET' && call.input === '/api/settings') {
      return jsonResponse(200, this.state);
    }
    if (call.method === 'GET' && call.input === '/api/providers') {
      return jsonResponse(200, { providers: this.providers });
    }
    if (call.method === 'PUT' && call.input === '/api/settings') {
      const body = JSON.parse(call.body ?? '{}') as {
        app?: { timezone?: string; pollingIntervalSeconds?: number; historyRetentionDays?: number };
        auth?: { password?: string };
        logging?: { level?: string };
      };
      const { settings } = this.state;
      if (body.app?.timezone !== undefined) settings.app.timezone.value = body.app.timezone;
      if (body.app?.pollingIntervalSeconds !== undefined) {
        settings.app.pollingIntervalSeconds.value = body.app.pollingIntervalSeconds;
      }
      if (body.app?.historyRetentionDays !== undefined) {
        settings.app.historyRetentionDays.value = body.app.historyRetentionDays;
      }
      if (body.auth?.password !== undefined) settings.auth.passwordConfigured = true;
      if (body.logging?.level !== undefined) {
        settings.logging.level.value = body.logging.level as 'error' | 'warn' | 'info' | 'debug';
      }
      return jsonResponse(200, this.putOutcome);
    }
    return envelope(404, 'NOT_FOUND');
  }
}

const wrappers: VueWrapper[] = [];

async function mountView(
  backend: FakeSettingsBackend,
  storage: MemoryThemeStorage = new MemoryThemeStorage(),
): Promise<VueWrapper> {
  const theme = createAppTheme({ storage, media: new FakeThemeMedia() });
  const wrapper = mount(SettingsView, {
    attachTo: document.body,
    global: {
      plugins: [createAppI18n(), theme, createApiClientPlugin({ fetchImpl: backend.impl })],
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

/** Drain the async chains (load → mutate → reload) through microtasks. */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

/** The macrotask hop a router navigation needs under happy-dom. */
async function settleNavigation(): Promise<void> {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushPromises();
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

function putsOf(backend: FakeSettingsBackend): RecordedCall[] {
  return backend.calls.filter((call) => call.method === 'PUT' && call.input === '/api/settings');
}

/* ── The read-only surfaces and annotations ───────────────────────────── */

describe('settings page: loads and read-only surfaces (task 179, §14.5)', () => {
  it('renders the loading line while the settings load is in flight — never an error, never a fake page', async () => {
    // The initial-state pin D-138 pinned for the overview only: the page
    // states its loading honestly until the first answer arrives (the
    // suite's settingsGate holds the GET /api/settings answer).
    const backend = new FakeSettingsBackend();
    let releaseSettings!: () => void;
    backend.settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const wrapper = await mountView(backend);

    const loading = wrapper.find('[data-testid="settings-loading"]');
    expect(loading.exists()).toBe(true);
    expect(loading.text()).toBe(en.settings.loading);
    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-facts"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);

    releaseSettings();
    await settle();
    expect(wrapper.find('[data-testid="settings-loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(true);
  });

  it('renders the facts, paths, forms, and schedule from the served view', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    // Both page loads dispatched.
    expect(
      backend.calls
        .filter((call) => call.method === 'GET')
        .map((call) => call.input)
        .sort(),
    ).toEqual(['/api/providers', '/api/settings']);

    const facts = wrapper.find('[data-testid="settings-facts"]');
    expect(facts.text()).toContain('127.0.0.1');
    expect(facts.text()).toContain('8642');
    expect(facts.text()).toContain('auto');
    // §6.4's marker and remedy, verbatim.
    expect(facts.findAll('[data-testid="settings-restart-marker"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="settings-restart-hint"]').text()).toContain(
      'quotameter restart',
    );

    const paths = wrapper.find('[data-testid="settings-paths"]');
    expect(paths.text()).toContain('/home/op/.config/quotameter/config.json');
    expect(paths.text()).toContain('/home/op/.local/share/quotameter');

    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="settings-password"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="settings-theme-row"]').exists()).toBe(true);
  });

  it('the restart markers are consumed from the served flags, not assumed', async () => {
    // The false direction: a served restartRequired of false renders no
    // marker — the annotation is the contract's own (D-023), never a
    // page-side constant (the real endpoint always serves true for the
    // trio today; this pin keeps the consuming v-if honest).
    const backend = new FakeSettingsBackend(settingsResponse({ restartTrio: false }));
    const wrapper = await mountView(backend);

    expect(wrapper.findAll('[data-testid="settings-restart-marker"]')).toHaveLength(0);
  });

  it('a failed settings load renders the notice and retry, never a fake page', async () => {
    const backend = new FakeSettingsBackend();
    backend.refuseNext = (call) => (call.method === 'GET' ? envelope(500, 'INTERNAL') : undefined);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    expect(wrapper.find('[data-testid="settings-retry"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(false);

    backend.refuseNext = null;
    await wrapper.find('[data-testid="settings-retry"]').trigger('click');
    await settle();
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(true);
  });

  it('a failed providers load degrades the schedule section alone', async () => {
    const backend = new FakeSettingsBackend();
    backend.refuseNext = (call) =>
      call.input === '/api/providers' ? envelope(500, 'INTERNAL') : undefined;
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.internal);
    expect(wrapper.find('[data-testid="settings-schedule"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-general"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="settings-paths"]').exists()).toBe(true);
  });
});

describe('the editability matrix (only §6.4-permitted settings editable)', () => {
  it('the restart trio renders values with no edit controls', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const facts = wrapper.find('[data-testid="settings-facts"]');
    expect(factsHaveNoControls(facts.element)).toBe(true);
  });

  it('environment-supplied fields render disabled with the annotation', async () => {
    const backend = new FakeSettingsBackend(
      settingsResponse({
        environment: [
          'app.timezone',
          'app.pollingIntervalSeconds',
          'app.historyRetentionDays',
          'logging.level',
          'server.port',
        ],
      }),
    );
    const wrapper = await mountView(backend);

    for (const testid of [
      'settings-timezone',
      'settings-interval',
      'settings-retention',
      'settings-level',
    ]) {
      expect(
        wrapper.find(`[data-testid="${testid}"]`).attributes('disabled'),
        `${testid} is environment-supplied`,
      ).toBeDefined();
    }
    // One annotation per env-supplied editable field, and one on the port
    // fact row — never on file-sourced fields.
    expect(
      wrapper.find('[data-testid="settings-general"]').findAll('[data-testid="settings-env-note"]'),
    ).toHaveLength(4);
    expect(
      wrapper
        .find('[data-testid="settings-port"]')
        .find('[data-testid="settings-env-marker"]')
        .exists(),
    ).toBe(true);
    expect(
      wrapper
        .find('[data-testid="settings-host"]')
        .find('[data-testid="settings-env-marker"]')
        .exists(),
    ).toBe(false);
  });

  it('file-sourced fields render enabled with no annotations', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    for (const testid of [
      'settings-timezone',
      'settings-interval',
      'settings-retention',
      'settings-level',
    ]) {
      expect(wrapper.find(`[data-testid="${testid}"]`).attributes('disabled')).toBeUndefined();
    }
    expect(
      wrapper.find('[data-testid="settings-general"]').findAll('[data-testid="settings-env-note"]'),
    ).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="settings-env-marker"]')).toHaveLength(0);
  });
});

/** The facts section must contain no form controls (read-only by shape). */
function factsHaveNoControls(root: Element): boolean {
  return root.querySelectorAll('input, select, textarea, button').length === 0;
}

/* ── Field validation ─────────────────────────────────────────────────── */

describe('settings page: field validation (client guards before requests)', () => {
  it.each(['', 'abc', '60.5', '59', '3601', '-60'])(
    'an invalid interval (%s) renders the field error and dispatches nothing',
    async (value) => {
      const backend = new FakeSettingsBackend();
      const wrapper = await mountView(backend);

      await wrapper.find('[data-testid="settings-interval"]').setValue(value);
      await wrapper.find('[data-testid="settings-save"]').trigger('submit');
      await settle();

      const errors = wrapper.find('[data-testid="settings-general"]').findAll('.field-error');
      expect(errors.map((error) => error.text())).toContain(
        'Enter a whole number between 60 and 3600.',
      );
      expect(putsOf(backend)).toHaveLength(0);
    },
  );

  it.each(['', 'abc', '6', '3651'])(
    'an invalid retention (%s) renders the field error and dispatches nothing',
    async (value) => {
      const backend = new FakeSettingsBackend();
      const wrapper = await mountView(backend);

      await wrapper.find('[data-testid="settings-retention"]').setValue(value);
      await wrapper.find('[data-testid="settings-save"]').trigger('submit');
      await settle();

      const errors = wrapper.find('[data-testid="settings-general"]').findAll('.field-error');
      expect(errors.map((error) => error.text())).toContain(
        'Enter a whole number between 7 and 3650.',
      );
      expect(putsOf(backend)).toHaveLength(0);
    },
  );

  it.each([
    ['', 'A display time zone is required.'],
    ['   ', 'A display time zone is required.'],
    ['Not/AZone', 'Enter a valid IANA time-zone name.'],
  ])('an invalid zone (%s) renders %s and dispatches nothing', async (value, message) => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-timezone"]').setValue(value);
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    const errors = wrapper.find('[data-testid="settings-general"]').findAll('.field-error');
    expect(errors.map((error) => error.text())).toContain(message);
    expect(putsOf(backend)).toHaveLength(0);
  });

  it('the invalid inputs carry aria-invalid', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('59');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    expect(
      wrapper.find('[data-testid="settings-interval"]').attributes('aria-invalid'),
    ).toBeDefined();
  });

  it('the save button stays disabled without changes', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="settings-save"]').attributes('disabled')).toBeDefined();
  });

  it.each(['60', '3600'])(
    'the interval boundary %s is accepted (inclusive edges)',
    async (value) => {
      const backend = new FakeSettingsBackend();
      const wrapper = await mountView(backend);

      await wrapper.find('[data-testid="settings-interval"]').setValue(value);
      await wrapper.find('[data-testid="settings-save"]').trigger('submit');
      await settle();

      expect(putsOf(backend)).toHaveLength(1);
      expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
        app: { pollingIntervalSeconds: Number(value) },
      });
      // An inclusive accept renders no field error.
      expect(wrapper.find('[data-testid="settings-general"]').findAll('.field-error')).toHaveLength(
        0,
      );
    },
  );

  it.each(['7', '3650'])(
    'the retention boundary %s is accepted (inclusive edges)',
    async (value) => {
      const backend = new FakeSettingsBackend();
      const wrapper = await mountView(backend);

      await wrapper.find('[data-testid="settings-retention"]').setValue(value);
      await wrapper.find('[data-testid="settings-save"]').trigger('submit');
      await settle();

      expect(putsOf(backend)).toHaveLength(1);
      expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
        app: { historyRetentionDays: Number(value) },
      });
      expect(wrapper.find('[data-testid="settings-general"]').findAll('.field-error')).toHaveLength(
        0,
      );
    },
  );

  it('warns per §11.3 while a drafted retention is below the applied window', async () => {
    // The reduce-retention warning (U-053, D-178): the applied window the
    // last completed cleanup wrote is 180; a drafted 30 means the records
    // between the two windows go at the NEXT cleanup. The warning is
    // advisory — the save still dispatches.
    const backend = new FakeSettingsBackend(settingsResponse({ appliedRetentionDays: 180 }));
    const wrapper = await mountView(backend);

    const warning = () => wrapper.find('[data-testid="settings-retention-warning"]');
    expect(warning().exists(), 'no warning before the draft changes').toBe(false);

    await wrapper.find('[data-testid="settings-retention"]').setValue('30');
    await settle();
    expect(warning().exists()).toBe(true);
    expect(warning().text()).toBe(
      en.settings.general.retentionReduceWarning.replace('{days}', '30'),
    );

    // Raising the draft back to the applied window clears the warning.
    await wrapper.find('[data-testid="settings-retention"]').setValue('180');
    await settle();
    expect(warning().exists()).toBe(false);

    // Advisory, not blocking: a save with the reduced window dispatches.
    await wrapper.find('[data-testid="settings-retention"]').setValue('30');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(putsOf(backend)).toHaveLength(1);
    expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
      app: { historyRetentionDays: 30 },
    });
  });

  it('an already-reduced configuration warns on load, and a completed cleanup clears it', async () => {
    // The warning is about the PENDING deletion, not the edit action: a
    // configured window (30) below the applied one (180) warns before any
    // edit, and once the next cleanup rewrites the marker to the new
    // window (the post-save reload serving 30), the warning self-clears.
    const body = settingsResponse({ appliedRetentionDays: 180 });
    body.settings.app.historyRetentionDays.value = 30;
    const backend = new FakeSettingsBackend(body);
    const wrapper = await mountView(backend);

    const warning = () => wrapper.find('[data-testid="settings-retention-warning"]');
    expect(warning().exists(), 'the unchanged-but-reduced draft warns').toBe(true);

    await wrapper.find('[data-testid="settings-level"]').setValue('info');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    // The cleanup ran between the save and the reload: the served marker
    // is now 30 — the drafts adopt it and the warning is gone.
    backend.state.appliedRetentionDays = 30;
    await settle();
    expect(warning().exists()).toBe(false);
  });

  it('no applied window yet (null marker) or an invalid draft renders no warning', async () => {
    // Null is the fresh-database/failed-cleanup arm: nothing to compare
    // against, so lowering the draft is just an edit.
    const backend = new FakeSettingsBackend(settingsResponse({ appliedRetentionDays: null }));
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-retention"]').setValue('30');
    await settle();
    expect(wrapper.find('[data-testid="settings-retention-warning"]').exists()).toBe(false);

    // An out-of-range draft keeps the range error alone — the warning is
    // about a deletable window, and an invalid draft names none.
    const applied = new FakeSettingsBackend(settingsResponse({ appliedRetentionDays: 180 }));
    const appliedWrapper = await mountView(applied);
    await appliedWrapper.find('[data-testid="settings-retention"]').setValue('5');
    await appliedWrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(appliedWrapper.find('[data-testid="settings-retention-warning"]').exists()).toBe(false);
    expect(
      appliedWrapper.find('[data-testid="settings-general"]').findAll('.field-error'),
    ).toHaveLength(1);
  });

  it('a served zone this browser cannot confirm never blocks an unrelated save', async () => {
    // The review round's P2: the guards own the operator's edits alone —
    // a served value the browser's Intl disputes (ICU skew against the
    // server's Node, or an environment-supplied zone) is not being sent,
    // so it must not refuse a save that changes only the log level.
    const body = settingsResponse();
    // A zone no current ICU knows: server-valid in the fixture's world,
    // browser-invalid by construction.
    body.settings.app.timezone.value = 'Mars/Olympus_Mons';
    const backend = new FakeSettingsBackend(body);
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-level"]').setValue('info');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({ logging: { level: 'info' } });
    expect(wrapper.find('[data-testid="settings-general"]').findAll('.field-error')).toHaveLength(
      0,
    );
  });

  it('a picked suggestion clears a stale zone error', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-timezone"]').setValue('Not/AZone');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(
      wrapper.find('[data-testid="settings-timezone"]').attributes('aria-invalid'),
    ).toBeDefined();

    await wrapper.find('[data-testid="settings-timezone"]').setValue('Singapore');
    await wrapper.findAll('[data-testid="settings-timezone-option"]')[0]!.trigger('click');
    expect(
      wrapper.find('[data-testid="settings-timezone"]').attributes('aria-invalid'),
    ).toBeUndefined();
    expect(wrapper.find('[data-testid="settings-general"]').findAll('.field-error')).toHaveLength(
      0,
    );
  });

  it('a refused submit keeps a still-true pending-restart notice', async () => {
    const backend = new FakeSettingsBackend();
    backend.putOutcome = {
      applied: ['app.pollingIntervalSeconds'],
      restartRequired: ['server.port'],
    };
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('600');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(wrapper.find('[data-testid="settings-restart-pending"]').exists()).toBe(true);

    // The next submit is refused client-side (an invalid retention) —
    // the restart fact from the previous save is still true and stays.
    await wrapper.find('[data-testid="settings-retention"]').setValue('6');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(wrapper.find('[data-testid="settings-restart-pending"]').exists()).toBe(true);
  });
});

/* ── The time-zone suggestion keyboard semantics (task 181, D-164) ─────── */

describe('settings page: the time-zone suggestion keyboard semantics (task 181)', () => {
  it('the field announces the search affordance and controls the suggestion list', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    // The linkage (ARIA 1.2-clean: a plain textbox may not carry
    // aria-expanded — that is the combobox contract D-156 declined): the
    // hint's id describes the field (the search affordance is announced
    // before anything is typed), and an aria-controls reference renders
    // only beside a rendered list — axe rejects dangling ids.
    expect(field.attributes('aria-describedby')).toBe('settings-timezone-hint');
    expect(wrapper.find('#settings-timezone-hint').exists()).toBe(true);
    expect(field.attributes('aria-autocomplete')).toBe('list');
    expect(field.attributes('aria-controls')).toBeUndefined();
    expect(wrapper.find('#settings-timezone-suggestions').exists()).toBe(false);

    await field.setValue('Singapore');
    const list = wrapper.find('[data-testid="settings-timezone-suggestions"]');
    expect(list.exists()).toBe(true);
    expect(list.attributes('aria-label')).toBe('Matching time zones');
    expect(field.attributes('aria-controls')).toBe('settings-timezone-suggestions');
    // The controlled id resolves to the rendered list.
    expect(wrapper.find('#settings-timezone-suggestions').element).toBe(list.element);
  });

  it('ArrowDown hands focus to the first suggestion; Escape from the list reverts and refocuses', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    await field.setValue('Singapore');
    await field.trigger('keydown', { key: 'ArrowDown' });
    const options = wrapper.findAll('[data-testid="settings-timezone-option"]');
    expect(options.length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(options[0]!.element);

    await options[0]!.trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);
    expect(document.activeElement).toBe(field.element);
    // The abandoned edit reverted to the served truth.
    expect((field.element as HTMLInputElement).value).toBe('UTC');
  });

  it('Escape in the field reverts the edit, collapses the list, and clears the stale error', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    await field.setValue('Not/AZone');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(field.attributes('aria-invalid')).toBeDefined();

    await field.setValue('Singapore');
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(true);
    await field.trigger('keydown', { key: 'Escape' });
    await settle();
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);
    expect((field.element as HTMLInputElement).value).toBe('UTC');
    expect(field.attributes('aria-invalid')).toBeUndefined();
  });

  it('ArrowDown without suggestions leaves the caret and focus alone', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    await field.setValue('Not/AZone');
    // Focus the field the way a keyboard user would have it (VTU's
    // trigger does not focus) — the no-op must not move it.
    (field.element as HTMLInputElement).focus();
    await field.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);
    expect(document.activeElement).toBe(field.element);
  });

  it('a picked suggestion returns focus to the field (task 181)', async () => {
    // The picked button unmounts with the collapsing list — without the
    // hand-off, keyboard focus falls to the body (the review round's P1).
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    await field.setValue('Singapore');
    const options = wrapper.findAll('[data-testid="settings-timezone-option"]');
    expect(options.length).toBeGreaterThan(0);
    (options[0]!.element as HTMLElement).focus();
    await options[0]!.trigger('click');
    await settle();

    expect((field.element as HTMLInputElement).value).toBe('Asia/Singapore');
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);
    expect(document.activeElement).toBe(field.element);
  });

  it('an IME composition Escape does not revert the edit', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-timezone"]');
    await field.setValue('Singapore');
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(true);
    await field.trigger('keydown', { key: 'Escape', isComposing: true });
    await settle();
    // The composition owns the key press: the draft and list survive.
    expect((field.element as HTMLInputElement).value).toBe('Singapore');
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(true);
  });
});

/* ── The save flow: minimal attempted writes and outcomes ─────────────── */

describe('settings page: the save flow (D-130/D-140 minimal writes)', () => {
  it('sends exactly the changed field', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('600');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    const puts = putsOf(backend);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body ?? '{}')).toEqual({ app: { pollingIntervalSeconds: 600 } });
  });

  it('sends each field alone and together', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-level"]').setValue('info');
    await wrapper.find('[data-testid="settings-retention"]').setValue('30');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
      app: { historyRetentionDays: 30 },
      logging: { level: 'info' },
    });
  });

  it('the time-zone search narrows and applies a picked zone', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-timezone"]').setValue('Singapore');
    const options = wrapper.findAll('[data-testid="settings-timezone-option"]');
    expect(options.map((option) => option.text())).toContain('Asia/Singapore');

    await options.find((option) => option.text() === 'Asia/Singapore')!.trigger('click');
    expect(
      (wrapper.find('[data-testid="settings-timezone"]').element as HTMLInputElement).value,
    ).toBe('Asia/Singapore');
    // The exact match collapses the suggestion list.
    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);

    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
      app: { timezone: 'Asia/Singapore' },
    });
  });

  it('a fully typed tzdb primary suggests its listed canonical twin', async () => {
    // The engine's list carries CLDR-canonical names: 'Asia/Kolkata' is
    // not listed, but it is valid and resolves to listed 'Asia/Calcutta'
    // — the search must surface the twin (D-156).
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-timezone"]').setValue('Asia/Kolkata');
    const options = wrapper.findAll('[data-testid="settings-timezone-option"]');
    expect(options.map((option) => option.text())).toEqual(['Asia/Calcutta']);

    await options[0]!.trigger('click');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();
    expect(JSON.parse(putsOf(backend)[0]!.body ?? '{}')).toEqual({
      app: { timezone: 'Asia/Calcutta' },
    });
  });

  it('an untouched zone shows no suggestions', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="settings-timezone-suggestions"]').exists()).toBe(false);
  });

  it('a successful save states it, reloads the served truth, and re-adopts', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('600');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="settings-saved"]').text()).toBe('Settings saved.');
    // The parent reloaded the served truth (two GETs) and the draft
    // adopted it (the backend applies the PUT).
    expect(
      backend.calls.filter((call) => call.method === 'GET' && call.input === '/api/settings'),
    ).toHaveLength(2);
    expect(
      (wrapper.find('[data-testid="settings-interval"]').element as HTMLInputElement).value,
    ).toBe('600');
    // An empty restartRequired outcome renders no restart notice.
    expect(wrapper.find('[data-testid="settings-restart-pending"]').exists()).toBe(false);
  });

  it('a pending-restart outcome names the fields with the remedy', async () => {
    const backend = new FakeSettingsBackend();
    backend.putOutcome = {
      applied: ['app.pollingIntervalSeconds'],
      restartRequired: ['server.port'],
    };
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('600');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    const notice = wrapper.find('[data-testid="settings-restart-pending"]');
    expect(notice.text()).toContain('Port');
    expect(notice.text()).toContain('quotameter restart');
  });

  it('a refused save presents through the shared notice and keeps the drafts', async () => {
    const backend = new FakeSettingsBackend();
    backend.refuseNext = (call) =>
      call.method === 'PUT'
        ? envelope(403, 'FORBIDDEN', { reason: 'environment-overridden-read-only' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-interval"]').setValue('600');
    await wrapper.find('[data-testid="settings-save"]').trigger('submit');
    await settle();

    const notice = wrapper.find('[data-testid="api-error"]');
    expect(notice.text()).toBe(en.errors.codes.forbidden);
    expect(notice.attributes('data-error-code')).toBe('FORBIDDEN');
    // The operator's edit survives the refusal.
    expect(
      (wrapper.find('[data-testid="settings-interval"]').element as HTMLInputElement).value,
    ).toBe('600');
    expect(wrapper.find('[data-testid="settings-saved"]').exists()).toBe(false);
  });
});

/* ── The password change ──────────────────────────────────────────────── */

describe('settings page: the password change (§15.2, D-124/D-126)', () => {
  it('states the configured fact and the consequence before any input', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="settings-password-configured"]').text()).toBe(
      'No password is set.',
    );
    expect(wrapper.find('[data-testid="settings-password"]').text()).toContain(
      'signs out every session, including this one',
    );
  });

  it('states the configured fact when a password exists', async () => {
    const backend = new FakeSettingsBackend(settingsResponse({ passwordConfigured: true }));
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="settings-password-configured"]').text()).toBe(
      'A password is set.',
    );
  });

  it('the field is write-only: masked, never prefilled', async () => {
    const backend = new FakeSettingsBackend(settingsResponse({ passwordConfigured: true }));
    const wrapper = await mountView(backend);

    const field = wrapper.find('[data-testid="settings-password-input"]');
    expect(field.attributes('type')).toBe('password');
    expect(field.attributes('autocomplete')).toBe('new-password');
    expect((field.element as HTMLInputElement).value).toBe('');
  });

  it('a short password renders the field error and dispatches nothing', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    // 'elevenchars' — 11 characters, one under the §15.2 minimum.
    await wrapper.find('[data-testid="settings-password-input"]').setValue('elevenchars');
    await wrapper.find('[data-testid="settings-password-submit"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="settings-password"]').find('.field-error').text()).toBe(
      'The password must be at least 12 characters.',
    );
    expect(putsOf(backend)).toHaveLength(0);
    // A client-guard refusal keeps the typed value — the operator fixes
    // the input, it is not a dispatched attempt (the accounts form's
    // rule); clearing happens after every DISPATCHED attempt, pinned by
    // the success and server-refusal cases below.
    expect(
      (wrapper.find('[data-testid="settings-password-input"]').element as HTMLInputElement).value,
    ).toBe('elevenchars');
  });

  it('a whitespace-only password is never a value (D-011)', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-password-input"]').setValue('            ');
    await wrapper.find('[data-testid="settings-password-submit"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="settings-password"]').find('.field-error').exists()).toBe(
      true,
    );
    expect(putsOf(backend)).toHaveLength(0);
  });

  it('an exactly-12-character password is accepted (the inclusive boundary)', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    // 'abcdefghijkl' — exactly the §15.2 minimum.
    await wrapper.find('[data-testid="settings-password-input"]').setValue('abcdefghijkl');
    await wrapper.find('[data-testid="settings-password-submit"]').trigger('submit');
    await settle();

    expect(putsOf(backend)).toHaveLength(1);
    expect(wrapper.find('[data-testid="settings-password"]').find('.field-error').exists()).toBe(
      false,
    );
  });

  it('a valid password PUTs the password alone, clears the field, and states the consequence', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-password-input"]').setValue('a-fine-new-password');
    await wrapper.find('[data-testid="settings-password-submit"]').trigger('submit');
    await settle();

    const puts = putsOf(backend);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body ?? '{}')).toEqual({
      auth: { password: 'a-fine-new-password' },
    });
    expect(
      (wrapper.find('[data-testid="settings-password-input"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(wrapper.find('[data-testid="settings-password-changed"]').text()).toContain(
      'All sessions were revoked',
    );
    // The configured fact flipped with the change — the success notice
    // must not sit beside a stale "No password is set." (review P1).
    expect(wrapper.find('[data-testid="settings-password-configured"]').text()).toBe(
      'A password is set.',
    );
    // The typed password appears nowhere in the rendered output.
    expect(wrapper.text()).not.toContain('a-fine-new-password');
  });

  it('a refused change clears the field beside the notice', async () => {
    const backend = new FakeSettingsBackend();
    backend.refuseNext = (call) =>
      call.method === 'PUT'
        ? envelope(400, 'VALIDATION', { reason: 'invalid-settings' })
        : undefined;
    const wrapper = await mountView(backend);

    await wrapper.find('[data-testid="settings-password-input"]').setValue('a-fine-new-password');
    await wrapper.find('[data-testid="settings-password-submit"]').trigger('submit');
    await settle();

    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.validation);
    expect(
      (wrapper.find('[data-testid="settings-password-input"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(wrapper.find('[data-testid="settings-password-changed"]').exists()).toBe(false);
  });
});

/* ── The read-only peak schedule ──────────────────────────────────────── */

describe('settings page: the read-only peak schedule (§9.2)', () => {
  it('renders the §9.1 schedule as data in its own zone', async () => {
    const backend = new FakeSettingsBackend();
    const wrapper = await mountView(backend);

    const section = wrapper.find('[data-testid="settings-schedule"]');
    expect(section.find('h4').text()).toBe('Z.ai Coding Plan');
    expect(section.text()).toContain('Asia/Singapore');
    expect(section.text()).toContain('×0.5');

    const rows = section.findAll('[data-testid="settings-schedule-window"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('Z.ai Coding Plan peak hours');
    expect(rows[0]!.text()).toContain('mon, tue, wed, thu, fri');
    expect(rows[0]!.text()).toContain('14:00–18:00');
    expect(rows[0]!.text()).toContain('×1');
    // No edit controls anywhere in the section.
    expect(section.findAll('input, select, textarea, button')).toHaveLength(0);
  });

  it('a provider without a schedule states §9.2’s sentence, never an invented one', async () => {
    const backend = new FakeSettingsBackend(settingsResponse(), [
      { id: 'future-provider', name: 'Future Provider', peakHours: null, metrics: [] },
      {
        id: 'unverified-provider',
        name: 'Unverified Provider',
        peakHours: { timezone: 'UTC', windows: [] },
        metrics: [],
      },
    ]);
    const wrapper = await mountView(backend);

    const emptyStates = wrapper.findAll('[data-testid="settings-schedule-empty"]');
    expect(emptyStates).toHaveLength(2);
    for (const state of emptyStates) {
      expect(state.text()).toBe('Peak-hours schedule is not configured.');
    }
    expect(wrapper.find('[data-testid="settings-schedule"]').findAll('table')).toHaveLength(0);
  });

  it('a registry-empty build states the honest absence', async () => {
    const backend = new FakeSettingsBackend(settingsResponse(), []);
    const wrapper = await mountView(backend);

    expect(wrapper.find('[data-testid="settings-schedule-none"]').text()).toBe(
      'No provider is available in this build.',
    );
  });
});

/* ── The theme row: one controller with the header select ─────────────── */

describe('settings page: the theme row agrees with the header control (D-133)', () => {
  async function mountShell(
    backend: FakeSettingsBackend,
    storage: MemoryThemeStorage,
  ): Promise<VueWrapper> {
    const router = createAppRouter(createMemoryHistory());
    await router.push('/settings');
    await router.isReady();
    const theme = createAppTheme({ storage, media: new FakeThemeMedia() });
    const selection = createAccountSelection({ storage: new MemoryThemeStorage() });
    // Task 180: the shell's sign-out control consumes the session store
    // (the composition root installs it; every shell mount does the same).
    const session = createSession();
    const wrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [
          router,
          createAppI18n(),
          theme,
          selection,
          session,
          createApiClientPlugin({ fetchImpl: backend.impl }),
        ],
      },
    });
    wrappers.push(wrapper);
    await settleNavigation();
    return wrapper;
  }

  it('the settings select flips the same controller the header reads', async () => {
    const storage = new MemoryThemeStorage();
    const wrapper = await mountShell(new FakeSettingsBackend(), storage);

    // Both controls start at the controller's value.
    expect(
      (wrapper.find('[data-testid="settings-theme"]').element as HTMLSelectElement).value,
    ).toBe('system');
    expect((wrapper.find('[data-testid="theme-select"]').element as HTMLSelectElement).value).toBe(
      'system',
    );

    await wrapper.find('[data-testid="settings-theme"]').setValue('dark');
    await settle();

    // The header select follows, the attribute flips, and the choice
    // persists through the shared controller's storage.
    expect((wrapper.find('[data-testid="theme-select"]').element as HTMLSelectElement).value).toBe(
      'dark',
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(storage.getItem('quotameter.theme')).toBe('dark');
  });

  it('a header flip reaches the settings select', async () => {
    const wrapper = await mountShell(new FakeSettingsBackend(), new MemoryThemeStorage());

    await wrapper.find('[data-testid="theme-select"]').setValue('light');
    await settle();

    expect(
      (wrapper.find('[data-testid="settings-theme"]').element as HTMLSelectElement).value,
    ).toBe('light');
  });
});
