import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DiscoveryView from '../src/views/DiscoveryView.vue';
import DmTable from '../src/components/DmTable.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import { useSession } from '../src/stores/session';
import { download } from '../src/table-export';
import type { Role } from '../src/auth';
import { expectEveryColumnSaid } from './table-columns';

const calls: { path: string; init?: RequestInit }[] = [];
// The server's side: the onboarding running on the candidate (named by the candidates while it runs) and how it ended;
// `list` answers the candidates' pages instead of the one candidate; `inFlight` counts the pages asked at once.
type Page = { candidates: unknown[]; cursor: string | null };
// `discovery`: GET /discovery's answer when a test gives one; `refuse`: the dismissal or restore requests that fail (by their
// number, from 1).
const server: { running: string | null; ended: { status: string; error?: string }; backend?: unknown; routers?: unknown[]; routersLater?: Promise<void>; tags?: Record<string, string[]>; row?: Record<string, unknown>;
  discovery?: () => Record<string, unknown>; refuse?: number[]; dismissals?: number; exclusions?: unknown[];
  list?: (query: URLSearchParams) => Page; inFlight: number; mostInFlight: number; later?: Promise<void> } = { running: null, ended: { status: 'succeeded' }, inFlight: 0, mostInFlight: 0 };
const CHECK = { name: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'], checkedAt: '2026-10-11T10:00:00.000Z' };
const candidate = () => ({
  id: 'c-1', status: 'pending-onboarding', statusReason: 'eligible', account: '111122223333', accountName: 'example', region: 'eu-west-3',
  conditions: 'host app.example.com', loadBalancer: 'web', loadBalancerArn: 'arn:lb/web', listener: 'HTTPS:443', priority: '10', rules: [], backend: server.backend ?? null, idleHours7d: null,
  targetGroup: 'ligoj-ui-prod', targetGroupArn: 'arn:tg/ligoj-ui-prod', firstSeenAt: '2026-10-07T06:00:00.000Z',
  ...(server.tags ? { tags: server.tags } : {}),
  ...(server.running ? { operation: { id: server.running, type: 'onboard' } } : {}),
  ...(server.row ?? {}),
});
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/operations') {
      server.running = 'op-9';
      return { operation: { id: 'op-9' } };
    }
    if (path.startsWith('/operations/')) return { id: path.slice('/operations/'.length), type: 'onboard', ...server.ended };
    if (path === '/exclusions' && init?.method === 'POST') return { candidates: 1, operation: { id: 'op-x' } };
    if (path === '/discovery') return server.discovery?.() ?? { lastRun: null, counts: { 'pending-onboarding': 1 } };
    if (path === '/discovery/run') return { accepted: true };
    if (path === '/exclusions') return { exclusions: server.exclusions ?? [] };
    if (path === '/routers' && server.routersLater) await server.routersLater;
    if (path === '/routers' && server.routers) return { routers: server.routers };
    if (path === '/routers') return { routers: [{ name: 'dmtr-dev-eu-west-3', account: '111122223333', region: 'eu-west-3', clusters: [CHECK] }] };
    if (path === '/discovery/dismiss' || path === '/discovery/restore') {
      server.dismissals = (server.dismissals ?? 0) + 1;
      if (server.refuse?.includes(server.dismissals)) throw new Error('ids must be a list of 1 to 100 candidate IDs');
      const ids = JSON.parse(String(init!.body)).ids as string[];
      return { candidates: ids.map((id) => ({ id })) };
    }
    if (path.startsWith('/discovery/candidates?') && server.list) {
      server.inFlight += 1;
      server.mostInFlight = Math.max(server.mostInFlight, server.inFlight);
      // A page asked while another is still on its way would be counted here.
      await Promise.resolve();
      // A page that takes its time, while the test looks at the table loading.
      if (server.later) await server.later;
      server.inFlight -= 1;
      return server.list(new URLSearchParams(path.split('?')[1]));
    }
    if (path.startsWith('/discovery/candidates?')) return { candidates: [candidate()], cursor: null };
    throw new Error(`unexpected ${path}`);
  }),
}));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));

// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountView(role: Role = 'admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = role;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/discovery', component: DiscoveryView }, { path: '/operations', component: { render: () => null } }] });
  await router.push('/discovery');
  const wrapper = mount(DiscoveryView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
type View = Awaited<ReturnType<typeof mountView>>;
const select = async (wrapper: View) => {
  await wrapper.findAll('tr').find((tr) => tr.text().includes('host app.example.com'))!.find('input[type="checkbox"]').trigger('click');
  await nextTick();
};
const running = (wrapper: View) => wrapper.find('a[aria-label="Onboarding of ligoj-ui-prod running: follow it in Operations"]');
const toast = () => document.querySelector('.v-snackbar');
// A row by its rule, a cell of it by the column's title.
const rowOf = (wrapper: View, host: string) => wrapper.findAll('tbody tr').find((tr) => tr.text().includes(host))!;
const cellOf = (wrapper: View, row: ReturnType<View['find']>, column: string) => row.findAll('td')[wrapper.findAll('thead th').map((th) => th.text()).indexOf(column)]!;
// A menu's items once its "⋮" is clicked; chosen, the menu closes (a click during its closing would be lost).
const menuItems = () => [...document.querySelectorAll<HTMLElement>('.v-overlay--active .v-list-item')];
async function openMenu(button: ReturnType<View['find']>) {
  await button.trigger('click');
  await flushPromises();
  return menuItems();
}
async function menuOf(wrapper: View, host: string): Promise<string[] | null> {
  const button = rowOf(wrapper, host).find('[data-test="dm-row-menu"]');
  if (!button.exists()) return null;
  const titles = (await openMenu(button)).map((i) => `${i.textContent!.trim()}${i.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : ''}`);
  await button.trigger('click');
  await flushPromises();
  await sleep(350);
  return titles;
}
async function choose(wrapper: View, host: string, title: string) {
  (await openMenu(rowOf(wrapper, host).find('[data-test="dm-row-menu"]'))).find((i) => i.textContent?.trim() === title)!.click();
  await flushPromises();
  await sleep(350);
}
// The CSV the table's menu exports, as its lines.
async function exportCsv(wrapper: View) {
  vi.mocked(download).mockClear();
  await openMenu(wrapper.find('thead [data-test="dm-table-menu"]'));
  (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
  await flushPromises();
  await sleep(50);
  await flushPromises();
  const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
  expect(name).toMatch(/^dormeto-discovery-\d{4}-\d{2}-\d{2}\.csv$/);
  return (body as string).split('\r\n').slice(0, -1);
}
// Candidates of one status, by pages of the size asked, the cursor their offset.
const pagesOf = (rows: unknown[]) => (q: URLSearchParams): Page => {
  const start = Number(q.get('cursor') ?? 0);
  const end = start + Number(q.get('limit'));
  return { candidates: rows.slice(start, end), cursor: end < rows.length ? String(end) : null };
};
const numbered = (n: number) => Array.from({ length: n }, (_, i) => ({ ...candidate(), id: `c-${i}`, conditions: `host h${String(i).padStart(3, '0')}.example.com`, targetGroup: `tg-${i}`, targetGroupArn: `arn:tg/tg-${i}` }));
// A row's checkbox, and whether it is ticked.
const box = (wrapper: View, host: string) => rowOf(wrapper, host).find('input[type="checkbox"]');
const ticked = (wrapper: View, host: string) => (box(wrapper, host).element as HTMLInputElement).checked;
const button = (wrapper: View, text: string) => wrapper.findAll('button').find((b) => b.text() === text);
// A button of the dialog open.
const dialogButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === text)!;

describe('Discovery view, both clouds', () => {
  it('filters by an AWS account or a Google Cloud project, and by a region of that cloud only', async () => {
    document.body.innerHTML = '';
    calls.length = 0;
    const wrapper = await mountView();
    const field = (label: string) => wrapper.findAll('.dm-filter').find((f) => f.text().includes(label))!;
    expect(field('Account or project').exists()).toBe(true);
    const listed = () => new URLSearchParams(calls.filter((c) => c.path.startsWith('/discovery/candidates?')).at(-1)!.path.split('?')[1]);
    const type = async (label: string, value: string) => {
      const input = field(label).find('input');
      await input.setValue(value);
      await sleep(450);
      await flushPromises();
    };
    await type('Account or project', 'dormeto-dev');
    expect(listed().get('account')).toBe('dormeto-dev');
    // A Google Cloud region within a project, an AWS one within an account; the other cloud's is not sent.
    await type('Region', 'europe-west2');
    expect(listed().get('region')).toBe('europe-west2');
    // A global load balancer's candidates have the region `global`.
    await type('Region', 'global');
    expect(listed().get('region')).toBe('global');
    await type('Region', 'eu-west-1');
    expect(listed().get('region')).toBeNull();
    await type('Account or project', '111122223333');
    await type('Region', 'eu-west-1');
    expect([listed().get('account'), listed().get('region')]).toEqual(['111122223333', 'eu-west-1']);
    await type('Region', 'europe-west2');
    expect(listed().get('region')).toBeNull();
    await type('Region', 'global');
    expect(listed().get('region')).toBeNull();
    wrapper.unmount();
  });

  it('suggests the region of the filtered account\'s cloud: an AWS one by default, a Google Cloud one for a project', async () => {
    document.body.innerHTML = '';
    const wrapper = await mountView();
    const region = () => wrapper.findAll('.dm-filter').find((f) => f.text().includes('Region'))!.find('input');
    expect(region().attributes('placeholder')).toBe('eu-west-1');
    await wrapper.findAll('.dm-filter').find((f) => f.text().includes('Account or project'))!.find('input').setValue('dormeto-dev');
    expect(region().attributes('placeholder')).toBe('europe-west2 or global');
    await wrapper.findAll('.dm-filter').find((f) => f.text().includes('Account or project'))!.find('input').setValue('111122223333');
    expect(region().attributes('placeholder')).toBe('eu-west-1');
    wrapper.unmount();
  });
});

const GCP_BS = 'projects/dormeto-dev/global/backendServices/shop-bs';
const GCP_MAP = 'projects/dormeto-dev/global/urlMaps/shop-lb';
const gcpRow = () => ({
  id: GCP_BS, cloud: 'gcp', account: 'dormeto-dev', accountName: 'dormeto-dev', region: 'global', conditions: 'host shop.example.com', loadBalancer: 'shop-lb', loadBalancerArn: '', listener: '', priority: '',
  targetGroup: 'shop-bs', targetGroupArn: null, backendService: GCP_BS, urlMap: GCP_MAP, lb: { kind: 'global' }, backend: { kind: 'asg', id: 'shop-mig' }, idleHours7d: 120, requests7d: 4_000,
});

describe('Discovery view, a Google Cloud candidate', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    delete server.backend;
    document.body.innerHTML = '';
    server.row = gcpRow();
  });
  afterEach(() => {
    delete server.row;
    delete server.routers;
  });

  it('shows its backend service and URL map by name, linked to the Google Cloud console, in `global` as the earth alone, its idle share with a ~ and no word', async () => {
    const wrapper = await mountView();
    const row = wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!;
    expect(row.text()).toContain('shop-bs');
    expect(row.text()).toContain('shop-lb');
    // The user (2026-11-12): no "estimated", the ~ says it; no region name for `global`.
    expect(row.text()).not.toContain('estimated');
    expect(cellOf(wrapper, row, 'Idle (7 days)').text()).toBe('~71 %');
    const region = cellOf(wrapper, row, 'Region');
    expect(region.text()).toBe('');
    expect(region.find('.region-label').attributes('aria-label')).toBe('global');
    await region.find('.region-label').trigger('mouseenter');
    await sleep(300);
    expect(document.querySelector('.v-overlay--active')?.textContent).toContain('A global load balancer');
    expect(row.text()).not.toContain('priority');
    expect(row.text()).toContain('shop-mig');
    const hrefs = row.findAll('a').map((a) => a.attributes('href')).filter(Boolean);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain('console.cloud.google.com');
    expect(hrefs).toContain('https://console.cloud.google.com/net-services/loadbalancing/details/http/shop-lb?project=dormeto-dev');
    wrapper.unmount();
  });

  it('keeps an AWS candidate\'s idle share without the word', async () => {
    server.row = { idleHours7d: 120, requests7d: 4_000 };
    const wrapper = await mountView();
    const row = wrapper.findAll('tr').find((tr) => tr.text().includes('host app.example.com'))!;
    expect(row.text()).not.toContain('estimated');
    expect(cellOf(wrapper, row, 'Idle (7 days)').text()).toBe('71 %');
    expect(row.text()).toContain('priority 10');
    wrapper.unmount();
  });

  it('offers to exclude its backend service, its URL map or its project, and sends the chosen one by its path', async () => {
    const wrapper = await mountView();
    await wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!.find('input[type="checkbox"]').trigger('click');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('Exclude…'))!.trigger('click');
    await flushPromises();
    const dialog = document.querySelector('.v-dialog')!;
    expect(dialog.textContent).toContain('Backend service shop-bs');
    expect(dialog.textContent).toContain('URL map shop-lb');
    expect(dialog.textContent).toContain('Project dormeto-dev');
    expect(dialog.textContent).not.toContain('Target group');
    (dialog.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click();
    await nextTick();
    const reason = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    reason.value = 'shared';
    reason.dispatchEvent(new Event('input'));
    await nextTick();
    const submit = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Exclude')!;
    submit.click();
    await flushPromises();
    const sent = calls.find((c) => c.path === '/exclusions' && c.init?.method === 'POST')!;
    expect(JSON.parse(sent.init!.body as string)).toEqual({ target: { kind: 'load-balancer', path: GCP_MAP }, reason: 'shared' });
    wrapper.unmount();
  });

  it('offboards a managed one through the router its workload names, not one found by its region', async () => {
    server.row = { ...gcpRow(), status: 'managed', workloadId: 'shop-bs', workload: { router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs', name: 'Shop' } };
    const wrapper = await mountView();
    await wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!.find('input[type="checkbox"]').trigger('click');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('Offboard'))!.trigger('click');
    await flushPromises();
    const sent = calls.find((c) => c.path === '/operations')!;
    expect(JSON.parse(sent.init!.body as string)).toMatchObject({ type: 'offboard', router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs' });
    wrapper.unmount();
  });
});

describe('Discovery view, onboarding a Google Cloud candidate', () => {
  const ROUTERS = [
    { name: 'dmtr-dormeto-dev-europe-west2', cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2' },
    { name: 'dmtr-dormeto-dev-us-east1', cloud: 'gcp', account: 'dormeto-dev', region: 'us-east1' },
    { name: 'dmtr-other-us-east1', cloud: 'gcp', account: 'other', region: 'us-east1' },
  ];
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    delete server.backend;
    document.body.innerHTML = '';
    server.row = gcpRow();
  });
  afterEach(() => {
    delete server.row;
    delete server.routers;
    delete server.routersLater;
  });
  const open = async () => {
    const wrapper = await mountView();
    await wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!.find('input[type="checkbox"]').trigger('click');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('Onboard'))!.trigger('click');
    await flushPromises();
    return wrapper;
  };

  it('asks a global candidate for one of its project\'s routers when there are several, and sends it with the Cloud SQL instances', async () => {
    server.routers = ROUTERS;
    const wrapper = await open();
    const dialog = wrapper.findComponent(OnboardDialog);
    expect(dialog.props('cloud')).toBe('gcp');
    expect(dialog.props('routers')).toEqual([{ name: 'dmtr-dormeto-dev-europe-west2', region: 'europe-west2' }, { name: 'dmtr-dormeto-dev-us-east1', region: 'us-east1' }]);
    dialog.vm.$emit('submit', { router: 'dmtr-dormeto-dev-us-east1', settings: {}, databases: [{ kind: 'cloudsql-instance', id: 'db-demo' }] });
    await flushPromises();
    const sent = calls.find((c) => c.path === '/operations')!;
    expect(JSON.parse(sent.init!.body as string)).toEqual({ type: 'onboard', candidateId: GCP_BS, router: 'dmtr-dormeto-dev-us-east1', settings: {}, databases: [{ kind: 'cloudsql-instance', id: 'db-demo' }] });
    wrapper.unmount();
  });

  it('offers no router below 0.40.0, and asks for one when the project has several whatever their versions (the API needs it named)', async () => {
    server.routers = [
      { name: 'dmtr-dormeto-dev-europe-west2', cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', version: '0.39.0' },
      { name: 'dmtr-dormeto-dev-us-east1', cloud: 'gcp', account: 'dormeto-dev', region: 'us-east1', version: '0.40.0-dev.1' },
      { name: 'dmtr-dormeto-dev-us-west1', cloud: 'gcp', account: 'dormeto-dev', region: 'us-west1', version: null, refusal: 'router_too_old' },
    ];
    const wrapper = await open();
    const dialog = wrapper.findComponent(OnboardDialog);
    expect(dialog.props('routers')).toEqual([{ name: 'dmtr-dormeto-dev-us-east1', region: 'us-east1' }]);
    expect(dialog.props('chooseRouter')).toBe(true);
    wrapper.unmount();
  });

  it('gives the dialog no router list while it is read, for a global candidate', async () => {
    let release!: () => void;
    server.routersLater = new Promise<void>((resolve) => { release = resolve; });
    server.routers = ROUTERS;
    const wrapper = await open();
    expect(wrapper.findComponent(OnboardDialog).props('routers')).toBeNull();
    release();
    await flushPromises();
    expect(wrapper.findComponent(OnboardDialog).props('routers')).toHaveLength(2);
    wrapper.unmount();
  });

  it('gives a regional candidate its region\'s router alone, so no choice', async () => {
    server.routers = ROUTERS;
    server.row = { ...gcpRow(), region: 'us-east1', lb: { kind: 'regional', region: 'us-east1' } };
    const wrapper = await open();
    expect(wrapper.findComponent(OnboardDialog).props('routers')).toEqual([{ name: 'dmtr-dormeto-dev-us-east1', region: 'us-east1' }]);
    wrapper.unmount();
  });

  it('offers Offboard for a managed VM or instance group candidate, not for a GKE one', async () => {
    const managed = { ...gcpRow(), status: 'managed', workloadId: 'shop-bs', workload: { router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs', name: 'Shop' } };
    const offboardButton = async (backend: unknown) => {
      server.row = { ...managed, backend };
      document.body.innerHTML = '';
      const wrapper = await mountView();
      await wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!.find('input[type="checkbox"]').trigger('click');
      await nextTick();
      const found = wrapper.findAll('button').some((b) => b.text().includes('Offboard'));
      wrapper.unmount();
      return found;
    };
    expect(await offboardButton({ kind: 'instance', id: 'vm' })).toBe(true);
    expect(await offboardButton({ kind: 'k8s', kubernetes: { cluster: 'gke' } })).toBe(false);
  });
});

describe('Discovery view', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    delete server.backend;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says what discovery reads in a tooltip beside the page\'s title, not under it (the user, 2026-11-02)', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).not.toContain('Load balancer rules of every account');
    const more = wrapper.find('[data-test="page-title"] [data-test="discovery-more"]');
    expect(more.attributes('tabindex')).toBe('0');
    expect(more.attributes('aria-label')).toBe('What discovery reads');
    await more.trigger('mouseenter');
    await sleep(300);
    const tip = document.querySelector('.v-overlay--active [data-test="discovery-tip"]')!;
    expect(tip.textContent!.replace(/\s+/g, ' ').trim()).toBe('Load balancer rules of every account and region of the perimeter, read with the read-only DmtDiscoveryRole. Discovery runs on a schedule and on demand; idle shares are the hours without any request over the last 7 days. A Google Cloud project is read with the discovery service account of dormeto gcp connect; its idle share is estimated, as Google samples its load balancer metrics.');
    expect(tip.querySelector('code')!.textContent).toBe('DmtDiscoveryRole');
    wrapper.unmount();
  });

  it('shows an onboarding running on a candidate as an animated chip opening its operation, and offers no second onboarding', async () => {
    server.running = 'op-5';
    const wrapper = await mountView();
    expect(running(wrapper).attributes('href')).toBe('/operations?id=op-5');
    expect(running(wrapper).find('.v-progress-circular--indeterminate').exists()).toBe(true);
    await select(wrapper);
    expect(wrapper.findAll('button').some((b) => b.text() === 'Onboard…')).toBe(false);
    const busy = wrapper.findAll('button').find((b) => b.text() === 'Onboarding…');
    expect(busy?.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('starts an onboarding with a toast linking to its operation, not a banner, and shows it running at once', async () => {
    const wrapper = await mountView();
    await select(wrapper);
    wrapper.findComponent(OnboardDialog).vm.$emit('submit', { settings: {}, databases: [] });
    await flushPromises();
    await sleep(50);
    expect(toast()?.textContent).toContain('Onboarding of ligoj-ui-prod started');
    expect([...toast()!.querySelectorAll('a')].find((a) => a.textContent === 'Follow it in Operations')?.getAttribute('href')).toBe('/operations?id=op-9');
    expect(wrapper.find('.v-alert').exists()).toBe(false);
    expect(running(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it('passes the tags of the form to the onboarding operation, and the candidate\'s AWS tags to the dialog (R11)', async () => {
    server.tags = { team: ['payments'], env: ['staging', 'prod'] };
    const wrapper = await mountView();
    await select(wrapper);
    await wrapper.findAll('button').find((b) => b.text() === 'Onboard…')!.trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(OnboardDialog);
    expect(dialog.props('awsTags')).toEqual({ team: ['payments'], env: ['staging', 'prod'] });
    dialog.vm.$emit('submit', { settings: {}, databases: [], tags: { team: 'payments' } });
    await flushPromises();
    const started = calls.find((c) => c.path === '/operations')!;
    expect(JSON.parse(started.init!.body as string)).toMatchObject({ type: 'onboard', candidateId: 'c-1', tags: { team: 'payments' } });
    server.tags = undefined;
    wrapper.unmount();
  });

  it('gives the onboarding dialog of a Kubernetes candidate its owner and switch, and the router\'s last check of its cluster (R10.5)', async () => {
    const kubernetes = { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress', hpa: false, keda: false, capacity: 'nodes', autoscaler: 'karpenter',
      ingress: { name: 'web', ruleIndex: 0, groupOrder: -1, service: { name: 'web', port: { number: 80 } } } };
    server.backend = { kind: 'k8s', id: 'eks-demo/demo/Deployment/web', kubernetes };
    const wrapper = await mountView();
    await select(wrapper);
    await wrapper.findAll('button').find((b) => b.text() === 'Onboard…')!.trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(OnboardDialog);
    expect(dialog.props('kubernetes')).toEqual(kubernetes);
    expect(dialog.props('access')).toEqual(CHECK);
    wrapper.unmount();
  });

  it('says its last run\'s status by its icon alone, the word its name', async () => {
    const { api } = await import('../src/api');
    const at = '2026-10-07T06:00:00.000Z';
    const run = { startedAt: at, finishedAt: '2026-10-07T06:00:47.000Z', trigger: 'schedule', status: 'partial', mode: 'organization', targets: [], lint: [] };
    vi.mocked(api).mockImplementationOnce(async () => ({ lastRun: run, counts: { 'pending-onboarding': 1 } }));
    const wrapper = await mountView();
    const headline = wrapper.find('.dm-run__headline');
    expect(headline.text()).toMatch(/^Last run .* ago$/);
    expect(headline.find('[data-test="status-mark"]').attributes()).toMatchObject({ 'aria-label': 'partial', tabindex: '0', class: expect.stringContaining('text-warning') });
    wrapper.unmount();
  });

  it('refreshes while an onboarding runs, and says in a toast how it ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server.running = 'op-5';
    server.ended = { status: 'failed', error: 'verify: route app' };
    const wrapper = await mountView();
    server.running = null;
    vi.advanceTimersByTime(10_000);
    await flushPromises();
    await sleep(50);
    expect(calls.some((c) => c.path === '/operations/op-5')).toBe(true);
    expect(toast()?.textContent).toContain('Onboarding of ligoj-ui-prod failed: verify: route app');
    expect(running(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('Discovery view, its table', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    server.mostInFlight = 0;
    delete server.backend;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete server.list;
    delete server.routers;
  });
  const MANAGED_VM = { ...gcpRow(), status: 'managed', workloadId: 'shop-bs', workload: { router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs', name: 'Shop' }, backend: { kind: 'instance', id: 'shop-vm' } };

  it('shows each candidate\'s status as its icon alone, named, and an onboarding running as a spinner opening its operation', async () => {
    server.list = () => ({ candidates: [candidate(), { ...candidate(), id: 'c-run', conditions: 'host run.example.com', operation: { id: 'op-5', type: 'onboard' } }], cursor: null });
    const wrapper = await mountView();
    const status = cellOf(wrapper, rowOf(wrapper, 'host app.example.com'), 'Status');
    expect(status.text()).toBe('');
    expect(status.find('[data-test="status-mark"]').attributes('aria-label')).toBe('To onboard');
    const busy = cellOf(wrapper, rowOf(wrapper, 'host run.example.com'), 'Status');
    expect(busy.text()).toBe('');
    const link = busy.find('a');
    expect([link.attributes('href'), link.attributes('aria-label')]).toEqual(['/operations?id=op-5', 'Onboarding of ligoj-ui-prod running: follow it in Operations']);
    expect(link.find('.v-progress-circular--indeterminate').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps the selection across pages: the selection\'s dismissal takes the rows chosen on each', async () => {
    server.list = pagesOf(numbered(70));
    const wrapper = await mountView();
    const box = (host: string) => rowOf(wrapper, host).find('input[type="checkbox"]');
    const footer = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!;
    await box('host h001.example.com').trigger('click');
    await nextTick();
    await footer('Next').trigger('click');
    await flushPromises();
    expect(calls.filter((c) => c.path.startsWith('/discovery/candidates?')).at(-1)!.path).toBe('/discovery/candidates?status=pending-onboarding&limit=50&cursor=50');
    await box('host h060.example.com').trigger('click');
    await nextTick();
    expect(wrapper.findAll('button').some((b) => b.text() === 'Dismiss (2)')).toBe(true);
    // Back on the first page, its row is still chosen.
    await footer('Previous').trigger('click');
    await flushPromises();
    expect((box('host h001.example.com').element as HTMLInputElement).checked).toBe(true);
    expect((box('host h002.example.com').element as HTMLInputElement).checked).toBe(false);
    await wrapper.findAll('button').find((b) => b.text() === 'Dismiss (2)')!.trigger('click');
    await flushPromises();
    const dialog = document.querySelector('.v-dialog')!;
    expect(dialog.textContent).toContain('The 2 selected rules will stay dismissed');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dismiss')!.click();
    await flushPromises();
    const sent = calls.find((c) => c.path === '/discovery/dismiss')!;
    expect(JSON.parse(sent.init!.body as string)).toEqual({ ids: ['c-1', 'c-60'] });
    wrapper.unmount();
  });

  it('puts a candidate\'s actions in its row\'s menu for operators: Onboard, Offboard, Exclude, Dismiss or Restore, as the selection\'s buttons offer them', async () => {
    server.list = () => ({ candidates: [
      candidate(),
      { ...candidate(), id: 'c-run', conditions: 'host run.example.com', operation: { id: 'op-5', type: 'onboard' } },
      { ...candidate(), ...MANAGED_VM },
      { ...candidate(), id: 'c-old', conditions: 'host old.example.com', status: 'dismissed' },
    ], cursor: null });
    const wrapper = await mountView();
    expect(rowOf(wrapper, 'host app.example.com').find('[data-test="dm-row-menu"]').attributes('aria-label')).toBe('Actions for host app.example.com');
    expect(await menuOf(wrapper, 'host app.example.com')).toEqual(['Onboard…', 'Exclude…', 'Dismiss…']);
    expect(await menuOf(wrapper, 'host run.example.com')).toEqual(['Onboarding… (disabled)', 'Exclude…', 'Dismiss…']);
    expect(await menuOf(wrapper, 'host shop.example.com')).toEqual(['Offboard', 'Exclude…', 'Dismiss…']);
    expect(await menuOf(wrapper, 'host old.example.com')).toEqual(['Exclude…', 'Restore']);
    // The running one says why in its tooltip.
    const item = (await openMenu(rowOf(wrapper, 'host run.example.com').find('[data-test="dm-row-menu"]')))[0]!;
    item.dispatchEvent(new Event('mouseenter'));
    await sleep(300);
    expect(document.querySelector('.v-overlay-container')!.textContent).toContain('Onboarding of ligoj-ui-prod is running: follow it in Operations.');
    await rowOf(wrapper, 'host run.example.com').find('[data-test="dm-row-menu"]').trigger('click');
    await sleep(350);

    // Each acts on its row alone, through the same dialogs.
    await choose(wrapper, 'host app.example.com', 'Onboard…');
    const onboarding = wrapper.findComponent(OnboardDialog);
    expect([onboarding.props('modelValue'), onboarding.props('title')]).toEqual([true, 'host app.example.com']);
    onboarding.vm.$emit('update:modelValue', false);
    await flushPromises();
    await choose(wrapper, 'host old.example.com', 'Restore');
    expect(JSON.parse(calls.find((c) => c.path === '/discovery/restore')!.init!.body as string)).toEqual({ ids: ['c-old'] });
    await choose(wrapper, 'host shop.example.com', 'Offboard');
    expect(JSON.parse(calls.find((c) => c.path === '/operations')!.init!.body as string)).toMatchObject({ type: 'offboard', router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs' });
    wrapper.unmount();
  });

  it('gives a viewer no row menu and no selection, the table\'s menu with its exports still', async () => {
    const wrapper = await mountView('viewer');
    expect(wrapper.findAll('[data-test="dm-row-menu"]')).toHaveLength(0);
    expect(wrapper.findAll('tbody input[type="checkbox"]')).toHaveLength(0);
    expect(wrapper.find('thead [data-test="dm-table-menu"]').attributes('aria-label')).toBe('Table actions');
    wrapper.unmount();
  });

  it('exports its candidates with each column in words: the status, the rule and where it is, the account, the region, the backend, the idle share with its ~, the reason, the first seen date', async () => {
    const aws = { ...candidate(), backend: { kind: 'instance', id: 'i-0f30c85bc47412bf3' }, idleHours7d: 120, requests7d: 4_000,
      rules: [{ priority: '10', listener: 'HTTPS:443', conditions: 'host app.example.com' }, { priority: '20', listener: 'HTTPS:443', conditions: 'host app.example.com path /api/*' }] };
    server.list = () => ({ candidates: [aws, { ...candidate(), ...gcpRow(), operation: { id: 'op-7', type: 'onboard' } }, { ...candidate(), ...MANAGED_VM }], cursor: null });
    const wrapper = await mountView();
    expect(await exportCsv(wrapper)).toEqual([
      'Status,Rule,Account or project,Region,Backend,Idle (7 days),Reason,First seen',
      'To onboard,host app.example.com · web · HTTPS:443 · priority 10 · 2 rules,"example (AWS, 111122223333)",eu-west-3,EC2 instance i-0f30c85bc47412bf3,71 %,eligible,2026-10-07T06:00:00.000Z',
      'To onboard · onboarding running,host shop.example.com · backend service shop-bs · URL map shop-lb · global external Application Load Balancer,dormeto-dev (Google Cloud),global,Managed instance group shop-mig,~71 %,eligible,2026-10-07T06:00:00.000Z',
      'Managed,host shop.example.com · backend service shop-bs · URL map shop-lb · global external Application Load Balancer,dormeto-dev (Google Cloud),global,Compute Engine VM shop-vm,~71 %,managed as Shop,2026-10-07T06:00:00.000Z',
    ]);
    expectEveryColumnSaid(wrapper, 'discovery', aws);
    wrapper.unmount();
  });

  it('exports every candidate of the status and the filters shown, reading the API\'s largest pages one at a time, the filters in the PDF', async () => {
    server.list = pagesOf(numbered(450));
    const wrapper = await mountView();
    const type = async (label: string, value: string) => {
      await wrapper.findAll('.dm-filter').find((f) => f.text().includes(label))!.find('input').setValue(value);
      await sleep(450);
      await flushPromises();
    };
    await type('Account or project', '111122223333');
    await type('Region', 'eu-west-3');
    calls.length = 0;
    server.mostInFlight = 0;
    const lines = await exportCsv(wrapper);
    const asked = calls.filter((c) => c.path.startsWith('/discovery/candidates?')).map((c) => Object.fromEntries(new URLSearchParams(c.path.split('?')[1])));
    const where = { status: 'pending-onboarding', limit: '200', account: '111122223333', region: 'eu-west-3' };
    expect(asked).toEqual([where, { ...where, cursor: '200' }, { ...where, cursor: '400' }]);
    expect(server.mostInFlight).toBe(1);
    expect(lines).toHaveLength(1 + 450);
    expect([lines[1]!.split(',')[1], lines[450]!.split(',')[1]]).toEqual(['host h000.example.com · web · HTTPS:443 · priority 10', 'host h449.example.com · web · HTTPS:443 · priority 10']);
    expect((wrapper.findComponent(DmTable).props() as { exported: unknown }).exported).toEqual({ name: 'discovery', title: 'Discovery candidates', filters: ['Status: To onboard', 'Account or project: 111122223333', 'Region: eu-west-3'] });
    wrapper.unmount();
  });

  it('cuts an export at 5,000 candidates, saying so (the API does not count a filtered list)', async () => {
    server.list = pagesOf(numbered(5_300));
    const wrapper = await mountView();
    calls.length = 0;
    const lines = await exportCsv(wrapper);
    // 5,001 read to know there are others: 26 pages of 200.
    expect(calls.filter((c) => c.path.startsWith('/discovery/candidates?'))).toHaveLength(26);
    expect(lines).toHaveLength(1 + 5_000 + 1);
    expect(lines.at(-1)).toBe('"The first 5,000 rows: narrow the search or the filters to export the others.",,,,,,,');
    wrapper.unmount();
  });
});

describe('Discovery view, its table: a row\'s actions, the export\'s reading, search, the pager (review round 1)', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    server.mostInFlight = 0;
    delete server.backend;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete server.list;
    delete server.later;
  });
  const listed = () => calls.filter((c) => c.path.startsWith('/discovery/candidates?')).map((c) => Object.fromEntries(new URLSearchParams(c.path.split('?')[1])));

  it('acts on a row from its menu without touching the selection: Exclude… cancelled or confirmed, Dismiss…, the rows ticked stay ticked', async () => {
    server.list = pagesOf(numbered(5));
    const wrapper = await mountView();
    await box(wrapper, 'host h000.example.com').trigger('click');
    await box(wrapper, 'host h001.example.com').trigger('click');
    await nextTick();
    expect(button(wrapper, 'Dismiss (2)')).toBeDefined();
    // Cancelled: nothing changes.
    await choose(wrapper, 'host h003.example.com', 'Exclude…');
    let dialog = document.querySelector('.v-dialog.v-overlay--active')!;
    expect(dialog.textContent).toContain('tg-3');
    expect(dialog.textContent).not.toContain('tg-0');
    dialogButton('Cancel').click();
    await flushPromises();
    await sleep(350);
    expect([ticked(wrapper, 'host h000.example.com'), ticked(wrapper, 'host h001.example.com'), ticked(wrapper, 'host h003.example.com')]).toEqual([true, true, false]);
    expect(button(wrapper, 'Dismiss (2)')).toBeDefined();
    // Confirmed: the row's target alone is excluded; the two stay ticked.
    await choose(wrapper, 'host h003.example.com', 'Exclude…');
    dialog = document.querySelector('.v-dialog.v-overlay--active')!;
    (dialog.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click();
    await nextTick();
    const reason = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    reason.value = 'shared';
    reason.dispatchEvent(new Event('input'));
    await nextTick();
    dialogButton('Exclude').click();
    await flushPromises();
    await sleep(50);
    await flushPromises();
    const sent = calls.find((c) => c.path === '/exclusions' && c.init?.method === 'POST')!;
    expect(JSON.parse(sent.init!.body as string)).toMatchObject({ target: { kind: 'target-group', arn: 'arn:tg/tg-3' }, reason: 'shared' });
    expect([ticked(wrapper, 'host h000.example.com'), ticked(wrapper, 'host h001.example.com')]).toEqual([true, true]);
    expect(button(wrapper, 'Dismiss (2)')).toBeDefined();
    // Dismiss… from a row: that rule alone, said so; the two stay ticked.
    await choose(wrapper, 'host h004.example.com', 'Dismiss…');
    expect(document.querySelector('.v-dialog.v-overlay--active')!.textContent).toContain('The rule host h004.example.com will stay dismissed');
    dialogButton('Dismiss').click();
    await flushPromises();
    await sleep(50);
    await flushPromises();
    expect(JSON.parse(calls.find((c) => c.path === '/discovery/dismiss')!.init!.body as string)).toEqual({ ids: ['c-4'] });
    expect([ticked(wrapper, 'host h000.example.com'), ticked(wrapper, 'host h001.example.com')]).toEqual([true, true]);
    wrapper.unmount();
  });

  it('keeps a page\'s rows when its header ticks them all after rows of another page', async () => {
    server.list = pagesOf(numbered(70));
    const wrapper = await mountView();
    await box(wrapper, 'host h001.example.com').trigger('click');
    await nextTick();
    await button(wrapper, 'Next')!.trigger('click');
    await flushPromises();
    await wrapper.find('thead input[type="checkbox"]').trigger('click');
    await nextTick();
    expect(button(wrapper, 'Dismiss (21)')).toBeDefined();
    await button(wrapper, 'Previous')!.trigger('click');
    await flushPromises();
    expect([ticked(wrapper, 'host h001.example.com'), ticked(wrapper, 'host h002.example.com')]).toEqual([true, false]);
    await button(wrapper, 'Dismiss (21)')!.trigger('click');
    await flushPromises();
    dialogButton('Dismiss').click();
    await flushPromises();
    const ids = JSON.parse(calls.find((c) => c.path === '/discovery/dismiss')!.init!.body as string).ids as string[];
    expect(ids).toHaveLength(21);
    expect(ids).toContain('c-1');
    expect(ids).toContain('c-50');
    expect(ids).toContain('c-69');
    wrapper.unmount();
  });

  it('stops an export when the API gives a page\'s cursor twice, saying so in the file', async () => {
    server.list = (q) => ({ candidates: q.get('cursor') ? [] : [candidate()], cursor: 'again' });
    const wrapper = await mountView();
    calls.length = 0;
    const lines = await exportCsv(wrapper);
    expect(listed().map((q) => q.cursor ?? null)).toEqual([null, 'again']);
    expect(lines).toHaveLength(1 + 1 + 1);
    expect(lines.at(-1)).toBe('"1 row read, then the API gave the same page twice: the reading stopped there.",,,,,,,');
    wrapper.unmount();
  });

  it('reads on through empty pages (a scoped user\'s, the API filters after its query), and stops after ceil(limit / page) + 25 requests', async () => {
    // 30 empty pages, then the rows.
    server.list = (q) => {
      const n = Number(q.get('cursor') ?? 0);
      return n < 30 ? { candidates: [], cursor: String(n + 1) } : { candidates: numbered(2), cursor: null };
    };
    let wrapper = await mountView();
    calls.length = 0;
    let lines = await exportCsv(wrapper);
    expect(listed()).toHaveLength(31);
    expect(lines).toHaveLength(1 + 2);
    wrapper.unmount();
    // Empty pages without end: 26 requests for 5,001 rows of 200, and 25 more.
    server.list = (q) => ({ candidates: [], cursor: String(Number(q.get('cursor') ?? 0) + 1) });
    document.body.innerHTML = '';
    wrapper = await mountView();
    calls.length = 0;
    lines = await exportCsv(wrapper);
    expect(listed()).toHaveLength(51);
    expect(lines).toEqual(['Status,Rule,Account or project,Region,Backend,Idle (7 days),Reason,First seen',
      '"0 rows read in 51 requests, the most an export makes: narrow the search or the filters to export the others.",,,,,,,']);
    wrapper.unmount();
  });

  it('exports within the filters the table shows, not those still being typed', async () => {
    server.list = pagesOf(numbered(3));
    const wrapper = await mountView();
    await wrapper.findAll('.dm-filter').find((f) => f.text().includes('Account or project'))!.find('input').setValue('111122223333');
    // Within the 400 ms pause: the table still shows every account.
    calls.length = 0;
    await exportCsv(wrapper);
    expect(listed()[0]!.account).toBeUndefined();
    expect(((wrapper.findComponent(DmTable).props() as { exported: { filters: string[] } }).exported).filters).toEqual(['Status: To onboard']);
    await sleep(450);
    await flushPromises();
    calls.length = 0;
    await exportCsv(wrapper);
    expect(listed()[0]!.account).toBe('111122223333');
    wrapper.unmount();
  });

  it('keeps its pager reachable while a page loads: Previous and Next ignore a click then, the range a status, the pager a named navigation', async () => {
    server.list = pagesOf(numbered(120));
    const wrapper = await mountView();
    const pager = wrapper.find('nav.dm-candidates__foot');
    expect(pager.attributes('aria-label')).toBe('Pages of candidates');
    expect(pager.find('[role="status"]').text()).toBe('1–50 of 1 (at the last change)');
    let release!: () => void;
    server.later = new Promise<void>((r) => { release = r; });
    await button(wrapper, 'Next')!.trigger('click');
    await nextTick();
    // Loading: the buttons stay enabled (the focus stays), a click is ignored.
    expect(button(wrapper, 'Next')!.attributes('disabled')).toBeUndefined();
    expect(button(wrapper, 'Previous')!.attributes('disabled')).toBeUndefined();
    const asked = listed().length;
    await button(wrapper, 'Next')!.trigger('click');
    await button(wrapper, 'Previous')!.trigger('click');
    await nextTick();
    expect(listed()).toHaveLength(asked);
    release();
    delete server.later;
    await flushPromises();
    expect(wrapper.find('nav.dm-candidates__foot [role="status"]').text()).toMatch(/^51–100 /);
    expect(button(wrapper, 'Previous')!.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('searches every candidate of the status within the filters: read by the cursor, shown as one list with the table\'s pages, the selection kept; cleared, the cursor\'s pages again', async () => {
    server.list = pagesOf(numbered(70));
    const wrapper = await mountView();
    await box(wrapper, 'host h001.example.com').trigger('click');
    await nextTick();
    calls.length = 0;
    await wrapper.find('[data-test="dm-table-search"] input').setValue('h06');
    await sleep(450);
    await flushPromises();
    // The status' candidates read by the API's largest pages; the matching ones shown, the cursor's pager gone.
    expect(listed()).toEqual([{ status: 'pending-onboarding', limit: '200' }]);
    expect(wrapper.findAll('tbody tr').map((r) => r.text().match(/host h\d+/)?.[0])).toEqual(Array.from({ length: 10 }, (_, i) => `host h06${i}`));
    expect(wrapper.find('nav.dm-candidates__foot').exists()).toBe(false);
    expect(button(wrapper, 'Dismiss (1)')).toBeDefined();
    await box(wrapper, 'host h065.example.com').trigger('click');
    await nextTick();
    expect(button(wrapper, 'Dismiss (2)')).toBeDefined();
    // Its export: those rows.
    const lines = await exportCsv(wrapper);
    expect(lines).toHaveLength(1 + 10);
    // Cleared: the cursor's first page again, the selection kept.
    await wrapper.find('[data-test="dm-table-search"] input').setValue('');
    await sleep(450);
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(50);
    expect(wrapper.find('nav.dm-candidates__foot').exists()).toBe(true);
    expect(ticked(wrapper, 'host h001.example.com')).toBe(true);
    expect(button(wrapper, 'Dismiss (2)')).toBeDefined();
    wrapper.unmount();
  });

  it('says when a search reads only the first 5,000 candidates, on the page and in the export', async () => {
    server.list = pagesOf(numbered(5_300));
    const wrapper = await mountView();
    calls.length = 0;
    await wrapper.find('[data-test="dm-table-search"] input').setValue('example');
    await sleep(450);
    await flushPromises();
    expect(listed()).toHaveLength(26);
    const said = 'Searched among the first 5,000 candidates of this status: narrow the filters to search the others.';
    expect(wrapper.find('[data-test="discovery-search-cut"]').text()).toBe(said);
    const lines = await exportCsv(wrapper);
    expect(lines).toHaveLength(1 + 5_000 + 1);
    expect(lines.at(-1)).toBe(`"${said}",,,,,,,`);
    wrapper.unmount();
  });
  // A row's action leaves the ticked rows as they are (Onboard…, Offboard, Restore; Exclude… and Dismiss… above).
  it('keeps the ticked rows through a row\'s Onboard…, Offboard and Restore', async () => {
    const rows = numbered(4);
    Object.assign(rows[2]!, gcpRow(), { status: 'managed', workloadId: 'shop-bs', workload: { router: 'dmtr-dormeto-dev-europe-west2', workloadId: 'shop-bs', name: 'Shop' }, backend: { kind: 'instance', id: 'shop-vm' } },
      { id: 'c-2', conditions: 'host h002.example.com' });
    Object.assign(rows[3]!, { status: 'dismissed' });
    server.list = pagesOf(rows);
    const wrapper = await mountView();
    await box(wrapper, 'host h000.example.com').trigger('click');
    await box(wrapper, 'host h001.example.com').trigger('click');
    await nextTick();
    const kept = () => [ticked(wrapper, 'host h000.example.com'), ticked(wrapper, 'host h001.example.com'), Boolean(button(wrapper, 'Dismiss (2)'))];
    expect(kept()).toEqual([true, true, true]);
    // Onboard… from the first row: its dialog for that row, the operation for it.
    await choose(wrapper, 'host h000.example.com', 'Onboard…');
    const onboarding = wrapper.findComponent(OnboardDialog);
    expect(onboarding.props('title')).toBe('host h000.example.com');
    onboarding.vm.$emit('submit', { settings: {}, databases: [] });
    await flushPromises();
    expect(JSON.parse(calls.find((c) => c.path === '/operations')!.init!.body as string)).toMatchObject({ type: 'onboard', candidateId: 'c-0' });
    expect(kept()).toEqual([true, true, true]);
    // Offboard from the managed one, Restore from the dismissed one.
    await choose(wrapper, 'host h002.example.com', 'Offboard');
    expect(JSON.parse(calls.filter((c) => c.path === '/operations').at(-1)!.init!.body as string)).toMatchObject({ type: 'offboard', workloadId: 'shop-bs' });
    expect(kept()).toEqual([true, true, true]);
    await choose(wrapper, 'host h003.example.com', 'Restore');
    await flushPromises();
    expect(JSON.parse(calls.find((c) => c.path === '/discovery/restore')!.init!.body as string)).toEqual({ ids: ['c-3'] });
    expect(kept()).toEqual([true, true, true]);
    wrapper.unmount();
  });

  it('keeps what a row\'s dialog shows while it closes: its options, not the selection\'s', async () => {
    server.list = pagesOf(numbered(5));
    const wrapper = await mountView();
    await box(wrapper, 'host h000.example.com').trigger('click');
    await nextTick();
    await choose(wrapper, 'host h003.example.com', 'Exclude…');
    const dialog = document.querySelector('.v-dialog.v-overlay--active')!;
    expect(dialog.textContent).toContain('tg-3');
    dialogButton('Cancel').click();
    await nextTick();
    // Closing: still the row's, never the one ticked.
    expect(dialog.textContent).toContain('tg-3');
    expect(dialog.textContent).not.toContain('tg-0');
    await sleep(350);
    // The selection's own Exclude… then shows the one ticked.
    await button(wrapper, 'Exclude…')!.trigger('click');
    await flushPromises();
    expect(document.querySelector('.v-dialog.v-overlay--active')!.textContent).toContain('tg-0');
    wrapper.unmount();
  });

  it('stops a search\'s reading when the search is cleared or another list is read, and shows the cursor\'s page at once, without the loader', async () => {
    server.list = pagesOf(numbered(450));
    const wrapper = await mountView();
    let release!: () => void;
    server.later = new Promise<void>((r) => { release = r; });
    calls.length = 0;
    await wrapper.find('[data-test="dm-table-search"] input').setValue('h00');
    await sleep(450);
    await flushPromises();
    expect(listed()).toEqual([{ status: 'pending-onboarding', limit: '200' }]);
    expect((wrapper.findComponent(DmTable).props() as { loading: boolean }).loading).toBe(true);
    // Cleared while its first page is on its way: no loader over the page shown, and no second page asked once it answers.
    await wrapper.find('[data-test="dm-table-search"] input').setValue('');
    await sleep(450);
    await flushPromises();
    expect((wrapper.findComponent(DmTable).props() as { loading: boolean }).loading).toBe(false);
    release();
    delete server.later;
    await flushPromises();
    await sleep(20);
    await flushPromises();
    expect(listed().filter((q) => q.limit === '200')).toEqual([{ status: 'pending-onboarding', limit: '200' }]);
    expect(wrapper.findAll('tbody tr')).toHaveLength(50);
    expect(wrapper.find('nav.dm-candidates__foot').exists()).toBe(true);
    // Replaced by the reading of another list (a filter typed while searching): the first stops after its page, the second
    // reads to its end.
    server.later = new Promise<void>((r) => { release = r; });
    calls.length = 0;
    await wrapper.find('[data-test="dm-table-search"] input').setValue('h44');
    await sleep(450);
    await flushPromises();
    await wrapper.findAll('.dm-filter').find((f) => f.text().includes('Account or project'))!.find('input').setValue('111122223333');
    await sleep(450);
    await flushPromises();
    release();
    delete server.later;
    await flushPromises();
    await sleep(20);
    await flushPromises();
    expect(listed().filter((q) => q.limit === '200').map((q) => [q.account ?? '-', q.cursor ?? null])).toEqual([['-', null], ['111122223333', null], ['111122223333', '200'], ['111122223333', '400']]);
    expect(wrapper.findAll('tbody tr').map((r) => r.text().match(/host h\d+/)?.[0])).toEqual(Array.from({ length: 10 }, (_, i) => `host h44${i}`));
    wrapper.unmount();
  });

  it('refreshes a search\'s list quietly while an operation runs, every 30 s, never two readings at once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const rows = numbered(250);
      Object.assign(rows[0]!, { operation: { id: 'op-5', type: 'onboard' } });
      server.list = pagesOf(rows);
      const wrapper = await mountView();
      await wrapper.find('[data-test="dm-table-search"] input').setValue('h00');
      await sleep(450);
      await flushPromises();
      expect(wrapper.findAll('tbody tr')).toHaveLength(10);
      calls.length = 0;
      // Under a search, one tick in three: nothing at 10 s and 20 s.
      vi.advanceTimersByTime(20_000);
      await flushPromises();
      expect(listed()).toEqual([]);
      // At 30 s, a reading (its first page held), with no loader: the rows stay.
      let release!: () => void;
      server.later = new Promise<void>((r) => { release = r; });
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      expect(listed()).toEqual([{ status: 'pending-onboarding', limit: '200' }]);
      expect((wrapper.findComponent(DmTable).props() as { loading: boolean }).loading).toBe(false);
      expect(wrapper.findAll('tbody tr')).toHaveLength(10);
      // Longer than the interval: the ticks meanwhile start nothing.
      vi.advanceTimersByTime(60_000);
      await flushPromises();
      expect(listed()).toHaveLength(1);
      release();
      delete server.later;
      await flushPromises();
      await sleep(20);
      await flushPromises();
      expect(listed().map((q) => q.cursor ?? null)).toEqual([null, '200']);
      expect(wrapper.findAll('tbody tr')).toHaveLength(10);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  // The API takes 100 ids a request; a selection now spans pages and searches.
  it('dismisses more than 100 ticked rows by batches of 100, one request at a time; a batch refused says how many were done and keeps the others ticked', async () => {
    server.list = pagesOf(numbered(150));
    server.dismissals = 0;
    const wrapper = await mountView();
    const tickPage = async () => {
      await wrapper.find('thead input[type="checkbox"]').trigger('click');
      await nextTick();
    };
    await tickPage();
    await button(wrapper, 'Next')!.trigger('click');
    await flushPromises();
    await tickPage();
    await button(wrapper, 'Next')!.trigger('click');
    await flushPromises();
    await box(wrapper, 'host h100.example.com').trigger('click');
    await nextTick();
    await button(wrapper, 'Dismiss (101)')!.trigger('click');
    await flushPromises();
    dialogButton('Dismiss').click();
    await flushPromises();
    await sleep(20);
    await flushPromises();
    const sent = calls.filter((c) => c.path === '/discovery/dismiss').map((c) => (JSON.parse(c.init!.body as string).ids as string[]));
    expect(sent.map((ids) => ids.length)).toEqual([100, 1]);
    expect(new Set(sent.flat()).size).toBe(101);
    expect(toast()?.textContent).toContain('101 candidates dismissed.');
    wrapper.unmount();

    // The second batch refused: the first 100 done, said so, the last one still ticked.
    document.body.innerHTML = '';
    calls.length = 0;
    server.dismissals = 0;
    server.refuse = [2];
    const again = await mountView();
    for (const go of [true, true, false]) {
      await again.find('thead input[type="checkbox"]').trigger('click');
      await nextTick();
      if (go) {
        await button(again, 'Next')!.trigger('click');
        await flushPromises();
      }
    }
    expect(button(again, 'Dismiss (150)')).toBeDefined();
    await button(again, 'Dismiss (150)')!.trigger('click');
    await flushPromises();
    dialogButton('Dismiss').click();
    await flushPromises();
    await sleep(20);
    await flushPromises();
    expect(calls.filter((c) => c.path === '/discovery/dismiss')).toHaveLength(2);
    expect(toast()?.textContent).toContain('100 of 150 candidates dismissed, then: ids must be a list of 1 to 100 candidate IDs. The 50 others stay ticked.');
    expect(button(again, 'Dismiss (50)')).toBeDefined();
    delete server.refuse;
    again.unmount();
  });

  it('while a run it started is in progress, reads the run\'s state only, then the list once when it ends, quietly, the selection kept', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const at = '2026-10-07T06:00:00.000Z';
      let run = { startedAt: at, finishedAt: '2026-10-07T06:00:47.000Z', trigger: 'schedule', status: 'ok', mode: 'organization', targets: [], lint: [] };
      server.discovery = () => ({ lastRun: run, counts: { 'pending-onboarding': 70 } });
      server.list = pagesOf(numbered(70));
      const wrapper = await mountView();
      await wrapper.find('[data-test="dm-table-search"] input').setValue('h0');
      await sleep(450);
      await flushPromises();
      await box(wrapper, 'host h001.example.com').trigger('click');
      await nextTick();
      calls.length = 0;
      await button(wrapper, 'Run now')!.trigger('click');
      await flushPromises();
      run = { ...run, startedAt: '2026-10-07T07:00:00.000Z', status: 'running', trigger: 'manual' };
      // Running: three polls, the run's state only.
      for (let i = 0; i < 3; i += 1) {
        vi.advanceTimersByTime(5_000);
        await flushPromises();
      }
      expect(calls.map((c) => c.path)).toEqual(['/discovery/run', '/discovery', '/discovery', '/discovery']);
      // Ended: the list read once, without the loader, the row still ticked.
      run = { ...run, status: 'ok', finishedAt: '2026-10-07T07:00:50.000Z' };
      let release!: () => void;
      server.later = new Promise<void>((r) => { release = r; });
      vi.advanceTimersByTime(5_000);
      await flushPromises();
      expect((wrapper.findComponent(DmTable).props() as { loading: boolean }).loading).toBe(false);
      release();
      delete server.later;
      await flushPromises();
      await sleep(20);
      await flushPromises();
      vi.advanceTimersByTime(20_000);
      await flushPromises();
      expect(listed()).toEqual([{ status: 'pending-onboarding', limit: '200' }]);
      expect(ticked(wrapper, 'host h001.example.com')).toBe(true);
      expect(button(wrapper, 'Run now')!.attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    } finally {
      delete server.discovery;
      vi.useRealTimers();
    }
  });

  it('keeps the ticked rows when an operation it watched ends and the list is read again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const rows = numbered(5);
      Object.assign(rows[0]!, { operation: { id: 'op-5', type: 'onboard' } });
      server.list = pagesOf(rows);
      server.ended = { status: 'succeeded' };
      const wrapper = await mountView();
      await box(wrapper, 'host h001.example.com').trigger('click');
      await box(wrapper, 'host h002.example.com').trigger('click');
      await nextTick();
      // It ended, and h002 left the list.
      server.list = pagesOf([{ ...rows[0]!, operation: undefined, status: 'managed' }, rows[1]!, rows[3]!, rows[4]!]);
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      await sleep(50);
      await flushPromises();
      expect(toast()?.textContent).toContain('Onboarding of tg-0 succeeded.');
      expect(ticked(wrapper, 'host h001.example.com')).toBe(true);
      expect(button(wrapper, 'Dismiss (1)')).toBeDefined();
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it('says an exclusion expired or its lift incomplete by an icon alone, the word its name and its tooltip', async () => {
    const at = '2026-10-07T06:00:00.000Z';
    server.exclusions = [
      { id: 'x1', target: { kind: 'account', account: '111122223333', name: 'example' }, reason: 'migration', by: 'ops@example.com', at, expiresAt: '2026-10-08T06:00:00.000Z', expired: true },
      { id: 'x2', target: { kind: 'target-group', arn: 'arn:tg/shop', account: '111122223333', region: 'eu-west-3', name: 'shop' }, reason: 'freeze', by: 'ops@example.com', at, lifting: true, paused: [{ router: 'dmt-dev', workloadId: 'w1' }] },
    ];
    try {
      const wrapper = await mountView();
      const items = wrapper.findAll('#exclusions .v-list-item');
      const marks = items.map((i) => i.find('.v-list-item__append [data-test="status-mark"]'));
      expect(marks.map((m) => m.attributes('aria-label'))).toEqual(['expired', 'lift incomplete']);
      expect(marks.map((m) => m.attributes('tabindex'))).toEqual(['0', '0']);
      expect(items.map((i) => i.find('.v-list-item__append').text())).toEqual(['Lift', 'Retry lift']);
      expect(wrapper.find('#exclusions .v-chip').exists()).toBe(false);
      wrapper.unmount();
    } finally {
      delete server.exclusions;
    }
  });
});

