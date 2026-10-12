import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';
import { nextTick } from 'vue';
import StateChip from '../src/components/StateChip.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

describe('StateChip', () => {
  it('shows the state with its color', () => {
    const wrapper = mount(StateChip, { props: { state: 'FAILED' }, global: { plugins: [createVuetify({ components })] } });
    expect(wrapper.text()).toBe('FAILED');
    expect(wrapper.html()).toContain('bg-error');
  });

  it('shows an icon for each state, and explains the state in a tooltip', async () => {
    // As main.ts: the icons are SVG paths.
    const vuetify = () => createVuetify({ components, directives, icons: { defaultSet: 'mdi', aliases, sets: { mdi } } });
    const icons = new Set<string>();
    for (const state of ['AWAKE', 'NAPPING', 'ASLEEP', 'WAKING', 'FAILED']) {
      const wrapper = mount(StateChip, { props: { state }, global: { plugins: [vuetify()] } });
      icons.add(wrapper.find('.v-chip svg path').attributes('d') ?? '');
      wrapper.unmount();
    }
    expect(icons.size).toBe(5);
    const wrapper = mount(StateChip, { props: { state: 'ASLEEP' }, attachTo: document.body, global: { plugins: [vuetify()] } });
    await wrapper.find('.v-chip').trigger('mouseenter');
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toMatch(/Asleep: .*the next request wakes it/);
    wrapper.unmount();
  });
});
