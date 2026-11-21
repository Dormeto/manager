// The idle share of a standalone candidate over the last 7 days (vision standalone workloads design §4, §6): the default
// signals of its own resource's type, read in 5-minute points with GetMetricData; an hour is idle when every signal is under
// its threshold at each of its 12 points. A missing point is not idle; a candidate with no point at all has no share (a
// resource stopped all week); a read that fails gives no new share and a problem.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRegion, type ScanPorts } from '../src/scan.js';
import { defaultSignals, standaloneIdle } from '../src/standalone-idle.js';
import type { DiscoveredRule, StandaloneRule } from '../src/types.js';
import { ACCOUNT, REGION, clusterArn, dbArn, groupArn, instanceArn, serviceArn, standalonePorts } from './standalone-fakes.js';

const HOUR = 3_600_000;
const FIVE = 300_000;
// 12:30 now: the window ends at 12:00 (10 minutes behind, at an hour), 168 hours before.
const NOW = Date.UTC(2026, 10, 21, 12, 30);
const END = Date.UTC(2026, 10, 21, 12);
const START = END - 168 * HOUR;
type Query = { Id: string; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] }; Period: number; Stat: string } };

// A CloudWatch that answers each query from `series` (by its first dimension's value: t → value), `size` points a page.
function cloudwatch(series: Record<string, Map<number, number>>, { size = 5000, fail }: { size?: number; fail?: () => Error } = {}) {
  const calls: { queries: number; token?: string; start: number; end: number }[] = [];
  const port: NonNullable<ScanPorts['cloudwatch']> = {
    async getMetricData(input) {
      calls.push({ queries: input.MetricDataQueries.length, ...(input.NextToken ? { token: input.NextToken } : {}), start: input.StartTime.getTime(), end: input.EndTime.getTime() });
      if (fail) throw fail();
      const all = (input.MetricDataQueries as Query[]).flatMap((q) => [...(series[q.MetricStat.Metric.Dimensions[0]!.Value] ?? new Map()).entries()].map(([t, v]) => ({ id: q.Id, t, v })));
      const from = Number(input.NextToken ?? 0);
      const page = all.slice(from, from + size);
      const ids = [...new Set(page.map((p) => p.id))];
      return {
        MetricDataResults: ids.map((Id) => ({ Id, Timestamps: page.filter((p) => p.id === Id).map((p) => new Date(p.t)), Values: page.filter((p) => p.id === Id).map((p) => p.v) })),
        ...(from + size < all.length ? { NextToken: String(from + size) } : {}),
      };
    },
  };
  return { port, calls };
}
// Every 5-minute point of the week at `value`, but the hours `busy` (value 50) and `gaps` (one point missing).
function week(value: number, { busy = [] as number[], gaps = [] as number[], hours = 168 } = {}) {
  const points = new Map<number, number>();
  for (let h = 0; h < hours; h += 1) {
    for (let p = 0; p < 12; p += 1) {
      if (gaps.includes(h) && p === 6) continue;
      points.set(START + h * HOUR + p * FIVE, busy.includes(h) ? 50 : value);
    }
  }
  return points;
}
const candidate = (kind: StandaloneRule['backend']['kind'], id: string, arn: string): StandaloneRule => ({
  kind: 'standalone', id: arn, account: ACCOUNT, region: REGION, resourceArn: arn, name: id, backend: { kind, id, arn }, tags: {}, eligibility: 'eligible', idleHours7d: null,
});
const LONE = candidate('instance', 'i-lone', instanceArn('i-lone'));
const WORKERS = candidate('asg', 'workers', groupArn('workers'));
const WORKER = candidate('ecs', serviceArn('main', 'worker'), serviceArn('main', 'worker'));
const SHOP = candidate('rds-instance', 'shop-db', dbArn('shop-db'));
const AURORA = candidate('rds-cluster', 'aurora', clusterArn('aurora'));

