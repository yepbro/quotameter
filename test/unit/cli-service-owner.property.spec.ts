import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { resolveServiceOwner, type PasswdEntry } from '../../src/cli/service-owner';

/**
 * Property pins of the service-owner decision layer (task 136, spec §5.3,
 * decision D-105): over arbitrary user databases, sudo environments, and
 * process uids, every **ok** resolution carries a non-root owner (§5.1/
 * §15.6's "the service must never run as root" — the done-condition), a
 * regular user resolves their own account, and a root process resolves an
 * owner only through a name that a genuine sudo environment supplied and
 * the database verified. Root-named entries, zero uids, empty and malformed
 * `SUDO_*` values are all inside the generators' reach, so the refusals are
 * exercised as data, not just as hand-picked unit cases.
 */

/** Account names the database generator can produce, `root` included. */
const nameArbitrary = fc.stringMatching(/^[a-z_][a-z0-9_-]{0,8}$/);

/** One user-database row; duplicate names and uids are legal inputs. */
const entryArbitrary = fc.record({
  name: nameArbitrary,
  uid: fc.nat(3000),
  gid: fc.nat(3000),
  home: fc.constantFrom('/home/x', '/root', ''),
});

/** A whole (possibly hostile) user database. */
const entriesArbitrary = fc.array(entryArbitrary, { maxLength: 6 });

/** A sudo id value: a plausible id, or shapes that must never verify. */
const idValueArbitrary = fc.oneof(
  fc.nat(3000).map(String),
  fc.constantFrom('', 'abc', '-1', '1e3', '0'),
);

/** The sudo environment slice, each variable present, absent, or garbage. */
const sudoEnvArbitrary = fc.record({
  SUDO_USER: fc.option(fc.oneof(nameArbitrary, fc.constantFrom('root', '')), {
    nil: undefined,
  }),
  SUDO_UID: fc.option(idValueArbitrary, { nil: undefined }),
  SUDO_GID: fc.option(idValueArbitrary, { nil: undefined }),
});

/** Runs the resolver over generated inputs and narrows the ok state. */
function resolveOk(
  uid: number,
  entries: readonly PasswdEntry[],
  env: Record<string, string | undefined>,
) {
  const result = resolveServiceOwner({ getuid: () => uid, env, passwd: () => entries });
  return result.state === 'ok' ? result.context : null;
}

describe('resolveServiceOwner properties', () => {
  it('never resolves a root owner, at any uid, from any database or environment', () => {
    fc.assert(
      fc.property(fc.nat(3000), entriesArbitrary, sudoEnvArbitrary, (uid, entries, env) => {
        const context = resolveOk(uid, entries, env);
        if (context === null) return true;
        expect(context.user.name).not.toBe('root');
        expect(context.user.uid).not.toBe(0);
        return true;
      }),
    );
  });

  it('resolves a regular user to their own unprivileged account', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3000 }),
        entriesArbitrary,
        sudoEnvArbitrary,
        (uid, entries, env) => {
          const context = resolveOk(uid, entries, env);
          if (context === null) return true;
          expect(context.kind).toBe('regular-user');
          expect(context.privileges).toBe('none');
          expect(context.user.uid).toBe(uid);
          // The name must round-trip: the generated `User=` resolves by
          // first name match in systemd, and that first match must be the
          // very entry resolved here (review round P0's invariant).
          expect(entries.find((candidate) => candidate.name === context.user.name)).toBe(
            context.user,
          );
          return true;
        },
      ),
    );
  });

  it('resolves a root process only to the verified SUDO_USER account, holding privileges', () => {
    fc.assert(
      fc.property(entriesArbitrary, sudoEnvArbitrary, (entries, env) => {
        const context = resolveOk(0, entries, env);
        if (context === null) return true;
        expect(context.kind).toBe('sudo');
        expect(context.privileges).toBe('held');
        // The owner is exactly the account sudo named — no other source
        // can produce an ok root-context resolution — and selecting by
        // name means the first-name-match round-trip holds by construction.
        const sudoUser = Object.hasOwn(env, 'SUDO_USER') ? env.SUDO_USER : undefined;
        expect(sudoUser).toBe(context.user.name);
        expect(context.user.uid).not.toBe(0);
        expect(entries.find((candidate) => candidate.name === context.user.name)).toBe(
          context.user,
        );
        return true;
      }),
    );
  });
});
