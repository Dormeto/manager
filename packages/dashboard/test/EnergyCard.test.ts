// The Overview's energy card: one sentence under the figures, the method in its tooltip (the user, 2026-11-03).
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import EnergyCard from '../src/components/EnergyCard.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('EnergyCard', () => {
  it('says in one sentence whence the estimate comes, the method in a tooltip', async () => {
    const wrapper = mount(EnergyCard, { props: { energy: { kwh: 1234.5, co2Kg: 345.6, workloads: 18, estimated: 20 }, loaded: true }, attachTo: document.body,
      global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    expect(wrapper.find('[data-test="energy-note"]').text()).toBe('Estimate from 18 workloads, not a measure.');
    expect(wrapper.text()).not.toContain('50% CPU use');
    const more = wrapper.find('[data-test="energy-note"] [data-test="energy-more"]');
    expect(more.attributes('tabindex')).toBe('0');
    expect(more.attributes('aria-label')).toBe('How the energy is estimated');
    await more.trigger('mouseenter');
    await nextTick();
    await sleep(300);
    const tip = document.querySelector('.v-overlay--active [data-test="energy-tip"]')!.textContent!.replace(/\s+/g, ' ');
    for (const part of ['Each workload\'s last nap\'s items', 'every hour asleep within the savings baseline over the last 30 days', '50% CPU use',
      'an unknown region at the average', 'left out', 'Cloud Carbon Footprint']) expect(tip).toContain(part);
    wrapper.unmount();
  });

  it('says one workload in the singular', async () => {
    const wrapper = mount(EnergyCard, { props: { energy: { kwh: 2, co2Kg: 1, workloads: 1, estimated: 1 }, loaded: true }, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    expect(wrapper.find('[data-test="energy-note"]').text()).toBe('Estimate from 1 workload, not a measure.');
    wrapper.unmount();
  });
});
