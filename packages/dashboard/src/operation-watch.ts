// Operations a view showed running (an upgrade on Routers, an onboarding on Discovery): one no longer running at a refresh
// is fetched once, and how it ended is told (a toast) with a link to its steps.
import { api } from './api';
import type { Notice } from './components/NoticeAlert.vue';
import type { RouterOperationType } from './types';

export type WatchedType = RouterOperationType | 'onboard' | 'offboard';
export interface Watched { id: string; type: WatchedType; subject: string }

const LABEL: Record<WatchedType, string> = {
  'install-router': 'Installation', 'upgrade-router': 'Upgrade', 'uninstall-router': 'Uninstallation', onboard: 'Onboarding', offboard: 'Offboarding',
};
export const operationLabel = (type: WatchedType, subject: string) => `${LABEL[type]} of ${subject}`;

export const operationEnded = (type: WatchedType, subject: string, op: { status: string; error?: string }) =>
  op.status === 'succeeded' ? `${operationLabel(type, subject)} succeeded.` : `${operationLabel(type, subject)} failed: ${op.error ?? 'see its steps'}.`;

export function operationWatch(tell: (notice: Notice) => void) {
  const watched = new Map<string, Watched>();
  async function ended(w: Watched) {
    try {
      const op = await api<{ status: string; error?: string }>(`/operations/${encodeURIComponent(w.id)}`);
      // Still running (a refresh that missed it): told at a later refresh.
      if (op.status === 'running') watched.set(w.id, w);
      else tell({ type: op.status === 'succeeded' ? 'success' : 'error', text: operationEnded(w.type, w.subject, op), operation: w.id });
    } catch {
      // Its steps stay in Operations.
    }
  }
  return {
    watch(id: string, type: WatchedType, subject: string) {
      watched.set(id, { id, type, subject });
    },
    get active() {
      return watched.size > 0;
    },
    // The operations running at this refresh: those watched and no longer among them have ended.
    refreshed(running: Watched[]) {
      const now = new Set(running.map((w) => w.id));
      for (const w of [...watched.values()]) {
        if (now.has(w.id)) continue;
        watched.delete(w.id);
        void ended(w);
      }
      // The name it was started with stays (an onboarding under another name than its target group).
      for (const w of running) if (!watched.has(w.id)) watched.set(w.id, w);
    },
  };
}
