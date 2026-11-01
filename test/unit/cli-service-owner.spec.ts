import { describe, expect, it } from 'vitest';
import {
  ETC_PASSWD_PATH,
  PRIVILEGED_SYSTEMD_OPERATIONS,
  isPrivilegedSystemdOperation,
  parsePasswdFile,
  readEtcPasswd,
  resolveServiceOwner,
  type PasswdEntry,
  type ServiceOwnerSeams,
} from '../../src/cli/service-owner';

/**
 * The service-owner decision layer (task 136, spec §5.3 steps 1 and 7,
 * decision D-105) — the ownership/privilege seam tasks 137–139 consume.
 *
 * The done-condition "the service does not run as root" is delivered as a
 * structural property of the resolver: every ok outcome carries a non-root
 * owner, and a root process without a verifiable SUDO_USER resolves to
 * problems instead of a guessed account. All contexts are driven through
 * the injected seams (uid, environment, user database) — the container and
 * CI run unprivileged with no sudo and no systemd, and the layer must be
 * testable without them. The never-root invariant over arbitrary inputs is
 * pinned separately by `cli-service-owner.property.spec.ts`.
 */

/** Representative regular account; tests override single fields. */
function entry(overrides: Partial<PasswdEntry> = {}): PasswdEntry {
  return { name: 'den', uid: 1001, gid: 1001, home: '/home/den', ...overrides };
}

/** A small realistic user database: root plus two regular accounts. */
function database(): readonly PasswdEntry[] {
  return [
    entry({ name: 'root', uid: 0, gid: 0, home: '/root' }),
    entry(),
    entry({ name: 'kim', uid: 1002, gid: 1002, home: '/home/kim' }),
  ];
}

/** Seams defaulting to the regular user `den`; tests override single fields. */
function seams(overrides: Partial<ServiceOwnerSeams> = {}): ServiceOwnerSeams {
  return { getuid: () => 1001, env: {}, passwd: () => database(), ...overrides };
}

describe('resolveServiceOwner — regular user (uid !== 0)', () => {
  it('resolves the current user from the database with no privileges held', () => {
    const result = resolveServiceOwner(seams());
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'regular-user', privileges: 'none', user: entry() },
    });
  });

  it('never consults SUDO_* at a non-root uid — exported leftovers are ignored', () => {
    const result = resolveServiceOwner(
      seams({
        env: { SUDO_USER: 'root', SUDO_UID: '0', SUDO_GID: '0' },
      }),
    );
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'regular-user', privileges: 'none', user: entry() },
    });
  });

  it('resolves the first entry matching the current uid', () => {
    const alias = entry({ name: 'den-alias', gid: 1009 });
    const result = resolveServiceOwner(seams({ passwd: () => [alias, ...database()] }));
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'regular-user', privileges: 'none', user: alias },
    });
  });

  it('fails when the current uid has no database entry', () => {
    const result = resolveServiceOwner(seams({ getuid: () => 4242 }));
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('uid 4242');
    expect(result.problems[0]).toContain('no entry in the user database');
  });

  it('fails when the current uid maps to a root-named entry (§5.1)', () => {
    const corrupt = entry({ name: 'root', uid: 1500 });
    const result = resolveServiceOwner(
      seams({ getuid: () => 1500, passwd: () => [database()[0]!, corrupt] }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('"root"');
    expect(result.problems[0]).toContain('never run as root');
  });

  it('refuses duplicate account names whose first-by-name entry is root (review P0)', () => {
    // uid lookup selects the uid-1001 row, but a generated `User=den`
    // would make systemd resolve the FIRST `den` row — uid 0 — and run
    // the service as root. The name must round-trip to the selected
    // entry, or ownership is refused.
    const rootAlias = entry({ name: 'den', uid: 0, gid: 0, home: '/root' });
    const result = resolveServiceOwner(
      seams({ passwd: () => [database()[0]!, rootAlias, entry()] }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('ambiguous');
    expect(result.problems[0]).toContain('"den"');
    expect(result.problems[0]).toContain('possibly root');
  });

  it('refuses duplicate account names that attribute the unit to another account', () => {
    // Same shape without any root entry: the first `den` row is another
    // account (uid 1002), so `User=den` would run the service as that
    // account instead of the current user.
    const other = entry({ name: 'den', uid: 1002, gid: 1002, home: '/home/other' });
    const result = resolveServiceOwner(seams({ passwd: () => [other, ...database()] }));
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('ambiguous');
  });

  it('accepts the same entry object listed twice (the name still round-trips)', () => {
    const den = entry();
    const result = resolveServiceOwner(seams({ passwd: () => [den, den] }));
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'regular-user', privileges: 'none', user: den },
    });
  });

  it('fails when the uid cannot be determined (non-POSIX runtime)', () => {
    const result = resolveServiceOwner(seams({ getuid: () => undefined }));
    expect(result).toEqual({
      state: 'problems',
      problems: [
        'cannot determine the uid of the running process — the service owner cannot be resolved',
      ],
    });
  });
});

