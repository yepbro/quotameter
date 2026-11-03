import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  SWEEP_NOW,
  expectMaskedKey,
  failedCycle,
  readConfigJson,
  seedCycles,
  startComposedApi,
  successfulCycle,
  sweepIso,
  withComposedApi,
  type ComposedApi,
  type StartedComposedApi,
  type SweepResponse,
} from '../helpers/composedApi';

/**
 * Task 164's cross-endpoint secret-masking sweep (§15.4, §17.1's
 * marker-secret scenario): THREE distinct key markers — the file-stored
 * API key of the seed account, the history account's key, and a key
 * created through the API — plus a password submitted through the
 * settings PUT, are all present in the persisted state of ONE production
 * composition (a real temp `config.json` and a real migrated
 * `node:sqlite` database), and the history key additionally sits EMBEDDED
 * in the stored provider-sourced text (the plan name and a failed run's
 * error message — §7.4's contract-violating-provider residual). Every
 * response that echoes stored data is then scanned for all of them: the
 * eight read endpoints, the connection-test outcome, and the error
 * envelopes, plus every log line — with the embedded-key text asserted
 * to arrive REDACTED, not dropped. (Two further markers live in their
 * OWN lifecycles: a wire-created key in a dedicated rotation test, and
 * an env-resolved key — so the shared lifecycle stays read-only and
 * order-independent.) The per-family suites pin their own routes'
 * masking; this sweep proves the discipline holds across the whole
 * surface AT ONCE, over the production construction (D-140), with the
 * startup keys registered as the logger's known secret values exactly as
 * the production construction would (the harness mirrors the
 * registration because it must inject a sink-capturing logger).
 *
 * Two exclusions, recorded: the accounts surface's `planName` field is
 * `null` by construction in this composition (no `src/` writer populates
 * the row's `plan_name` today; when the polling composition lands one,
 * the §7.4 redaction must join it or the embedded-key scan extends
 * there — noted for that task), and the password's POSITIVE control is
 * the stored scrypt hash (the plaintext never persists anywhere — its
 * absence from the file is itself the pin).
 */

/** The §15.4 markers — none may ever reach a response body or a log line. */
const MARKER_FILE_KEY = 'sk-sweep-secrets-file-6b19d4';
const MARKER_WIRE_KEY = 'sk-sweep-secrets-wire-2ac8e5';
const MARKER_PASSWORD = 'marker-password-sweep-7f3a9c';
const MARKER_HIST_KEY = 'sk-sweep-secrets-hist-8e30fb';

/**
 * Provider-sourced stored text with the account's own key embedded — the
 * §7.4 contract-violating-provider residual: server-side redaction must
 * replace the exact occurrence wherever the text rides the wire.
 */
const MARKER_ERROR = `upstream failed after bearer ${MARKER_HIST_KEY}`;
const MARKER_PLAN = `Team Ultra (${MARKER_HIST_KEY})`;

/** All key markers, for the sweeps that scan for every one of them. */
const ALL_MARKERS = [MARKER_FILE_KEY, MARKER_WIRE_KEY, MARKER_PASSWORD, MARKER_HIST_KEY];

/** The account whose §11.2 history carries the plan and error markers. */
const HIST = 'hist';

let api: ComposedApi;
let teardown: StartedComposedApi | undefined;

beforeAll(async () => {
  teardown = await startComposedApi({
    config: {
      app: { timezone: 'UTC' },
      accounts: [
        {
          id: 'seed',
          providerId: 'zai-coding-plan',
          label: 'Seed account',
          apiKey: MARKER_FILE_KEY,
        },
        {
          id: HIST,
          providerId: 'zai-coding-plan',
          label: 'History account',
          apiKey: MARKER_HIST_KEY,
        },
      ],
    },
    seed: (repository) => {
      seedCycles(repository, [
        successfulCycle(HIST, SWEEP_NOW - DAY_MS, { planName: MARKER_PLAN }),
        failedCycle(HIST, SWEEP_NOW - DAY_MS + 300_000, MARKER_ERROR),
      ]);
    },
  });
  api = teardown;

  // A marker key entering through the wire (the write-only channel) and
  // a marker password entering through the settings PUT — both stored
  // before any sweep reads, so every test sees the same state.
  const created = await api.call('POST', '/api/accounts', {
    providerId: 'zai-coding-plan',
    label: 'Wire-keyed account',
    id: 'wire',
    apiKey: MARKER_WIRE_KEY,
  });
  expect(created.statusCode).toBe(201);
  const applied = await api.call('PUT', '/api/settings', { auth: { password: MARKER_PASSWORD } });
  expect(applied.statusCode).toBe(200);
}, 30_000);

