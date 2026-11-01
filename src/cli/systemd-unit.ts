/**
 * systemd unit content generation and structural validation (task 134,
 * spec §5.4).
 *
 * Three pure concerns, one module:
 *
 * - **Generation** — {@link buildSystemUnit} renders the system unit from
 *   validated inputs: absolute Node/CLI paths (spec §5.4: Node may live in
 *   nvm or NodeSource, so the unit pins `process.execPath`'s absolute value
 *   and the CLI entry's absolute value at generation time), a regular
 *   `User=`, `Restart=on-failure` with a configurable `RestartSec`,
 *   `After=`/`Wants=network-online.target`, `Environment=NODE_ENV=production`,
 *   the §5.4 hardening set, and journald output. The output is deterministic:
 *   identical inputs produce a byte-identical unit, which is what
 *   `quotameter service install`'s regeneration requirement (§5.4) and
 *   `doctor`'s staleness check build on.
 * - **Parsing** — {@link parseUnitFile} reads unit content back into
 *   directives (comments, CRLF, backslash continuations, malformed lines).
 *   `doctor` (task 145) reuses it to read installed units — including
 *   hand-edited ones — before comparing their `ExecStart` paths against the
 *   current runtime (§5.4 "detect stale Node/CLI paths").
 * - **Structural validation** — {@link validateSystemUnit} checks a unit's
 *   content against the §5.4 contract and returns problem strings (empty
 *   array = valid). The development container and CI have no systemd (no
 *   `systemd-analyze`), so validation is structural: an exact-content
 *   snapshot plus this invariant checker. The checker is deliberately a
 *   strict shape check of the unit this module generates — any directive
 *   outside the known set, any duplicate key, and any `Environment=` line
 *   other than `NODE_ENV=production` is a problem; that allowlist is the
 *   mechanical half of "never put secrets in unit files" (§5.4) — the other
 *   half is that {@link SystemUnitInput} has no secret-carrying field at
 *   all.
 *
 * Task 135's user unit (`src/cli/systemd-user-unit.ts`) composes the shared
 * pieces — {@link renderUnitFile}, {@link assertUnitPathInput},
 * {@link assertUnitRestartSecSeconds}, {@link checkUnitShape} with the
 * exported check builders, and the pinned Description/Documentation
 * constants — with a user-compatible minimal hardening set instead of the
 * system one.
 *
 * Nothing here touches the filesystem or systemd itself: installing,
 * enabling, and starting the unit is task 139's `service install` command.
 */

import * as path from 'node:path';

/** The system unit's file name (spec §5.3: `/etc/systemd/system/quotameter.service`). */
export const SYSTEM_UNIT_NAME = 'quotameter.service';

/** Where task 139 installs the generated system unit (spec §5.3 step 7). */
export const SYSTEM_UNIT_INSTALL_PATH = '/etc/systemd/system/quotameter.service';

/** Cosmetic but pinned so the generated unit is stable (shared with the user unit). */
export const UNIT_DESCRIPTION = 'Quotameter - usage quota monitoring for AI subscriptions';

/** The public repository, stable public information (shared with the user unit). */
export const UNIT_DOCUMENTATION = 'https://github.com/yepbro/quotameter';

/**
 * Inputs of the generated system unit (spec §5.4). Every path is absolute
 * and injection-safe (validated by {@link assertUnitPathInput}); the user is
 * a regular account (validated by {@link assertUnitUserInput}). There is
 * deliberately no field for secrets: §5.4 forbids secrets in unit files, and
 * an input that cannot carry one cannot leak one.
 */
export interface SystemUnitInput {
  /** Absolute path of the Node binary — at runtime `process.execPath`. */
  nodePath: string;
  /** Absolute path of the CLI entry point (`bin/quotameter.mjs`). */
  cliPath: string;
  /** The regular account the service runs as (spec §5.1: never root). */
  user: string;
  /** Optional `Group=` override; omitted means the user's primary group. */
  group?: string;
  /** Restart delay in seconds, rendered as `RestartSec=<n>s`. */
  restartSecSeconds: number;
  /** Absolute configuration directory (§6.1) — first `ReadWritePaths` entry. */
  configDir: string;
  /** Absolute data directory (§6.1) — second `ReadWritePaths` entry. */
  dataDir: string;
}

