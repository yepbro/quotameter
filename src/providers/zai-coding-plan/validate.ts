/**
 * Z.ai Coding Plan credential validation (spec §8.1, §8.3; task 098,
 * decision D-052).
 *
 * The "test connection" action behind `validateCredentials`: one signal-less
 * `Authorization: Bearer <key>` GET to the dossier's endpoint 4
 * (`GET {coding-base}/models` — cheap and quota-state-independent) through
 * the shared transport ([dossier][dossier-096], D-042/D-047). The check is
 * **status-based** and total over exactly three results:
 *
 * | Outcome                                    | Result                            |
 * | ------------------------------------------ | -------------------------------- |
 * | `providerFetch` resolves (2xx delivered)   | resolve — credentials valid       |
 * | HTTP 401/403 (assumption A3)               | {@link CredentialsRejectedError} |
 * | any other transport failure of any kind    | {@link ProviderUnavailableError} |
 *
 * The response body is never parsed — it was never captured (D-049:
 * `synthetic/zai-models.json` is a stand-in only), so validation reads the
 * status the verified flow delivers and nothing else. "2xx" means "2xx
 * delivered by the transport": a 2xx that fails the transport's
 * `application/json`/size gates surfaces as a transport error and therefore
 * reads unavailable (the check could not confirm anything through the
 * verified flow), never valid and never rejected.
 *
 * Secret discipline (spec §8.1, §15.4; D-013/D-042): the account key is read
 * exactly once, into the `Authorization` header. Errors are composed only
 * from static English and transport fields that D-042 already scrubbed
 * against the request's own credential material, so no code path here can
 * echo the key. Marker tests pin the whole surface.
 *
 * [dossier-096]: https://github.com/yepbro/quotameter/blob/master/docs/providers/zai-coding-plan.md
 * (section "Adapter contract — implementation-facing rules for tasks
 * 098-100", task 096)
 */

import type { AccountContext } from '../registry';
import {
  TransportError,
  TransportStatusError,
  providerFetch,
  type TransportErrorKind,
} from '../transport';

/* ── Result vocabulary (D-052) ─────────────────────────────────────────── */

/**
 * Why a credential check failed: the provider refused the key, or the check
 * was inconclusive. Kept provider-neutral (the 070 contract's wording for
 * `validateCredentials` rejections in `registry.ts`) and structural — the
 * {@link CredentialCheckError.kind} field is the discriminant consumers that
 * cannot import adapter types read.
 */
export type CredentialCheckKind = 'credentials-rejected' | 'provider-unavailable';

/**
 * Base of every {@link validateZaiCredentials} rejection: a provider-neutral
 * error (spec §8.1) whose {@link kind} discriminates the two failure
 * meanings. Self-contained like D-042's errors: no cause is attached, and
 * subclasses carry only non-secret facts (an HTTP status, a transport kind).
 */
export class CredentialCheckError extends Error {
  readonly kind: CredentialCheckKind;

  constructor(kind: CredentialCheckKind, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }
}

/**
 * The provider answered and refused the account credentials — HTTP 401/403
 * on the credential check. An assumption-shaped classification (dossier
 * ledger A3): Z.ai's real auth-rejection shape was never captured, and only
 * these two statuses count as rejection; the first observed bad-key response
 * reopens the assumption.
 */
export class CredentialsRejectedError extends CredentialCheckError {
  /** The HTTP status that grounded the rejection (401 or 403). */
  readonly httpStatus: 401 | 403;

  constructor(httpStatus: 401 | 403) {
    super(
      'credentials-rejected',
      `the provider rejected the account credentials (HTTP ${httpStatus})`,
    );
    this.httpStatus = httpStatus;
  }
}

/**
 * The credential check was inconclusive — every transport failure that is
 * not an HTTP 401/403: network/timeout/DNS problems, 5xx, 429, other
 * statuses, and 2xx responses the transport refused to deliver (content
 * type, size cap). Unavailability is not a verdict on the key; a caller must
 * not treat it as a rejection (spec §7.2 keeps the two apart for polling,
 * and the check inherits the distinction).
 */
export class ProviderUnavailableError extends CredentialCheckError {
  /** Which transport failure (D-042 taxonomy) made the check inconclusive. */
  readonly transportKind: TransportErrorKind;
  /**
   * The HTTP status when a status response arrived (a non-2xx);
   * `undefined` for response-less failures and for gate-refused 2xx bodies,
   * whose D-042 error classes carry no status.
   */
  readonly httpStatus: number | undefined;

  constructor(transportError: TransportError) {
    super(
      'provider-unavailable',
      `the credential check could not be completed: ${transportError.message}`,
    );
    this.transportKind = transportError.kind;
    this.httpStatus =
      transportError instanceof TransportStatusError ? transportError.status : undefined;
  }
}

/* ── Classification ────────────────────────────────────────────────────── */

/** The dossier's A3 rule: only 401 and 403 reject credentials. */
function isAuthRejectionStatus(status: number): status is 401 | 403 {
  return status === 401 || status === 403;
}

/**
 * Maps one transport failure (D-042) to the credential-check result — the
 * pure seam behind {@link validateZaiCredentials}, unit-tested across the
 * whole taxonomy. Total by construction: a `TransportStatusError` with a
 * 401/403 status rejects; every other transport failure is unavailability.
 * There is deliberately no per-kind switch and no fail-fast arm: the check
 * is signal-less, so the `aborted` kind cannot occur (dossier), and a
 * transport failure the adapter did not predict still classifies instead of
 * crashing a "test connection" request.
 */
export function classifyCredentialCheckFailure(error: TransportError): CredentialCheckError {
  if (error instanceof TransportStatusError && isAuthRejectionStatus(error.status)) {
    return new CredentialsRejectedError(error.status);
  }
  return new ProviderUnavailableError(error);
}

/* ── The check ─────────────────────────────────────────────────────────── */

/** The one request {@link validateZaiCredentials} performs. */
export interface CredentialCheckRequest {
  /** Absolute http(s) URL of the credential-check endpoint (endpoint 4). */
  readonly url: string;
  /** The §7.2 total request deadline for the check. */
  readonly timeoutMs: number;
}

/**
 * Runs the credential check for `account` (spec §8.1): resolves when the
 * provider accepts the key, rejects with a {@link CredentialCheckError}
 * otherwise. Sends exactly one GET — retrying is not this layer's job
 * (D-042/D-047) — and never parses the response body (the transport's
 * bounded read behind its content-type and size gates is D-042's, not
 * interpretation).
 */
export async function validateZaiCredentials(
  account: AccountContext,
  request: CredentialCheckRequest,
): Promise<void> {
  try {
    await providerFetch(
      { url: request.url, headers: { authorization: `Bearer ${account.secret}` } },
      { timeoutMs: request.timeoutMs },
    );
  } catch (error) {
    if (error instanceof TransportError) {
      throw classifyCredentialCheckFailure(error);
    }
    // Transport-option TypeErrors are wiring bugs, not provider outcomes;
    // they stay loud instead of being dressed up as a check result.
    throw error;
  }
}
