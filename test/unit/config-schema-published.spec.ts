import { describe, expect, it } from 'vitest';
import committedFile from '../../schema/config.schema.json';
import { CONFIG_DEFAULTS, CONFIG_SCHEMA_DOCUMENT } from '../../src/schemas/config';

/**
 * Locks the published JSON Schema artifact (spec §6.2, §18; task 062,
 * decision D-015): the committed `schema/config.schema.json` must stay
 * identical to the canonical document (`CONFIG_SCHEMA_DOCUMENT` in
 * `src/schemas/config.ts`) and must carry the contract's constraints as
 * plain JSON Schema keywords, so editor tooling and future Ajv compilation
 * (task 064) see exactly the contract task 061 defined.
 *
 * Behavioral validation of the *contract* (a good config passes, a bad one
 * fails) lives in `config.spec.ts`, checked with TypeBox's `Value` module on
 * the live schemas: `Value.Check` dispatches on a `Symbol(Kind)` marker that
 * JSON serialization strips, so it cannot run against the published file —
 * standard JSON Schema tooling, which reads only the keywords pinned here,
 * is the artifact's consumer.
 */

/** The committed artifact, typed as loose keyword maps for traversal. */
const doc = committedFile as unknown as Record<string, unknown>;

/** Narrows an unknown keyword value to a schema-node object. */
function node(value: unknown, path: string): Record<string, unknown> {
  expect(value, `${path} must be a schema object`).not.toBeNull();
  expect(typeof value, `${path} must be a schema object`).toBe('object');
  expect(Array.isArray(value), `${path} must be a schema object`).toBe(false);
  return value as Record<string, unknown>;
}

/** The `const` members of a union node's `anyOf`, in declared order. */
function constValues(parent: Record<string, unknown>, at: string): string[] {
  const members = parent.anyOf;
  expect(Array.isArray(members), `${at}.anyOf must be an array`).toBe(true);
  return (members as unknown[]).map((member, index) =>
    String(node(member, `${at}.anyOf[${index}]`).const),
  );
}

/** A top-level section node of the published document. */
function section(name: string): Record<string, unknown> {
  return node(node(doc.properties, 'properties')[name], `properties.${name}`);
}

/** A property node inside a schema node. */
function field(parent: Record<string, unknown>, name: string, at: string): Record<string, unknown> {
  return node(node(parent.properties, `${at}.properties`)[name], `${at}.properties.${name}`);
}

/** The per-provider settings node: the sole `patternProperties` entry. */
function providerNode(): Record<string, unknown> {
  const patterns = node(section('providers').patternProperties, 'providers.patternProperties');
  const [key] = Object.keys(patterns);
  expect(key, 'providers must key on the id charset pattern').toBeDefined();
  return node(patterns[key as string], `providers.patternProperties.${key}`);
}

/** One peak window: the `items` node of `providers.*.peakHours.windows`. */
function windowNode(): Record<string, unknown> {
  const peakHours = field(providerNode(), 'peakHours', 'provider');
  return node(field(peakHours, 'windows', 'peakHours').items, 'peakHours.windows.items');
}

describe('published document metadata (spec §6.2, §18)', () => {
  it('declares JSON Schema draft 2020-12 and identifies the format', () => {
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(String(doc.title)).toContain('Quotameter');
    expect(String(doc.description)).toContain('Structural validation only');
  });

  it('exposes the six configuration sections with only app required', () => {
    const sections = node(doc.properties, 'properties');
    expect(Object.keys(sections)).toEqual([
      'server',
      'app',
      'auth',
      'logging',
      'providers',
      'accounts',
    ]);
    expect(doc.required).toEqual(['app']);
    expect(node(sections.app, 'properties.app').required).toEqual(['timezone']);
  });
});

describe('committed artifact freshness (decision D-015)', () => {
  it('equals the canonical document — regenerate with `make schema` when stale', () => {
    // Both sides are pure JSON data: the projection drops the TypeBox
    // symbol markers the live schema nodes carry, so equality compares
    // exactly what a JSON Schema consumer reads.
    expect(committedFile).toEqual(JSON.parse(JSON.stringify(CONFIG_SCHEMA_DOCUMENT)));
  });
});

