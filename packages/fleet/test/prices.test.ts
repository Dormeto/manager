// The price book (R9b): AWS's on-demand list prices from the Price List API, cached; what it cannot price is null.
import { describe, expect, it } from 'vitest';
import { createPriceBook } from '../src/prices.js';

// A product as the Price List API answers it (a JSON string), with one on-demand term.
const product = (attributes: Record<string, string>, usd: string, unit = 'Hrs') => JSON.stringify({
  product: { attributes },
  terms: { OnDemand: { 'X.JRTCKXETXF': { priceDimensions: { 'X.JRTCKXETXF.6YS6EN2CT7': { unit, pricePerUnit: { USD: usd } } } } } },
});

type SpotEntry = { AvailabilityZone?: string; SpotPrice?: string; Timestamp?: Date };
function setup(answers: (filters: Record<string, string>) => string[], spotAnswer: (region: string, input: { InstanceTypes: string[]; ProductDescriptions: string[] }) => SpotEntry[] = () => []) {
  const asked: Record<string, string>[] = [];
  const cache = new Map<string, number | null>();
  const pricing = {
    async getProducts(input: { ServiceCode: string; Filters: { Type: string; Field: string; Value: string }[] }) {
      const filters = Object.fromEntries([['ServiceCode', input.ServiceCode], ...input.Filters.map((f) => [`${f.Type === 'CONTAINS' ? '~' : ''}${f.Field}`, f.Value])]);
      asked.push(filters);
      return { PriceList: answers(filters) };
    },
  };
  let t = Date.parse('2026-10-08T12:00:00.000Z');
  const days = new Map<string, number>();
  const store = { getPrice: async (key: string) => (cache.has(key) ? { usd: cache.get(key)!, fresh: true } : null), putPrice: async (key: string, usd: number | null, d = 30) => { cache.set(key, usd); days.set(key, d); } };
  const spotAsked: { region: string; InstanceTypes: string[]; ProductDescriptions: string[]; StartTime: Date }[] = [];
  const spot = { async history(region: string, input: { InstanceTypes: string[]; ProductDescriptions: string[]; StartTime: Date }) { spotAsked.push({ region, ...input }); return { SpotPriceHistory: spotAnswer(region, input) }; } };
  const book = createPriceBook({ pricing, spot, store, now: () => t });
  return { book, asked, cache, days, spotAsked, advance: (ms: number) => { t += ms; } };
}

