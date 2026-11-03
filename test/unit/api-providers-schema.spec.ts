import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { ProviderViewSchema, ProvidersListResponseSchema } from '../../src/schemas/api/providers';

/**
 * The §13 providers contract tables (task 160, decision D-130): the closed
 * response object, the two schedule states (a configured §9.2 schedule, or
 * `null` — "not configured", never an invented one), and the nesting rule
 * (the response carries the configuration contract's own peak-hours node
 * verbatim, so the two cannot drift).
 */

/** A complete, valid §9.2 schedule — the spec's own sample shape. */
const SCHEDULE = {
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
} as const;

describe('ProviderViewSchema (§13 available types)', () => {
  const VALID_PROVIDER = {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    peakHours: SCHEDULE,
    metrics: [
      { metricKey: 'tokens-5h', label: '5-hour token quota' },
      { metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' },
    ],
  } as const;

  it('accepts a configured provider and the not-configured null', () => {
    const validate = new Ajv2020().compile(ProviderViewSchema);
    expect(validate(VALID_PROVIDER)).toBe(true);
    expect(validate({ ...VALID_PROVIDER, peakHours: null })).toBe(true);
    // The schedule node is the configuration contract's own: its optional
    // fields (multipliers) may be absent exactly as the file allows.
    expect(
      validate({
        ...VALID_PROVIDER,
        peakHours: { timezone: 'UTC', windows: [] },
      }),
    ).toBe(true);
    // The D-137 catalog: an adapter without one declares none — the
    // honest empty array on the wire.
    expect(validate({ ...VALID_PROVIDER, metrics: [] })).toBe(true);
  });

  it('rejects malformed schedules, catalogs, and non-contract fields', () => {
    const validate = new Ajv2020().compile(ProviderViewSchema);
    const rejected: unknown[] = [
      { id: 'zai-coding-plan', name: 'Z.ai Coding Plan' },
      { ...VALID_PROVIDER, metrics: undefined },
      { ...VALID_PROVIDER, requestTimeoutSeconds: 15 },
      { ...VALID_PROVIDER, apiKey: 'sk-marker-secret' },
      { ...VALID_PROVIDER, metrics: [{ metricKey: 'tokens-5h' }] },
      { ...VALID_PROVIDER, metrics: [{ metricKey: '', label: 'Empty key' }] },
      { ...VALID_PROVIDER, metrics: [{ metricKey: 'tokens-5h', label: ' ' }] },
      {
        ...VALID_PROVIDER,
        peakHours: { ...SCHEDULE, windows: [{ ...SCHEDULE.windows[0], days: ['fri', 'fri'] }] },
      },
      {
        ...VALID_PROVIDER,
        peakHours: { ...SCHEDULE, windows: [{ ...SCHEDULE.windows[0], start: '25:00' }] },
      },
      { ...VALID_PROVIDER, peakHours: { windows: [] } },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('ProvidersListResponseSchema (§13 list)', () => {
  it('accepts the empty registry and a populated list', () => {
    const validate = new Ajv2020().compile(ProvidersListResponseSchema);
    expect(validate({ providers: [] })).toBe(true);
    expect(
      validate({
        providers: [
          {
            id: 'zai-coding-plan',
            name: 'Z.ai Coding Plan',
            peakHours: SCHEDULE,
            metrics: [],
          },
          {
            id: 'ghost-plan',
            name: 'Ghost',
            peakHours: null,
            metrics: [{ metricKey: 'weekly-quota', label: 'Weekly quota' }],
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects additions to the envelope', () => {
    const validate = new Ajv2020().compile(ProvidersListResponseSchema);
    expect(validate({ providers: [], schedules: [SCHEDULE] })).toBe(false);
    expect(validate({ providers: [], apiKey: 'sk-marker-secret' })).toBe(false);
  });
});
