import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RoutersView from '../src/views/RoutersView.vue';
import { useSession } from '../src/stores/session';

const calls: { path: string; init?: RequestInit }[] = [];
const DRIFT = '5 drift repairs in 24 hours: infrastructure as code changed what onboarding added (see the workloads)';
// The server's side: the upgrade running on dmtr-dev-eu-west-3 (named by /routers while it runs) and how it ended.
const server: { running: string | null; ended: { status: string; error?: string } } = { running: null, ended: { status: 'succeeded' } };
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/operations') {
      server.running = 'op-9';
      return { operation: { id: 'op-9' } };
    }
    if (path.startsWith('/operations/')) return { id: path.slice('/operations/'.length), type: 'upgrade-router', target: { account: '111122223333', region: 'eu-west-3' }, ...server.ended };
    if (path.startsWith('/workloads?')) return { workloads: [{ workloadId: 'a4dffc5bf369a297', router: 'dmtr-dev-eu-west-3', state: 'ASLEEP' }], total: 1 };
    if (path.startsWith('/routers/')) {
      return {
        health: { checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, lambda: { controller: { errors: 0, throttles: 0 } }, queues: { check: 0, controller: 0 }, concurrency: null, ipLists: [] },
        configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' }, metrics: { value: false, source: 'terraform' }, ipLists: { value: [], source: 'terraform' }, noWakeRules: { value: [], source: 'terraform' } },
      };
    }
    if (path === '/ip-lists') return { catalog: 's3://b/catalog.json', lists: [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24, version: '1', entries: 12, fetchedAt: new Date().toISOString() }] };
    if (path === '/alerts') {
      return {
        alarms: [{ id: 'router#111122223333#eu-west-1', kind: 'router', name: 'dmtr-dev-eu-west-1', account: '111122223333', region: 'eu-west-1', level: 'warning', since: new Date(Date.now() - 3 * 3_600_000).toISOString(), problems: [] }],
        notifications: { topicArn: 'arn', confirmed: 1, pending: 0 },
      };
    }
    return {
      available: { version: '0.23.0' },
      routers: [
        { name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', account: '111122223333', source: 'manager', version: '0.22.6', build: '79c810cca8d3', workloads: 1, workloadStates: { ASLEEP: 1 }, health: { status: 'ok', problems: [] },
          ...(server.running ? { operation: { id: server.running, type: 'upgrade-router' } } : {}) },
        { name: 'dmtr-dev-eu-west-1', region: 'eu-west-1', account: '111122223333', source: 'manager', version: '0.23.0', build: 'a1b2c3d4e5f6', workloads: 0,
          health: { status: 'warning', problems: [{ level: 'warning', text: DRIFT }] },
          pauses: [{ scope: 'router', reason: 'load test', by: 'ops@example.com', at: '2026-10-07T06:00:00.000Z' }] },
        { name: 'dmt-dev', region: 'eu-west-1', account: '111122223333', source: 'terraform', version: '0.22.6', build: 'fc69a52b9b43', workloads: 5, workloadStates: { ASLEEP: 5 }, health: { status: 'ok', problems: [] } },
      ],
    };
  }),
}));

// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountView(path = '/routers') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = 'admin';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/routers', component: RoutersView }, { path: '/operations', component: { render: () => null } },
    { path: '/workloads', component: { render: () => null } }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/routers/:name', component: { render: () => null } }] });
  await router.push(path);
  const wrapper = mount(RoutersView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return Object.assign(wrapper, { router });
}
const rowOf = (wrapper: Awaited<ReturnType<typeof mountView>>, name: string) => wrapper.findAll('tr').find((tr) => tr.text().includes(name))!;
const hover = async (el: { trigger: (e: string) => Promise<void> }) => {
  await el.trigger('mouseenter');
  await nextTick();
  await sleep(300);
};

