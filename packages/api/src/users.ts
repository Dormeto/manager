// Users of the dashboard: Cognito users and groups. While SES is in the sandbox, Cognito can only send the invitation
// to a verified address: the invited address becomes an SES identity first, and the invitation is resent once verified.
import { HttpError, type Role, type UserView, type UsersService } from './api.js';

type Input = Record<string, unknown>;

// The Cognito and SES calls used here (SDK command inputs and outputs, as plain objects).
export interface CognitoPort {
  listUsers(input: { UserPoolId: string; PaginationToken?: string }): Promise<{ Users?: CognitoUser[]; PaginationToken?: string }>;
  listUsersInGroup(input: { UserPoolId: string; GroupName: string; NextToken?: string }): Promise<{ Users?: CognitoUser[]; NextToken?: string }>;
  adminCreateUser(input: Input & { Username: string; MessageAction?: string }): Promise<unknown>;
  adminAddUserToGroup(input: { UserPoolId: string; Username: string; GroupName: string }): Promise<unknown>;
  adminRemoveUserFromGroup(input: { UserPoolId: string; Username: string; GroupName: string }): Promise<unknown>;
  adminDisableUser(input: { UserPoolId: string; Username: string }): Promise<unknown>;
  adminEnableUser(input: { UserPoolId: string; Username: string }): Promise<unknown>;
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

const ORDER: Role[] = ['admin', 'operator', 'viewer'];
const group = (role: Role) => `dmt-${role}`;

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

export function createUsers({ cognito, ses, userPoolId }: { cognito: CognitoPort; ses: SesPort; userPoolId: string }): UsersService {
  async function inProduction() {
    return (await ses.getAccount()).ProductionAccessEnabled === true;
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

  async function members(groupName: string) {
    const names = new Set<string>();
    let NextToken: string | undefined;
    do {
      const page = await cognito.listUsersInGroup({ UserPoolId: userPoolId, GroupName: groupName, NextToken });
      for (const u of page.Users ?? []) if (u.Username) names.add(u.Username);
      NextToken = page.NextToken;
    } while (NextToken);
    return names;
  }

  return {
    async list() {
      const all: CognitoUser[] = [];
      let PaginationToken: string | undefined;
      do {
        const page = await cognito.listUsers({ UserPoolId: userPoolId, ...(PaginationToken ? { PaginationToken } : {}) });
        all.push(...(page.Users ?? []));
        PaginationToken = page.PaginationToken;
      } while (PaginationToken);
      const groups = await Promise.all(ORDER.map(async (role) => [role, await members(group(role))] as const));
      return all.map((u): UserView => ({
        email: u.Attributes?.find((a) => a.Name === 'email')?.Value ?? u.Username ?? '',
        role: groups.find(([, names]) => names.has(u.Username ?? ''))?.[0] ?? 'viewer',
        status: u.UserStatus ?? 'UNKNOWN',
        enabled: u.Enabled !== false,
        createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
      }));
    },

    async invite(email, role) {
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
      await cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: group(role) });
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
      await mapped(() => cognito.adminAddUserToGroup({ UserPoolId: userPoolId, Username: email, GroupName: group(role) }));
    },

    async setEnabled(email, enabled) {
      const input = { UserPoolId: userPoolId, Username: email };
      await mapped(() => (enabled ? cognito.adminEnableUser(input) : cognito.adminDisableUser(input)));
    },
  };
}