describe('the default signals of a standalone candidate', () => {
  it('reads its CPU under 5 %, or a database\'s connections under 1 with its CPU off, as the router\'s built-ins', () => {
    const view = (c: StandaloneRule) => defaultSignals(c.backend).map((s) => [s.signal, s.below, s.metric.namespace, s.metric.name, s.metric.dimensions, s.metric.stat]);
    expect(view(LONE)).toEqual([['cpu', 5, 'AWS/EC2', 'CPUUtilization', [{ Name: 'InstanceId', Value: 'i-lone' }], 'Maximum']]);
    expect(view(WORKERS)).toEqual([['cpu', 5, 'AWS/EC2', 'CPUUtilization', [{ Name: 'AutoScalingGroupName', Value: 'workers' }], 'Maximum']]);
    expect(view(WORKER)).toEqual([['cpu', 5, 'AWS/ECS', 'CPUUtilization', [{ Name: 'ClusterName', Value: 'main' }, { Name: 'ServiceName', Value: 'worker' }], 'Maximum']]);
    expect(view(SHOP)).toEqual([['metric', 1, 'AWS/RDS', 'DatabaseConnections', [{ Name: 'DBInstanceIdentifier', Value: 'shop-db' }], 'Maximum']]);
    expect(view(AURORA)).toEqual([['metric', 1, 'AWS/RDS', 'DatabaseConnections', [{ Name: 'DBClusterIdentifier', Value: 'aurora' }], 'Maximum']]);
  });
});

describe('the idle share of standalone candidates', () => {
  it('counts the hours whose every point is under the threshold, a missing point or one over making the hour busy', async () => {
    const { port, calls } = cloudwatch({ 'i-lone': week(2, { busy: [3, 100], gaps: [7] }), workers: week(1), 'shop-db': week(0, { busy: [0] }), aurora: week(0, { hours: 24 }) }, { size: 10_000 });
    const { shares, failed } = await standaloneIdle(port, [LONE, WORKERS, SHOP, AURORA], { now: () => NOW });
    expect(Object.fromEntries(shares)).toEqual({ [LONE.id]: 165, [WORKERS.id]: 168, [SHOP.id]: 167, [AURORA.id]: 24 });
    expect(failed).toEqual([]);
    // One call for the four, 5-minute points over the 168 hours before the last hour 10 minutes behind.
    expect(calls).toEqual([{ queries: 4, start: START, end: END }]);
  });

  it('gives no share to a resource with no point in the week (stopped all week): no data, neither idle nor busy', async () => {
    const { port } = cloudwatch({});
    expect(Object.fromEntries((await standaloneIdle(port, [LONE, WORKER], { now: () => NOW })).shares)).toEqual({ [LONE.id]: null, [WORKER.id]: null });
  });

  it('reads every page CloudWatch answers, and asks 500 queries a call at most', async () => {
    const many = Array.from({ length: 501 }, (_, i) => candidate('instance', `i-${i}`, instanceArn(`i-${i}`)));
    const { port, calls } = cloudwatch({ 'i-0': week(1), 'i-500': week(1) }, { size: 1000 });
    const { shares } = await standaloneIdle(port, many, { now: () => NOW });
    expect([shares.get(many[0]!.id), shares.get(many[500]!.id), shares.get(many[1]!.id)]).toEqual([168, 168, null]);
    expect(calls.map((c) => [c.queries, c.token ?? null])).toEqual([[500, null], [500, '1000'], [500, '2000'], [1, null], [1, '1000'], [1, '2000']]);
  });

  it('gives no share and says why when CloudWatch fails, never an idle hour', async () => {
    const { port } = cloudwatch({}, { fail: () => Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }) });
    const { shares, failed } = await standaloneIdle(port, [LONE, SHOP], { now: () => NOW });
    expect(shares.size).toBe(0);
    expect(failed).toEqual([{ ids: [LONE.id, SHOP.id], error: 'ThrottlingException: Rate exceeded' }]);
  });
});

