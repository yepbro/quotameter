import { describe, expect, it } from 'vitest';
import {
  USER_UNIT_NAME,
  buildUserUnit,
  userUnitInstallPath,
  validateUserUnit,
} from '../../src/cli/systemd-user-unit';
import type { UserUnitInput } from '../../src/cli/systemd-user-unit';
import { buildSystemUnit, parseUnitFile, validateSystemUnit } from '../../src/cli/systemd-unit';
import type { SystemUnitInput } from '../../src/cli/systemd-unit';

/**
 * The systemd user unit generator (task 135, spec §5.3 step 7 / §5.4,
 * decision D-104) — the twin of `cli-systemd-unit.spec.ts`.
 *
 * Validation is structural by design (the development container and CI ship
 * no systemd), so the done-condition "generated unit is valid and contains
 * no secrets" is delivered as the exact-content snapshot plus
 * {@link validateUserUnit}, the invariant checker that reads the unit back
 * through the same parser `doctor` will use on installed units. The
 * user-unit-specific half of the contract — every system-only directive
 * correctly absent, the user hardening set compatible with the unprivileged
 * manager — is asserted structurally (parsed directive keys, not string
 * containment), and the closing cross-check proves the system and user
 * contracts are genuinely distinct: each validator rejects the other twin's
 * unit.
 */

/** Representative valid input; unit tests override single fields. */
function input(overrides: Partial<UserUnitInput> = {}): UserUnitInput {
  return {
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/quotameter/bin/quotameter.mjs',
    restartSecSeconds: 5,
    ...overrides,
  };
}

