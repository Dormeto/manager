// The measured uptime of EC2 instances without an Auto Scaling group (vision docs/specs/2026-10-10-savings-estimate-design.md
// §5, --ec2-uptime) and of ECS services (--ecs-uptime; --uptime both): when each ran over its region's requests period,
// from its CPUUtilization — EC2 publishes an instance's every 5 minutes while it runs (detailed monitoring adds up to the
// same 5 minutes), ECS a service's every minute while it has a task, and nothing while stopped or at 0 tasks (read on
// dev's ECS demo). Twenty per GetMetricData call (4,032 values each over 14 days, under the 100,800 a call returns),
// every page. A metric CloudWatch could not read is unreadable, never a stop. What Dormeto manages is not measured: its
// uptime is already its naps. Kept per account and region the same UTC day.
import { freshRequests, type Cache } from './cache.js';
import { mapLimit } from './limit.js';
import { clusterOf, type Progress, type RegionDiscovery, type Workload } from './discover.js';
import type { CloudWatchPort, RegionRequests } from './requests.js';

const MIN_MS = 60_000;
const PERIOD_MINUTES = 5;
const PER_CALL = 20;

export interface RegionUptime {
  account: string;
  region: string;
  from: string;
  to: string;
  // By instance id or service ARN: when it ran, [start, end) in minutes from `from`, sorted and disjoint.
  running: Record<string, [number, number][]>;
  unreadable: Record<string, string>;
}

// What each option measures: EC2 instances without an Auto Scaling group (ec2), ECS services (ecs), never what Dormeto
// manages.
export interface UptimeKinds { ec2: boolean; ecs: boolean; rds?: boolean }
export const measured = (w: Workload, kinds: UptimeKinds = { ec2: true, ecs: false }) =>
  !w.managed && ((kinds.ec2 && w.backend.kind === 'instance') || (kinds.ecs && w.backend.kind === 'ecs'));

// An instance by its id; an ECS service (arn:aws:ecs:...:service/<cluster>/<service>) by its cluster and name; a
// companion database (rds-instance:<id>, rds-cluster:<id>) by its identifier (RDS publishes every minute while it is
// available, nothing while it is stopped).
const metricOf = (id: string) => {
  if (id.startsWith('rds-instance:')) return { Namespace: 'AWS/RDS', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'DBInstanceIdentifier', Value: id.slice('rds-instance:'.length) }] };
  if (id.startsWith('rds-cluster:')) return { Namespace: 'AWS/RDS', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'DBClusterIdentifier', Value: id.slice('rds-cluster:'.length) }] };
  return id.startsWith('arn:') && id.split(':')[2] === 'ecs'
    ? { Namespace: 'AWS/ECS', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'ClusterName', Value: clusterOf(id) }, { Name: 'ServiceName', Value: id.split('/').at(-1)! }] }
    : { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: id }] };
};
// A companion database's key in the uptime: its kind and identifier.
export const databaseKey = (d: { kind: string; id: string }) => `${d.kind}:${d.id}`;

export async function readUptime(cloudwatch: CloudWatchPort, ids: string[], { from, to }: { from: string; to: string }): Promise<Pick<RegionUptime, 'running' | 'unreadable'>> {
  const start = Date.parse(from);
  const end = Math.round((Date.parse(to) - start) / MIN_MS);
  const minutes = new Map<string, number[]>(ids.map((id) => [id, []]));
  const unreadable: Record<string, string> = {};
  for (let first = 0; first < ids.length; first += PER_CALL) {
    const batch = ids.slice(first, first + PER_CALL);
    const queries = batch.map((id, k) => ({
      Id: `u${k}`, ReturnData: true,
      MetricStat: { Metric: metricOf(id), Period: PERIOD_MINUTES * 60, Stat: 'SampleCount' },
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

export async function uptimeAll({ regions, requests, cloudwatchOf, cache, refresh, now, progress = () => {}, kinds = { ec2: true, ecs: false }, concurrency = 5, onPlan = () => {}, onStart = () => {} }: {
  regions: RegionDiscovery[];
  requests: RegionRequests[];
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
  kinds?: UptimeKinds;
  // Regions read at once (--parallel).
  concurrency?: number;
  // The phase's progress: how many regions are measured, when each starts.
  onPlan?: (count: number) => void;
  onStart?: (account: string, region: string) => void;
}): Promise<RegionUptime[]> {
  // The regions with something measured, over their requests period.
  const toRead = regions.flatMap((region) => {
    const ids = [...new Set([
      ...region.workloads.filter((w) => measured(w, kinds)).map((w) => w.backend.id),
      ...(kinds.rds ? (region.databases ?? []).filter((d) => !d.notStoppable).map(databaseKey) : []),
    ])];
    const period = requests.find((r) => r.account === region.account && r.region === region.region);
    return ids.length && period ? [{ region, ids, period }] : [];
  });
  onPlan(toRead.length);
  return mapLimit(toRead, concurrency, (r) => {
    onStart(r.region.account, r.region.region);
    return regionUptime(r, { cloudwatchOf, cache, refresh, now, progress });
  });
}

// One region's uptime: kept, read, or unreadable with AWS's reason.
async function regionUptime({ region, ids, period }: { region: RegionDiscovery; ids: string[]; period: RegionRequests }, { cloudwatchOf, cache, refresh, now, progress }: {
  cloudwatchOf: (account: string, region: string) => Promise<CloudWatchPort>; cache: Cache; refresh: 'discovery' | 'metrics' | null; now: () => number; progress: Progress;
}): Promise<RegionUptime> {
  const where = { account: region.account, region: region.region };
  const path = `uptime/${region.account}-${region.region}.json`;
  const kept = refresh ? null : await cache.get<RegionUptime>(path, freshRequests(now()));
  // Kept while it measures the same period and every instance.
  if (kept && kept.from === period.from && ids.every((id) => id in kept.running || id in kept.unreadable)) {
    progress({ phase: 'uptime', ...where, from: 'cache', workloads: ids.length });
    return kept;
  }
  let read: RegionUptime;
  try {
    read = { ...where, from: period.from, to: period.to, ...(await readUptime(await cloudwatchOf(region.account, region.region), ids, period)) };
    await cache.put(path, read);
    progress({ phase: 'uptime', ...where, from: 'aws', workloads: ids.length });
  } catch (err) {
    // Not read at all (a denial, throttling): its instances and services unreadable with AWS's reason, nothing kept, the run goes on.
    const why = `${(err as Error).name}: ${(err as Error).message}`;
    read = { ...where, from: period.from, to: period.to, running: {}, unreadable: Object.fromEntries(ids.map((id) => [id, why])) };
    progress({ phase: 'uptime', ...where, from: 'aws', workloads: ids.length, error: why });
  }
  return read;
}
