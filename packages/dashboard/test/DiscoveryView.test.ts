import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DiscoveryView from '../src/views/DiscoveryView.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import { useSession } from '../src/stores/session';

const calls: { path: string; init?: RequestInit }[] = [];
// The server's side: the onboarding running on the candidate (named by the candidates while it runs) and how it ended.
const server: { running: string | null; ended: { status: string; error?: string }; backend?: unknown; routers?: unknown[]; routersLater?: Promise<void>; tags?: Record<string, string[]>; row?: Record<string, unknown> } = { running: null, ended: { status: 'succeeded' } };
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
    if (path === '/discovery') return { lastRun: null, counts: { 'pending-onboarding': 1 } };
    if (path === '/exclusions') return { exclusions: [] };
    if (path === '/routers' && server.routersLater) await server.routersLater;
    if (path === '/routers' && server.routers) return { routers: server.routers };
    if (path === '/routers') return { routers: [{ name: 'dmtr-dev-eu-west-3', account: '111122223333', region: 'eu-west-3', clusters: [CHECK] }] };
    if (path.startsWith('/discovery/candidates?')) return { candidates: [candidate()], cursor: null };
    throw new Error(`unexpected ${path}`);
  }),
}));

// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = 'admin';
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

  it('shows its backend service and URL map by name, linked to the Google Cloud console, in `global`, with its idle share said estimated', async () => {
    const wrapper = await mountView();
    const row = wrapper.findAll('tr').find((tr) => tr.text().includes('host shop.example.com'))!;
    expect(row.text()).toContain('shop-bs');
    expect(row.text()).toContain('shop-lb');
    expect(row.text()).toContain('global');
    expect(row.text()).toContain('estimated');
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