/** The complete expected user unit for {@link input} — the snapshot contract. */
const EXPECTED_UNIT = `[Unit]
Description=Quotameter - usage quota monitoring for AI subscriptions
Documentation=https://github.com/yepbro/quotameter
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

/** The system-only directives §5.4 assigns to system units (D-104). */
const SYSTEM_ONLY_DIRECTIVES = [
  'User',
  'Group',
  'PrivateTmp',
  'ProtectSystem',
  'ProtectHome',
  'ReadWritePaths',
] as const;

/** A representative system-unit input for the cross-contract checks. */
function systemInput(): SystemUnitInput {
  return {
    nodePath: input().nodePath,
    cliPath: input().cliPath,
    user: 'den',
    restartSecSeconds: 5,
    configDir: '/home/den/.config/quotameter',
    dataDir: '/home/den/.local/share/quotameter',
  };
}

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

describe('buildUserUnit content (spec §5.3/§5.4 snapshot)', () => {
  it('renders the exact §5.4 user unit for the given inputs', () => {
    expect(buildUserUnit(input())).toBe(EXPECTED_UNIT);
  });

  it('is deterministic: the same inputs render byte-identical content', () => {
    expect(buildUserUnit(input())).toBe(buildUserUnit(input()));
  });

  it('pins absolute Node and CLI paths in ExecStart with the run command', () => {
    expect(values(buildUserUnit(input()), 'Service', 'ExecStart')).toEqual([
      '/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run',
    ]);
  });

  it('orders after and wants network-online.target and sets the restart policy', () => {
    const unit = buildUserUnit(input());
    expect(values(unit, 'Unit', 'After')).toEqual(['network-online.target']);
    expect(values(unit, 'Unit', 'Wants')).toEqual(['network-online.target']);
    expect(values(unit, 'Service', 'Restart')).toEqual(['on-failure']);
    expect(values(unit, 'Service', 'Environment')).toEqual(['NODE_ENV=production']);
  });

  it('renders the configurable RestartSec from the input', () => {
    expect(
      values(buildUserUnit(input({ restartSecSeconds: 30 })), 'Service', 'RestartSec'),
    ).toEqual(['30s']);
    expect(values(buildUserUnit(input({ restartSecSeconds: 1 })), 'Service', 'RestartSec')).toEqual(
      ['1s'],
    );
  });

  it('applies the compatible minimal hardening set: NoNewPrivileges only', () => {
    const unit = buildUserUnit(input());
    expect(values(unit, 'Service', 'NoNewPrivileges')).toEqual(['true']);
    // Structural absence of every system-only directive: the parsed
    // directive keys of the whole unit, not string containment (D-104).
    const keys = parseUnitFile(unit).directives.map((d) => d.key);
    for (const key of SYSTEM_ONLY_DIRECTIVES) {
      expect(keys, `directive ${key}= must be absent from the user unit`).not.toContain(key);
    }
    // And the exact [Service] shape, in render order.
    expect(
      parseUnitFile(unit)
        .directives.filter((d) => d.section === 'Service')
        .map((d) => d.key),
    ).toEqual([
      'Type',
      'ExecStart',
      'Environment',
      'Restart',
      'RestartSec',
      'NoNewPrivileges',
      'StandardOutput',
      'StandardError',
    ]);
  });

  it('sends output to journald and enables into the user manager default target', () => {
    const unit = buildUserUnit(input());
    expect(values(unit, 'Service', 'StandardOutput')).toEqual(['journal']);
    expect(values(unit, 'Service', 'StandardError')).toEqual(['journal']);
    // The user manager ships default.target and no multi-user.target (D-104).
    expect(values(unit, 'Install', 'WantedBy')).toEqual(['default.target']);
  });

  it('ends with exactly one final newline and uses no carriage returns', () => {
    const unit = buildUserUnit(input());
    expect(unit.endsWith('\n')).toBe(true);
    expect(unit.endsWith('\n\n')).toBe(false);
    expect(unit).not.toContain('\r');
  });

  it('exposes the user unit name constant (same name, separate namespace)', () => {
    expect(USER_UNIT_NAME).toBe('quotameter.service');
  });
});

describe('userUnitInstallPath (spec §5.3 step 7)', () => {
  it('composes the spec-literal ~/.config/systemd/user path under a home directory', () => {
    expect(userUnitInstallPath('/home/den')).toBe(
      '/home/den/.config/systemd/user/quotameter.service',
    );
    // path.join normalizes a trailing separator in the home directory.
    expect(userUnitInstallPath('/home/den/')).toBe(
      '/home/den/.config/systemd/user/quotameter.service',
    );
  });

  it('rejects non-absolute homes with the field named (shared injection guard)', () => {
    expect(() => userUnitInstallPath('den')).toThrow(/homeDir must be an absolute path/);
    expect(() => userUnitInstallPath('~/')).toThrow(/homeDir must be an absolute path/);
    expect(() => userUnitInstallPath('')).toThrow(/homeDir must not be empty/);
  });

  it('rejects whitespace, newline injection, and systemd metacharacters', () => {
    expect(() => userUnitInstallPath('/home/den smith')).toThrow(
      /homeDir must not contain whitespace or control characters/,
    );
    expect(() => userUnitInstallPath('/home/den\nExecStart=/bin/sh')).toThrow(
      /homeDir must not contain whitespace or control characters/,
    );
    expect(() => userUnitInstallPath('/home/%h')).toThrow(
      /homeDir must not contain systemd metacharacters/,
    );
  });
});

describe('buildUserUnit input validation (§5.4, injection guard)', () => {
  it('rejects relative or empty paths with the field named', () => {
    expect(() => buildUserUnit(input({ nodePath: 'node' }))).toThrow(
      /nodePath must be an absolute path/,
    );
    expect(() => buildUserUnit(input({ cliPath: 'bin/quotameter.mjs' }))).toThrow(
      /cliPath must be an absolute path/,
    );
    expect(() => buildUserUnit(input({ cliPath: '' }))).toThrow(/cliPath must not be empty/);
  });

  it('rejects whitespace in paths instead of emitting a unit that needs quoting', () => {
    expect(() => buildUserUnit(input({ nodePath: '/opt/node 22/bin/node' }))).toThrow(
      /nodePath must not contain whitespace or control characters/,
    );
    // DEL is the one forbidden character above 0x20.
    expect(() =>
      buildUserUnit(input({ cliPath: '/opt/quotameter\x7f/bin/quotameter.mjs' })),
    ).toThrow(/cliPath must not contain whitespace or control characters/);
  });

  it('rejects newline injection through any path field', () => {
    const injected = '/usr/bin/node\nExecStart=/bin/sh -c pwned';
    expect(() => buildUserUnit(input({ nodePath: injected }))).toThrow(
      /nodePath must not contain whitespace or control characters/,
    );
    const viaCli = '/usr/lib/quotameter.mjs\nEnvironment=QUOTAMETER_API_KEY=sk-secret';
    expect(() => buildUserUnit(input({ cliPath: viaCli }))).toThrow(
      /cliPath must not contain whitespace or control characters/,
    );
  });

  it('rejects systemd metacharacters in paths instead of emitting unescaped semantics', () => {
    expect(() => buildUserUnit(input({ nodePath: '/usr/local/bin/node\\' }))).toThrow(
      /nodePath must not contain systemd metacharacters/,
    );
    expect(() => buildUserUnit(input({ cliPath: '/opt/%h/quotameter.mjs' }))).toThrow(
      /cliPath must not contain systemd metacharacters/,
    );
    expect(() => buildUserUnit(input({ nodePath: '/opt/$NODE_HOME/bin/node' }))).toThrow(
      /nodePath must not contain systemd metacharacters/,
    );
  });

  it('rejects a RestartSec that is not a whole number of seconds >= 1', () => {
    // 1e21 stringifies exponentially ("1e+21") and would render a RestartSec
    // the module's own validator rejects — shared safe-integer guard.
    for (const restartSecSeconds of [0, -5, 1.5, Number.NaN, 1e21]) {
      expect(() => buildUserUnit(input({ restartSecSeconds }))).toThrow(
        /restartSecSeconds must be a whole number of seconds >= 1/,
      );
    }
  });
});

describe('validateUserUnit (structural validation, the done-condition)', () => {
  it('accepts the generated user unit', () => {
    expect(validateUserUnit(buildUserUnit(input()))).toEqual([]);
    expect(validateUserUnit(buildUserUnit(input({ restartSecSeconds: 30 })))).toEqual([]);
  });

  it('reports missing §5.4 contract directives', () => {
    for (const line of [
      'After=network-online.target\n',
      'Wants=network-online.target\n',
      'Type=exec\n',
      'Environment=NODE_ENV=production\n',
      'Restart=on-failure\n',
      'RestartSec=5s\n',
      'NoNewPrivileges=true\n',
      'StandardOutput=journal\n',
      'StandardError=journal\n',
    ]) {
      const broken = buildUserUnit(input()).replace(line, '');
      expect(validateUserUnit(broken), `after removing ${JSON.stringify(line)}`).toEqual(
        expect.arrayContaining([expect.stringMatching(/is missing the required directive/)]),
      );
    }

    // ExecStart has no constant spelling to remove — drop its line by anchor.
    const noExecStart = buildUserUnit(input()).replace(
      'ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/quotameter/bin/quotameter.mjs run\n',
      '',
    );
    expect(validateUserUnit(noExecStart)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\[Service\] is missing the required directive ExecStart=/),
      ]),
    );

    const noInstall = buildUserUnit(input()).replace(
      '\n[Install]\nWantedBy=default.target\n',
      '\n',
    );
    expect(validateUserUnit(noInstall)).toEqual(
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
      // The system unit's enable target is not the user manager's
      // (multi-user.target does not exist there — D-104).
      [
        'WantedBy=default.target',
        'WantedBy=multi-user.target',
        /WantedBy= is "multi-user\.target", expected "default\.target"/,
      ],
    ];
    for (const [from, to, pattern] of cases) {
      const broken = replaceLine(buildUserUnit(input()), from, to);
      expect(validateUserUnit(broken), `after ${from} -> ${to}`).toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('accepts the alternative systemd boolean spellings for NoNewPrivileges', () => {
    const unit = replaceLine(buildUserUnit(input()), 'NoNewPrivileges=true', 'NoNewPrivileges=yes');
    expect(validateUserUnit(unit)).toEqual([]);
  });

  it('accepts plain-digit and other systemd time units for RestartSec', () => {
    expect(
      validateUserUnit(replaceLine(buildUserUnit(input()), 'RestartSec=5s', 'RestartSec=30')),
    ).toEqual([]);
    expect(
      validateUserUnit(replaceLine(buildUserUnit(input()), 'RestartSec=5s', 'RestartSec=2d')),
    ).toEqual([]);
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
      const broken = replaceLine(buildUserUnit(input()), originalExecStart, execStart);
      expect(validateUserUnit(broken), `ExecStart case ${execStart}`).toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('rejects any Environment= line beyond NODE_ENV=production without echoing its value (no-secrets guard, §5.4/§15.4)', () => {
    const smuggled = replaceLine(
      buildUserUnit(input()),
      'Environment=NODE_ENV=production',
      'Environment=QUOTAMETER_API_KEY=sk-secret-value',
    );
    const problems = validateUserUnit(smuggled);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Environment= differs from the required "NODE_ENV=production"/),
      ]),
    );
    // The divergent value — potentially a secret — must not reach any
    // problem string.
    for (const problem of problems) {
      expect(problem).not.toContain('sk-secret-value');
      expect(problem).not.toContain('QUOTAMETER_API_KEY');
    }
  });

  it('rejects every system-only directive as unexpected in the user unit (D-104)', () => {
    // The most likely real-world corruption: a system unit pasted into
    // ~/.config/systemd/user/ and hand-trimmed. Each of §5.4's system-only
    // directives must be rejected, never silently reinterpreted.
    const insertions: readonly [string, RegExp][] = [
      ['User=den', /unexpected directive User= in \[Service\]/],
      ['Group=ops', /unexpected directive Group= in \[Service\]/],
      ['PrivateTmp=true', /unexpected directive PrivateTmp= in \[Service\]/],
      ['ProtectSystem=strict', /unexpected directive ProtectSystem= in \[Service\]/],
      ['ProtectHome=read-only', /unexpected directive ProtectHome= in \[Service\]/],
      [
        'ReadWritePaths=/home/den/.config/quotameter /home/den/.local/share/quotameter',
        /unexpected directive ReadWritePaths= in \[Service\]/,
      ],
    ];
    for (const [directive, pattern] of insertions) {
      const broken = replaceLine(buildUserUnit(input()), 'Type=exec', `Type=exec\n${directive}`);
      expect(validateUserUnit(broken), `after inserting ${directive}`).toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });

  it('rejects unexpected directives, sections (empty ones included), and duplicate keys', () => {
    const withExtra = replaceLine(
      buildUserUnit(input()),
      'StandardError=journal',
      'StandardError=journal\nEnvironmentFile=/etc/quotameter/secrets',
    );
    expect(validateUserUnit(withExtra)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unexpected directive EnvironmentFile= in \[Service\]/),
      ]),
    );

    const withSocket = `${buildUserUnit(input())}\n[Socket]\nListenStream=8787\n`;
    expect(validateUserUnit(withSocket)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[Socket\]/)]),
    );

    const emptySocket = `${buildUserUnit(input())}\n[Socket]\n`;
    expect(validateUserUnit(emptySocket)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[Socket\]/)]),
    );

    // Whitespace inside a section header makes it a different, unknown
    // section to systemd — the parser keeps it verbatim, and the checker
    // must not normalize it into "[Service]".
    const padded = replaceLine(buildUserUnit(input()), '[Service]', '[ Service ]');
    expect(validateUserUnit(padded)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unexpected section \[ Service \]/)]),
    );

    const duplicated = replaceLine(buildUserUnit(input()), 'Type=exec', 'Type=exec\nType=exec');
    expect(validateUserUnit(duplicated)).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate directive Type= in \[Service\]/)]),
    );
  });

  it('surfaces parse problems of malformed unit content', () => {
    expect(validateUserUnit('nonsense\n').length).toBeGreaterThan(0);
    expect(validateUserUnit('After=x\n[Unit]\n').length).toBeGreaterThan(0);
  });

  it('treats Object.prototype-derived section names as unexpected, not as crashes (review round P1)', () => {
    // `in` and a bare bracket lookup both see inherited properties: a unit
    // section named `toString`/`constructor`/`__proto__` used to pass the
    // known-section check and then crash the directive walk on the
    // inherited function/object (`allowed.includes is not a function`) —
    // the shared engine must own-property-check both lookups and report
    // the section as unexpected instead. Both entry points, one engine.
    for (const section of ['toString', 'constructor', '__proto__']) {
      const hostile = `[${section}]\nA=1\n`;
      expect(() => validateUserUnit(hostile), `validateUserUnit on [${section}]`).not.toThrow();
      expect(validateUserUnit(hostile)).toEqual(
        expect.arrayContaining([expect.stringMatching(/unexpected section/)]),
      );
      expect(() => validateSystemUnit(hostile), `validateSystemUnit on [${section}]`).not.toThrow();
      expect(validateSystemUnit(hostile)).toEqual(
        expect.arrayContaining([expect.stringMatching(/unexpected section/)]),
      );
    }
  });
});

describe('the user and system unit contracts are distinct (cross-check)', () => {
  it('the system validator rejects the generated user unit', () => {
    const problems = validateSystemUnit(buildUserUnit(input()));
    // The system-only directives are missing from the user unit, and its
    // enable target is the user manager's, not the system's.
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\[Service\] is missing the required directive User=/),
        expect.stringMatching(/\[Service\] is missing the required directive PrivateTmp=/),
        expect.stringMatching(/\[Service\] is missing the required directive ProtectSystem=/),
        expect.stringMatching(/\[Service\] is missing the required directive ProtectHome=/),
        expect.stringMatching(/\[Service\] is missing the required directive ReadWritePaths=/),
        expect.stringMatching(/WantedBy= is "default\.target", expected "multi-user\.target"/),
      ]),
    );
  });

  it('the user validator rejects the generated system unit', () => {
    const problems = validateUserUnit(buildSystemUnit(systemInput()));
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unexpected directive User= in \[Service\]/),
        expect.stringMatching(/unexpected directive PrivateTmp= in \[Service\]/),
        expect.stringMatching(/unexpected directive ProtectSystem= in \[Service\]/),
        expect.stringMatching(/unexpected directive ProtectHome= in \[Service\]/),
        expect.stringMatching(/unexpected directive ReadWritePaths= in \[Service\]/),
        expect.stringMatching(/WantedBy= is "multi-user\.target", expected "default\.target"/),
      ]),
    );
  });
});
