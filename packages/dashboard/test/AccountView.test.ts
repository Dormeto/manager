import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import AccountView from '../src/views/AccountView.vue';
import { useSession } from '../src/stores/session';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const calls: [string, Record<string, unknown>][] = [];
const me: { value: Record<string, unknown> } = { value: {} };
let refreshed = 0;
vi.mock('../src/cognito', () => ({
  cognito: vi.fn(async (target: string, body: Record<string, unknown>) => {
    calls.push([target, body]);
    if (target === 'AssociateSoftwareToken') return { SecretCode: 'JBSWY3DPEHPK3PXP' };
    if (target === 'VerifySoftwareToken' && body.UserCode !== '123456') throw new Error('Invalid code received for user');
    return {};
  }),
}));
vi.mock('../src/auth', () => ({ accessToken: async () => 'access-token' }));
vi.mock('../src/config', () => ({ getConfig: () => ({ env: 'dev' }) }));
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => { if (path === '/me?fresh=1') refreshed += 1; return me.value; }) }));

async function mountView(mode: 'optional' | 'operators' | 'required', enabled: boolean, role = 'admin') {
  setActivePinia(createPinia());
  me.value = { email: 'ops@example.com', groups: [`dmt-${role}`], role, effectiveRole: enabled ? role : 'viewer', mfa: { mode, enabled, required: mode !== 'optional' } };
  const session = useSession();
  session.applyMe(me.value as never);
  const wrapper = mount(AccountView, { global: { plugins: [createVuetify({ components })] } });
  await flushPromises();
  return wrapper;
}
const button = (wrapper: Awaited<ReturnType<typeof mountView>>, text: string) => wrapper.findAll('button').find((b) => b.text().includes(text))!;

beforeEach(() => { calls.length = 0; refreshed = 0; });

describe('Account', () => {
  it('sets up an authenticator app: secret and QR code, a code verified, TOTP preferred, rights read again', async () => {
    const wrapper = await mountView('operators', false);
    expect(wrapper.text()).toContain('Two-step verification is off: your admin rights wait for it');
    await button(wrapper, 'Set up an authenticator app').trigger('click');
    await flushPromises();
    expect(calls[0]).toEqual(['AssociateSoftwareToken', { AccessToken: 'access-token' }]);
    expect(wrapper.text()).toContain('JBSW Y3DP EHPK 3PXP');
    expect(wrapper.find('img[alt="QR code of the authenticator secret"]').attributes('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    me.value = { ...me.value, effectiveRole: 'admin', mfa: { mode: 'operators', enabled: true, required: true } };
    await wrapper.find('input').setValue('123456');
    await button(wrapper, 'Verify').trigger('click');
    await flushPromises();
    expect(calls.slice(1)).toEqual([
      ['VerifySoftwareToken', { AccessToken: 'access-token', UserCode: '123456', FriendlyDeviceName: 'Dormeto dev' }],
      ['SetUserMFAPreference', { AccessToken: 'access-token', SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }],
    ]);
    expect(refreshed).toBe(1);
    expect(useSession().effectiveRole).toBe('admin');
    expect(wrapper.text()).toContain('Two-step verification is on');
  });

  it('says a wrong code, and lets the user try again', async () => {
    const wrapper = await mountView('operators', false);
    await button(wrapper, 'Set up an authenticator app').trigger('click');
    await flushPromises();
    await wrapper.find('input').setValue('000000');
    await button(wrapper, 'Verify').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Invalid code received for user');
    expect(calls.map(([t]) => t)).toEqual(['AssociateSoftwareToken', 'VerifySoftwareToken']);
  });

  it('turns MFA off only where the policy is optional', async () => {
    const optional = await mountView('optional', true);
    await button(optional, 'Turn off').trigger('click');
    await flushPromises();
    expect(calls).toEqual([['SetUserMFAPreference', { AccessToken: 'access-token', SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }]]);
    const operators = await mountView('operators', true);
    expect(button(operators, 'Turn off')).toBeUndefined();
  });
});
