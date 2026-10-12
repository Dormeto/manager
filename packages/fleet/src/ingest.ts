// Router events into summaries (vision scale design §4). The envelope's account (set by EventBridge: the caller's)
// identifies the router's account; its region is the router's own, in the event (the envelope carries the bus's region
// when a router publishes from another region), so a router can only speak for regions of its own account. Events can
// arrive late, twice or out of order: a newer state always wins. What they carry is checked first (clean.ts).
import { CHUNK_WORKLOADS_MAX, chunkOf, regionOf, routerOf, stateOf, timely, workloadIdOf, workloadOf } from './clean.js';
import type { FleetStore, RouterSummary } from './store.js';

// Workloads of a chunk written at once: a chunk holds about 90, a backlog of chunks drains within the Lambda timeout.
const WRITES = 10;

// Work on the items, at most `limit` at once; the first failure fails the whole (the event comes back).
async function eachAtOnce<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

export interface RouterEvent {
  account: string;
  region: string;
  'detail-type': string;
  detail: any;
}

export function createIngest({ store, now = Date.now, log }: {
  store: Pick<FleetStore, 'getRouter' | 'putRouter' | 'getWorkload' | 'putWorkload' | 'deleteWorkload' | 'routerWorkloads'>;
  now?: () => number;
  log?: { warn: (event: string, data: object) => void };
}) {
  // Dropped, not retried: the same event would be refused again.
  const refuse = (event: RouterEvent, reason: string) => log?.warn('RouterEventRefused', { account: event.account, detailType: event['detail-type'], reason });

  // One chunk of a router's state after an idle check: its workloads first, then the chunk counted; the last chunk in
  // removes the workloads the check no longer lists.
  async function checked(event: RouterEvent) {
    const { account, region: envelope, detail } = event;
    const d = detail ?? {};
    const checkedAt = timely(d.checkedAt, now());
    const chunk = chunkOf(d.chunk);
    const own = routerOf(d);
    if (!checkedAt || !chunk || !own.name) return refuse(event, !checkedAt ? `check time ${String(d.checkedAt).slice(0, 40)}` : !chunk ? 'chunk' : 'router name');
    const region = regionOf(d.router?.region) ?? envelope;
    const current = await store.getRouter(account, region);
    if (current && current.summary.check.checkedAt > checkedAt) return;
    const listed: unknown[] = Array.isArray(d.workloads) ? d.workloads.slice(0, CHUNK_WORKLOADS_MAX) : [];
    const workloads = listed.map(workloadOf).filter((w): w is Record<string, unknown> => w !== null);
    await eachAtOnce(workloads, WRITES, async (w) => {
      const existing = await store.getWorkload(account, region, w.workloadId as string);
      // A state change newer than this check is kept.
      const newer = existing?.stateAt && existing.stateAt > checkedAt;
      await store.putWorkload({
        ...w, workloadId: w.workloadId as string, account, region, router: own.name, checkedAt,
        ...(newer ? { state: existing.state, stateAt: existing.stateAt } : existing?.stateAt ? { stateAt: existing.stateAt } : {}),
      });
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const stored = attempt === 0 ? current : await store.getRouter(account, region);
      const check = stored?.summary.check;
      if (check && check.checkedAt > checkedAt) return;
      const received = check && check.checkedAt === checkedAt ? [...new Set([...check.received, chunk.index])] : [chunk.index];
      const summary: RouterSummary = { account, region, ...own, checkedAt, check: { checkedAt, total: chunk.total, received } };
      if (!(await store.putRouter(summary, stored?.version ?? 0))) continue;
      if (received.length === chunk.total) {
        for (const w of await store.routerWorkloads(account, region)) {
          if ((w.checkedAt ?? '') < checkedAt && (w.stateAt ?? '') < checkedAt) await store.deleteWorkload(w);
        }
      }
      return;
    }
    throw new Error(`router ${account}/${region}: summary kept changing`);
  }

  // A state change, at once; ignored when the workload already shows a newer state (a later change or check).
  async function stateChanged(event: RouterEvent) {
    const { account, region: envelope, detail } = event;
    const d = detail ?? {};
    const at = timely(d.at, now());
    const workloadId = workloadIdOf(d.workloadId);
    const to = stateOf(d.to);
    const router = typeof d.router === 'string' ? d.router.slice(0, 64) : null;
    if (!at || !workloadId || !to || !router) return refuse(event, !at ? `change time ${String(d.at).slice(0, 40)}` : 'workload, state or router');
    const region = regionOf(d.region) ?? envelope;
    const existing = await store.getWorkload(account, region, workloadId);
    if ((existing?.stateAt ?? '') >= at || (existing?.checkedAt ?? '') > at) return;
    await store.putWorkload({ ...(existing ?? { account, region, router, workloadId }), state: to, stateAt: at });
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