describe('resolveServiceOwner — root through sudo (uid === 0)', () => {
  /** The genuine sudo environment for `den`: consistent uid and gid. */
  function sudoEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
    return { SUDO_USER: 'den', SUDO_UID: '1001', SUDO_GID: '1001', ...overrides };
  }

  it('resolves the sudo-invoking account with privileges held', () => {
    const result = resolveServiceOwner(seams({ getuid: () => 0, env: sudoEnv() }));
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'sudo', privileges: 'held', user: entry() },
    });
  });

  it('accepts the leftover sudo environment of a `sudo -s` root shell', () => {
    // Same shape as the direct invocation: `sudo -s` keeps SUDO_* set in
    // the root shell, and the trio still agrees with the database, so the
    // owner resolves exactly like a direct `sudo quotameter init`.
    const result = resolveServiceOwner(
      seams({
        getuid: () => 0,
        env: { ...sudoEnv(), SUDO_COMMAND: '/bin/bash', SUDO_EDITOR: 'vi' },
      }),
    );
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'sudo', privileges: 'held', user: entry() },
    });
  });

  it('fails with guidance when SUDO_USER is not set (plain root shell)', () => {
    const result = resolveServiceOwner(seams({ getuid: () => 0, env: {} }));
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('running as root without SUDO_USER');
    expect(result.problems[0]).toContain('"sudo quotameter init"');
    expect(result.problems[0]).toContain('regular user');
  });

  it('treats an inherited SUDO_USER as unset (own-property reads only)', () => {
    // Object.prototype-carried names must not masquerade as a sudo
    // invocation (the init-yes.ts process.env precedent).
    const hostileEnv = Object.create({
      SUDO_USER: 'den',
      SUDO_UID: '1001',
      SUDO_GID: '1001',
    }) as Record<string, string | undefined>;
    const result = resolveServiceOwner(seams({ getuid: () => 0, env: hostileEnv }));
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('running as root without SUDO_USER');
  });

  it('fails distinctly when SUDO_USER is set but empty', () => {
    const result = resolveServiceOwner(seams({ getuid: () => 0, env: sudoEnv({ SUDO_USER: '' }) }));
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('SUDO_USER is set but empty');
  });

  it('fails when SUDO_USER names an unknown account', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_USER: 'ghost' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('"ghost"');
    expect(result.problems[0]).toContain('unknown account');
  });

  it('fails when SUDO_USER is root (sudo chain invoked by root)', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_USER: 'root', SUDO_UID: '0', SUDO_GID: '0' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('SUDO_USER resolves to root');
  });

  it('fails when SUDO_USER names an account whose uid is 0 by another name', () => {
    const zeroUidAlias = entry({ name: 'superadmin', uid: 0, gid: 0, home: '/root' });
    const result = resolveServiceOwner(
      seams({
        getuid: () => 0,
        env: sudoEnv({ SUDO_USER: 'superadmin', SUDO_UID: '0', SUDO_GID: '0' }),
        passwd: () => [zeroUidAlias, ...database()],
      }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('resolves to root');
  });

  it('resolves the first database entry with the SUDO_USER name', () => {
    const duplicate = entry({ uid: 1007, gid: 1007, home: '/home/den2' });
    const result = resolveServiceOwner(
      seams({
        getuid: () => 0,
        // The ids must match the first `den` row — that is the entry the
        // name lookup picks.
        env: sudoEnv({ SUDO_UID: '1007', SUDO_GID: '1007' }),
        passwd: () => [database()[0]!, duplicate, ...database()],
      }),
    );
    expect(result).toEqual({
      state: 'ok',
      context: { kind: 'sudo', privileges: 'held', user: duplicate },
    });
  });

  it('fails when SUDO_UID is not set', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_UID: undefined }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toEqual([
      'SUDO_UID is not set while SUDO_USER is — the sudo environment is incomplete, cannot verify the service owner',
    ]);
  });

  it('fails when SUDO_UID is not a valid numeric id', () => {
    // Malformed shapes, and — review round P2 — decimal values beyond the
    // exactly-comparable integer range, where `Number` precision loss
    // could otherwise make two different strings compare equal.
    for (const value of [
      'abc',
      '',
      '10.5',
      '-1',
      '1e3',
      ' 1001',
      '9007199254740993', // 2^53 + 1: rounds onto 2^53
      '999999999999999999999999',
    ]) {
      const result = resolveServiceOwner(
        seams({ getuid: () => 0, env: sudoEnv({ SUDO_UID: value }) }),
      );
      expect(result.state, `SUDO_UID=${JSON.stringify(value)}`).toBe('problems');
      if (result.state !== 'problems') return;
      expect(result.problems[0]).toContain('SUDO_UID is not a valid numeric id');
    }
  });

  it('rejects the precision-collision forgery: SUDO_UID rounding onto the owner uid (review P2)', () => {
    // SUDO_UID 2^53+1 and a database uid of 2^53 are different values that
    // `Number()` maps to the same double; the safe-integer parser must
    // refuse the string instead of letting the verification pass.
    const huge = entry({ uid: 2 ** 53, gid: 2 ** 53 });
    const result = resolveServiceOwner(
      seams({
        getuid: () => 0,
        env: sudoEnv({ SUDO_UID: '9007199254740993', SUDO_GID: '9007199254740993' }),
        passwd: () => [database()[0]!, huge],
      }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toHaveLength(2);
  });

  it('fails when SUDO_UID disagrees with the database', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_UID: '1002' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('SUDO_UID (1002) disagrees with the user database (1001)');
    expect(result.problems[0]).toContain('"den"');
  });

  it('fails when SUDO_GID is not set', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_GID: undefined }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toEqual([
      'SUDO_GID is not set while SUDO_USER is — the sudo environment is incomplete, cannot verify the service owner',
    ]);
  });

  it('fails when SUDO_GID is not a valid numeric id', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_GID: '9007199254740993' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('SUDO_GID is not a valid numeric id');
  });

  it('fails when SUDO_GID disagrees with the database', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_GID: '1002' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems[0]).toContain('SUDO_GID (1002) disagrees with the user database (1001)');
  });

  it('reports both id problems in one pass', () => {
    const result = resolveServiceOwner(
      seams({ getuid: () => 0, env: sudoEnv({ SUDO_UID: '2001', SUDO_GID: '2002' }) }),
    );
    expect(result.state).toBe('problems');
    if (result.state !== 'problems') return;
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('SUDO_UID');
    expect(result.problems[1]).toContain('SUDO_GID');
  });

  it('is pure over its seams — the same inputs resolve identically', () => {
    expect(resolveServiceOwner(seams({ getuid: () => 0, env: sudoEnv() }))).toEqual(
      resolveServiceOwner(seams({ getuid: () => 0, env: sudoEnv() })),
    );
  });
});

