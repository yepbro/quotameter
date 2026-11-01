import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, SCRYPT_PARAMETERS } from '../../src/services/password-hash';

/**
 * The §15.2 hash encoding (task 144, decision D-118): scrypt from
 * `node:crypto`, a random salt per hash, and an encoding that carries its
 * own parameters — so task 153's verifier can parse a stored hash without
 * this module's constants ever drifting from what is on disk. The suite
 * pins the format executably against `node:crypto` itself (the known-answer
 * test recomputes the derivation from the exported constants), the salt
 * randomness (two hashes of one password differ), and the byte lengths.
 */

/** The exact parameter prefix every produced hash carries. */
const PARAMETER_FIELD = `N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p},keylen=${SCRYPT_PARAMETERS.keyLengthBytes}`;

/** One `$`-separated field of an encoded hash, guaranteed present. */
function field(encoded: string, index: number): string {
  const value = encoded.split('$')[index];
  if (value === undefined) throw new Error(`encoded hash has no field ${index}`);
  return value;
}

/** A non-secret test password (the §15.2 minimum respected). */
const PASSWORD = 'unit-test-password';

describe('hashPassword (spec §15.2 encoding)', () => {
  it('produces the self-describing scrypt encoding', async () => {
    const encoded = await hashPassword(PASSWORD);
    expect(encoded.split('$')).toHaveLength(4);
    expect(field(encoded, 0)).toBe('scrypt');
    expect(field(encoded, 1)).toBe(PARAMETER_FIELD);
    expect(Buffer.from(field(encoded, 2), 'base64')).toHaveLength(
      SCRYPT_PARAMETERS.saltLengthBytes,
    );
    expect(Buffer.from(field(encoded, 3), 'base64')).toHaveLength(SCRYPT_PARAMETERS.keyLengthBytes);
  });

  it('draws a fresh random salt per hash', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
    expect(field(first, 2)).not.toBe(field(second, 2));
  });

  it('matches a derivation recomputed from the exported constants (known answer)', async () => {
    const salt = Buffer.from('0123456789abcdef'); // 16 bytes, deterministic
    const encoded = await hashPassword(PASSWORD, { salt });
    const expected = scryptSync(PASSWORD, salt, SCRYPT_PARAMETERS.keyLengthBytes, {
      N: SCRYPT_PARAMETERS.N,
      r: SCRYPT_PARAMETERS.r,
      p: SCRYPT_PARAMETERS.p,
      maxmem: SCRYPT_PARAMETERS.maxmemBytes,
    });
    expect(field(encoded, 2)).toBe(salt.toString('base64'));
    expect(field(encoded, 3)).toBe(expected.toString('base64'));
  });

  it('is deterministic for the same password and salt', async () => {
    const salt = Buffer.from('fixed-salt-16byt');
    const first = await hashPassword(PASSWORD, { salt });
    const second = await hashPassword(PASSWORD, { salt });
    expect(first).toBe(second);
  });

  it('carries the work parameters inside the string, not just the constants', async () => {
    // The verifier of task 153 reads the parameters from the stored
    // string — this pins that the string and the exported constants are
    // the same values, so a raised cost changes both together.
    const encoded = await hashPassword(PASSWORD);
    expect(encoded.startsWith(`scrypt$${PARAMETER_FIELD}$`)).toBe(true);
  });
});
