import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../../src/server/api/error';
import {
  classifyHostRequest,
  createHostAllowlist,
  createHostGuard,
  type HostDecision,
  type HostGuardReason,
} from '../../src/server/api/security';

/**
 * The §15.3 Host-allowlist decision machinery (task 151, decision D-120):
 * `createHostAllowlist` — the spec's three literal names plus the
 * name-normalized configured host — and `classifyHostRequest`, the pure,
 * fail-closed verdict over `{host?, url?}` that compares authority NAMES
 * (ports unpinned: §15.6's SSH tunneling remaps them freely) and also
 * adjudicates absolute-form request targets, which fastify routes with
 * the full URL as `request.url` (verified live — an unchecked,
 * attacker-controlled authority without this leg). The `createHostGuard`
 * hook's wiring, statuses, bytes, and the duplicate-Host scan are pinned
 * here at the throw level and by `test/integration/api-host.spec.ts`
 * against the real construction.
 */

/** The denial verdict for a reason, as a comparable plain object. */
function denied(reason: HostGuardReason): HostDecision {
  return { allowed: false, reason };
}

/** The allowance verdict. */
const allowed: HostDecision = { allowed: true };

/** The default-construction allowlist: base names + the loopback bind. */
const LOOPBACK = createHostAllowlist('127.0.0.1');

describe('createHostAllowlist — the spec-literal base plus the configured host', () => {
  it('holds exactly the three §15.3 names and the configured host', () => {
    // Duplicated configured host collapses onto the base entry.
    expect(createHostAllowlist('127.0.0.1')).toEqual(
      Object.freeze(new Set(['localhost', '127.0.0.1', '[::1]'])),
    );
    expect(createHostAllowlist('192.168.1.5')).toEqual(
      Object.freeze(new Set(['localhost', '127.0.0.1', '[::1]', '192.168.1.5'])),
    );
  });

  it('normalizes the configured host — case, padding, IPv6 wire forms', () => {
    expect(createHostAllowlist('  QUOTAMETER.EXAMPLE ')).toEqual(
      createHostAllowlist('quotameter.example'),
    );
    // A bracketed IPv6 spelling loses a possible port after the literal;
    // an unbracketed colon-bearing spelling (Node's bind form) gains the
    // brackets the Host grammar requires (the review round's P1: an
    // unbracketed entry could never match the wire name, so a non-
    // loopback IPv6 bind would have rejected every request).
    expect(createHostAllowlist('[::1]:8787')).toEqual(createHostAllowlist('[::1]'));
    expect(createHostAllowlist('::1')).toEqual(createHostAllowlist('[::1]'));
    expect(createHostAllowlist('fd00::5').has('[fd00::5]')).toBe(true);
    // Zone ids encode the way the wire spells them (`%` → `%25`), in
    // both configured spellings.
    expect(createHostAllowlist('fe80::1%eth0').has('[fe80::1%25eth0]')).toBe(true);
    expect(createHostAllowlist('[fe80::1%eth0]')).toEqual(createHostAllowlist('fe80::1%eth0'));
    // An unterminated bracket stays verbatim — a never-matching entry
    // for a broken configuration, never a wire match.
    expect(createHostAllowlist('[::1').has('[::1')).toBe(true);
    // An empty configured value (schema-impossible) adds nothing: the
    // builder stays at the base names, so no empty name can ever match.
    expect(createHostAllowlist('')).toEqual(createHostAllowlist('localhost'));
    expect(createHostAllowlist('   ')).toEqual(LOOPBACK);
  });

  it('admits the configured IPv6 bind under its wire spelling', () => {
    const lan = createHostAllowlist('fd00::5');
    expect(classifyHostRequest({ host: '[fd00::5]:8787' }, lan)).toEqual(allowed);
    expect(classifyHostRequest({ host: '[fd00::5]' }, lan)).toEqual(allowed);
    const scoped = createHostAllowlist('fe80::1%eth0');
    expect(classifyHostRequest({ host: '[fe80::1%25eth0]:8787' }, scoped)).toEqual(allowed);
  });
});

