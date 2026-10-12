// A router's own view (user request): its version, health, workloads, configuration with where each setting is changed,
// and its actions, reached from the Routers list as a workload is from Workloads.
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RouterView from '../src/views/RouterView.vue';
import { useSession } from '../src/stores/session';

const INSTALLED = {
  name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', account: '111122223333', source: 'manager', version: '0.25.0', build: 'b1', workloads: 2, workloadStates: { AWAKE: 1, ASLEEP: 1 },
  health: { status: 'warning', problems: [{ level: 'warning', text: 'controller: 2 errors in 24 hours' }] }, pauses: [], lastScheduledCheckAt: new Date().toISOString(),
};
const DETAILS = {
  health: { checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, lambda: { controller: { errors: 2, throttles: 0 } }, queues: { check: 0, controller: 0 }, concurrency: null, ipLists: [] },
  configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'manager' }, metrics: { value: false, source: 'manager' }, ipLists: { value: [], source: 'manager' }, noWakeRules: { value: [], source: 'manager' } },
};
const TERRAFORM_DETAILS = {
  ...DETAILS,
  configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' }, metrics: { value: true, source: 'terraform' }, ipLists: { value: [], source: 'terraform' },
    ipListsCatalog: { value: { lists: [] }, source: 'manager' }, noWakeRules: { value: [], source: 'terraform' } },
};
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path === '/routers') return { available: { version: '0.26.0' }, routers: [INSTALLED, { ...INSTALLED, name: 'dmt-dev', source: 'terraform', region: 'eu-west-1' }] };
    if (path === '/routers/dmt-dev') return TERRAFORM_DETAILS;
    if (path.startsWith('/routers/')) return { ...DETAILS, clusters: [
      { name: 'eks-demo', reachable: true, allowed: true, missing: [], checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { name: 'eks-legacy', reachable: true, allowed: false, missing: ['get nodes'], checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { name: 'eks-lab', reachable: false, allowed: false, missing: [], reason: 'GET /apis: no connection within 3000 ms', checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
    ] };
    if (path === '/alerts') return { alarms: [{ id: 'router#111122223333#eu-west-3', kind: 'router', name: 'dmtr-dev-eu-west-3', level: 'warning', since: new Date(Date.now() - 600_000).toISOString(), problems: [] }], notifications: null };
    return {};
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountView(name: string, role: 'admin' | 'viewer' = 'admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = role;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/routers', component: { render: () => null } }, { path: '/routers/:name', component: RouterView, props: true },
    { path: '/workloads', component: { render: () => null } }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/operations', component: { render: () => null } }] });
  await router.push(`/routers/${name}`);
  const wrapper = mount(RouterView, { props: { name }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
const chips = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.findAll('.v-chip').map((c) => c.text());

describe('Router view', () => {
  it('shows a router: version and upgrade, health with its alert, workloads by state, and its account and region', async () => {
    const wrapper = await mountView('dmtr-dev-eu-west-3');
    const text = wrapper.text();
    expect(wrapper.find('h1').text()).toBe('dmtr-dev-eu-west-3');
    expect(text).toContain('0.25.0');
    expect(wrapper.find('[aria-label="Upgrade dmtr-dev-eu-west-3 to 0.26.0"]').exists()).toBe(true);
    expect(text).toContain('controller: 2 errors in 24 hours');
    expect(text).toMatch(/alert since 10 min ago/);
    expect(text).toContain('1 awake');
    expect(text).toContain('111122223333');
    wrapper.unmount();
  });

  it('says where its configuration is changed: by the manager for one it installed, in its Terraform otherwise', async () => {
    const installed = await mountView('dmtr-dev-eu-west-3');
    expect(installed.text()).toMatch(/Set by the manager when it installs or upgrades the router/);
    installed.unmount();
    const terraform = await mountView('dmt-dev');
    expect(terraform.text()).toMatch(/Set in this router's Terraform/);
    terraform.unmount();
  });

  it('shows the Terraform deployment mode, explained in a tooltip, and says nothing of the manager\'s, the standard way', async () => {
    const installed = await mountView('dmtr-dev-eu-west-3');
    expect(installed.text()).not.toContain('installed by the manager');
    expect(chips(installed)).not.toContain('Terraform');
    expect(chips(installed)).not.toContain('manager');
    installed.unmount();
    const terraform = await mountView('dmt-dev');
    // The router's own chip, and one per setting set in its Terraform; none for the manager's IP lists.
    expect(chips(terraform).filter((c) => c === 'Terraform')).toHaveLength(5);
    expect(chips(terraform)).not.toContain('manager');
    const [header, setting] = terraform.findAll('.v-chip').filter((c) => c.text() === 'Terraform');
    await header!.trigger('mouseenter');
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toMatch(/dmt-dev is written in Terraform: change its settings, upgrade or uninstall it there/);
    await setting!.trigger('mouseenter');
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toMatch(/Set in this router's Terraform: change it there and apply/);
    terraform.unmount();
  });

  it('offers pause to operators, and upgrade and uninstall to administrators of a router the manager installed', async () => {
    const admin = await mountView('dmtr-dev-eu-west-3');
    const labels = admin.findAll('button').map((b) => b.text() || b.attributes('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['Pause', 'Uninstall dmtr-dev-eu-west-3']));
    admin.unmount();
    const viewer = await mountView('dmtr-dev-eu-west-3', 'viewer');
    expect(viewer.findAll('button').map((b) => b.text())).not.toContain('Pause');
    viewer.unmount();
  });

  it('lists the EKS clusters of its account and region with its reach and rights, and what to apply when some are missing (R10.5)', async () => {
    const wrapper = await mountView('dmtr-dev-eu-west-3');
    await flushPromises();
    const text = wrapper.find('[data-test="clusters"]').findAll('tr').map((r) => `${r.find('th').text()} ${r.find('td').text()}`.replace(/\s+/g, ' ')).join(' | ');
    expect(text).toContain('eks-demo reachable, every right checked 1 h ago');
    expect(text).toContain('eks-legacy missing get nodes: apply dormeto-kubernetes-<version>.yaml of the release (the ClusterRole and its binding to the group dormeto:router): https://dormeto.com/organization-access.html#kubernetes');
    expect(text).toContain('eks-lab unreachable: GET /apis: no connection within 3000 ms');
    wrapper.unmount();
  });

  it('says so for a router the manager does not know', async () => {
    const wrapper = await mountView('nope');
    expect(wrapper.text()).toContain('Unknown router: nope');
    wrapper.unmount();
  });
});
