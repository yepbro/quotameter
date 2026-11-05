import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderView } from '../../src/schemas/api/providers';
import AccountAddForm from '../../ui/src/components/AccountAddForm.vue';
import { createApiClientPlugin } from '../../ui/src/api';
import { createAppI18n } from '../../ui/src/i18n';
import { FakeFetch, jsonResponse, type RecordedCall } from '../helpers/api';

/**
 * The add-account form's provider-select watch (task 182, spec §14.2/§5.3;
 * decisions D-135/D-165): the provider options arrive as a prop, and the
 * form owns one reconciliation rule — the first available type is the
 * default, an explicit user pick survives a reload of the list, and a stale
 * pick (its type gone from the build) is corrected to the first listed
 * provider instead of being sent to a certain server-side VALIDATION. The
 * page-level suite pins the whole §14.2 flow but loads the providers list
 * exactly once per mount, so the reload arms are only drivable at component
 * level — this spec mounts the form alone against a fake create endpoint on
 * the injectable fetch seam (the D-134 hermetic pattern: no network, no
 * browser globals).
 */

function provider(id: string, name = id): ProviderView {
  return { id, name, peakHours: null, metrics: [] };
}

const wrappers: VueWrapper[] = [];

async function mountForm(
  providers: ReadonlyArray<ProviderView>,
  createAnswers: RecordedCall[] = [],
): Promise<VueWrapper> {
  const fake = new FakeFetch((call) => {
    createAnswers.push(call);
    // The §13 create answer: the created account row (trusted cast, D-134).
    return Promise.resolve(
      jsonResponse(201, {
        id: 'acc-new',
        providerId: 'zai-coding-plan',
        label: 'Backup',
        enabled: true,
        status: 'active',
        hasKey: true,
        keySource: 'file',
        keyMask: '********',
        planName: null,
        createdAt: null,
        archivedAt: null,
      }),
    );
  });
  const wrapper = mount(AccountAddForm, {
    global: { plugins: [createAppI18n(), createApiClientPlugin({ fetchImpl: fake.impl })] },
    props: { providers, providersLoaded: true },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** The provider select's current value — the form's reconciliation state. */
function selectedProvider(wrapper: VueWrapper): string {
  return (wrapper.find('[data-testid="add-provider"]').element as HTMLSelectElement).value;
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

describe('AccountAddForm: the provider-select reconciliation (task 182, §14.2)', () => {
  it('adopts the first available provider as the default when nothing is chosen', async () => {
    const wrapper = await mountForm([provider('zai-coding-plan'), provider('other')]);
    expect(selectedProvider(wrapper)).toBe('zai-coding-plan');
  });

  it('keeps an explicit pick across a providers reload that still lists it', async () => {
    const wrapper = await mountForm([provider('zai-coding-plan'), provider('other')]);
    await wrapper.find('[data-testid="add-provider"]').setValue('other');
    expect(selectedProvider(wrapper)).toBe('other');

    // A reload arriving with a longer list must not reset the operator's
    // choice — the watch only fills an ABSENT selection.
    await wrapper.setProps({
      providers: [provider('zai-coding-plan'), provider('other'), provider('third')],
    });
    await flushPromises();
    expect(selectedProvider(wrapper)).toBe('other');
  });

  it('corrects a stale pick to the first listed provider — and sends the corrected id', async () => {
    const createAnswers: RecordedCall[] = [];
    const wrapper = await mountForm(
      [provider('zai-coding-plan'), provider('other')],
      createAnswers,
    );
    await wrapper.find('[data-testid="add-provider"]').setValue('other');

    // The build changes and 'other' is gone: the pick is stale, and sending
    // it would be a guaranteed VALIDATION refusal — the form corrects it.
    await wrapper.setProps({ providers: [provider('zai-coding-plan')] });
    await flushPromises();
    expect(selectedProvider(wrapper)).toBe('zai-coding-plan');

    await wrapper.find('[data-testid="add-label"]').setValue('Backup');
    await wrapper.find('button[type="submit"]').trigger('submit');
    await flushPromises();
    expect(createAnswers).toHaveLength(1);
    expect(JSON.parse(createAnswers[0]!.body ?? '{}')).toMatchObject({
      providerId: 'zai-coding-plan',
    });
  });

  it('an empty providers list adopts no default and disables the form; a later list fills it', async () => {
    const wrapper = await mountForm([]);
    // No provider to adopt: the select stays empty and the fieldset is the
    // honest "nothing can be added" surface (the no-providers sentence is
    // the page-level pin; this is the form's own state half).
    expect(selectedProvider(wrapper)).toBe('');
    expect((wrapper.find('fieldset').element as HTMLFieldSetElement).disabled).toBe(true);

    await wrapper.setProps({ providers: [provider('zai-coding-plan'), provider('other')] });
    await flushPromises();
    expect(selectedProvider(wrapper)).toBe('zai-coding-plan');
    expect((wrapper.find('fieldset').element as HTMLFieldSetElement).disabled).toBe(false);
  });
});