describe('parsePasswdFile', () => {
  it('parses seven-field lines into entries, dropping unused fields', () => {
    expect(parsePasswdFile('den:x:1001:1001:Den Brooks:/home/den:/bin/bash\n')).toEqual([
      { name: 'den', uid: 1001, gid: 1001, home: '/home/den' },
    ]);
  });

  it('parses a realistic database in order', () => {
    const content = [
      'root:x:0:0:root:/root:/bin/bash',
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
      'den:x:1001:1001:Den Brooks:/home/den:/bin/zsh',
      '',
    ].join('\n');
    expect(parsePasswdFile(content)).toEqual([
      { name: 'root', uid: 0, gid: 0, home: '/root' },
      { name: 'daemon', uid: 1, gid: 1, home: '/usr/sbin' },
      { name: 'den', uid: 1001, gid: 1001, home: '/home/den' },
    ]);
  });

  it('skips blank lines and lines that are not seven plain-decimal fields', () => {
    const content = [
      '',
      'root:x:0:0:root:/root', // six fields
      'den:x:1001:1001:g:/home/den:/bin/zsh:extra', // eight fields
      ':x:1002:1002:g:/home/x:/bin/sh', // empty name
      'alpha:x:uid:1003:g:/home/alpha:/bin/sh', // non-numeric uid
      'beta:x:1004:gid:g:/home/beta:/bin/sh', // non-numeric gid
      'gamma:x:-1:1005:g:/home/gamma:/bin/sh', // signed uid is not plain decimal
      'huge:x:9007199254740993:1006:g:/home/huge:/bin/sh', // uid beyond exact comparison (review P2)
      'kim:x:1002:1002:Kim:/home/kim:/bin/bash',
    ].join('\n');
    expect(parsePasswdFile(content)).toEqual([
      { name: 'kim', uid: 1002, gid: 1002, home: '/home/kim' },
    ]);
  });

  it('accepts ids up to the safe-integer boundary', () => {
    // 2^53 - 1 is the largest decimal id JavaScript compares exactly; the
    // parser accepts it and refuses everything beyond (the next integer).
    const content = [
      'max:x:9007199254740991:9007199254740991:g:/home/max:/bin/sh',
      'over:x:9007199254740992:1:g:/home/over:/bin/sh',
    ].join('\n');
    expect(parsePasswdFile(content)).toEqual([
      { name: 'max', uid: 9007199254740991, gid: 9007199254740991, home: '/home/max' },
    ]);
  });
});

