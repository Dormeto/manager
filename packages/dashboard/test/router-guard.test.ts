import { describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Review M10: a user the MFA policy allows nothing (required, no authenticator) is sent to the Account page.
const me: { value: Record<string, unknown> } = { value: {} };
vi.mock('../src/api', () => ({ api: vi.fn(async () => me.value) }));
vi.mock('../src/auth', () => ({
  currentUser: async () => ({ expired: false, profile: { email: 'a@example.com', 'cognito:groups': ['dmt-admin'] } }),
  signIn: vi.fn(),
  roleOf: () => 'admin',
}));
vi.mock('../src/stores/preferences', () => ({ usePreferences: () => ({ load: async () => {} }) }));

describe('router guard', () => {
  it('sends a user with no rights until MFA to the Account page, and lets one with rights through', async () => {
    setActivePinia(createPinia());
    me.value = { email: 'a@example.com', role: 'admin', effectiveRole: null, mfa: { mode: 'required', enabled: false, required: true } };
    const { router } = await import('../src/router');
    await router.push('/routers');
    expect(router.currentRoute.value.path).toBe('/account');
  });

  // R11: the fleet's pages are none of a member's; their own are open.
  it('sends a member away from Routers, Discovery and Operations, and lets them into Workloads', async () => {
    setActivePinia(createPinia());
    me.value = { email: 'a@example.com', role: 'member', effectiveRole: 'member', groups: ['payments'], grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake'] }] };
    const { router } = await import('../src/router');
    for (const path of ['/routers', '/routers/dmt-dev', '/discovery', '/operations', '/users']) {
      await router.push(path);
      expect(router.currentRoute.value.path, path).toBe('/');
    }
    await router.push('/workloads');
    expect(router.currentRoute.value.path).toBe('/workloads');
    await router.push('/workloads/dmt-dev/abc');
    expect(router.currentRoute.value.path).toBe('/workloads/dmt-dev/abc');
  });

  // The user, 2026-11-02: in the demo, Operations and Users could not be clicked. The dev server rebuilt its dependencies on their
  // first visit and their code could not be fetched; a release that replaced the files of an open page does the same.
  it('loads the page in full, once, when its code cannot be fetched; another error is not a reload', async () => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    me.value = { email: 'a@example.com', role: 'admin', effectiveRole: 'admin' };
    const { router, navigation } = await import('../src/router');
    const load = vi.spyOn(navigation, 'load').mockImplementation(() => {});
    router.addRoute({ path: '/stale', component: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://localhost:5173/src/views/StaleView.vue')) });
    router.addRoute({ path: '/broken', component: () => Promise.reject(new Error('boom')) });
    await router.push('/stale').catch(() => {});
    expect(load).toHaveBeenCalledWith('/stale');
    // Loaded in full, it fails again: no second load, no loop.
    await router.push('/stale').catch(() => {});
    expect(load).toHaveBeenCalledTimes(1);
    await router.push('/broken').catch(() => {});
    expect(load).toHaveBeenCalledTimes(1);
    // A page reached forgets it: its code failing later is loaded in full again.
    await router.push('/workloads');
    await router.push('/stale').catch(() => {});
    expect(load).toHaveBeenCalledTimes(2);
  });
});
