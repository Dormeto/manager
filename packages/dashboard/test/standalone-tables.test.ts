// The two kinds of workloads in the tables (vision standalone workloads design §6): Workloads and Discovery mark a standalone
// row and filter on the kind (the API's `kind`), a standalone candidate is said by its resource; the perimeter's standalone
// scan is a switch; a criterion takes the resources' kinds.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadsView from '../src/views/WorkloadsView.vue';
import DiscoveryView from '../src/views/DiscoveryView.vue';
import DiscoverySettingsView from '../src/views/DiscoverySettingsView.vue';
import { useSession } from '../src/stores/session';
import { setDimension, dimensionOf } from '../src/discovery';
import { kindOf, KINDS } from '../src/kinds';

const ARN = 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0abc';
const HTTP_ROW = { router: 'dmt-dev', workloadId: 'web', name: 'Web', account: '111122223333', state: 'AWAKE', url: 'https://web.example.com', awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null, pendingWake: false, stats7d: null, settings: {} };
const STANDALONE_ROW = { router: 'dmt-dev', workloadId: 'sa', name: 'Build agent', kind: 'standalone', resourceArn: ARN, account: '111122223333', state: 'ASLEEP', awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null, pendingWake: false, stats7d: { wakes: 1 }, settings: {}, backends: ['instance'] };
const HTTP_CANDIDATE = {
  id: 'arn:tg/web', status: 'pending-onboarding', statusReason: 'eligible', account: '111122223333', accountName: 'example', region: 'eu-west-1', conditions: 'host web.example.com',
  loadBalancer: 'web', listener: 'HTTPS:443', priority: '10', rules: [], backend: { kind: 'instance', id: 'i-1' }, idleHours7d: null, targetGroup: 'web', targetGroupArn: 'arn:tg/web', firstSeenAt: '2026-11-21T06:00:00.000Z', tags: {}, history: [],
};
const STANDALONE_CANDIDATE = {
  kind: 'standalone', id: ARN, resourceArn: ARN, name: 'build-agent', status: 'pending-onboarding', statusReason: 'eligible', account: '111122223333', accountName: 'example', region: 'eu-west-1',
  backend: { kind: 'instance', id: 'i-0abc', arn: ARN }, idleHours7d: 140, firstSeenAt: '2026-11-21T06:00:00.000Z', tags: {}, history: [],
};
const paths: string[] = [];
const puts: unknown[] = [];
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    paths.push(path);
    if (path === '/workloads/states') return null;
    if (path.startsWith('/workloads?')) return { workloads: [HTTP_ROW, STANDALONE_ROW], total: 2, errors: [] };
    if (path === '/discovery') return { lastRun: null, counts: { 'pending-onboarding': 2 } };
    if (path === '/exclusions') return { exclusions: [] };
    if (path.startsWith('/discovery/access')) return null;
    if (path.startsWith('/discovery/candidates?')) return { candidates: [HTTP_CANDIDATE, STANDALONE_CANDIDATE], cursor: null };
    if (path === '/discovery/config' && init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return { config: JSON.parse(String(init.body)), lint: [] }; }
    if (path === '/discovery/config') return { config: { version: 1, mode: 'account', regions: ['*'], refreshHours: 24, globalExcludes: [], filters: [] }, lint: [], updatedAt: null, updatedBy: null };
    if (path === '/discovery/google') return { connection: null };
    return {};
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountAt(path: string, component: object) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = 'admin';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: path.split('?')[0]!, component }, { path: '/:rest(.*)', component: { render: () => null } }] });
  await router.push(path);
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('the kinds', () => {
  it('are HTTP when a row says none, standalone when it says so, each with its icon and words', () => {
    expect([kindOf({}), kindOf({ kind: 'standalone' }), kindOf({ kind: 'other' })]).toEqual(['http', 'standalone', 'http']);
    expect(KINDS.map((k) => [k.value, k.title])).toEqual([['http', 'HTTP workload'], ['standalone', 'Standalone workload']]);
    expect(KINDS.every((k) => k.icon.startsWith('M'))).toBe(true);
  });
});

describe('Workloads with both kinds', () => {
  it('marks a standalone workload in its name\'s cell, an HTTP one not, and shows no URL for it', async () => {
    const w = await mountAt('/workloads', WorkloadsView);
    const [web, sa] = w.findAll('tbody tr');
    expect(sa!.find('[data-test="kind-mark"]').attributes('aria-label')).toBe('Standalone workload');
    expect(web!.find('[data-test="kind-mark"]').exists()).toBe(false);
    expect(sa!.find('a.dm-url').exists()).toBe(false);
    w.unmount();
  });

  it('filters on the kind through the API', async () => {
    const w = await mountAt('/workloads?kind=standalone', WorkloadsView);
    const last = paths.filter((p) => p.startsWith('/workloads?')).at(-1)!;
    expect(new URLSearchParams(last.split('?')[1]).get('kind')).toBe('standalone');
    expect(w.find('[data-test="kind-filter"]').exists()).toBe(true);
    w.unmount();
  });
});

describe('Discovery with both kinds', () => {
  it('says a standalone candidate by its name and resource, marked, its rule cell without load balancer', async () => {
    const w = await mountAt('/discovery', DiscoveryView);
    const row = w.findAll('tbody tr').find((tr) => tr.text().includes('build-agent'))!;
    expect(row.find('[data-test="kind-mark"]').attributes('aria-label')).toBe('Standalone workload');
    expect(row.find('[data-test="standalone-resource"]').text()).toBe('EC2 instance i-0abc');
    expect(row.text()).not.toContain('priority');
    const http = w.findAll('tbody tr').find((tr) => tr.text().includes('host web.example.com'))!;
    expect(http.find('[data-test="kind-mark"]').exists()).toBe(false);
    w.unmount();
  });

  it('filters on the kind through the API', async () => {
    const w = await mountAt('/discovery?kind=standalone', DiscoveryView);
    const last = paths.filter((p) => p.startsWith('/discovery/candidates?')).at(-1)!;
    expect(new URLSearchParams(last.split('?')[1]).get('kind')).toBe('standalone');
    w.unmount();
  });
});

describe('The perimeter\'s standalone scan', () => {
  it('is a switch, off when the perimeter says none, saved as on or off', async () => {
    const w = await mountAt('/discovery/settings', DiscoverySettingsView);
    const toggle = w.find('[data-test="standalone-switch"] input');
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    await toggle.setValue(true);
    await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click');
    await flushPromises();
    expect((puts.at(-1) as { standalone?: string }).standalone).toBe('on');
    await sleep(0);
    w.unmount();
  });

  it('takes the databases\' kinds in a backend type criterion', () => {
    expect(setDimension({}, 'backendKinds', 'instance, rds-instance, rds-cluster, lambda').backendKinds).toEqual(['instance', 'rds-instance', 'rds-cluster']);
    expect(dimensionOf('backendKinds').hint).toBe('instance, asg, ecs, k8s; for standalone resources also rds-instance, rds-cluster');
  });
});