/** One `[Section]` plus its directive lines, in render order. */
export type UnitSection = readonly [name: string, directives: readonly string[]];

/** A parsed `Key=Value` line, tagged with its section and 1-based line. */
export interface UnitDirective {
  section: string;
  key: string;
  value: string;
  line: number;
}

/** A parsed `[Section]` header, tagged with its 1-based line. */
export interface UnitSectionHeader {
  name: string;
  line: number;
}

/** Result of {@link parseUnitFile}: sections, directives, and problems. */
export interface ParsedUnitFile {
  /** Every valid section header in file order, empty sections included. */
  sections: UnitSectionHeader[];
  directives: UnitDirective[];
  /** Human-readable parse failures (malformed lines); empty when clean. */
  problems: string[];
}

/**
 * True when `value` contains a character that must never appear in an
 * interpolated unit value: any C0 control (a newline could inject further
 * directives into the unit), space (unit values are space-separated lists
 * or single words; systemd quoting is not implemented), or DEL. Non-ASCII
 * characters are fine — paths may legitimately carry them. Written as a
 * char-code scan rather than a control-character regex to keep the
 * `no-control-regex` security lint clean (the src/util/version.ts
 * precedent of restructuring instead of suppressing).
 */
function hasUnitForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True when `value` contains any C0 control or DEL (space is allowed). */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** User/group names this generator accepts (covers Debian/Ubuntu practice). */
const UNIT_USER_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Directive lines the renderer accepts: `Key=value` with a bare key. */
const UNIT_DIRECTIVE_LINE = /^[A-Za-z][A-Za-z0-9_.-]*=\S.*$/;

