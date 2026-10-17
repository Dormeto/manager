import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import OverviewView from '../src/views/OverviewView.vue';

const late = new Date(Date.now() - 60 * 60_000).toISOString();
const failing = { alerts: false };
const paths: string[] = [];
// The bar of all workloads (GET /workloads/states), with the energy the API estimates (PR #1).
const ENERGY = { kwh: 1234.5, co2Kg: 345.6, workloads: 2, estimated: 5 };
let fleetStates: Record<string, unknown> = {
  workloads: 2, computedAt: late, cacheMinutes: 60, states7d: { from: late, to: late, totals: {} },
  costs: { baseline: { kind: 'always' }, saved: { usd: 1, hours: 2, unpricedHours: 0 }, hourly: 0.1, monthly: 10, priced: 1 }, energy: ENERGY,
};
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    paths.push(path);
    if (path === '/workloads/states') return structuredClone(fleetStates);
    if (path === '/alerts' && failing.alerts) throw new Error('SNS throttled');
    if (path === '/alerts') {
      return {
        alarms: [{ id: 'router#1#eu-west-1', kind: 'router', name: 'dmt-dev', account: '1', region: 'eu-west-1', level: 'error', since: late, problems: [{ code: 'check-late', level: 'error', text: 'idle check late', since: late }] }],
        notifications: { topicArn: 'arn', confirmed: 1, pending: 0 },
      };
    }
    return {
      workloads: [], total: 0, byState: { ASLEEP: 2 }, stats7d: { wakes: 0, ignored: 0, deferred: 0 },
      routers: [{ name: 'dmt-dev', region: 'eu-west-1', version: '0.24.0', workloads: 2, checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: late, health: { status: 'error', problems: [] } }],
    };
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
// Reduced motion: the figures show at once, without counting up.
window.matchMedia ??= ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
async function mountOverview() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const wrapper = mount(OverviewView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('Overview', () => {
  it('shows the open alarms in the Alerts card, instead of a banner per late router', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
    const wrapper = mount(OverviewView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Alerts');
    expect(wrapper.text()).toContain('dmt-dev (1 · eu-west-1)idle check late');
    expect(wrapper.text()).not.toContain('do not nap on their own');
    wrapper.unmount();
  });

  it('review: still shows the workloads when the alerts cannot be read', async () => {
    failing.alerts = true;
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
    const wrapper = mount(OverviewView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Asleep');
    expect(wrapper.text()).not.toContain('SNS throttled');
    expect(wrapper.find('.v-card .text-headline-large').text()).toBe('0');
    failing.alerts = false;
    wrapper.unmount();
  });

  it('links each router to its view (user request)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
    const wrapper = mount(OverviewView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    // The routers list, and the router's alert in the Alerts card.
    const links = wrapper.findAll('a.v-list-item').filter((a) => a.text().startsWith('dmt-dev')).map((a) => a.attributes('href'));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(new Set(links)).toEqual(new Set(['/routers/dmt-dev']));
    wrapper.unmount();
  });

  it('says the energy the naps did not use as the API estimates it, from the bar of all workloads: never every workload (PR #1)', async () => {
    paths.length = 0;
    const wrapper = await mountOverview();
    const card = wrapper.find('.dm-energy');
    expect(card.text()).toMatch(/1,200\s*kWh/);
    expect(card.text()).toMatch(/350\s*kg CO₂e/);
    // Everyday equivalents, approximate: 1234.5 kWh / 15 Wh a smartphone charge.
    expect(card.text()).toContain('≈ 82,000smartphone charges');
    // The method, in the card's note.
    expect(card.text()).toContain('Estimate from 2 workloads');
    for (const part of ['50% CPU use', 'every hour asleep within the savings baseline over the last 30 days', 'an unknown region at the average', 'left out', 'Cloud Carbon Footprint']) expect(card.text()).toContain(part);
    expect(paths.filter((p) => p === '/workloads/states')).toHaveLength(1);
    expect(paths.some((p) => /states=1|limit=1000/.test(p))).toBe(false);
    wrapper.unmount();
  });

  it('says no estimate yet rather than a zero: no workload estimated, or no prices (PR #1)', async () => {
    for (const energy of [{ kwh: 0, co2Kg: 0, workloads: 0, estimated: 0 }, undefined]) {
      const saved = fleetStates;
      fleetStates = { ...fleetStates, energy };
      const wrapper = await mountOverview();
      const card = wrapper.find('.dm-energy');
      expect(card.text()).toContain('No estimate yet');
      expect(card.text()).not.toMatch(/\d\s*kWh/);
      fleetStates = saved;
      wrapper.unmount();
    }
  });
});