describe('constraint keywords survive publication', () => {
  it('keeps the numeric ranges of the contract (spec §5.3, §7.1, §7.2, §11.3)', () => {
    expect(field(section('server'), 'port', 'server')).toMatchObject({
      minimum: 1,
      maximum: 65535,
      type: 'integer',
    });
    const app = section('app');
    expect(field(app, 'pollingIntervalSeconds', 'app')).toMatchObject({
      minimum: 60,
      maximum: 3600,
    });
    expect(field(app, 'historyRetentionDays', 'app')).toMatchObject({
      minimum: 7,
      maximum: 3650,
    });
    expect(field(providerNode(), 'requestTimeoutSeconds', 'provider')).toMatchObject({
      minimum: 5,
      maximum: 60,
    });
  });

  it('keeps draft 2020-12 numeric exclusiveMinimum for multipliers (spec §9.2)', () => {
    // Draft 2020-12 uses a numeric exclusiveMinimum; draft-07 form would be
    // a boolean next to `minimum`. TypeBox emits the numeric form, so the
    // declared `$schema` above must (and does) match it.
    const peakHours = field(providerNode(), 'peakHours', 'provider');
    expect(field(peakHours, 'offPeakMultiplier', 'peakHours')).toMatchObject({
      exclusiveMinimum: 0,
    });
    expect(field(windowNode(), 'multiplier', 'window')).toMatchObject({ exclusiveMinimum: 0 });
  });

  it('keeps the closed enums (spec §15.1, §16, §9.2)', () => {
    expect(constValues(field(section('auth'), 'mode', 'auth'), 'auth.mode')).toEqual([
      'auto',
      'required',
    ]);
    expect(constValues(field(section('logging'), 'level', 'logging'), 'logging.level')).toEqual([
      'error',
      'warn',
      'info',
      'debug',
    ]);
    const days = field(windowNode(), 'days', 'window');
    expect(constValues(node(days.items, 'window.days'), 'window.days')).toEqual([
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
    ]);
    expect(days).toMatchObject({ minItems: 1, uniqueItems: true });
  });

  it('keeps the pattern constraints, including the provider-key charset (spec §9.2)', () => {
    const idPattern = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
    expect(Object.keys(node(section('providers').patternProperties, 'providers'))).toEqual([
      idPattern,
    ]);
    const account = node(section('accounts').items, 'accounts.items');
    expect(field(account, 'id', 'accounts.items')).toMatchObject({ pattern: idPattern });
    expect(field(account, 'apiKeyEnv', 'accounts.items')).toMatchObject({
      pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
    });
    expect(account.required).toEqual(['id', 'providerId', 'label']);
    expect(field(windowNode(), 'start', 'window').pattern).toBe('^([01][0-9]|2[0-3]):[0-5][0-9]$');
    expect(field(windowNode(), 'end', 'window').pattern).toBe(
      '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$',
    );
  });

  it('closes every object schema against unknown keys (decision D-014)', () => {
    /** Recursively asserts `additionalProperties: false` on object nodes. */
    const assertClosed = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => assertClosed(entry, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const current = value as Record<string, unknown>;
      if (current.type === 'object') {
        // A hand-edited file must fail on typo'd keys, not silently accept
        // them — including keys outside the provider-id charset.
        expect(current.additionalProperties, `${path} (${current.type})`).toBe(false);
      }
      for (const [keyword, child] of Object.entries(current)) {
        assertClosed(child, `${path}.${keyword}`);
      }
    };
    assertClosed(doc, '$');
  });

  it('keeps the spec defaults visible to editor tooling', () => {
    expect(field(section('server'), 'host', 'server')).toMatchObject({
      default: CONFIG_DEFAULTS.server.host,
    });
    expect(field(section('server'), 'port', 'server')).toMatchObject({
      default: CONFIG_DEFAULTS.server.port,
    });
    expect(field(section('app'), 'pollingIntervalSeconds', 'app')).toMatchObject({
      default: CONFIG_DEFAULTS.app.pollingIntervalSeconds,
    });
    expect(field(section('auth'), 'mode', 'auth')).toMatchObject({
      default: CONFIG_DEFAULTS.auth.mode,
    });
    expect(field(section('logging'), 'level', 'logging')).toMatchObject({
      default: CONFIG_DEFAULTS.logging.level,
    });
  });
});
