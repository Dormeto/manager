import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadsView from '../src/views/WorkloadsView.vue';
import IdleBar from '../src/components/IdleBar.vue';

const paths: string[] = [];
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const SHOP = {
  router: 'dmt-dev', workloadId: 'a4dffc5bf369a297', name: 'Shop', account: '111122223333', region: 'eu-west-1', state: 'ASLEEP', url: null, wakeMode: 'browser',
  wakeCount: 3, awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null, pendingWake: false, backends: ['asg', 'rds-instance'],
  idleHours7d: 150, requests7d: 12,
};
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => { paths.push(path); return { workloads: [SHOP], total: 1, errors: [] }; }) }));

describe('Workloads view', () => {
  it('lists the workloads of one router in one state when the address names them, and shows the filter', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }] });
    await router.push('/workloads?router=dmt-dev&state=ASLEEP');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const query = new URLSearchParams(paths[0]!.split('?')[1]);
    expect(query.get('router')).toBe('dmt-dev');
    expect(query.get('state')).toBe('ASLEEP');
    expect(wrapper.text()).toContain('dmt-dev');
    expect(wrapper.text().toLowerCase()).toContain('asleep');
    wrapper.unmount();
  });

  it('links each workload\'s router to it in Routers (user request)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/routers', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const link = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Router')]!.find('a');
    expect([link.text(), link.attributes('href')]).toEqual(['dmt-dev', '/routers?router=dmt-dev']);
    wrapper.unmount();
  });

  it('shows the AWS account of each workload in the first column', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('thead th')[0]!.text()).toBe('AWS account');
    expect(wrapper.findAll('tbody tr')[0]!.findAll('td')[0]!.text()).toBe('111122223333');
    wrapper.unmount();
  });

  it('shows the kinds of each workload\'s backends as icons, each explained in a tooltip', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const cell = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Backend')]!;
    expect(headers.indexOf('Backend')).toBe(headers.indexOf('Workload') + 1);
    expect(cell.findAll('img').map((img) => img.attributes('alt'))).toEqual(['Auto Scaling group', 'RDS instance']);
    await cell.find('[aria-label="Auto Scaling group"]').trigger('mouseenter');
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toContain('Auto Scaling group: its instances are started and stopped through the group');
    wrapper.unmount();
  });

  it('shows each workload\'s idle share over 7 days as in Discovery, asking the page with it', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    paths.length = 0;
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    expect(new URLSearchParams(paths[0]!.split('?')[1]).get('idle')).toBe('1');
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const cell = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Idle (7 days)')]!;
    expect(cell.findComponent(IdleBar).props()).toEqual({ idleHours7d: 150, requests7d: 12 });
    wrapper.unmount();
  });

  it('dates a failed workload from its failure, not from the last write of its run', async () => {
    const failed = { ...SHOP, state: 'FAILED', failedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementationOnce(async () => ({ workloads: [failed], total: 1, errors: [] }) as never);
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    expect(wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Since')]!.text()).toBe('2 h ago');
    wrapper.unmount();
  });
});
