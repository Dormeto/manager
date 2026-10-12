// Phase 3 of the estimate (spec §6): each eligible workload's R10 replay priced by the product's price book, what is
// left out and why, the totals by account, region and all, net of Dormeto's cost.
import { describe, expect, it } from 'vitest';
import { DORMETO_COST, idleWindowAdvice, type StoppedItem } from '@dormeto/fleet';
import type { Reached } from '../src/accounts.js';
import type { RegionDiscovery, Workload } from '../src/discover.js';
import { estimateAll } from '../src/estimate.js';
import type { RegionRequests } from '../src/requests.js';

const A = '111111111111';
const B = '222222222222';
const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const TO = '2026-10-10T12:00:00.000Z';
const FROM = '2026-09-26T12:00:00.000Z';
const T3: StoppedItem = { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' };
const FARGATE: StoppedItem = { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'arm64', os: 'Linux' };
const HUGE: StoppedItem = { kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux' };
const hourly = async (_region: string, item: StoppedItem) => (item.kind === 'ec2' && item.type === 't3.medium' ? 0.0456 : item.kind === 'fargate' ? 0.0099 : null);
const daily: [number, number][] = Array.from({ length: 14 }, (_, d) => [600 + d * 1440, 3]);
const w = (account: string, region: string, name: string, stopped: StoppedItem[]): Workload => ({
  account, region, loadBalancer: 'web', loadBalancerArn: `arn:lb/${name}`, targetGroup: name, targetGroupArn: `arn:tg/${name}`, hosts: [`${name}.example.com`], backend: { kind: 'asg', id: name }, stopped,
});
const W = {
  priced: w(A, 'eu-west-1', 'shop', [T3]), quiet: w(A, 'eu-west-1', 'docs', [FARGATE]), unpriced: w(A, 'eu-west-1', 'gpu', [HUGE]),
  empty: w(A, 'eu-west-1', 'batch', []), unread: w(A, 'eu-west-1', 'blog', [T3]), other: w(B, 'eu-west-1', 'crm', [T3]),
};
const reached: Reached = { organization: 'o-abc123', why: null, accounts: [{ account: A, name: 'prod', credentials: async () => null }, { account: B, name: 'staging', credentials: async () => null }], unreachable: [{ account: '333333333333', name: 'sandbox', reason: 'denied', fix: 'create a role' }] };
const regions: RegionDiscovery[] = [
  { account: A, region: 'eu-west-1', workloads: [W.priced, W.quiet, W.unpriced, W.empty, W.unread], ineligible: [{ loadBalancer: 'web', targetGroup: 'shared', hosts: [], reason: 'its target group is shared' }] },
  { account: A, region: 'eu-west-3', workloads: [], ineligible: [], error: 'opt-in region not enabled' },
  { account: B, region: 'eu-west-1', workloads: [W.other], ineligible: [] },
];
const requests: RegionRequests[] = [
  { account: A, region: 'eu-west-1', from: FROM, to: TO, minutes: { 'arn:tg/shop': daily, 'arn:tg/docs': [], 'arn:tg/gpu': daily, 'arn:tg/batch': daily }, unreadable: { 'arn:tg/blog': 'CloudWatch could not read the requests (Forbidden)' } },
  { account: B, region: 'eu-west-1', from: FROM, to: TO, minutes: { 'arn:tg/crm': daily }, unreadable: {} },
];
const OPTIONS = { regions: null, role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' as const }, discounts: { compute: 0, databases: 0 }, refresh: null };
const run = (over: Partial<Parameters<typeof estimateAll>[0]> = {}) => estimateAll({ reached, regions, requests, hourly, baseline: { kind: 'always' }, options: OPTIONS, now: NOW, ...over });
// The product's replay, as the estimate must call it (decision 5).
const advise = (minutes: [number, number][], stopped: StoppedItem[], baseline = { kind: 'always' } as Parameters<typeof idleWindowAdvice>[0]['baseline']) => idleWindowAdvice({
  requests: { from: FROM, to: TO, minutes }, current: 15, checkMinutes: 5, wakeMs: 60_000, startAsleep: false, actualWakes: 0, actualFrom: null, stopped,
  hourly: (item) => hourly('eu-west-1', item), baseline, wakerTargetGroup: false, now: NOW,
});
const row = (a: Awaited<ReturnType<typeof advise>>, minutes: number) => a.windows.find((r) => r.minutes === minutes)!;

describe('the estimate', () => {
  it('each priced workload at 15 minutes and at its recommended window, as the product\'s replay gives them', async () => {
    const e = await run();
    expect(e.workloads.map((x) => x.workload.targetGroup)).toEqual(['shop', 'docs', 'crm']);
    const shop = e.workloads[0]!;
    const expected = await advise(daily, [T3]);
    expect(shop.at15).toEqual({ usdMonth: row(expected, 15).usdMonth, wakesPerDay: row(expected, 15).wakesPerDay, asleepHours: row(expected, 15).asleepHours });
    expect(shop.recommended).toEqual({ minutes: expected.recommended, usdMonth: row(expected, expected.recommended).usdMonth, wakesPerDay: row(expected, expected.recommended).wakesPerDay });
    // No request in 14 days: estimated, asleep throughout.
    expect(e.workloads[1]).toMatchObject({ quiet: true, at15: { wakesPerDay: 0 } });
    expect(shop.quiet).toBe(false);
  });

  it('leaves out, with the reason, what cannot be estimated', async () => {
    const e = await run();
    expect(e.leftOut.map((l) => [l.workload.targetGroup, l.reason])).toEqual([
      ['gpu', 'what it stops has no AWS list price'],
      ['batch', 'nothing running to stop (an Auto Scaling group at 0, an ECS service on EC2 capacity, or no instance)'],
      ['blog', 'requests unreadable: CloudWatch could not read the requests (Forbidden)'],
    ]);
    expect(e.ineligible).toEqual([{ account: A, region: 'eu-west-1', loadBalancer: 'web', targetGroup: 'shared', hosts: [], reason: 'its target group is shared' }]);
    expect(e.failedRegions).toEqual([{ account: A, region: 'eu-west-3', error: 'opt-in region not enabled' }]);
    expect(e.unreachable).toEqual(reached.unreachable);
  });

  it('totals by account, region and all, net of Dormeto\'s cost (a router per account and region with workloads)', async () => {
    const e = await run();
    const sum = (f: (x: (typeof e.workloads)[number]) => number) => e.workloads.reduce((n, x) => n + f(x), 0);
    expect(e.totals.workloads).toBe(3);
    expect(e.totals.usdMonth15).toBeCloseTo(sum((x) => x.at15.usdMonth), 9);
    expect(e.totals.usdMonthRecommended).toBeCloseTo(sum((x) => x.recommended.usdMonth), 9);
    expect(e.totals.dormetoMonth).toBeCloseTo(DORMETO_COST.manager + 2 * DORMETO_COST.router + 3 * DORMETO_COST.workload, 9);
    expect(e.byAccount[A]).toMatchObject({ workloads: 2 });
    expect(e.byAccount[A]!.dormetoMonth).toBeCloseTo(DORMETO_COST.router + 2 * DORMETO_COST.workload, 9);
    expect(e.byRegion['eu-west-1']).toMatchObject({ workloads: 3 });
    expect(e.byRegion['eu-west-1']!.dormetoMonth).toBeCloseTo(2 * DORMETO_COST.router + 3 * DORMETO_COST.workload, 9);
    expect(e).toMatchObject({ organization: 'o-abc123', accounts: 2, generatedAt: new Date(NOW).toISOString() });
    expect(e.assumptions.join(' ')).toContain('Every request counts');
  });

  it('within the business-hours baseline, as the product prices it', async () => {
    const paris = { kind: 'business-hours' as const, timeZone: 'Europe/Paris' };
    const e = await run({ baseline: paris });
    expect(e.workloads[0]!.at15.usdMonth).toBeCloseTo(row(await advise(daily, [T3], paris), 15).usdMonth!, 9);
    expect(e.workloads[0]!.at15.usdMonth).toBeLessThan((await run()).workloads[0]!.at15.usdMonth);
  });
});
