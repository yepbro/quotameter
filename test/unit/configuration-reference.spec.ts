import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfigWithEnv, ENV_OVERRIDES } from '../../src/config/env';
import { RELOAD_FIELDS } from '../../src/config/reload';
import {
  CONFIG_SCHEMA_DOCUMENT,
  findConfigProblems,
  ID_PATTERN,
  type AccountConfig,
  type Config,
  type PeakWindow,
} from '../../src/schemas/config';

/**
 * The configuration reference's drift guard (task 187, spec §6, §18; decision
 * D-197): `docs/configuration.md` must agree with the shipped JSON Schema —
 * the same repo-file guard shape as `spec-timestamp-rule.spec.ts` (D-183) and
 * the same schema-walk shape as `config-schema-published.spec.ts` (D-015,
 * whose freshness test keeps `schema/config.schema.json` identical to
 * `CONFIG_SCHEMA_DOCUMENT`, so guarding against the document IS guarding
 * against the shipped artifact).
 *
 * The guard parses the reference's field tables and compares every row
 * against a walk of the canonical contract: field inventory (both
 * directions), Type, Default, the schema's constraint tokens inside
 * Validation, the Environment override column against `ENV_OVERRIDES` (D-023),
 * and the Applies column against `RELOAD_FIELDS` (§6.4, D-026) — a schema
 * change without a matching reference row (or a reference claim the schema
 * no longer backs) fails `make check`. The cross-field rules and the reserved
 * `QUOTAMETER_*` names are pinned behaviorally: the rule must actually fire
 * in `findConfigProblems` / the environment scan before the reference is
 * allowed to document it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The reference document, verbatim. */
const REFERENCE = readFileSync(path.join(REPO_ROOT, 'docs/configuration.md'), 'utf8');

/** A `\|` escape inside a markdown table cell, so cell splitting is safe. */
const ESCAPED_PIPE = '\u0000';

/** One raw markdown table cell, escapes resolved. */
function cellOf(raw: string): string {
  return raw.replaceAll(ESCAPED_PIPE, '|');
}

/** A cell normalized for comparison: no backticks, single-spaced, trimmed. */
function normalizedCell(raw: string): string {
  return cellOf(raw).replaceAll('`', '').replaceAll(/\s+/gu, ' ').trim();
}

/** Parses one table line into cells (an empty array for non-table lines). */
function splitRow(line: string): string[] {
  if (!line.trim().startsWith('|')) return [];
  return line
    .trim()
    .replaceAll('\\|', ESCAPED_PIPE)
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.replaceAll(ESCAPED_PIPE, '|').trim());
}

/** Every row of every table whose header row equals `header` (normalized). */
function tableRows(header: string[]): string[][] {
  const lines = REFERENCE.split('\n');
  const wanted = header.join('|');
  const rows: string[][] = [];
  let current: string[][] | undefined;
  for (const line of lines) {
    const cells = splitRow(line);
    if (cells.length === 0) {
      if (current !== undefined && current.length > 0) rows.push(...current.slice(2));
      current = undefined;
      continue;
    }
    if (current === undefined) {
      if (cells.map(normalizedCell).join('|') !== wanted) continue;
      current = [];
    }
    current.push(cells);
  }
  if (current !== undefined && current.length > 0) rows.push(...current.slice(2));
  return rows;
}

/** The whole document, whitespace-collapsed and backtick-stripped. */
const PROSE = REFERENCE.replaceAll('`', '').replaceAll(/\s+/gu, ' ');

/* ── The schema walk (the expected field rows) ──────────────────────────── */

/** A loose JSON-Schema node of the contract. */
type Node = Record<string, unknown>;

/** Narrows an unknown value to a schema-node object with a located message. */
function node(value: unknown, at: string): Node {
  expect(value, `${at} must be a schema object`).toBeDefined();
  expect(typeof value, `${at} must be a schema object`).toBe('object');
  return value as Node;
}

/** The `required` names of a schema node, as a set. */
function requiredOf(parent: Node): Set<string> {
  return new Set(((parent.required as string[] | undefined) ?? []) as string[]);
}

/** One expected field row: its canonical path, node, and requiredness. */
interface FieldRow {
  readonly path: string;
  readonly node: Node;
  readonly required: boolean;
}

/** The `const` members of an `anyOf` literal-union node, in declared order. */
function constValues(parent: Node): string[] {
  return (parent.anyOf as Node[]).map((member) => String(member.const));
}

