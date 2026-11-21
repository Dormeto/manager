// Discovery with Google Cloud standalone candidates (plan 5, M52): each said by its resource in Google Cloud's words, marked,
// its idle share; the run's Cloud SQL problem as the scan says it; the onboarding dialog in Google Cloud's words, a router asked
// for when the project has several and none in the resource's region.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DiscoveryView from '../src/views/DiscoveryView.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import { useSession } from '../src/stores/session';

const VM = 'projects/dormeto-dev/zones/europe-west2-b/instances/batch';
const GROUP = 'projects/dormeto-dev/regions/europe-west2/instanceGroupManagers/workers';
const SQL = 'projects/dormeto-dev/instances/orders';
const candidate = (id: string, name: string, kind: string, region: string, extra: Record<string, unknown> = {}) => ({
  kind: 'standalone', id, resource: id, cloud: 'gcp', name, status: 'pending-onboarding', statusReason: 'eligible', account: 'dormeto-dev', accountName: 'dormeto-dev', region,
  backend: { kind, id: name }, idleHours7d: 150, firstSeenAt: '2026-11-21T06:00:00.000Z', tags: { env: ['dev'] }, history: [], ...extra,
});
const CANDIDATES = [candidate(VM, 'batch', 'instance', 'europe-west2'), candidate(GROUP, 'workers', 'asg', 'europe-west2'), candidate(SQL, 'orders', 'cloudsql-instance', 'europe-west1')];
const PROBLEM = 'Cloud SQL instances not listed: the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project dormeto-dev';
const RUN = { id: 'r1', lint: [], status: 'partial', startedAt: '2026-11-21T06:00:00.000Z', finishedAt: '2026-11-21T06:01:00.000Z', trigger: 'schedule', targets: [{ account: 'dormeto-dev', region: 'europe-west2', status: 'ok', rules: 2, ms: 900, problems: [PROBLEM] }], counts: {} };
const ROUTERS = [
  { name: 'dmtr-dormeto-dev-europe-west2', cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', source: 'cli', installed: { version: '0.42.0' } },
  { name: 'dmtr-dormeto-dev-us-central1', cloud: 'gcp', account: 'dormeto-dev', region: 'us-central1', source: 'cli', installed: { version: '0.42.0' } },
];
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: vi.fn(async (path: string) => {
    if (path === '/discovery') return { lastRun: RUN, counts: { 'pending-onboarding': 3 } };
    if (path === '/exclusions') return { exclusions: [] };
    if (path.startsWith('/discovery/access')) return null;
    if (path.startsWith('/discovery/candidates?')) return { candidates: CANDIDATES, cursor: null };
    if (path === '/discovery/google') return { connection: null };
    if (path === '/routers') return { routers: ROUTERS };
    if (path === '/discovery/config') return { config: { version: 1, mode: 'account', regions: ['*'], refreshHours: 24, globalExcludes: [], filters: [], standalone: 'on' }, lint: [], updatedAt: null, updatedBy: null };
    return {};
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountDiscovery() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = 'admin';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/discovery', component: DiscoveryView }, { path: '/:rest(.*)', component: { render: () => null } }] });
  await router.push('/discovery');
  const w = mount(DiscoveryView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return w;
}
const rowOf = (w: Awaited<ReturnType<typeof mountDiscovery>>, name: string) => w.findAll('tbody tr').find((tr) => tr.text().includes(name))!;

describe('Discovery with Google Cloud standalone candidates', () => {
  it('says each by its resource in Google Cloud\'s words, marked as Google Cloud\'s, and the run\'s Cloud SQL problem as the scan says it', async () => {
    const w = await mountDiscovery();
    expect(rowOf(w, 'batch').find('[data-test="standalone-resource"]').text()).toBe('Compute Engine VM batch');
    expect(rowOf(w, 'workers').find('[data-test="standalone-resource"]').text()).toBe('Managed instance group workers');
    expect(rowOf(w, 'orders').find('[data-test="standalone-resource"]').text()).toBe('Cloud SQL instance orders');
    const mark = rowOf(w, 'batch').findComponent({ name: 'KindMark' });
    expect(mark.props('cloud')).toBe('gcp');
    expect(w.find('[data-test="run-problem"]').text()).toBe(`dormeto-dev · europe-west2: ${PROBLEM}`);
    w.unmount();
  });

  it('onboards one through the dialog in Google Cloud\'s words, asking for a router when none is in its region', async () => {
    const w = await mountDiscovery();
    const dialog = w.findComponent(OnboardDialog);
    const vm = w.vm as unknown as { target: unknown; onboardOpen: boolean };
    vm.target = CANDIDATES[2];
    vm.onboardOpen = true;
    await flushPromises();
    expect(dialog.props('resource')).toBe('cloudsql-instance');
    expect(dialog.props('cloud')).toBe('gcp');
    expect(dialog.props('chooseRouter')).toBe(true);
    expect(dialog.props('routers')).toEqual([{ name: 'dmtr-dormeto-dev-europe-west2', region: 'europe-west2' }, { name: 'dmtr-dormeto-dev-us-central1', region: 'us-central1' }]);
    vm.target = CANDIDATES[0];
    vm.onboardOpen = false;
    await flushPromises();
    vm.onboardOpen = true;
    await flushPromises();
    expect(dialog.props('chooseRouter')).toBe(false);
    expect(dialog.props('routers')).toEqual([{ name: 'dmtr-dormeto-dev-europe-west2', region: 'europe-west2' }]);
    w.unmount();
  });
});
