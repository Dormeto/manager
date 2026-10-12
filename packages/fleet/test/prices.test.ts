// The price book (R9b): AWS's on-demand list prices from the Price List API, cached; what it cannot price is null.
import { describe, expect, it } from 'vitest';
import { createPriceBook } from '../src/prices.js';

// A product as the Price List API answers it (a JSON string), with one on-demand term.
const product = (attributes: Record<string, string>, usd: string, unit = 'Hrs') => JSON.stringify({
  product: { attributes },
  terms: { OnDemand: { 'X.JRTCKXETXF': { priceDimensions: { 'X.JRTCKXETXF.6YS6EN2CT7': { unit, pricePerUnit: { USD: usd } } } } } },
});

function setup(answers: (filters: Record<string, string>) => string[]) {
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
  const store = { getPrice: async (key: string) => (cache.has(key) ? { usd: cache.get(key)!, fresh: true } : null), putPrice: async (key: string, usd: number | null) => { cache.set(key, usd); } };
  const book = createPriceBook({ pricing, store, now: () => t });
  return { book, asked, cache, advance: (ms: number) => { t += ms; } };
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
});