/** Section names the renderer accepts. */
const UNIT_SECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Validates a path-typed unit input (shared with task 135's user unit).
 *
 * Rejects empty, relative, or non-absolute values (spec §5.4: the unit must
 * pin absolute paths), any value containing whitespace or control
 * characters (a newline could inject further directives into the unit; a
 * space would need systemd quoting), and any value containing a systemd
 * metacharacter (`\`, `"`, `'`, `$`, `%`) — this generator deliberately does
 * not implement escaping or quoting (decision D-103), and unescaped those
 * characters change unit semantics (`\` and the quotes alter `ExecStart`
 * tokenization, `%` is a specifier, `$` is variable expansion). An
 * unsupported path is a loud error at generation time, never a silently
 * re-interpreted unit. The field name is included in the message so callers
 * can attribute the failure.
 */
export function assertUnitPathInput(field: string, value: string): void {
  if (value === '') {
    throw new Error(`systemd unit input: ${field} must not be empty`);
  }
  if (hasUnitForbiddenCharacter(value)) {
    throw new Error(
      `systemd unit input: ${field} must not contain whitespace or control characters ` +
        `(got ${JSON.stringify(value)}); paths with such characters cannot be written to a unit file safely`,
    );
  }
  if (/[\\'"$%]/.test(value)) {
    throw new Error(
      `systemd unit input: ${field} must not contain systemd metacharacters ('\\', '"', "'", '$', '%') ` +
        `(got ${JSON.stringify(value)}); this generator does not escape them, and unescaped they change unit semantics`,
    );
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      `systemd unit input: ${field} must be an absolute path (got ${JSON.stringify(value)}); ` +
        'spec §5.4 requires absolute paths in generated units',
    );
  }
}

/**
 * Validates a user/group-typed unit input (shared with task 135). The name
 * charset excludes everything that could break the directive line, and
 * `root` is rejected outright: spec §5.1 states the service must never run
 * as root — for `User=` this is the direct violation, for `Group=` it would
 * hand the process the root group's privileges.
 */
export function assertUnitUserInput(field: string, value: string): void {
  if (value === 'root') {
    throw new Error(
      `systemd unit input: ${field} must not be 'root' (spec §5.1: the service must never run as root)`,
    );
  }
  if (!UNIT_USER_NAME.test(value)) {
    throw new Error(
      `systemd unit input: ${field} must be a valid user or group name ` +
        `(letters, digits, '.', '_', '-', first character not a digit; got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Validates the shared `RestartSec` input (system and user units alike):
 * a whole number of seconds >= 1. `Number.isSafeInteger`, not
 * `Number.isInteger`: 1e21 is an integer whose string form is exponential
 * ("1e+21"), which would render a RestartSec the module's own validator
 * rejects (review round P2).
 */
export function assertUnitRestartSecSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `systemd unit input: restartSecSeconds must be a whole number of seconds >= 1 ` +
        `(got ${String(value)})`,
    );
  }
}

/**
 * Renders complete unit-file content from ordered sections.
 *
 * Deterministic: sections and directives render in the given order, sections
 * are separated by one blank line, lines are `\n`-terminated, and the file
 * ends with exactly one final newline. Every directive line must already be
 * `Key=value`-shaped and free of control characters — the renderer is the
 * last line of defense against smuggling a second directive inside a value.
 */
export function renderUnitFile(sections: readonly UnitSection[]): string {
  const blocks: string[] = [];
  for (const [name, directives] of sections) {
    if (!UNIT_SECTION_NAME.test(name)) {
      throw new Error(`systemd unit renderer: invalid section name ${JSON.stringify(name)}`);
    }
    if (directives.length === 0) {
      throw new Error(`systemd unit renderer: section [${name}] has no directives`);
    }
    const lines: string[] = [`[${name}]`];
    for (const directive of directives) {
      if (!UNIT_DIRECTIVE_LINE.test(directive) || hasControlCharacter(directive)) {
        throw new Error(
          `systemd unit renderer: section [${name}] has an unusable directive line ` +
            `(expected 'Key=value' without control characters, got ${JSON.stringify(directive)})`,
        );
      }
      lines.push(directive);
    }
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Builds the system unit content (spec §5.4) from validated inputs.
 *
 * The directive set is exactly §5.4's, plus the structural minimum systemd
 * needs to run and enable the service:
 *
 * - `Type=exec` — start-up fails visibly when the pinned Node/CLI path has
 *   gone stale (an `exec` failure is reported by systemd itself), which
 *   pairs with `doctor`'s stale-path detection (§5.4).
 * - `WantedBy=multi-user.target` — the standard target for a networked
 *   system service.
 * - No `WorkingDirectory` — the service needs no specific working directory,
 *   and every absolute path in the unit is one more path that can go stale
 *   after an upgrade.
 *
 * `Group=` is rendered only when provided; `User=`/`Group=` never `root`
 * (§5.1). Output goes to journald explicitly (§5.4) even though that is
 * systemd's default for system services — the spec names it, the unit pins
 * it.
 *
 * @returns the complete unit file content, `\n`-terminated.
 * @throws {@link Error} naming the offending field when an input violates
 *   the §5.4/§5.1 rules above.
 */
export function buildSystemUnit(input: SystemUnitInput): string {
  assertUnitPathInput('nodePath', input.nodePath);
  assertUnitPathInput('cliPath', input.cliPath);
  assertUnitPathInput('configDir', input.configDir);
  assertUnitPathInput('dataDir', input.dataDir);
  assertUnitUserInput('user', input.user);
  if (input.group !== undefined) {
    assertUnitUserInput('group', input.group);
  }
  assertUnitRestartSecSeconds(input.restartSecSeconds);

  const serviceDirectives: string[] = ['Type=exec', `User=${input.user}`];
  if (input.group !== undefined) {
    serviceDirectives.push(`Group=${input.group}`);
  }
  serviceDirectives.push(
    // `quotameter run` is the foreground command systemd supervises (§5.2).
    `ExecStart=${input.nodePath} ${input.cliPath} run`,
    'Environment=NODE_ENV=production',
    'Restart=on-failure',
    `RestartSec=${input.restartSecSeconds}s`,
    // The §5.4 system hardening set. ProtectSystem=strict makes the whole
    // file system read-only; ProtectHome=read-only does the same for /home,
    // /root, /run/user — ReadWritePaths re-opens exactly the application's
    // config and data directories (§6.1) for writing.
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    `ReadWritePaths=${input.configDir} ${input.dataDir}`,
    'StandardOutput=journal',
    'StandardError=journal',
  );

  return renderUnitFile([
    [
      'Unit',
      [
        `Description=${UNIT_DESCRIPTION}`,
        `Documentation=${UNIT_DOCUMENTATION}`,
        'After=network-online.target',
        'Wants=network-online.target',
      ],
    ],
    ['Service', serviceDirectives],
    ['Install', ['WantedBy=multi-user.target']],
  ]);
}

/**
 * Parses unit-file content into directives (spec §5.4's read-back half).
 *
 * Follows systemd's documented unit syntax
 * (systemd.syntax(7)) where it matters for reading real installed files:
 * full-line `#` and `;` comments, blank lines, `[Section]` headers (the
 * name between the brackets is taken verbatim — systemd does not trim it,
 * so `[ Service ]` is a different, unknown section), `Key=value` with all
 * whitespace after `=` ignored (values may contain `=`, trailing whitespace
 * trimmed), backslash line continuations where the backslash is replaced by
 * a single space and any comment block between the continued lines is
 * skipped, an even (escaped) number of trailing backslashes not continuing
 * at all, CRLF and lone CR normalized, and a leading BOM skipped. Anything
 * else — a malformed line, a directive before any section header — becomes
 * a problem string carrying its 1-based line number instead of a thrown
 * error: this parser reads files the application does not control
 * (hand-edited units), and a caller like `doctor` wants to report every
 * problem at once.
 */
export function parseUnitFile(content: string): ParsedUnitFile {
  const sections: UnitSectionHeader[] = [];
  const directives: UnitDirective[] = [];
  const problems: string[] = [];
  const physical = content.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let section: string | null = null;

  let index = 0;
  while (index < physical.length) {
    const startLine = index + 1;
    // Both indexings are guarded by `index < physical.length`, and split()
    // never returns holes — the non-null assertions state that invariant
    // instead of a dead `?? ''` fallback (the src/cli/parser.ts precedent).
    let line = physical[index]!;
    index += 1;
    // Join continuations: an odd number of trailing backslashes continues
    // (an escaped backslash `\\` does not), systemd replaces the backslash
    // with a single space, and a comment block between the continued lines
    // is ignored — the continuation joins whatever follows it. Continuation
    // joining happens before comment/blank checks — systemd joins physical
    // lines first.
    while (countTrailingBackslashes(line) % 2 === 1 && index < physical.length) {
      line = `${line.slice(0, -1)} `;
      while (index < physical.length && isCommentLine(physical[index]!)) index += 1;
      if (index >= physical.length) break;
      line += physical[index]!;
      index += 1;
    }
    const text = line.trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) continue;
    if (text.startsWith('[')) {
      if (!/^\[[^\]]+\]$/.test(text)) {
        problems.push(`line ${startLine}: malformed section header ${JSON.stringify(text)}`);
        continue;
      }
      // Verbatim between the brackets: `[ Service ]` must stay distinct
      // from `[Service]` — systemd does not trim section names.
      section = text.slice(1, -1);
      sections.push({ name: section, line: startLine });
      continue;
    }
    const equals = text.indexOf('=');
    if (equals <= 0) {
      problems.push(`line ${startLine}: not a 'Key=value' directive: ${JSON.stringify(text)}`);
      continue;
    }
    const key = text.slice(0, equals).trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) {
      problems.push(`line ${startLine}: malformed directive key ${JSON.stringify(key)}`);
      continue;
    }
    if (section === null) {
      problems.push(
        `line ${startLine}: directive ${JSON.stringify(key)} appears before any section`,
      );
      continue;
    }
    // All whitespace immediately after '=' is ignored (systemd.syntax),
    // not just one space; trailing whitespace is trimmed the same way.
    const value = text
      .slice(equals + 1)
      .trimStart()
      .trimEnd();
    directives.push({ section, key, value, line: startLine });
  }

  return { sections, directives, problems };
}

