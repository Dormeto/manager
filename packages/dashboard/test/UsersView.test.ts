import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import UsersView from '../src/views/UsersView.vue';
import { useSession } from '../src/stores/session';

const calls: [string, string][] = [];
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push([init?.method ?? 'GET', path]);
    if (path === '/users') {
      return { users: [
        { email: 'admin@example.com', role: 'admin', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true },
        { email: 'ops@example.com', role: 'operator', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true },
        { email: 'new@example.com', role: 'viewer', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: false },
        { email: 'odd@example.com', role: 'viewer', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: null },
      ] };
    }
    return { email: 'ops@example.com', mfa: false };
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

describe('Users', () => {
  it('shows who has two-step verification, and resets another user\'s after confirmation', async () => {
    setActivePinia(createPinia());
    useSession().email = 'admin@example.com';
    const wrapper = mount(UsersView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    const row = (email: string) => wrapper.findAll('tbody tr').find((r) => r.text().includes(email))!;
    expect(row('ops@example.com').text()).toContain('on');
    expect(row('new@example.com').text()).toContain('off');
    // Review M4: Cognito could not say.
    expect(row('odd@example.com').text()).toContain('unknown');
    await row('ops@example.com').find('button').trigger('click');
    await flushPromises();
    const reset = [...document.querySelectorAll('.v-list-item')].find((i) => i.textContent?.includes('Reset two-step verification')) as HTMLElement;
    reset.click();
    await flushPromises();
    expect(document.body.textContent).toContain('ops@example.com sets up an authenticator app again at their next sign-in');
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reset') as HTMLElement;
    confirm.click();
    await flushPromises();
    expect(calls).toContainEqual(['POST', '/users/ops%40example.com/mfa/reset']);
    wrapper.unmount();
  });
});
