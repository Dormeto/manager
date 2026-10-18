import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import AccountView from '../src/views/AccountView.vue';
import { useSession } from '../src/stores/session';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const calls: [string, Record<string, unknown>][] = [];
const me: { value: Record<string, unknown> } = { value: {} };
const scopeless = { value: false };
const credentials: { value: Record<string, unknown>[] } = { value: [] };
let refreshed = 0;
vi.mock('../src/cognito', () => ({
  cognito: vi.fn(async (target: string, body: Record<string, unknown>) => {
    calls.push([target, body]);
    if (target === 'AssociateSoftwareToken' && scopeless.value) throw new Error('Access Token does not have required scopes');
    if (target === 'AssociateSoftwareToken') return { SecretCode: 'JBSWY3DPEHPK3PXP' };
    if (target === 'ListWebAuthnCredentials') return { Credentials: credentials.value };
    if (target === 'DeleteWebAuthnCredential') { credentials.value = credentials.value.filter((c) => c.CredentialId !== body.CredentialId); return {}; }
    if (target === 'VerifySoftwareToken' && body.UserCode !== '123456') throw new Error('Invalid code received for user');
    return {};
  }),
}));
vi.mock('../src/auth', () => ({ accessToken: async () => 'access-token' }));
vi.mock('../src/config', () => ({ getConfig: () => ({ env: 'dev', clientId: 'client-1', authDomain: 'auth.example.com' }) }));
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => { if (path === '/me?fresh=1') refreshed += 1; return me.value; }) }));

async function mountView(mode: 'optional' | 'operators' | 'required', enabled: boolean, role = 'admin', extra: Record<string, unknown> = {}) {
  setActivePinia(createPinia());
  me.value = { email: 'ops@example.com', groups: [`dmt-${role}`], role, effectiveRole: enabled ? role : 'viewer', mfa: { mode, enabled, required: mode !== 'optional', ...extra } };
  const session = useSession();
  session.applyMe(me.value as never);
  const wrapper = mount(AccountView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
  await flushPromises();
  return wrapper;
}
const button = (wrapper: Awaited<ReturnType<typeof mountView>>, text: string) => wrapper.findAll('button').find((b) => b.text().includes(text))!;

beforeEach(() => { credentials.value = []; document.body.innerHTML = ''; calls.length = 0; refreshed = 0; scopeless.value = false; });

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
    expect(refreshed).toBe(2);
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

  it('review M9: a session opened before two-step verification existed is told to sign in again', async () => {
    scopeless.value = true;
    const wrapper = await mountView('operators', false);
    await button(wrapper, 'Set up an authenticator app').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Your session predates two-step verification: sign out, sign in again, then set it up.');
  });

  it('reads the MFA fresh when it opens (the API caches it: a reset elsewhere shows at once)', async () => {
    await mountView('operators', false);
    expect(refreshed).toBe(1);
  });
});

