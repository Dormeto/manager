import { defineStore } from 'pinia';
import type { User } from 'oidc-client-ts';
import { roleOf, type Role } from '../auth';

// What /api/me says (R6c): the role the groups give, the role the user acts with (lower without MFA where the policy
// requires it; null when nothing is allowed until MFA is set up), and the MFA.
export interface Me {
  email: string;
  role: Role;
  effectiveRole?: Role | null;
  // R11: the custom groups, and the grants the user acts with (their role's and their groups').
  groups?: string[];
  grants?: Grant[];
  // enabled: null when Cognito could not say.
  mfa?: { mode: 'optional' | 'operators' | 'required'; enabled: boolean | null; required: boolean;
    // method: how this session signed in (null: the token does not say); passkeys: the pool offers them.
    method?: 'passkey' | 'app' | 'password' | null; passkeys?: boolean };
}

export interface Grant { tags: Record<string, string>; permissions: ('read' | 'wake' | 'nap')[] }

export const useSession = defineStore('session', {
  state: () => ({ email: '' as string, role: 'viewer' as Role, effectiveRole: null as Role | null, mfa: null as Me['mfa'] | null, groups: [] as string[], grants: [] as Grant[], loaded: false }),
  getters: {
    // Until /api/me answers, the role the token's groups give (the API enforces the effective one anyway).
    acting: (s): Role => (s.loaded ? s.effectiveRole ?? 'viewer' : s.role),
    canOperate(): boolean { return this.acting === 'operator' || this.acting === 'admin'; },
    isAdmin(): boolean { return this.acting === 'admin'; },
    // A member sees workloads by their groups' grants and nothing else of the fleet (R11).
    isMember(): boolean { return this.acting === 'member'; },
    // Rights the user has but this session cannot use: the session decides (a passkey session has them, a password one of an
    // enrolled user does not).
    waitingForMfa: (s) => s.loaded && !!s.mfa?.required && s.effectiveRole !== s.role,
  },
  actions: {
    set(user: User | null) {
      this.email = (user?.profile.email as string | undefined) ?? '';
      if (!this.loaded) this.role = roleOf(user);
    },
    applyMe(me: Me) {
      this.email = me.email || this.email;
      this.role = me.role;
      this.effectiveRole = me.effectiveRole === undefined ? me.role : me.effectiveRole;
      this.mfa = me.mfa ?? null;
      this.groups = me.groups ?? [];
      this.grants = me.grants ?? [];
      this.loaded = true;
    },
  },
});
