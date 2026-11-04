import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  MAX_LOGIN_DELAY_SLEEP_MS,
  createSessionAuthenticator,
  defaultSleep,
  sessionCookieTransportOf,
} from '../../src/server/api/auth-routes';
import { HTTP_CONNECTION_TIMEOUT_MS } from '../../src/server/http';
import type { QuotaRepository, SessionRecord } from '../../src/storage/repository';
import { SESSION_COOKIE_NAME } from '../../src/services/session-cookie';
import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../../src/storage/migrations';
import { hashSessionToken } from '../../src/services/sessions';

/**
 * The pure halves of the auth route module (task U-041, D-146), unit lane
 * per the testing convention: the §15.1 seam consumption
 * (`createSessionAuthenticator` — the D-124 one-lambda wiring behind the
 * D-121 seam) over a behavioral in-memory session facade, and the D-126
 * transport-fact resolution over request doubles. The wire behavior (the
 * endpoints, the budget, the cookie) lives in
 * `test/integration/auth-routes.spec.ts`; what belongs here are exactly
 * the arms a socketless view can name: the missing/empty-cookie early
 * returns (and their storage-call-freedom), the verdict mapping, the
 * refresh write's exact arguments, and the header shapes the `Secure`
 * verdict reads.
 */

/** Deterministic §11.1 epoch-millisecond base: 2026-11-04T09:00:00Z. */
const T0 = 1_789_000_000_000;

/** One day in epoch milliseconds. */
const DAY_MS = 86_400_000;

/* ── The behavioral session facade ──────────────────────────────────────── */

/**
 * The in-memory double of the two facade methods `authenticateSession`
 * touches (D-124's suite used the real repository; here the unit lane
 * wants the CALLS observable — the refresh write's arguments and the
 * read counter that proves the early returns are storage-call-free).
 */
function createSessionFacade(sessions: ReadonlyArray<readonly [string, SessionRecord]>) {
  const rows = new Map(sessions);
  const calls = { getSession: 0, touchSession: 0 };
  const touches: Array<{ tokenHash: string; lastSeenAt: number; expiresAt: number }> = [];
  const repository = {
    getSession(tokenHash: string): SessionRecord | null {
      calls.getSession += 1;
      return rows.get(tokenHash) ?? null;
    },
    touchSession(tokenHash: string, sighting: { lastSeenAt: number; expiresAt: number }): boolean {
      calls.touchSession += 1;
      touches.push({ tokenHash, ...sighting });
      if (!rows.has(tokenHash)) return false;
      rows.set(tokenHash, { ...rows.get(tokenHash)!, ...sighting });
      return true;
    },
  } as unknown as QuotaRepository;
  return { repository, calls, touches };
}

/** A minimal request double — the authenticator reads cookies only. */
function requestWithCookies(cookies: Record<string, string | undefined>): FastifyRequest {
  return { cookies } as unknown as FastifyRequest;
}

/** A minimal request double for the transport resolution. */
function requestForTransport(parts: {
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    protocol: parts.protocol ?? 'http',
    headers: parts.headers ?? {},
  } as unknown as FastifyRequest;
}

/** A session row with the §11.2 times, for seeding the facade. */
function sessionRow(
  token: string,
  times: { createdAt: number; lastSeenAt: number; expiresAt: number },
): readonly [string, SessionRecord] {
  return [hashSessionToken(token), { tokenHash: hashSessionToken(token), ...times }];
}

