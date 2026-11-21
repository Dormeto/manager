// The manager's readers of a standalone workload's signals against the router's (lambda/src/lib/activity.mjs createIdleSignals):
// fed the same recorded CloudWatch answers, the same value at each 5-minute point for each kind of resource (the Activity
// history, M47: network in and out summed and scaled to bytes a minute, the largest of a signal's series, a list of companions'
// connections), and the same idle hours for a candidate's default signals (discovery's idle share, M43). Skipped without the
// router's checkout beside the manager.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activityPoints } from '../../discovery/src/activity-step.js';
import { standaloneIdle } from '../../discovery/src/standalone-idle.js';
import type { StandaloneRule } from '../../discovery/src/types.js';
import { activityPlan, signalValues, type ActivityBackend } from '../src/activity.js';

const ACTIVITY = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/activity.mjs');
type Signal = { signal: string; value: number | null; applies: boolean };
type Window = { startMs: number; endMs: number };
const router = (existsSync(ACTIVITY) ? await import(/* @vite-ignore */ ACTIVITY) : null) as {
  createIdleSignals(d: unknown): (cfg: unknown, backends: unknown[], window: Window) => Promise<Signal[]>;
  isIdle(signals: Signal[], window: Window): boolean;
} | null;

const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';
const POINT = 300_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 21, 12, 7);
// The recorded answers: each metric's points, by its namespace, name, dimensions and statistic, from a pattern of its own
// (under its threshold, over it, missing): a third of the hours quiet (each point under) so that some hours are idle, a third
// under but for one missing point.
const LEVELS: Record<string, [under: number, over: number]> = {
  CPUUtilization: [1.5, 62], NetworkIn: [1800, 90_000], NetworkOut: [1400, 40_000], NetworkReceiveThroughput: [3, 400], NetworkTransmitThroughput: [2, 900],
  DatabaseConnections: [0, 4], QueuedJobs: [0, 3],
};
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function recorded(namespace: string, name: string, dimensions: { Name: string; Value: string }[], stat: string, t: number): number | undefined {
  const key = `${namespace}|${name}|${dimensions.map((d) => `${d.Name}=${d.Value}`).sort().join(',')}|${stat}`;
  const [under, over] = LEVELS[name]!;
  const p = Math.floor(t / POINT);
  if (Math.floor(p / 12) % 3 === 0) return under + (hash(key) % 3) / 10;
  // Another third: under but for one missing point (never idle).
  if (Math.floor(p / 12) % 3 === 1) return (p + hash(key)) % 12 === 5 ? undefined : under;
  const k = (p + hash(key)) % 23;
  if (k === 0) return undefined;
  return k % 4 === 0 ? over + k : under + (k % 5) / 10;
}
type Query = { Id: string; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] }; Stat: string } };
// CloudWatch on the recorded answers: each query's points from StartTime to before EndTime, a page of at most 100 points a
// query (the manager reads every page; the router's windows fit in one).
const cloudwatch = {
  async getMetricData(input: { StartTime: Date; EndTime: Date; NextToken?: string; MetricDataQueries: Query[] }) {
    const page = Number(input.NextToken ?? 0);
    const all: number[] = [];
    for (let t = input.StartTime.getTime(); t < input.EndTime.getTime(); t += POINT) all.push(t);
    const times = all.slice(page * 100, page * 100 + 100);
    return {
      MetricDataResults: input.MetricDataQueries.map((q) => {
        const m = q.MetricStat.Metric;
        const points = times.map((t) => [t, recorded(m.Namespace, m.MetricName, m.Dimensions, q.MetricStat.Stat, t)] as const).filter(([, v]) => v !== undefined);
        return { Id: q.Id, StatusCode: 'Complete', Timestamps: points.map(([t]) => new Date(t)), Values: points.map(([, v]) => v!) };
      }),
      ...(all.length > (page + 1) * 100 ? { NextToken: String(page + 1) } : {}),
    };
  },
};
const read = () => router!.createIdleSignals({ cloudwatch, log: { warn() {} } });

