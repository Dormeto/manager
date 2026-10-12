// Sign-in with the Cognito managed login: authorization code with PKCE (oidc-client-ts), tokens in sessionStorage.
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import type { Config } from './config';

let manager: UserManager | null = null;

export function initAuth(config: Config): void {
  manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: `${window.location.origin}/callback`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    // aws.cognito.signin.user.admin: the user sets up their own MFA with their access token (R6c).
    scope: 'openid email profile aws.cognito.signin.user.admin',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
}

function users(): UserManager {
  if (!manager) throw new Error('authentication not initialized');
  return manager;
}

export const currentUser = (): Promise<User | null> => users().getUser();

export const signIn = (returnTo: string): Promise<void> => users().signinRedirect({ state: { returnTo } });

export async function completeSignIn(): Promise<string> {
  const user = await users().signinRedirectCallback();
  return (user.state as { returnTo?: string } | undefined)?.returnTo ?? '/';
}

// Cognito has no end_session_endpoint in its discovery document: its own /logout endpoint ends the session.
export async function signOut(config: Config): Promise<void> {
  await users().removeUser();
  const target = encodeURIComponent(`${window.location.origin}/`);
  window.location.assign(`https://${config.authDomain}/logout?client_id=${config.clientId}&logout_uri=${target}`);
}

// ID token for the API (it carries the email and the groups); renewed with the refresh token when expired.
export async function idToken(): Promise<string | null> {
  const user = await users().getUser();
  if (user && !user.expired && user.id_token) return user.id_token;
  try {
    return (await users().signinSilent())?.id_token ?? null;
  } catch {
    return null;
  }
}

// Access token for the user's own calls to Cognito (MFA set-up); renewed as the ID token.
export async function accessToken(): Promise<string | null> {
  const user = await users().getUser();
  if (user && !user.expired && user.access_token) return user.access_token;
  try {
    return (await users().signinSilent())?.access_token ?? null;
  } catch {
    return null;
  }
}

export type Role = 'viewer' | 'operator' | 'admin';

export function roleOf(user: User | null): Role {
  const groups = (user?.profile['cognito:groups'] as string[] | undefined) ?? [];
  if (groups.includes('dmt-admin')) return 'admin';
  if (groups.includes('dmt-operator')) return 'operator';
  return 'viewer';
}
