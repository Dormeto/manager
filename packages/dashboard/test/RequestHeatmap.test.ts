// A workload's requests heatmap (RequestHeatmap.vue): read with the idle window advice, a 7-day grid with its summary,
// 14 days on demand, and a word when the advice has no hours yet.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RequestHeatmap from '../src/components/RequestHeatmap.vue';
import IdleWindowCard from '../src/components/IdleWindowCard.vue';
import { api } from '../src/api';
import type { IdleWindowAdvice } from '../src/types';

const HOUR = 3_600_000;
const from = new Date(new Date(2026, 9, 22, 10).getTime() - 14 * 24 * HOUR);
const counts = Array.from({ length: 14 * 24 }, (_, i) => { const t = new Date(from.getTime() + i * HOUR); return t.getHours() === 14 ? 120 : t.getHours() === 15 ? 40 : 0; });
const ADVICE: IdleWindowAdvice = {
  computedAt: '2026-10-22T08:00:00.000Z', from: from.toISOString(), to: '2026-10-22T08:00:00.000Z', current: 15, recommended: 10, checkMinutes: 5,
  wakeSeconds: 25, priced: false, windows: [{ minutes: 15, asleepHours: 22, usdMonth: null, wakesPerDay: 1, waitSecondsPerDay: 25 }],
  actual: { wakes: 14, replayedWakes: 14, noisy: false }, wakerTargetGroup: true, hours: { from: from.toISOString(), counts },
};
const answer: { value: unknown; fail?: string } = { value: ADVICE };
vi.mock('../src/api', () => ({ api: vi.fn(async () => { if (answer.fail) throw new Error(answer.fail); return answer.value; }) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const vuetify = () => createVuetify({ components, directives });

async function mountHeat(value: unknown, fail?: string) {
  answer.value = value;
  answer.fail = fail;
  const wrapper = mount(RequestHeatmap, { props: { router: 'dmt-dev', id: 'demo' }, global: { plugins: [vuetify()] } });
  await flushPromises();
  return wrapper;
}

describe('RequestHeatmap', () => {
  it('draws 7 days of 24 hours from the idle window advice, with the total, the quiet hours and the busiest hour', async () => {
    const wrapper = await mountHeat(ADVICE);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/workloads/dmt-dev/demo/idle-window');
    const cells = wrapper.findAll('[data-test="heat-cell"]');
    expect(cells).toHaveLength(7 * 24);
    expect(wrapper.text()).toContain('requests');
    expect(wrapper.text()).toMatch(/no request in \d+ of \d+ hours/);
    expect(wrapper.text()).toMatch(/busiest .+ 14:00 \(120\)/);
    expect(cells.filter((c) => c.attributes('data-level') === '4').length).toBeGreaterThan(0);
    expect(cells.some((c) => c.attributes('data-level') === 'none')).toBe(true);
  });

  it('says the hour and its requests in a tooltip when a cell is pointed at', async () => {
    const wrapper = await mountHeat(ADVICE);
    const busy = wrapper.findAll('[data-test="heat-cell"]').find((c) => c.attributes('data-tip')?.endsWith('120 requests'))!;
    expect(wrapper.find('[data-test="heat-tip"]').exists()).toBe(false);
    await busy.trigger('mouseover');
    expect(wrapper.find('[data-test="heat-tip"]').text()).toMatch(/14:00 to 15:00: 120 requests$/);
    expect(busy.classes()).toContain('is-active');
    await wrapper.find('.dm-heat__wrap').trigger('mouseleave');
    expect(wrapper.find('[data-test="heat-tip"]').exists()).toBe(false);
  });

  it('shows 14 days on demand', async () => {
    const wrapper = await mountHeat(ADVICE);
    await wrapper.findAll('button').find((b) => b.text() === '14 days')!.trigger('click');
    expect(wrapper.findAll('[data-test="heat-cell"]')).toHaveLength(14 * 24);
  });

  it('an advice kept from before the hours: says they come with the next one', async () => {
    const { hours: _, ...old } = ADVICE;
    const wrapper = await mountHeat(old);
    expect(wrapper.find('[data-test="heat-later"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="heat-cell"]')).toHaveLength(0);
  });

  it('says why when the requests cannot be read', async () => {
    const wrapper = await mountHeat(null, 'discovery is busy');
    expect(wrapper.text()).toContain('The requests cannot be read: discovery is busy');
  });

  it('shares one read with the Idle window card', async () => {
    vi.mocked(api).mockClear();
    answer.value = ADVICE;
    answer.fail = undefined;
    const plugins = [vuetify()];
    mount(RequestHeatmap, { props: { router: 'dmt-dev', id: 'demo' }, global: { plugins } });
    mount(IdleWindowCard, { props: { router: 'dmt-dev', id: 'demo' }, global: { plugins } });
    await flushPromises();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
});
