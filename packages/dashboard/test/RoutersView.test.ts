import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { mdiPauseCircleOutline } from '@mdi/js';
import RoutersView from '../src/views/RoutersView.vue';
import PauseDialog from '../src/components/PauseDialog.vue';
import { useSession } from '../src/stores/session';
import { download } from '../src/table-export';
import { columnTexts, expectEveryColumnSaid } from './table-columns';

vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
const calls: { path: string; init?: RequestInit }[] = [];
let failPut = false;
// The workload defaults as never set by an administrator (no who, no when).
let neverChanged = false;
let defaultsJoin: number | null = null;
let defaultsEnded: number | null = null;
let defaultsError: string | null = null;
const DRIFT = '5 drift repairs in 24 hours: infrastructure as code changed what onboarding added (see the workloads)';
// The open alarm on dmtr-dev-eu-west-1.
const ALARM_SINCE = new Date(Date.now() - 3 * 3_600_000).toISOString();
// The server's side: the upgrade running on dmtr-dev-eu-west-3 (named by /routers while it runs) and how it ended.
let withGoogle = false;
// A router older than 0.16: no health report.
let withOld = false;
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
    if (path.endsWith('/pause')) return { woken: [] };
    if (path.endsWith('/resume')) return { resumed: true };
    if (path.startsWith('/routers/')) {
      return {
        health: { checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, lambda: { controller: { errors: 0, throttles: 0 } }, queues: { check: 0, controller: 0 }, concurrency: null, ipLists: [] },
        configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' }, metrics: { value: false, source: 'terraform' }, ipLists: { value: [], source: 'terraform' }, noWakeRules: { value: [], source: 'terraform' } },
      };
    }
    if (path === '/settings/workloads') {
      if (init?.method === 'PUT' && failPut) throw new Error('settings.json: access denied');
      if (init?.method === 'PUT') return { ...JSON.parse(String(init.body)), updatedAt: new Date().toISOString(), updatedBy: 'ops@example.com', note: 'routers apply it at their next check, within 5 minutes' };
      return neverChanged ? { hibernate: true, joinMinutes: defaultsJoin, endedWindowDays: defaultsEnded, updatedAt: null, updatedBy: null, ...(defaultsError ? { error: defaultsError } : {}) } : { hibernate: true, joinMinutes: defaultsJoin, endedWindowDays: defaultsEnded, ...(defaultsError ? { error: defaultsError } : {}), updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), updatedBy: 'admin@example.com' };
    }
    if (path === '/ip-lists') return { catalog: 's3://b/catalog.json', lists: [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24, version: '1', entries: 12, fetchedAt: new Date().toISOString() }] };
    if (path === '/alerts') {
      return {
        alarms: [{ id: 'router#111122223333#eu-west-1', kind: 'router', name: 'dmtr-dev-eu-west-1', account: '111122223333', region: 'eu-west-1', level: 'warning', since: ALARM_SINCE, problems: [] }],
        notifications: { topicArn: 'arn', confirmed: 1, pending: 0 },
      };
    }
    return {
      available: { version: '0.23.0' },
      routers: [
        { name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', account: '111122223333', source: 'manager', version: '0.22.6', build: '79c810cca8d3', workloads: 1, summary: 'Dev router of the shop team', workloadStates: { ASLEEP: 1 }, health: { status: 'ok', problems: [] },
          ...(server.running ? { operation: { id: server.running, type: 'upgrade-router' } } : {}) },
        { name: 'dmtr-dev-eu-west-1', region: 'eu-west-1', account: '111122223333', source: 'manager', version: '0.23.0', build: 'a1b2c3d4e5f6', workloads: 0, workloadStates: {},
          health: { status: 'warning', problems: [{ level: 'warning', text: DRIFT }] },
          pauses: [{ scope: 'router', reason: 'load test', by: 'ops@example.com', at: '2026-10-07T06:00:00.000Z' }] },
        { name: 'dmt-dev', region: 'eu-west-1', account: '111122223333', source: 'terraform', version: '0.22.6', build: 'fc69a52b9b43', workloads: 5, workloadStates: { ASLEEP: 5 }, paused: 2, health: { status: 'ok', problems: [] } },
        // Known by its count only (no state counts), with a workload paused; it does not report.
        ...(withOld ? [{ name: 'dmtr-old-eu-west-2', region: 'eu-west-2', account: '111122223333', source: 'manager', version: '0.15.2', build: '0a1b2c3d4e5f', workloads: 3, paused: 1, reporting: false }] : []),
        ...(withGoogle ? [{ name: 'dmtr-dormeto-dev-europe-west2', cloud: 'gcp', region: 'europe-west2', account: 'dormeto-dev', source: 'cli', version: '0.40.0', build: 'b1c2d3e4f5a6', workloads: 2, workloadStates: { ASLEEP: 2 }, health: { status: 'ok', problems: [] } }] : []),
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

async function mountView(path = '/routers', role: 'admin' | 'operator' | 'viewer' = 'admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = role;
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
// A column's cell in a router's row, by the column's title.
const cellOf = (wrapper: Awaited<ReturnType<typeof mountView>>, name: string, column: string) => {
  const titles = wrapper.findAll('thead th').map((th) => th.text());
  return rowOf(wrapper, name).findAll('td')[titles.indexOf(column)]!;
};
// A row's "⋮" opens its menu (the items of the menus open), and closes it again; a click during a menu's closing
// transition would be lost, hence the wait.
const menuItems = () => [...document.querySelectorAll<HTMLElement>('.v-overlay--active .v-list-item')];
async function openMenu(wrapper: Awaited<ReturnType<typeof mountView>>, name: string) {
  await rowOf(wrapper, name).find('[data-test="dm-row-menu"]').trigger('click');
  await flushPromises();
  return menuItems();
}
async function closeMenu(wrapper: Awaited<ReturnType<typeof mountView>>, name: string) {
  await rowOf(wrapper, name).find('[data-test="dm-row-menu"]').trigger('click');
  await flushPromises();
  await sleep(350);
}
// A router's menu, as its items' titles (null: no menu).
async function menuOf(wrapper: Awaited<ReturnType<typeof mountView>>, name: string): Promise<string[] | null> {
  if (!rowOf(wrapper, name).find('[data-test="dm-row-menu"]').exists()) return null;
  const titles = (await openMenu(wrapper, name)).map((i) => i.textContent!.trim());
  await closeMenu(wrapper, name);
  return titles;
}
async function choose(wrapper: Awaited<ReturnType<typeof mountView>>, name: string, title: string) {
  (await openMenu(wrapper, name)).find((i) => i.textContent?.trim() === title)!.click();
  await flushPromises();
  await sleep(350);
}
// A button of the dialog open.
const buttonOfDialog = (text: string) => [...document.querySelectorAll('.v-overlay--active button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('Routers view', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    withGoogle = false;
    withOld = false;
    document.body.innerHTML = '';
  });

  it('marks each router with its cloud, and a Google Cloud router with its project and its region\'s location', async () => {
    withGoogle = true;
    const wrapper = await mountView();
    const aws = rowOf(wrapper, 'dmt-dev');
    const gcp = rowOf(wrapper, 'dmtr-dormeto-dev-europe-west2');
    expect(aws.find('[data-test="cloud-mark"]').attributes('aria-label')).toBe('AWS account');
    expect(gcp.find('[data-test="cloud-mark"]').attributes('aria-label')).toBe('Google Cloud project');
    expect(gcp.find('.dm-router__where').text()).toContain('dormeto-dev');
    expect(gcp.find('.region-label').attributes('aria-label')).toBe('europe-west2, London');
    expect(aws.find('.region-label').attributes('aria-label')).toBe('eu-west-1, Europe (Ireland)');
    // Installed by the CLI: no upgrade and no uninstallation from the dashboard.
    expect(gcp.find('button[aria-label^="Upgrade"]').exists()).toBe(false);
    expect(await menuOf(wrapper, 'dmtr-dormeto-dev-europe-west2')).toEqual(['Pause…']);
    // Its cloud in words where search and the exports read it.
    expect(columnTexts(wrapper, 'routers', (routers: { name: string }[]) => routers.find((r) => r.name === 'dmtr-dormeto-dev-europe-west2')!).Router)
      .toBe('dmtr-dormeto-dev-europe-west2 (Google Cloud, dormeto-dev, europe-west2)');
    wrapper.unmount();
  });

  it('keeps the install form AWS\'s, with one line saying a Google Cloud router is installed by dormeto gcp routers install', async () => {
    const wrapper = await mountView();
    const install = wrapper.findAll('button').find((b) => b.text() === 'Install a router')!;
    await install.trigger('click');
    await flushPromises();
    const dialog = document.body.querySelector('.v-dialog')!;
    expect(dialog.textContent).toContain('Account ID');
    expect(dialog.querySelector('[data-test="gcp-install-line"]')?.textContent).toMatch(/Google Cloud router.*dormeto gcp routers install/);
    wrapper.unmount();
  });

  it('shows the description\'s first line, muted, under the name of a router that has one', async () => {
    const wrapper = await mountView();
    const line = rowOf(wrapper, 'dmtr-dev-eu-west-3').find('[data-test="summary"]');
    expect(line.text()).toBe('Dev router of the shop team');
    expect(line.attributes('title')).toBe('Dev router of the shop team');
    expect(rowOf(wrapper, 'dmt-dev').find('[data-test="summary"]').exists()).toBe(false);
    wrapper.unmount();
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

  it('explains the uninstallation in a tooltip in the row\'s menu, and asks for confirmation before it', async () => {
    const wrapper = await mountView();
    const remove = (await openMenu(wrapper, 'dmtr-dev-eu-west-3')).find((i) => i.textContent?.trim() === 'Uninstall…')!;
    expect(remove.classList).toContain('text-error');
    remove.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    await sleep(300);
    expect(document.body.textContent).toMatch(/Uninstall dmtr-dev-eu-west-3: deletes every resource.*asks for confirmation/i);
    remove.click();
    await flushPromises();
    await sleep(350);
    expect(document.body.textContent).toContain('Uninstall dmtr-dev-eu-west-3?');
    expect(calls.some((c) => c.path === '/operations')).toBe(false);
    buttonOfDialog('Uninstall').click();
    await flushPromises();
    const started = calls.find((c) => c.path === '/operations')!;
    expect(JSON.parse(String(started.init!.body))).toEqual({ type: 'uninstall-router', router: 'dmtr-dev-eu-west-3' });
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

  it('opens the workload a "×1" asleep chip counts, named and explained in its tooltip', async () => {
    const wrapper = await mountView();
    const chip = rowOf(wrapper, 'dmtr-dev-eu-west-3').find('[data-test="state-count"]');
    expect(chip.text()).toBe('×1');
    // Its name starts with what it shows (×1), then says what it is and does.
    expect(chip.attributes('aria-label')).toBe('×1 asleep on dmtr-dev-eu-west-3: open it');
    expect(chip.attributes('role')).toBe('button');
    expect(chip.attributes('tabindex')).toBe('0');
    expect(chip.classes()).toContain('text-info');
    // Reached by the keyboard, its tooltip opens on focus.
    (chip.element as HTMLElement).focus();
    await nextTick();
    await sleep(300);
    expect(document.activeElement).toBe(chip.element);
    expect(document.querySelector('.v-overlay--active')?.textContent).toBe('1 workload asleep on dmtr-dev-eu-west-3: open it');
    await chip.trigger('click');
    await flushPromises();
    await sleep(50);
    expect(calls.some((c) => c.path === '/workloads?router=dmtr-dev-eu-west-3&state=ASLEEP&limit=1')).toBe(true);
    expect(wrapper.router.currentRoute.value.fullPath).toBe('/workloads/dmtr-dev-eu-west-3/a4dffc5bf369a297');
    wrapper.unmount();
  });

  it('opens the list of the workloads a "×5" asleep chip counts', async () => {
    const wrapper = await mountView();
    const chip = rowOf(wrapper, 'dmt-dev').find('[data-test="state-count"]');
    expect(chip.text()).toBe('×5');
    expect(chip.attributes('aria-label')).toBe('×5 asleep on dmt-dev: open their list');
    await hover(chip);
    expect(document.body.textContent).toContain('5 workloads asleep on dmt-dev');
    // Enter opens them, as a click does; Space too.
    await chip.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await sleep(50);
    expect(wrapper.router.currentRoute.value.fullPath).toBe('/workloads?router=dmt-dev&state=ASLEEP');
    await wrapper.router.push('/routers');
    await chip.trigger('keydown', { key: ' ' });
    await flushPromises();
    await sleep(50);
    expect(wrapper.router.currentRoute.value.fullPath).toBe('/workloads?router=dmt-dev&state=ASLEEP');
    wrapper.unmount();
  });

  it('shows the paused workloads as one more chip of the same form: the pause icon and ×N in the pause\'s color', async () => {
    const wrapper = await mountView();
    const chip = rowOf(wrapper, 'dmt-dev').find('[data-test="paused-count"]');
    expect(chip.text()).toBe('×2');
    expect(chip.classes()).toContain('text-secondary');
    expect(chip.findComponent({ name: 'VIcon' }).props('icon')).toBe(mdiPauseCircleOutline);
    expect(chip.attributes('tabindex')).toBe('0');
    expect(chip.attributes('aria-label')).toBe('2 workloads paused on dmt-dev: never napped until resumed; requests still wake them');
    // It opens nothing: not drawn as the state chips a click opens (outlined, no link), and its tooltip, its name again, not
    // read twice.
    expect(chip.classes()).toContain('v-chip--variant-outlined');
    expect(chip.classes()).not.toContain('v-chip--link');
    await hover(chip);
    expect(document.querySelector('.v-overlay--active')?.textContent).toBe('2 workloads paused on dmt-dev: never napped until resumed; requests still wake them');
    expect(document.querySelector('.v-overlay--active .v-overlay__content > [aria-hidden="true"]')?.textContent).toBe('2 workloads paused on dmt-dev: never napped until resumed; requests still wake them');
    expect(rowOf(wrapper, 'dmtr-dev-eu-west-3').find('[data-test="paused-count"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a router\'s count and its paused chip without state counts, and 0 for a router without workloads', async () => {
    withOld = true;
    const wrapper = await mountView();
    const cell = cellOf(wrapper, 'dmtr-old-eu-west-2', 'Workloads');
    expect(cell.text()).toBe('3×1');
    expect(cell.find('[data-test="paused-count"]').attributes('aria-label')).toBe('1 workload paused on dmtr-old-eu-west-2: never napped until resumed; requests still wake it');
    expect(cellOf(wrapper, 'dmtr-dev-eu-west-1', 'Workloads').text()).toBe('0');
    const texts = columnTexts(wrapper, 'routers', (routers: { name: string }[]) => routers.find((r) => r.name === 'dmtr-old-eu-west-2')!);
    expect(texts.Workloads).toBe('3; 1 of them paused');
    wrapper.unmount();
  });

  it('says no state, pause or health word in a cell: the icons are named by their words, the counts are ×N', async () => {
    withOld = true;
    const wrapper = await mountView();
    for (const name of ['dmtr-dev-eu-west-3', 'dmtr-dev-eu-west-1', 'dmt-dev', 'dmtr-old-eu-west-2']) {
      expect(cellOf(wrapper, name, 'Health').text(), name).toBe('');
      expect(cellOf(wrapper, name, 'Pause').text(), name).toBe('');
      // A router known by its count only shows it (then its paused chip).
      expect(cellOf(wrapper, name, 'Workloads').text(), name).toMatch(/^(\d+|×\d+)(×\d+)*$/);
    }
    const names = (name: string, column: string) => cellOf(wrapper, name, column).findAll('[data-test="status-mark"]').map((m) => m.attributes('aria-label'));
    expect(names('dmtr-dev-eu-west-3', 'Health')).toEqual(['ok']);
    expect(names('dmtr-dev-eu-west-1', 'Health')).toEqual(['warning', 'alert since 3 h ago']);
    expect(names('dmtr-old-eu-west-2', 'Health')).toEqual(['no health report', 'not reporting']);
    expect(names('dmtr-dev-eu-west-1', 'Pause')).toEqual(['paused']);
    expect(names('dmt-dev', 'Pause')).toEqual([]);
    wrapper.unmount();
  });

  it('explains Pause and Resume in tooltips in the rows\' menus', async () => {
    const wrapper = await mountView();
    const tip = async (name: string, title: string) => {
      const item = (await openMenu(wrapper, name)).find((i) => i.textContent?.trim() === title)!;
      item.dispatchEvent(new MouseEvent('mouseenter'));
      await nextTick();
      await sleep(300);
      const text = document.body.textContent;
      await closeMenu(wrapper, name);
      return text;
    };
    expect(await tip('dmtr-dev-eu-west-3', 'Pause…')).toMatch(/never naps its workloads/);
    expect(await tip('dmtr-dev-eu-west-1', 'Resume')).toMatch(/nap again when idle/);
    wrapper.unmount();
  });

  it('pauses a router from its menu after asking a reason, and resumes one at once', async () => {
    const wrapper = await mountView();
    await choose(wrapper, 'dmtr-dev-eu-west-3', 'Pause…');
    expect(document.querySelector('.v-overlay--active .v-card-title')?.textContent).toBe('Pause dmtr-dev-eu-west-3');
    const reason = document.querySelector('.v-overlay--active input') as HTMLInputElement;
    reason.value = 'load test';
    reason.dispatchEvent(new Event('input'));
    // Resumed in a day, its asleep workloads left asleep.
    const dialog = wrapper.findComponent(PauseDialog);
    await dialog.findComponent({ name: 'VSelect' }).setValue('1d');
    await dialog.findComponent({ name: 'VCheckbox' }).find('input').setValue(true);
    await flushPromises();
    buttonOfDialog('Pause').click();
    await flushPromises();
    const paused = calls.find((c) => c.path === '/routers/dmtr-dev-eu-west-3/pause')!;
    const sent = JSON.parse(String(paused.init!.body)) as { reason: string; keepAsleep: boolean; until: string };
    expect(sent).toMatchObject({ reason: 'load test', keepAsleep: true });
    expect(Date.parse(sent.until) - Date.now()).toBeGreaterThan(86_000_000);
    await sleep(350);
    // The one dialog, opened for another router, starts again from nothing: no reason, resumed in 4 hours, workloads woken.
    await choose(wrapper, 'dmt-dev', 'Pause…');
    expect(document.querySelector('.v-overlay--active .v-card-title')?.textContent).toBe('Pause dmt-dev');
    expect((document.querySelector('.v-overlay--active input') as HTMLInputElement).value).toBe('');
    expect(dialog.findComponent({ name: 'VSelect' }).props('modelValue')).toBe('4h');
    expect((dialog.findComponent({ name: 'VCheckbox' }).find('input').element as HTMLInputElement).checked).toBe(false);
    buttonOfDialog('Cancel').click();
    await flushPromises();
    await sleep(350);
    await choose(wrapper, 'dmtr-dev-eu-west-1', 'Resume');
    expect(calls.some((c) => c.path === '/routers/dmtr-dev-eu-west-1/resume' && c.init?.method === 'POST')).toBe(true);
    wrapper.unmount();
  });

  it('puts a router\'s actions in its row\'s menu, last: Pause or Resume for operators, Uninstall for administrators of what the manager installed', async () => {
    withOld = true;
    const admin = await mountView();
    const headers = admin.findAll('thead th').map((th) => th.text());
    expect(headers.at(-1)).toBe('Actions');
    expect(headers.indexOf('Actions')).toBe(headers.indexOf('Pause') + 1);
    expect(admin.find('.dm-routers thead [data-test="dm-table-menu"]').attributes('aria-label')).toBe('Table actions: Routers');
    expect(rowOf(admin, 'dmtr-dev-eu-west-3').find('[data-test="dm-row-menu"]').attributes('aria-label')).toBe('Actions for dmtr-dev-eu-west-3');
    expect(await menuOf(admin, 'dmtr-dev-eu-west-3')).toEqual(['Pause…', 'Uninstall…']);
    expect(await menuOf(admin, 'dmtr-dev-eu-west-1')).toEqual(['Resume', 'Uninstall…']);
    expect(await menuOf(admin, 'dmt-dev')).toEqual(['Pause…']);
    // No health report (before 0.16): no pause.
    expect(await menuOf(admin, 'dmtr-old-eu-west-2')).toEqual(['Uninstall…']);
    admin.unmount();
    const operator = await mountView('/routers', 'operator');
    expect(await menuOf(operator, 'dmtr-dev-eu-west-3')).toEqual(['Pause…']);
    expect(await menuOf(operator, 'dmtr-dev-eu-west-1')).toEqual(['Resume']);
    expect(await menuOf(operator, 'dmtr-old-eu-west-2')).toBeNull();
    operator.unmount();
    const viewer = await mountView('/routers', 'viewer');
    expect(viewer.findAll('[data-test="dm-row-menu"]')).toHaveLength(0);
    expect(viewer.find('.dm-routers [data-test="dm-table-menu"]').exists()).toBe(true);
    viewer.unmount();
  });

  it('says a warning\'s problems in the health icon\'s tooltip, not in the cell', async () => {
    const wrapper = await mountView();
    const mark = cellOf(wrapper, 'dmtr-dev-eu-west-1', 'Health').find('[data-test="status-mark"]');
    expect(cellOf(wrapper, 'dmtr-dev-eu-west-1', 'Health').text()).not.toContain(DRIFT);
    await hover(mark);
    const tip = document.querySelector('.v-overlay--active')!;
    expect(tip.querySelector('.dm-status__label')?.textContent).toBe('warning');
    expect(tip.textContent).toContain(`warning: ${DRIFT}`);
    expect(tip.textContent).toContain('alert since 3 h ago');
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

  it('marks an open alarm with a bell beside the health icon, dated in its name and its tooltip', async () => {
    const wrapper = await mountView();
    const bell = cellOf(wrapper, 'dmtr-dev-eu-west-1', 'Health').findAll('[data-test="status-mark"]')[1]!;
    expect(bell.attributes('aria-label')).toBe('alert since 3 h ago');
    expect(bell.classes()).toContain('text-warning');
    await hover(bell);
    expect(document.querySelector('.v-overlay--active .dm-status__label')?.textContent).toBe('alert since 3 h ago');
    expect(cellOf(wrapper, 'dmt-dev', 'Health').findAll('[data-test="status-mark"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('searches what the cells say: "paused" finds the paused router and the one with paused workloads', async () => {
    const wrapper = await mountView();
    await wrapper.find('.dm-routers [data-test="dm-table-search"] input').setValue('paused');
    await flushPromises();
    expect(wrapper.findAll('.dm-routers tbody tr').map((tr) => tr.find('.dm-router__name').text())).toEqual(['dmtr-dev-eu-west-1', 'dmt-dev']);
    wrapper.unmount();
  });

  it('exports its routers with each column in words: where, version and build, health and its problems, workloads by state and paused, the pause', async () => {
    const wrapper = await mountView();
    await wrapper.find('.dm-routers [data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-routers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((body as string).split('\r\n')).toEqual([
      'Router,Version,Health,Idle check,Workloads,Pause',
      // The version says the upgrade its cell offers (the manager's) or hints at (Terraform's).
      '"dmtr-dev-eu-west-3 (AWS, 111122223333, eu-west-3) · Dev router of the shop team",0.22.6 (build 79c810cca8d3) · 0.23.0 available,ok,,1 asleep,',
      `"dmtr-dev-eu-west-1 (AWS, 111122223333, eu-west-1)",0.23.0 (build a1b2c3d4e5f6),warning: ${DRIFT} · alert since ${ALARM_SINCE},,0,Router paused by ops@example.com at 2026-10-07T06:00:00.000Z: load test`,
      '"dmt-dev (AWS, 111122223333, eu-west-1)",0.22.6 (build fc69a52b9b43) · 0.23.0 available through its Terraform,ok,,5 asleep; 2 of them paused,',
      '',
    ]);
    // A router with every fact (its idle check too): each column says it.
    expectEveryColumnSaid(wrapper, 'routers', (routers: { name: string }[]) => ({ ...routers.find((r) => r.name === 'dmtr-dev-eu-west-1')!, lastScheduledCheckAt: '2026-11-12T10:00:00.000Z' }));
    wrapper.unmount();
  });

  it('shows the manager\'s IP lists under the routers', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('#ip-lists').text()).toMatch(/ipsum.*defer.*12/);
    wrapper.unmount();
  });

  it('says what a router is in a tooltip beside the page\'s title, not under it (the user, 2026-11-02)', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).not.toContain('One router per AWS account and region');
    const more = wrapper.find('[data-test="page-title"] [data-test="routers-more"]');
    expect(more.attributes('tabindex')).toBe('0');
    expect(more.attributes('aria-label')).toBe('What a router does');
    await hover(more);
    const tip = document.querySelector('.v-overlay--active [data-test="routers-tip"]')!;
    expect(tip.textContent!.replace(/\s+/g, ' ').trim()).toBe('One router per AWS account and region, or per Google Cloud project and region, naps and wakes its workloads. A paused router never naps any of them (requests still wake); health comes from its idle check and, on AWS, its Lambda functions and its failure queues.');
    wrapper.unmount();
  });

  it('says what the IP lists are in a tooltip beside their title, not under it (the user, 2026-11-02)', async () => {
    const wrapper = await mountView();
    const panel = wrapper.find('#ip-lists');
    expect(panel.text()).not.toContain('seldom belong to a visitor');
    const more = panel.find('.v-card-title [data-test="ip-lists-more"]');
    expect(more.attributes('tabindex')).toBe('0');
    expect(more.attributes('aria-label')).toBe('What the IP lists are');
    await hover(more);
    const tip = document.querySelector('.v-overlay--active [data-test="ip-lists-tip"]')!;
    const text = tip.textContent!.replace(/\s+/g, ' ');
    // What they are and do (user request): the manager's lists, for every router of the organization.
    expect(text).toMatch(/Lists of addresses .*seldom belong to a visitor.* every router of the organization reads them/);
    expect(text).toMatch(/defer: a request from a listed address does not wake a workload by itself.*ignore: it never wakes one/);
    expect(text).toMatch(/ip_lists in the manager's Terraform; a router written in Terraform can add lists of its own/);
    wrapper.unmount();
  });

  describe('the workload defaults card (hibernation)', () => {
    const card = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.find('[data-test="workload-defaults"]');
    const dialogButton = (text: string) => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

    it('shows the default, who changed it and when', async () => {
      const wrapper = await mountView();
      expect(card(wrapper).text()).toContain('Workload defaults');
      expect(card(wrapper).text()).toContain('Hibernate');
      expect(card(wrapper).text()).toContain('On');
      expect(card(wrapper).text()).toContain('admin@example.com');
      expect(card(wrapper).text()).toContain('3 h ago');
      wrapper.unmount();
    });

    it('says "Never changed." while no administrator set it', async () => {
      neverChanged = true;
      const wrapper = await mountView();
      expect(card(wrapper).text()).toContain('Never changed.');
      expect(card(wrapper).text()).not.toContain('Never changed: on.');
      wrapper.unmount();
      neverChanged = false;
    });

    // What each setting does is in a tooltip on an icon beside its name, not under it (the user, 2026-11-02).
    it('shows each setting by its name and value, what it does in a tooltip on a focusable icon', async () => {
      const wrapper = await mountView();
      for (const [name, label, words] of [
        ['hibernate', 'What Hibernate does', 'EC2 instances outside an Auto Scaling group (not ECS)'],
        ['join', 'What Join windows does', 'count as one'],
        ['ended', 'What Ended windows does', 'leaves its schedule'],
      ] as const) {
        const row = card(wrapper).find(`[data-test="default-${name}"]`);
        expect(row.text(), name).not.toContain(words);
        const more = row.find(`[data-test="default-${name}-more"]`);
        expect(more.attributes('tabindex'), name).toBe('0');
        expect(more.attributes('aria-label'), name).toBe(label);
        await hover(more);
        expect(document.querySelector(`.v-overlay--active [data-test="default-${name}-tip"]`)?.textContent, name).toContain(words);
        await more.trigger('mouseleave');
        await sleep(300);
      }
      wrapper.unmount();
    });

    const joinButton = (w: Awaited<ReturnType<typeof mountView>>) => card(w).find('[data-test="edit-join"]');
    const joinDialog = () => document.querySelector('[data-test="join-dialog"]') as HTMLElement;

    it('says the joined windows\' default, the built-in value while unset', async () => {
      const wrapper = await mountView();
      const row = card(wrapper).find('[data-test="default-join"]');
      expect(row.text()).toContain('Join windows');
      expect(row.text()).toContain('15 min, the default');
      expect(joinButton(wrapper).exists()).toBe(true);
      wrapper.unmount();
    });

    it('hides its Edit from an operator, who reads the value', async () => {
      defaultsJoin = 30;
      const wrapper = await mountView('/routers', 'operator');
      expect(card(wrapper).find('[data-test="default-join"]').text()).toContain('30 min');
      expect(joinButton(wrapper).exists()).toBe(false);
      wrapper.unmount();
      defaultsJoin = null;
    });

    it('sends only joinMinutes, says when routers apply it, and null for the default', async () => {
      const wrapper = await mountView();
      await joinButton(wrapper).trigger('click');
      await flushPromises();
      expect(joinDialog().textContent).toContain('Override default join');
      expect(joinDialog().textContent).toContain('default: 15 min, built in');
      expect(joinDialog().textContent).toContain('within 5 minutes');
      (joinDialog().querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      await flushPromises();
      const input = joinDialog().querySelector('input[type="number"]') as HTMLInputElement;
      input.value = '30';
      input.dispatchEvent(new Event('input'));
      await flushPromises();
      dialogButton('Save').click();
      await flushPromises();
      const put = calls.find((c) => c.path === '/settings/workloads' && c.init?.method === 'PUT')!;
      expect(JSON.parse(String(put.init!.body))).toEqual({ joinMinutes: 30 });
      wrapper.unmount();
    });

    const endedButton = (w: Awaited<ReturnType<typeof mountView>>) => card(w).find('[data-test="edit-ended"]');
    const endedDialog = () => document.querySelector('[data-test="ended-dialog"]') as HTMLElement;

    it('says how long an ended window stays, a year while unset, and kept for 0 (the user, 2026-11-02)', async () => {
      const wrapper = await mountView();
      const row = card(wrapper).find('[data-test="default-ended"]');
      expect(row.text()).toContain('Ended windows');
      expect(row.text()).toContain('365 days, the default');
      expect(endedButton(wrapper).exists()).toBe(true);
      wrapper.unmount();
      defaultsEnded = 0;
      const kept = await mountView('/routers', 'operator');
      expect(card(kept).find('[data-test="default-ended"]').text()).toContain('Kept');
      expect(endedButton(kept).exists()).toBe(false);
      kept.unmount();
      defaultsEnded = null;
    });

    it('sends only endedWindowDays: its days, 0 to keep them, refused out of range, null for the default', async () => {
      const wrapper = await mountView();
      await endedButton(wrapper).trigger('click');
      await flushPromises();
      expect(endedDialog().textContent).toContain('Default (365 days)');
      expect(endedDialog().textContent).toContain('within 5 minutes');
      (endedDialog().querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      await flushPromises();
      const input = endedDialog().querySelector('input[type="number"]') as HTMLInputElement;
      for (const [value, ok] of [['10', false], ['4000', false], ['', false], ['0', true], ['90', true]] as const) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
        await flushPromises();
        expect(dialogButton('Save').disabled, value).toBe(!ok);
        expect(endedDialog().textContent!.includes('0 to keep them, or 30 to 3650 days'), value).toBe(!ok);
      }
      dialogButton('Save').click();
      await flushPromises();
      const put = calls.filter((c) => c.path === '/settings/workloads' && c.init?.method === 'PUT').at(-1)!;
      expect(JSON.parse(String(put.init!.body))).toEqual({ endedWindowDays: 90 });
      wrapper.unmount();
    });

    it('says a settings.json it cannot read, and a refusal in a toast; the card reads it again', async () => {
      const wrapper = await mountView();
      expect(card(wrapper).find('[data-test="defaults-error"]').exists()).toBe(false);
      await joinButton(wrapper).trigger('click');
      await flushPromises();
      failPut = true;
      defaultsError = 'settings.json is unreadable';
      dialogButton('Save').click();
      await flushPromises();
      expect(document.querySelector('.dm-toast')?.textContent).toContain('settings.json: access denied');
      expect(card(wrapper).find('[data-test="defaults-error"]').text()).toContain('settings.json is unreadable');
      wrapper.unmount();
      failPut = false;
      defaultsError = null;
    });

    it('hides the switch from an operator', async () => {
      const wrapper = await mountView('/routers', 'operator');
      expect(card(wrapper).text()).toContain('On');
      expect(card(wrapper).find('input[type="checkbox"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it('asks first, naming what it affects, then sends the new value', async () => {
      const wrapper = await mountView();
      await card(wrapper).find('input[type="checkbox"]').setValue(false);
      await flushPromises();
      expect(calls.some((c) => c.path === '/settings/workloads' && c.init?.method === 'PUT')).toBe(false);
      expect(document.body.textContent).toContain("EC2 instances outside an Auto Scaling group (not ECS) launched with hibernation, in every router that reads the manager's settings, from their next check");
      expect(document.body.textContent).toContain('Dormeto does not enable hibernation on an instance: it is chosen when the instance is launched.');
      expect(document.body.textContent).not.toContain('never launches');
      dialogButton('Turn off').click();
      await flushPromises();
      const put = calls.find((c) => c.path === '/settings/workloads' && c.init?.method === 'PUT')!;
      expect(JSON.parse(String(put.init!.body))).toEqual({ hibernate: false });
      wrapper.unmount();
    });

    it('keeps the value when the confirmation is cancelled', async () => {
      const wrapper = await mountView();
      await card(wrapper).find('input[type="checkbox"]').setValue(false);
      await flushPromises();
      dialogButton('Cancel').click();
      await flushPromises();
      expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
      expect((card(wrapper).find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
      wrapper.unmount();
    });

    it('puts the switch back on the stored value when the save fails', async () => {
      failPut = true;
      const wrapper = await mountView();
      await card(wrapper).find('input[type="checkbox"]').setValue(false);
      await flushPromises();
      dialogButton('Turn off').click();
      await flushPromises();
      expect((card(wrapper).find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
      failPut = false;
      wrapper.unmount();
    });
  });

  describe('the organization\'s waiting page card', () => {
    it('is labelled Organization and sits beside the workload defaults', async () => {
      const wrapper = await mountView();
      const card = wrapper.get('[data-test="waiting-page-card"]');
      expect(card.get('[data-test="waiting-page-level"]').text()).toBe('Organization');
      expect(card.element.parentElement).toBe(wrapper.get('[data-test="workload-defaults"]').element.parentElement);
      expect(calls.some((c) => c.path === '/settings/waiting-page')).toBe(true);
      wrapper.unmount();
    });
  });
});