describe('Account, passkeys', () => {
  const laptop = { CredentialId: 'cred-1', FriendlyCredentialName: 'MacBook', AuthenticatorAttachment: 'platform', CreatedAt: 1760000000 };
  const key = { CredentialId: 'cred-2', FriendlyCredentialName: 'YubiKey 5', AuthenticatorAttachment: 'cross-platform', CreatedAt: 1761000000 };

  it('has no Passkeys card where the pool offers none', async () => {
    const wrapper = await mountView('operators', false);
    expect(wrapper.text()).not.toContain('Passkeys');
    expect(calls.map(([t]) => t)).not.toContain('ListWebAuthnCredentials');
  });

  it('lists the passkeys: name and kind (this device, or a security key)', async () => {
    credentials.value = [laptop, key];
    const wrapper = await mountView('operators', false, 'admin', { passkeys: true });
    expect(calls[0]).toEqual(['ListWebAuthnCredentials', { AccessToken: 'access-token', MaxResults: 20 }]);
    const text = wrapper.text();
    expect(text).toContain('Passkeys');
    expect(text).toContain('MacBook');
    expect(text).toContain('This device');
    expect(text).toContain('YubiKey 5');
    expect(text).toContain('Security key');
  });

  it('adds a passkey through managed login, which returns to the Account page', async () => {
    const wrapper = await mountView('operators', false, 'admin', { passkeys: true });
    const add = wrapper.findAll('a').find((a) => a.text().includes('Add a passkey'))!;
    expect(add.attributes('href')).toBe(`https://auth.example.com/passkeys/add?client_id=client-1&redirect_uri=${encodeURIComponent(`${window.location.origin}/account`)}`);
  });

  it('removes a passkey after confirmation', async () => {
    credentials.value = [laptop, key];
    const wrapper = await mountView('operators', false, 'admin', { passkeys: true });
    await wrapper.findAll('button').find((b) => b.text().includes('Remove') && b.attributes('aria-label')?.includes('MacBook'))!.trigger('click');
    await flushPromises();
    expect(calls.map(([t]) => t)).not.toContain('DeleteWebAuthnCredential');
    expect(document.body.textContent).toContain('Remove the passkey MacBook?');
    ([...document.querySelectorAll('.v-overlay-container button')].find((b) => b.textContent?.trim() === 'Remove') as HTMLElement).click();
    await flushPromises();
    expect(calls).toContainEqual(['DeleteWebAuthnCredential', { AccessToken: 'access-token', CredentialId: 'cred-1' }]);
    expect(wrapper.text()).not.toContain('MacBook');
    expect(wrapper.text()).toContain('YubiKey 5');
  });

  it('warns that the authenticator app prevents signing in with a passkey; only a reset by an administrator (operators mode) switches to passkeys', async () => {
    credentials.value = [laptop];
    const wrapper = await mountView('operators', true, 'admin', { passkeys: true });
    expect(wrapper.text()).toContain('With an authenticator app on, you cannot sign in with a passkey. To switch to passkeys, ask an administrator to reset your two-step verification, then add a passkey right away.');
    expect(button(wrapper, 'Turn off')).toBeUndefined();
    const without = await mountView('operators', false, 'admin', { passkeys: true });
    expect(without.text()).not.toContain('you cannot sign in with a passkey');
  });

  it('says how this session signed in', async () => {
    for (const [method, line] of [['passkey', 'signed in with a passkey'], ['app', 'signed in with the authenticator app'], ['password', 'signed in with a password only']]) {
      expect((await mountView('operators', false, 'admin', { passkeys: true, method })).text()).toContain(`This session: ${line}`);
    }
    expect((await mountView('operators', false, 'admin', { passkeys: true, method: null })).text()).not.toContain('This session');
  });

  it('offers to turn the app off in the optional mode only', async () => {
    credentials.value = [laptop];
    expect(button(await mountView('optional', true, 'admin', { passkeys: true }), 'Turn off')).toBeDefined();
    expect(button(await mountView('operators', true, 'admin', { passkeys: true }), 'Turn off')).toBeUndefined();
    expect(button(await mountView('required', true, 'admin', { passkeys: true }), 'Turn off')).toBeUndefined();
  });

  it('a passkey session needs no prompt to set up two-step verification, nor the app offer', async () => {
    const wrapper = await mountView('operators', false, 'admin', { passkeys: true, method: 'passkey' });
    useSession().applyMe({ ...me.value, effectiveRole: 'admin' } as never);
    await flushPromises();
    expect(wrapper.text()).toContain('Signed in with a passkey: two-step verification is built in.');
    expect(wrapper.text()).not.toContain('your admin rights wait for it');
    expect(button(wrapper, 'Set up an authenticator app')).toBeUndefined();
  });

  it('an enrolled user whose session is password only is told to sign in again', async () => {
    const wrapper = await mountView('operators', true, 'admin', { passkeys: true, method: 'password' });
    useSession().applyMe({ ...me.value, effectiveRole: 'viewer' } as never);
    await flushPromises();
    expect(wrapper.text()).toContain('sign out and sign in again to use your rights');
  });
});