/** A full-line `#`/`;` comment (an empty-when-trimmed line is not one). */
function isCommentLine(line: string): boolean {
  const text = line.trim();
  return text.startsWith('#') || text.startsWith(';');
}

/** Number of consecutive `\` characters at the end of `line`. */
function countTrailingBackslashes(line: string): number {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i -= 1) count += 1;
  return count;
}

/** systemd boolean truth spellings (case-insensitive), per systemd.syntax(7). */
function isTruthyUnitBoolean(value: string): boolean {
  return /^(?:1|yes|true|on)$/i.test(value);
}

/** Directives of one section with one key, in file order. */
function occurrences(
  directives: readonly UnitDirective[],
  section: string,
  key: string,
): UnitDirective[] {
  return directives.filter((d) => d.section === section && d.key === key);
}

/** A directive check: the problem string when the value fails, else null. */
export type UnitDirectiveCheck = (directive: UnitDirective) => string | null;

/**
 * One contract row of a unit shape: how every occurrence of a directive is
 * checked, and whether the directive's absence is itself a problem.
 * Required rows report absence; optional rows (like the system unit's
 * `Group=`) only check the occurrences that exist.
 */
export interface UnitContractRow {
  section: string;
  key: string;
  required: boolean;
  check: UnitDirectiveCheck;
}

