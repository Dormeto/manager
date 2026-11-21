// A failed Google Cloud standalone workload's page (plan 5, M52; router 4c1fe78): its kept permission failure as the router gives
// it (naming the tag), that the check retries its wake and when, and Nap offered to end the retries; no AWS word.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadView from '../src/views/WorkloadView.vue';
import { useSession } from '../src/stores/session';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const PROJECT = 'dormeto-dev';
const RESOURCE = 'projects/dormeto-dev/zones/europe-west2-b/instances/batch';
const PERMISSION = 'Permission compute.instances.start denied on projects/dormeto-dev/zones/europe-west2-b/instances/batch: check that it has the tag dormeto=managed';
const STATUS = {
  workloadId: 'batch', name: 'batch', kind: 'standalone', resource: RESOURCE, router: { version: '0.42.0', build: 'b' }, source: 'manager', tags: {}, state: 'FAILED',
  stateAt: minutesAgo(30), drift: [], updatedAt: minutesAgo(2), awakeSince: null, wakeStartedAt: minutesAgo(40), failedAt: minutesAgo(30),
  failure: { kind: 'permission', step: 'wake', message: PERMISSION, at: minutesAgo(30) }, consecutiveFailures: 3, nextAttemptAt: minutesAgo(-4),
  wakeCount: 3, pendingWake: false, pauses: [],
  idle: [
    { signal: 'cpu', below: 5, value: null, underSince: null, applies: true, from: 'default' },
    { signal: 'network', below: null, value: null, underSince: null, applies: false, reason: 'off', from: 'default' },
    { signal: 'metric', below: null, value: null, underSince: null, applies: false, reason: 'off', from: 'default' },
  ],
  nap: null, backends: [{ kind: 'instance', id: 'batch', status: 'TERMINATED' }], ignoredTargets: [], recommendations: [],
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' },
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'default', idleNetworkBytes: 'default', idleMetric: 'default' },
  type: { name: 'instance', from: 'backends' }, stats: { days: 7, since: minutesAgo(10_000), today: { wakes: {} }, total: { wakes: {} } }, schedule: null, next: [],
  account: 'dormeto-dev', cloud: 'gcp', region: 'europe-west2', can: { wake: true, nap: true },
};
// The status the page reads: the failed VM's, or another a test sets.
const shown: { status: Record<string, unknown> } = { status: STATUS };
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => (path.endsWith('/description') ? { description: null } : path.endsWith('/history') ? { phases: [], entries: [] } : path.endsWith('/activity') ? Promise.reject(new Error('no history here')) : structuredClone(shown.status))) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountPage(status: Record<string, unknown> = STATUS) {
  shown.status = status;
  setActivePinia(createPinia());
  useSession().role = 'operator';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }, { path: '/:rest(.*)', component: { render: () => null } }] });
  await router.push('/workloads/dmtr-dormeto-dev-europe-west2/batch');
  const w = mount(WorkloadView, { props: { router: 'dmtr-dormeto-dev-europe-west2', id: 'batch' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return w;
}

describe('a failed Google Cloud standalone workload\'s page', () => {
  it('shows the kept permission failure as the router gives it, its retry and when, and offers Nap to end the retries', async () => {
    setActivePinia(createPinia());
    useSession().role = 'operator';
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }, { path: '/:rest(.*)', component: { render: () => null } }] });
    await router.push('/workloads/dmtr-dormeto-dev-europe-west2/batch');
    const w = mount(WorkloadView, { props: { router: 'dmtr-dormeto-dev-europe-west2', id: 'batch' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
    await flushPromises();
    const failure = w.find('[data-test="failure"]');
    expect(failure.text()).toContain(PERMISSION);
    expect(failure.text()).toContain('3 failures in a row');
    expect(failure.text()).toMatch(/retried until it succeeds or a person naps it · next attempt in \d+ min/);
    expect(failure.find('[data-test="failure-nap"]').text()).toBe('Nap to end the retries');
    await w.find('[data-test="actions"]').trigger('click');
    await flushPromises();
    const nap = [...document.querySelectorAll('[data-test="action"]')].find((e) => e.textContent?.trim() === 'Nap')!;
    expect(nap.classList.contains('v-list-item--disabled')).toBe(false);
    await failure.find('[data-test="failure-nap"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Its wake is no longer retried: its backends stop, then its Cloud SQL instances. Nothing wakes it on demand: a schedule, a person or a start made in Google Cloud does.');
    expect(w.text()).not.toMatch(/CloudWatch|start made in AWS|dormeto:workload/);
    w.unmount();
  });
});

// The final review's minors 3, 4 and 6, and M52's own concerns (findings-final-manager-1.md).
describe('a Google Cloud standalone workload\'s page, the final review\'s words', () => {
  it('says that a resource that lost its tag shows as a permission failure', async () => {
    const w = await mountPage();
    expect(w.find('[data-test="failure"]').text()).toContain('On Google Cloud a resource that lost the tag dormeto/managed shows as a permission failure: offboard the workload, then onboard it again, which binds the tag.');
    w.unmount();
  });

  it('says a failed nap\'s confirmation as a nap tried again, its Activity Nap line as its own', async () => {
    const w = await mountPage({ ...STATUS, failure: { kind: 'permission', step: 'nap', message: PERMISSION, at: minutesAgo(30) }, nextAttemptAt: null });
    expect(w.find('[data-test="nap-estimate"]').text()).toBe('Nap: its nap is tried again after its idle window');
    await w.find('[data-test="failure-nap"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Its nap is tried again now: its backends stop, then its Cloud SQL instances.');
    w.unmount();
    const wake = await mountPage();
    expect(wake.find('[data-test="nap-estimate"]').text()).toBe('Nap: not while it is failed: its wake is retried until it succeeds or a person naps it');
    wake.unmount();
  });

  it('has no suspension row for a Cloud SQL instance, and says a group\'s history covers its current VMs', async () => {
    const sql = await mountPage({ ...STATUS, state: 'AWAKE', failure: null, nextAttemptAt: null, resource: `projects/${PROJECT}/instances/orders`, backends: [{ kind: 'cloudsql-instance', id: 'orders', status: 'RUNNABLE' }], hibernation: { workload: null, effective: false } });
    expect(sql.find('[data-test="hibernate"]').exists()).toBe(false);
    sql.unmount();
    const group = await mountPage({ ...STATUS, state: 'AWAKE', failure: null, nextAttemptAt: null, resource: `projects/${PROJECT}/zones/europe-west2-b/instanceGroupManagers/workers`, backends: [{ kind: 'asg', id: 'workers', status: 'RUNNING' }] });
    expect(group.find('[data-test="activity"]').text()).toContain('A managed instance group recreates its VMs and has none while asleep: the history covers its current VMs.');
    group.unmount();
  });
});
