/**
 * The §15.2 password-hash encoding and its verification (task 144 /
 * task 153; decisions D-118 / D-122).
 *
 * The configuration contract stores an opaque `auth.passwordHash` string
 * (`src/schemas/config.ts`) whose encoding is "owned by the auth service"
 * — this module is that owner: {@link hashPassword} (task 144) produces
 * the encoding, {@link verifyPassword} (task 153) parses it back and
 * compares constant-time. The format is self-describing so the round
 * trip never needs this module's hashing constants to match what is on
 * disk:
 *
 * ```text
 * scrypt$N=65536,r=8,p=1,keylen=64$<salt base64>$<hash base64>
 * ```
 *
 * Every parameter travels with the hash. A future parameter change (say a
 * higher `N`) therefore never invalidates stored hashes: the verifier
 * reads the parameters from the string, and only newly set passwords use
 * the raised cost.
 *
 * `scrypt` comes from `node:crypto` with a random salt per spec §15.2 —
 * the work parameters below are the documented interactive-cost choice:
 * `N=2^16, r=8, p=1` costs ~64 MiB and tens of milliseconds on current
 * hardware (OWASP-class for an interactive set/change operation), and the
 * explicit `maxmem` is required because Node's 32 MiB default memory
 * limit refuses this `N × r` combination.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
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

/* ── Verification (task 153, decision D-122) ──────────────────────────── */

/**
 * The memory ceiling every verification derivation runs under: 1 GiB —
 * sixteen times today's 64 MiB requirement, so any plausible future cost
 * raise (`N` up to `2^19` at `r=8`) verifies unchanged, while a corrupt
 * or hostile stored string can never talk the verifier into unbounded
 * allocation: `node:crypto` refuses a derivation beyond `maxmem`, and
 * the refusal classifies as a mismatch below. Exported like {@link
 * SCRYPT_PARAMETERS} so tests derive the must-refuse parameter set from
 * the bound itself and the pin travels with it.
 */
export const VERIFICATION_MAXMEM_BYTES = 1024 * 1024 * 1024;

/**
 * The parallelization ceiling verification accepts: `maxmem` above bounds
 * only OpenSSL's memory estimate — `p` multiplies CPU work without
 * touching it, so an unbounded `p` in a corrupt stored string could pin a
 * libuv thread for hours (measured on the pinned runtime: `p=4000` ≈ 21 s
 * under a 1 GiB ceiling; `p` in the millions scales past hours). The
 * producer writes `p=1` and every realistic raise goes through `N`, so
 * 1024 is a generous bound whose worst case is seconds, not hours.
 * Exported like {@link VERIFICATION_MAXMEM_BYTES}: tests derive the
 * must-refuse value from the bound itself.
 */
export const VERIFICATION_MAX_PARALLELIZATION = 1024;

/**
 * The parameter field's exact grammar: the canonical key order, plain
 * decimal, no leading zeros. This module is the encoding's only
 * producer, so anything the grammar does not accept is by definition
 * not one of its hashes.
 */
const STORED_PARAMETER_PATTERN =
  /^N=([1-9][0-9]*),r=([1-9][0-9]*),p=([1-9][0-9]*),keylen=([1-9][0-9]*)$/;

/**
 * Canonical padded base64 and nothing else — see {@link
 * decodeCanonicalBase64}.
 */
const BASE64_FIELD_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes one `$`-separated field, accepting only the canonical padded
 * base64 `Buffer.toString('base64')` emits: non-empty, a whole number of
 * 4-character quanta, the standard alphabet with at most two trailing
 * `=`, and a re-encode round-trip — which additionally rejects quanta
 * with non-zero trailing bits (`AB==` decodes to one zero-valued byte
 * but re-encodes as `AA==`) and every alias Node's permissive decoder
 * would silently forgive. Anything else is `null`: a malformed field is
 * refused, never best-effort-guessed.
 */
function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_FIELD_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

/** A stored hash parsed into its parts. */
interface StoredPasswordHash {
  /** The CPU/memory cost the string carries (`N` of scrypt). */
  readonly N: number;
  /** The block size the string carries (`r` of scrypt). */
  readonly r: number;
  /** The parallelization the string carries (`p` of scrypt). */
  readonly p: number;
  /** The derived-key length the string claims (`keylen`). */
  readonly keyLengthBytes: number;
  /** The decoded salt field. */
  readonly salt: Buffer;
  /** The decoded hash field (its length equals `keyLengthBytes`). */
  readonly hash: Buffer;
}

