// The measured uptime of EC2 instances without an Auto Scaling group (vision docs/specs/2026-10-10-savings-estimate-design.md
// §5, --ec2-uptime): when each ran over its region's requests period, from its CPUUtilization — EC2 publishes it every
// 5 minutes while an instance runs and nothing while it is stopped (detailed monitoring adds up to the same 5 minutes).
// Twenty instances per GetMetricData call (4,032 values each over 14 days, under the 100,800 a call returns), every
// page. A metric CloudWatch could not read is unreadable, never a stop. Instances Dormeto manages are not measured: their
// uptime is already its naps. Kept per account and region the same UTC day.
import { freshRequests, type Cache } from './cache.js';
import type { Progress, RegionDiscovery, Workload } from './discover.js';
import type { CloudWatchPort, RegionRequests } from './requests.js';

const MIN_MS = 60_000;
const PERIOD_MINUTES = 5;
const PER_CALL = 20;

export interface RegionUptime {
  account: string;
  region: string;
  from: string;
  to: string;
  // By instance id: when it ran, [start, end) in minutes from `from`, sorted and disjoint.
  running: Record<string, [number, number][]>;
  unreadable: Record<string, string>;
}

// The instances measured: without an Auto Scaling group, not managed by Dormeto.
export const measured = (w: Workload) => w.backend.kind === 'instance' && !w.managed;

export async function readUptime(cloudwatch: CloudWatchPort, instances: string[], { from, to }: { from: string; to: string }): Promise<Pick<RegionUptime, 'running' | 'unreadable'>> {
  const start = Date.parse(from);
  const end = Math.round((Date.parse(to) - start) / MIN_MS);
  const minutes = new Map<string, number[]>(instances.map((id) => [id, []]));
  const unreadable: Record<string, string> = {};
  for (let first = 0; first < instances.length; first += PER_CALL) {
    const batch = instances.slice(first, first + PER_CALL);
    const queries = batch.map((id, k) => ({
      Id: `u${k}`, ReturnData: true,
      MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: id }] }, Period: PERIOD_MINUTES * 60, Stat: 'SampleCount' },
    }));
    let token: string | undefined;
    do {
      const page = await cloudwatch.getMetricData({ StartTime: new Date(from), EndTime: new Date(to), MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
      for (const result of page.MetricDataResults ?? []) {
        const id = batch[Number((result.Id ?? '').slice(1))];
        if (!id) continue;
        if (result.StatusCode && result.StatusCode !== 'Complete' && result.StatusCode !== 'PartialData') {
          const why = result.Messages?.map((x) => x.Value ?? x.Code).filter(Boolean).join('; ');
          unreadable[id] = `CloudWatch could not read the uptime (${result.StatusCode}${why ? `: ${why}` : ''})`;
          continue;
        }
        (result.Timestamps ?? []).forEach((timestamp, k) => {
          if ((result.Values?.[k] ?? 0) > 0) minutes.get(id)!.push(Math.round((new Date(timestamp).getTime() - start) / MIN_MS));
        });
      }
      token = page.NextToken;
    } while (token);
  }
  // Each datapoint: running its 5 minutes; consecutive ones joined.
  const running: Record<string, [number, number][]> = {};
  for (const [id, starts] of minutes) {
    if (unreadable[id]) continue;
    const periods: [number, number][] = [];
    for (const m of [...new Set(starts)].sort((a, b) => a - b)) {
      const [a, b] = [Math.max(0, m), Math.min(end, m + PERIOD_MINUTES)];
      if (a >= b) continue;
      const last = periods.at(-1);
      if (last && last[1] >= a) last[1] = Math.max(last[1], b);
      else periods.push([a, b]);
    }
    running[id] = periods;
  }
  return { running, unreadable };
}

export async function uptimeAll({ regions, requests, cloudwatchOf, cache, refresh, now, progress = () => {} }: {
  regions: RegionDiscovery[];
  requests: RegionRequests[];
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
}): Promise<RegionUptime[]> {
  const out: RegionUptime[] = [];
  for (const region of regions) {
    const instances = [...new Set(region.workloads.filter(measured).map((w) => w.backend.id))];
    const period = requests.find((r) => r.account === region.account && r.region === region.region);
    if (!instances.length || !period) continue;
    const where = { account: region.account, region: region.region };
    const path = `uptime/${region.account}-${region.region}.json`;
    const kept = refresh ? null : await cache.get<RegionUptime>(path, freshRequests(now()));
    // Kept while it measures the same period and every instance.
    if (kept && kept.from === period.from && instances.every((id) => id in kept.running || id in kept.unreadable)) {
      out.push(kept);
      progress({ phase: 'uptime', ...where, from: 'cache', workloads: instances.length });
      continue;
    }
    let read: RegionUptime;
    try {
      read = { ...where, from: period.from, to: period.to, ...(await readUptime(await cloudwatchOf(region.account, region.region), instances, period)) };
      await cache.put(path, read);
      progress({ phase: 'uptime', ...where, from: 'aws', workloads: instances.length });
    } catch (err) {
      // Not read at all (a denial, throttling): its instances unreadable with AWS's reason, nothing kept, the run goes on.
      const why = `${(err as Error).name}: ${(err as Error).message}`;
      read = { ...where, from: period.from, to: period.to, running: {}, unreadable: Object.fromEntries(instances.map((id) => [id, why])) };
      progress({ phase: 'uptime', ...where, from: 'aws', workloads: instances.length, error: why });
    }
    out.push(read);
  }
  return out;
}
