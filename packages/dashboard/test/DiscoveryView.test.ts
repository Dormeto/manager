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
const server: { running: string | null; ended: { status: string; error?: string } } = { running: null, ended: { status: 'succeeded' } };
const candidate = () => ({
  id: 'c-1', status: 'pending-onboarding', statusReason: 'eligible', account: '111122223333', accountName: 'example', region: 'eu-west-3',
  conditions: 'host app.example.com', loadBalancer: 'web', loadBalancerArn: 'arn:lb/web', listener: 'HTTPS:443', priority: '10', rules: [], backend: null, idleHours7d: null,
  targetGroup: 'ligoj-ui-prod', targetGroupArn: 'arn:tg/ligoj-ui-prod', firstSeenAt: '2026-10-07T06:00:00.000Z',
  ...(server.running ? { operation: { id: server.running, type: 'onboard' } } : {}),
});
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/operations') {
      server.running = 'op-9';
      return { operation: { id: 'op-9' } };
    }
    if (path.startsWith('/operations/')) return { id: path.slice('/operations/'.length), type: 'onboard', ...server.ended };
    if (path === '/discovery') return { lastRun: null, counts: { 'pending-onboarding': 1 } };
    if (path === '/exclusions') return { exclusions: [] };
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

describe('Discovery view', () => {
  beforeEach(() => {
    calls.length = 0;
    server.running = null;
    server.ended = { status: 'succeeded' };
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
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