/**
 * Walks the canonical contract into the reference's row vocabulary —
 * generically, so a schema field added anywhere under a walked container
 * surfaces as a row the reference must document (the review-verified totality
 * requirement: name-pinned pulls here once let a new provider-level field ship
 * undocumented while every gate stayed green). Containers that stay prose
 * (the root, the plain sections, the provider record and its `<id>` keys, the
 * `accounts` array itself) are pinned by the keys assertions instead: any
 * structural growth of the contract fails this walk with a message naming the
 * change, never silently.
 */
function fieldRows(): FieldRow[] {
  const rows: FieldRow[] = [];
  const properties = node(
    node(CONFIG_SCHEMA_DOCUMENT, 'CONFIG_SCHEMA_DOCUMENT').properties,
    'properties',
  );
  expect(Object.keys(properties).sort(), 'the root sections are exactly the walked set').toEqual([
    'accounts',
    'app',
    'auth',
    'logging',
    'providers',
    'server',
  ]);

  /**
   * Emits one row per property of `parentNode` at `prefix`, recursing into
   * object children and into array `items` (the `prefix[]` vocabulary).
   */
  const emit = (prefix: string, parentNode: Node): void => {
    const parentRequired = requiredOf(parentNode);
    for (const [name, raw] of Object.entries(node(parentNode.properties, `${prefix}.properties`))) {
      const child = node(raw, `${prefix}.${name}`);
      const path = `${prefix}.${name}`;
      rows.push({ path, node: child, required: parentRequired.has(name) });
      if (child.properties !== undefined) {
        emit(path, child);
      } else {
        const items = child.items as Node | undefined;
        if (items !== undefined && items.properties !== undefined) {
          emit(`${path}[]`, items);
        }
      }
    }
  };

  for (const section of ['server', 'app', 'auth', 'logging']) {
    emit(section, node(properties[section], `properties.${section}`));
  }

  const providers = node(properties.providers, 'properties.providers');
  const patterns = Object.keys(node(providers.patternProperties, 'providers.patternProperties'));
  expect(patterns, 'the provider record keys on exactly one pattern').toHaveLength(1);
  const provider = node(
    node(providers.patternProperties, 'providers.patternProperties')[patterns[0]!],
    'providers.patternProperties.<pattern>',
  );
  const providerProperties = node(provider.properties, 'provider.properties');
  expect(Object.keys(providerProperties).sort(), 'every provider field is walked').toEqual([
    'peakHours',
    'requestTimeoutSeconds',
  ]);
  emit('providers.<id>', provider);

  emit(
    'accounts[]',
    node(node(properties.accounts, 'properties.accounts').items, 'accounts.items'),
  );

  return rows;
}

/** The reference's Type token for a schema node. */
function typeToken(node: Node): string {
  if (Array.isArray(node.anyOf)) return 'enum';
  const type = String(node.type);
  expect(
    ['string', 'integer', 'number', 'boolean', 'array', 'object'],
    `type of ${type}`,
  ).toContain(type);
  return type;
}

/** The reference's Default token for a schema node. */
function defaultToken(node: Node): string {
  return node.default === undefined ? '—' : String(node.default);
}

/** The constraint tokens a Validation cell must contain, from the node alone. */
function constraintTokens(node: Node): string[] {
  const tokens: string[] = [];
  if (node.minimum !== undefined && node.maximum !== undefined) {
    tokens.push(`${String(node.minimum)}–${String(node.maximum)}`);
  }
  if (node.exclusiveMinimum !== undefined) tokens.push(`> ${String(node.exclusiveMinimum)}`);
  if (node.minLength !== undefined) tokens.push(`minLength ${String(node.minLength)}`);
  if (node.minItems !== undefined) tokens.push(`minItems ${String(node.minItems)}`);
  if (node.uniqueItems === true) tokens.push('uniqueItems');
  if (Array.isArray(node.anyOf)) tokens.push(`one of ${constValues(node).join(', ')}`);
  const items = node.items as Node | undefined;
  if (items !== undefined && Array.isArray(items.anyOf)) {
    tokens.push(`one of ${constValues(items).join(', ')}`);
  }
  if (typeof node.pattern === 'string') tokens.push(node.pattern);
  return tokens;
}

/** The §6.4 class of a reference path, derived from `RELOAD_FIELDS`. */
function appliesOf(path: string): 'restart' | 'reload' {
  const hits = RELOAD_FIELDS.filter(
    (spec) =>
      path === spec.field || path.startsWith(`${spec.field}.`) || path.startsWith(`${spec.field}[`),
  );
  expect(
    hits,
    `exactly one RELOAD_FIELDS row must classify ${path} (prefix rule for scope rows)`,
  ).toHaveLength(1);
  // The reference's operator-facing word for the code's 'live' class is
  // 'reload' — the change applies with the next successful reload (§6.4).
  return hits[0]!.applies === 'restart' ? 'restart' : 'reload';
}

