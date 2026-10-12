// The daily savings job (R9b): each workload's previous day priced from its history, a day item per workload, and the
// summary the Overview reads; idempotent.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore } from '@dormeto/fleet';
import { createSavingsJob } from '../src/savings-job.js';

const ACCOUNT = '121014831971';
const DAY = '2026-10-07';
const NOW = Date.parse('2026-10-08T00:30:00.000Z');
const at = (h: number, m = 0) => new Date(Date.parse(`${DAY}T00:00:00.000Z`) + (h * 60 + m) * 60_000).toISOString();
const T3 = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };

async function setup() {
  const dynamo = fakeDynamo();
  const fleet = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
  const summary = (id: string, name: string) => ({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, name, state: 'ASLEEP', checkedAt: at(23) });
  await fleet.writeWorkload(summary('a', 'Shop') as never, 0);
  await fleet.writeWorkload(summary('b', 'Blog') as never, 0);
  await fleet.writeWorkload(summary('c', 'Old') as never, 0);
  const put = (id: string, to: string, when: string, extra: Record<string, unknown> = {}) => fleet.putHistory({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, from: null, to, at: when, ...extra } as never);
  // a: asleep all day from the evening before (t3.medium); b: asleep 06:00 to 18:00 (t3.medium); c: asleep, its router before 0.27.0.
  await put('a', 'ASLEEP', '2026-10-06T20:00:00.000Z', { stopped: [T3] });
  await put('b', 'AWAKE', '2026-10-06T08:00:00.000Z');
  await put('b', 'ASLEEP', at(6), { stopped: [T3] });
  await put('b', 'AWAKE', at(18));
  await put('c', 'ASLEEP', '2026-10-06T20:00:00.000Z');
  const prices = { hourly: async (_region: string, item: { kind: string }) => (item.kind === 'ec2' ? 0.0456 : null) };
  const job = createSavingsJob({ fleet, prices, baseline: { kind: 'always' }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} } });
  return { dynamo, fleet, job };
}

describe('savings job', () => {
  it('prices the previous day of each workload into day items, and sums the fleet in the summary', async () => {
    const s = await setup();
    await s.job.run();
    const day = await s.fleet.listSavingsDay(DAY);
    expect(day.map((d) => [d.workloadId, Number(d.usd.toFixed(4)), d.asleepHours])).toEqual([['a', 1.0944, 24], ['b', 0.5472, 12], ['c', 0, 24]]);
    expect(day.find((d) => d.workloadId === 'c')!.unpriced).toEqual([{ reason: 'not described (a router before 0.27.0)', hours: 24 }]);
    const summary = (await s.fleet.getSavingsSummary())!;
    expect(summary.day).toBe(DAY);
    expect(summary.last30.usd).toBeCloseTo(1.6416, 4);
    expect(summary.last30.days.at(-1)).toEqual({ date: DAY, usd: expect.closeTo(1.6416, 4) });
    expect(summary.month).toEqual({ month: '2026-10', usd: expect.closeTo(1.6416, 4) });
    expect(summary.cumulative).toEqual({ usd: expect.closeTo(1.6416, 4), since: DAY, lastDay: DAY });
    expect(summary.top.map((t) => t.workloadId)).toEqual(['a', 'b']);
    expect(summary.unpriced).toEqual({ workloads: 1, hours: 24 });
    expect(summary.baseline).toEqual({ kind: 'always' });
    // The cost model: $5 for the manager, $0.26 per router, $0.13 per workload a month.
    expect(summary.dormeto.usdMonth).toBeCloseTo(5 + 0.26 * 1 + 0.13 * 3, 6);
  });

  it('is idempotent: a second run for the same day writes the same items and adds nothing to the cumulative total', async () => {
    const s = await setup();
    await s.job.run();
    await s.job.run();
    await s.job.run({ day: DAY });
    expect(await s.fleet.listSavingsDay(DAY)).toHaveLength(3);
    expect((await s.fleet.getSavingsSummary())!.cumulative.usd).toBeCloseTo(1.6416, 4);
  });

  it('a day computed out of order counts in the cumulative total, and a day run again replaces its own amount (review I1)', async () => {
    const s = await setup();
    await s.job.run({ day: DAY });
    await s.job.run({ day: '2026-10-06' });
    const both = (await s.fleet.getSavingsSummary())!;
    // 2026-10-06: a asleep from 20:00 (4 hours of t3.medium).
    expect(both.cumulative.usd).toBeCloseTo(1.6416 + 4 * 0.0456, 4);
    expect([both.cumulative.since, both.day]).toEqual(['2026-10-06', DAY]);
    await s.job.run({ day: '2026-10-06' });
    expect((await s.fleet.getSavingsSummary())!.cumulative.usd).toBeCloseTo(1.6416 + 4 * 0.0456, 4);
  });

  it('one workload whose history cannot be read is said, and the others are priced (review I1)', async () => {
    const s = await setup();
    const list = s.fleet.listHistory;
    s.fleet.listHistory = async (account, region, id, ...rest) => { if (id === 'b') throw new Error('ProvisionedThroughputExceededException'); return list(account, region, id, ...rest); };
    const job = createSavingsJob({ fleet: s.fleet, prices: { hourly: async () => 0.0456 }, baseline: { kind: 'always' }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} } });
    await job.run();
    expect((await s.fleet.listSavingsDay(DAY)).map((d) => d.workloadId)).toEqual(['a', 'c']);
    expect((await s.fleet.getSavingsSummary())!.failed).toBe(1);
  });

  it('prices with the discounts set, read once per run, and records those of its latest day in the summary (R9.5)', async () => {
    const s = await setup();
    await s.fleet.putSavingsSettings({ compute: 20, databases: 30 }, 'admin@example.com');
    let reads = 0;
    const seen: unknown[] = [];
    const fleet = { ...s.fleet, getSavingsSettings: async () => { reads += 1; return s.fleet.getSavingsSettings(); } };
    const prices = { hourly: async (_region: string, item: { kind: string }, discounts?: { compute: number; databases: number }) => { seen.push(discounts); return item.kind === 'ec2' ? 0.0456 * (1 - (discounts?.compute ?? 0) / 100) : null; } };
    const job = createSavingsJob({ fleet, prices, baseline: { kind: 'always' }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} } });
    await job.run();
    expect(reads).toBe(1);
    expect(new Set(seen.map((d) => JSON.stringify(d)))).toEqual(new Set([JSON.stringify({ compute: 20, databases: 30 })]));
    const day = await s.fleet.listSavingsDay(DAY);
    expect(day.find((d) => d.workloadId === 'a')!.usd).toBeCloseTo(0.8 * 1.0944, 4);
    expect((await s.fleet.getSavingsSummary())!.discounts).toEqual({ compute: 20, databases: 30 });
    // An earlier day run again by hand keeps the discounts of the latest day in the summary.
    await s.fleet.putSavingsSettings({ compute: 50, databases: 50 }, 'admin@example.com');
    await job.run({ day: '2026-10-06' });
    expect((await s.fleet.getSavingsSummary())!.discounts).toEqual({ compute: 20, databases: 30 });
  });
});
