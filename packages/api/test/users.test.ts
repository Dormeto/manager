import { describe, expect, it } from 'vitest';
import { createUsers, type CognitoPort, type SesPort } from '../src/users.js';
import { HttpError } from '../src/api.js';

// The group calls of fakes that do not use them.
const groupsUnused = { async createGroup() { return {}; }, async updateGroup() { return {}; }, async deleteGroup() { return {}; }, async listGroups() { return {}; } };

function fakes({ production = false, identities = {} as Record<string, boolean>, sender = 'ses' as 'ses' | 'cognito' } = {}) {
  const calls: unknown[] = [];
  // The groups of each user (Cognito usernames): the built-in role's and the custom groups.
  const groups: Record<string, string[]> = { 'u-admin': ['dmt-admin', 'payments'], 'u-op': ['dmt-operator', 'dmt-viewer'], 'bob@example.com': ['payments', 'search'] };
  const cognito: CognitoPort = {
    async listUsers({ PaginationToken }) {
      calls.push(['listUsers', PaginationToken ?? null]);
      if (!PaginationToken) return { Users: [{ Username: 'u-admin', Attributes: [{ Name: 'email', Value: 'admin@example.com' }], UserStatus: 'CONFIRMED', Enabled: true, UserCreateDate: new Date(0) }], PaginationToken: 'p2' };
      return { Users: [{ Username: 'u-op', Attributes: [{ Name: 'email', Value: 'op@example.com' }], UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: false }, { Username: 'u-new', Attributes: [{ Name: 'email', Value: 'new@example.com' }], UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: true }] };
    },
    async adminListGroupsForUser({ Username, NextToken }) {
      calls.push(['groups-of', Username, NextToken ?? null]);
      const all = groups[Username] ?? [];
      // Two pages for the first user.
      if (Username === 'u-admin') return NextToken ? { Groups: all.slice(1).map((GroupName) => ({ GroupName })) } : { Groups: all.slice(0, 1).map((GroupName) => ({ GroupName })), NextToken: 'g2' };
      return { Groups: all.map((GroupName) => ({ GroupName })) };
    },
    async createGroup(input) {
      calls.push(['create-group', input.GroupName, input.Description ?? null]);
      if (input.GroupName === 'dup') throw Object.assign(new Error('exists'), { name: 'GroupExistsException' });
      return {};
    },
    async updateGroup(input) { calls.push(['update-group', input.GroupName, input.Description ?? null]); return {}; },
    async deleteGroup(input) {
      calls.push(['delete-group', input.GroupName]);
      if (input.GroupName === 'gone') throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
      return {};
    },
    async listGroups({ NextToken }) {
      return NextToken ? { Groups: [{ GroupName: 'search' }] } : { Groups: [{ GroupName: 'dmt-admin' }, { GroupName: 'payments' }], NextToken: 'n2' };
    },
    async adminCreateUser(input) {
      calls.push(['create', input.Username, input.MessageAction ?? 'invite']);
      if (input.Username === 'exists@example.com' && input.MessageAction !== 'RESEND') throw Object.assign(new Error('exists'), { name: 'UsernameExistsException' });
      return {};
    },
    async adminAddUserToGroup(input) { calls.push(['add', input.Username, input.GroupName]); return {}; },
    async adminRemoveUserFromGroup(input) { calls.push(['remove', input.Username, input.GroupName]); return {}; },
    async adminDisableUser(input) { calls.push(['disable', input.Username]); return {}; },
    async adminEnableUser(input) { calls.push(['enable', input.Username]); return {}; },
    async adminGetUser(input) {
      calls.push(['get', input.Username]);
      return { UserMFASettingList: input.Username === 'u-admin' ? ['SOFTWARE_TOKEN_MFA'] : [] };
    },
    async adminSetUserMFAPreference(input) { calls.push(['mfa-preference', input.Username, input.SoftwareTokenMfaSettings]); return {}; },
    async adminDeleteSoftwareToken(input) { calls.push(['delete-token', input.Username]); if (input.Username === 'none@example.com') throw Object.assign(new Error('no token'), { name: 'ResourceNotFoundException' }); return {}; },
  };
  const ses: SesPort = {
    async getAccount() { return { ProductionAccessEnabled: production }; },
    async getEmailIdentity({ EmailIdentity }) {
      if (!(EmailIdentity in identities)) throw Object.assign(new Error('missing'), { name: 'NotFoundException' });
      return { VerifiedForSendingStatus: identities[EmailIdentity] };
    },
    async createEmailIdentity({ EmailIdentity }) { calls.push(['identity', EmailIdentity]); return {}; },
  };
  // With Cognito sending its own email, SES is never called.
  const untouched: SesPort = { getAccount: () => { throw new Error('SES called'); }, getEmailIdentity: () => { throw new Error('SES called'); }, createEmailIdentity: () => { throw new Error('SES called'); } };
  return { users: createUsers({ cognito, ses: sender === 'cognito' ? untouched : ses, userPoolId: 'pool', sender }), calls };
}

