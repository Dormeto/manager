import { describe, expect, it } from 'vitest';
import { createUsers, type CognitoPort, type SesPort } from '../src/users.js';
import { HttpError } from '../src/api.js';

function fakes({ production = false, identities = {} as Record<string, boolean> } = {}) {
  const calls: unknown[] = [];
  const groups: Record<string, string[]> = { 'dmt-admin': ['u-admin'], 'dmt-operator': ['u-op'], 'dmt-viewer': [] };
  const cognito: CognitoPort = {
    async listUsers({ PaginationToken }) {
      calls.push(['listUsers', PaginationToken ?? null]);
      if (!PaginationToken) return { Users: [{ Username: 'u-admin', Attributes: [{ Name: 'email', Value: 'admin@example.com' }], UserStatus: 'CONFIRMED', Enabled: true, UserCreateDate: new Date(0) }], PaginationToken: 'p2' };
      return { Users: [{ Username: 'u-op', Attributes: [{ Name: 'email', Value: 'op@example.com' }], UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: false }, { Username: 'u-new', Attributes: [{ Name: 'email', Value: 'new@example.com' }], UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: true }] };
    },
    async listUsersInGroup({ GroupName }) { return { Users: (groups[GroupName] ?? []).map((Username) => ({ Username })) }; },
    async adminCreateUser(input) {
      calls.push(['create', input.Username, input.MessageAction ?? 'invite']);
      if (input.Username === 'exists@example.com' && input.MessageAction !== 'RESEND') throw Object.assign(new Error('exists'), { name: 'UsernameExistsException' });
      return {};
    },
    async adminAddUserToGroup(input) { calls.push(['add', input.Username, input.GroupName]); return {}; },
    async adminRemoveUserFromGroup(input) { calls.push(['remove', input.Username, input.GroupName]); return {}; },
    async adminDisableUser(input) { calls.push(['disable', input.Username]); return {}; },
    async adminEnableUser(input) { calls.push(['enable', input.Username]); return {}; },
  };
  const ses: SesPort = {
    async getAccount() { return { ProductionAccessEnabled: production }; },
    async getEmailIdentity({ EmailIdentity }) {
      if (!(EmailIdentity in identities)) throw Object.assign(new Error('missing'), { name: 'NotFoundException' });
      return { VerifiedForSendingStatus: identities[EmailIdentity] };
    },
    async createEmailIdentity({ EmailIdentity }) { calls.push(['identity', EmailIdentity]); return {}; },
  };
  return { users: createUsers({ cognito, ses, userPoolId: 'pool' }), calls };
}

describe('users service', () => {
  it('lists every user with its highest role', async () => {
    const { users } = fakes();
    expect(await users.list()).toEqual([
      { email: 'admin@example.com', role: 'admin', status: 'CONFIRMED', enabled: true, createdAt: '1970-01-01T00:00:00.000Z' },
      { email: 'op@example.com', role: 'operator', status: 'FORCE_CHANGE_PASSWORD', enabled: false, createdAt: null },
      { email: 'new@example.com', role: 'viewer', status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdAt: null },
    ]);
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
