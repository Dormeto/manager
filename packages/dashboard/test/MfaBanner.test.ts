import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import MfaBanner from '../src/components/MfaBanner.vue';
import { useSession } from '../src/stores/session';

function mountBanner(me: Parameters<ReturnType<typeof useSession>['applyMe']>[0]) {
  setActivePinia(createPinia());
  useSession().applyMe(me);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  return mount(MfaBanner, { global: { plugins: [createVuetify({ components }), router] } });
}

describe('MfaBanner', () => {
  it('asks a user whose rights wait for MFA to set it up, linking to the Account page', () => {
    const wrapper = mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: true } });
    expect(wrapper.text()).toContain('Set up two-step verification to use your admin rights');
    expect(wrapper.find('a').attributes('href')).toBe('/account');
  });

  it('offers a passkey beside the authenticator app where passkeys are offered', () => {
    const wrapper = mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: true, passkeys: true } });
    expect(wrapper.text()).toContain('set up an authenticator app or add a passkey');
    expect(wrapper.find('a').attributes('href')).toBe('/account');
    expect(mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: true } }).text()).not.toContain('passkey');
  });

  it('follows the session, not the enrollment: a passkey session has its rights and no banner; a password session of an enrolled user is told', () => {
    expect(mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'admin', mfa: { mode: 'operators', enabled: false, required: true, method: 'passkey', passkeys: true } }).text()).toBe('');
    expect(mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: true, required: true, method: 'password', passkeys: true } }).text()).toContain('Sign out and sign in again');
  });

  it('tells an enrolled user on a session with fewer rights to sign in again; others to set it up', () => {
    const enrolled = mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: true, required: true, method: 'password', passkeys: true } });
    expect(enrolled.text()).toContain('Sign out and sign in again with your authenticator app or a passkey to use your rights');
    expect(enrolled.text()).not.toContain('set up an authenticator app');
    const notEnrolled = mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: true, passkeys: true } });
    expect(notEnrolled.text()).toContain('set up an authenticator app or add a passkey');
    expect(notEnrolled.text()).not.toContain('sign in again');
  });

  it('says nothing once MFA is on, or where the policy does not require it', () => {
    expect(mountBanner({ email: 'a@example.com', role: 'admin', effectiveRole: 'admin', mfa: { mode: 'operators', enabled: true, required: true } }).text()).toBe('');
    expect(mountBanner({ email: 'a@example.com', role: 'viewer', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: false } }).text()).toBe('');
  });

  it('review M5: says nothing before /api/me answered', () => {
    setActivePinia(createPinia());
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
    const session = useSession();
    session.role = 'admin';
    expect(mount(MfaBanner, { global: { plugins: [createVuetify({ components }), router] } }).text()).toBe('');
    expect(session.acting).toBe('admin');
  });
});
