// What a router's actions do (the Routers list and a router's view): router operations (administrators, run by the
// workflow and followed in Operations), pause and resume (operators), and the workloads a state count opens.
import type { Ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from './api';
import { operationWatch } from './operation-watch';
import type { Notice } from './components/NoticeAlert.vue';
import type { RouterInfo, RouterOperationType } from './types';

export function useRouterOperations(notice: Ref<Notice | null>, refresh: () => Promise<void>) {
  const navigation = useRouter();
  // Router operations running at the last refresh: a toast says how each one ended.
  const watch = operationWatch((n) => { notice.value = n; });

  async function operation(body: Record<string, unknown>, what: string, row?: RouterInfo) {
    try {
      const { operation: op } = await api<{ operation: { id: string } }>('/operations', { method: 'POST', body: JSON.stringify(body) });
      notice.value = { type: 'success', text: `${what} started (operation ${op.id}).`, operation: op.id };
      // Shown running at once (the next refresh confirms it).
      if (row) {
        row.operation = { id: op.id, type: body.type as RouterOperationType };
        watch.watch(op.id, row.operation.type, row.name);
      }
    } catch (err) {
      notice.value = { type: 'error', text: (err as Error).message };
    }
  }

  async function pause(router: RouterInfo, body: { reason: string; until?: string; keepAsleep: boolean }) {
    try {
      const result = await api<{ woken: string[] }>(`/routers/${encodeURIComponent(router.name)}/pause`, { method: 'POST', body: JSON.stringify(body) });
      notice.value = { type: 'success', text: `${router.name} paused${result.woken.length ? `; waking ${result.woken.join(', ')}` : ''}.` };
    } catch (err) {
      notice.value = { type: 'error', text: (err as Error).message };
    }
    await refresh();
  }

  async function resume(router: RouterInfo) {
    try {
      await api(`/routers/${encodeURIComponent(router.name)}/resume`, { method: 'POST' });
      notice.value = { type: 'success', text: `${router.name} resumed: its workloads nap again when idle (workloads paused on their own stay paused).` };
    } catch (err) {
      notice.value = { type: 'error', text: (err as Error).message };
    }
    await refresh();
  }

  // A count of workloads in a state: the workload itself when there is one, else the list of those workloads.
  async function openWorkloads(router: string, state: string, count: number) {
    if (count === 1) {
      try {
        const { workloads } = await api<{ workloads: { workloadId: string }[] }>(`/workloads?${new URLSearchParams({ router, state, limit: '1' })}`);
        if (workloads[0]) return navigation.push(`/workloads/${encodeURIComponent(router)}/${encodeURIComponent(workloads[0].workloadId)}`);
      } catch {
        // The list below says what there is.
      }
    }
    return navigation.push({ path: '/workloads', query: { router, state } });
  }

  return { watch, operation, pause, resume, openWorkloads };
}
