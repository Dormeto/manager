import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import App from '../src/App.vue';
import { useSession } from '../src/stores/session';

vi.mock('../src/config', () => ({ getConfig: () => ({ env: 'dev' }) }));
vi.mock('../src/auth', () => ({ signOut: vi.fn() }));
const h = vi.hoisted(() => ({ calls: [] as string[], answers: {} as Record<string, unknown> }));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    h.calls.push(path);
    return h.answers[path] ?? {};
  }),
}));
afterEach(() => {
  h.calls.length = 0;
  h.answers = {};
  vi.useRealTimers();
});
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

// Signed in, on a desktop's width (the drawer beside the views).
async function mountSignedIn(me?: Parameters<ReturnType<typeof useSession>['applyMe']>[0]) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.email = 'ops@example.com';
  session.role = 'admin';
  if (me) session.applyMe(me);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
  await router.push('/');
  const wrapper = mount(App, { global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('App', () => {
  it('gives the views the whole width of the window, however wide', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null }, meta: { public: true } }] });
    await router.push('/');
    const wrapper = mount(App, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const container = wrapper.find('main .v-container');
    expect(container.classes()).toContain('v-container--fluid');
    expect(container.attributes('style') ?? '').not.toMatch(/max-width/);
    wrapper.unmount();
  });

  it('says the environment in the top bar on a desktop, as before the redesign (PR #1)', async () => {
    const wrapper = await mountSignedIn();
    expect(wrapper.find('.v-app-bar .v-chip').text()).toBe('dev');
    wrapper.unmount();
  });

  it('says the role in the drawer as the account menu does: under MFA required, acting as nothing, never viewer (PR #1)', async () => {
    const wrapper = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: null, mfa: { mode: 'required', enabled: false, required: true } });
    expect(wrapper.find('.dm-me__role').text()).toBe('Role: admin (acting as nothing)');
    wrapper.unmount();
    const allowed = await mountSignedIn({ email: 'ops@example.com', role: 'operator', effectiveRole: 'operator' });
    expect(allowed.find('.dm-me__role').text()).toBe('Role: operator');
    allowed.unmount();
  });

  it('offers the Update page to an administrator, after Audit, and not to an operator', async () => {
    const admin = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    const titles = admin.findAll('.dm-nav-item').map((i) => i.text());
    expect(titles).toContain('Update');
    expect(titles.indexOf('Update')).toBe(titles.indexOf('Audit') + 1);
    expect(admin.find('.dm-nav-icon--update').exists()).toBe(true);
    admin.unmount();
    const operator = await mountSignedIn({ email: 'ops@example.com', role: 'operator', effectiveRole: 'operator' });
    expect(operator.findAll('.dm-nav-item').map((i) => i.text())).not.toContain('Update');
    operator.unmount();
  });

  it('shows the versions available next to Update, to administrators, as Discovery shows its pending ones', async () => {
    h.answers['/update/available'] = { count: 2 };
    const admin = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    const item = admin.findAll('.dm-nav-item').find((i) => i.text().startsWith('Update'))!;
    expect(item.find('.v-badge').text()).toBe('2');
    expect(item.find('[aria-label="2 updates available"]').exists()).toBe(true);
    admin.unmount();
    h.answers['/update/available'] = { count: 1 };
    const one = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    expect(one.find('[aria-label="1 update available"]').exists()).toBe(true);
    one.unmount();
    h.answers['/update/available'] = { count: 0 };
    const none = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    expect(none.findAll('.dm-nav-item').find((i) => i.text().startsWith('Update'))!.find('.v-badge').exists()).toBe(false);
    none.unmount();
  });

  it('keeps Discovery\'s badge label its own', async () => {
    h.answers['/discovery'] = { lastRun: { counts: { 'pending-onboarding': 3 } } };
    const wrapper = await mountSignedIn({ email: 'ops@example.com', role: 'operator', effectiveRole: 'operator' });
    expect(wrapper.find('[aria-label="3 pending onboardings or offboardings"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('reads the versions available at sign-in and every 30 minutes, for administrators only', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reads = () => h.calls.filter((p) => p === '/update/available').length;
    const operator = await mountSignedIn({ email: 'ops@example.com', role: 'operator', effectiveRole: 'operator' });
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(reads()).toBe(0);
    operator.unmount();
    h.answers['/update/available'] = { count: 1 };
    const admin = await mountSignedIn({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(reads()).toBe(1);
    h.answers['/update/available'] = { count: 3 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(2);
    expect(admin.find('[aria-label="3 updates available"]').exists()).toBe(true);
    admin.unmount();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(reads()).toBe(2);
  });

  it('reads them once the role says administrator, when it arrives after the sign-in', async () => {
    const wrapper = await mountSignedIn({ email: 'ops@example.com', role: 'viewer', effectiveRole: 'viewer' });
    expect(h.calls).not.toContain('/update/available');
    useSession().applyMe({ email: 'ops@example.com', role: 'admin', effectiveRole: 'admin' });
    await flushPromises();
    expect(h.calls.filter((p) => p === '/update/available')).toHaveLength(1);
    wrapper.unmount();
  });

  it('says the manager version at the bottom of the sidebar, as /health answers', async () => {
    h.answers['/health'] = { status: 'ok', version: '0.12.0-dev.3' };
    const wrapper = await mountSignedIn();
    expect(wrapper.find('.dm-drawer .dm-version').text()).toBe('Dormeto manager 0.12.0-dev.3');
    expect(h.calls.filter((p) => p === '/health')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows no version while it is unknown or when /health fails', async () => {
    const { api } = await import('../src/api');
    vi.mocked(api).mockImplementation(async (path: string) => { if (path === '/health') throw new Error('down'); return {} as never; });
    const wrapper = await mountSignedIn();
    expect(wrapper.find('.dm-version').exists()).toBe(false);
    wrapper.unmount();
  });

  it('draws the brand mark as the website header logo (sun r 6, bold closed eyes, no stars)', async () => {
    const wrapper = await mountSignedIn();
    const logo = wrapper.find('.dm-brand svg');
    expect(logo.find('.dm-sun-core').attributes('r')).toBe('6');
    expect(logo.find('.dm-ray').attributes('d')).toBe('M52 3.3V1.1');
    expect(logo.find('.dm-eye-open').attributes('rx')).toBe('3');
    expect(logo.find('.dm-stars').exists()).toBe(false);
    expect(logo.find('.dm-glint').exists()).toBe(false);
    wrapper.unmount();
  });

  it('draws Operations as two meshing cogs, each its own element to turn', async () => {
    const wrapper = await mountSignedIn();
    const icon = wrapper.find('.dm-nav-icon--operations');
    expect(icon.find('.ni-cog-big').exists()).toBe(true);
    expect(icon.find('.ni-cog-small').exists()).toBe(true);
    expect(icon.find('.ni-gear').exists()).toBe(false);
    wrapper.unmount();
  });

  // R11: a member (no built-in role) sees workloads by their groups' grants only.
  it('shows a member Overview and Workloads only: no Routers, Discovery, Operations or administration (R11)', async () => {
    const member = await mountSignedIn({ email: 'dev@example.com', role: 'member', effectiveRole: 'member' });
    expect(member.findAll('.dm-nav-item').map((i) => i.text())).toEqual(['Overview', 'Workloads']);
    // The fleet's other reads are none of theirs: the API would refuse them.
    expect(h.calls).not.toContain('/discovery');
    member.unmount();
    const viewer = await mountSignedIn({ email: 'v@example.com', role: 'viewer', effectiveRole: 'viewer' });
    expect(viewer.findAll('.dm-nav-item').map((i) => i.text())).toEqual(['Overview', 'Workloads', 'Routers', 'Discovery', 'Operations']);
    viewer.unmount();
  });

  it('hides them again when /me says member after the sign-in', async () => {
    const wrapper = await mountSignedIn({ email: 'ops@example.com', role: 'operator', effectiveRole: 'operator' });
    expect(wrapper.findAll('.dm-nav-item').map((i) => i.text())).toContain('Routers');
    useSession().applyMe({ email: 'ops@example.com', role: 'member', effectiveRole: 'member' });
    await flushPromises();
    expect(wrapper.findAll('.dm-nav-item').map((i) => i.text())).toEqual(['Overview', 'Workloads']);
    wrapper.unmount();
  });
});
