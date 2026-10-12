import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadView from '../src/views/WorkloadView.vue';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
// Awake for 35 minutes; the run last written 5 minutes ago (a nap request at the last idle check: no state change).
const status = {
  workloadId: '5cdfbf844b925bf8', name: 'ligoj-ui-prod', url: null, router: { version: '0.23.2', build: 'b' }, state: 'AWAKE',
  updatedAt: minutesAgo(5), awakeSince: minutesAgo(35), wakeStartedAt: minutesAgo(36), failedAt: null, wakeCount: 2, holders: 0, pendingWake: false,
  pauses: [], drift: [], lastRequestAt: minutesAgo(40), nap: { eligibleAt: minutesAgo(1), latestAt: minutesAgo(0), inSeconds: 0 }, route: 'app', rules: [], issues: [],
  backends: [], ignoredTargets: [], recommendations: [], targets: [], settings: { waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 300, maxHolders: 100 },
  stats: null, ipLists: [], wakeMode: 'any', wakeRules: [], noWakeRules: [],
};
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(status)) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe('Workload view', () => {
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