describe('classifyHostRequest — allowed authorities (§15.3)', () => {
  it('accepts the three literal names bare, with default ports, and in any case', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost:80', // explicitly written default (the inject default)
      'localhost:443', // scheme-less: both defaults strip
      '127.0.0.1',
      '127.0.0.1:80',
      '127.0.0.1:443',
      '[::1]',
      '[::1]:80',
      '[::1]:443',
      '  LocalHost  ',
    ] as const) {
      expect(classifyHostRequest({ host }, LOOPBACK), host).toEqual(allowed);
    }
  });

  it('accepts non-default ports — the name is the verdict, not the port', () => {
    // D-120: §15.6's recommended SSH tunneling remaps ports freely
    // (`-L 9999:127.0.0.1:8787` sends `Host: localhost:9999`); the
    // rebinding threat is a name confusion, which this still rejects.
    for (const host of ['localhost:8787', 'localhost:9999', '127.0.0.1:65535', '[::1]:8787']) {
      expect(classifyHostRequest({ host }, LOOPBACK), host).toEqual(allowed);
    }
  });

  it('accepts the configured host and its port forms', () => {
    const lan = createHostAllowlist('192.168.1.5');
    for (const host of ['192.168.1.5', '192.168.1.5:8787', '192.168.1.5:80']) {
      expect(classifyHostRequest({ host }, lan), host).toEqual(allowed);
    }
    // The same header is a foreign host under the loopback construction.
    expect(classifyHostRequest({ host: '192.168.1.5' }, LOOPBACK)).toEqual(
      denied('disallowed-host'),
    );
  });

  it('ignores the request target when it is not absolute-form', () => {
    for (const url of ['/api/health', '/', '/accounts?x=1', '*', '//evil.example/path']) {
      expect(classifyHostRequest({ host: 'localhost', url }, LOOPBACK), url).toEqual(allowed);
    }
    expect(classifyHostRequest({ host: 'localhost' }, LOOPBACK)).toEqual(allowed);
  });

  it('accepts an absolute-form target on an allowlisted, Host-equal name', () => {
    // RFC 9112 §3.2.2: with an authority in the target, the Host must
    // say the same name — ports stay out of the comparison (D-120).
    expect(
      classifyHostRequest(
        { host: 'localhost:80', url: 'http://localhost:9999/api/health' },
        LOOPBACK,
      ),
    ).toEqual(allowed);
    expect(
      classifyHostRequest({ host: '[::1]', url: 'http://[::1]:8787/api/health' }, LOOPBACK),
    ).toEqual(allowed);
    // The https scheme arm: `https://localhost` drops its own default
    // (:443) and the name comparison stands.
    expect(
      classifyHostRequest({ host: 'localhost', url: 'https://localhost/x' }, LOOPBACK),
    ).toEqual(allowed);
  });
});

describe('classifyHostRequest — fail-closed rejections (§15.3)', () => {
  it('rejects a missing or empty Host', () => {
    expect(classifyHostRequest({}, LOOPBACK)).toEqual(denied('missing-host'));
    expect(classifyHostRequest({ host: undefined }, LOOPBACK)).toEqual(denied('missing-host'));
    expect(classifyHostRequest({ host: '' }, LOOPBACK)).toEqual(denied('missing-host'));
    expect(classifyHostRequest({ host: '   ' }, LOOPBACK)).toEqual(denied('missing-host'));
  });

  it('rejects every not-allowlisted name — the rebinding shapes', () => {
    for (const host of [
      'evil.example',
      'EVIL.EXAMPLE',
      'evil.example:8787',
      'localhost.evil.example',
      'evil.example.localhost',
      '127.0.0.2', // spec-literal: only 127.0.0.1, not the /8 range
      '0.0.0.0',
      '[::2]',
      '[fe80::1]',
      'local host',
      'localhost..',
    ] as const) {
      expect(classifyHostRequest({ host }, LOOPBACK), host).toEqual(denied('disallowed-host'));
    }
  });

  it('rejects malformed authorities instead of guessing', () => {
    for (const host of [
      '::1', // unbracketed IPv6 — the Host grammar requires brackets
      '[::1', // unterminated literal
      '[]', // empty literal
      'localhost:', // colon without a port
      'localhost:abc',
      'localhost:99999', // 5 digits but not a port value
      'localhost:123456', // 6 digits
      '[::1]:abc',
      'localhost:8080:80', // multi-colon garbage (the review round's fix:
      '127.0.0.1:80:443', // a trailing default port must not collapse it)
      '[::1]:80:443',
      'localhost, evil.example', // Node's duplicate-header join
      'localhost:80, evil.example:80', // joined where a port would sit
      ':80', // port without a name
    ] as const) {
      expect(classifyHostRequest({ host }, LOOPBACK), host).toEqual(denied('disallowed-host'));
    }
  });

  it('checks the Host header before the request target — a fixed order', () => {
    expect(
      classifyHostRequest({ host: 'evil.example', url: 'http://evil.example/x' }, LOOPBACK),
    ).toEqual(denied('disallowed-host'));
    expect(classifyHostRequest({ url: 'http://evil.example/x' }, LOOPBACK)).toEqual(
      denied('missing-host'),
    );
  });

  it('rejects absolute-form targets that are not allowlisted or unparseable', () => {
    expect(
      classifyHostRequest({ host: 'localhost', url: 'http://evil.example/api/health' }, LOOPBACK),
    ).toEqual(denied('disallowed-target'));
    // Case-insensitive scheme detection; uppercase host still fails on name.
    expect(
      classifyHostRequest({ host: 'localhost', url: 'HTTP://EVIL.EXAMPLE/x' }, LOOPBACK),
    ).toEqual(denied('disallowed-target'));
    // An unparseable absolute-form target is a rejected target.
    expect(classifyHostRequest({ host: 'localhost', url: 'http://[broken/x' }, LOOPBACK)).toEqual(
      denied('disallowed-target'),
    );
  });

  it('rejects an absolute-form target disagreeing with the Host name', () => {
    // RFC 9112 §3.2.2: the Host must be identical to the target's
    // authority — both names allowlisted is not enough.
    expect(
      classifyHostRequest({ host: 'localhost', url: 'http://127.0.0.1/api/health' }, LOOPBACK),
    ).toEqual(denied('target-mismatch'));
  });
});

