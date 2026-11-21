// A standalone workload's activity over its last days (vision standalone workloads design §4, §6, §7): its idle signals' 5-minute
// points read from CloudWatch, as the router reads them (router lambda/src/lib/activity.mjs plan: the queries by backend kind,
// how series combine), and the points the idle window advisor replays as activity: a point is busy when a signal that applies
// is at or over its threshold, or has no point while the workload was awake.
import type { RequestMinutes } from './idle.js';

// The windows tried for a standalone workload: 5 minutes to 24 hours (its idle window's range).
export const STANDALONE_WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
// The knee is chosen from 5 minutes to the built-in 2 hours (M47 ruling): each longer window only avoids the stops of longer
// quiet times (nights, weekends), so the knee alone would choose a day, awake through every night; they are shown to compare.
export const STANDALONE_RECOMMENDABLE = STANDALONE_WINDOWS.filter((m) => m <= 120);
export const PERIOD_MS = 5 * 60_000;
const PERIOD_MINUTES = 5;
// CloudWatch publishes a point minutes after its period (activity.mjs METRIC_LAG_MS).
export const METRIC_LAG_MS = 10 * 60_000;
const RESOURCE = '${resource}';

export interface ActivityBackend { kind: string; id: string; companion?: boolean }
export interface IdleMetric { namespace: string; name: string; dimensions: Record<string, string> | Record<string, string>[]; statistic: string; below: number }
export interface ActivitySettings { idleCpuPercent?: number | 'off'; idleNetworkBytes?: number | 'off'; idleMetric?: IdleMetric | 'off' }
export interface ActivityQuery { id: string; namespace: string; name: string; dimensions: { Name: string; Value: string }[]; stat: string }
// How a signal's queries make one value a point: each series the sum of its queries, scaled to the signal's unit; the
// largest series is the signal's value (the router's `measured`).
// percent: Google Cloud's CPU utilization, a ratio (× 100).
export type Scale = 'same' | 'ec2PerMinute' | 'rdsPerMinute' | 'percent';
export interface PlannedSignal { signal: 'cpu' | 'network' | 'metric'; below: number | null; applies: boolean; reason?: string; series: { ids: string[]; scale: Scale }[] }

