import { defineStore } from 'pinia';
import type { User } from 'oidc-client-ts';
import { roleOf, type Role } from '../auth';

export const useSession = defineStore('session', {
  state: () => ({ email: '' as string, role: 'viewer' as Role }),
  getters: {
    canOperate: (s) => s.role === 'operator' || s.role === 'admin',
    isAdmin: (s) => s.role === 'admin',
  },
  actions: {
    set(user: User | null) {
      this.email = (user?.profile.email as string | undefined) ?? '';
      this.role = roleOf(user);
    },
  },
});