describe('readEtcPasswd', () => {
  it(`parses the real ${ETC_PASSWD_PATH} and finds the running user`, () => {
    const entries = readEtcPasswd();
    expect(entries.length).toBeGreaterThan(0);
    for (const row of entries) {
      expect(row.name).not.toBe('');
      expect(Number.isInteger(row.uid)).toBe(true);
      expect(Number.isInteger(row.gid)).toBe(true);
    }
    // Both supported environments (the pinned container image and CI) run
    // as a user listed in /etc/passwd, so the production database always
    // resolves the current uid.
    expect(entries.some((row) => row.uid === process.getuid?.())).toBe(true);
  });

  it('defaults the seams to exactly the documented production sources', () => {
    // Equivalence pin, total in every environment: calling with no seams
    // must behave exactly like injecting the documented defaults.
    expect(resolveServiceOwner()).toEqual(
      resolveServiceOwner({
        getuid: () => process.getuid?.(),
        env: process.env,
        passwd: readEtcPasswd,
      }),
    );
  });
});

describe('isPrivilegedSystemdOperation', () => {
  it('pins the privileged vocabulary exactly (§5.3 step 7)', () => {
    expect(PRIVILEGED_SYSTEMD_OPERATIONS).toEqual([
      'install-system-unit',
      'remove-system-unit',
      'daemon-reload',
      'enable-system-unit',
      'disable-system-unit',
      'start-system-unit',
      'stop-system-unit',
      'enable-linger',
    ]);
  });

  it('classifies exactly the listed operations as privileged', () => {
    for (const operation of PRIVILEGED_SYSTEMD_OPERATIONS) {
      expect(isPrivilegedSystemdOperation(operation)).toBe(true);
    }
    // Everything a service setup does beyond the privileged systemd
    // operations runs as the service owner (§5.3 step 7).
    for (const operation of [
      'create-config-directory',
      'create-data-directory',
      'provider-connection-test',
      'install-user-unit',
      'query-unit-state',
      'read-journal',
      'write-configuration',
    ]) {
      expect(isPrivilegedSystemdOperation(operation)).toBe(false);
    }
  });
});