/** The override variable of a reference path, `—` when file-only. */
function envOf(path: string): string {
  return ENV_OVERRIDES.find((spec) => spec.field === path)?.variable ?? '—';
}

/* ── The reference's field tables ───────────────────────────────────────── */

const FIELD_HEADER = ['Field', 'Type', 'Default', 'Validation', 'Environment override', 'Applies'];

/** The parsed field rows keyed by their Field cell. */
const documented = new Map(
  tableRows(FIELD_HEADER).map((cells) => [
    normalizedCell(cells[0]!),
    {
      type: normalizedCell(cells[1]!),
      default: normalizedCell(cells[2]!),
      validation: normalizedCell(cells[3]!),
      env: normalizedCell(cells[4]!),
      applies: normalizedCell(cells[5]!),
    },
  ]),
);

describe('the configuration reference agrees with the shipped schema', () => {
  it('documents every walkable field exactly once, with no extra rows', () => {
    // A duplicated Field row would collapse into the Map (last row wins), so
    // the row count is pinned against the map size before comparing keys.
    expect(tableRows(FIELD_HEADER), 'no duplicated field rows').toHaveLength(documented.size);
    const expected = fieldRows().map((row) => row.path);
    expect([...documented.keys()].sort()).toEqual([...expected].sort());
  });

  it('carries the schema truth in every row (type, default, constraints, requiredness)', () => {
    for (const row of fieldRows()) {
      const doc = documented.get(row.path)!;
      expect(doc.type, `${row.path} Type`).toBe(typeToken(row.node));
      expect(doc.default, `${row.path} Default`).toBe(defaultToken(row.node));
      for (const token of constraintTokens(row.node)) {
        expect(doc.validation, `${row.path} Validation must mention '${token}'`).toContain(token);
      }
      // Requiredness is the leading `required;` marker — a word-boundary
      // match would false-positive on the `auth.mode` enum value 'required'.
      expect(
        /^required\b/.test(doc.validation),
        `${row.path} requiredness must match the schema`,
      ).toBe(row.required);
    }
  });

  it('names the right environment override per field (D-023)', () => {
    for (const row of fieldRows()) {
      expect(documented.get(row.path)!.env, `${row.path} override`).toBe(envOf(row.path));
    }
  });

  it('classifies restart vs reload exactly as RELOAD_FIELDS does (§6.4, D-026)', () => {
    for (const row of fieldRows()) {
      expect(documented.get(row.path)!.applies, `${row.path} Applies`).toBe(appliesOf(row.path));
    }
  });

  it('documents the override vocabulary verbatim (variables, fields, coercion)', () => {
    const rows = tableRows(['Variable', 'Field', 'Coercion']);
    expect(
      rows.map((cells) => ({
        variable: normalizedCell(cells[0]!),
        field: normalizedCell(cells[1]!),
        kind: normalizedCell(cells[2]!),
      })),
    ).toEqual(
      ENV_OVERRIDES.map((spec) => ({
        variable: spec.variable,
        field: spec.field,
        kind: spec.kind,
      })),
    );
  });
});

/* ── Behavioral pins: the reserved names and the cross-field rules ──────── */

