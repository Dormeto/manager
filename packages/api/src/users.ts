// Users of the dashboard: Cognito users and groups. When Cognito sends through an SES identity in the sandbox, it can only
// send the invitation to a verified address: the invited address becomes an SES identity first, and the invitation is
// resent once verified. When Cognito sends its own email (the manager module without ses_identity), SES is not involved.
import { HttpError, type Role, type UserView, type UsersService } from './api.js';

type Input = Record<string, unknown>;

// The Cognito and SES calls used here (SDK command inputs and outputs, as plain objects).
export interface CognitoPort {
  listUsers(input: { UserPoolId: string; PaginationToken?: string }): Promise<{ Users?: CognitoUser[]; PaginationToken?: string }>;
  // Groups (R11): a user's, the pool's, and the custom groups' own lifecycle.
  adminListGroupsForUser(input: { UserPoolId: string; Username: string; NextToken?: string }): Promise<{ Groups?: { GroupName?: string }[]; NextToken?: string }>;
  listGroups(input: { UserPoolId: string; NextToken?: string }): Promise<{ Groups?: { GroupName?: string }[]; NextToken?: string }>;
  createGroup(input: { UserPoolId: string; GroupName: string; Description?: string }): Promise<unknown>;
  updateGroup(input: { UserPoolId: string; GroupName: string; Description?: string }): Promise<unknown>;
  deleteGroup(input: { UserPoolId: string; GroupName: string }): Promise<unknown>;
  adminCreateUser(input: Input & { Username: string; MessageAction?: string }): Promise<unknown>;
  adminAddUserToGroup(input: { UserPoolId: string; Username: string; GroupName: string }): Promise<unknown>;
  adminRemoveUserFromGroup(input: { UserPoolId: string; Username: string; GroupName: string }): Promise<unknown>;
  adminDisableUser(input: { UserPoolId: string; Username: string }): Promise<unknown>;
  adminEnableUser(input: { UserPoolId: string; Username: string }): Promise<unknown>;
  // MFA (R6c): a user's factors, turning TOTP off, and deleting the TOTP token (a recent API: optional).
  adminGetUser(input: { UserPoolId: string; Username: string }): Promise<{ UserMFASettingList?: string[] }>;
  adminSetUserMFAPreference(input: { UserPoolId: string; Username: string; SoftwareTokenMfaSettings: { Enabled: boolean; PreferredMfa: boolean } }): Promise<unknown>;
  adminDeleteSoftwareToken?(input: { UserPoolId: string; Username: string }): Promise<unknown>;
}

export interface SesPort {
  getAccount(): Promise<{ ProductionAccessEnabled?: boolean }>;
  getEmailIdentity(input: { EmailIdentity: string }): Promise<{ VerifiedForSendingStatus?: boolean }>;
  createEmailIdentity(input: { EmailIdentity: string }): Promise<unknown>;
}

interface CognitoUser {
  Username?: string;
  Attributes?: { Name?: string; Value?: string }[];
  UserStatus?: string;
  Enabled?: boolean;
  UserCreateDate?: Date;
}

// The built-in roles' groups, highest first; a member (a role without one) is in none of them.
const ORDER: Role[] = ['admin', 'operator', 'viewer'];
const group = (role: Role) => `dmt-${role}`;
const BUILT_IN = new Set(ORDER.map(group));

// Cognito errors that are the caller's problem, not ours.
async function mapped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'UsernameExistsException') throw new HttpError(409, 'conflict', 'this user already exists');
    if (name === 'UserNotFoundException') throw new HttpError(404, 'not_found', 'no such user');
    if (name === 'UnsupportedUserStateException') throw new HttpError(409, 'conflict', 'the user has already signed in: no invitation to resend');
    throw err;
  }
}

