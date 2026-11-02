import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyAuthMode,
  createAuthModeGuard,
  proxyIndicatorPresent,
  PUBLIC_AUTH_ROUTE_CONFIG,
  type AuthModeVerdict,
} from '../../src/server/api/auth';
import { ApiError } from '../../src/server/api/error';
import type { AuthMode } from '../../src/schemas/config';

/**
 * The §15.1 auth-mode decision machinery (task 152, decision D-121):
 * `proxyIndicatorPresent` (the request-side fact — §15.1's `Forwarded`,
 * `X-Real-IP`, `X-Forwarded-*` indicator family, presence-only),
 * `classifyAuthMode` (the pure, fail-closed verdict over the full
 * address × password × mode × proxy matrix), and `createAuthModeGuard`
 * (the `/api` scope's third `onRequest` hook: the 403-with-instructions
 * throw of the passwordless proxied shape, the 401 throw when the
 * verdict demands credentials, the public-route opt-out, and the
 * `RequestAuthenticator` seam tasks 153–155 implement). The wire-level
 * matrix is pinned by `test/integration/api-auth-mode.spec.ts` against
 * the real task-146 construction.

 * The startup-refusal legs of §15.1 (`required` without a password, a
 * non-loopback bind without a password) belong to the config layer and
 * are pinned there (task 073); here they appear only as the
 * fail-closed classifier cells and hook arms that keep an
 * inconsistently constructed server shut.
 */

/** The exact §15.1 instruction message — byte-pinned against the hook. */
const PROXY_INSTRUCTIONS =
  'The request was forwarded by a reverse proxy, but no password is configured; ' +
  'set one with `quotameter passwd` before exposing the service through a proxy, ' +
  'or reach it directly on the loopback interface';

describe('proxyIndicatorPresent — §15.1 indicator family, presence-only', () => {
  it('fires on the exact names the spec spells (any casing)', () => {
    expect(proxyIndicatorPresent(['forwarded'])).toBe(true);
    expect(proxyIndicatorPresent(['x-real-ip'])).toBe(true);
    // Proxies emit mixed casing; Node lowercases, the detector is total
    // over any spelling regardless.
    expect(proxyIndicatorPresent(['Forwarded'])).toBe(true);
    expect(proxyIndicatorPresent(['X-Real-IP'])).toBe(true);
    expect(proxyIndicatorPresent(['FORWARDED'])).toBe(true);
  });

  it('fires on every X-Forwarded-* family member, including future ones', () => {
    expect(proxyIndicatorPresent(['x-forwarded-for'])).toBe(true);
    expect(proxyIndicatorPresent(['x-forwarded-proto'])).toBe(true);
    expect(proxyIndicatorPresent(['x-forwarded-host'])).toBe(true);
    expect(proxyIndicatorPresent(['x-forwarded-port'])).toBe(true);
    expect(proxyIndicatorPresent(['x-forwarded-server'])).toBe(true);
    expect(proxyIndicatorPresent(['X-Forwarded-By'])).toBe(true);
    // The spec names the family (`X-Forwarded-*`), not a closed list:
    // any prefixed successor a proxy adds indicates the hop too.
    expect(proxyIndicatorPresent(['x-forwarded-tls-client-cert'])).toBe(true);
  });

  it('fires when an indicator rides among other headers', () => {
    expect(proxyIndicatorPresent(['host', 'accept', 'x-real-ip', 'connection'])).toBe(true);
  });

  it('stays quiet for lookalikes outside the family (fail-open here is correct)', () => {
    // Not indicators: the family needs the trailing dash segment, the
    // exact names need exact equality. Over-matching ordinary headers
    // would lock every loopback client out, so the vocabulary stays the
    // spec's own three spellings.
    expect(proxyIndicatorPresent([])).toBe(false);
    expect(proxyIndicatorPresent(['host', 'accept', 'content-type'])).toBe(false);
    expect(proxyIndicatorPresent(['x-forwarded'])).toBe(false);
    expect(proxyIndicatorPresent(['x-forward'])).toBe(false);
    expect(proxyIndicatorPresent(['forwarded-by'])).toBe(false);
    expect(proxyIndicatorPresent(['x-real-ipx'])).toBe(false);
    expect(proxyIndicatorPresent(['xx-forwarded-for'])).toBe(false);
    expect(proxyIndicatorPresent(['xforwarded-for'])).toBe(false);
    expect(proxyIndicatorPresent([''])).toBe(false);
    expect(proxyIndicatorPresent(['  '])).toBe(false);
  });

  it('is value-blind by construction — names only', () => {
    // An empty-valued indicator still fires: the name is the fact, the
    // value is never read (Node keeps present-but-empty headers, and a
    // proxy that forwards an empty value still forwarded the request).
    // The type is the proof: the detector takes names, not values.
    expect(proxyIndicatorPresent(['x-real-ip', 'host'])).toBe(true);
  });
});