describe('the reference documents rules the code actually enforces', () => {
  it('lists exactly the reserved names the environment scan accepts', async () => {
    const reserved = ['QUOTAMETER_CONFIG_DIR', 'QUOTAMETER_DATA_DIR', 'QUOTAMETER_CLI_ENTRY'];
    for (const name of reserved) {
      // Behavioral: the scan must genuinely accept the name (not report it).
      const scan = await loadConfigWithEnv('/nonexistent/quotameter/config.json', { [name]: 'x' });
      expect(
        (scan.ok ? [] : scan.problems).some((problem) => problem.includes('unsupported')),
        `${name} must be reserved in src/config/env.ts`,
      ).toBe(false);
      // …and the reference must document it.
      expect(PROSE, `${name} documented`).toContain(name);
    }
    // The control: an unknown name is rejected, exactly as the reference says.
    const control = await loadConfigWithEnv('/nonexistent/quotameter/config.json', {
      QUOTAMETER_NO_SUCH_KNOB: 'x',
    });
    expect(
      control.ok ? '' : control.problems.join('\n'),
      'the unknown-name rejection the reference describes',
    ).toContain('unsupported environment variable');
  });

  it('documents every cross-field rule that actually fires', () => {
    const window = (overrides: Partial<PeakWindow> = {}): PeakWindow => ({
      id: 'w',
      name: 'Window',
      days: ['mon'],
      start: '09:00',
      end: '17:00',
      multiplier: 1,
      ...overrides,
    });
    const account = (overrides: Partial<AccountConfig> = {}): AccountConfig => ({
      id: 'a',
      providerId: 'zai-coding-plan',
      label: 'Account',
      enabled: true,
      ...overrides,
    });
    const config = (overrides: {
      app?: Config['app'];
      auth?: Config['auth'];
      server?: Config['server'];
      providers?: Config['providers'];
      accounts?: Config['accounts'];
    }): Config => ({
      server: { host: '127.0.0.1', port: 8787 },
      app: { timezone: 'UTC', pollingIntervalSeconds: 300, historyRetentionDays: 180 },
      auth: { mode: 'auto' },
      logging: { level: 'warn' },
      providers: {},
      accounts: [],
      ...overrides,
    });

    const cases: ReadonlyArray<{ doc: string; fragment: string; problems: string[] }> = [
      {
        doc: 'valid IANA time zone name',
        fragment: 'not a valid IANA time zone',
        problems: findConfigProblems(
          config({ app: { ...config({}).app, timezone: 'Nowhere/None' } }),
        ),
      },
      {
        doc: 'mutually exclusive',
        fragment: 'mutually exclusive',
        problems: findConfigProblems(
          config({ accounts: [account({ apiKey: 'k', apiKeyEnv: 'ZAI_KEY' })] }),
        ),
      },
      {
        doc: 'unique across accounts',
        fragment: 'duplicate account id',
        problems: findConfigProblems(config({ accounts: [account(), account()] })),
      },
      {
        doc: 'must be earlier than',
        fragment: 'must be earlier than',
        problems: findConfigProblems(
          config({
            providers: {
              p: {
                peakHours: {
                  timezone: 'UTC',
                  offPeakMultiplier: 1,
                  windows: [window({ start: '18:00', end: '14:00' })],
                },
                requestTimeoutSeconds: 15,
              },
            },
          }),
        ),
      },
      {
        doc: 'unique within the schedule',
        fragment: 'duplicate window id',
        problems: findConfigProblems(
          config({
            providers: {
              p: {
                peakHours: {
                  timezone: 'UTC',
                  offPeakMultiplier: 1,
                  windows: [window(), window({ start: '19:00', end: '20:00' })],
                },
                requestTimeoutSeconds: 15,
              },
            },
          }),
        ),
      },
      {
        doc: 'not overlap',
        fragment: 'overlap on',
        problems: findConfigProblems(
          config({
            providers: {
              p: {
                peakHours: {
                  timezone: 'UTC',
                  offPeakMultiplier: 1,
                  windows: [
                    window(),
                    window({ id: 'w2', name: 'Second', start: '10:00', end: '11:00' }),
                  ],
                },
                requestTimeoutSeconds: 15,
              },
            },
          }),
        ),
      },
      {
        doc: 'or server.host is not loopback',
        fragment: 'a password is required',
        problems: [
          ...findConfigProblems(config({ auth: { mode: 'required' } })),
          ...findConfigProblems(config({ server: { host: '0.0.0.0', port: 8787 } })),
        ],
      },
    ];

    for (const { doc, fragment, problems } of cases) {
      expect(problems.length, `the rule documented as '${doc}' must fire`).toBeGreaterThan(0);
      expect(
        problems.join('\n'),
        `the rule documented as '${doc}' fired with its own message`,
      ).toContain(fragment);
      expect(PROSE, `the reference documents the '${doc}' rule`).toContain(doc);
    }
  });

  it('pins the operating sentences the tables cannot carry', () => {
    for (const phrase of [
      'app section is the only required section',
      'environment over file over defaults',
      'counts as unset',
      'is not expanded',
      'mode 0700',
      'mode 0600',
      'server.host, server.port, and auth.mode',
      'quotameter restart',
      'unsupported environment variable',
      'read-only in the web UI',
    ]) {
      expect(PROSE, `the reference states '${phrase}'`).toContain(phrase);
    }
    // The provider-record key charset is prose (a table row cannot carry it).
    expect(PROSE, 'the provider key charset').toContain(ID_PATTERN);
  });
});
