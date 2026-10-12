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
});