describe('classifyAuthMode — the full §15.1 matrix (2×2×2×2)', () => {
  /** The verdict literal for the expected cell, as a comparable object. */
  function verdict(authentication: AuthModeVerdict['authentication']): AuthModeVerdict {
    return { authentication };
  }

  /**
   * The full address × password × proxy × mode table. The four
   * startup-refused cells (`required`/non-loopback without a password
   * never start — task 073's config leg) are answered fail-closed
   * `required`, so an inconsistently constructed server stays shut.
   */
  it.each<[AuthMode, boolean, boolean, boolean, AuthModeVerdict]>([
    // required: a password is always demanded, every address, every hop.
    ['required', true, true, true, verdict('required')],
    ['required', true, true, false, verdict('required')],
    ['required', true, false, true, verdict('required')], // startup-refused shape
    ['required', true, false, false, verdict('required')], // startup-refused shape
    ['required', false, true, true, verdict('required')],
    ['required', false, true, false, verdict('required')],
    ['required', false, false, true, verdict('required')], // startup-refused shape
    ['required', false, false, false, verdict('required')], // startup-refused shape
    // auto, loopback bind: the proxy indication flips the verdict.
    ['auto', true, true, true, verdict('required')],
    ['auto', true, true, false, verdict('not-required')],
    ['auto', true, false, true, verdict('proxy-without-password')],
    ['auto', true, false, false, verdict('not-required')],
    // auto, non-loopback bind: the password is demanded on every path.
    ['auto', false, true, true, verdict('required')],
    ['auto', false, true, false, verdict('required')],
    ['auto', false, false, true, verdict('required')], // startup-refused shape
    ['auto', false, false, false, verdict('required')], // startup-refused shape
  ])(
    'mode=%s loopback=%s password=%s proxy=%s → %s',
    (mode, bindIsLoopback, passwordConfigured, proxyIndicated, expected) => {
      expect(
        classifyAuthMode({ mode, bindIsLoopback, passwordConfigured, proxyIndicated }),
      ).toEqual(expected);
    },
  );

  it("keeps auto's direct-loopback cell passwordless even with a password set", () => {
    // The spec's own words: "direct loopback requests do not require a
    // password" — configuring one does not tighten auto mode's local
    // leg (the password matters on the remote/proxy paths only).
    expect(
      classifyAuthMode({
        mode: 'auto',
        bindIsLoopback: true,
        passwordConfigured: true,
        proxyIndicated: false,
      }),
    ).toEqual(verdict('not-required'));
  });
});