const lastSegment = (arn: string) => String(arn).split('/').at(-1)!;
const isDatabase = (b: ActivityBackend) => b.kind === 'rds-instance' || b.kind === 'rds-cluster';
const rdsDimension = (b: ActivityBackend) => ({ Name: b.kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier', Value: b.id });
// An ECS service's ARN is service/<cluster>/<name> (service/<name> in the default cluster).
const ecsCluster = (arn: string) => {
  const path = arn.split(':service/')[1] ?? '';
  return path.includes('/') ? path.split('/')[0]! : 'default';
};
const resourceIdOf = (b: ActivityBackend) => (b.kind === 'ecs' ? lastSegment(b.id) : b.id);

function cpuOf(b: ActivityBackend): { namespace: string; dimensions: ActivityQuery['dimensions'] } | null {
  if (b.kind === 'instance') return { namespace: 'AWS/EC2', dimensions: [{ Name: 'InstanceId', Value: b.id }] };
  if (b.kind === 'asg') return { namespace: 'AWS/EC2', dimensions: [{ Name: 'AutoScalingGroupName', Value: b.id }] };
  if (b.kind === 'ecs') return { namespace: 'AWS/ECS', dimensions: [{ Name: 'ClusterName', Value: ecsCluster(b.id) }, { Name: 'ServiceName', Value: lastSegment(b.id) }] };
  if (isDatabase(b)) return { namespace: 'AWS/RDS', dimensions: [rdsDimension(b)] };
  return null;
}
function networkOf(b: ActivityBackend): { namespace: string; names: [string, string]; stat: string; dimensions: ActivityQuery['dimensions']; scale: Scale } | null {
  if (b.kind === 'instance' || b.kind === 'asg') return { namespace: 'AWS/EC2', names: ['NetworkIn', 'NetworkOut'], stat: 'Sum', dimensions: cpuOf(b)!.dimensions, scale: 'ec2PerMinute' };
  if (isDatabase(b)) return { namespace: 'AWS/RDS', names: ['NetworkReceiveThroughput', 'NetworkTransmitThroughput'], stat: 'Average', dimensions: [rdsDimension(b)], scale: 'rdsPerMinute' };
  return null;
}

// The signals of a workload's resolved settings and their queries (the router's plan): CPU and network are its own
// backends' (its database's when its resource is the database), the metric's ${resource} its own id.
export function activityPlan(backends: ActivityBackend[], settings: ActivitySettings): { signals: PlannedSignal[]; queries: ActivityQuery[] } {
  const primaries = backends.filter((b) => !isDatabase(b));
  const own = primaries.length ? primaries : backends.filter(isDatabase);
  const signals: PlannedSignal[] = [];
  const queries: ActivityQuery[] = [];
  const off = (signal: PlannedSignal['signal'], below: number | null, reason: string): PlannedSignal => ({ signal, below, applies: false, reason, series: [] });

  const cpu = settings.idleCpuPercent ?? 'off';
  if (cpu === 'off') signals.push(off('cpu', null, 'off'));
  else if (!own.length) signals.push(off('cpu', cpu, 'no backend to read'));
  else {
    signals.push({ signal: 'cpu', below: cpu, applies: true, series: own.map((b, i) => {
      const m = cpuOf(b)!;
      queries.push({ id: `cpu_${i}`, namespace: m.namespace, name: 'CPUUtilization', dimensions: m.dimensions, stat: 'Maximum' });
      return { ids: [`cpu_${i}`], scale: 'same' as const };
    }) });
  }

  const network = settings.idleNetworkBytes ?? 'off';
  if (network === 'off') signals.push(off('network', null, 'off'));
  else {
    const read = own.map((b, i) => [i, networkOf(b)] as const).filter(([, m]) => m);
    if (!read.length) signals.push(off('network', network, own.length ? 'an ECS service has no network metric without Container Insights' : 'no backend to read'));
    else {
      signals.push({ signal: 'network', below: network, applies: true, series: read.map(([i, m]) => ({
        ids: m!.names.map((name, k) => {
          const id = `net_${i}_${k ? 'out' : 'in'}`;
          queries.push({ id, namespace: m!.namespace, name, dimensions: m!.dimensions, stat: m!.stat });
          return id;
        }),
        scale: m!.scale,
      })) });
    }
  }

  const metric = settings.idleMetric ?? 'off';
  if (metric === 'off') signals.push(off('metric', null, 'off'));
  else {
    const resource = own[0] ? resourceIdOf(own[0]) : null;
    const sets = Array.isArray(metric.dimensions) ? metric.dimensions : [metric.dimensions ?? {}];
    if (resource === null && sets.some((d) => Object.values(d).some((v) => v.includes(RESOURCE)))) signals.push(off('metric', metric.below, `no backend to replace ${RESOURCE}`));
    else {
      signals.push({ signal: 'metric', below: metric.below, applies: true, series: sets.map((d, i) => {
        const id = Array.isArray(metric.dimensions) ? `metric_${i}` : 'metric';
        queries.push({ id, namespace: metric.namespace, name: metric.name, dimensions: Object.entries(d).map(([Name, v]) => ({ Name, Value: v.replaceAll(RESOURCE, resource ?? '') })), stat: metric.statistic });
        return { ids: [id], scale: 'same' as const };
      }) });
    }
  }
  return { signals, queries };
}

const scaled = (scale: Scale, sum: number) => (scale === 'ec2PerMinute' ? sum / PERIOD_MINUTES : scale === 'rdsPerMinute' ? sum * 60 : scale === 'percent' ? sum * 100 : sum);

// ---- Google Cloud (plan 5): the router's gcp/src/idle-signals.mjs plan ----

// A Google Cloud standalone workload's backend, as its status names it (AWS's entries): a VM, a managed group with its VMs' names
// (read by the discovery account: the status lists none), a Cloud SQL instance (`companion` when it is not the resource).
export interface GoogleBackend { kind: string; id: string; location?: string; companion?: boolean; vms?: string[] }
// One Cloud Monitoring read: its filter and aligner; its series' points merged by `label` (a VM's name, the database, all).
export interface GoogleSpec { id: string; filter: string; aligner: string; label: 'instance_name' | 'db' | 'all'; merge: 'max' | 'sum' }
export interface GoogleMetric { type: string; filter?: string | string[]; aligner: string; below: number }
const GCP_CPU = 'compute.googleapis.com/instance/cpu/utilization';
const GCP_RECEIVED = 'compute.googleapis.com/instance/network/received_bytes_count';
const GCP_SENT = 'compute.googleapis.com/instance/network/sent_bytes_count';
const GCP_SQL_CPU = 'cloudsql.googleapis.com/database/cpu/utilization';
const NO_SQL_NETWORK = 'a Cloud SQL instance\'s network is not read: its connections are its signal';
const isSql = (b: GoogleBackend) => b.kind === 'cloudsql-instance';
const vmsOf = (b: GoogleBackend) => (b.kind === 'instance' ? [b.id] : b.vms ?? []);
const vmFilter = (type: string, names: string[]) => `metric.type = "${type}" AND resource.type = "gce_instance" AND metric.labels.instance_name = one_of(${names.map((n) => JSON.stringify(n)).join(', ')})`;

// The signals of a Google Cloud workload's resolved settings and their reads (the router's plan): CPU a ratio to percent, a group's
// every VM a series, Cloud SQL's CPU by its database id; network in and out summed as bytes a minute, none for Cloud SQL; the
// custom metric's filter with `${resource}` the resource's name. A group whose VMs are not known applies with no series (never idle).
export function googleActivityPlan(backends: GoogleBackend[], settings: { idleCpuPercent?: number | 'off'; idleNetworkBytes?: number | 'off'; idleMetric?: GoogleMetric | 'off' }, project: string): { signals: PlannedSignal[]; specs: GoogleSpec[] } {
  const primaries = backends.filter((b) => !isSql(b));
  const own = primaries.length ? primaries : backends.filter(isSql);
  const signals: PlannedSignal[] = [];
  const specs: GoogleSpec[] = [];
  const off = (signal: PlannedSignal['signal'], below: number | null, reason: string): PlannedSignal => ({ signal, below, applies: false, reason, series: [] });
  const unknownGroup = own.find((b) => b.kind === 'asg' && !vmsOf(b).length);

  const cpu = settings.idleCpuPercent ?? 'off';
  if (cpu === 'off') signals.push(off('cpu', null, 'off'));
  else if (!own.length) signals.push(off('cpu', cpu, 'no backend to read'));
  else if (unknownGroup) signals.push({ signal: 'cpu', below: cpu, applies: true, reason: `the VMs of group ${unknownGroup.id} are not known`, series: [] });
  else {
    signals.push({ signal: 'cpu', below: cpu, applies: true, series: own.flatMap((b, i) => {
      const id = `cpu_${i}`;
      if (isSql(b)) {
        specs.push({ id, filter: `metric.type = "${GCP_SQL_CPU}" AND resource.labels.database_id = "${project}:${b.id}"`, aligner: 'ALIGN_MAX', label: 'db', merge: 'max' });
        return [{ ids: [`${id}:db`], scale: 'percent' as const }];
      }
      specs.push({ id, filter: vmFilter(GCP_CPU, vmsOf(b)), aligner: 'ALIGN_MAX', label: 'instance_name', merge: 'max' });
      return vmsOf(b).map((name) => ({ ids: [`${id}:${name}`], scale: 'percent' as const }));
    }) });
  }

  const network = settings.idleNetworkBytes ?? 'off';
  if (network === 'off') signals.push(off('network', null, 'off'));
  else if (!own.length) signals.push(off('network', network, 'no backend to read'));
  else if (own.every(isSql)) signals.push(off('network', network, NO_SQL_NETWORK));
  else if (unknownGroup) signals.push({ signal: 'network', below: network, applies: true, reason: `the VMs of group ${unknownGroup.id} are not known`, series: [] });
  else {
    signals.push({ signal: 'network', below: network, applies: true, series: own.filter((b) => !isSql(b)).map((b, i) => {
      const names = vmsOf(b);
      specs.push({ id: `rx_${i}`, filter: vmFilter(GCP_RECEIVED, names), aligner: 'ALIGN_SUM', label: 'instance_name', merge: 'sum' });
      specs.push({ id: `tx_${i}`, filter: vmFilter(GCP_SENT, names), aligner: 'ALIGN_SUM', label: 'instance_name', merge: 'sum' });
      return { ids: names.flatMap((name) => [`rx_${i}:${name}`, `tx_${i}:${name}`]), scale: 'ec2PerMinute' as const };
    }) });
  }

  const metric = settings.idleMetric ?? 'off';
  if (metric === 'off') signals.push(off('metric', null, 'off'));
  else {
    const resource = own[0]?.id ?? null;
    const filters = Array.isArray(metric.filter) ? metric.filter : [metric.filter ?? null];
    if (resource === null && filters.some((f) => typeof f === 'string' && f.includes(RESOURCE))) signals.push(off('metric', metric.below, `no backend to replace ${RESOURCE}`));
    else {
      signals.push({ signal: 'metric', below: metric.below, applies: true, series: filters.map((f, j) => {
        const id = `metric_${j}`;
        const extra = typeof f === 'string' && f ? ` AND (${f.replaceAll(RESOURCE, resource ?? '')})` : '';
        specs.push({ id, filter: `metric.type = "${metric.type}"${extra}`, aligner: metric.aligner, label: 'all', merge: 'max' });
        return { ids: [`${id}:all`], scale: 'same' as const };
      }) });
    }
  }
  return { signals, specs };
}

// The points read: by query id, each point's minute from `from` and its value.
export interface ActivityPoints { from: string; to: string; points: Record<string, [number, number][]> }

// Each applying signal's value at each 5-minute point (null: missing), from `from` to `to`.
export function signalValues(signals: PlannedSignal[], read: ActivityPoints): { signal: PlannedSignal['signal']; values: (number | null)[] }[] {
  const count = Math.round((Date.parse(read.to) - Date.parse(read.from)) / PERIOD_MS);
  const byId = new Map(Object.entries(read.points).map(([id, list]) => [id, new Map(list.map(([minute, v]) => [Math.round(minute / PERIOD_MINUTES), v]))]));
  return signals.filter((s) => s.applies).map((s) => ({
    signal: s.signal,
    values: Array.from({ length: count }, (_, p) => {
      let worst: number | null = null;
      for (const { ids, scale } of s.series) {
        let sum = 0;
        for (const id of ids) {
          const v = byId.get(id)?.get(p);
          if (v === undefined) return null;
          sum += v;
        }
        worst = worst === null ? scaled(scale, sum) : Math.max(worst, scaled(scale, sum));
      }
      return worst;
    }),
  }));
}

// The replay's activity (design §7: a napped resource is started again when its history next shows activity): each
// 5-minute point busy, as its five minutes. A point is busy while the workload was awake and a signal that applies is at or
// over its threshold or has no point; while it was asleep (stopped), a point says nothing. `awake`: every time but its naps.
export function busyMinutes(signals: PlannedSignal[], values: ReturnType<typeof signalValues>, read: Pick<ActivityPoints, 'from' | 'to'>, awake: { from: string; to: string }[]): RequestMinutes {
  const from = Date.parse(read.from);
  const count = Math.round((Date.parse(read.to) - from) / PERIOD_MS);
  const periods = awake.map((p) => [Date.parse(p.from), Date.parse(p.to)] as const);
  const wasAwake = (t: number) => periods.some(([a, b]) => t >= a && t + PERIOD_MS <= b);
  const below = new Map(signals.filter((s) => s.applies).map((s) => [s.signal, s.below!]));
  const minutes: [number, number][] = [];
  for (let p = 0; p < count; p += 1) {
    if (!wasAwake(from + p * PERIOD_MS)) continue;
    const busy = values.some((s) => s.values[p] === null || s.values[p]! >= below.get(s.signal)!);
    if (busy) for (let m = 0; m < PERIOD_MINUTES; m += 1) minutes.push([p * PERIOD_MINUTES + m, 1]);
  }
  return { from: read.from, to: read.to, minutes };
}