describe('the standalone scan\'s idle share', () => {
  const NOW_SCAN = () => NOW;
  const byArn = (found: DiscoveredRule[]) => Object.fromEntries(found.filter((c): c is StandaloneRule => c.kind === 'standalone').map((c) => [c.id, c]));

  it('is read for the eligible and managed candidates only, the HTTP ones as before', async () => {
    const { ports } = standalonePorts();
    const http = ports.cloudwatch!;
    const asked: string[] = [];
    const { port } = cloudwatch({ 'i-lone': week(1), 'shop-db': week(0) });
    ports.cloudwatch = {
      async getMetricData(input) {
        const standalone = (input.MetricDataQueries as Query[]).every((q) => q.MetricStat.Period === 300);
        asked.push(standalone ? `standalone ${input.MetricDataQueries.length}` : 'http');
        return standalone ? port.getMetricData(input) : http.getMetricData(input);
      },
    };
    const found = byArn(await scanRegion(ports, { account: ACCOUNT, region: REGION }, { now: NOW_SCAN, standalone: true }));
    expect([found[instanceArn('i-lone')]!.idleHours7d, found[dbArn('shop-db')]!.idleHours7d, found[instanceArn('i-noname')]!.idleHours7d]).toEqual([168, 168, null]);
    // Ineligible ones are not read: i-lone, i-noname, i-managed, workers, worker, shop-db, aurora.
    expect(asked).toEqual(['http', 'standalone 7']);
    expect(found[instanceArn('i-store')]!.idleHours7d).toBeNull();
  });

  it('keeps the stored share of a candidate CloudWatch fails for (none if it never had one), and says it in the run', async () => {
    const { ports } = standalonePorts();
    const http = ports.cloudwatch!;
    ports.cloudwatch = {
      async getMetricData(input) {
        if ((input.MetricDataQueries as Query[]).every((q) => q.MetricStat.Period === 300)) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
        return http.getMetricData(input);
      },
    };
    const reports: { problems: string[] }[] = [];
    const storedIdle = async () => new Map([[instanceArn('i-lone'), { idleHours7d: 100, requests7d: null }]]);
    const found = byArn(await scanRegion(ports, { account: ACCOUNT, region: REGION }, { now: NOW_SCAN, standalone: true, storedIdle, onStandalone: (r) => reports.push(r) }));
    expect([found[instanceArn('i-lone')]!.idleHours7d, found[dbArn('shop-db')]!.idleHours7d]).toEqual([100, null]);
    expect(found[instanceArn('i-lone')]).not.toHaveProperty('requests7d');
    expect(reports[0]!.problems).toEqual(['the idle share of 7 standalone candidates could not be read: ThrottlingException: Rate exceeded']);
  });
});

// The router's activity (lambda/src/lib/activity.mjs) and built-in settings (settings-levels.mjs) on the same resources:
// the same metrics, statistics, period and thresholds. Skipped when the router's checkout is not beside the manager's.
const LIB = resolve(import.meta.dirname, '../../../../router/lambda/src/lib');
type RouterSignal = { signal: string; below: number | null; applies: boolean };
const activity = (existsSync(`${LIB}/activity.mjs`) ? await import(/* @vite-ignore */ `${LIB}/activity.mjs`) : null) as {
  createIdleSignals(deps: { cloudwatch: unknown; log: unknown }): (cfg: unknown, backends: unknown[], window: { startMs: number; endMs: number }) => Promise<RouterSignal[]>;
} | null;
const levels = (existsSync(`${LIB}/settings-levels.mjs`) ? await import(/* @vite-ignore */ `${LIB}/settings-levels.mjs`) : null) as { builtInSettingsOf(cfg: unknown): Record<string, unknown> } | null;

describe.skipIf(!activity || !levels)('the default signals against the router\'s', () => {
  // The router's backend of each resource (backends.mjs: a group by its name, a service by its ARN and its cluster).
  const routerBackend = (c: StandaloneRule) => (c.backend.kind === 'asg' ? { kind: 'asg', name: c.backend.id }
    : c.backend.kind === 'ecs' ? { kind: 'ecs', id: c.backend.id, cluster: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/main` }
      : { kind: c.backend.kind, id: c.backend.id });
  it('reads the router\'s metrics with its built-in thresholds for each kind of resource', async () => {
    for (const c of [LONE, WORKERS, WORKER, SHOP, AURORA]) {
      let asked: Query[] = [];
      const read = activity!.createIdleSignals({ cloudwatch: { async getMetricData(input: { MetricDataQueries: Query[] }) { asked = input.MetricDataQueries; return { MetricDataResults: [] }; } }, log: { warn() {} } });
      const cfg = { workloadId: 'w', kind: 'standalone', resourceArn: c.resourceArn, ...levels!.builtInSettingsOf({ kind: 'standalone', resourceArn: c.resourceArn }) };
      const signals = await read(cfg, [routerBackend(c)], { startMs: START, endMs: START + HOUR });
      const mine = defaultSignals(c.backend);
      expect(signals.filter((s) => s.applies).map((s) => [s.signal, s.below]), c.id).toEqual(mine.map((s) => [s.signal, s.below]));
      expect(asked.map((q) => [q.MetricStat.Metric.Namespace, q.MetricStat.Metric.MetricName, q.MetricStat.Metric.Dimensions, q.MetricStat.Stat, q.MetricStat.Period]), c.id)
        .toEqual(mine.map((s) => [s.metric.namespace, s.metric.name, s.metric.dimensions, s.metric.stat, 300]));
    }
  });
});
