/**
 * The §15.2 password-hash encoding (task 144; decision D-118).
 *
 * The configuration contract stores an opaque `auth.passwordHash` string
 * (`src/schemas/config.ts`) whose encoding is "owned by the auth service"
 * — this module is that owner's first half: **hashing**. Verification
 * (constant-time comparison against a stored hash) is task 153 and lands
 * with the login paths that need it; the format is designed so it can be
 * parsed back without this module's constants ever drifting from what is
 * on disk:
 *
 * ```text
 * scrypt$N=65536,r=8,p=1,keylen=64$<salt base64>$<hash base64>
 * ```
 *
 * Every parameter travels with the hash. A future parameter change (say a
 * higher `N`) therefore never invalidates stored hashes: the verifier of
 * task 153 reads the parameters from the string, and only newly set
 * passwords use the raised cost.
 *
 * `scrypt` comes from `node:crypto` with a random salt per spec §15.2 —
 * the work parameters below are the documented interactive-cost choice:
 * `N=2^16, r=8, p=1` costs ~64 MiB and tens of milliseconds on current
 * hardware (OWASP-class for an interactive set/change operation), and the
 * explicit `maxmem` is required because Node's 32 MiB default memory
 * limit refuses this `N × r` combination.
 */

import { randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * The §15.2 scrypt work parameters this module hashes with. Frozen and
 * exported so tests pin the encoding executably against `node:crypto`
 * itself — a silent change here would strand every stored hash shape.
 */
export const SCRYPT_PARAMETERS = Object.freeze({
  /** CPU/memory cost (power of two > 1). */
  N: 65_536,
  /** Block size. */
  r: 8,
  /** Parallelization. */
  p: 1,
  /** Derived key length in bytes. */
  keyLengthBytes: 64,
  /** Random salt length in bytes (a fresh salt per hash). */
  saltLengthBytes: 16,
  /**
   * Memory budget for the derivation. Must exceed `128 × N × r` = 64 MiB;
   * Node's default (32 MiB) would reject the parameter set above.
   */
  maxmemBytes: 128 * 1024 * 1024,
});

/** The promisified `node:crypto` derivation (async — the event loop stays free). */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** The literal encoding marker every produced hash starts with. */
const ALGORITHM_ID = 'scrypt';

/**
 * Hashes `password` into the self-describing encoded form (§15.2: scrypt
 * from `node:crypto`, random salt, documented parameters). Two calls with
 * the same password produce different strings (the salt is random); the
 * returned encoding is safe to store in the `0600` configuration file —
 * it contains no recoverable password material.
 *
 * `options.salt` exists for deterministic known-answer tests only — a
 * fixed salt would make the output deterministic, which is precisely what
 * §15.2's random-salt rule exists to prevent; never pass it outside tests
 * (the docblock is the guard, the landed seam pattern — the module's
 * consumers are this package's own code).
 */
export async function hashPassword(
  password: string,
  options: { readonly salt?: Buffer } = {},
): Promise<string> {
  const salt = options.salt ?? randomBytes(SCRYPT_PARAMETERS.saltLengthBytes);
  const derived = await scrypt(password, salt, SCRYPT_PARAMETERS.keyLengthBytes, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: SCRYPT_PARAMETERS.maxmemBytes,
  });
  const parameters = `N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p},keylen=${SCRYPT_PARAMETERS.keyLengthBytes}`;
  return [ALGORITHM_ID, parameters, salt.toString('base64'), derived.toString('base64')].join('$');
}