afterAll(async () => {
  await teardown?.stop();
});

/** Every read endpoint that can echo stored data, addressed at real rows. */
async function echoingResponses(): Promise<Array<[string, SweepResponse]>> {
  const from = sweepIso(SWEEP_NOW - 2 * DAY_MS);
  const to = sweepIso(SWEEP_NOW);
  return [
    ['GET /api/accounts', await api.call('GET', '/api/accounts')],
    ['GET /api/status', await api.call('GET', '/api/status')],
    ['GET /api/providers', await api.call('GET', '/api/providers')],
    ['GET /api/settings', await api.call('GET', '/api/settings')],
    ['GET /api/quota', await api.call('GET', `/api/quota?accountId=${HIST}`)],
    [
      'GET /api/history',
      await api.call(
        'GET',
        `/api/history?accountId=${HIST}&metric=sweep-monthly&from=${from}&to=${to}`,
      ),
    ],
    [
      'GET /api/events',
      await api.call('GET', `/api/events?accountId=${HIST}&from=${from}&to=${to}`),
    ],
    [
      'GET /api/peak-hours',
      await api.call('GET', `/api/peak-hours?accountId=seed&from=${from}&to=${to}`),
    ],
  ];
}

describe('§15.4 secret masking across the endpoint surface (marker-secret method)', () => {
  it('holds every marker in stored state — the sweep’s absences are non-vacuous', async () => {
    // The configuration file holds every key marker…
    const file = await readConfigJson(api.configPath);
    const fileText = JSON.stringify(file);
    expect(fileText).toContain(MARKER_FILE_KEY);
    expect(fileText).toContain(MARKER_WIRE_KEY);
    expect(fileText).toContain(MARKER_HIST_KEY);
    // …only the scrypt encoding of the password — never its plaintext…
    expect(fileText).not.toContain(MARKER_PASSWORD);
    expect(String((file.auth as Record<string, unknown>).passwordHash)).toMatch(/^scrypt\$/);
    // …and the database rows carry the key-embedding plan name and error
    // message verbatim (the raw stored values the wire must redact).
    const snapshot = api.composed.repository.getLatestSnapshot(HIST);
    expect(snapshot?.planName).toBe(MARKER_PLAN);
    const failedRun = api.composed.repository.getLatestCollectionRun(HIST, 'server_error');
    expect(failedRun?.errorMessage).toBe(MARKER_ERROR);
  });

  it('never echoes any marker in any read endpoint’s body', async () => {
    for (const [label, response] of await echoingResponses()) {
      expect(response.statusCode, label).toBe(200);
      for (const marker of ALL_MARKERS) {
        expect(response.body, `${label} must not contain ${marker}`).not.toContain(marker);
      }
    }
  });

  it('renders the key-embedding stored text redacted, keeping the events it explains', async () => {
    // §7.4 server-side: the failure evidence and the plan name ride the
    // wire with the key's exact occurrence replaced — api-status pins the
    // token on its own routes; the sweep pins it across the surface.
    const events = await api.call(
      'GET',
      `/api/events?accountId=${HIST}&from=${sweepIso(SWEEP_NOW - 2 * DAY_MS)}&to=${sweepIso(SWEEP_NOW)}`,
    );
    const eventsBody = events.json() as { events: Array<{ kind: string; message?: string }> };
    expect(eventsBody.events.some((event) => event.kind === 'collection_error')).toBe(true);
    expect(events.body).toContain('upstream failed after bearer [REDACTED]');
    expect(events.body).not.toContain(MARKER_HIST_KEY);

    const quota = await api.call('GET', `/api/quota?accountId=${HIST}`);
    expect(quota.body).toContain('Team Ultra ([REDACTED])');
    expect(quota.body).not.toContain(MARKER_HIST_KEY);
  });

  it('never echoes a marker in the connection-test outcome or the error envelopes', async () => {
    const test = await api.call('POST', '/api/accounts/seed/test');
    expect(test.statusCode).toBe(200);
    expect(test.body).not.toContain(MARKER_FILE_KEY);

    const notFound = await api.call('GET', '/api/quota?accountId=ghost');
    expect(notFound.statusCode).toBe(404);
    const forbidden = await api.call(
      'POST',
      '/api/accounts',
      {
        providerId: 'zai-coding-plan',
        label: 'Cross-origin probe',
      },
      { origin: 'https://attacker.example' },
    );
    expect(forbidden.statusCode).toBe(403);
    for (const marker of ALL_MARKERS) {
      expect(notFound.body, `404 must not contain ${marker}`).not.toContain(marker);
      expect(forbidden.body, `403 must not contain ${marker}`).not.toContain(marker);
    }
  });

  it('keeps every marker out of every log line (§16 redaction path)', async () => {
    // Positive control first: the sink captured the lifecycle records, so
    // the absence assertions below cannot pass vacuously through a broken
    // logger wiring. The startup keys are registered as the logger's
    // known secret values exactly as the production construction would
    // (the harness mirrors the registration — see its docblock).
    const lines = api.sink.lines();
    expect(lines.length, 'the sink captured lifecycle records').toBeGreaterThan(0);
    const logs = lines.join('\n');
    for (const marker of ALL_MARKERS) {
      expect(logs, `logs must not contain ${marker}`).not.toContain(marker);
    }
  });

  it('answers §13’s mask contract: the constant mask, the boolean, never a key field', async () => {
    const response = await api.call('GET', '/api/accounts');
    const body = response.json() as { accounts: Array<Record<string, unknown>> };
    const byId = new Map(body.accounts.map((view) => [view.id as string, view]));
    expectMaskedKey(byId.get('seed')!, true);
    expectMaskedKey(byId.get('wire')!, true);
    expectMaskedKey(byId.get(HIST)!, true);
    // No serialized view carries the key FIELD at all — the closed
    // serializer drops it even if a handler bug set it (D-128).
    expect(response.body).not.toContain('"apiKey"');
    // The settings view reports the password as presence only.
    const settings = await api.call('GET', '/api/settings');
    expect(settings.body).not.toContain('scrypt$');
    expect(settings.body).not.toContain('passwordHash');
  });

  it(
    'keeps a runtime-rotated key off the wire too (the marker method on PATCH)',
    { timeout: 10_000 },
    async () => {
      // A dedicated lifecycle: the rotation is a mutation, and its positive
      // control must prove THE ROTATION persisted — a fresh file that never
      // held the rotated marker elsewhere (the shared lifecycle's `wire`
      // account would make a file-wide contains() vacuous).
      const MARKER_ROTATED_KEY = 'sk-sweep-secrets-rotated-51c7ea';
      await withComposedApi(
        {
          config: {
            app: { timezone: 'UTC' },
            accounts: [
              {
                id: 'seed',
                providerId: 'zai-coding-plan',
                label: 'Seed account',
                apiKey: MARKER_FILE_KEY,
              },
            ],
          },
        },
        async (own) => {
          const rotated = await own.call('PATCH', '/api/accounts/seed', {
            apiKey: MARKER_ROTATED_KEY,
          });
          expect(rotated.statusCode).toBe(200);
          expect(rotated.body).not.toContain(MARKER_ROTATED_KEY);
          expectMaskedKey(rotated.json() as Record<string, unknown>, true);
          // The rotation persisted to the seed ENTRY (the entry-specific
          // positive control — the old key is gone from the entry too)…
          const file = await readConfigJson(own.configPath);
          const seedEntry = (file.accounts as Array<Record<string, unknown>>).find(
            (account) => account.id === 'seed',
          );
          expect(seedEntry?.apiKey).toBe(MARKER_ROTATED_KEY);
          // …and still never reached a log line.
          expect(own.sink.lines().join('\n')).not.toContain(MARKER_ROTATED_KEY);
        },
      );
    },
  );

  it(
    'keeps the env-resolved key masked the same way (§6.3 third source)',
    { timeout: 10_000 },
    async () => {
      await withComposedApi(
        {
          config: {
            app: { timezone: 'UTC' },
            accounts: [
              {
                id: 'envseed',
                providerId: 'zai-coding-plan',
                label: 'Environment account',
                apiKeyEnv: 'QM_SWEEP_ENV_KEY',
              },
            ],
          },
          env: { QM_SWEEP_ENV_KEY: MARKER_WIRE_KEY },
        },
        async (envApi) => {
          const accounts = await envApi.call('GET', '/api/accounts');
          expect(accounts.statusCode).toBe(200);
          const [view] = (accounts.json() as { accounts: Array<Record<string, unknown>> }).accounts;
          expectMaskedKey(view!, true);
          expect(view!.keySource).toBe('environment');
          expect(accounts.body).not.toContain(MARKER_WIRE_KEY);
          expect(envApi.sink.lines().join('\n')).not.toContain(MARKER_WIRE_KEY);
        },
      );
    },
  );
});
