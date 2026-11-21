// A standalone resource's idle signals (vision standalone workloads design §4, §6, §7): its default signals and their idle
// share over the week (discovery src/standalone-idle.ts, the scan's and the estimate's), and the Activity history's chain
// (fleet src/activity.ts, discovery src/activity-step.ts): the signals' queries, their points read, each signal's value a
// point, the busy points the idle window advisor replays (the replay topic's `standaloneAdvice`). The cases of discovery
// test/standalone-idle.test.ts, activity-step.test.ts and fleet test/activity.test.ts.
import { error, regionModel } from './aws.mjs';

export const name = 'standalone-idle';

const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';
const HOUR = 3_600_000;
const POINT = 300_000;
const SERVICE = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/jobs/worker`;
const backend = (kind, id, arn) => ({ kind, id, arn });
const BACKENDS = {
  instance: backend('instance', 'i-lone', `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-lone`),
  asg: backend('asg', 'workers', `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:6d4f2c1e-0000-4000-8000-000000000007:autoScalingGroupName/workers`),
  ecs: backend('ecs', SERVICE, SERVICE),
  ecsOld: backend('ecs', `arn:aws:ecs:${REGION}:${ACCOUNT}:service/legacy`, `arn:aws:ecs:${REGION}:${ACCOUNT}:service/legacy`),
  db: backend('rds-instance', 'shop-db', `arn:aws:rds:${REGION}:${ACCOUNT}:db:shop-db`),
  cluster: backend('rds-cluster', 'aurora', `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:aurora`),
};
const candidate = (b) => ({
  kind: 'standalone', id: b.arn, account: ACCOUNT, region: REGION, resourceArn: b.arn, name: b.id.split('/').at(-1), backend: b, tags: {}, eligibility: 'eligible', idleHours7d: null,
});

// The week standaloneIdle reads at `now`: 168 hours to the last hour 10 minutes behind.
const week = (now) => {
  const end = Math.floor((Date.parse(now) - 600_000) / HOUR) * HOUR;
  return { start: end - 168 * HOUR, end };
};
// A series from `start` to `end`, a point each 5 minutes; value(t) undefined: no point.
function series(start, end, value) {
  const Timestamps = [];
  const Values = [];
  for (let t = start; t < end; t += POINT) {
    const v = value(t);
    if (v === undefined) continue;
    Timestamps.push(new Date(t).toISOString());
    Values.push(v);
  }
  return { StatusCode: 'Complete', Timestamps, Values };
}
const dimensionsOf = (q) => Object.fromEntries(q.MetricStat.Metric.Dimensions.map((d) => [d.Name, d.Value]));
const EMPTY = { StatusCode: 'Complete', Timestamps: [], Values: [] };

// The week of each resource: i-lone busy at 09:00 UTC each day and missing a point on day 2 (its hour busy); workers idle
// but over at one point of its third hour; shop-db without connections but its first hour; aurora with points only for its
// last 24 hours (a cluster stopped until then: those hours are not idle); the services without a point (no share).
function weekMetrics(now, { forbid } = {}) {
  const { start, end } = week(now);
  return (q) => {
    const d = dimensionsOf(q);
    if (forbid && Object.values(d).includes(forbid)) return { StatusCode: 'Forbidden', Messages: [{ Code: 'Forbidden', Value: 'not authorized to read this metric' }] };
    if (d.InstanceId === 'i-lone') return series(start, end, (t) => (t === start + 24 * HOUR + 30 * 60_000 ? undefined : new Date(t).getUTCHours() === 9 ? 64.5 : 1.25));
    if (d.AutoScalingGroupName === 'workers') return series(start, end, (t) => (t === start + 2 * HOUR + 15 * 60_000 ? 5 : 4.99));
    if (d.DBInstanceIdentifier === 'shop-db') return series(start, end, (t) => (t < start + HOUR ? 2 : 0));
    if (d.DBClusterIdentifier === 'aurora') return series(end - 24 * HOUR, end, () => 0);
    return EMPTY;
  };
}

// One day of the Activity history's queries, to `now`'s 5-minute boundary 10 minutes behind.
function dayMetrics(now) {
  const end = Math.floor((Date.parse(now) - 600_000) / POINT) * POINT;
  const start = end - 24 * HOUR;
  return (q) => {
    if (q.Id === 'cpu_0') return series(start, end, (t) => (new Date(t).getUTCHours() === 9 ? 71.5 : 2.5));
    if (q.Id === 'metric') return series(start, end, (t) => (t % (6 * HOUR) === 0 ? 1 : 0));
    if (q.Id === 'net_0_in') return series(start, end, (t) => (t === start + HOUR ? undefined : 600));
    return EMPTY;
  };
}

const QUERIES = [
  { id: 'cpu_0', namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: [{ Name: 'InstanceId', Value: 'i-lone' }], stat: 'Maximum' },
  { id: 'net_0_in', namespace: 'AWS/EC2', name: 'NetworkIn', dimensions: [{ Name: 'InstanceId', Value: 'i-lone' }], stat: 'Sum' },
  { id: 'metric', namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: [{ Name: 'Agent', Value: 'i-lone' }], stat: 'Maximum' },
];

// The signals of activityPlan, as signalValues and busyMinutes take them.
const SIGNALS = [
  { signal: 'cpu', below: 5, applies: true, series: [{ ids: ['cpu_0'], scale: 'same' }, { ids: ['cpu_1'], scale: 'same' }] },
  { signal: 'network', below: 1000, applies: true, series: [{ ids: ['net_0_in', 'net_0_out'], scale: 'ec2PerMinute' }, { ids: ['net_1_in', 'net_1_out'], scale: 'rdsPerMinute' }] },
  { signal: 'metric', below: 1, applies: false, reason: 'off', series: [] },
];
const HOUR_FROM = '2026-10-12T06:00:00.000Z';
const HOUR_TO = '2026-10-12T07:00:00.000Z';
// An hour's 12 points of each query, minute offsets from HOUR_FROM; a few missing.
const points = (value) => Array.from({ length: 12 }, (_, p) => [p * 5, value(p)]).filter(([, v]) => v !== undefined);
const HOUR_POINTS = {
  cpu_0: points((p) => (p === 3 ? 7.5 : 1)),
  cpu_1: points((p) => (p === 5 ? 9 : p === 10 ? undefined : 2)),
  net_0_in: points((p) => 1000 + p * 300),
  net_0_out: points((p) => (p === 7 ? undefined : 500)),
  net_1_in: points(() => 4.5),
  net_1_out: points((p) => (p === 11 ? 20 : 3)),
};
const METRIC = { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 };
const CONNECTIONS = { namespace: 'AWS/RDS', name: 'DatabaseConnections', statistic: 'Maximum', below: 1 };

export function cases(now) {
  const idle = (title, candidates, spec) => ({
    name: `standaloneIdle: ${title}`, input: { function: 'standaloneIdle', candidates: candidates.map(candidate), now }, model: regionModel(spec),
  });
  const plan = (title, backends, settings) => ({ name: `activityPlan: ${title}`, input: { function: 'activityPlan', backends, settings } });
  const read = (title, spec, extra = {}) => ({ name: `activityPoints: ${title}`, input: { function: 'activityPoints', queries: QUERIES, days: 1, now, ...extra }, model: regionModel(spec) });
  return [
    ...Object.entries(BACKENDS).map(([key, b]) => ({ name: `defaultSignals: ${key === 'ecsOld' ? 'an ECS service of the old ARN format (cluster default)' : b.kind}`, input: { function: 'defaultSignals', backend: b } })),
    idle('an hour idle with its 12 points under; one over or missing, busy; no point all week, no share', [BACKENDS.instance, BACKENDS.asg, BACKENDS.ecs, BACKENDS.db, BACKENDS.cluster], { metrics: weekMetrics(now) }),
    idle('CloudWatch\'s answer in pages (NextToken, PartialData)', [BACKENDS.db], { metrics: weekMetrics(now), metricsPage: 1000 }),
    idle('a query CloudWatch could not read (Forbidden): the batch failed, never idle', [BACKENDS.ecs, BACKENDS.db], { metrics: weekMetrics(now, { forbid: 'shop-db' }) }),
    idle('CloudWatch failing: the batch failed', [BACKENDS.instance], { fail: { 'cloudwatch.getMetricData': error('ThrottlingException', 'Rate exceeded') } }),
    plan('an instance: CPU, network in and out, the custom metric with its id', [{ kind: 'instance', id: 'i-lone' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: METRIC }),
    plan('a group by its name', [{ kind: 'asg', id: 'workers' }], { idleCpuPercent: 3, idleNetworkBytes: 10, idleMetric: 'off' }),
    plan('an ECS service: CPU, no network', [{ kind: 'ecs', id: SERVICE }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: METRIC }),
    plan('a database: its throughput and connections', [{ kind: 'rds-instance', id: 'shop-db' }], { idleCpuPercent: 'off', idleNetworkBytes: 100, idleMetric: { ...CONNECTIONS, dimensions: { DBInstanceIdentifier: 'shop-db' } } }),
    plan('a server with companions: its own CPU, the companions\' connections as a list', [{ kind: 'instance', id: 'i-2' }, { kind: 'rds-cluster', id: 'aurora', companion: true }, { kind: 'rds-instance', id: 'shop-db', companion: true }],
      { idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: { ...CONNECTIONS, dimensions: [{ DBClusterIdentifier: 'aurora' }, { DBInstanceIdentifier: 'shop-db' }] } }),
    plan('two backends: a series each', [{ kind: 'instance', id: 'i-3' }, { kind: 'instance', id: 'i-4' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }),
    plan('no backend: nothing to read, ${resource} not replaced', [], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: METRIC }),
    plan('every signal off', [{ kind: 'instance', id: 'i-lone' }], { idleCpuPercent: 'off', idleNetworkBytes: 'off', idleMetric: 'off' }),
    read('a day of 5-minute points to 10 minutes ago, in pages', { metrics: dayMetrics(now), metricsPage: 400 }),
    read('a query CloudWatch could not read: an error, never an idle day', { metrics: (q) => (q.Id === 'metric' ? { StatusCode: 'Forbidden', Messages: [{ Code: 'Forbidden', Value: 'not authorized' }] } : dayMetrics(now)(q)) }),
    { name: 'signalValues: network in and out summed a minute (EC2 a 5-minute sum, RDS bytes a second), the largest series, a missing query', input: { function: 'signalValues', signals: SIGNALS, read: { from: HOUR_FROM, to: HOUR_TO, points: HOUR_POINTS } } },
    {
      name: 'busyMinutes: a point at or over its threshold or missing while awake is busy, asleep says nothing',
      input: {
        function: 'busyMinutes', signals: SIGNALS.slice(0, 2), from: HOUR_FROM, to: HOUR_TO,
        values: [{ signal: 'cpu', values: [1, 1, 1, 7.5, 1, 5, 1, 1, 1, 1, null, 1] }, { signal: 'network', values: [400, 400, 400, 999, 1000, 400, 400, null, 400, 400, 400, 400] }],
        awake: [{ from: HOUR_FROM, to: '2026-10-12T06:40:00.000Z' }],
      },
    },
    { name: 'busyMinutes: nothing awake, nothing busy', input: { function: 'busyMinutes', signals: SIGNALS.slice(0, 1), from: HOUR_FROM, to: HOUR_TO, values: [{ signal: 'cpu', values: Array(12).fill(null) }], awake: [] } },
  ];
}

export async function run(product, input, ports) {
  switch (input.function) {
    case 'defaultSignals': return product.defaultSignals(input.backend);
    case 'standaloneIdle': {
      const { shares, failed } = await product.standaloneIdle(ports.cloudwatch, input.candidates, { now: () => Date.parse(input.now) });
      return { shares: Object.fromEntries(shares), failed };
    }
    case 'activityPlan': return product.activityPlan(input.backends, input.settings);
    case 'activityPoints':
      try {
        return await product.activityPoints({ cloudwatch: ports.cloudwatch }, { queries: input.queries, days: input.days, now: Date.parse(input.now) });
      } catch (err) {
        if (err.message?.includes('could not read')) return { error: { message: err.message } };
        throw err;
      }
    case 'signalValues': return product.signalValues(input.signals, input.read);
    case 'busyMinutes': return product.busyMinutes(input.signals, input.values, { from: input.from, to: input.to }, input.awake);
    default: throw new Error(`unknown function ${input.function}`);
  }
}

export const readme = `A standalone resource's idle signals (\`packages/discovery/src/standalone-idle.ts\`, \`activity-step.ts\`,
\`packages/fleet/src/activity.ts\`; Go: \`defaultSignals\` and \`standaloneIdle\` in \`internal/discover\`, \`activityPlan\`,
\`activityPoints\` and \`signalValues\` in \`internal/metrics\`, \`busyMinutes\` in \`internal/replay\`). \`input.function\` names the function:

- \`defaultSignals\`: \`{backend: {kind, id, arn}}\`. Output: \`[{signal, below, metric: {namespace, name, dimensions:
  [{Name, Value}], stat}}]\`, the router's built-ins of a workload with no companion (CPU under 5 %, a database's
  connections under 1); an ECS service's cluster from its ARN (\`service/<cluster>/<name>\`, \`default\` for \`service/<name>\`).
- \`standaloneIdle\`: \`{candidates, now}\`. The week is the 168
  hours to \`now\`'s last hour 10 minutes behind (\`floor((now − 10 min) / 1 h)\`); one \`GetMetricData\` call (and its
  pages) a batch of at most 500 queries, \`Period\` 300, the queries' \`Id\` \`s<n>\` in the candidates' order. An hour is
  idle when every signal has its 12 points and each is under its threshold; a candidate with no point all week has
  \`null\`; a call that fails, or a result whose \`StatusCode\` is neither \`Complete\` nor \`PartialData\`, fails its batch.
  Output: \`{shares: {<candidate id>: hours|null}, failed: [{ids, error}]}\` (\`error\`: \`<name>: <message>\`).
- \`activityPlan\`: \`{backends: [{kind, id, companion?}], settings: {idleCpuPercent, idleNetworkBytes, idleMetric}}\`.
  Output: \`{signals: [{signal, below, applies, reason?, series: [{ids, scale}]}], queries: [{id, namespace, name,
  dimensions, stat}]}\`, the router's queries (its \`activity.mjs\`); \`scale\` is \`same\`, \`ec2PerMinute\` (÷ 5) or
  \`rdsPerMinute\` (× 60).
- \`activityPoints\`: \`{queries, days, now}\`. The window ends at \`now\`'s 5-minute boundary 10 minutes behind and starts
  \`days\` days before; every page read. Output: \`{from, to, points: {<id>: [[minute from \`from\`, value]]}}\`, or
  \`{error: {message}}\` for a result CloudWatch could not read.
- \`signalValues\`: \`{signals, read: {from, to, points}}\`. Output: \`[{signal, values}]\` for each signal that applies, a
  value a 5-minute point (each series the sum of its queries, scaled; the largest series; null when a query has no point).
- \`busyMinutes\`: \`{signals, values, from, to, awake: [{from, to}]}\`. Output: \`{from, to, minutes: [[minute, 1]]}\`, the
  five minutes of each busy point: a point inside an awake period with a signal at or over its threshold or null.`;
