// The daily savings job (R9b): each workload's previous day priced from its history, a day item per workload, and the
// summary the Overview reads; idempotent.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore, createPriceBook } from '@dormeto/fleet';
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

  // One AWS workload (t3.medium, a fake Price List at $0.0456) and one on Google Cloud (an e2-standard-2 asleep all day in
  // europe-west1, a fake Catalog: $0.02 a core, $0.003 a GiB), both through the job's real price book.
  async function mixed(catalogFails: boolean) {
    const dynamo = fakeDynamo();
    const fleet = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
    const summary = (account: string, region: string, router: string, id: string) => ({ account, region, router, workloadId: id, name: id, state: 'ASLEEP', checkedAt: at(23) });
    await fleet.writeWorkload(summary(ACCOUNT, 'eu-west-1', 'dmt-dev', 'aws') as never, 0);
    await fleet.writeWorkload(summary('dormeto-dev', 'europe-west1', 'dmt-dev-gcp', 'gcp') as never, 0);
    const GCE = { kind: 'gce', machineType: 'e2-standard-2', family: 'e2', vcpus: 2, memoryGb: 8, count: 1, os: 'linux', zone: 'europe-west1-b' };
    await fleet.putHistory({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'aws', from: null, to: 'ASLEEP', at: '2026-10-06T20:00:00.000Z', stopped: [T3] } as never);
    await fleet.putHistory({ account: 'dormeto-dev', region: 'europe-west1', router: 'dmt-dev-gcp', workloadId: 'gcp', from: null, to: 'ASLEEP', at: '2026-10-06T20:00:00.000Z', stopped: [GCE] } as never);
    const sku = (description: string, usageUnit: string, nanos: number) => ({
      description, category: { resourceFamily: 'Compute', usageType: 'OnDemand' }, serviceRegions: ['europe-west1'],
      pricingInfo: [{ pricingExpression: { usageUnit, tieredRates: [{ unitPrice: { units: '0', nanos } }] } }],
    });
    const asked: string[] = [];
    const catalog = { async skus(service: string) { asked.push(service); if (catalogFails) throw new Error('The Cloud Billing API refused the discovery account'); return { skus: [sku('E2 Instance Core running in EMEA', 'h', 20_000_000), sku('E2 Instance Ram running in EMEA', 'GiBy.h', 3_000_000)] }; } };
    const pricing = { async getProducts() { return { PriceList: [JSON.stringify({ terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: '0.0456000000' } } } } } } })] }; } };
    const logged: { event: string; data?: object }[] = [];
    const prices = createPriceBook({ pricing, store: fleet, catalog, onCatalogRead: (read) => logged.push({ event: 'GooglePricesRead', data: read }), now: () => NOW });
    const job = createSavingsJob({ fleet, prices, baseline: { kind: 'always' }, now: () => NOW, log: { info: (event, data) => logged.push({ event, data }), warn: () => {}, error: () => {} } });
    return { fleet, job, asked, logged };
  }

  it('prices an AWS workload and a Google Cloud one in one run, the summary adding them', async () => {
    const s = await mixed(false);
    await s.job.run();
    const day = await s.fleet.listSavingsDay(DAY);
    // 24 hours of 0.0456, and of 2 × 0.02 + 8 × 0.003 = 0.064.
    expect(day.map((d) => [d.workloadId, Number(d.usd.toFixed(4)), d.unpriced])).toEqual([['aws', 1.0944, []], ['gcp', 1.536, []]]);
    expect((await s.fleet.getSavingsSummary())!.last30.usd).toBeCloseTo(1.0944 + 1.536, 4);
    expect((await s.fleet.getSavingsSummary())!.unpriced).toEqual({ workloads: 0, hours: 0 });
    // Its Catalog read is said once, and cached for the next run (30 days).
    expect(s.asked).toEqual(['6F81-5844-456A']);
    expect(s.logged.filter((l) => l.event === 'GooglePricesRead').map((l) => l.data)).toEqual([{ service: '6F81-5844-456A', pages: 1, skus: 2, ms: 0 }]);
    expect(await s.fleet.getPrice('europe-west1#gce#e2#core#ondemand')).toEqual({ usd: 0.02 });
  });

  it('a Catalog that fails prices the AWS workload, leaves the Google Cloud one\'s hours not priced, caches nothing, and does not fail the run', async () => {
    const s = await mixed(true);
    await s.job.run();
    const day = await s.fleet.listSavingsDay(DAY);
    expect(day.map((d) => [d.workloadId, Number(d.usd.toFixed(4)), d.unpriced.map((u) => u.hours)])).toEqual([['aws', 1.0944, []], ['gcp', 0, [24]]]);
    const summary = (await s.fleet.getSavingsSummary())!;
    expect([summary.failed, summary.unpriced, summary.last30.usd]).toEqual([0, { workloads: 1, hours: 24 }, expect.closeTo(1.0944, 4)]);
    expect(await s.fleet.getPrice('europe-west1#gce#e2#core#ondemand')).toBeNull();
    expect(s.logged.some((l) => l.event === 'GooglePricesRead')).toBe(false);
  });
});
