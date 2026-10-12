// The Overview's Savings card (R9): the daily job's summary, net of Dormeto's own cost, with what it does not count.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import SavingsCard from '../src/components/SavingsCard.vue';
import { api } from '../src/api';
import { useSession } from '../src/stores/session';

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
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountCard(value: unknown, role: 'viewer' | 'operator' | 'admin' = 'viewer') {
  answer.value = value;
  setActivePinia(createPinia());
  useSession().role = role;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const wrapper = mount(SavingsCard, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
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

  it('takes Dormeto\'s cost for the days computed only, in the first 30 days (review I7)', async () => {
    const recent = { ...SUMMARY, last30: { ...SUMMARY.last30, usd: 1.5 }, cumulative: { usd: 1.5, since: '2026-10-05', lastDay: '2026-10-07' } };
    const wrapper = await mountCard({ summary: recent });
    // 3 days computed: $5.78 × 3 / 30 = $0.58 of Dormeto's cost.
    expect(wrapper.text()).toContain('net about $0.92 over the 3 days computed');
    wrapper.unmount();
  });

  // R9.5: Spot at Spot prices, discounts for commitments set by administrators.
  const NONE = { compute: 0, databases: 0, updatedAt: null, updatedBy: null };
  const SET = { compute: 20, databases: 30, updatedAt: '2026-10-09T10:00:00.000Z', updatedBy: 'admin@example.com' };

  it('says the discounts, and that Spot is priced at Spot prices', async () => {
    const none = await mountCard({ summary: SUMMARY, settings: NONE });
    expect(none.text()).toContain('No discount set; Spot at Spot prices (Fargate Spot at 30% of on-demand).');
    none.unmount();
    const set = await mountCard({ summary: { ...SUMMARY, discounts: { compute: 20, databases: 30 } }, settings: SET });
    expect(set.text()).toContain('Discounts: compute 20%, databases 30% off the list prices; Spot at Spot prices (Fargate Spot at 30% of on-demand).');
    expect(set.text()).not.toContain('from the next day computed');
    expect(set.text()).toMatch(/AWS list prices of what the naps stopped, against 24\/7/);
    expect(set.text()).toContain('the discounts are an average rate');
    expect(set.text()).not.toContain('Savings Plans, Reserved Instances and Spot lower the real figure');
    set.unmount();
  });

  it('says a change of discounts applies from the next day computed; a summary from before has none', async () => {
    const changed = await mountCard({ summary: { ...SUMMARY, discounts: { compute: 0, databases: 0 } }, settings: SET });
    expect(changed.text()).toContain('from the next day computed');
    changed.unmount();
    const old = await mountCard({ summary: SUMMARY, settings: SET });
    expect(old.text()).toContain('from the next day computed');
    old.unmount();
    const same = await mountCard({ summary: SUMMARY, settings: NONE });
    expect(same.text()).not.toContain('from the next day computed');
    same.unmount();
  });

  it('lets administrators only edit the discounts: whole percentages from 0 to 90', async () => {
    const operator = await mountCard({ summary: SUMMARY, settings: NONE }, 'operator');
    expect(operator.find('[data-test="edit-discounts"]').exists()).toBe(false);
    operator.unmount();
    const wrapper = await mountCard({ summary: SUMMARY, settings: NONE }, 'admin');
    await wrapper.find('[data-test="edit-discounts"]').trigger('click');
    await flushPromises();
    const field = (name: string) => document.querySelector(`[data-test="${name}"] input`) as HTMLInputElement;
    const save = () => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement;
    expect(document.body.textContent).toContain('an average rate');
    for (const [compute, databases] of [['91', '30'], ['2.5', '30'], ['20', '']]) {
      field('compute').value = compute!;
      field('compute').dispatchEvent(new Event('input'));
      field('databases').value = databases!;
      field('databases').dispatchEvent(new Event('input'));
      await flushPromises();
      expect(save().disabled, `${compute}, ${databases}`).toBe(true);
    }
    field('databases').value = '30';
    field('databases').dispatchEvent(new Event('input'));
    await flushPromises();
    vi.mocked(api).mockClear();
    save().click();
    await flushPromises();
    const put = vi.mocked(api).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put).toEqual(['/savings/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ compute: 20, databases: 30 }) })]);
    wrapper.unmount();
  });
});