describe('createHostGuard — the hook (D-113 throw-side pattern)', () => {
  /** A minimal request double — the hook reads headers, url, rawHeaders. */
  function request(
    host: string | undefined,
    rawHostEntries: readonly string[] = host === undefined ? [] : [host],
    url = '/api/health',
  ): FastifyRequest {
    const rawHeaders: string[] = [];
    for (const entry of rawHostEntries) {
      rawHeaders.push('Host', entry);
    }
    return {
      method: 'GET',
      url,
      headers: host === undefined ? {} : { host },
      raw: { rawHeaders },
    } as unknown as FastifyRequest;
  }

  /** The FORBIDDEN ApiError shape every rejection throws. */
  async function rejection(requestDouble: FastifyRequest): Promise<ApiError> {
    let error: unknown;
    try {
      await createHostGuard(LOOPBACK)(requestDouble);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }

  it('resolves without throwing for allowlisted hosts', async () => {
    await expect(createHostGuard(LOOPBACK)(request('localhost'))).resolves.toBeUndefined();
    await expect(createHostGuard(LOOPBACK)(request('127.0.0.1:8787'))).resolves.toBeUndefined();
    await expect(createHostGuard(LOOPBACK)(request('[::1]:443'))).resolves.toBeUndefined();
  });

  it('rejects a disallowed host with the byte-shaped FORBIDDEN ApiError', async () => {
    const apiError = await rejection(request('evil.example'));
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.statusCode).toBe(403);
    expect(apiError.message).toBe('Request host rejected');
    expect(apiError.details).toEqual({ reason: 'disallowed-host' });
  });

  it('rejects a missing host (the HTTP/1.0 wire shape)', async () => {
    const apiError = await rejection(request(undefined));
    expect(apiError.details).toEqual({ reason: 'missing-host' });
  });

  it('counts Host entries over rawHeaders, case-insensitively — one entry passes', async () => {
    await expect(
      createHostGuard(LOOPBACK)(request('localhost', ['localhost'])),
    ).resolves.toBeUndefined();
  });

  it('rejects duplicate Host entries — the RFC 9112 MUST the runtime does not enforce', async () => {
    // Node folds `headers.host` onto the first value (verified live);
    // rawHeaders keeps every wire entry, so the scan sees what the fold
    // hides. The folded first value being allowlisted must not save it.
    const apiError = await rejection(request('localhost', ['localhost', 'evil.example']));
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.details).toEqual({ reason: 'duplicate-host' });
  });

  it('rejects an absolute-form target through the same envelope', async () => {
    const apiError = await rejection(
      request('localhost', ['localhost'], 'http://evil.example/api/health'),
    );
    expect(apiError.details).toEqual({ reason: 'disallowed-target' });
    const mismatch = await rejection(
      request('localhost', ['localhost'], 'http://127.0.0.1/api/health'),
    );
    expect(mismatch.details).toEqual({ reason: 'target-mismatch' });
  });

  it('reads the joined split-header shape the way the runtime would deliver it', async () => {
    // `headers.host` arriving as an array (the readHeader join) produces
    // a comma-carrying value no name parse can establish — fail closed.
    const joined = {
      method: 'GET',
      url: '/api/health',
      headers: { host: ['localhost', 'evil.example'] },
      raw: { rawHeaders: ['Host', 'localhost'] },
    } as unknown as FastifyRequest;
    const apiError = await rejection(joined);
    expect(apiError.details).toEqual({ reason: 'disallowed-host' });
  });
});
