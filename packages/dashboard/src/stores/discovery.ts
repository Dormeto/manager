import { defineStore } from 'pinia';
import type { RunRecord } from '@dormeto/discovery/types';
import { api } from '../api';

// Pending onboardings and offboardings of the last discovery run, for the navigation badge.
export const useDiscoveryBadge = defineStore('discovery-badge', {
  state: () => ({ pending: 0 }),
  actions: {
    fromCounts(counts: RunRecord['counts'] | undefined) {
      this.pending = (counts?.['pending-onboarding'] ?? 0) + (counts?.['pending-offboarding'] ?? 0);
    },
    async refresh() {
      try {
        this.fromCounts((await api<{ lastRun: RunRecord | null }>('/discovery')).lastRun?.counts);
      } catch {
        // The badge is a hint; the Discovery view shows errors.
      }
    },
  },
});
