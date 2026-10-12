// Phase 2 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §5): each eligible workload's
// requests per minute over 14 days (its target group's RequestCount; CloudWatch keeps one-minute data 15 days), five
// metrics per GetMetricData call (20,160 values each, under the 100,800 a call returns), every page, by each value's
// timestamp. CloudWatch publishes nothing for a minute without request: an empty series is a workload no one called; a
// metric it could not read is unreadable, never silence. Kept per account and region the same UTC day.
import { lbDimension, tgDimension, type ScanPorts } from '@dormeto/discovery';
import { freshRequests, type Cache } from './cache.js';
import { mapLimit } from './limit.js';
import type { Progress, RegionDiscovery, Workload } from './discover.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const PER_CALL = 5;

export type CloudWatchPort = NonNullable<ScanPorts['cloudwatch']>;
export interface RegionRequests {
  account: string;
  region: string;
  from: string;
  to: string;
  minutes: Record<string, [number, number][]>; // by target group ARN
  unreadable: Record<string, string>;
}

export async function readRequests(cloudwatch: CloudWatchPort, workloads: Workload[], { days, now }: { days: number; now: number }): Promise<RegionRequests> {
  const to = Math.floor(now / MIN_MS) * MIN_MS;
  const from = to - days * DAY_MS;
  const minutes: Record<string, [number, number][]> = {};
  const unreadable: Record<string, string> = {};
  // One metric per target group: a managed workload's waker too, added up to its own (R10).
  const metrics = workloads.flatMap((w, i) => [{ i, tg: w.targetGroupArn }, ...(w.wakerTargetGroupArn ? [{ i, tg: w.wakerTargetGroupArn }] : [])]);
  const counts = workloads.map(() => new Map<number, number>());
  for (let start = 0; start < metrics.length; start += PER_CALL) {
    const batch = metrics.slice(start, start + PER_CALL);
    const queries = batch.map((m, k) => ({
      Id: `m${k}`, ReturnData: true,
      MetricStat: {
        Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount', Dimensions: [{ Name: 'LoadBalancer', Value: lbDimension(workloads[m.i]!.loadBalancerArn) }, { Name: 'TargetGroup', Value: tgDimension(m.tg) }] },
        Period: 60, Stat: 'Sum',
      },
    }));
    let token: string | undefined;
    do {
      const page = await cloudwatch.getMetricData({ StartTime: new Date(from), EndTime: new Date(to), MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
      for (const result of page.MetricDataResults ?? []) {
        const m = batch[Number((result.Id ?? '').slice(1))];
        if (!m) continue;
        const w = workloads[m.i]!;
        if (result.StatusCode && result.StatusCode !== 'Complete' && result.StatusCode !== 'PartialData') {
          const why = result.Messages?.map((x) => x.Value ?? x.Code).filter(Boolean).join('; ');
          unreadable[w.targetGroupArn] = `CloudWatch could not read the requests (${result.StatusCode}${why ? `: ${why}` : ''})`;
          continue;
        }
        (result.Timestamps ?? []).forEach((timestamp, k) => {
          const value = result.Values?.[k] ?? 0;
          const minute = Math.round((new Date(timestamp).getTime() - from) / MIN_MS);
          if (value > 0 && minute >= 0 && minute < days * 1440) counts[m.i]!.set(minute, (counts[m.i]!.get(minute) ?? 0) + value);
        });
      }
      token = page.NextToken;
    } while (token);
  }
  workloads.forEach((w, i) => {
    if (!unreadable[w.targetGroupArn]) minutes[w.targetGroupArn] = [...counts[i]!].sort((a, b) => a[0] - b[0]);
  });
  return { account: workloads[0]?.account ?? '', region: workloads[0]?.region ?? '', from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes, unreadable };
}

export async function requestsAll({ regions, cloudwatchOf, cache, refresh, now, progress = () => {}, concurrency = 5 }: {
  regions: RegionDiscovery[];
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
  // Regions read at once (--parallel).
  concurrency?: number;
}): Promise<RegionRequests[]> {
  const read = await mapLimit(regions, concurrency, (region) => regionRequests(region, { cloudwatchOf, cache, refresh, now, progress }));
  return read.filter((r): r is RegionRequests => r !== null);
}

// One region's requests: kept, read, or unreadable with AWS's reason; null for a region without workload or that failed.
async function regionRequests(region: RegionDiscovery, { cloudwatchOf, cache, refresh, now, progress }: {
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>; cache: Cache; refresh: 'discovery' | 'metrics' | null; now: () => number; progress: Progress;
}): Promise<RegionRequests | null> {
  if (region.error || !region.workloads.length) return null;
  const path = `requests/${region.account}-${region.region}.json`;
  const kept = refresh ? null : await cache.get<RegionRequests>(path, freshRequests(now()));
  // Kept only while it covers every workload discovery found (a new one since: read again).
  if (kept && region.workloads.every((w) => w.targetGroupArn in kept.minutes || w.targetGroupArn in kept.unreadable)) {
    progress({ phase: 'requests', account: region.account, region: region.region, from: 'cache', workloads: region.workloads.length });
    return kept;
  }
  let read: RegionRequests;
  try {
    read = await readRequests(await cloudwatchOf(region.account, region.region), region.workloads, { days: 14, now: now() });
    await cache.put(path, read);
  } catch (err) {
    // A region whose requests cannot be read at all (a denial, throttling, expired credentials): its workloads are
    // unreadable with AWS's reason, nothing is kept, and the run goes on.
    const why = `${(err as Error).name}: ${(err as Error).message}`;
    const to = Math.floor(now() / MIN_MS) * MIN_MS;
    read = {
      account: region.account, region: region.region, from: new Date(to - 14 * DAY_MS).toISOString(), to: new Date(to).toISOString(),
      minutes: {}, unreadable: Object.fromEntries(region.workloads.map((w) => [w.targetGroupArn, why])),
    };
    progress({ phase: 'requests', account: region.account, region: region.region, from: 'aws', workloads: region.workloads.length, error: why });
    return read;
  }
  progress({ phase: 'requests', account: region.account, region: region.region, from: 'aws', workloads: region.workloads.length });
  return read;
}
