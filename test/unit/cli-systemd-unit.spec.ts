import { describe, expect, it } from 'vitest';
import {
  assertUnitPathInput,
  assertUnitUserInput,
  buildSystemUnit,
  parseUnitFile,
  renderUnitFile,
  SYSTEM_UNIT_INSTALL_PATH,
  SYSTEM_UNIT_NAME,
  validateSystemUnit,
} from '../../src/cli/systemd-unit';
import type { SystemUnitInput } from '../../src/cli/systemd-unit';

/**
 * The systemd system unit generator (task 134, spec §5.4, decision D-103).
 *
 * Validation is structural by design: the development container and CI ship
 * no systemd (`systemd-analyze` is absent — verified on the pinned image),
 * so the done-condition "generated unit passes a validation/snapshot test"
 * is delivered as an exact-content snapshot (the same inputs must render
 * byte-identical content) plus {@link validateSystemUnit}, the invariant
 * checker that reads the unit back through the same parser `doctor` will
 * use on installed units. Assertions follow the house style of exact
 * string/structure checks (`test/unit/cli-raw-diagnostics.spec.ts`).
 */

/** Representative valid input; unit tests override single fields. */
function input(overrides: Partial<SystemUnitInput> = {}): SystemUnitInput {
  return {
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs',
    user: 'den',
    restartSecSeconds: 5,
    configDir: '/home/den/.config/quotameter',
    dataDir: '/home/den/.local/share/quotameter',
    ...overrides,
  };
}