describe('Routers view', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    document.body.innerHTML = '';
  });

  it('links each router to its own view, as Workloads does; no row expands (user request)', async () => {
    const wrapper = await mountView();
    const link = rowOf(wrapper, 'dmt-dev').findAll('a').find((a) => a.text() === 'dmt-dev')!;
    expect(link.attributes('href')).toBe('/routers/dmt-dev');
    expect(wrapper.find('.v-data-table__td--expanded-row').exists()).toBe(false);
    expect(wrapper.findAll('thead th').map((th) => th.text())).not.toContain('');
    wrapper.unmount();
  });

  it('offers the upgrade as an icon beside the version of a router the manager installed', async () => {
    const wrapper = await mountView();
    const cells = rowOf(wrapper, 'dmtr-dev-eu-west-3').findAll('td');
    const versionCell = cells.find((td) => td.text().includes('0.22.6'))!;
    const upgrade = versionCell.find('button[aria-label="Upgrade dmtr-dev-eu-west-3 to 0.23.0"]');
    expect(upgrade.exists()).toBe(true);
    expect(upgrade.text()).toBe('');
    expect(wrapper.text()).not.toContain('Upgrade to');
    wrapper.unmount();
  });

  it('offers no upgrade to a router at the available version, nor to one written in Terraform', async () => {
    const wrapper = await mountView();
    expect(rowOf(wrapper, 'dmtr-dev-eu-west-1').find('button[aria-label^="Upgrade"]').exists()).toBe(false);
    expect(rowOf(wrapper, 'dmt-dev').find('button[aria-label^="Upgrade"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('explains the upgrade in a tooltip: from and to which version, what changes and stays, that it starts at once', async () => {
    const wrapper = await mountView();
    await hover(wrapper.find('button[aria-label="Upgrade dmtr-dev-eu-west-3 to 0.23.0"]'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('0.22.6 to 0.23.0');
    expect(text).toMatch(/workloads keep their state/);
    expect(text).toMatch(/starts at once/i);
    wrapper.unmount();
  });

  it('explains the uninstallation in a tooltip, and asks for confirmation before it', async () => {
    const wrapper = await mountView();
    const remove = wrapper.find('button[aria-label="Uninstall dmtr-dev-eu-west-3"]');
    await hover(remove);
    expect(document.body.textContent).toMatch(/asks for confirmation/i);
    await remove.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Uninstall dmtr-dev-eu-west-3?');
    expect(calls.some((c) => c.path === '/operations')).toBe(false);
    wrapper.unmount();
  });

  it('starts an upgrade with a toast linking to its operation, not a banner, and animates the upgrade icon at once', async () => {
    const wrapper = await mountView();
    await wrapper.find('button[aria-label="Upgrade dmtr-dev-eu-west-3 to 0.23.0"]').trigger('click');
    await flushPromises();
    await sleep(50);
    const toast = document.querySelector('.v-snackbar');
    expect(toast?.textContent).toContain('Upgrade of dmtr-dev-eu-west-3 to 0.23.0 started');
    expect([...toast!.querySelectorAll('a')].find((a) => a.textContent === 'Follow it in Operations')?.getAttribute('href')).toBe('/operations?id=op-9');
    expect(wrapper.find('.v-alert').exists()).toBe(false);
    expect(wrapper.find('a[aria-label="Upgrading dmtr-dev-eu-west-3: follow it in Operations"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows an upgrade running as the upgrade icon animated, opening its operation, and explains it in a tooltip', async () => {
    server.running = 'op-7';
    const wrapper = await mountView();
    const versionCell = rowOf(wrapper, 'dmtr-dev-eu-west-3').findAll('td').find((td) => td.text().includes('0.22.6'))!;
    const upgrading = versionCell.find('a[aria-label="Upgrading dmtr-dev-eu-west-3: follow it in Operations"]');
    expect(upgrading.attributes('href')).toBe('/operations?id=op-7');
    expect(upgrading.find('.v-progress-circular--indeterminate').exists()).toBe(true);
    expect(versionCell.find('button[aria-label^="Upgrade"]').exists()).toBe(false);
    await hover(upgrading);
    expect(document.body.textContent).toContain('Upgrading dmtr-dev-eu-west-3 to 0.23.0');
    wrapper.unmount();
  });

  it('says in a toast that an upgrade it showed running succeeded', async () => {
    server.running = 'op-7';
    const wrapper = await mountView();
    server.running = null;
    await wrapper.find('button[aria-label="Refresh now"]').trigger('click');
    await flushPromises();
    await sleep(50);
    expect(calls.some((c) => c.path === '/operations/op-7')).toBe(true);
    expect(document.querySelector('.v-snackbar')?.textContent).toContain('Upgrade of dmtr-dev-eu-west-3 succeeded');
    wrapper.unmount();
  });

  it('says in a toast that an upgrade it showed running failed, with the reason and its operation', async () => {
    server.running = 'op-7';
    server.ended = { status: 'failed', error: 'install functions: Rate exceeded' };
    const wrapper = await mountView();
    server.running = null;
    await wrapper.find('button[aria-label="Refresh now"]').trigger('click');
    await flushPromises();
    await sleep(50);
    const toast = document.querySelector('.v-snackbar');
    expect(toast?.textContent).toContain('Upgrade of dmtr-dev-eu-west-3 failed: install functions: Rate exceeded');
    expect([...toast!.querySelectorAll('a')].find((a) => a.textContent === 'Follow it in Operations')?.getAttribute('href')).toBe('/operations?id=op-7');
    wrapper.unmount();
  });

  it('opens the workload a "1 asleep" chip counts, and explains it in a tooltip', async () => {
    const wrapper = await mountView();
    const chip = rowOf(wrapper, 'dmtr-dev-eu-west-3').findAll('.v-chip').find((c) => c.text() === '1 asleep')!;
    await hover(chip);
    expect(document.body.textContent).toContain('1 workload asleep on dmtr-dev-eu-west-3');
    await chip.trigger('click');
    await flushPromises();
    await sleep(50);
    expect(calls.some((c) => c.path === '/workloads?router=dmtr-dev-eu-west-3&state=ASLEEP&limit=1')).toBe(true);
    expect(wrapper.router.currentRoute.value.fullPath).toBe('/workloads/dmtr-dev-eu-west-3/a4dffc5bf369a297');
    wrapper.unmount();
  });

  it('opens the list of the workloads a "5 asleep" chip counts', async () => {
    const wrapper = await mountView();
    const chip = rowOf(wrapper, 'dmt-dev').findAll('.v-chip').find((c) => c.text() === '5 asleep')!;
    await hover(chip);
    expect(document.body.textContent).toContain('5 workloads asleep on dmt-dev');
    await chip.trigger('click');
    await flushPromises();
    await sleep(50);
    expect(wrapper.router.currentRoute.value.fullPath).toBe('/workloads?router=dmt-dev&state=ASLEEP');
    wrapper.unmount();
  });

  it('explains Pause and Resume in tooltips', async () => {
    const wrapper = await mountView();
    await hover(rowOf(wrapper, 'dmtr-dev-eu-west-3').findAll('button').find((b) => b.text() === 'Pause')!);
    expect(document.body.textContent).toMatch(/never naps its workloads/);
    await hover(rowOf(wrapper, 'dmtr-dev-eu-west-1').findAll('button').find((b) => b.text() === 'Resume')!);
    expect(document.body.textContent).toMatch(/nap again when idle/);
    wrapper.unmount();
  });

  it('names the actions column, and keeps a router\'s actions on one line', async () => {
    const wrapper = await mountView();
    const headers = wrapper.findAll('thead th').map((th) => th.text());
    expect(headers.indexOf('Actions')).toBe(headers.indexOf('Pause') + 1);
    const actions = rowOf(wrapper, 'dmtr-dev-eu-west-3').findAll('td')[headers.indexOf('Actions')]!;
    expect(actions.find('.flex-nowrap').findAll('button').length).toBe(2);
    wrapper.unmount();
  });

  it('shows a long health problem on one line, cut short, the whole of it in its tooltip', async () => {
    const wrapper = await mountView();
    const shown = rowOf(wrapper, 'dmtr-dev-eu-west-1').find('.health-problem');
    expect(shown.classes()).toContain('text-truncate');
    expect(shown.text()).toBe(DRIFT);
    await hover(rowOf(wrapper, 'dmtr-dev-eu-west-1').find('[tabindex="0"]:has(.health-problem)'));
    expect(document.body.textContent).toContain(`warning: ${DRIFT}`);
    wrapper.unmount();
  });

  it('says that a router written in Terraform has a newer version, upgraded with its Terraform rather than from here', async () => {
    const wrapper = await mountView();
    const versionCell = rowOf(wrapper, 'dmt-dev').findAll('td').find((td) => td.text().includes('0.22.6'))!;
    expect(versionCell.find('button').exists()).toBe(false);
    const hint = versionCell.find('[aria-label="dmt-dev: 0.23.0 available, upgraded with Terraform"]');
    expect(hint.exists()).toBe(true);
    await hover(hint);
    expect(document.body.textContent).toMatch(/dmt-dev is written in Terraform.*apply its Terraform/);
    wrapper.unmount();
  });

  it('dates an open alarm in the router\'s health cell', async () => {
    const wrapper = await mountView();
    expect(rowOf(wrapper, 'dmtr-dev-eu-west-1').text()).toContain('alert since 3 h ago');
    expect(rowOf(wrapper, 'dmt-dev').text()).not.toContain('alert since');
    wrapper.unmount();
  });

  it('shows the manager\'s IP lists under the routers', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('#ip-lists').text()).toMatch(/ipsum.*defer.*12/);
    wrapper.unmount();
  });
});
