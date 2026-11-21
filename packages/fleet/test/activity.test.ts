// A standalone workload's activity for the idle window advisor (vision standalone workloads design §4, §6, §7): its signals'
// queries as the router reads them, each signal's value a point, the busy points, and their replay from 5 minutes to 24 hours.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDALONE_RECOMMENDABLE, STANDALONE_WINDOWS, activityPlan, busyMinutes, signalValues, type ActivityBackend, type ActivityPoints } from '../src/activity.js';
import { idleWindowAdvice } from '../src/idle.js';

const ACCOUNT = '111122223333';
const SVC = `arn:aws:ecs:eu-west-1:${ACCOUNT}:service/jobs/worker`;
const METRIC = { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 };
const FROM = '2026-11-14T12:00:00.000Z';
const TO = '2026-11-21T12:00:00.000Z';
const POINTS = 7 * 288;
const DAY_MINUTES = 1440;

describe('the signals\' queries', () => {
  it('read each kind\'s CPU and network, a database\'s own, and the custom metric with the resource\'s id', () => {
    const view = (backends: ActivityBackend[], settings: Parameters<typeof activityPlan>[1]) => activityPlan(backends, settings).queries.map((q) => [q.id, q.namespace, q.name, q.dimensions.map((d) => `${d.Name}=${d.Value}`).join(','), q.stat]);
    expect(view([{ kind: 'instance', id: 'i-1' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: METRIC })).toEqual([
      ['cpu_0', 'AWS/EC2', 'CPUUtilization', 'InstanceId=i-1', 'Maximum'],
      ['net_0_in', 'AWS/EC2', 'NetworkIn', 'InstanceId=i-1', 'Sum'], ['net_0_out', 'AWS/EC2', 'NetworkOut', 'InstanceId=i-1', 'Sum'],
      ['metric', 'CI/Agents', 'QueuedJobs', 'Agent=i-1', 'Maximum'],
    ]);
    expect(view([{ kind: 'ecs', id: SVC }], { idleCpuPercent: 5, idleNetworkBytes: 1000 })).toEqual([['cpu_0', 'AWS/ECS', 'CPUUtilization', 'ClusterName=jobs,ServiceName=worker', 'Maximum']]);
    expect(activityPlan([{ kind: 'ecs', id: SVC }], { idleNetworkBytes: 1000 }).signals.find((s) => s.signal === 'network')).toMatchObject({ applies: false, reason: 'an ECS service has no network metric without Container Insights' });
    // A server with a companion database: its CPU only, the database's connections by the metric.
    expect(view([{ kind: 'asg', id: 'workers' }, { kind: 'rds-instance', id: 'db', companion: true }], { idleCpuPercent: 5 })).toEqual([['cpu_0', 'AWS/EC2', 'CPUUtilization', 'AutoScalingGroupName=workers', 'Maximum']]);
    expect(view([{ kind: 'rds-cluster', id: 'aurora' }], { idleCpuPercent: 'off', idleMetric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { DBClusterIdentifier: 'aurora' }, statistic: 'Maximum', below: 1 } }))
      .toEqual([['metric', 'AWS/RDS', 'DatabaseConnections', 'DBClusterIdentifier=aurora', 'Maximum']]);
  });
});

// The router's activity on the same backends and settings: the same queries. Skipped without its checkout.
const ACTIVITY = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/activity.mjs');
const router = (existsSync(ACTIVITY) ? await import(/* @vite-ignore */ ACTIVITY) : null) as { createIdleSignals(d: unknown): (cfg: unknown, b: unknown[], w: unknown) => Promise<unknown> } | null;
describe.skipIf(!router)('the signals\' queries against the router\'s', () => {
  const cases: [ActivityBackend[], Record<string, unknown>][] = [
    [[{ kind: 'instance', id: 'i-1' }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: METRIC }],
    [[{ kind: 'asg', id: 'workers' }], { idleCpuPercent: 3, idleNetworkBytes: 10, idleMetric: 'off' }],
    [[{ kind: 'ecs', id: SVC }], { idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: METRIC }],
    [[{ kind: 'rds-instance', id: 'db' }], { idleCpuPercent: 'off', idleNetworkBytes: 100, idleMetric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { DBInstanceIdentifier: 'db' }, statistic: 'Maximum', below: 1 } }],
    [[{ kind: 'instance', id: 'i-2' }, { kind: 'rds-cluster', id: 'aurora', companion: true }], { idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: [{ DBClusterIdentifier: 'aurora' }, { DBInstanceIdentifier: 'x' }], statistic: 'Maximum', below: 1 } }],
  ];
  // The router's backends: a group by its name, a service with its cluster's ARN.
  const routerBackend = (b: ActivityBackend) => (b.kind === 'asg' ? { kind: 'asg', name: b.id } : b.kind === 'ecs' ? { kind: 'ecs', id: b.id, cluster: `arn:aws:ecs:eu-west-1:${ACCOUNT}:cluster/jobs` } : { kind: b.kind, id: b.id });
  it('asks CloudWatch the same', async () => {
    for (const [backends, settings] of cases) {
      let asked: { Id: string; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: unknown[] }; Stat: string } }[] = [];
      const read = router!.createIdleSignals({ cloudwatch: { async getMetricData(input: { MetricDataQueries: typeof asked }) { asked = input.MetricDataQueries; return { MetricDataResults: [] }; } }, log: { warn() {} } });
      await read({ workloadId: 'w', idleMinutes: 120, ...settings }, backends.map(routerBackend), { startMs: Date.parse(FROM), endMs: Date.parse(FROM) + 3_600_000 });
      expect(activityPlan(backends, settings as never).queries.map((q) => [q.id, q.namespace, q.name, q.dimensions, q.stat]), JSON.stringify(backends))
        .toEqual(asked.map((q) => [q.Id, q.MetricStat.Metric.Namespace, q.MetricStat.Metric.MetricName, q.MetricStat.Metric.Dimensions, q.MetricStat.Stat]));
    }
  });
});

