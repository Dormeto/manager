// Phase 2 of the estimate (spec §5): each eligible workload's requests per minute over 14 days, five workloads per
// GetMetricData call, every page, kept per account and region the same UTC day.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCache } from '../src/cache.js';
import type { RegionDiscovery, Workload } from '../src/discover.js';
import { readRequests, requestsAll, type CloudWatchPort } from '../src/requests.js';

const A = '111111111111';
const R = 'eu-west-1';
const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const TO = Date.parse('2026-10-10T12:00:00.000Z');
const FROM = TO - 14 * 86_400_000;
const minute = (m: number) => new Date(FROM + m * 60_000);
const LB = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/web/0123456789abcdef`;
const tg = (i: number) => `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/app-${i}/fedcba98765432${String(i).padStart(2, '0')}`;
const workload = (i: number): Workload => ({ account: A, region: R, loadBalancer: 'web', loadBalancerArn: LB, targetGroup: `app-${i}`, targetGroupArn: tg(i), hosts: [], backend: { kind: 'asg', id: `asg-${i}` }, stopped: [], tags: {} });
type Result = { Id?: string; Timestamps?: Date[]; Values?: number[]; StatusCode?: string; Messages?: { Code?: string; Value?: string }[] };

// A CloudWatch fake: each query's answer by its target group, the first call in two pages.
function cloudwatch(answer: (targetGroupArn: string) => Result = () => ({ Timestamps: [], Values: [], StatusCode: 'Complete' })) {
  const calls: { queries: string[]; token?: string }[] = [];
  const port: CloudWatchPort = {
    getMetricData: async (input) => {
      const queries = input.MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'TargetGroup')!.Value);
      calls.push({ queries, ...(input.NextToken ? { token: input.NextToken } : {}) });
      const results = input.MetricDataQueries.map((q) => ({ Id: q.Id, ...answer(tg(Number(/app-(\d+)/.exec(q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'TargetGroup')!.Value)![1]))) }));
      // The first call answers its values in two pages.
      if (calls.length === 1) return { MetricDataResults: results.map((r) => ({ ...r, Timestamps: r.Timestamps?.slice(0, 1), Values: r.Values?.slice(0, 1) })), NextToken: 'page-2' };
      if (input.NextToken === 'page-2') return { MetricDataResults: results.map((r) => ({ ...r, Timestamps: r.Timestamps?.slice(1), Values: r.Values?.slice(1) })) };
      return { MetricDataResults: results };
    },
  };
  return { port, calls };
}

describe('the requests of a region\'s workloads', () => {
  it('five workloads per call, every page, by each value\'s timestamp, a target group\'s values never another\'s', async () => {
    const { port, calls } = cloudwatch((arn) => (arn === tg(0) ? { Timestamps: [minute(9), minute(2)], Values: [4, 1], StatusCode: 'Complete' } : arn === tg(1) ? { Timestamps: [minute(9)], Values: [7], StatusCode: 'Complete' } : { Timestamps: [], Values: [], StatusCode: 'Complete' }));
    const out = await readRequests(port, Array.from({ length: 12 }, (_, i) => workload(i)), { days: 14, now: NOW });
    expect(calls.map((c) => [c.queries.length, c.token ?? null])).toEqual([[5, null], [5, 'page-2'], [5, null], [2, null]]);
    expect(out).toMatchObject({ account: A, region: R, from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), unreadable: {} });
    expect(out.minutes[tg(0)]).toEqual([[2, 1], [9, 4]]);
    expect(out.minutes[tg(1)]).toEqual([[9, 7]]);
    // No value at all: no request in 14 days, not unreadable.
    expect(out.minutes[tg(11)]).toEqual([]);
  });

  it('a workload Dormeto manages: its application and waker target groups added up, five metrics a call', async () => {
    const managed = { ...workload(0), managed: true as const, wakerTargetGroupArn: tg(9) };
    const { port, calls } = cloudwatch((arn) => (arn === tg(0) ? { Timestamps: [minute(9), minute(4)], Values: [2, 1], StatusCode: 'Complete' } : arn === tg(9) ? { Timestamps: [minute(9), minute(5)], Values: [3, 6], StatusCode: 'Complete' } : { Timestamps: [], Values: [], StatusCode: 'Complete' }));
    const out = await readRequests(port, [managed, workload(1), workload(2), workload(3), workload(4)], { days: 14, now: NOW });
    // Six metrics: five in the first call (two pages), one in the next.
    expect(calls.map((c) => c.queries.length)).toEqual([5, 5, 1]);
    expect(out.minutes[tg(0)]).toEqual([[4, 1], [5, 6], [9, 5]]);
    expect(out.minutes[tg(9)]).toBeUndefined();
  });

  it('a metric CloudWatch could not read is unreadable, the others are read', async () => {
    const { port } = cloudwatch((arn) => (arn === tg(1) ? { Timestamps: [], Values: [], StatusCode: 'Forbidden', Messages: [{ Code: 'Forbidden', Value: 'not authorized' }] } : { Timestamps: [minute(3)], Values: [2], StatusCode: 'Complete' }));
    const out = await readRequests(port, [workload(0), workload(1)], { days: 14, now: NOW });
    expect(out.unreadable).toEqual({ [tg(1)]: 'CloudWatch could not read the requests (Forbidden: not authorized)' });
    expect(out.minutes[tg(0)]).toEqual([[3, 2]]);
    expect(out.minutes[tg(1)]).toBeUndefined();
  });
});

describe('the requests of every region', () => {
  const region = (workloads: Workload[], over: Partial<RegionDiscovery> = {}): RegionDiscovery => ({ account: A, region: R, workloads, ineligible: [], ...over });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    let reads = 0;
    let t = NOW;
    const run = (regions: RegionDiscovery[], refresh: 'discovery' | 'metrics' | null = null) => requestsAll({
      regions, cache: createCache({ dir, now: () => t }), refresh, now: () => t,
      cloudwatchOf: async () => ({ getMetricData: async (input) => { reads += 1; return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: [], Values: [], StatusCode: 'Complete' })) }; } }),
    });
    return { run, reads: () => reads, later: (ms: number) => { t += ms; } };
  }

  it('kept per account and region the same UTC day, read again the next day or when refreshed', async () => {
    const s = setup();
    const regions = [region([workload(0)])];
    await s.run(regions);
    await s.run(regions);
    expect(s.reads()).toBe(1);
    await s.run(regions, 'metrics');
    await s.run(regions, 'discovery');
    expect(s.reads()).toBe(3);
    s.later(12 * 3_600_000);
    await s.run(regions);
    expect(s.reads()).toBe(4);
  });

  it('a region whose requests cannot be read at all: its workloads unreadable with AWS\'s reason, the others read, nothing kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    let reads = 0;
    const regions = [region([workload(0)]), region([{ ...workload(1), region: 'eu-west-3' }], { region: 'eu-west-3' })];
    const run = () => requestsAll({
      regions, cache: createCache({ dir, now: () => NOW }), refresh: null, now: () => NOW,
      cloudwatchOf: async (_account, where) => {
        if (where === R) throw Object.assign(new Error('User is not authorized to perform: cloudwatch:GetMetricData with an explicit deny in a service control policy'), { name: 'AccessDenied' });
        return { getMetricData: async (input) => { reads += 1; return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: [], Values: [], StatusCode: 'Complete' })) }; } };
      },
    });
    const out = await run();
    expect(out[0]).toMatchObject({ region: R, unreadable: { [tg(0)]: 'AccessDenied: User is not authorized to perform: cloudwatch:GetMetricData with an explicit deny in a service control policy' } });
    expect(out[1]!.minutes[tg(1)]).toEqual([]);
    await run();
    expect(reads).toBe(1);
  });

  it('a region without workload or that failed asks nothing; a kept file missing a new workload is read again', async () => {
    const s = setup();
    const out = await s.run([region([]), region([], { region: 'eu-west-3', error: 'opt-in region' })]);
    expect(out).toEqual([]);
    expect(s.reads()).toBe(0);
    await s.run([region([workload(0)])]);
    await s.run([region([workload(0), workload(1)])]);
    expect(s.reads()).toBe(2);
  });
});
