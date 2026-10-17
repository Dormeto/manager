import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import App from '../src/App.vue';
import { useSession } from '../src/stores/session';

vi.mock('../src/config', () => ({ getConfig: () => ({ env: 'dev' }) }));
vi.mock('../src/auth', () => ({ signOut: vi.fn() }));
vi.mock('../src/api', () => ({ api: vi.fn(async () => ({})) }));
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
});