describe('createSessionAuthenticator — the §15.1 seam consumption (D-146)', () => {
  it('answers false for a missing cookie without touching storage', () => {
    const facade = createSessionFacade([]);
    const authenticator = createSessionAuthenticator({
      repository: facade.repository,
      now: () => T0,
    });
    expect(authenticator(requestWithCookies({}))).toBe(false);
    expect(facade.calls).toEqual({ getSession: 0, touchSession: 0 });
  });

  it('answers false for an empty-string cookie without touching storage', () => {
    const facade = createSessionFacade([]);
    const authenticator = createSessionAuthenticator({
      repository: facade.repository,
      now: () => T0,
    });
    expect(authenticator(requestWithCookies({ [SESSION_COOKIE_NAME]: '' }))).toBe(false);
    expect(facade.calls).toEqual({ getSession: 0, touchSession: 0 });
  });

  it('answers false for a cookie naming no row (garbage digests to a miss)', () => {
    const facade = createSessionFacade([]);
    const authenticator = createSessionAuthenticator({
      repository: facade.repository,
      now: () => T0,
    });
    expect(authenticator(requestWithCookies({ [SESSION_COOKIE_NAME]: 'garbage-token' }))).toBe(
      false,
    );
    // The miss was a real lookup (digest → no row), never a raw-token read.
    expect(facade.calls.getSession).toBe(1);
    expect(facade.calls.touchSession).toBe(0);
  });

  it('answers true for a live session and refreshes the sighting through the row', () => {
    const token = 'live-token-value';
    const facade = createSessionFacade([
      sessionRow(token, {
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      }),
    ]);
    const now = T0 + DAY_MS;
    const authenticator = createSessionAuthenticator({
      repository: facade.repository,
      now: () => now,
    });
    expect(authenticator(requestWithCookies({ [SESSION_COOKIE_NAME]: token }))).toBe(true);
    // D-124's refresh: last_seen at the sighting, expiry through the
    // single-sited formula (the 7-day slide, capped by the 30-day age).
    expect(facade.touches).toEqual([
      {
        tokenHash: hashSessionToken(token),
        lastSeenAt: now,
        expiresAt: T0 + Math.min(DAY_MS + SESSION_INACTIVITY_TIMEOUT_MS, SESSION_MAX_AGE_MS),
      },
    ]);
  });

  it('answers false for an expired session and performs no refresh write', () => {
    const token = 'expired-token-value';
    const expiresAt = T0 + DAY_MS;
    const facade = createSessionFacade([
      sessionRow(token, { createdAt: T0, lastSeenAt: T0, expiresAt }),
    ]);
    // D-124's half-open verdict: a request AT the expiry instant is dead.
    const authenticator = createSessionAuthenticator({
      repository: facade.repository,
      now: () => expiresAt,
    });
    expect(authenticator(requestWithCookies({ [SESSION_COOKIE_NAME]: token }))).toBe(false);
    expect(facade.calls.touchSession).toBe(0);
  });

  it('answers false when the row vanishes at the refresh write (passwd revoked it)', () => {
    const token = 'raced-token-value';
    // The race arm: the lookup sees a row, the touch answers gone (the
    // cross-process revocation D-124 documented for exactly this shape).
    const repository = {
      getSession: () => ({
        tokenHash: hashSessionToken(token),
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      }),
      touchSession: () => false,
    } as unknown as QuotaRepository;
    const authenticator = createSessionAuthenticator({ repository, now: () => T0 });
    expect(authenticator(requestWithCookies({ [SESSION_COOKIE_NAME]: token }))).toBe(false);
  });
});

describe('sessionCookieTransportOf — the D-126 recipe resolution (D-146)', () => {
  it('reads the socket fact from the protocol and nothing else by default', () => {
    expect(sessionCookieTransportOf(requestForTransport({ protocol: 'http' }))).toEqual({
      requestTls: false,
      forwardedProto: undefined,
      forwarded: undefined,
    });
  });

  it('marks the socket fact true only for the https protocol', () => {
    expect(sessionCookieTransportOf(requestForTransport({ protocol: 'https' })).requestTls).toBe(
      true,
    );
  });

  it('passes the folded X-Forwarded-Proto and Forwarded values through verbatim', () => {
    const facts = sessionCookieTransportOf(
      requestForTransport({
        headers: { 'x-forwarded-proto': 'https, http', forwarded: 'for=192.0.2.60;proto=https' },
      }),
    );
    expect(facts.forwardedProto).toBe('https, http');
    expect(facts.forwarded).toBe('for=192.0.2.60;proto=https');
  });

  it('joins array-shaped header values into the comma list form the parsers take', () => {
    const facts = sessionCookieTransportOf(
      requestForTransport({ headers: { 'x-forwarded-proto': ['https', 'http'] } }),
    );
    expect(facts.forwardedProto).toBe('https, http');
  });
});

describe("the transport-safe delay bounds (D-146, the review round's P1 pins)", () => {
  it('clamps the login sleep comfortably inside the socket-inactivity bound', () => {
    // D-109's own rule: the connection bound "must comfortably exceed the
    // longest legitimate silent handler" — and a login inside its delay is
    // exactly that. The clamp ceiling must leave room for the scrypt
    // verify that follows the sleep, hence the one-minute margin; the
    // relation is pinned here so the two constants cannot drift apart
    // silently in either direction.
    expect(MAX_LOGIN_DELAY_SLEEP_MS).toBeLessThanOrEqual(HTTP_CONNECTION_TIMEOUT_MS - 60_000);
    expect(MAX_LOGIN_DELAY_SLEEP_MS).toBeGreaterThan(0);
  });

  it('unrefs the default sleep timer: an in-flight delay never holds the loop open', async () => {
    // §5.6: runServer drains the event loop instead of exiting, so a
    // REFERENCED delay timer would linger up to the full clamp past the
    // bounded shutdown. The observable: the timer handle the default
    // sleep arms reports hasRef() false while the promise is pending.
    // The spy is a pure pass-through — it only captures the REAL handle
    // the module created, so `hasRef()` reports what the module did; the
    // pending 60 s sleep is deliberately not awaited (an unref'd timer
    // never blocks anything — that is the assertion).
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      void defaultSleep(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      const timer = spy.mock.results[0]!.value as { hasRef(): boolean };
      expect(timer.hasRef()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
