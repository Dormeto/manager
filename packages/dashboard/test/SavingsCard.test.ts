// The Overview's Savings card (R9): the daily job's summary, net of Dormeto's own cost, with what it does not count.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import SavingsCard from '../src/components/SavingsCard.vue';

const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 8).padStart(2, '0')}`, usd: i === 29 ? 1.25 : 0.5 }));
const SUMMARY = {
  computedAt: '2026-10-08T00:31:00.000Z', day: '2026-10-07', baseline: { kind: 'always' },
  last30: { usd: 15.75, asleepHours: 1234, days },
  month: { month: '2026-10', usd: 4.25 }, cumulative: { usd: 15.75, since: '2026-09-08', lastDay: '2026-10-07' },
  top: [{ account: '1', region: 'eu-west-1', router: 'dmt-dev', workloadId: 'demo-rds', name: 'demo-rds', usd: 9.5 }, { account: '1', region: 'eu-west-1', router: 'dmt-dev', workloadId: 'demo', name: 'demo', usd: 6.25 }],
  unpriced: { workloads: 1, hours: 24 }, workloads: 4, dormeto: { usdMonth: 5.78 },
};
const answer: { value: unknown } = { value: { summary: SUMMARY } };
vi.mock('../src/api', () => ({ api: vi.fn(async () => answer.value) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

async function mountCard(value: unknown) {
  answer.value = value;
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const wrapper = mount(SavingsCard, { global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return wrapper;
}

describe('SavingsCard', () => {
  it('says the last 30 days, this month and since the start, net of Dormeto\'s cost, with a bar a day', async () => {
    const wrapper = await mountCard({ summary: SUMMARY });
    const text = wrapper.text();
    expect(text).toContain('$15.75');
    expect(text).toContain('this month $4.25');
    expect(text).toMatch(/\$15\.75 since Sep 8/);
    expect(text).toContain('Dormeto costs about $5.78 a month');
    expect(wrapper.findAll('[data-test="bar"]')).toHaveLength(30);
    wrapper.unmount();
  });

  it('links its top workloads, and says what it does not count', async () => {
    const wrapper = await mountCard({ summary: SUMMARY });
    const links = wrapper.findAll('a').map((a) => [a.text(), a.attributes('href')]);
    expect(links).toEqual(expect.arrayContaining([[expect.stringContaining('demo-rds'), '/workloads/dmt-dev/demo-rds']]));
    expect(wrapper.text()).toMatch(/AWS list prices of what the naps stopped, against 24\/7/);
    expect(wrapper.text()).toMatch(/1 workload not priced yet/);
    wrapper.unmount();
  });

  it('says when the first estimate comes, before the job\'s first run', async () => {
    const wrapper = await mountCard({ summary: null });
    expect(wrapper.text()).toContain('No estimate yet: the first one is computed tonight at 00:30 UTC');
    wrapper.unmount();
  });
});
