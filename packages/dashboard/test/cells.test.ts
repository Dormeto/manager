// Cells of the discovery table: a short visible value, the details in a tooltip (hover or keyboard focus).
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import BackendLabel from '../src/components/BackendLabel.vue';
import IdleBar from '../src/components/IdleBar.vue';
import RegionLabel from '../src/components/RegionLabel.vue';
import StatusChip from '../src/components/DiscoveryStatusChip.vue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());
const render = (component: object, props: Record<string, unknown>) => {
  wrapper = mount(component, { props, attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
  return wrapper;
};
// The tooltip's text once its activator is hovered.
async function tooltipOf(w: VueWrapper, selector: string) {
  await w.find(selector).trigger('mouseenter');
  await nextTick();
  await sleep(300);
  return document.querySelector('.v-overlay-container')?.textContent ?? '';
}

describe('discovery cells', () => {
  it('shows a region as its flag only, its location, country and code in the tooltip', async () => {
    const w = render(RegionLabel, { region: 'eu-west-1' });
    expect(w.text()).toBe('');
    expect(w.find('img').attributes('src')).toMatch(/\.svg|^data:image\/svg/);
    expect(w.find('.region-label').attributes('aria-label')).toBe('eu-west-1, Europe (Ireland)');
    const tip = await tooltipOf(w, '.region-label');
    expect(tip).toContain('Europe (Ireland)');
    expect(tip).toContain('Ireland · eu-west-1');
  });

  it('shows an unknown region as a globe, its code in the tooltip', async () => {
    const w = render(RegionLabel, { region: 'xx-moon-1' });
    expect(w.find('img').exists()).toBe(false);
    expect(await tooltipOf(w, '.region-label')).toContain('xx-moon-1');
  });

  it('shows a backend as its icon and id, its service and ARN in the tooltip', async () => {
    const w = render(BackendLabel, { backend: { kind: 'instance', id: 'i-0f30c85bc47412bf3' }, account: '121014831971', region: 'eu-west-1' });
    expect(w.text()).toBe('i-0f30c85bc47412bf3');
    expect(w.text()).not.toContain('EC2 instance');
    expect(w.find('.backend-label .mono').classes()).toContain('nowrap'); // never "i-" alone on a line
    const tip = await tooltipOf(w, '.backend-label');
    expect(tip).toContain('EC2 instance');
    expect(tip).toContain('arn:aws:ec2:eu-west-1:121014831971:instance/i-0f30c85bc47412bf3');
  });

  it('shows the idle share as a colored bar without text, explained in the tooltip', async () => {
    const w = render(IdleBar, { idleHours7d: 154, requests7d: 1234 });
    expect(w.text()).toBe('');
    expect(w.html()).toContain('background-color: rgb(57, 182, 32)'); // hsl(110 70% 42%), as jsdom serializes it
    expect(w.find('.idle-bar').attributes('aria-label')).toBe('Idle 92 % of the last 7 days');
    const tip = await tooltipOf(w, '.idle-bar');
    expect(tip).toContain('154 of 168 hours without any request');
    expect(tip).toContain('CloudWatch');
  });

  it('shows a status by its short name, its meaning and transitions in the tooltip', async () => {
    const w = render(StatusChip, { status: 'pending-onboarding' });
    expect(w.text()).toBe('To onboard');
    const tip = await tooltipOf(w, '.v-chip');
    expect(tip).toContain('Onboard → Managed');
    expect(tip).toContain('Dismiss → Dismissed');
  });
});
