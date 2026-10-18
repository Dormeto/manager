import { defineStore } from 'pinia';
import { api } from '../api';
import type { NotInstalled, UpdateState } from '../update';

// The versions the manager can be updated to (enabled or not), for the navigation badge of administrators.
export const useUpdateBadge = defineStore('update-badge', {
  state: () => ({ count: 0 }),
  actions: {
    // A state the Update page loaded: its versions on offer.
    fromState(state: UpdateState | NotInstalled) {
      this.count = state.installedWithCli ? state.versions.length : 0;
    },
    async refresh() {
      try {
        const { count } = await api<{ count?: unknown }>('/update/available');
        if (typeof count === 'number') this.count = count;
      } catch {
        // The badge is a hint; the Update page shows errors.
      }
    },
  },
});