describe('the busy points and their replay', () => {
  const plan = activityPlan([{ kind: 'instance', id: 'i-1' }], { idleCpuPercent: 5 });
  const read = (value: (point: number) => number | undefined): ActivityPoints => ({
    from: FROM, to: TO, points: { cpu_0: Array.from({ length: POINTS }, (_, p) => [p * 5, value(p)] as [number, number | undefined]).filter((x): x is [number, number] => x[1] !== undefined) },
  });
  const allWeek = [{ from: FROM, to: TO }];
  const advise = async (points: ActivityPoints, awake = allWeek) => {
    const requests = busyMinutes(plan.signals, signalValues(plan.signals, points), points, awake);
    return idleWindowAdvice({
      requests, current: 120, checkMinutes: 5, wakeMs: 60_000, startAsleep: false, actualWakes: 0, actualFrom: null, stopped: null, hourly: async () => null,
      baseline: { kind: 'always' }, wakerTargetGroup: false, now: Date.parse(TO), windows: STANDALONE_WINDOWS, recommendable: STANDALONE_RECOMMENDABLE,
    });
  };

  it('always busy: never asleep, whatever the window', async () => {
    const a = await advise(read(() => 40));
    expect(a.windows.map((w) => w.minutes)).toEqual(STANDALONE_WINDOWS);
    expect(a.windows.every((w) => w.asleepHours === 0 && w.wakesPerDay === 0)).toBe(true);
  });

  it('always idle: asleep nearly all the time from the first window\'s end, no wake', async () => {
    const a = await advise(read(() => 1));
    expect(a.windows.every((w) => w.wakesPerDay === 0)).toBe(true);
    expect(a.windows.find((w) => w.minutes === 5)!.asleepHours).toBeGreaterThan(23.9);
    expect(a.recommended).toBe(5);
  });

  it('a daily job of an hour: a wake a day for the windows shorter than the day\'s quiet, none for 24 hours', async () => {
    const a = await advise(read((p) => ((p * 5) % DAY_MINUTES < 60 ? 90 : 1)));
    expect(a.windows.find((w) => w.minutes === 120)!.wakesPerDay).toBeCloseTo(6 / 7, 1);
    expect(a.windows.find((w) => w.minutes === 120)!.asleepHours).toBeGreaterThan(20);
    expect(a.windows.find((w) => w.minutes === 1440)!.wakesPerDay).toBe(0);
    // The knee from 5 minutes to 2 hours: a day would avoid the stop but keep it awake all night.
    expect(a.recommended).toBe(5);
  });

  it('a missing point while awake is busy; points while it was stopped say nothing', async () => {
    const missing = signalValues(plan.signals, read((p) => (p % 2 ? 1 : undefined)));
    expect(busyMinutes(plan.signals, missing, read(() => 1), allWeek).minutes.length).toBe((POINTS / 2) * 5);
    // Stopped the whole week (no point): nothing busy, the replay naps at once.
    expect(busyMinutes(plan.signals, signalValues(plan.signals, read(() => undefined)), read(() => 1), []).minutes).toEqual([]);
  });
});

describe('the activity kept a day', () => {
  it('is read back until its expiresAt, then no more', async () => {
    const { fakeDynamo } = await import('../../discovery/test/dynamo-fake.js');
    const { createFleetStore } = await import('../src/index.js');
    const dynamo = fakeDynamo();
    let t = Date.parse(TO);
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => t });
    await store.putActivity('121014831971', 'eu-west-1', 'sa', { key: 'k', answer: { advice: null } });
    const item = [...dynamo.items.values()].find((i) => i.sk?.S === 'ACTIVITY#121014831971#eu-west-1#sa')!;
    expect(Number(item.expiresAt!.N) - Math.floor(t / 1000)).toBe(86_400);
    expect(await store.getActivity('121014831971', 'eu-west-1', 'sa')).toEqual({ key: 'k', answer: { advice: null } });
    t += 86_401_000;
    expect(await store.getActivity('121014831971', 'eu-west-1', 'sa')).toBeNull();
  });
});
