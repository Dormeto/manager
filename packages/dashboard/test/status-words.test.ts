// Statuses as their icons alone (tables design §3), over every view as the demo shows it (npm run dev:mock): no status word
// in a mark's or a status chip's visible text. The word is the mark's name, its tooltip and the exports.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import type { Component } from 'vue';
import { useSession } from '../src/stores/session';
import AuditView from '../src/views/AuditView.vue';
import DiscoveryView from '../src/views/DiscoveryView.vue';
import OperationsView from '../src/views/OperationsView.vue';
import OverviewView from '../src/views/OverviewView.vue';
import RouterView from '../src/views/RouterView.vue';
import RoutersView from '../src/views/RoutersView.vue';
import UsersView from '../src/views/UsersView.vue';
import AccountView from '../src/views/AccountView.vue';
import SchedulesView from '../src/views/SchedulesView.vue';
import UpdateView from '../src/views/UpdateView.vue';
import WorkloadView from '../src/views/WorkloadView.vue';
import WorkloadsView from '../src/views/WorkloadsView.vue';

// The API answered by the demo's own (src/mock), without its network's delay.
vi.mock('../src/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/api')>();
  return { ...original, api: vi.fn(async (path: string, init?: RequestInit) => (await import('../src/mock')).mockApi(path, init)) };
});
// The user's own Cognito calls (Account) answered by the demo's too, signed in.
vi.mock('../src/cognito', () => ({ cognito: vi.fn(async (target: string, body: Record<string, unknown>) => (await import('../src/mock')).mockCognito(target, body)) }));
vi.mock('../src/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/auth')>()), accessToken: async () => 'demo', idToken: async () => 'demo' }));
vi.mock('../src/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config')>()), getConfig: () => ({ env: 'demo', authority: 'https://example.invalid', clientId: 'demo', authDomain: 'example.invalid', passkeys: true }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
window.matchMedia ??= ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => boolean, what: string) {
  for (const end = Date.now() + 5000; !test(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  await flushPromises();
}

// The words of the statuses the dashboard shows as icons: a workload's state, a pause, a router's health and status, an
// operation's and its steps', an audit result, a user's, a discovery candidate's and run's, a backend's, a build's.
const WORDS = [
  'awake', 'asleep', 'napping', 'waking', 'failed', 'unknown', 'paused', 'excluded', 'ok', 'warning', 'error', 'unreachable', 'not reporting', 'idle check late',
  'no health report', 'running', 'succeeded', 'done', 'skipped', 'pending', 'refused', 'confirmed', 'force change password', 'enabled', 'disabled', 'to onboard',
  'to offboard', 'managed', 'ineligible', 'dismissed', 'out of scope', 'gone', 'partial', 'stopped', 'in progress', 'in_progress', 'active', 'invited',
  'password reset', 'healthy', 'unhealthy', 'expired', 'lift incomplete',
];
const said = (text: string) => WORDS.find((w) => new RegExp(`(^|[^a-z-])${w.replace(/ /g, '[ _]')}($|[^a-z-])`, 'i').test(text));
// What a view shows with a status word where an icon should stand alone, as `<where>: "<text>"`.
function wordsShown(root: Element): string[] {
  const found: string[] = [];
  const text = (el: Element | ChildNode) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  // A mark (StatusMark, PauseChip, a health), a state chip: no text at all.
  for (const el of root.querySelectorAll('[data-test="status-mark"], [data-test="state-chip"]')) if (text(el)) found.push(`${el.getAttribute('data-test')} "${text(el)}"`);
  // Beside a mark, not its own word again ("[icon] Awake since" says it twice): the text next to a mark, against the words of
  // the marks of its parent (a pause mark may stand between the state and the sentence). Another fact may stand there (an
  // audit result's recorded text beside its outcome's mark).
  for (const el of root.querySelectorAll('[data-test="status-mark"], [data-test="state-chip"]')) {
    const mark = el.closest('.v-chip') ?? el;
    const parent = mark.parentElement;
    if (!parent) continue;
    const words = [...parent.querySelectorAll('[data-test="status-mark"], [data-test="state-chip"]')].map((m) => (m.getAttribute('aria-label') ?? '').toLowerCase()).filter(Boolean);
    for (const node of [mark.previousSibling, mark.nextSibling, mark.previousElementSibling, mark.nextElementSibling]) {
      if (!node || (node instanceof Element && node.matches('[data-test="status-mark"], [data-test="state-chip"], .v-chip, a, button'))) continue;
      const beside = text(node as Element).toLowerCase();
      if (words.some((w) => beside === w || beside.startsWith(`${w} `) || beside.endsWith(` ${w}`))) found.push(`beside ${el.getAttribute('aria-label')}: "${beside}"`);
    }
  }
  // The ×N chips: ×N only.
  for (const el of root.querySelectorAll('[data-test="state-count"], [data-test="paused-count"]')) if (!/^×\d+$/.test(text(el))) found.push(`${el.getAttribute('data-test')} "${text(el)}"`);
  // Any other chip saying a status by its word (the filters of a chip group and the closable ones aside: they choose a status,
  // they say none; a schedule window's kind, Awake or Nap, is a kind of window, not a state).
  for (const el of root.querySelectorAll('.v-chip')) {
    if (el.closest('.v-chip-group, [data-test="window"]') || el.querySelector('.v-chip__close') || el.matches('[data-test="state-chip"], [data-test="state-count"], [data-test="paused-count"]')) continue;
    const word = said(text(el));
    if (word && text(el).toLowerCase().replace(/_/g, ' ') === word.replace(/_/g, ' ')) found.push(`chip "${text(el)}"`);
  }
  return found;
}

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});
// `width`: the window's (a phone's: 390), which Vuetify reads as it starts.
async function show(view: Component, path: string, props: Record<string, unknown> = {}, width = 1280) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().applyMe({ email: 'admin@example.com', role: 'admin' });
  const stub = { render: () => null };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: stub }, { path: '/routers', component: stub }, { path: '/routers/:name', component: stub }, { path: '/workloads', component: stub },
    { path: '/workloads/:router/:id', component: stub }, { path: '/operations', component: stub }, { path: '/discovery', component: stub }, { path: '/discovery/settings', component: stub },
    { path: '/users', component: stub }, { path: '/audit', component: stub }, { path: '/schedules', component: stub }, { path: '/update', component: stub },
  ] });
  await router.push(path);
  wrapper = mount(view, { props, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  return wrapper;
}
// The whole page, the overlays' content aside (tooltips hold the words on purpose).
const page = () => document.body;

interface Listed { router: string; workloadId: string; state: string; pauses?: unknown[]; cloud?: string }
let listed: Listed[] = [];
let routerNames: string[] = [];
beforeAll(async () => {
  const { mockApi } = await import('../src/mock');
  listed = ((await mockApi('/workloads?limit=1000')) as { workloads: Listed[] }).workloads;
  routerNames = ((await mockApi('/routers')) as { routers: { name: string }[] }).routers.map((r) => r.name);
});

describe('statuses as their icons alone, over the demo', () => {
  it('the Overview', async () => {
    await show(OverviewView, '/');
    await until(() => document.querySelectorAll('[data-test="routers-card"] .v-list-item').length > 0, 'the routers card');
    expect(wordsShown(page())).toEqual([]);
  });

  it('Routers, with the IP lists', async () => {
    await show(RoutersView, '/routers');
    await until(() => document.querySelectorAll('.dm-routers [data-test="health-mark"]').length === routerNames.length, 'the routers');
    await until(() => document.querySelectorAll('[data-test="ip-lists"] [data-test="status-mark"], .dm-iplists [data-test="status-mark"]').length > 0, 'the IP lists');
    expect(wordsShown(page())).toEqual([]);
  });

  it('each router\'s page', async () => {
    for (const name of routerNames) {
      await show(RouterView, `/routers/${name}`, { name });
      await until(() => Boolean(document.querySelector('.dm-hero [data-test="health-mark"]')), name);
      expect(wordsShown(page()), name).toEqual([]);
      wrapper!.unmount();
      wrapper = undefined;
      document.body.innerHTML = '';
    }
  });

  it('Workloads', async () => {
    await show(WorkloadsView, '/workloads');
    await until(() => document.querySelectorAll('[data-test="state-chip"]').length > 0, 'the workloads');
    expect(wordsShown(page())).toEqual([]);
  });

  it('a workload\'s page: one of each state, a paused one, a Google Cloud one', async () => {
    const picked = new Map<string, Listed>();
    for (const w of listed) {
      if (!picked.has(w.state)) picked.set(w.state, w);
      if (w.pauses?.length && !picked.has('paused')) picked.set('paused', w);
      if (w.cloud === 'gcp' && !picked.has('gcp')) picked.set('gcp', w);
    }
    expect([...picked.keys()]).toEqual(expect.arrayContaining(['ASLEEP', 'AWAKE', 'FAILED', 'paused', 'gcp']));
    for (const w of picked.values()) {
      await show(WorkloadView, `/workloads/${w.router}/${w.workloadId}`, { router: w.router, id: w.workloadId });
      await until(() => Boolean(document.querySelector('[data-test="header"] [data-test="state-chip"]')), w.workloadId);
      await until(() => document.querySelectorAll('[data-test="backend"]').length > 0, `${w.workloadId}'s backends`);
      expect(wordsShown(page()), w.workloadId).toEqual([]);
      wrapper!.unmount();
      wrapper = undefined;
      document.body.innerHTML = '';
    }
  });

  it('Discovery, each status of its tabs, and its last run', async () => {
    await show(DiscoveryView, '/discovery');
    await until(() => document.querySelectorAll('.dm-candidates tbody [data-test="status-mark"]').length > 0, 'the candidates');
    expect(wordsShown(page())).toEqual([]);
    const tabs = () => [...document.querySelectorAll<HTMLElement>('.dm-candidates__tabs .v-chip')];
    for (let i = 1; i < tabs().length; i += 1) {
      // The tab's status (its count aside), then its candidates shown: each row's mark named by it.
      const label = tabs()[i]!.textContent!.replace(/\d+\s*$/, '').trim();
      tabs()[i]!.click();
      const marks = () => [...document.querySelectorAll('.dm-candidates tbody [data-test="status-mark"]')].map((m) => m.getAttribute('aria-label'));
      await until(() => !document.querySelector('.dm-candidates .v-data-table-rows-loading') && marks().length > 0 && marks().every((m) => m === label), label);
      expect(wordsShown(page()), label).toEqual([]);
    }
  }, 30_000);

  it('Operations, every row opened', async () => {
    await show(OperationsView, '/operations');
    await until(() => document.querySelectorAll('.dm-operations [data-test="dm-row-expand"]').length > 0, 'the operations');
    for (const toggle of document.querySelectorAll<HTMLElement>('.dm-operations [data-test="dm-row-expand"]')) toggle.click();
    await flushPromises();
    expect(document.querySelectorAll('.dm-step').length).toBeGreaterThan(0);
    expect(wordsShown(page())).toEqual([]);
  });

  it('Users and Audit', async () => {
    await show(UsersView, '/users');
    await until(() => document.querySelectorAll('[data-test="status-mark"]').length > 0, 'the users');
    expect(wordsShown(page())).toEqual([]);
    wrapper!.unmount();
    wrapper = undefined;
    document.body.innerHTML = '';
    await show(AuditView, '/audit');
    await until(() => document.querySelectorAll('[data-test="audit-result"]').length > 0, 'the audit');
    expect(wordsShown(page())).toEqual([]);
  });
  it('Update, Schedules and the account', async () => {
    for (const [view, path, ready] of [[UpdateView, '/update', '.v-card'], [SchedulesView, '/schedules', '.fc'], [AccountView, '/account', '.v-card']] as const) {
      await show(view, path);
      await until(() => Boolean(document.querySelector(ready)), path);
      await sleep(600);
      await flushPromises();
      expect(wordsShown(page()), path).toEqual([]);
      wrapper!.unmount();
      wrapper = undefined;
      document.body.innerHTML = '';
    }
  }, 30_000);

  it('a phone\'s width: the tables as stacked rows', async () => {
    try {
      for (const [view, path, ready] of [[RoutersView, '/routers', '.dm-routers [data-test="health-mark"]'], [WorkloadsView, '/workloads', '[data-test="state-chip"]'],
        [DiscoveryView, '/discovery', '.dm-candidates tbody [data-test="status-mark"]'], [OperationsView, '/operations', '.dm-operations [data-test="status-mark"]'],
        [UsersView, '/users', '[data-test="status-mark"]']] as const) {
        await show(view, path, {}, 390);
        await until(() => Boolean(document.querySelector(ready)), path);
        expect(document.querySelector('.v-data-table__tr--mobile'), path).not.toBeNull();
        expect(wordsShown(page()), path).toEqual([]);
        wrapper!.unmount();
        wrapper = undefined;
        document.body.innerHTML = '';
      }
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    }
  }, 30_000);
});
