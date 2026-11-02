import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ApiErrorNotice from '../../ui/src/components/ApiErrorNotice.vue';
import { ApiClientError, type ApiClientErrorKind } from '../../ui/src/api/error';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';
import { API_ERROR_DEFINITIONS, type ApiErrorCode } from '../../src/schemas/api/error';

/**
 * The shared error presentation (task 169, spec §13/§14; decision D-134):
 * every taxonomy class renders its catalog sentence, every §13 registry
 * code renders its own, unknown codes fall back — and nothing a response
 * carried ever reaches the DOM. The hostile-envelope marker test is the
 * leak gate: internals-looking strings in the envelope's message and
 * details must not appear anywhere in the rendered text.
 */

/** The catalog's per-code sentence keys. */
type CodeKey = keyof (typeof en.errors)['codes'];

/** Registry code → the catalog key the notice renders for it. */
const CODE_TO_KEY: Record<ApiErrorCode, CodeKey> = {
  VALIDATION: 'validation',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'notFound',
  PAYLOAD_TOO_LARGE: 'payloadTooLarge',
  URI_TOO_LONG: 'uriTooLong',
  UNSUPPORTED_MEDIA_TYPE: 'unsupportedMediaType',
  INTERNAL: 'internal',
};

function mountNotice(error: ApiClientError) {
  return mount(ApiErrorNotice, {
    props: { error },
    global: { plugins: [createAppI18n()] },
  });
}

describe('ApiErrorNotice (task 169, D-134)', () => {
  it.each([
    ['network', en.errors.network],
    ['timeout', en.errors.timeout],
    ['aborted', en.errors.aborted],
    ['unexpected', en.errors.unexpected],
  ] as const)('renders the catalog sentence for the %s kind', (kind, expected) => {
    const wrapper = mountNotice(new ApiClientError({ kind: kind as ApiClientErrorKind }));
    const region = wrapper.find('[data-testid="api-error"]');
    expect(region.text()).toBe(expected);
    expect(region.attributes('role')).toBe('alert');
    expect(region.attributes('data-error-kind')).toBe(kind);
  });

  it('the catalog covers exactly the registry codes (no drift either way)', () => {
    // The component's per-code branches are pinned against the server's
    // own registry: every registry code has a catalog sentence, and the
    // mapping table above names no code the registry does not know.
    expect([...Object.keys(CODE_TO_KEY)].sort()).toEqual(
      [...Object.keys(API_ERROR_DEFINITIONS)].sort(),
    );
  });

  it.each(Object.entries(CODE_TO_KEY) as [ApiErrorCode, CodeKey][])(
    'renders the %s sentence for the envelope code',
    (code, key) => {
      const wrapper = mountNotice(
        new ApiClientError({
          kind: 'rejected',
          status: 400,
          code,
          serverMessage: 'server text',
          serverDetails: null,
        }),
      );
      const region = wrapper.find('[data-testid="api-error"]');
      expect(region.text()).toBe(en.errors.codes[key]);
      expect(region.attributes('data-error-kind')).toBe('rejected');
      expect(region.attributes('data-error-code')).toBe(code);
    },
  );

  it('falls back to the unknown-code sentence for a non-registry code', () => {
    const wrapper = mountNotice(
      new ApiClientError({ kind: 'rejected', status: 418, code: 'TEAPOT', serverMessage: 'x' }),
    );
    expect(wrapper.find('[data-testid="api-error"]').text()).toBe(en.errors.codes.unknown);
    expect(wrapper.find('[data-testid="api-error"]').attributes('data-error-code')).toBe('TEAPOT');
  });

  it('never leaks the envelope message or details (the marker gate)', () => {
    // A hostile or misrouted responder carrying internals-looking strings
    // in the envelope: the presentation must render ONLY the catalog
    // sentence for the code. `code` itself is the one deliberate
    // machine-readable channel (§13's stable code, surfaced as the
    // data-error-code attribute for e2e/diagnostics); `message` and
    // `details` have no channel into the DOM.
    const markerMessage = '/etc/quotameter/secret-config.json stack: at /srv/app/db.ts';
    const markerDetails = { path: '/var/lib/quotameter/quotameter.sqlite', key: 'sk-leak-me' };
    const wrapper = mountNotice(
      new ApiClientError({
        kind: 'rejected',
        status: 500,
        code: 'INTERNAL',
        serverMessage: markerMessage,
        serverDetails: markerDetails,
      }),
    );
    const rendered = wrapper.find('[data-testid="api-error"]').text();
    expect(rendered).toBe(en.errors.codes.internal);
    expect(rendered).not.toContain('/etc/quotameter');
    expect(rendered).not.toContain('quotameter.sqlite');
    expect(rendered).not.toContain('sk-leak-me');
    // And nothing else in the component's HTML carries the markers.
    expect(wrapper.html()).not.toContain('/etc/quotameter');
    expect(wrapper.html()).not.toContain('sk-leak-me');
  });

  it('never renders the transport error text of a network failure', () => {
    const wrapper = mountNotice(
      new ApiClientError({ kind: 'network', cause: new Error('ECONNREFUSED 127.0.0.1:8787') }),
    );
    const rendered = wrapper.find('[data-testid="api-error"]').text();
    expect(rendered).toBe(en.errors.network);
    expect(rendered).not.toContain('ECONNREFUSED');
  });
});
