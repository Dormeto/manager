import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import HistoryCard from '../src/components/HistoryCard.vue';
import { api } from '../src/api';

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const history = {
  from: local(7, 12), to: local(8, 12), truncated: false,
  phases: [
    { state: 'ASLEEP', from: local(7, 12), to: local(8, 9), cause: 'idle' },
    { state: 'WAKING', from: local(8, 9), to: local(8, 9, 1), cause: 'manager', by: 'ops@example.com' },
    { state: 'AWAKE', from: local(8, 9, 1), to: local(8, 12) },
  ],
  totals: { ASLEEP: 21 * 3600, WAKING: 60, AWAKE: 179 * 60 },
  wakes: { count: 1, failed: 0, medianMs: 41_000, maxMs: 41_000 },
  before: null,
  entries: [
    { from: 'NAPPING', to: 'ASLEEP', at: local(7, 11), cause: 'idle' },
    { from: 'ASLEEP', to: 'WAKING', at: local(8, 9), cause: 'manager', by: 'ops@example.com' },
    { from: 'WAKING', to: 'AWAKE', at: local(8, 9, 1), durationMs: 41_000 },
  ],
};
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(history)) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

async function mountCard() {
  setActivePinia(createPinia());
  const wrapper = mount(HistoryCard, { props: { router: 'dmt-dev', id: 'demo', now: Date.parse(local(8, 12)) }, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return wrapper;
}

describe('HistoryCard', () => {
  it('draws a row per day, says the totals, and explains each phase', async () => {
    const wrapper = await mountCard();
    expect(vi.mocked(api)).toHaveBeenCalledWith('/workloads/dmt-dev/demo/history?days=7');
    expect(wrapper.findAll('[data-test="day"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('Asleep 88%');
    expect(wrapper.text()).toContain('1 wake, median 41 s, longest 41 s');
    const waking = wrapper.findAll('[data-test="segment"]').find((s) => s.attributes('aria-label')?.startsWith('Waking'))!;
    expect(waking.attributes('aria-label')).toMatch(/Waking .*1 min.*woken from the manager by ops@example\.com/);
    wrapper.unmount();
  });

  it('lists the transitions newest first, with their cause and the wake duration', async () => {
    const wrapper = await mountCard();
    const rows = wrapper.findAll('[data-test="transition"]').map((r) => r.text());
    expect(rows[0]).toMatch(/WAKING → AWAKE.*41 s/);
    expect(rows[1]).toMatch(/ASLEEP → WAKING.*woken from the manager by ops@example\.com/);
    expect(rows).toHaveLength(3);
    wrapper.unmount();
  });

  it('the asleep share is of the time with history; napping is told apart from waking (found live)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), totals: { UNKNOWN: 86_000, ASLEEP: 300, AWAKE: 100 },
      phases: [{ state: 'UNKNOWN', from: local(7, 12), to: local(8, 11, 53) }, { state: 'NAPPING', from: local(8, 11, 53), to: local(8, 11, 54) }, { state: 'ASLEEP', from: local(8, 11, 54), to: local(8, 12) }] });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('Asleep 75% of the time with history');
    expect(wrapper.find('[data-test="gap"]').exists()).toBe(true);
    const napping = wrapper.findAll('[data-test="segment"]').find((x) => x.attributes('aria-label')?.startsWith('Napping'))!;
    expect(napping.classes()).toContain('napping');
    wrapper.unmount();
  });

  it('says a capped period keeps its latest changes, and a first entry is first seen (review I2, M7)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), truncated: true, entries: [{ from: null, to: 'ASLEEP', at: local(7, 11), inferred: true }] });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('More than 5,000 changes in this period: only the latest are drawn');
    expect(wrapper.find('[data-test="transition"]').text()).toMatch(/first seen → ASLEEP.*first seen by the manager/);
    wrapper.unmount();
  });

  it('estimates the period\'s savings when the history has them (R9)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), savings: { usd: 0.957, hours: 21, items: [{ item: { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }, hourly: 0.0456, hours: 21, usd: 0.957 }], unpriced: [], baseline: { kind: 'always' } } });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('saved about $0.96 (estimate)');
    wrapper.unmount();
  });

  it('reloads for another period', async () => {
    const wrapper = await mountCard();
    await wrapper.findAll('button').find((b) => b.text() === '30 days')!.trigger('click');
    await flushPromises();
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/workloads/dmt-dev/demo/history?days=30');
    wrapper.unmount();
  });
});
