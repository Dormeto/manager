// Discovery settings: the perimeter's form, and the Google Cloud connection read-only under it (written by `dormeto gcp connect`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DiscoverySettingsView from '../src/views/DiscoverySettingsView.vue';
import { useSession } from '../src/stores/session';
// The API's own answers, as its test checks them (packages/api/test/api.test.ts).
import { GOOGLE_ANSWER, NO_GOOGLE_ANSWER } from '../../api/test/google-connection';

const CONFIG = { mode: 'account', regions: ['*'], refreshHours: 24, excludes: [], filters: [], eventRefresh: { enabled: false } };
const CONNECTION = {
  project: 'dormeto-dev', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws-121014831971', scopes: ['projects/dormeto-dev', 'folders/42'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-dev.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-dev.iam.gserviceaccount.com' },
  routers: [{ project: 'dormeto-dev', region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', version: '0.40.0' }],
  googleAdded: ['monitoring.googleapis.com'], connectedAt: new Date(Date.now() - 3_600_000).toISOString(), connectedBy: 'fab@example.com', cli: '0.14.0',
};
// What GET /discovery/google answers: { connection }, null when there is none; `answer` in its place when set.
let connection: typeof CONNECTION | null = CONNECTION;
let answer: unknown;
let failure = '';
const calls: string[] = [];
vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>();
  return {
    ...original,
    api: vi.fn(async (path: string) => {
      calls.push(path);
      if (path === '/discovery/config') return { config: structuredClone(CONFIG), lint: [], updatedAt: null, updatedBy: null };
      if (path === '/discovery/google') {
        if (failure) throw new original.ApiError(500, failure);
        return structuredClone(answer ?? { connection });
      }
      return {};
    }),
  };
});
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = 'admin';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/discovery/settings', component: DiscoverySettingsView }, { path: '/discovery', component: { render: () => null } }] });
  await router.push('/discovery/settings');
  const wrapper = mount(DiscoverySettingsView, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('Discovery settings: the Google Cloud connection', () => {
  beforeEach(() => { connection = CONNECTION; answer = undefined; failure = ''; calls.length = 0; });

  it('reads the API\'s own answer (its test\'s fixture): the connection under connection, its routers with or without a controller', async () => {
    answer = GOOGLE_ANSWER;
    const wrapper = await mountView();
    const text = wrapper.find('[data-test="google-connection"]').text();
    const c = GOOGLE_ANSWER.connection;
    for (const shown of [c.project, c.projectNumber, ...c.scopes, c.serviceAccounts.discovery, c.serviceAccounts.command, c.pool, c.provider, c.connectedBy, c.cli]) expect(text).toContain(shown);
    expect(text).toContain('europe-west2 · 0.40.0');
    expect(text).toContain('us-central1');
    expect(text).not.toContain('No Google Cloud connection');
    wrapper.unmount();
    answer = NO_GOOGLE_ANSWER;
    const none = await mountView();
    expect(none.find('[data-test="google-connection"]').text()).toContain('No Google Cloud connection');
    none.unmount();
  });

  it('shows the host project, the scopes, the two service accounts, the routers, and who connected and when, read-only', async () => {
    const wrapper = await mountView();
    const card = wrapper.find('[data-test="google-connection"]');
    const text = card.text();
    expect(text).toContain('Google Cloud connection');
    expect(text).toContain('dormeto-dev');
    expect(text).toContain('projects/dormeto-dev');
    expect(text).toContain('folders/42');
    expect(text).toContain('dmt-dev-discovery@dormeto-dev.iam.gserviceaccount.com');
    expect(text).toContain('dmt-dev-command@dormeto-dev.iam.gserviceaccount.com');
    expect(text).toContain('europe-west2');
    expect(text).toContain('0.40.0');
    expect(text).toMatch(/Connected 1 h ago by fab@example.com/);
    expect(card.find('input, button').exists()).toBe(false);
    expect(calls).toContain('/discovery/google');
    wrapper.unmount();
  });

  it('names the commands that add a router when the connection has none yet', async () => {
    connection = { ...CONNECTION, routers: [] };
    const wrapper = await mountView();
    expect(wrapper.find('[data-test="google-connection"]').text()).toContain('none yet: dormeto gcp routers install, then dormeto gcp connect again');
    wrapper.unmount();
  });

  it('says there is none, and names the command that connects one', async () => {
    connection = null;
    const wrapper = await mountView();
    const card = wrapper.find('[data-test="google-connection"]');
    expect(card.text()).toContain('No Google Cloud connection');
    expect(card.text()).toContain('dormeto gcp connect');
    // The perimeter's form is still there.
    expect(wrapper.text()).toContain('Global excludes');
    wrapper.unmount();
  });

  it('says why when the connection cannot be read, rather than that there is none', async () => {
    failure = 'the store did not answer';
    const wrapper = await mountView();
    const card = wrapper.find('[data-test="google-connection"]');
    expect(card.text()).toContain('the store did not answer');
    expect(card.text()).not.toContain('No Google Cloud connection');
    wrapper.unmount();
  });
});

describe('Discovery settings: the perimeter\'s regions', () => {
  beforeEach(() => { connection = CONNECTION; answer = undefined; failure = ''; calls.length = 0; });

  it('names a region of each cloud and Google Cloud\'s global, and says every region enabled in each account or project', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('Every region enabled in each account or project');
    await wrapper.find('input[type="checkbox"]').setValue(false);
    await flushPromises();
    expect(wrapper.text()).toContain('eu-west-1');
    expect(wrapper.text()).toContain('europe-west2');
    expect(wrapper.text()).toContain('global');
    wrapper.unmount();
  });
});