describe('createAuthModeGuard — the hook (D-113 throw-side pattern)', () => {
  /** A minimal request double — the hook reads headers and routeOptions.config. */
  function request(
    headers: Record<string, string>,
    routeConfig?: { readonly auth?: 'public' },
  ): FastifyRequest {
    return {
      headers,
      routeOptions: routeConfig === undefined ? {} : { config: routeConfig },
    } as unknown as FastifyRequest;
  }

  /** The ApiError a rejection threw (fails the test when none did). */
  async function rejection(error: unknown): Promise<ApiError> {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }

  it('resolves for the auto-mode direct loopback request (no indicators)', async () => {
    const guard = createAuthModeGuard({ mode: 'auto', bindHost: '127.0.0.1' });
    await expect(
      guard(request({ host: '127.0.0.1:8787', accept: 'application/json' })),
    ).resolves.toBeUndefined();
  });

  it('skips the public-route opt-out regardless of the verdict', async () => {
    // The health route's config is the exemption — even `required` mode
    // with no credentials lets the public route through.
    const guard = createAuthModeGuard({ mode: 'required', bindHost: '127.0.0.1' });
    await expect(guard(request({}, PUBLIC_AUTH_ROUTE_CONFIG))).resolves.toBeUndefined();
  });

  it('throws the byte-shaped 403-with-instructions for the passwordless proxied shape', async () => {
    const guard = createAuthModeGuard({ mode: 'auto', bindHost: 'localhost' });
    let error: unknown;
    try {
      await guard(request({ 'x-real-ip': '203.0.113.7' }));
    } catch (thrown) {
      error = thrown;
    }
    const apiError = await rejection(error);
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.statusCode).toBe(403);
    expect(apiError.message).toBe(PROXY_INSTRUCTIONS);
    expect(apiError.details).toEqual({ reason: 'proxy-without-password' });
    // §15.4: nothing the client sent is echoed — the proxied value the
    // request carried appears in neither message nor details.
    expect(apiError.message).not.toContain('203.0.113.7');
    expect(JSON.stringify(apiError.details)).not.toContain('203.0.113.7');
  });

  it('throws the registry 401 when the verdict demands credentials the request lacks', async () => {
    // Default seam: no request is authenticated (fail closed until 153).
    const guard = createAuthModeGuard({
      mode: 'required',
      bindHost: '127.0.0.1',
      passwordConfigured: () => true,
    });
    let error: unknown;
    try {
      await guard(request({ host: '127.0.0.1:8787' }));
    } catch (thrown) {
      error = thrown;
    }
    const apiError = await rejection(error);
    expect(apiError.code).toBe('UNAUTHENTICATED');
    expect(apiError.statusCode).toBe(401);
    expect(apiError.message).toBe('Authentication required');
    expect(apiError.details).toEqual({ reason: 'authentication-required' });
  });

  it('answers the startup-refused shapes fail-closed 401, never open', async () => {
    // A construction fed inconsistent facts (the config layer refuses
    // these at startup — task 073): both arms demand authentication
    // nothing can satisfy, so the surface stays shut.
    const requiredWithoutPassword = createAuthModeGuard({
      mode: 'required',
      bindHost: '127.0.0.1',
    });
    await expect(requiredWithoutPassword(request({}))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const remoteWithoutPassword = createAuthModeGuard({
      mode: 'auto',
      bindHost: '192.168.1.5',
    });
    await expect(remoteWithoutPassword(request({}))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('passes an authenticated request through the demanding verdicts (the 153–155 seam)', async () => {
    const guard = createAuthModeGuard({
      mode: 'required',
      bindHost: '127.0.0.1',
      passwordConfigured: () => true,
      isAuthenticated: (request) => Promise.resolve(request.headers.cookie !== undefined),
    });
    // The seam is awaited and its boolean decides — the promise form is
    // the realistic one (scrypt and the session store are async).
    await expect(guard(request({ cookie: 'qm-session=t.example' }))).resolves.toBeUndefined();
    await expect(guard(request({}))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('consults the credential seam only on verdicts that demand credentials', async () => {
    const isAuthenticated = vi.fn(() => true);
    const guard = createAuthModeGuard({
      mode: 'auto',
      bindHost: '127.0.0.1',
      isAuthenticated,
    });
    // not-required: the seam is never asked.
    await expect(guard(request({}))).resolves.toBeUndefined();
    expect(isAuthenticated).not.toHaveBeenCalled();
    // proxy-without-password: misconfiguration answers 403 without a
    // credential question (there is no password to check against).
    await expect(guard(request({ forwarded: 'for=203.0.113.7' }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(isAuthenticated).not.toHaveBeenCalled();
    // required (a password exists and the proxy hop demands it): asked.
    const demanding = createAuthModeGuard({
      mode: 'auto',
      bindHost: '127.0.0.1',
      passwordConfigured: () => true,
      isAuthenticated,
    });
    await expect(demanding(request({ forwarded: 'for=203.0.113.7' }))).resolves.toBeUndefined();
    expect(isAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('reads the password fact per request — a live `passwd` takes effect without restart', async () => {
    // §6.4/D-026: auth.passwordHash is live. The thunk is consulted on
    // every request, so the passwordless 403 flips to the demanding 401
    // the moment the fact flips — the future reload feed changes the
    // answer by changing the fact, never the guard.
    let configured = false;
    const guard = createAuthModeGuard({
      mode: 'auto',
      bindHost: '127.0.0.1',
      passwordConfigured: () => configured,
      isAuthenticated: () => false,
    });
    const proxied = request({ 'x-forwarded-for': '203.0.113.7' });
    await expect(guard(proxied)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    configured = true;
    await expect(guard(proxied)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
