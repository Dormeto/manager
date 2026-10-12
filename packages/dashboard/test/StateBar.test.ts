// A workload's time in each state over 7 days (user request): the bar of its Workloads row and of its view's header, in the
// history's colors, each state and its share explained in its tooltip.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import StateBar from '../src/components/StateBar.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

// A day without history, then 6 days: asleep 5 days, awake 23 h 53 min 20 s, waking 6 min 40 s.
const STATES = { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { UNKNOWN: 86_400, ASLEEP: 432_000, AWAKE: 86_000, WAKING: 400 } };
const render = (props: Record<string, unknown>) => mount(StateBar, { props, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
const hover = async (wrapper: ReturnType<typeof render>) => {
  await wrapper.find('[data-test="state-bar"]').trigger('mouseenter');
  await nextTick();
  await new Promise((r) => setTimeout(r, 300));
  return document.body.textContent ?? '';
};
const widths = (wrapper: ReturnType<typeof render>) => wrapper.findAll('[data-test="state-segment"]').map((s) => Number.parseFloat(s.attributes('style')!.match(/width: ([\d.]+)%/)![1]!));

describe('StateBar', () => {
  it('draws the time with history in each state, in the history\'s colors and order; a short one stays visible', () => {
    const wrapper = render({ states: STATES });
    const segments = wrapper.findAll('[data-test="state-segment"]');
    expect(segments.map((s) => s.classes().find((c) => c.startsWith('bg-')))).toEqual(['bg-success', 'bg-info', 'bg-warning']);
    const [awake, asleep, waking] = widths(wrapper);
    expect(awake! + asleep! + waking!).toBeCloseTo(100, 5);
    expect(asleep! / awake!).toBeCloseTo(432_000 / 86_000, 0);
    expect(waking).toBeGreaterThanOrEqual(1);
    expect(wrapper.find('[data-test="state-bar"]').attributes('aria-label')).toBe('Last 7 days: awake 17 %, asleep 83 %, waking <1 %');
    wrapper.unmount();
  });

  it('explains each state with its share and time in its tooltip, the time without history, and the hours without requests', async () => {
    const wrapper = render({ states: STATES, idleHours7d: 150, requests7d: 12 });
    const text = await hover(wrapper);
    expect(text).toContain('Last 7 days, of the time with history');
    expect(text).toMatch(/Awake17 %23 h 53 min.*serving requests/);
    expect(text).toMatch(/Asleep83 %5 d.*backends stopped/);
    expect(text).toMatch(/Waking<1 %6 min 40 s/);
    expect(text).toContain('No history for 1 d of the 7 days');
    expect(text).toContain('Requests: 150 of 168 hours without any request to its target group (12 requests in 7 days).');
    wrapper.unmount();
  });

  it('says when there is no history yet, and draws nothing', async () => {
    for (const states of [null, { ...STATES, totals: { UNKNOWN: 604_800 } }]) {
      const wrapper = render({ states });
      expect(wrapper.findAll('[data-test="state-segment"]')).toHaveLength(0);
      expect(await hover(wrapper)).toContain('No history yet');
      wrapper.unmount();
    }
  });
});