describe('price book', () => {
  it('prices EC2 by type, region and OS, times the count; asks once, then reads the cache', async () => {
    const s = setup((f) => (f.ServiceCode === 'AmazonEC2' && f.instanceType === 't3.medium' && f.regionCode === 'eu-west-1' && f.operatingSystem === 'Linux' ? [product({ instanceType: 't3.medium' }, '0.0456000000')] : []));
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' })).toBeCloseTo(0.0912, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' })).toBeCloseTo(0.0456, 6);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ tenancy: 'Shared', preInstalledSw: 'NA', capacitystatus: 'Used' });
  });

  it('prices Fargate by vCPU and GB hours, x86 or ARM, times the count', async () => {
    const s = setup((f) => {
      const usage = f['~usagetype'];
      const usd = { 'Fargate-vCPU-Hours:perCPU': '0.0404800000', 'Fargate-GB-Hours': '0.0044450000', 'Fargate-ARM-vCPU-Hours:perCPU': '0.0323800000', 'Fargate-ARM-GB-Hours': '0.0035600000' }[usage ?? ''];
      return f.ServiceCode === 'AmazonECS' && usd ? [product({ usagetype: `EU-${usage}` }, usd, 'hours')] : [];
    });
    expect(await s.book.hourly('eu-west-1', { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 2, arch: 'x86_64', os: 'Linux' })).toBeCloseTo(2 * (0.5 * 0.04048 + 1 * 0.004445), 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'fargate', vcpu: 1, memoryGb: 2, count: 1, arch: 'arm64', os: 'Linux' })).toBeCloseTo(0.03238 + 2 * 0.00356, 6);
  });

  it('prices RDS by class, engine and deployment, Aurora Serverless v2 by ACU; Multi-AZ is its own price', async () => {
    const s = setup((f) => {
      if (f.ServiceCode !== 'AmazonRDS') return [];
      if (f['~usagetype'] === 'Aurora:ServerlessV2Usage' && f.databaseEngine === 'Aurora MySQL') return [product({}, '0.1400000000', 'ACU-Hr')];
      if (f.instanceType === 'db.t4g.micro' && f.databaseEngine === 'PostgreSQL') return [product({}, f.deploymentOption === 'Multi-AZ' ? '0.0350000000' : '0.0170000000')];
      return [];
    });
    expect(await s.book.hourly('eu-west-1', { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false })).toBeCloseTo(0.017, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true })).toBeCloseTo(0.035, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 })).toBeCloseTo(0.07, 6);
  });

  it('cannot price another OS, Oracle or SQL Server, an unknown item, or what the API does not return (cached as such)', async () => {
    const s = setup(() => []);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'm5.large', count: 1, os: 'Red Hat Enterprise Linux' })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { kind: 'rds', class: 'db.m5.large', engine: 'oracle-ee', multiAz: false })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { kind: 'unknown', backend: 'ecs:x', reason: 'denied' })).toBeNull();
    expect(s.asked).toHaveLength(0);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux' })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux' })).toBeNull();
    expect(s.asked).toHaveLength(1);
  });

  it('a throttled API prices nothing for that item, without caching it', async () => {
    let calls = 0;
    const s = setup(() => []);
    const book = createPriceBook({
      pricing: { async getProducts() { calls += 1; throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }); } },
      store: { getPrice: async () => null, putPrice: async (k: string, v: number | null) => { s.cache.set(k, v); } }, now: () => 0,
    });
    expect(await book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' })).toBeNull();
    expect(calls).toBe(1);
    expect(s.cache.size).toBe(0);
  });

  it('reads the SDK\'s answer, whose products are String objects, not strings (found live)', async () => {
    const s = setup((f) => (f.instanceType === 't4g.nano' ? [new String(product({ instanceType: 't4g.nano' }, '0.0046000000')) as unknown as string] : []));
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't4g.nano', count: 1, os: 'Linux' })).toBeCloseTo(0.0046, 6);
  });

  it('asks for AWS regions only, and RDS by its usage type (not I/O-Optimized); several products of different prices are no price (review I2)', async () => {
    const s = setup((f) => (f.ServiceCode === 'AmazonRDS' ? [product({}, '0.2900000000'), product({}, '0.3770000000')] : [product({}, '0.0456000000'), product({}, '0.0456000000')]));
    expect(await s.book.hourly('eu-west-1', { kind: 'rds', class: 'db.r6g.large', engine: 'aurora-postgresql', multiAz: false })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' })).toBeCloseTo(0.0456, 6);
    expect(s.asked.find((a) => a.ServiceCode === 'AmazonRDS')).toMatchObject({ locationType: 'AWS Region', '~usagetype': 'InstanceUsage:' });
    expect(s.asked.find((a) => a.ServiceCode === 'AmazonEC2')).toMatchObject({ locationType: 'AWS Region' });
    const multi = setup(() => [product({}, '0.0350000000')]);
    await multi.book.hourly('eu-west-1', { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true });
    expect(multi.asked[0]).toMatchObject({ '~usagetype': 'Multi-AZUsage:' });
  });

  it('keeps prices in memory, shares a price being asked, and remembers a failure for minutes (review I5)', async () => {
    let calls = 0;
    let failing = true;
    let t = 0;
    const reads: string[] = [];
    const book = createPriceBook({
      pricing: { async getProducts() { calls += 1; if (failing) throw new Error('Rate exceeded'); return { PriceList: [product({}, '0.0456000000')] }; } },
      store: { getPrice: async (k: string) => { reads.push(k); return null; }, putPrice: async () => {} }, now: () => t,
    });
    const item = { kind: 'ec2' as const, type: 't3.medium', count: 1, os: 'Linux' };
    await Promise.all([book.hourly('eu-west-1', item), book.hourly('eu-west-1', item), book.hourly('eu-west-1', item)]);
    expect(calls).toBe(1);
    await book.hourly('eu-west-1', item);
    expect(calls, 'a failure remembered').toBe(1);
    failing = false;
    t += 6 * 60_000;
    expect(await book.hourly('eu-west-1', item)).toBeCloseTo(0.0456, 6);
    const before = reads.length;
    expect(await book.hourly('eu-west-1', item)).toBeCloseTo(0.0456, 6);
    expect(reads.length, 'from memory, not the table').toBe(before);
  });

  // R9.5b: Spot capacity at Spot prices, commitments as discounts.
  const HOUR = 3_600_000;
  const T = Date.parse('2026-10-08T12:00:00.000Z');
  const FARGATE = (f: Record<string, string>) => {
    const usd = { 'Fargate-vCPU-Hours:perCPU': '0.0404800000', 'Fargate-GB-Hours': '0.0044450000' }[f['~usagetype'] ?? ''];
    return f.ServiceCode === 'AmazonECS' && usd ? [product({}, usd, 'hours')] : [];
  };
  const fargate = { kind: 'fargate' as const, vcpu: 0.5, memoryGb: 1, count: 2, arch: 'x86_64', os: 'Linux' };
  const fargateUsd = 2 * (0.5 * 0.04048 + 1 * 0.004445);

  it('prices a Spot instance at the region\'s Spot price: the latest of each zone averaged, times the count; cached a day', async () => {
    const s = setup(() => [], () => [
      { AvailabilityZone: 'eu-west-1a', SpotPrice: '0.020000', Timestamp: new Date(T - HOUR) },
      { AvailabilityZone: 'eu-west-1a', SpotPrice: '0.030000', Timestamp: new Date(T - 3 * HOUR) },
      { AvailabilityZone: 'eu-west-1b', SpotPrice: '0.018000', Timestamp: new Date(T - 2 * HOUR) },
    ]);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux', spot: true })).toBeCloseTo(2 * 0.019, 6);
    expect(s.spotAsked).toEqual([{ region: 'eu-west-1', InstanceTypes: ['t3.medium'], ProductDescriptions: ['Linux/UNIX'], StartTime: new Date(T) }]);
    expect([s.cache.get('eu-west-1#ec2-spot#t3.medium#Linux'), s.days.get('eu-west-1#ec2-spot#t3.medium#Linux')]).toEqual([0.019, 1]);
    expect(s.asked).toEqual([]);
  });

  it('asks Windows as Windows; another OS, or no answer, is no Spot price (none cached a day)', async () => {
    const s = setup(() => [], (_r, input) => (input.ProductDescriptions[0] === 'Windows' ? [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.050000', Timestamp: new Date(T) }] : []));
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'm5.large', count: 1, os: 'Windows', spot: true })).toBeCloseTo(0.05, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'm5.large', count: 1, os: 'Red Hat Enterprise Linux', spot: true })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux', spot: true })).toBeNull();
    expect(s.spotAsked.map((a) => a.ProductDescriptions[0])).toEqual(['Windows', 'Linux/UNIX']);
    expect([s.cache.get('eu-west-1#ec2-spot#x9.huge#Linux'), s.days.get('eu-west-1#ec2-spot#x9.huge#Linux')]).toEqual([null, 1]);
  });

  it('a region the manager\'s account has not enabled prices nothing, caches nothing, and is asked again after five minutes', async () => {
    let calls = 0;
    const s = setup(() => [], () => { calls += 1; throw Object.assign(new Error('You are not subscribed to this service'), { name: 'OptInRequired' }); });
    expect(await s.book.hourly('ap-east-2', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux', spot: true })).toBeNull();
    expect(await s.book.hourly('ap-east-2', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux', spot: true })).toBeNull();
    expect([calls, s.cache.size]).toEqual([1, 0]);
    s.advance(301_000);
    await s.book.hourly('ap-east-2', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux', spot: true });
    expect(calls).toBe(2);
  });

  it('prices Fargate Spot at 30% of the on-demand price (AWS\'s largest discount: the smallest saving)', async () => {
    const s = setup(FARGATE);
    expect(await s.book.hourly('eu-west-1', { ...fargate, spot: true })).toBeCloseTo(0.3 * fargateUsd, 6);
    expect(await s.book.hourly('eu-west-1', fargate)).toBeCloseTo(fargateUsd, 6);
  });

  it('takes the compute discount off on-demand EC2 and Fargate, the databases one off RDS and Aurora, none off Spot', async () => {
    const s = setup((f) => {
      if (f.ServiceCode === 'AmazonEC2') return [product({}, '0.0456000000')];
      if (f.ServiceCode === 'AmazonRDS') return [product({}, f['~usagetype'] === 'Aurora:ServerlessV2Usage' ? '0.1400000000' : '0.0170000000')];
      return FARGATE(f);
    }, () => [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.019000', Timestamp: new Date(T) }]);
    const discounts = { compute: 20, databases: 30 };
    const ec2 = { kind: 'ec2' as const, type: 't3.medium', count: 2, os: 'Linux' };
    expect(await s.book.hourly('eu-west-1', ec2, discounts)).toBeCloseTo(0.8 * 0.0912, 6);
    expect(await s.book.hourly('eu-west-1', fargate, discounts)).toBeCloseTo(0.8 * fargateUsd, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false }, discounts)).toBeCloseTo(0.7 * 0.017, 6);
    expect(await s.book.hourly('eu-west-1', { kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 }, discounts)).toBeCloseTo(0.7 * 0.07, 6);
    expect(await s.book.hourly('eu-west-1', { ...ec2, spot: true }, discounts)).toBeCloseTo(2 * 0.019, 6);
    expect(await s.book.hourly('eu-west-1', { ...fargate, spot: true }, discounts)).toBeCloseTo(0.3 * fargateUsd, 6);
    // The list price stays as it is, in the table and in memory: no discount taken twice.
    expect(s.cache.get('eu-west-1#ec2#t3.medium#Linux')).toBeCloseTo(0.0456, 6);
    expect(await s.book.hourly('eu-west-1', ec2, discounts)).toBeCloseTo(0.8 * 0.0912, 6);
    expect(await s.book.hourly('eu-west-1', ec2)).toBeCloseTo(0.0912, 6);
  });

  // Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, section 9).
  const pods = { kind: 'k8s-pods' as const, count: 2, cpu: 0.5, memoryGb: 1, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } };
  const M5 = (f: Record<string, string>) => (f.ServiceCode === 'AmazonEC2' && f.instanceType === 'm5.large' && f.operatingSystem === 'Linux' ? [product({}, '0.1070000000')] : []);

  it('prices pods on nodes as their share of the node (the larger of CPU and memory over its allocatable) times its price and the pods', async () => {
    const s = setup(M5, () => [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.040000', Timestamp: new Date(T) }]);
    expect(await s.book.hourly('eu-west-1', pods)).toBeCloseTo(0.107 * (0.5 / 1.93) * 2, 6);
    expect(await s.book.hourly('eu-west-1', { ...pods, cpu: 0.1, memoryGb: 4 })).toBeCloseTo(0.107 * (4 / 6.886) * 2, 6);
    // A pod asking more than its node's allocatable is at most the node.
    expect(await s.book.hourly('eu-west-1', { ...pods, cpu: 3 })).toBeCloseTo(0.107 * 2, 6);
    // Spot (Karpenter's capacity type) at the Spot price, never discounted; on-demand less the compute discount.
    expect(await s.book.hourly('eu-west-1', { ...pods, spot: true }, { compute: 20, databases: 0 })).toBeCloseTo(0.04 * (0.5 / 1.93) * 2, 6);
    expect(await s.book.hourly('eu-west-1', pods, { compute: 20, databases: 0 })).toBeCloseTo(0.8 * 0.107 * (0.5 / 1.93) * 2, 6);
  });

  it('pods on nodes no autoscaler removes save nothing ($0: the nodes stay); without the node\'s type or allocatable they are not priced', async () => {
    const s = setup(M5);
    expect(await s.book.hourly('eu-west-1', { ...pods, autoscaled: false })).toBe(0);
    expect(await s.book.hourly('eu-west-1', { ...pods, nodeType: null })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { ...pods, allocatable: { cpu: 0, memoryGb: 0 } })).toBeNull();
    expect(await s.book.hourly('eu-west-1', { ...pods, nodeType: 'x9.huge' })).toBeNull();
  });
});