/**
 * Parses the encoded form strictly — or answers `null` for anything this
 * module would not have written: exactly four `$`-separated fields, the
 * one algorithm id, the canonical parameter grammar, canonical base64
 * fields, and internal consistency (the decoded hash length equals the
 * `keylen` the string claims, and `p` stays inside {@link
 * VERIFICATION_MAX_PARALLELIZATION} — the CPU twin of the memory
 * ceiling, this module's own budget because `node:crypto` offers no
 * `p` knob). Parameter *semantics* — power-of-two `N`, ranges, memory —
 * are deliberately not re-validated here: `node:crypto` owns those
 * rules, and the derivation in {@link verifyPassword} answers `false`
 * when it refuses them, leaving one authority instead of a mirrored
 * table that can drift.
 */
function parseStoredHash(stored: string): StoredPasswordHash | null {
  const fields = stored.split('$');
  if (fields.length !== 4 || fields[0] !== ALGORITHM_ID) {
    return null;
  }
  const parameters = STORED_PARAMETER_PATTERN.exec(fields[1]!);
  if (parameters === null) {
    return null;
  }
  const p = Number(parameters[3]!);
  const keyLengthBytes = Number(parameters[4]!);
  const salt = decodeCanonicalBase64(fields[2]!);
  const hash = decodeCanonicalBase64(fields[3]!);
  if (salt === null || hash === null || hash.length !== keyLengthBytes) {
    return null;
  }
  if (p > VERIFICATION_MAX_PARALLELIZATION) {
    return null;
  }
  return {
    N: Number(parameters[1]!),
    r: Number(parameters[2]!),
    p,
    keyLengthBytes,
    salt,
    hash,
  };
}

/**
 * Whether `candidate` is the password `stored` encodes — §15.2's
 * verification half (task 153, decision D-122) and the inverse of
 * {@link hashPassword}: parse the stored string, re-derive the candidate
 * under the parameters **the string itself carries** (never {@link
 * SCRYPT_PARAMETERS} — D-118's forward-compatibility rule: a cost raise
 * changes only what newly set hashes use, and every already-stored hash
 * keeps verifying), and compare the derived keys constant-time.
 *
 * **Constant-time discipline:** the comparison is `timingSafeEqual` over
 * the derived key bytes, never over strings, and its equal-length
 * precondition is guaranteed *before* any secret is touched — the parse
 * (above) rejects a stored hash whose byte length disagrees with its own
 * `keylen`, and the lengths of the public encoding are not secret (an
 * attacker who can read them already has the config file). There is no
 * early exit on candidate content: every candidate under a parseable
 * stored hash costs exactly one full derivation, wrong passwords
 * included.
 *
 * **Fail closed, never throws:** an absent stored hash (the optional
 * `auth.passwordHash` field may be passed directly — the signature
 * mirrors it, and runtime junk beyond it answers `false` through the
 * same guard), an empty or malformed one (wrong field count, unknown
 * algorithm id, off-grammar parameters, non-canonical base64,
 * self-inconsistent lengths, a `p` past {@link
 * VERIFICATION_MAX_PARALLELIZATION}), and a parameter set `node:crypto`
 * refuses (a non-power-of-two `N`, a set beyond {@link
 * VERIFICATION_MAXMEM_BYTES}) all answer `false` — an unverifiable
 * credential is a wrong password to this function, never an error and
 * never an accept; the operator-facing diagnosis of a corrupt
 * configuration belongs to the config layer, and the login/session tasks
 * (154+) need only the boolean.
 */
export async function verifyPassword(
  stored: string | undefined,
  candidate: string,
): Promise<boolean> {
  // Totality guard: `auth.passwordHash` is optional in the configuration
  // contract, and the fail-closed-never-throws promise is the function's
  // whole contract — absence (and, at the JS boundary, any non-string)
  // is a mismatch, never a TypeError.
  if (typeof stored !== 'string') {
    return false;
  }
  const parsed = parseStoredHash(stored);
  if (parsed === null) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await scrypt(candidate, parsed.salt, parsed.keyLengthBytes, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: VERIFICATION_MAXMEM_BYTES,
    });
  } catch {
    // node:crypto refused the stored parameters — a string this module
    // would never have written. Fail closed: a refusal is a mismatch.
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}
