import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../../ui/src/App.vue';

/**
 * Minimal component mount proving the Vue + Vite + Vue Test Utils pipeline
 * works under happy-dom (spec §17.1). Real component tests arrive with the
 * UI implementation stages.
 */
describe('App shell', () => {
  it('mounts and renders the application title', () => {
    const wrapper = mount(App);
    expect(wrapper.find('h1').text()).toBe('Quotameter');
  });

  it('shows the implementation status placeholder', () => {
    const wrapper = mount(App);
    expect(wrapper.find('[data-testid="app-status"]').text()).toContain('not implemented yet');
  });
});
