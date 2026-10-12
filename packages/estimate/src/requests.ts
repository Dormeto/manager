// Phase 2 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §5): each eligible workload's
// requests per minute over 14 days (its target group's RequestCount; CloudWatch keeps one-minute data 15 days), five
// workloads per GetMetricData call (20,160 values each, under the 100,800 a call returns), every page, by each value's
// timestamp. CloudWatch publishes nothing for a minute without request: an empty series is a workload no one called; a
// metric it could not read is unreadable, never silence. Kept per account and region the same UTC day.
import { lbDimension, tgDimension, type ScanPorts } from '@dormeto/discovery';
import { freshRequests, type Cache } from './cache.js';
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
  for (let start = 0; start < workloads.length; start += PER_CALL) {
    const batch = workloads.slice(start, start + PER_CALL);
    const counts = batch.map(() => new Map<number, number>());
    const queries = batch.map((w, i) => ({
      Id: `w${i}`, ReturnData: true,
      MetricStat: {
        Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount', Dimensions: [{ Name: 'LoadBalancer', Value: lbDimension(w.loadBalancerArn) }, { Name: 'TargetGroup', Value: tgDimension(w.targetGroupArn) }] },
        Period: 60, Stat: 'Sum',
      },
    }));
    let token: string | undefined;
    do {
      const page = await cloudwatch.getMetricData({ StartTime: new Date(from), EndTime: new Date(to), MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
      for (const result of page.MetricDataResults ?? []) {
        const i = Number((result.Id ?? '').slice(1));
        const w = batch[i];
        if (!w) continue;
        if (result.StatusCode && result.StatusCode !== 'Complete' && result.StatusCode !== 'PartialData') {
          const why = result.Messages?.map((m) => m.Value ?? m.Code).filter(Boolean).join('; ');
          unreadable[w.targetGroupArn] = `CloudWatch could not read the requests (${result.StatusCode}${why ? `: ${why}` : ''})`;
          continue;
        }
        (result.Timestamps ?? []).forEach((timestamp, k) => {
          const value = result.Values?.[k] ?? 0;
          const m = Math.round((new Date(timestamp).getTime() - from) / MIN_MS);
          if (value > 0 && m >= 0 && m < days * 1440) counts[i]!.set(m, (counts[i]!.get(m) ?? 0) + value);
        });
      }
      token = page.NextToken;
    } while (token);
    batch.forEach((w, i) => {
      if (!unreadable[w.targetGroupArn]) minutes[w.targetGroupArn] = [...counts[i]!].sort((a, b) => a[0] - b[0]);
    });
  }
  return { account: workloads[0]?.account ?? '', region: workloads[0]?.region ?? '', from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes, unreadable };
}

export async function requestsAll({ regions, cloudwatchOf, cache, refresh, now, progress = () => {} }: {
  regions: RegionDiscovery[];
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
}): Promise<RegionRequests[]> {
  const out: RegionRequests[] = [];
  for (const region of regions) {
    if (region.error || !region.workloads.length) continue;
    const path = `requests/${region.account}-${region.region}.json`;
    const kept = refresh ? null : await cache.get<RegionRequests>(path, freshRequests(now()));
    // Kept only while it covers every workload discovery found (a new one since: read again).
    if (kept && region.workloads.every((w) => w.targetGroupArn in kept.minutes || w.targetGroupArn in kept.unreadable)) {
      out.push(kept);
      progress({ phase: 'requests', account: region.account, region: region.region, from: 'cache', workloads: region.workloads.length });
      continue;
    }
    const read = await readRequests(await cloudwatchOf(region.account, region.region), region.workloads, { days: 14, now: now() });
    await cache.put(path, read);
    out.push(read);
    progress({ phase: 'requests', account: region.account, region: region.region, from: 'aws', workloads: region.workloads.length });
  }
  return out;
}
