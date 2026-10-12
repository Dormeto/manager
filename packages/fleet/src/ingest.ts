// Router events into summaries (vision scale design §4). The envelope's account (set by EventBridge: the caller's)
// identifies the router's account; its region is the router's own, in the event (the envelope carries the bus's region
// when a router publishes from another region), so a router can only speak for regions of its own account. Events can
// arrive late, twice or out of order: a newer state always wins. What they carry is checked first (clean.ts).
import { CHUNK_WORKLOADS_MAX, chunkOf, failureOf, regionOf, routerOf, stateOf, timely, workloadIdOf, workloadOf, type Failure } from './clean.js';
import type { FailureEntry, FleetStore, RouterSummary, WorkloadSummary } from './store.js';

// A router before 0.25.0 says a workload FAILED, never why.
const NO_REASON = 'the wake failed (a router older than 0.25.0 gives no reason)';

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
  store: Pick<FleetStore, 'getRouter' | 'putRouter' | 'readWorkload' | 'writeWorkload' | 'deleteWorkload' | 'routerWorkloads' | 'getWorkload' | 'getFailure' | 'putFailure' | 'deleteFailure'>;
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
      let before: WorkloadSummary | undefined;
      let written: WorkloadSummary | null = null;
      await versioned(account, region, w.workloadId as string, (existing) => {
        before = existing;
        // A newer check wrote it already; a state change newer than this check is kept.
        if ((existing?.checkedAt ?? '') > checkedAt) return (written = null);
        const newer = existing?.stateAt && existing.stateAt > checkedAt;
        return (written = {
          ...w, workloadId: w.workloadId as string, account, region, router: own.name, checkedAt,
          ...(newer ? { state: existing.state, stateAt: existing.stateAt } : existing?.stateAt ? { stateAt: existing.stateAt } : {}),
        });
      });
      // The failure index follows the summaries (a lost event made good; written on a change only).
      if (written) await syncFailure(before, written, checkedAt);
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const stored = attempt === 0 ? current : await store.getRouter(account, region);
      const check = stored?.summary.check;
      if (check && check.checkedAt > checkedAt) return;
      const received = check && check.checkedAt === checkedAt ? [...new Set([...check.received, chunk.index])] : [chunk.index];
      const summary: RouterSummary = { account, region, ...own, checkedAt, check: { checkedAt, total: chunk.total, received } };
      if (!(await store.putRouter(summary, stored?.version ?? 0))) continue;
      if (received.length === chunk.total) {
        // Read again before the delete, which is refused if it changed since: a state change landing meanwhile stays.
        const unlisted = (w: WorkloadSummary) => (w.checkedAt ?? '') < checkedAt && (w.stateAt ?? '') < checkedAt;
        for (const w of (await store.routerWorkloads(account, region)).filter(unlisted)) {
          const read = await store.readWorkload(account, region, w.workloadId);
          if (read && unlisted(read.summary)) await store.deleteWorkload(read.summary, read.version);
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
    await versioned(account, region, workloadId, (existing) => ((existing?.stateAt ?? '') >= at || (existing?.checkedAt ?? '') > at
      ? null : { ...(existing ?? { account, region, router, workloadId }), state: to, stateAt: at }));
    // A failed wake is indexed for the watchdog (R7b), whatever comes after it before the next check; a wake that
    // succeeds removes it.
    if (to === 'FAILED') {
      const failure = failureOf(d.failure) ?? { kind: 'unknown', step: 'wake' as const, message: NO_REASON, at };
      const summary = await store.getWorkload(account, region, workloadId);
      await indexFailure({ account, region, router, workloadId, name: summary?.name, url: summary?.url as string | null | undefined, wakeId: typeof d.wakeId === 'string' ? d.wakeId.slice(0, 64) : undefined, failure });
    } else if (to === 'AWAKE') {
      await unindexFailure(account, region, workloadId, at);
    }
  }

  // The failure a summary shows: the router's record (0.25.0), or FAILED without a reason (older routers).
  const failureIn = (w: WorkloadSummary | undefined, at: string): Failure | undefined => (!w ? undefined
    : (w.failure as Failure | undefined) ?? (w.state === 'FAILED' ? { kind: 'unknown', step: 'wake', message: NO_REASON, at: (w.failedAt as string | undefined) ?? at } : undefined));

  async function syncFailure(before: WorkloadSummary | undefined, after: WorkloadSummary, at: string) {
    const now = failureIn(after, at);
    const was = failureIn(before, at);
    if (now && now.at !== was?.at) {
      await indexFailure({
        account: after.account, region: after.region, router: after.router, workloadId: after.workloadId, name: after.name, url: after.url as string | null | undefined,
        failure: now, consecutiveFailures: after.consecutiveFailures as number | undefined, nextAttemptAt: after.nextAttemptAt as string | undefined,
      });
    } else if (!now && was) {
      await unindexFailure(after.account, after.region, after.workloadId, at);
    }
  }

  // Written when newer than what the index holds (events arrive late or twice).
  async function indexFailure(entry: FailureEntry) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const read = await store.getFailure(entry.account, entry.region, entry.workloadId);
      if (read && read.entry.failure.at > entry.failure.at) return;
      const merged = read && read.entry.failure.at === entry.failure.at ? { ...read.entry, ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) } : entry;
      if (await store.putFailure(merged as FailureEntry, read?.version ?? 0)) return;
    }
  }

  // Removed unless it is newer than what removes it (a stale success leaves a later failure).
  async function unindexFailure(account: string, region: string, id: string, at: string) {
    const read = await store.getFailure(account, region, id);
    if (read && read.entry.failure.at <= at) await store.deleteFailure(account, region, id, read.version);
  }

  // Read, decide (null: nothing to write) and write a workload's summary, again when another event changed it meanwhile.
  async function versioned(account: string, region: string, id: string, next: (existing: WorkloadSummary | undefined) => WorkloadSummary | null) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const read = await store.readWorkload(account, region, id);
      const summary = next(read?.summary);
      if (!summary || (await store.writeWorkload(summary, read?.version ?? 0))) return;
    }
    throw new Error(`workload ${account}/${region}/${id}: summary kept changing`);
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
