// A Google Cloud router's defaults (plan 5, M52): from 0.42.0 its level holds the idle signals, the custom metric in Google Cloud's
// shape; an organization's metric of the other cloud is not what its workloads inherit (the router ignores it).
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RouterDetails from '../src/components/RouterDetails.vue';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import { useSession } from '../src/stores/session';

const AWS_METRIC = { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 };
const DETAILS = {
  name: 'dmtr-dormeto-dev-europe-west1', cloud: 'gcp', region: 'europe-west1', account: 'dormeto-dev', router: { name: 'dmtr-dormeto-dev-europe-west1', version: '0.42.0', build: 'b' },
  configuration: { checkSchedule: { value: null, source: 'cli' }, ipLists: { value: [], source: 'cli' }, noWakeRules: { value: [], source: 'cli' }, metrics: { value: null, source: 'cli' } },
  pauses: [], workloads: { total: 5, byState: {}, paused: 0, lastActivityAt: null },
  health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null, lambda: {}, queues: {}, ipLists: [] },
  settings: { hibernate: null, defaults: { idleCpuPercent: 3 }, by: null, at: null }, managerSettings: { defaults: { idleMetric: AWS_METRIC, idleNetworkBytes: 2000 } },
};
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(DETAILS)) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

describe('a Google Cloud router\'s defaults', () => {
  it('hold the idle signals from 0.42.0, in Google Cloud\'s shape, an AWS metric of the organization not inherited', async () => {
    setActivePinia(createPinia());
    useSession().role = 'admin';
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
    const w = mount(RouterDetails, { props: { name: DETAILS.name, source: 'cli', version: '0.42.0' }, global: { plugins: [createVuetify({ components, directives }), router] } });
    await flushPromises();
    const dialog = w.findComponent(DefaultsDialog);
    expect(dialog.props('idle')).toBe(true);
    expect(dialog.props('cloud')).toBe('gcp');
    expect(dialog.props('inherited')).toMatchObject({ idleNetworkBytes: 'under 2,000 bytes a minute, organization', idleMetric: 'off; a Cloud SQL instance\'s connections under 1, built-in' });
    w.unmount();
  });

  it('hold none before 0.42.0', async () => {
    setActivePinia(createPinia());
    useSession().role = 'admin';
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
    const w = mount(RouterDetails, { props: { name: DETAILS.name, source: 'cli', version: '0.41.0' }, global: { plugins: [createVuetify({ components, directives }), router] } });
    await flushPromises();
    expect(w.findComponent(DefaultsDialog).props('idle')).toBe(false);
    w.unmount();
  });
});
