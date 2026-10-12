// Router events into summaries (vision scale design §4). The envelope's account and region identify the router; the
// payload never does. Events can arrive late, twice or out of order: a newer state always wins.
import type { FleetStore, RouterSummary } from './store.js';

export interface RouterEvent {
  account: string;
  region: string;
  'detail-type': string;
  detail: any;
}

export function createIngest({ store }: { store: Pick<FleetStore, 'getRouter' | 'putRouter' | 'getWorkload' | 'putWorkload' | 'deleteWorkload' | 'routerWorkloads'> }) {
  // One chunk of a router's state after an idle check: its workloads first, then the chunk counted; the last chunk in
  // removes the workloads the check no longer lists.
  async function checked({ account, region, detail: d }: RouterEvent) {
    const current = await store.getRouter(account, region);
    if (current && current.summary.check.checkedAt > d.checkedAt) return;
    for (const w of d.workloads ?? []) {
      const existing = await store.getWorkload(account, region, w.workloadId);
      // A state change newer than this check is kept.
      const newer = existing?.stateAt && existing.stateAt > d.checkedAt;
      await store.putWorkload({
        ...w, account, region, router: d.router.name, checkedAt: d.checkedAt,
        ...(newer ? { state: existing.state, stateAt: existing.stateAt } : existing?.stateAt ? { stateAt: existing.stateAt } : {}),
      });
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const now = attempt === 0 ? current : await store.getRouter(account, region);
      const check = now?.summary.check;
      if (check && check.checkedAt > d.checkedAt) return;
      const received = check && check.checkedAt === d.checkedAt ? [...new Set([...check.received, d.chunk.index])] : [d.chunk.index];
      const summary: RouterSummary = {
        account, region, name: d.router.name, version: d.router.version ?? null, build: d.router.build ?? null, checkSchedule: d.router.checkSchedule ?? null,
        checkedAt: d.checkedAt, durationMs: d.durationMs ?? null, health: d.health ?? null, pauses: d.pauses ?? [], counts: d.counts ?? {},
        check: { checkedAt: d.checkedAt, total: d.chunk.total, received },
      };
      if (!(await store.putRouter(summary, now?.version ?? 0))) continue;
      if (received.length === d.chunk.total) {
        for (const w of await store.routerWorkloads(account, region)) {
          if ((w.checkedAt ?? '') < d.checkedAt && (w.stateAt ?? '') < d.checkedAt) await store.deleteWorkload(w);
        }
      }
      return;
    }
    throw new Error(`router ${account}/${region}: summary kept changing`);
  }

  // A state change, at once; ignored when the workload already shows a newer state (a later change or check).
  async function stateChanged({ account, region, detail: d }: RouterEvent) {
    const existing = await store.getWorkload(account, region, d.workloadId);
    if ((existing?.stateAt ?? '') >= d.at || (existing?.checkedAt ?? '') > d.at) return;
    await store.putWorkload({ ...(existing ?? { account, region, router: d.router, workloadId: d.workloadId }), state: d.to, stateAt: d.at });
  }

  return async function ingest(event: RouterEvent) {
    if (event['detail-type'] === 'Router checked') return checked(event);
    if (event['detail-type'] === 'Workload state changed') return stateChanged(event);
  };
}

// Records of the queue, each on its own: the failed ones come back (partial batch response).
export async function processRecords(records: { messageId: string; body: string }[], ingest: (event: RouterEvent) => Promise<unknown>, log: { warn: (event: string, data: object) => void }) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    try {
      await ingest(JSON.parse(record.body) as RouterEvent);
    } catch (err) {
      log.warn('RouterEventFailed', { messageId: record.messageId, error: (err as Error).message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
