import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadsView from '../src/views/WorkloadsView.vue';
import StateBar from '../src/components/StateBar.vue';
import { useSession } from '../src/stores/session';
import { barSavings } from '../src/costs';

const paths: string[] = [];
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const SHOP = {
  router: 'dmt-dev', workloadId: 'a4dffc5bf369a297', name: 'Shop', summary: 'Storefront of the shop team', account: '111122223333', region: 'eu-west-1', state: 'ASLEEP', url: null, wakeMode: 'browser',
  wakeCount: 3, awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null, pendingWake: false, backends: ['asg', 'rds-instance'],
  idleHours7d: 150, requests7d: 12, costs: { baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: null, savedShare: 0.8, items: [], saved: { usd: 0, hours: 0, unpricedHours: 0 } }, states7d: { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { ASLEEP: 500_000, AWAKE: 104_800 } },
};
const FLEET = {
  workloads: 2, computedAt: new Date(Date.now() - 12 * 60_000).toISOString(), cacheMinutes: 60,
  states7d: { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { ASLEEP: 1_000_000, AWAKE: 209_600 } },
  costs: { baseline: { kind: 'always' }, saved: { usd: 41.5, hours: 1200, unpricedHours: 0 }, hourly: 0.12, monthly: 70.08, priced: 2 },
};
// A Google Cloud workload: its router is named dmtr-<project>-<region>, its account is the project.
const DEMO_VM = {
  ...SHOP, router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'b5eed0c6a470b3a8', name: 'Demo VM', summary: undefined, cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', backends: ['instance', 'cloudsql-instance'],
};
let rows: unknown[] = [SHOP];
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: rows, total: rows.length, errors: [] }; }) }));
const listPath = () => paths.find((p) => p.startsWith('/workloads?'))!;

describe('Workloads view, both clouds', () => {
  it('marks each workload with its cloud, and names its owner an account (AWS) or a project (Google Cloud)', async () => {
    rows = [SHOP, DEMO_VM];
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/routers/:name', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    rows = [SHOP];
    paths.length = 0;
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const [aws, gcp] = wrapper.findAll('tbody tr').map((tr) => tr.findAll('td')[0]!);
    expect(aws!.find('[data-test="cloud-mark"]').attributes('aria-label')).toBe('AWS account');
    expect(gcp!.find('[data-test="cloud-mark"]').attributes('aria-label')).toBe('Google Cloud project');
    expect(gcp!.find('[data-test="cloud-mark"]').attributes('data-cloud')).toBe('gcp');
    // Vuetify hides an icon from screen readers unless told otherwise: the mark must be read.
    for (const cell of [aws!, gcp!]) expect(cell.find('[data-test="cloud-mark"]').attributes('aria-hidden')).not.toBe('true');
    expect([aws!.text(), gcp!.text()]).toEqual(['111122223333', 'dormeto-dev']);
    // The Google Cloud kinds are Material Design icons with the Google Cloud names; AWS's keep their product icons.
    const backend = wrapper.findAll('tbody tr')[1]!.findAll('td')[headers.indexOf('Backend')]!;
    expect(backend.findAll('[aria-label]').map((e) => e.attributes('aria-label'))).toEqual(['Compute Engine VM', 'Cloud SQL instance']);
    expect(backend.findAll('img')).toHaveLength(0);
    expect(wrapper.findAll('tbody tr')[1]!.find('a')?.text()).toBe('Demo VM');
    wrapper.unmount();
  });
});