describe('users service', () => {
  it('lists every user with its highest role (member without a built-in group) and its custom groups', async () => {
    const { users } = fakes();
    expect(await users.list()).toEqual([
      { email: 'admin@example.com', role: 'admin', groups: ['payments'], status: 'CONFIRMED', enabled: true, createdAt: '1970-01-01T00:00:00.000Z', mfa: true },
      { email: 'op@example.com', role: 'operator', groups: [], status: 'FORCE_CHANGE_PASSWORD', enabled: false, createdAt: null, mfa: false },
      { email: 'new@example.com', role: 'member', groups: [], status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdAt: null, mfa: false },
    ]);
  });

  it('invites a member into custom groups only, and a role with groups after its built-in group', async () => {
    const { users, calls } = fakes({ production: true });
    await users.invite('bob@example.com', 'member', ['payments', 'search']);
    await users.invite('ann@example.com', 'viewer', ['payments']);
    expect(calls).toEqual([
      ['create', 'bob@example.com', 'invite'], ['add', 'bob@example.com', 'payments'], ['add', 'bob@example.com', 'search'],
      ['create', 'ann@example.com', 'invite'], ['add', 'ann@example.com', 'dmt-viewer'], ['add', 'ann@example.com', 'payments'],
    ]);
  });

  it('makes a user a member by leaving every built-in group', async () => {
    const { users, calls } = fakes();
    await users.setRole('op@example.com', 'member');
    expect(calls).toEqual([['remove', 'op@example.com', 'dmt-admin'], ['remove', 'op@example.com', 'dmt-operator'], ['remove', 'op@example.com', 'dmt-viewer']]);
  });

  it('sets a user\'s custom groups: adds the missing, removes the others, never touches a built-in group', async () => {
    const { users, calls } = fakes();
    await users.setGroups('bob@example.com', ['search', 'ops']);
    expect(calls).toEqual([['groups-of', 'bob@example.com', null], ['add', 'bob@example.com', 'ops'], ['remove', 'bob@example.com', 'payments']]);
    calls.length = 0;
    await users.setGroups('u-admin', []);
    expect(calls).toEqual([['groups-of', 'u-admin', null], ['groups-of', 'u-admin', 'g2'], ['remove', 'u-admin', 'payments']]);
  });

  it('creates, describes and deletes a Cognito group; a group that exists is adopted, one already gone is deleted', async () => {
    const { users, calls } = fakes();
    await users.createGroup('payments', 'The payments team');
    await users.createGroup('dup', '');
    await users.updateGroup('payments', 'Payments');
    await users.deleteGroup('payments');
    await users.deleteGroup('gone');
    expect(calls).toEqual([['create-group', 'payments', 'The payments team'], ['create-group', 'dup', null], ['update-group', 'payments', 'Payments'], ['delete-group', 'payments'], ['delete-group', 'gone']]);
  });

  it('names the custom groups of the pool, every page, without the built-in ones', async () => {
    const { users } = fakes();
    expect(await users.groupNames()).toEqual(['payments', 'search']);
  });

  it('says whether a user has an authenticator app (R6c)', async () => {
    const { users } = fakes();
    expect(await users.mfaEnabled('u-admin')).toBe(true);
    expect(await users.mfaEnabled('u-op')).toBe(false);
  });

  it('resets a user\'s MFA: TOTP turned off and its token deleted; a user without a token is reset too', async () => {
    const { users, calls } = fakes();
    expect(await users.resetMfa('op@example.com')).toEqual({ tokenDeleted: true });
    expect(calls).toEqual([['mfa-preference', 'op@example.com', { Enabled: false, PreferredMfa: false }], ['delete-token', 'op@example.com']]);
    expect(await users.resetMfa('none@example.com')).toEqual({ tokenDeleted: false });
  });

  it('in the SES sandbox, an unverified address gets an SES identity and the invitation waits', async () => {
    const { users, calls } = fakes();
    expect(await users.invite('bob@example.com', 'operator')).toEqual({ invitation: 'pending-verification' });
    expect(calls).toEqual([['identity', 'bob@example.com'], ['create', 'bob@example.com', 'SUPPRESS'], ['add', 'bob@example.com', 'dmt-operator']]);
  });

  it('a verified address, or SES in production, gets the invitation at once', async () => {
    for (const setup of [{ identities: { 'bob@example.com': true } }, { production: true }]) {
      const { users, calls } = fakes(setup);
      expect(await users.invite('bob@example.com', 'viewer')).toEqual({ invitation: 'sent' });
      expect(calls).toEqual([['create', 'bob@example.com', 'invite'], ['add', 'bob@example.com', 'dmt-viewer']]);
    }
  });

  it('an address of a verified domain is ready at once (no identity of its own)', async () => {
    const { users, calls } = fakes({ identities: { 'example.org': true } });
    expect(await users.invite('ann@example.org', 'viewer')).toEqual({ invitation: 'sent' });
    expect(calls).toEqual([['create', 'ann@example.org', 'invite'], ['add', 'ann@example.org', 'dmt-viewer']]);
  });

  it('an address being verified does not get a second SES identity', async () => {
    const { users, calls } = fakes({ identities: { 'bob@example.com': false } });
    expect(await users.invite('bob@example.com', 'viewer')).toEqual({ invitation: 'pending-verification' });
    expect(calls.filter((c) => (c as string[])[0] === 'identity')).toEqual([]);
  });

  it('with Cognito sending its own email (no SES identity), invites and resends at once and never touches SES', async () => {
    const { users, calls } = fakes({ sender: 'cognito' });
    expect(await users.invite('new@example.com', 'viewer')).toEqual({ invitation: 'sent' });
    expect(await users.resend('new@example.com')).toEqual({ invitation: 'sent' });
    expect(calls).toEqual([['create', 'new@example.com', 'invite'], ['add', 'new@example.com', 'dmt-viewer'], ['create', 'new@example.com', 'RESEND']]);
  });

  it('an existing user is a conflict', async () => {
    const { users } = fakes({ production: true });
    await expect(users.invite('exists@example.com', 'viewer')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('resends once the address is verified, 409 before', async () => {
    await expect(fakes({ identities: { 'bob@example.com': false } }).users.resend('bob@example.com')).rejects.toBeInstanceOf(HttpError);
    const { users, calls } = fakes({ identities: { 'bob@example.com': true } });
    expect(await users.resend('bob@example.com')).toEqual({ invitation: 'sent' });
    expect(calls).toEqual([['create', 'bob@example.com', 'RESEND']]);
  });

  it('a role change keeps one Dormeto group; enable and disable', async () => {
    const { users, calls } = fakes();
    await users.setRole('op@example.com', 'admin');
    await users.setEnabled('op@example.com', false);
    await users.setEnabled('op@example.com', true);
    expect(calls).toEqual([
      ['remove', 'op@example.com', 'dmt-operator'], ['remove', 'op@example.com', 'dmt-viewer'], ['add', 'op@example.com', 'dmt-admin'],
      ['disable', 'op@example.com'], ['enable', 'op@example.com'],
    ]);
  });
});

describe('users service: review M4', () => {
  it('says the MFA is unknown (null) when Cognito cannot say, rather than off', async () => {
    const cognito = {
      async listUsers() { return { Users: [{ Username: 'u-1', Attributes: [{ Name: 'email', Value: 'a@example.com' }], UserStatus: 'CONFIRMED', Enabled: true }] }; },
      async adminListGroupsForUser() { return { Groups: [] }; }, ...groupsUnused,
      async adminCreateUser() { return {}; }, async adminAddUserToGroup() { return {}; }, async adminRemoveUserFromGroup() { return {}; },
      async adminDisableUser() { return {}; }, async adminEnableUser() { return {}; }, async adminSetUserMFAPreference() { return {}; },
      async adminGetUser(): Promise<{ UserMFASettingList?: string[] }> { throw Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' }); },
    };
    const users = createUsers({ cognito, ses: { getAccount: async () => ({}), getEmailIdentity: async () => ({}), createEmailIdentity: async () => ({}) }, userPoolId: 'pool', sender: 'cognito' });
    expect((await users.list())[0]!.mfa).toBeNull();
  });
});

describe('users service: MFA set up at sign-in (review I3, found live)', () => {
  // Under required, managed login's MFA_SETUP registers a verified authenticator without turning TOTP on in the user's
  // settings (UserMFASettingList empty): turning it on succeeds for such a user only.
  function cognitoWith(registered: Set<string>) {
    const settings = new Map<string, string[]>();
    return {
      settings,
      port: {
        async listUsers() { return { Users: [] }; }, async adminListGroupsForUser() { return { Groups: [] }; }, ...groupsUnused,
        async adminCreateUser() { return {}; }, async adminAddUserToGroup() { return {}; }, async adminRemoveUserFromGroup() { return {}; },
        async adminDisableUser() { return {}; }, async adminEnableUser() { return {}; },
        async adminGetUser({ Username }: { Username: string }) { return { UserMFASettingList: settings.get(Username) ?? [] }; },
        async adminSetUserMFAPreference({ Username, SoftwareTokenMfaSettings }: { Username: string; SoftwareTokenMfaSettings: { Enabled: boolean } }) {
          if (SoftwareTokenMfaSettings.Enabled && !registered.has(Username)) throw Object.assign(new Error('User does not have delivery config set to turn on SOFTWARE_TOKEN_MFA'), { name: 'InvalidParameterException' });
          settings.set(Username, SoftwareTokenMfaSettings.Enabled ? ['SOFTWARE_TOKEN_MFA'] : []);
          return {};
        },
      },
    };
  }
  const ses = { getAccount: async () => ({}), getEmailIdentity: async () => ({}), createEmailIdentity: async () => ({}) };

  it('with activate (required), a user with a verified authenticator but TOTP off is turned on, and counts as enrolled', async () => {
    const c = cognitoWith(new Set(['u-setup']));
    const users = createUsers({ cognito: c.port, ses, userPoolId: 'pool', sender: 'cognito' });
    expect(await users.mfaEnabled('u-setup')).toBe(false);
    expect(await users.mfaEnabled('u-setup', { activate: true })).toBe(true);
    expect(c.settings.get('u-setup')).toEqual(['SOFTWARE_TOKEN_MFA']);
    expect(await users.mfaEnabled('u-none', { activate: true })).toBe(false);
  });
});