/**
 * The strict shape of a generated unit, shared by the system and user
 * validators: the directive keys allowed per section (a section outside the
 * map is unexpected, and so is a listed section's directive outside its key
 * list) plus the contract rows that pin the required values.
 * {@link checkUnitShape} runs both over parsed content.
 */
export interface UnitShape {
  allowedKeys: Readonly<Record<string, readonly string[]>>;
  contract: readonly UnitContractRow[];
}

/** Expects the exact value; the message renders the directive's own key. */
export function expectUnitValue(expected: string): UnitDirectiveCheck {
  return (d) =>
    d.value === expected
      ? null
      : `${d.key}= is ${JSON.stringify(d.value)}, expected ${JSON.stringify(expected)}`;
}

/** Expects one of systemd's truthy boolean spellings (systemd.syntax(7)). */
export const expectUnitTruthyBoolean: UnitDirectiveCheck = (d) =>
  isTruthyUnitBoolean(d.value)
    ? null
    : `${d.key}= is ${JSON.stringify(d.value)}, expected a true value`;

/**
 * Expects a systemd.time(7) time span; a stand-alone number is seconds, and
 * "m" alone is not a unit ("min" is).
 */
export const expectUnitTimeSpan: UnitDirectiveCheck = (d) =>
  /^\d+(?:us|ms|s|min|h|d|w)?$/.test(d.value)
    ? null
    : `${d.key}= is ${JSON.stringify(d.value)}, expected a systemd time span`;

/** Expects exactly `<absolute node> <absolute CLI> run` (§5.4's pinned command). */
export const expectUnitExecStartRun: UnitDirectiveCheck = (d) => {
  const tokens = d.value.trim().split(/\s+/);
  if (tokens.length !== 3) {
    return `ExecStart= is ${JSON.stringify(d.value)}, expected exactly "<node> <cli> run"`;
  }
  // The length guard makes the tuple total; the cast states it (the
  // src/util/version.ts tuple precedent — no defensive undefined arms).
  const [nodePath, cliPath, argument] = tokens as [string, string, string];
  if (!path.isAbsolute(nodePath)) {
    return `ExecStart= first token is not an absolute path: ${JSON.stringify(d.value)}`;
  }
  if (!path.isAbsolute(cliPath)) {
    return `ExecStart= second token is not an absolute path: ${JSON.stringify(d.value)}`;
  }
  if (argument !== 'run') {
    return `ExecStart= third token is ${JSON.stringify(argument)}, expected "run"`;
  }
  return null;
};

/**
 * Expects the one sanctioned `Environment=` line. The divergent value is
 * deliberately NOT reproduced in the problem: a unit that carries a secret
 * in Environment= must not have that secret echoed into diagnostics
 * (spec §15.4; review round P0).
 */
export const expectUnitProductionEnvironment: UnitDirectiveCheck = (d) =>
  d.value === 'NODE_ENV=production'
    ? null
    : 'Environment= differs from the required "NODE_ENV=production" ' +
      '(the value is intentionally not quoted here — spec §5.4 forbids secrets or extra variables in unit files)';

/**
 * System-unit only: `User=`/`Group=` must never be `root` (§5.1), empty, or
 * a numeric id — systemd accepts numeric ids, and id 0 is root by another
 * spelling; the generated unit always carries a regular account name, so
 * any numeric id is outside the generated shape (review round P1).
 */
