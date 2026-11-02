import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  SCRYPT_PARAMETERS,
  VERIFICATION_MAXMEM_BYTES,
  VERIFICATION_MAX_PARALLELIZATION,
  verifyPassword,
} from '../../src/services/password-hash';

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
    // The verifier reads the parameters from the stored string — this
    // pins that the string and the exported constants are the same
    // values, so a raised cost changes both together.
    const encoded = await hashPassword(PASSWORD);
    expect(encoded.startsWith(`scrypt$${PARAMETER_FIELD}$`)).toBe(true);
  });
});

/* ── verifyPassword (task 153, D-122) ─────────────────────────────────── */

/** A wrong password of realistic shape (not a near-miss of the right one). */
const WRONG_PASSWORD = 'a-completely-different-password';

/** A §15.2-respecting password with non-ASCII characters. */
const UNICODE_PASSWORD = '-passphrase-Ω-🔐-ключ';

/** Encodes raw parts exactly the way the module's producer does. */
function encodeStored(parts: {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLengthBytes: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}): string {
  return [
    'scrypt',
    `N=${parts.N},r=${parts.r},p=${parts.p},keylen=${parts.keyLengthBytes}`,
    parts.salt.toString('base64'),
    parts.hash.toString('base64'),
  ].join('$');
}

/**
 * A stored encoding under deliberately non-default parameters (cheap
 * `N`, 32-byte key) whose derivation the test recomputes itself — the
 * pin that verification follows the string, not `SCRYPT_PARAMETERS`.
 */
function storedUnderStringParameters(): string {
  const salt = Buffer.from('0123456789abcdef');
  const hash = scryptSync(PASSWORD, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return encodeStored({ N: 16_384, r: 8, p: 1, keyLengthBytes: 32, salt, hash });
}

/** A 16-byte salt for the malformed-encoding table below. */
const TABLE_SALT_BASE64 = Buffer.alloc(16, 0x42).toString('base64');
/** A 32-byte hash field matching the table's `keylen=32`. */
const TABLE_HASH_BASE64 = Buffer.alloc(32, 0x43).toString('base64');

describe('verifyPassword (spec §15.2 verification)', () => {
  it('accepts the password its own hashPassword encoded', async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(true);
  });

  it('rejects a wrong password under the same stored hash', async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(stored, WRONG_PASSWORD)).resolves.toBe(false);
  });

  it('verifies a unicode password and rejects a different unicode candidate', async () => {
    const stored = await hashPassword(UNICODE_PASSWORD);
    await expect(verifyPassword(stored, UNICODE_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(stored, 'другой-пароль-🔐')).resolves.toBe(false);
  });

  it('derives under the parameters the string carries, not the module constants', async () => {
    // N=16384 and keylen=32 disagree with SCRYPT_PARAMETERS on purpose:
    // a stored hash from a lower-cost era (or a future raise) must keep
    // verifying — the string is the only source of truth.
    const stored = storedUnderStringParameters();
    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(stored, WRONG_PASSWORD)).resolves.toBe(false);
  });

  it.each([
    ['empty stored hash', ''],
    [
      'unknown algorithm id',
      `bcrypt$N=16384,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'algorithm id is case-sensitive',
      `SCRYPT$N=16384,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    ['missing parameter field', `scrypt$N=16384,r=8,p=1$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`],
    [
      'trailing extra field',
      `scrypt$N=16384,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}$x`,
    ],
    [
      'parameters out of canonical order',
      `scrypt$r=8,N=16384,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'unknown parameter key',
      `scrypt$N=16384,r=8,p=1,rounds=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'non-numeric parameter',
      `scrypt$N=16a84,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'leading-zero parameter',
      `scrypt$N=016384,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'zero-valued parameter',
      `scrypt$N=0,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    ['salt is not canonical base64', `scrypt$N=16384,r=8,p=1,keylen=32$@@@@$${TABLE_HASH_BASE64}`],
    [
      'salt is not a whole number of base64 quanta',
      `scrypt$N=16384,r=8,p=1,keylen=32$AAA$${TABLE_HASH_BASE64}`,
    ],
    [
      'salt has non-zero trailing quantum bits',
      `scrypt$N=16384,r=8,p=1,keylen=32$AB==$${TABLE_HASH_BASE64}`,
    ],
    ['empty salt field', `scrypt$N=16384,r=8,p=1,keylen=32$$${TABLE_HASH_BASE64}`],
    ['empty hash field', `scrypt$N=16384,r=8,p=1,keylen=32$${TABLE_SALT_BASE64}$`],
    [
      'keylen disagrees with the hash byte length',
      `scrypt$N=16384,r=8,p=1,keylen=64$${TABLE_SALT_BASE64}$${TABLE_HASH_BASE64}`,
    ],
    [
      'p beyond the verification CPU ceiling',
      encodeStored({
        N: 16_384,
        r: 8,
        p: VERIFICATION_MAX_PARALLELIZATION + 1,
        keyLengthBytes: 32,
        salt: Buffer.alloc(16, 0x42),
        hash: Buffer.alloc(32, 0x43),
      }),
    ],
  ])('answers false for a malformed stored hash: %s', async (_label, stored) => {
    await expect(verifyPassword(stored, PASSWORD)).resolves.toBe(false);
  });

  it('answers false for an absent stored hash (the optional config field)', async () => {
    await expect(verifyPassword(undefined, PASSWORD)).resolves.toBe(false);
  });

  it('answers false for non-string stored hashes at the JS boundary', async () => {
    await expect(verifyPassword(null as unknown as string, PASSWORD)).resolves.toBe(false);
    await expect(verifyPassword(123 as unknown as string, PASSWORD)).resolves.toBe(false);
  });

  it('answers false when node:crypto refuses the stored parameters', async () => {
    // N=1 parses (grammar-valid, self-consistent) but scrypt requires a
    // power of two greater than one — the refusal is a mismatch.
    const refusedNOne = encodeStored({
      N: 1,
      r: 8,
      p: 1,
      keyLengthBytes: 32,
      salt: Buffer.alloc(16, 0x42),
      hash: Buffer.alloc(32, 0x43),
    });
    await expect(verifyPassword(refusedNOne, PASSWORD)).resolves.toBe(false);
    // The smallest power-of-two N whose 128·N·r exceeds the exported
    // memory ceiling (derived from the constant, so the pin follows the
    // bound): node:crypto refuses before any allocation becomes a
    // denial-of-service surface.
    const beyondCeiling = (2 * VERIFICATION_MAXMEM_BYTES) / (128 * 8);
    const refusedMemory = encodeStored({
      N: beyondCeiling,
      r: 8,
      p: 1,
      keyLengthBytes: 32,
      salt: Buffer.alloc(16, 0x42),
      hash: Buffer.alloc(32, 0x43),
    });
    await expect(verifyPassword(refusedMemory, PASSWORD)).resolves.toBe(false);
  });
});
