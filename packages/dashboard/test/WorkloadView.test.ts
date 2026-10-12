import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadView from '../src/views/WorkloadView.vue';
import StateBar from '../src/components/StateBar.vue';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
// Awake for 35 minutes; the run last written 5 minutes ago (a nap request at the last idle check: no state change).
const status = {
  workloadId: '5cdfbf844b925bf8', name: 'ligoj-ui-prod', url: null, router: { version: '0.23.2', build: 'b' }, state: 'AWAKE',
  updatedAt: minutesAgo(5), awakeSince: minutesAgo(35), wakeStartedAt: minutesAgo(36), failedAt: null, wakeCount: 2, holders: 0, pendingWake: false,
  pauses: [], drift: [], lastRequestAt: minutesAgo(40), nap: { eligibleAt: minutesAgo(1), latestAt: minutesAgo(0), inSeconds: 0 }, route: 'app', rules: [], issues: [],
  backends: [], ignoredTargets: [], recommendations: [], targets: [], settings: { waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 300, maxHolders: 100 },
  stats: null, ipLists: [], wakeMode: 'any', wakeRules: [], noWakeRules: [],
};
let current: Record<string, unknown> = status;
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(current)) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

async function mountView() {
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }] });
  await router.push('/workloads/dmtr-dev/5cdfbf844b925bf8');
  const wrapper = mount(WorkloadView, { props: { router: 'dmtr-dev', id: '5cdfbf844b925bf8' }, global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return wrapper;
}

describe('Workload view', () => {
  it('shows in its header its time in each state over 7 days, the bar of its Workloads row (user request)', async () => {
    const states7d = { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { ASLEEP: 500_000, AWAKE: 104_800 } };
    current = { ...status, states7d, idleHours7d: 150, requests7d: 12 };
    const wrapper = await mountView();
    const bar = wrapper.find('[data-test="header"]').findComponent(StateBar);
    expect(bar.props()).toMatchObject({ states: states7d, idleHours7d: 150, requests7d: 12 });
    wrapper.unmount();
    current = status;
  });

  it('says why the last wake failed, how many times in a row, and when a request retries it (R7b)', async () => {
    current = {
      ...status, state: 'FAILED', failedAt: minutesAgo(2), consecutiveFailures: 3, nextAttemptAt: new Date(Date.now() + 4 * 60_000).toISOString(), fallbacks: [],
      failure: { kind: 'capacity', step: 'wake', backend: 'rds-instance:shop-db', message: 'no capacity for db.t4g.micro in eu-west-3a', at: minutesAgo(2) },
    };
    const wrapper = await mountView();
    const alert = wrapper.find('[data-test="failure"]');
    expect(alert.text()).toContain('Last wake failed: no capacity');
    expect(alert.text()).toContain('no capacity for db.t4g.micro in eu-west-3a');
    expect(alert.text()).toContain('shop-db');
    expect(alert.text()).toContain('3 failures in a row');
    expect(alert.text()).toContain('next attempt in 4 min');
    wrapper.unmount();
    current = status;
  });

  it('says which instances run on a fallback instance type, until the next nap (R7b)', async () => {
    current = { ...status, fallbacks: [{ instance: 'i-0123456789abcdef0', from: 't3.medium', to: 't3a.medium' }] };
    const wrapper = await mountView();
    expect(wrapper.find('[data-test="failure"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="fallbacks"]').text()).toMatch(/i-0123456789abcdef0 on t3a\.medium instead of t3\.medium.*next nap/);
    wrapper.unmount();
    current = status;
  });


  it('dates the state from when it began, not from the last write of the workload', async () => {
    setActivePinia(createPinia());
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }] });
    await router.push('/workloads/dmtr-dev/5cdfbf844b925bf8');
    const wrapper = mount(WorkloadView, { props: { router: 'dmtr-dev', id: '5cdfbf844b925bf8' }, global: { plugins: [createVuetify({ components, directives }), router] } });
    await flushPromises();
    const rows = Object.fromEntries(wrapper.findAll('tr').map((tr) => [tr.find('th').text(), tr.find('td').text()]));
    expect(rows['Awake since']).toBe('35 min ago');
    expect(rows['Last state change']).toBeUndefined();
    wrapper.unmount();
  });
});
