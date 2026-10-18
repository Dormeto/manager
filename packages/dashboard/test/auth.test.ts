import { describe, expect, it, vi } from 'vitest';

const settings: Record<string, unknown>[] = [];
vi.mock('oidc-client-ts', () => ({
  UserManager: class { constructor(s: Record<string, unknown>) { settings.push(s); } },
  WebStorageStateStore: class {},
}));

import { initAuth } from '../src/auth';

describe('sign-in', () => {
  it('asks for the lowest authentication level, so that the ID token tells how the user signed in (amr) and nobody is asked for more', () => {
    initAuth({ env: 'test', authority: 'https://cognito-idp.eu-west-1.amazonaws.com/p', clientId: 'c', authDomain: 'auth.example.com', passkeys: true });
    expect(settings[0]).toMatchObject({ client_id: 'c', extraQueryParams: { acr_values: 'urn:cognito:loa:1' } });
  });

  it('asks for nothing more where the pool offers no passkeys', () => {
    initAuth({ env: 'test', authority: 'https://cognito-idp.eu-west-1.amazonaws.com/p', clientId: 'c2', authDomain: 'auth.example.com', passkeys: false });
    expect(settings[1]).toMatchObject({ client_id: 'c2' });
    expect(settings[1]).not.toHaveProperty('extraQueryParams');
  });
});