const expectUnitNotRoot: UnitDirectiveCheck = (d) => {
  if (d.value === 'root')
    return `${d.key}= is "root" (spec §5.1: the service must never run as root)`;
  if (d.value === '') return `${d.key}= is empty`;
  if (/^\d+$/.test(d.value)) {
    return `${d.key}= is a numeric id ("${d.value}"), not the regular account name the generated unit carries (id 0 is root; spec §5.1)`;
  }
  return null;
};

/**
 * Runs a unit shape over unit content: the shared structural-validation
 * engine behind {@link validateSystemUnit} and the user unit's
 * `validateUserUnit` (task 135). Returns problem strings (empty array =
 * valid): parse problems first, then the unexpected-section walk (a section
 * outside the shape — empty ones included, caught through the parsed
 * headers), the unexpected-directive walk (strict shape of the generated
 * unit; directives inside an already-flagged section need no second message
 * of their own), duplicate keys inside a section (systemd silently applies
 * last-wins — a duplicate hides corruption), and finally the contract rows.
 */
export function checkUnitShape(content: string, shape: UnitShape): string[] {
  const { sections, directives, problems } = parseUnitFile(content);
  const issues: string[] = [...problems];

  // Own-property lookups only (Object.hasOwn, the init-yes.ts process.env
  // precedent): `in` and a bare bracket read both see inherited
  // Object.prototype properties, so a hand-edited section named `toString`,
  // `constructor`, or `__proto__` used to pass the known-section check and
  // crash the directive walk on the inherited function (review round P1) —
  // a unit the application does not control must produce a problem string,
  // never a throw.
  for (const header of sections) {
    if (!Object.hasOwn(shape.allowedKeys, header.name)) {
      issues.push(`line ${header.line}: unexpected section [${header.name}]`);
    }
  }
  for (const directive of directives) {
    if (!Object.hasOwn(shape.allowedKeys, directive.section)) {
      continue; // the section header was flagged above
    }
    // The hasOwn guard makes the own property's presence — and thus its
    // `readonly string[]` type — an invariant; the cast states it.
    const allowed = shape.allowedKeys[directive.section] as readonly string[];
    if (!allowed.includes(directive.key)) {
      issues.push(
        `line ${directive.line}: unexpected directive ${directive.key}= in [${directive.section}]`,
      );
    }
  }

  const seen = new Set<string>();
  for (const directive of directives) {
    const id = `${directive.section}::${directive.key}`;
    if (seen.has(id)) {
      issues.push(
        `line ${directive.line}: duplicate directive ${directive.key}= in [${directive.section}]`,
      );
    } else {
      seen.add(id);
    }
  }

  for (const { section, key, required, check } of shape.contract) {
    const found = occurrences(directives, section, key);
    if (found.length === 0) {
      if (required) issues.push(`[${section}] is missing the required directive ${key}=`);
      continue;
    }
    for (const directive of found) {
      const problem = check(directive);
      if (problem !== null) issues.push(`line ${directive.line}: ${problem}`);
    }
  }

  return issues;
}

/**
 * Structurally validates unit content against the §5.4 system-unit contract.
 *
 * Returns problem strings (empty array = valid): parse problems, missing or
 * wrong-valued contract directives, duplicate keys (systemd silently applies
 * last-wins — a duplicate hides corruption), unexpected sections (including
 * empty ones) or directives (this is a strict shape check of the unit this
 * module generates), a `User=`/`Group=` of `root` or of a numeric id (§5.1),
 * an `ExecStart` that is not `<absolute node> <absolute CLI> run`,
 * `ReadWritePaths` entries that are not absolute or that contain `/` (which
 * would undo `ProtectSystem=strict`), and **any** `Environment=` line other
 * than `NODE_ENV=production` — the mechanical no-secrets rule (§5.4), whose
 * problem message deliberately does not reproduce the divergent value so a
 * smuggled secret can never be echoed into diagnostics.
 *
 * When `expected` is supplied, `ReadWritePaths` must additionally equal
 * exactly the generated `<configDir> <dataDir>` pair in that order — the
 * comparison `doctor` (task 145) makes against a possibly stale installed
 * unit.
 *
 * `Description`/`Documentation` values are not pinned: they are cosmetic,
 * and a hand-adjusted description does not make a unit unsafe or stale.
 *
 * The development container and CI images ship no systemd (`systemd-analyze`
 * is absent — verified), so this checker plus the exact-content snapshot is
 * the whole validation story for generated units.
 */