describe('Workloads view', () => {
  it('lists the workloads of one router in one state when the address names them, and shows the filter', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }] });
    await router.push('/workloads?router=dmt-dev&state=ASLEEP');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const query = new URLSearchParams(listPath().split('?')[1]);
    expect(query.get('router')).toBe('dmt-dev');
    expect(query.get('state')).toBe('ASLEEP');
    expect(wrapper.text()).toContain('dmt-dev');
    expect(wrapper.text().toLowerCase()).toContain('asleep');
    wrapper.unmount();
  });

  it('links each workload\'s router to it in Routers (user request)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/routers/:name', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const link = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Router')]!.find('a');
    expect([link.text(), link.attributes('href')]).toEqual(['dmt-dev', '/routers/dmt-dev']);
    wrapper.unmount();
  });

  it('shows the description\'s first line, muted, under the name of a workload that has one', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const line = wrapper.find('tbody tr [data-test="summary"]');
    expect(line.text()).toBe('Storefront of the shop team');
    expect(line.attributes('title')).toBe('Storefront of the shop team');
    wrapper.unmount();
  });

  it('shows the AWS account of each workload in the first column', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('thead th')[0]!.text()).toBe('Account or project');
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

  it('shows each workload\'s time in each state over 7 days, with its idle hours, asking the page with them (user request)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    paths.length = 0;
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    const query = new URLSearchParams(listPath().split('?')[1]);
    expect([query.get('idle'), query.get('states')]).toEqual(['1', '1']);
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    expect(headers).not.toContain('Idle (7 days)');
    const cell = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Last 7 days')]!;
    expect(cell.findComponent(StateBar).props()).toMatchObject({ states: SHOP.states7d, idleHours7d: 150, requests7d: 12, savings: barSavings(SHOP.costs as never) });
    wrapper.unmount();
  });

  it('shows in its header the bar of all workloads: their time in each state and their savings, and since when (user request)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    const bar = wrapper.find('[data-test="workloads-header"]').findComponent(StateBar);
    expect(bar.props()).toMatchObject({
      states: FLEET.states7d, title: 'All 2 workloads, last 7 days', savings: { saved: FLEET.costs.saved, hourly: 0.12, monthly: 70.08 },
      note: 'Computed 12 min ago; each workload\'s figures are kept 60 minutes.',
    });
    // Its figures' labels in a few plain words (the user, 2026-11-03).
    expect(wrapper.findAll('.dm-strip__figures .dm-figure__label').map((l) => l.text())).toEqual(['saved in 30 days', 'a month']);
    wrapper.unmount();
  });

  it('dates a failed workload from its failure, not from the last write of its run', async () => {
    const failed = { ...SHOP, state: 'FAILED', failedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    const { api } = await import('../src/api');
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path: string) => (path === '/workloads/states' ? FLEET : { workloads: [failed], total: 1, errors: [] }) as never);
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
    await flushPromises();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    expect(wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Since')]!.text()).toBe('2 h ago');
    wrapper.unmount();
    vi.mocked(api).mockImplementation(original);
  });

  // R11: tags, and the filter by tags.
  const mountList = async (role?: 'member') => {
    const pinia = createPinia();
    setActivePinia(pinia);
    if (role) useSession().role = role;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/routers/:name', component: { render: () => null } }] });
    await router.push('/workloads');
    const wrapper = mount(WorkloadsView, { attachTo: document.body, global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    return wrapper;
  };

  it('marks a scheduled workload with a calendar icon beside its name (R12)', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation((async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: [{ ...SHOP, scheduled: true }, { ...SHOP, workloadId: 'b1', name: 'Plain' }], total: 2, errors: [] }; }) as never);
    const wrapper = await mountList();
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.find('[data-test="scheduled"]').exists()).toBe(true);
    expect(rows[0]!.find('[data-test="scheduled"]').attributes('aria-label')).toBe('Has a schedule');
    expect(rows[1]!.find('[data-test="scheduled"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows each workload\'s tags as chips in a Tags column, none for a router before 0.30.0', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation((async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: [{ ...SHOP, tags: { team: 'payments', env: 'staging' } }, { ...SHOP, workloadId: 'b1', name: 'Old' }], total: 2, errors: [] }; }) as never);
    const wrapper = await mountList();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const cells = wrapper.findAll('tbody tr').map((r) => r.findAll('td')[headers.indexOf('Tags')]!);
    expect(cells[0]!.findAll('[data-test="tag"]').map((t) => t.text())).toEqual(['env=staging', 'team=payments']);
    expect(cells[1]!.findAll('[data-test="tag"]')).toHaveLength(0);
    wrapper.unmount();
  });

  it('asks for the workloads with all the tags chosen: one tag=key=value each, from the chips or the filter', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation((async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: [{ ...SHOP, tags: { team: 'payments', env: 'staging' } }], total: 1, errors: [] }; }) as never);
    paths.length = 0;
    const wrapper = await mountList();
    // A chip of a row filters by it.
    await wrapper.find('[data-test="tag"]').trigger('click');
    await flushPromises();
    const asked = () => new URLSearchParams(paths.filter((p) => p.startsWith('/workloads?')).at(-1)!.split('?')[1]).getAll('tag');
    expect(asked()).toEqual(['env=staging']);
    // The filter offers the tags seen, and several narrow the list down.
    const filter = wrapper.findComponent({ name: 'VCombobox' });
    expect(filter.props('items')).toEqual(['env=staging', 'team=payments']);
    filter.vm.$emit('update:modelValue', ['env=staging', 'team=payments']);
    await flushPromises();
    expect(asked()).toEqual(['env=staging', 'team=payments']);
    expect(wrapper.text()).not.toContain('No workload yet');
    // Taking the filters off asks for all of them again.
    filter.vm.$emit('update:modelValue', []);
    await flushPromises();
    expect(asked()).toEqual([]);
    wrapper.unmount();
  });

  it('refuses free text in the tag filter with a hint and no request, encodes spaces as %20, and makes the row chips keyboard reachable', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation((async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: [{ ...SHOP, tags: { 'cost center': 'a b' } }], total: 1, errors: [] }; }) as never);
    paths.length = 0;
    const wrapper = await mountList();
    const lists = () => paths.filter((p) => p.startsWith('/workloads?'));
    const before = lists().length;
    const filter = wrapper.findComponent({ name: 'VCombobox' });
    filter.vm.$emit('update:modelValue', ['payments']);
    await flushPromises();
    expect(lists()).toHaveLength(before);
    expect(wrapper.text()).toContain('"payments" is not a tag: write it as key=value');
    expect(filter.props('modelValue')).toEqual([]);
    filter.vm.$emit('update:modelValue', ['=x']);
    await flushPromises();
    expect(lists()).toHaveLength(before);
    // A chip of a row is reachable by keyboard; its filter has the spaces percent-encoded.
    const chip = wrapper.find('[data-test="tag"]');
    expect(chip.attributes('tabindex')).toBe('0');
    await chip.trigger('click');
    await flushPromises();
    expect(lists().at(-1)).toContain('&tag=cost%20center%3Da%20b');
    expect(lists().at(-1)).not.toContain('+center');
    expect(wrapper.text()).not.toContain('is not a tag');
    wrapper.unmount();
  });

  it('shows a member the router column as text, an administrator as links', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation((async (path: string) => { paths.push(path); return path === '/workloads/states' ? FLEET : { workloads: [SHOP], total: 1, errors: [] }; }) as never);
    const wrapper = await mountList('member');
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    const cell = wrapper.findAll('tbody tr')[0]!.findAll('td')[headers.indexOf('Router')]!;
    expect([cell.text(), cell.find('a').exists()]).toEqual(['dmt-dev', false]);
    wrapper.unmount();
  });
});