export function createUsers({ cognito, ses, userPoolId, sender = 'ses' }: { cognito: CognitoPort; ses: SesPort; userPoolId: string; sender?: 'ses' | 'cognito' }): UsersService & { mfaEnabled(username: string, options?: { activate?: boolean }): Promise<boolean> } {
  // Any address receives Cognito's own email, and SES in production.
  async function inProduction() {
    return sender === 'cognito' || (await ses.getAccount()).ProductionAccessEnabled === true;
  }

  async function status(identity: string): Promise<'verified' | 'pending' | 'missing'> {
    try {
      return (await ses.getEmailIdentity({ EmailIdentity: identity })).VerifiedForSendingStatus ? 'verified' : 'pending';
    } catch (err) {
      if ((err as Error).name === 'NotFoundException') return 'missing';
      throw err;
    }
  }

  // An address can receive mail in the sandbox when it, or its whole domain, is a verified identity.
  async function identity(email: string) {
    const own = await status(email);
    if (own === 'verified') return own;
    return (await status(email.split('@')[1] ?? '')) === 'verified' ? 'verified' : own;
  }

  // Every group of a user (the built-in role's and the custom ones).
  async function groupsOf(username: string) {
    const names: string[] = [];
    let NextToken: string | undefined;
    do {
      const page = await mapped(() => cognito.adminListGroupsForUser({ UserPoolId: userPoolId, Username: username, ...(NextToken ? { NextToken } : {}) }));
      for (const g of page.Groups ?? []) if (g.GroupName) names.push(g.GroupName);
      NextToken = page.NextToken;
    } while (NextToken);
    return names;
  }

  // An authenticator app set up: TOTP among the user's MFA settings. activate (policy required): managed login's MFA_SETUP
  // registers a verified authenticator without turning TOTP on in the user's settings, so it is turned on here — Cognito
  // refuses that to a user without a verified authenticator, which then counts as none (seen live, R6c review).
  async function mfaEnabled(username: string, { activate = false } = {}) {
    const input = { UserPoolId: userPoolId, Username: username };
    if (((await cognito.adminGetUser(input)).UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA')) return true;
    if (!activate) return false;
    try {
      await cognito.adminSetUserMFAPreference({ ...input, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } });
      return true;
    } catch (err) {
      if ((err as Error).name === 'InvalidParameterException') return false;
      throw err;
    }
  }
  // A sliding window: up to `limit` calls in flight, a new one as soon as one ends; the first failure fails the whole.
  async function windowed<T, R>(items: T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await each(items[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  return {
    mfaEnabled,
    async list() {
      const all: CognitoUser[] = [];
      let PaginationToken: string | undefined;
      do {
        const page = await cognito.listUsers({ UserPoolId: userPoolId, ...(PaginationToken ? { PaginationToken } : {}) });
        all.push(...(page.Users ?? []));
        PaginationToken = page.PaginationToken;
      } while (PaginationToken);
      // Each user's groups (a failure fails the page) then their MFA (null: Cognito could not say, shown unknown, not off),
      // eight users in flight at a time.
      const rows = await windowed(all, 8, async (u) => {
        const groups = await groupsOf(u.Username ?? '');
        return { groups, mfa: await mfaEnabled(u.Username ?? '').catch(() => null) };
      });
      return all.map((u, i): UserView => ({
        email: u.Attributes?.find((a) => a.Name === 'email')?.Value ?? u.Username ?? '',
        role: ORDER.find((r) => rows[i]!.groups.includes(group(r))) ?? 'member',
        groups: rows[i]!.groups.filter((g) => !BUILT_IN.has(g)),
        status: u.UserStatus ?? 'UNKNOWN',
        enabled: u.Enabled !== false,
        createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
        mfa: rows[i]!.mfa,
      }));
    },

    async invite(email, role, groups = []) {
      let ready = await inProduction();
      if (!ready) {
        const status = await identity(email);
        if (status === 'missing') await ses.createEmailIdentity({ EmailIdentity: email });
        ready = status === 'verified';
      }
      await mapped(() => cognito.adminCreateUser({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
        DesiredDeliveryMediums: ['EMAIL'],
        ...(ready ? {} : { MessageAction: 'SUPPRESS' }),
      }));
      // A member is in no built-in group.
      if (role !== 'member') await cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: group(role) });
      for (const name of groups) await cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: name });
      return { invitation: ready ? 'sent' : 'pending-verification' };
    },

    async resend(email) {
      if (!(await inProduction()) && (await identity(email)) !== 'verified') {
        throw new HttpError(409, 'conflict', 'address not verified yet: the invitee must first click the link in the verification email from AWS');
      }
      await mapped(() => cognito.adminCreateUser({ UserPoolId: userPoolId, Username: email, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
      return { invitation: 'sent' };
    },

    async setRole(email, role) {
      for (const other of ORDER.filter((r) => r !== role)) {
        await mapped(() => cognito.adminRemoveUserFromGroup({ UserPoolId: userPoolId, Username: email, GroupName: group(other) }));
      }
      if (role !== 'member') await mapped(() => cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: group(role) }));
    },

    // The groups Dormeto manages (`managed`: the custom groups it keeps) become exactly these; the built-in groups and the
    // pool's groups made by hand are left alone.
    async setGroups(email, wanted, managed) {
      const have = (await groupsOf(email)).filter((g) => managed.includes(g));
      for (const name of wanted.filter((g) => !have.includes(g))) await mapped(() => cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: name }));
      for (const name of have.filter((g) => !wanted.includes(g))) await mapped(() => cognito.adminRemoveUserFromGroup({ UserPoolId: userPoolId, Username: email, GroupName: name }));
    },

    // A group that exists in the pool already is taken over (a creation that stopped half way is made good): adopted.
    async createGroup(name, description) {
      try {
        await cognito.createGroup({ UserPoolId: userPoolId, GroupName: name, ...(description ? { Description: description } : {}) });
        return { adopted: false };
      } catch (err) {
        if ((err as Error).name !== 'GroupExistsException') throw err;
        if (description) await cognito.updateGroup({ UserPoolId: userPoolId, GroupName: name, Description: description });
        return { adopted: true };
      }
    },
    async updateGroup(name, description) {
      await cognito.updateGroup({ UserPoolId: userPoolId, GroupName: name, Description: description });
    },
    // Already gone is as good as deleted.
    async deleteGroup(name) {
      try {
        await cognito.deleteGroup({ UserPoolId: userPoolId, GroupName: name });
      } catch (err) {
        if ((err as Error).name !== 'ResourceNotFoundException') throw err;
      }
    },
    // The pool's custom groups.
    async groupNames() {
      const names: string[] = [];
      let NextToken: string | undefined;
      do {
        const page = await cognito.listGroups({ UserPoolId: userPoolId, ...(NextToken ? { NextToken } : {}) });
        for (const g of page.Groups ?? []) if (g.GroupName && !BUILT_IN.has(g.GroupName)) names.push(g.GroupName);
        NextToken = page.NextToken;
      } while (NextToken);
      return names;
    },

    async setEnabled(email, enabled) {
      const input = { UserPoolId: userPoolId, Username: email };
      await mapped(() => (enabled ? cognito.adminEnableUser(input) : cognito.adminDisableUser(input)));
    },

    // TOTP off (enough while the pool's MFA is optional), and its token deleted (needed when MFA is required: a registered
    // token is asked for even when off); a user without a token is reset all the same.
    async resetMfa(email) {
      const input = { UserPoolId: userPoolId, Username: email };
      await mapped(() => cognito.adminSetUserMFAPreference({ ...input, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
      if (!cognito.adminDeleteSoftwareToken) return { tokenDeleted: false };
      try {
        await cognito.adminDeleteSoftwareToken(input);
        return { tokenDeleted: true };
      } catch (err) {
        if ((err as Error).name !== 'ResourceNotFoundException') throw err;
        return { tokenDeleted: false };
      }
    },
  };
}
