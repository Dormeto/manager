// The idle share of standalone candidates over the last 7 days (vision standalone workloads design §4, §6): the default
// signals of each one's own resource, read from CloudWatch in the router's 5-minute points. An hour is idle when every
// signal is under its threshold at each of its 12 points; a missing point is not idle (the router's rule). A candidate with
// no point at all in the week (a resource stopped all week, a service at 0) has no share: no data, neither idle nor busy.
// A read that fails gives no share: its candidates are said, never idle.
// The signals are the router's (lambda/src/lib/activity.mjs, its built-ins settings-levels.mjs builtInSettingsOf); a test
// reads them from the router's checkout.
import { errorText } from './error-text.js';
import type { ScanPorts } from './scan.js';
import type { StandaloneRule } from './types.js';

const HOUR_MS = 3_600_000;
const HOURS = 168;
const PERIOD_MS = 5 * 60_000; // activity.mjs PERIOD_MS
const POINTS = HOUR_MS / PERIOD_MS;
// CloudWatch publishes a point minutes after its period (activity.mjs METRIC_LAG_MS): the week ends at the last hour 10
// minutes behind, so that its last hour is complete.
const METRIC_LAG_MS = 10 * 60_000;
// GetMetricData's most queries a call.
const BATCH = 500;
// The built-ins of a standalone workload with no companion (settings-levels.mjs STANDALONE_BUILT_IN; a workload whose resource
// is a database: its CPU off, its connections under 1).
const CPU_PERCENT = 5;
const CONNECTIONS = 1;

export interface DefaultSignal {
  signal: 'cpu' | 'metric';
  below: number;
  metric: { namespace: string; name: string; dimensions: { Name: string; Value: string }[]; stat: 'Maximum' };
}

// A candidate's default signals, by its own resource's kind (a candidate lists no companion yet).
export function defaultSignals(backend: StandaloneRule['backend']): DefaultSignal[] {
  const cpu = (namespace: string, dimensions: DefaultSignal['metric']['dimensions']): DefaultSignal[] => [{ signal: 'cpu', below: CPU_PERCENT, metric: { namespace, name: 'CPUUtilization', dimensions, stat: 'Maximum' } }];
  switch (backend.kind) {
    case 'instance': return cpu('AWS/EC2', [{ Name: 'InstanceId', Value: backend.id }]);
    case 'asg': return cpu('AWS/EC2', [{ Name: 'AutoScalingGroupName', Value: backend.id }]);
    case 'ecs': {
      // service/<cluster>/<name>, or service/<name> in the default cluster (an ARN of the old format).
      const path = (backend.arn ?? backend.id).split(':service/')[1] ?? backend.id;
      const [cluster, name] = path.includes('/') ? [path.split('/')[0]!, path.split('/').at(-1)!] : ['default', path];
      return cpu('AWS/ECS', [{ Name: 'ClusterName', Value: cluster }, { Name: 'ServiceName', Value: name }]);
    }
    default: return [{
      signal: 'metric', below: CONNECTIONS,
      metric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: [{ Name: backend.kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier', Value: backend.id }], stat: 'Maximum' },
    }];
  }
}

// shares: each candidate read, its idle hours of the week (null: no point at all). failed: the candidates of each batch
// CloudWatch failed for, with the error.
export async function standaloneIdle(cloudwatch: NonNullable<ScanPorts['cloudwatch']>, candidates: StandaloneRule[], { now }: { now: () => number }) {
  const end = Math.floor((now() - METRIC_LAG_MS) / HOUR_MS) * HOUR_MS;
  const start = end - HOURS * HOUR_MS;
  const shares = new Map<string, number | null>();
  const failed: { ids: string[]; error: string }[] = [];
  // A candidate's signals stay in one batch: its share needs all of them.
  const batches: StandaloneRule[][] = [];
  let size = BATCH;
  for (const c of candidates) {
    const n = defaultSignals(c.backend).length;
    if (size + n > BATCH) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(c);
    size += n;
  }
  for (const batch of batches) {
    const queries = batch.flatMap((c) => defaultSignals(c.backend).map((s) => ({ id: c.id, s })));
    const points = new Map<string, Map<number, number>>();
    try {
      let token: string | undefined;
      do {
        const page = await cloudwatch.getMetricData({
          StartTime: new Date(start), EndTime: new Date(end), ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}),
          MetricDataQueries: queries.map(({ s }, i) => ({
            Id: `s${i}`, ReturnData: true,
            MetricStat: { Metric: { Namespace: s.metric.namespace, MetricName: s.metric.name, Dimensions: s.metric.dimensions }, Period: PERIOD_MS / 1000, Stat: s.metric.stat },
          })),
        });
        // A query's points may come over several pages.
        for (const r of page.MetricDataResults ?? []) {
          // A result CloudWatch could not read has no values: a failed read, never a week without a point.
          if (r.StatusCode && r.StatusCode !== 'Complete' && r.StatusCode !== 'PartialData') {
            const why = r.Messages?.map((m) => m.Value ?? m.Code).filter(Boolean).join('; ');
            throw new Error(`CloudWatch could not read the metrics (${r.StatusCode}${why ? `: ${why}` : ''})`);
          }
          const series = points.get(r.Id ?? '') ?? new Map<number, number>();
          (r.Timestamps ?? []).forEach((t, k) => {
            const v = r.Values?.[k];
            if (typeof v === 'number' && Number.isFinite(v)) series.set(new Date(t).getTime(), v);
          });
          points.set(r.Id ?? '', series);
        }
        token = page.NextToken;
      } while (token);
    } catch (err) {
      failed.push({ ids: batch.map((c) => c.id), error: errorText(err) });
      continue;
    }
    const byCandidate = new Map<string, { s: DefaultSignal; series: Map<number, number> }[]>();
    queries.forEach(({ id, s }, i) => byCandidate.set(id, [...(byCandidate.get(id) ?? []), { s, series: points.get(`s${i}`) ?? new Map() }]));
    for (const [id, signals] of byCandidate) {
      if (signals.every(({ series }) => series.size === 0)) {
        shares.set(id, null);
        continue;
      }
      let idle = 0;
      for (let h = 0; h < HOURS; h += 1) {
        const hour = start + h * HOUR_MS;
        const under = signals.every(({ s, series }) => Array.from({ length: POINTS }, (_, p) => series.get(hour + p * PERIOD_MS)).every((v) => v !== undefined && v < s.below));
        if (under) idle += 1;
      }
      shares.set(id, idle);
    }
  }
  return { shares, failed };
}