const SVC = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/jobs/worker`;
const CONNECTIONS = { namespace: 'AWS/RDS', name: 'DatabaseConnections', statistic: 'Maximum', below: 1 };
// The manager's backends and the router's for each kind (a group by its name, a service with its cluster's ARN).
const routerBackend = (b: ActivityBackend) => (b.kind === 'asg' ? { kind: 'asg', name: b.id } : b.kind === 'ecs' ? { kind: 'ecs', id: b.id, cluster: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/jobs` } : { kind: b.kind, id: b.id });
const CASES: [string, ActivityBackend[], Record<string, unknown>][] = [
  ['an instance: CPU, network in and out summed a minute, its custom metric', [{ kind: 'instance', id: 'i-1' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 } }],
  ['a group: its CPU and network by its name', [{ kind: 'asg', id: 'workers' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }],
  ['a service: its CPU, no network', [{ kind: 'ecs', id: SVC }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }],
  ['a database: bytes a second times 60, its connections', [{ kind: 'rds-instance', id: 'db' }], { idleCpuPercent: 'off', idleNetworkBytes: 1000, idleMetric: { ...CONNECTIONS, dimensions: { DBInstanceIdentifier: 'db' } } }],
  ['a cluster: its network and CPU', [{ kind: 'rds-cluster', id: 'aurora' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }],
  ['a server with companions: its own CPU and network, the largest of the companions\' connections', [{ kind: 'instance', id: 'i-2' }, { kind: 'rds-cluster', id: 'aurora', companion: true }, { kind: 'rds-instance', id: 'db', companion: true }],
    { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: { ...CONNECTIONS, dimensions: [{ DBClusterIdentifier: 'aurora' }, { DBInstanceIdentifier: 'db' }] } }],
  ['two backends: the largest of their series', [{ kind: 'instance', id: 'i-3' }, { kind: 'instance', id: 'i-4' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }],
];

describe.skipIf(!router)('the Activity history\'s values against the router\'s', () => {
  it.each(CASES)('%s: the same value at each point', async (_name, backends, settings) => {
    const plan = activityPlan(backends, settings as never);
    const points = await activityPoints({ cloudwatch } as never, { queries: plan.queries, days: 1, now: NOW });
    const values = signalValues(plan.signals, points);
    const from = Date.parse(points.from);
    const idleSignals = read();
    let compared = 0;
    for (let p = 0; p < 288; p += 1) {
      const window = { startMs: from + p * POINT, endMs: from + (p + 1) * POINT };
      const theirs = (await idleSignals({ workloadId: 'w', idleMinutes: 5, ...settings }, backends.map(routerBackend), window)).filter((s) => s.applies);
      expect(values.map((v) => v.signal)).toEqual(theirs.map((s) => s.signal));
      theirs.forEach((s, i) => {
        const ours = values[i]!.values[p]!;
        if (s.value === null) expect(ours, `${s.signal} at ${p}`).toBeNull();
        else expect(ours, `${s.signal} at ${p}`).toBeCloseTo(s.value, 9);
        compared += 1;
      });
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe.skipIf(!router)('discovery\'s idle hours against the router\'s', () => {
  // A candidate's default signals are the router's built-ins of a workload with no companion (settings-levels.mjs): CPU under 5 %,
  // a database's connections under 1 with its CPU off.
  const candidates: [StandaloneRule, ActivityBackend, Record<string, unknown>][] = [
    ['instance', 'i-1', `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-1`], ['asg', 'workers', `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:x:autoScalingGroupName/workers`],
    ['ecs', 'worker', SVC], ['rds-instance', 'db', `arn:aws:rds:${REGION}:${ACCOUNT}:db:db`], ['rds-cluster', 'aurora', `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:aurora`],
  ].map(([kind, id, arn]) => {
    const database = kind!.startsWith('rds-');
    const backend: ActivityBackend = { kind: kind!, id: kind === 'ecs' ? arn! : id! };
    const builtIn = database
      ? { idleCpuPercent: 'off', idleNetworkBytes: 'off', idleMetric: { ...CONNECTIONS, dimensions: { [kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: id } } }
      : { idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' };
    return [{ kind: 'standalone', id: arn!, resourceArn: arn!, backend: { kind: kind as never, id: id!, arn: arn! } } as unknown as StandaloneRule, backend, builtIn];
  });

  it('counts the same idle hours of the week for each kind', async () => {
    const { shares, failed } = await standaloneIdle(cloudwatch as never, candidates.map(([c]) => c), { now: () => NOW });
    expect(failed).toEqual([]);
    const end = Math.floor((NOW - 10 * 60_000) / HOUR) * HOUR;
    const idleSignals = read();
    for (const [c, backend, settings] of candidates) {
      let idle = 0;
      for (let h = 0; h < 168; h += 1) {
        const window = { startMs: end - (168 - h) * HOUR, endMs: end - (167 - h) * HOUR };
        if (router!.isIdle(await idleSignals({ workloadId: 'w', idleMinutes: 60, ...settings }, [routerBackend(backend)], window), window)) idle += 1;
      }
      expect(idle, c.backend.kind).toBeGreaterThan(0);
      expect(shares.get(c.id), c.backend.kind).toBe(idle);
    }
  });
});
