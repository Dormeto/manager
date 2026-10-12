// Router events into summaries (vision scale design §4). The envelope's account (set by EventBridge: the caller's)
// identifies the router's account; its region is the router's own, in the event (the envelope carries the bus's region
// when a router publishes from another region), so a router can only speak for regions of its own account. Events can
// arrive late, twice or out of order: a newer state always wins. What they carry is checked first (clean.ts).
import { CHUNK_WORKLOADS_MAX, chunkOf, failureOf, regionOf, routerOf, stateOf, timely, transitionOf, workloadIdOf, workloadOf, type Failure } from './clean.js';
import type { FailureEntry, FleetStore, HistoryEntry, RouterSummary, WorkloadSummary } from './store.js';

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
  store: Pick<FleetStore, 'getRouter' | 'putRouter' | 'readWorkload' | 'writeWorkload' | 'deleteWorkload' | 'routerWorkloads' | 'getWorkload' | 'getFailure' | 'putFailure' | 'deleteFailure' | 'putHistory'>;
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
      // When its state began, as the router says (0.26.0: the instant of its event), else the check's time.
      const reported = typeof w.stateAt === 'string' ? w.stateAt : undefined;
      await versioned(account, region, w.workloadId as string, (existing) => {
        before = existing;
        // A newer check wrote it already; a state change newer than this check is kept.
        if ((existing?.checkedAt ?? '') > checkedAt) return (written = null);
        const newer = existing?.stateAt && existing.stateAt > checkedAt;
        const stateAt = newer ? existing.stateAt : [existing?.stateAt, reported].filter((t): t is string => !!t).sort().at(-1);
        return (written = {
          ...w, workloadId: w.workloadId as string, account, region, router: own.name, checkedAt,
          ...(newer ? { state: existing.state } : {}), ...(stateAt ? { stateAt } : {}),
          historySince: existing?.historySince ?? reported ?? checkedAt,
        });
      });
      if (!written) return;
      const summary = written as WorkloadSummary;
      // The failure index follows the summaries (a lost event made good; written on a change only).
      await syncFailure(before, summary, checkedAt);
      // The history (R8): its first entry, or a transition whose event was lost (or not in yet: it replaces this one).
      const base = { account, region, router: own.name, workloadId: summary.workloadId, to: summary.state ?? 'UNKNOWN', at: reported ?? checkedAt, inferred: true };
      if (!before?.historySince) await store.putHistory({ ...base, from: null });
      else if (before.state && before.state !== summary.state) await store.putHistory({ ...base, from: before.state });
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
          if (!read || !unlisted(read.summary) || !(await store.deleteWorkload(read.summary, read.version))) continue;
          // No longer managed (offboarded, or its target group gone): its failure leaves the index and its alert resolves.
          const failure = await store.getFailure(account, region, w.workloadId);
          if (failure) await store.deleteFailure(account, region, w.workloadId, failure.version);
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
    // The history keeps every transition, also one older than the summary (R8).
    await store.putHistory({ account, region, router, workloadId, to, at, ...transitionOf(d, at), from: stateOf(d.from) } as HistoryEntry);
    // A workload known before its history (R8) starts it with what the manager knew: its stored state, since then.
    let known: WorkloadSummary | null = null;
    await versioned(account, region, workloadId, (existing) => {
      known = existing && !existing.historySince && existing.state ? existing : null;
      return (existing?.stateAt ?? '') >= at || (existing?.checkedAt ?? '') > at
        ? (known = null) : { ...(existing ?? { account, region, router, workloadId }), state: to, stateAt: at, historySince: existing?.historySince ?? (known ? undefined : at) };
    });
    const first = known as WorkloadSummary | null;
    const since = first ? first.stateAt ?? first.checkedAt : undefined;
    if (first && since && since < at) {
      await store.putHistory({ account, region, router, workloadId, from: null, to: first.state!, at: since, inferred: true });
      await versioned(account, region, workloadId, (existing) => (existing && !existing.historySince ? { ...existing, historySince: since } : null));
    }
    // A failed wake is indexed for the watchdog (R7b), whatever comes after it before the next check; a wake that
    // succeeds removes it.
    if (to === 'FAILED') {
      const failure = failureOf(d.failure, at) ?? { kind: 'unknown', step: 'wake' as const, message: NO_REASON, at };
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
    // While a summary has a failure, the index is read at each check (failed workloads only) and written when it lacks it.
    if (now) {
      await indexFailure({
        account: after.account, region: after.region, router: after.router, workloadId: after.workloadId, name: after.name, url: after.url as string | null | undefined,
        failure: now, consecutiveFailures: after.consecutiveFailures as number | undefined, nextAttemptAt: after.nextAttemptAt as string | undefined,
      });
    } else if ((was && after.consecutiveFailures !== undefined) || (after.state === 'AWAKE' && before?.state !== 'AWAKE')) {
      // Removed when a router that reports failures (0.25.0) no longer has one (it clears it at a successful wake
      // only), or when the workload is found awake (older routers: back to ASLEEP is not a successful wake).
      await unindexFailure(after.account, after.region, after.workloadId, at);
    }
  }

  // Written when newer than what the index holds (events arrive late or twice). A failure with its reason replaces one
  // without: the change's time is a few milliseconds after the failure's own, and only routers before 0.25.0 (whose
  // summaries have no reason either) send none.
  async function indexFailure(entry: FailureEntry) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const read = await store.getFailure(entry.account, entry.region, entry.workloadId);
      const reasonFor = read && read.entry.failure.message === NO_REASON && entry.failure.message !== NO_REASON;
      if (read && read.entry.failure.at > entry.failure.at && !reasonFor) return;
      const merged = read && (read.entry.failure.at === entry.failure.at || reasonFor) ? { ...read.entry, ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) } : entry;
      if (read && JSON.stringify(merged) === JSON.stringify(read.entry)) return;
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