/** The complete expected unit for {@link input} — the snapshot contract. */
const EXPECTED_UNIT = `[Unit]
Description=Quotameter - usage quota monitoring for AI subscriptions
Documentation=https://github.com/yepbro/quotameter
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=den
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/den/.config/quotameter /home/den/.local/share/quotameter
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

/** Values of one directive key inside one section, in file order. */
function values(content: string, section: string, key: string): string[] {
  return parseUnitFile(content)
    .directives.filter((d) => d.section === section && d.key === key)
    .map((d) => d.value);
}

/** Replaces the first line equal to `from` with `to` (validator mutations). */
function replaceLine(content: string, from: string, to: string): string {
  const index = content.indexOf(from);
  if (index === -1) throw new Error(`fixture line not found: ${from}`);
  return content.slice(0, index) + to + content.slice(index + from.length);
}

describe('buildSystemUnit content (spec §5.4 snapshot)', () => {
  it('renders the exact §5.4 unit for the given inputs', () => {
    expect(buildSystemUnit(input())).toBe(EXPECTED_UNIT);
  });

  it('is deterministic: the same inputs render byte-identical content', () => {
    expect(buildSystemUnit(input())).toBe(buildSystemUnit(input()));
  });

  it('pins absolute Node and CLI paths in ExecStart with the run command', () => {
    const execStart = values(buildSystemUnit(input()), 'Service', 'ExecStart')[0];
    expect(execStart).toBe(
      '/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
    );
  });

  it('sets the regular user, never root, and an optional group', () => {
    const unit = buildSystemUnit(input());
    expect(values(unit, 'Service', 'User')).toEqual(['den']);
    expect(values(unit, 'Service', 'Group')).toEqual([]);

    const withGroup = buildSystemUnit(input({ group: 'quotameter' }));
    expect(values(withGroup, 'Service', 'Group')).toEqual(['quotameter']);
    // Group= renders directly after User=, before ExecStart.
    expect(values(withGroup, 'Service', 'User')).toEqual(['den']);
    expect(withGroup.indexOf('User=den\n')).toBeLessThan(withGroup.indexOf('Group=quotameter'));
    expect(withGroup.indexOf('Group=quotameter')).toBeLessThan(withGroup.indexOf('ExecStart='));
  });

  it('orders after and wants network-online.target and sets the restart policy', () => {
    const unit = buildSystemUnit(input());
    expect(values(unit, 'Unit', 'After')).toEqual(['network-online.target']);
    expect(values(unit, 'Unit', 'Wants')).toEqual(['network-online.target']);
    expect(values(unit, 'Service', 'Restart')).toEqual(['on-failure']);
    expect(values(unit, 'Service', 'Environment')).toEqual(['NODE_ENV=production']);
  });

  it('renders the configurable RestartSec from the input', () => {
    expect(
      values(buildSystemUnit(input({ restartSecSeconds: 30 })), 'Service', 'RestartSec'),
    ).toEqual(['30s']);
    expect(
      values(buildSystemUnit(input({ restartSecSeconds: 1 })), 'Service', 'RestartSec'),
    ).toEqual(['1s']);
  });

  it('applies the §5.4 system hardening set with ReadWritePaths limited to config/data', () => {
    const unit = buildSystemUnit(input());
    expect(values(unit, 'Service', 'NoNewPrivileges')).toEqual(['true']);
    expect(values(unit, 'Service', 'PrivateTmp')).toEqual(['true']);
    expect(values(unit, 'Service', 'ProtectSystem')).toEqual(['strict']);
    expect(values(unit, 'Service', 'ProtectHome')).toEqual(['read-only']);
    expect(values(unit, 'Service', 'ReadWritePaths')).toEqual([
      '/home/den/.config/quotameter /home/den/.local/share/quotameter',
    ]);
    // Journald output (§5.4) and system-unit install target.
    expect(values(unit, 'Service', 'StandardOutput')).toEqual(['journal']);
    expect(values(unit, 'Service', 'StandardError')).toEqual(['journal']);
    expect(values(unit, 'Install', 'WantedBy')).toEqual(['multi-user.target']);
  });

  it('ends with exactly one final newline and uses no carriage returns', () => {
    const unit = buildSystemUnit(input());
    expect(unit.endsWith('\n')).toBe(true);
    expect(unit.endsWith('\n\n')).toBe(false);
    expect(unit).not.toContain('\r');
  });

  it('exposes the spec §5.3 unit name and install path constants', () => {
    expect(SYSTEM_UNIT_NAME).toBe('quotameter.service');
    expect(SYSTEM_UNIT_INSTALL_PATH).toBe('/etc/systemd/system/quotameter.service');
  });
});

describe('buildSystemUnit input validation (§5.4/§5.1, injection guard)', () => {
  it('rejects relative or empty paths with the field named', () => {
    expect(() => buildSystemUnit(input({ nodePath: 'node' }))).toThrow(
      /nodePath must be an absolute path/,
    );
    expect(() => buildSystemUnit(input({ cliPath: 'bin/quotameter.mjs' }))).toThrow(
      /cliPath must be an absolute path/,
    );
    expect(() => buildSystemUnit(input({ configDir: '.config/quotameter' }))).toThrow(
      /configDir must be an absolute path/,
    );
    expect(() => buildSystemUnit(input({ dataDir: '' }))).toThrow(/dataDir must not be empty/);
  });

  it('rejects whitespace in paths instead of emitting a unit that needs quoting', () => {
    expect(() => buildSystemUnit(input({ nodePath: '/opt/node 22/bin/node' }))).toThrow(
      /nodePath must not contain whitespace or control characters/,
    );
    expect(() => buildSystemUnit(input({ configDir: '/home/den/.config/quotameter\t' }))).toThrow(
      /configDir must not contain whitespace or control characters/,
    );
    // DEL is the one forbidden character above 0x20.
    expect(() => buildSystemUnit(input({ nodePath: '/opt/node\x7f' }))).toThrow(
      /nodePath must not contain whitespace or control characters/,
    );
  });

  it('rejects newline injection through any path field', () => {
    const injected = '/usr/bin/node\nExecStart=/bin/sh -c pwned';
    expect(() => buildSystemUnit(input({ nodePath: injected }))).toThrow(
      /nodePath must not contain whitespace or control characters/,
    );
    const viaData = '/var/lib/quotameter\nReadWritePaths=/';
    expect(() => buildSystemUnit(input({ dataDir: viaData }))).toThrow(
      /dataDir must not contain whitespace or control characters/,
    );
  });

  it('rejects systemd metacharacters in paths instead of emitting unescaped semantics', () => {
    // A trailing backslash would escape the following space in ExecStart
    // and silently change its tokenization; %, $, and quotes are
    // specifiers/expansion/quoting — this generator does not escape any of
    // them, so such paths are a loud error (review round P1).
    expect(() => buildSystemUnit(input({ nodePath: '/usr/local/bin/node\\' }))).toThrow(
      /nodePath must not contain systemd metacharacters/,
    );
    expect(() => buildSystemUnit(input({ cliPath: '/opt/%h/quotameter.mjs' }))).toThrow(
      /cliPath must not contain systemd metacharacters/,
    );
    expect(() => buildSystemUnit(input({ configDir: '/home/$USER/.config/quotameter' }))).toThrow(
      /configDir must not contain systemd metacharacters/,
    );
    expect(() => buildSystemUnit(input({ dataDir: '/var/lib/"quotameter"' }))).toThrow(
      /dataDir must not contain systemd metacharacters/,
    );
    expect(() => buildSystemUnit(input({ nodePath: "/opt/node's/bin/node" }))).toThrow(
      /nodePath must not contain systemd metacharacters/,
    );
  });

  it("rejects 'root' as user or group (§5.1: never run as root)", () => {
    expect(() => buildSystemUnit(input({ user: 'root' }))).toThrow(/user must not be 'root'/);
    expect(() => buildSystemUnit(input({ group: 'root' }))).toThrow(/group must not be 'root'/);
  });

  it('rejects malformed user and group names', () => {
    expect(() => buildSystemUnit(input({ user: '' }))).toThrow(
      /user must be a valid user or group name/,
    );
    expect(() => buildSystemUnit(input({ user: '1den' }))).toThrow(
      /user must be a valid user or group name/,
    );
    expect(() => buildSystemUnit(input({ user: 'den\nUser=root' }))).toThrow(
      /user must be a valid user or group name/,
    );
    expect(() => buildSystemUnit(input({ group: 'ops team' }))).toThrow(
      /group must be a valid user or group name/,
    );
  });

  it('rejects a RestartSec that is not a whole number of seconds >= 1', () => {
    // 1e21 is an integer by Number.isInteger but stringifies exponentially
    // ("1e+21"), which would render a RestartSec the module's own validator
    // rejects — Number.isSafeInteger closes that hole (review round P2).
    for (const restartSecSeconds of [0, -5, 1.5, Number.NaN, 1e21]) {
      expect(() => buildSystemUnit(input({ restartSecSeconds }))).toThrow(
        /restartSecSeconds must be a whole number of seconds >= 1/,
      );
    }
  });

  it('validates shared path/user inputs directly (task 135 reuse)', () => {
    expect(() => assertUnitPathInput('cliPath', '/usr/bin/node')).not.toThrow();
    expect(() => assertUnitPathInput('cliPath', 'node')).toThrow(
      /cliPath must be an absolute path/,
    );
    expect(() => assertUnitUserInput('user', 'den')).not.toThrow();
    expect(() => assertUnitUserInput('user', 'root')).toThrow(/user must not be 'root'/);
    expect(() => assertUnitUserInput('group', '_apt')).not.toThrow();
  });
});

describe('renderUnitFile (the shared renderer, task 135 reuse)', () => {
  it('renders sections in order separated by blank lines with one final newline', () => {
    expect(
      renderUnitFile([
        ['Unit', ['A=1']],
        ['Service', ['B=2', 'C=3']],
      ]),
    ).toBe('[Unit]\nA=1\n\n[Service]\nB=2\nC=3\n');
  });

  it('refuses malformed section names, empty sections, and unusable directive lines', () => {
    expect(() => renderUnitFile([['Unit Space', ['A=1']]])).toThrow(/invalid section name/);
    expect(() => renderUnitFile([['Unit', []]])).toThrow(/has no directives/);
    expect(() => renderUnitFile([['Unit', ['not a directive']]])).toThrow(
      /unusable directive line/,
    );
    expect(() => renderUnitFile([['Unit', ['A=1\nB=2']]])).toThrow(/unusable directive line/);
    expect(() => renderUnitFile([['Unit', ['=1']]])).toThrow(/unusable directive line/);
    // Control characters that pass the 'Key=value' shape check (tab and DEL
    // both match `.`) are still refused — these exercise the renderer's
    // control-scan guard directly rather than the shape check.
    expect(() => renderUnitFile([['Unit', ['A=1\t2']]])).toThrow(/unusable directive line/);
    expect(() => renderUnitFile([['Unit', ['A=1\x7f']]])).toThrow(/unusable directive line/);
  });
});

describe('parseUnitFile (the read-back path for doctor, task 145)', () => {
  it('parses sections, directives, and values containing equals signs', () => {
    const { sections, directives, problems } = parseUnitFile(
      '[Unit]\nAfter=network-online.target\n[Service]\nEnvironment=NODE_ENV=production\n',
    );
    expect(problems).toEqual([]);
    expect(sections).toEqual([
      { name: 'Unit', line: 1 },
      { name: 'Service', line: 3 },
    ]);
    expect(directives).toEqual([
      { section: 'Unit', key: 'After', value: 'network-online.target', line: 2 },
      { section: 'Service', key: 'Environment', value: 'NODE_ENV=production', line: 4 },
    ]);
  });

  it('collects section headers verbatim, whitespace included', () => {
    // systemd does not trim inside the brackets: "[ Service ]" is a
    // different, unknown section, and the parser must not normalize it into
    // "[Service]" (review round P1).
    const { sections } = parseUnitFile('[Service]\nUser=den\n[ Service ]\n');
    expect(sections.map((s) => s.name)).toEqual(['Service', ' Service ']);
  });

  it('skips comments, blank lines, and a leading BOM, and ignores all whitespace after the equals sign', () => {
    const content =
      '\uFEFF# a comment\n; another\n\n[Unit]\nDescription = Quotameter - monitoring\nWants=  network-online.target';
    const { directives, problems } = parseUnitFile(content);
    expect(problems).toEqual([]);
    expect(directives).toEqual([
      { section: 'Unit', key: 'Description', value: 'Quotameter - monitoring', line: 5 },
      // systemd.syntax: "Whitespace immediately before or after the '=' is
      // ignored" — every leading space/tab is stripped, not just one
      // (review round P1).
      { section: 'Unit', key: 'Wants', value: 'network-online.target', line: 6 },
    ]);
    const tabs = parseUnitFile('[Unit]\nWants=\t\t network-online.target\n');
    expect(tabs.directives[0]?.value).toBe('network-online.target');
  });

  it('normalizes CRLF and lone CR line endings', () => {
    const { directives, problems } = parseUnitFile('[Unit]\r\nAfter=x\rWants=y');
    expect(problems).toEqual([]);
    expect(directives.map((d) => d.key)).toEqual(['After', 'Wants']);
    expect(directives.every((d) => !d.value.includes('\r'))).toBe(true);
  });

  it('joins continuations per systemd.syntax: backslash becomes a space, comment blocks are skipped', () => {
    // No space before the backslash: the replacement space is the only one.
    const tight = parseUnitFile('[Service]\nReadWritePaths=/a\\\n/b\n');
    expect(tight.problems).toEqual([]);
    expect(tight.directives[0]?.value).toBe('/a /b');

    // A space before the backslash survives beside the replacement space.
    const padded = parseUnitFile('[Service]\nReadWritePaths=/a \\\n/b\n');
    expect(padded.directives[0]?.value).toBe('/a  /b');

    // A comment block between continued lines is ignored — the continuation
    // joins whatever follows it (the systemd.syntax example shape).
    const commented = parseUnitFile(
      '[Service]\nReadWritePaths=/a\\\n# ignored\n; also ignored\n/b\n',
    );
    expect(commented.problems).toEqual([]);
    expect(commented.directives[0]?.value).toBe('/a /b');

    // A continuation whose comment block runs to end of file ends the value
    // there (the replacement space is trimmed as trailing whitespace; no
    // trailing newline, so the comment block really is the last thing).
    const eofComments = parseUnitFile('[Service]\nReadWritePaths=/a\\\n# only comments follow');
    expect(eofComments.problems).toEqual([]);
    expect(eofComments.directives[0]?.value).toBe('/a');

    // Two trailing backslashes are an escaped backslash, not a continuation.
    const escaped = parseUnitFile('[Service]\nExecStart=/opt/node\\\\\nRestart=on-failure\n');
    expect(escaped.problems).toEqual([]);
    expect(escaped.directives.map((d) => d.key)).toEqual(['ExecStart', 'Restart']);
  });

  it('reports malformed lines, keys, headers, and directives before any section', () => {
    const { directives, problems } = parseUnitFile(
      'Before=section\n[Unit\nJustText\nA B=1\n[Unit]\nAfter=x\n',
    );
    expect(directives).toEqual([{ section: 'Unit', key: 'After', value: 'x', line: 6 }]);
    expect(problems).toEqual([
      'line 1: directive "Before" appears before any section',
      // A header that opens but never closes is malformed; note that
      // "[Unit x]" would NOT be — systemd allows spaces in section names.
      'line 2: malformed section header "[Unit"',
      'line 3: not a \'Key=value\' directive: "JustText"',
      'line 4: malformed directive key "A B"',
    ]);
  });
});

describe('validateSystemUnit (structural validation, the done-condition)', () => {
  it('accepts the generated system unit with and without a group', () => {
    expect(validateSystemUnit(buildSystemUnit(input()))).toEqual([]);
    expect(validateSystemUnit(buildSystemUnit(input({ group: 'quotameter' })))).toEqual([]);
    expect(validateSystemUnit(buildSystemUnit(input({ restartSecSeconds: 30 })))).toEqual([]);
  });

  it('reports missing §5.4 contract directives', () => {
    for (const line of [
      'After=network-online.target\n',
      'Wants=network-online.target\n',
      'Restart=on-failure\n',
      'RestartSec=5s\n',
      'Environment=NODE_ENV=production\n',
      'NoNewPrivileges=true\n',
      'PrivateTmp=true\n',
      'ProtectSystem=strict\n',
      'ProtectHome=read-only\n',
      'ReadWritePaths=/home/den/.config/quotameter /home/den/.local/share/quotameter\n',
      'StandardOutput=journal\n',
    ]) {
      const broken = buildSystemUnit(input()).replace(line, '');
      expect(validateSystemUnit(broken), `after removing ${JSON.stringify(line)}`).toEqual(
        expect.arrayContaining([expect.stringMatching(/is missing the required directive/)]),
      );
    }

    const noInstall = buildSystemUnit(input()).replace(
      '\n[Install]\nWantedBy=multi-user.target\n',
      '\n',
    );
    expect(validateSystemUnit(noInstall)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\[Install\] is missing the required directive WantedBy=/),
      ]),
    );
  });

  it('reports wrong-valued contract directives', () => {
    const cases: readonly [string, string, RegExp][] = [
      [
        'After=network-online.target',
        'After=network.target',
        /After= is "network\.target", expected "network-online\.target"/,
      ],
      ['Type=exec', 'Type=simple', /Type= is "simple", expected "exec"/],
      ['Restart=on-failure', 'Restart=always', /Restart= is "always", expected "on-failure"/],
      ['RestartSec=5s', 'RestartSec=soon', /RestartSec= is "soon", expected a systemd time span/],
      // "m" alone is not a systemd time unit ("min" is) — systemd.time(7).
      ['RestartSec=5s', 'RestartSec=1m', /RestartSec= is "1m", expected a systemd time span/],
      ['ProtectSystem=strict', 'ProtectSystem=full', /ProtectSystem= is "full", expected "strict"/],
      ['ProtectHome=read-only', 'ProtectHome=yes', /ProtectHome= is "yes", expected "read-only"/],
      [
        'NoNewPrivileges=true',
        'NoNewPrivileges=false',
        /NoNewPrivileges= is "false", expected a true value/,
      ],
      [
        'StandardOutput=journal',
        'StandardOutput=syslog',
        /StandardOutput= is "syslog", expected "journal"/,
      ],
      [
        'WantedBy=multi-user.target',
        'WantedBy=graphical.target',
        /WantedBy= is "graphical\.target", expected "multi-user\.target"/,
      ],
    ];
    for (const [from, to, pattern] of cases) {
      const broken = replaceLine(buildSystemUnit(input()), from, to);
      expect(validateSystemUnit(broken), `after ${from} -> ${to}`).toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('accepts the alternative systemd boolean spellings for hardening flags', () => {
    const unit = replaceLine(
      buildSystemUnit(input()),
      'NoNewPrivileges=true',
      'NoNewPrivileges=yes',
    ).replace('PrivateTmp=true', 'PrivateTmp=on');
    expect(validateSystemUnit(unit)).toEqual([]);
  });

  it('accepts plain-digit and other systemd time units for RestartSec', () => {
    expect(
      validateSystemUnit(replaceLine(buildSystemUnit(input()), 'RestartSec=5s', 'RestartSec=30')),
    ).toEqual([]);
    expect(
      validateSystemUnit(replaceLine(buildSystemUnit(input()), 'RestartSec=5s', 'RestartSec=2d')),
    ).toEqual([]);
  });

  it('rejects User=root, empty, and numeric-id User/Group values (§5.1)', () => {
    const root = replaceLine(buildSystemUnit(input()), 'User=den', 'User=root');
    expect(validateSystemUnit(root)).toEqual(
      expect.arrayContaining([expect.stringMatching(/User= is "root"/)]),
    );
    const emptyUser = replaceLine(buildSystemUnit(input()), 'User=den', 'User=');
    expect(validateSystemUnit(emptyUser)).toEqual(
      expect.arrayContaining([expect.stringMatching(/User= is empty/)]),
    );
    const rootGroup = replaceLine(
      buildSystemUnit(input({ group: 'ops' })),
      'Group=ops',
      'Group=root',
    );
    expect(validateSystemUnit(rootGroup)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Group= is "root"/)]),
    );
    // systemd accepts numeric ids, and id 0 is root by another spelling
    // (review round P1).
    const uidZero = replaceLine(buildSystemUnit(input()), 'User=den', 'User=0');
    expect(validateSystemUnit(uidZero)).toEqual(
      expect.arrayContaining([expect.stringMatching(/User= is a numeric id \("0"\)/)]),
    );
    const gidZero = replaceLine(buildSystemUnit(input({ group: 'ops' })), 'Group=ops', 'Group=0');
    expect(validateSystemUnit(gidZero)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Group= is a numeric id \("0"\)/)]),
    );
  });

  it('requires ExecStart to be "<absolute node> <absolute CLI> run"', () => {
    const originalExecStart =
      'ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run';
    const cases: readonly [string, RegExp][] = [
      [
        'ExecStart=node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
        /first token is not an absolute path/,
      ],
      [
        'ExecStart=/usr/local/bin/node bin/quotameter.mjs run',
        /second token is not an absolute path/,
      ],
      [
        'ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs serve',
        /third token is "serve", expected "run"/,
      ],
      ['ExecStart=/usr/local/bin/node', /expected exactly "<node> <cli> run"/],
      [
        'ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run --verbose',
        /expected exactly "<node> <cli> run"/,
      ],
    ];
    for (const [execStart, pattern] of cases) {
      const broken = replaceLine(buildSystemUnit(input()), originalExecStart, execStart);
      expect(validateSystemUnit(broken), `ExecStart case ${execStart}`).toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('requires ReadWritePaths entries to be absolute, never "/", and exactly the expected pair when supplied', () => {
    const goodPair = '/home/den/.config/quotameter /home/den/.local/share/quotameter';
    const unit = buildSystemUnit(input());

    // Without expected directories: absolute entries, and never a bare "/"
    // (which would undo ProtectSystem=strict — review round P1).
    const relative = replaceLine(
      unit,
      `ReadWritePaths=${goodPair}`,
      'ReadWritePaths=/home/den/.config/quotameter var/lib/quotameter',
    );
    expect(validateSystemUnit(relative)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /ReadWritePaths= contains non-absolute entries: "var\/lib\/quotameter"/,
        ),
      ]),
    );
    const wholeTree = replaceLine(unit, `ReadWritePaths=${goodPair}`, 'ReadWritePaths=/');
    expect(validateSystemUnit(wholeTree)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ReadWritePaths= contains "\/", which undoes ProtectSystem=strict/),
      ]),
    );

    // With expected directories: exactly the generated pair, in order.
    const expected = { configDir: input().configDir, dataDir: input().dataDir };
    expect(validateSystemUnit(unit, expected)).toEqual([]);
    const swapped = replaceLine(
      unit,
      `ReadWritePaths=${goodPair}`,
      'ReadWritePaths=/home/den/.local/share/quotameter /home/den/.config/quotameter',
    );
    expect(validateSystemUnit(swapped, expected)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/expected exactly .*the generated config\/data pair/),
      ]),
    );
    const extra = replaceLine(
      unit,
      `ReadWritePaths=${goodPair}`,
      `ReadWritePaths=${goodPair} /var/lib/elsewhere`,
    );
    expect(validateSystemUnit(extra, expected)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/expected exactly .*the generated config\/data pair/),
      ]),
    );
  });

  it('rejects any Environment= line beyond NODE_ENV=production without echoing its value (no-secrets guard, §5.4/§15.4)', () => {
    const smuggled = replaceLine(
      buildSystemUnit(input()),
      'Environment=NODE_ENV=production',
      'Environment=QUOTAMETER_API_KEY=sk-secret-value',
    );
    const problems = validateSystemUnit(smuggled);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Environment= differs from the required "NODE_ENV=production"/),
      ]),
    );
    // The divergent value — potentially a secret — must not reach any
    // problem string (review round P0).
    for (const problem of problems) {
      expect(problem).not.toContain('sk-secret-value');
      expect(problem).not.toContain('QUOTAMETER_API_KEY');
    }
  });

  it('rejects unexpected directives, sections (empty ones included), and duplicate keys', () => {
    const withExtra = replaceLine(
      buildSystemUnit(input()),
      'StandardError=journal',
      'StandardError=journal\nEnvironmentFile=/etc/quotameter/secrets',
    );
    expect(validateSystemUnit(withExtra)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unexpected directive EnvironmentFile= in \[Service\]/),
      ]),
    );

    const withSocket = `${buildSystemUnit(input())}\n[Socket]\nListenStream=8787\n`;
    expect(validateSystemUnit(withSocket)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[Socket\]/)]),
    );

    // An empty unknown section is flagged too: the header walk, not the
    // directives, carries the strict-shape contract (review round P2).
    const emptySocket = `${buildSystemUnit(input())}\n[Socket]\n`;
    expect(validateSystemUnit(emptySocket)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[Socket\]/)]),
    );

    // Whitespace inside a section header makes it a different, unknown
    // section to systemd — the parser keeps it verbatim, and the checker
    // must not normalize it into "[Service]" (review round P1).
    const padded = replaceLine(buildSystemUnit(input()), '[Service]', '[ Service ]');
    expect(validateSystemUnit(padded)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[ Service \]/)]),
    );

    const duplicated = replaceLine(buildSystemUnit(input()), 'User=den', 'User=den\nUser=den');
    expect(validateSystemUnit(duplicated)).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate directive User= in \[Service\]/)]),
    );
  });

  it('surfaces parse problems of malformed unit content', () => {
    expect(parseUnitFile('nonsense\n').problems).toEqual([
      `line 1: not a 'Key=value' directive: "nonsense"`,
    ]);
    expect(parseUnitFile('After=x\n[Unit]\n').problems).toEqual([
      'line 1: directive "After" appears before any section',
    ]);
    expect(validateSystemUnit('nonsense\n').length).toBeGreaterThan(0);
  });
});