export function validateSystemUnit(
  content: string,
  expected?: { configDir: string; dataDir: string },
): string[] {
  // One row per checked directive: required rows report absence, optional
  // rows (Group) only check the occurrences that exist. Pairing the check
  // with the row keeps the two lists from drifting apart.
  const contract: readonly UnitContractRow[] = [
    {
      section: 'Unit',
      key: 'After',
      required: true,
      check: expectUnitValue('network-online.target'),
    },
    {
      section: 'Unit',
      key: 'Wants',
      required: true,
      check: expectUnitValue('network-online.target'),
    },
    { section: 'Service', key: 'Type', required: true, check: expectUnitValue('exec') },
    { section: 'Service', key: 'User', required: true, check: expectUnitNotRoot },
    { section: 'Service', key: 'Group', required: false, check: expectUnitNotRoot },
    { section: 'Service', key: 'ExecStart', required: true, check: expectUnitExecStartRun },
    {
      section: 'Service',
      key: 'Environment',
      required: true,
      check: expectUnitProductionEnvironment,
    },
    { section: 'Service', key: 'Restart', required: true, check: expectUnitValue('on-failure') },
    { section: 'Service', key: 'RestartSec', required: true, check: expectUnitTimeSpan },
    { section: 'Service', key: 'NoNewPrivileges', required: true, check: expectUnitTruthyBoolean },
    { section: 'Service', key: 'PrivateTmp', required: true, check: expectUnitTruthyBoolean },
    { section: 'Service', key: 'ProtectSystem', required: true, check: expectUnitValue('strict') },
    { section: 'Service', key: 'ProtectHome', required: true, check: expectUnitValue('read-only') },
    {
      section: 'Service',
      key: 'ReadWritePaths',
      required: true,
      check: (d) => {
        const entries = d.value.trim().split(/\s+/);
        // A bare "/" (or any whole-tree prefix) silently undoes
        // ProtectSystem=strict, so it is always outside the contract, even
        // without knowing the intended directories (review round P1).
        if (entries.includes('/')) {
          return 'ReadWritePaths= contains "/", which undoes ProtectSystem=strict (spec §5.4 limits write access to the application config/data directories)';
        }
        const relative = entries.filter((entry) => !path.isAbsolute(entry));
        if (relative.length > 0) {
          return `ReadWritePaths= contains non-absolute entries: ${relative.map((e) => JSON.stringify(e)).join(', ')}`;
        }
        // With the intended directories supplied, the entry list must be
        // exactly the generated pair, in the generated order — the strict
        // shape doctor compares a possibly stale unit against.
        if (expected !== undefined) {
          const wanted = [expected.configDir, expected.dataDir];
          if (entries.length !== wanted.length || entries.some((entry, i) => entry !== wanted[i])) {
            return `ReadWritePaths= is ${JSON.stringify(d.value)}, expected exactly ${JSON.stringify(wanted.join(' '))} (the generated config/data pair)`;
          }
        }
        return null;
      },
    },
    {
      section: 'Service',
      key: 'StandardOutput',
      required: true,
      check: expectUnitValue('journal'),
    },
    { section: 'Service', key: 'StandardError', required: true, check: expectUnitValue('journal') },
    {
      section: 'Install',
      key: 'WantedBy',
      required: true,
      check: expectUnitValue('multi-user.target'),
    },
  ];

  return checkUnitShape(content, {
    allowedKeys: {
      Unit: ['Description', 'Documentation', 'After', 'Wants'],
      Service: [
        'Type',
        'User',
        'Group',
        'ExecStart',
        'Environment',
        'Restart',
        'RestartSec',
        'NoNewPrivileges',
        'PrivateTmp',
        'ProtectSystem',
        'ProtectHome',
        'ReadWritePaths',
        'StandardOutput',
        'StandardError',
      ],
      Install: ['WantedBy'],
    },
    contract,
  });
}
