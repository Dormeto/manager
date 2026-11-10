// Google's list prices (Google Cloud design §9.2): the Cloud Billing Catalog's SKUs as the discovery account reads them,
// an index of each service read once per price book, each key cached; what the rules don't name, an ambiguous match, or a
// Catalog that failed is not priced (null), never $0 and never another family's price.
import { describe, expect, it } from 'vitest';
import { createPriceBook, type CatalogSku, type StoppedItem } from '../src/prices.js';

const COMPUTE = '6F81-5844-456A';
const SQL = '9662-B51E-5089';

// A SKU as the Catalog answers it, with one tier (measured on 2026-11-10, europe-west1 unless named).
const sku = (description: string, usageType: string, serviceRegions: string[], usageUnit: string, nanos: number, resourceFamily = 'Compute'): CatalogSku => ({
  description, category: { resourceFamily, resourceGroup: 'CPU', usageType }, serviceRegions,
  pricingInfo: [{ pricingExpression: { usageUnit, tieredRates: [{ startUsageAmount: 0, unitPrice: { currencyCode: 'USD', units: '0', nanos } }] } }],
});
const EW1 = ['europe-west1'];
const COMPUTE_SKUS = [
  sku('E2 Instance Core running in EMEA', 'OnDemand', EW1, 'h', 23_993_370),
  sku('E2 Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 3_216_090),
  sku('Spot Preemptible E2 Instance Core running in EMEA', 'Preemptible', EW1, 'h', 11_650_000),
  sku('Spot Preemptible E2 Instance Ram running in EMEA', 'Preemptible', EW1, 'GiBy.h', 1_564_000),
  sku('Commitment v1: E2 Cpu in EMEA for 3 Year', 'Commit3Yr', EW1, 'h', 10_797_016),
  sku('N1 Predefined Instance Core running in EMEA', 'OnDemand', EW1, 'h', 34_773_000),
  sku('N1 Predefined Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 4_661_000),
  sku('N2D AMD Instance Core running in EMEA', 'OnDemand', EW1, 'h', 30_253_000),
  sku('N2D AMD Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 4_055_000),
  sku('Custom Instance Core running in EMEA', 'OnDemand', EW1, 'h', 36_511_650),
  sku('Custom Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 4_894_050),
  sku('A2 Instance Core running in EMEA', 'OnDemand', EW1, 'h', 34_773_000),
  sku('A2 Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 4_661_000),
  sku('Sole Tenancy Premium for C4 Sole Tenancy Instance Core running in Santiago', 'OnDemand', ['southamerica-west1'], 'h', 4_954_950),
];
const COMPUTE_SKUS_2 = [
  sku('Micro Instance with burstable CPU running in EMEA', 'OnDemand', EW1, 'h', 8_600_000),
  sku('Spot Preemptible Small Instance with 1 VCPU running in EMEA', 'Preemptible', EW1, 'h', 2_565_000),
  sku('C4D Instance Core running in Belgium', 'OnDemand', EW1, 'h', 36_009_800),
  sku('C4D Instance Ram running in Belgium', 'OnDemand', EW1, 'GBy.h', 3_848_981),
  sku('VM state: suspended RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 232_876),
  sku('VM state: suspended RAM in London', 'OnDemand', ['europe-west2'], 'GiBy.h', 279_452),
  sku('VM state: suspended RAM in Dammam', 'OnDemand', ['me-central2'], 'GiBy.h', 372_602),
  // Paris lists no suspended RAM (16 regions of 48 on 2026-11-10).
  sku('E2 Instance Core running in Paris', 'OnDemand', ['europe-west9'], 'h', 25_302_000),
  sku('E2 Instance Ram running in Paris', 'OnDemand', ['europe-west9'], 'GiBy.h', 3_391_000),
  // One SKU for three regions.
  sku('E2 Instance Core running in Americas', 'OnDemand', ['us-central1', 'us-east1', 'us-west1'], 'h', 21_811_590),
  sku('E2 Instance Ram running in Americas', 'OnDemand', ['us-central1', 'us-east1', 'us-west1'], 'GiBy.h', 2_923_530),
];
const SQL_SKUS = [
  sku('Cloud SQL for PostgreSQL: Zonal - vCPU in EMEA', 'OnDemand', EW1, 'h', 41_300_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Zonal - RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 7_000_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Regional - vCPU in EMEA', 'OnDemand', EW1, 'h', 82_600_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Regional - RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 14_000_000, 'ApplicationServices'),
  sku('Cloud SQL for MySQL: Zonal - Micro instance in EMEA', 'OnDemand', EW1, 'h', 10_500_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Zonal - Enterprise Plus N vCPU in EMEA', 'OnDemand', EW1, 'h', 53_700_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Zonal - Enterprise Plus N RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 9_100_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Zonal - Enterprise Plus C4 vCPU in Belgium', 'OnDemand', EW1, 'h', 54_000_000, 'ApplicationServices'),
  sku('Cloud SQL for PostgreSQL: Zonal - Enterprise Plus Extended support vCPU v13 in Belgium', 'OnDemand', EW1, 'h', 70_000_000, 'ApplicationServices'),
  sku('Cloud SQL for SQL Server: Zonal - vCPU in EMEA', 'OnDemand', EW1, 'h', 41_300_000, 'ApplicationServices'),
  sku('Cloud SQL for SQL Server: Zonal - RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 7_000_000, 'ApplicationServices'),
];

type Page = { skus?: CatalogSku[]; nextPageToken?: string };
// The Catalog's pages of each service (a page's token is its index), the price table, and a clock.
function setup(pages: Record<string, CatalogSku[][]> = { [COMPUTE]: [COMPUTE_SKUS, COMPUTE_SKUS_2], [SQL]: [SQL_SKUS] }, { cached = {}, catalog = true }: { cached?: Record<string, number | null>; catalog?: boolean } = {}) {
  const asked: string[] = [];
  const cache = new Map<string, number | null>(Object.entries(cached));
  const days = new Map<string, number>();
  let t = Date.parse('2026-11-10T12:00:00.000Z');
  const state = { failing: (_service: string, _page: number) => false };
  const skus = async (service: string, pageToken?: string): Promise<Page> => {
    const page = pageToken ? Number(pageToken) : 0;
    asked.push(`${service}#${page}`);
    if (state.failing(service, page)) throw new Error('The request timed out');
    const list = pages[service] ?? [[]];
    return { skus: list[page], ...(page + 1 < list.length ? { nextPageToken: String(page + 1) } : {}) };
  };
  const store = {
    getPrice: async (key: string) => (cache.has(key) ? { usd: cache.get(key)! } : null),
    putPrice: async (key: string, usd: number | null, d = 30) => { cache.set(key, usd); days.set(key, d); },
  };
  const pricing = { async getProducts() { return { PriceList: [JSON.stringify({ terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: '0.0456000000' } } } } } } })] }; } };
  const book = createPriceBook({ pricing, store, ...(catalog ? { catalog: { skus } } : {}), now: () => t });
  return { book, asked, cache, days, state, advance: (ms: number) => { t += ms; } };
}

type Gce = Extract<StoppedItem, { kind: 'gce' }>;
type CloudSql = Extract<StoppedItem, { kind: 'cloudsql' }>;
const vm = (machineType: string, family: string, vcpus: number, memoryGb: number, extra: Partial<Gce> = {}): Gce => ({
  kind: 'gce', machineType, family, vcpus, memoryGb, count: 1, os: 'linux', zone: 'europe-west1-b', ...extra,
});
const E2_SMALL = vm('e2-small', 'e2', 0.5, 2);
const db = (tier: string, extra: Partial<CloudSql> = {}): CloudSql => ({ kind: 'cloudsql', tier, engine: 'postgres', edition: 'enterprise', ha: false, region: 'europe-west1', ...extra });

describe('Google\'s list prices', () => {
  it('prices a VM in its zone\'s region: count × (vCPUs × core + memory × RAM), on demand or Spot', async () => {
    const s = setup();
    // The region given is the router's: a global load balancer's backends may run in another one.
    expect(await s.book.hourly('us-central1', E2_SMALL)).toBeCloseTo(0.0184285, 6); // 0.5 × 0.023993 + 2 × 0.003216
    expect(await s.book.hourly('us-central1', { ...E2_SMALL, spot: true })).toBeCloseTo(0.008953, 6);
    expect(await s.book.hourly('us-central1', vm('n2d-standard-2', 'n2d', 2, 8))).toBeCloseTo(0.092946, 6);
    expect(await s.book.hourly('us-central1', vm('n2d-standard-2', 'n2d', 2, 8, { count: 3 }))).toBeCloseTo(3 * 0.092946, 6);
    // A SKU counts in each of its regions.
    for (const zone of ['us-east1-b', 'us-west1-a']) expect(await s.book.hourly('europe-west1', { ...E2_SMALL, zone })).toBeCloseTo(0.5 * 0.02181159 + 2 * 0.00292353, 9);
  });

  it('prices a custom type at its series\' custom SKUs, f1-micro and g1-small at a whole VM\'s hour', async () => {
    const s = setup();
    // 2 × 0.03651165 + 4 × 0.00489405: Custom Instance, not N1 Predefined Instance.
    expect(await s.book.hourly('europe-west1', vm('custom-2-4096', 'n1', 2, 4))).toBeCloseTo(0.0926, 5);
    expect(await s.book.hourly('europe-west1', vm('f1-micro', 'f1', 0.2, 0.6))).toBeCloseTo(0.0086, 6);
    expect(await s.book.hourly('europe-west1', vm('g1-small', 'g1', 0.5, 1.7, { spot: true }))).toBeCloseTo(0.002565, 6);
    expect(await s.book.hourly('europe-west1', vm('g1-small', 'g1', 0.5, 1.7, { spot: true, count: 2 }))).toBeCloseTo(2 * 0.002565, 6);
  });

  it('a suspended VM saves its running price less the memory still paid; a region without that SKU takes the highest listed; never below 0', async () => {
    const s = setup();
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, suspended: true })).toBeCloseTo(0.017962748, 6);
    // Paris lists no suspended RAM: Dammam's, the highest (the smallest saving).
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, zone: 'europe-west9-a', suspended: true })).toBeCloseTo(0.5 * 0.025302 + 2 * 0.003391 - 2 * 0.000372602, 9);
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, zone: 'europe-west9-a', suspended: true, count: 2 })).toBeCloseTo(2 * (0.5 * 0.025302 + 2 * 0.003391 - 2 * 0.000372602), 9);
    const dear = setup({ [COMPUTE]: [[...COMPUTE_SKUS, sku('VM state: suspended RAM in EMEA', 'OnDemand', EW1, 'GiBy.h', 900_000_000)]] });
    expect(await dear.book.hourly('europe-west1', { ...E2_SMALL, suspended: true })).toBe(0);
  });

  it('prices Windows as Linux (its license not counted); takes the compute discount off on demand, never off Spot', async () => {
    const s = setup();
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, os: 'windows' })).toBeCloseTo(0.0184285, 6);
    const discounts = { compute: 20, databases: 50 };
    expect(await s.book.hourly('europe-west1', E2_SMALL, discounts)).toBeCloseTo(0.0147428, 6);
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, spot: true }, discounts)).toBeCloseTo(0.008953, 6);
    // The list prices stay as they are in the table: no discount taken twice.
    expect(s.cache.get('europe-west1#gce#e2#core#ondemand')).toBeCloseTo(0.02399337, 9);
  });

  it('does not price a family outside the table (a GPU series), nor a region without its SKUs: never another family\'s price', async () => {
    const s = setup();
    expect(await s.book.hourly('europe-west1', vm('a2-highgpu-1g', 'a2', 12, 85))).toBeNull();
    expect([...s.cache.keys()].filter((k) => k.includes('#a2#'))).toEqual([]);
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, zone: 'europe-west5-a' })).toBeNull();
    // A custom type of a series without custom SKUs.
    expect(await s.book.hourly('europe-west1', vm('c2d-custom-4-8192', 'c2d', 4, 8))).toBeNull();
  });

  it('an ambiguous match is not priced: two SKUs of one key at two prices; a SKU of several tiers counts as none', async () => {
    const tiered: CatalogSku = { ...sku('N2D AMD Instance Ram running in EMEA', 'OnDemand', EW1, 'GiBy.h', 4_055_000) };
    tiered.pricingInfo![0]!.pricingExpression!.tieredRates!.push({ startUsageAmount: 100, unitPrice: { units: '0', nanos: 3_000_000 } });
    const s = setup({ [COMPUTE]: [[
      ...COMPUTE_SKUS.filter((k) => !k.description!.startsWith('N2D')),
      sku('N2D AMD Instance Core running in EMEA', 'OnDemand', EW1, 'h', 30_253_000), tiered,
      sku('E2 Instance Core running in EMEA', 'OnDemand', EW1, 'h', 24_100_000),
    ]] });
    expect(await s.book.hourly('europe-west1', E2_SMALL)).toBeNull();
    expect(await s.book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8))).toBeNull();
    // The same price twice is one price.
    const twice = setup({ [COMPUTE]: [[...COMPUTE_SKUS, sku('E2 Instance Core running in EMEA', 'OnDemand', EW1, 'h', 23_993_370)]] });
    expect(await twice.book.hourly('europe-west1', E2_SMALL)).toBeCloseTo(0.0184285, 6);
  });

  it('prices RAM listed in GBy.h per GiB (× 1.073741824), as the items\' memory is', async () => {
    const s = setup();
    expect(await s.book.hourly('europe-west1', vm('c4d-standard-2', 'c4d', 2, 7))).toBeCloseTo(2 * 0.0360098 + 7 * 0.003848981 * 1.073741824, 9);
  });

  it('prices Cloud SQL in its region by edition and availability: custom, Enterprise Plus N and shared-core tiers, less the databases discount', async () => {
    const s = setup();
    expect(await s.book.hourly('us-central1', db('db-custom-2-7680', { vcpus: 2, memoryGb: 7.5 }))).toBeCloseTo(0.1351, 6);
    expect(await s.book.hourly('us-central1', db('db-custom-2-7680', { vcpus: 2, memoryGb: 7.5, ha: true }))).toBeCloseTo(0.2702, 6);
    expect(await s.book.hourly('us-central1', db('db-f1-micro', { engine: 'mysql' }))).toBeCloseTo(0.0105, 6);
    expect(await s.book.hourly('us-central1', db('db-perf-optimized-N-4', { edition: 'enterprise-plus', vcpus: 4, memoryGb: 32 }))).toBeCloseTo(0.506, 6);
    expect(await s.book.hourly('us-central1', db('db-custom-2-7680', { vcpus: 2, memoryGb: 7.5 }), { compute: 20, databases: 10 })).toBeCloseTo(0.9 * 0.1351, 6);
    expect(s.asked.every((a) => a.startsWith(`${SQL}#`))).toBe(true);
  });

  it('does not price SQL Server, another tier, an edition the tier does not take, or a dedicated tier without its shape', async () => {
    const s = setup();
    expect(await s.book.hourly('europe-west1', db('db-custom-2-7680', { engine: 'sqlserver', vcpus: 2, memoryGb: 7.5 }))).toBeNull();
    expect(await s.book.hourly('europe-west1', db('db-n1-standard-2', { vcpus: 2, memoryGb: 7.5 }))).toBeNull();
    expect(await s.book.hourly('europe-west1', db('db-custom-2-7680', { edition: 'enterprise-plus', vcpus: 2, memoryGb: 7.5 }))).toBeNull();
    expect(await s.book.hourly('europe-west1', db('db-custom-2-7680'))).toBeNull();
    expect(s.asked).toEqual([]);
  });

  it('caches each key it priced for 30 days and a key the index lacks for a day; reads every page once for many keys', async () => {
    const s = setup();
    const [small, n2d, micro] = await Promise.all([
      s.book.hourly('europe-west1', { ...E2_SMALL, suspended: true }), s.book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8)), s.book.hourly('europe-west1', vm('f1-micro', 'f1', 0.2, 0.6)),
    ]);
    expect([small, n2d, micro].every((usd) => usd !== null)).toBe(true);
    expect(s.asked).toEqual([`${COMPUTE}#0`, `${COMPUTE}#1`]);
    expect(Object.fromEntries(s.days)).toEqual({
      'europe-west1#gce#e2#core#ondemand': 30, 'europe-west1#gce#e2#ram#ondemand': 30, 'europe-west1#gce#suspended#ram#ondemand': 30,
      'europe-west1#gce#n2d#core#ondemand': 30, 'europe-west1#gce#n2d#ram#ondemand': 30, 'europe-west1#gce#f1#instance#ondemand': 30,
    });
    // The index stays: another region's key is answered from it, and one it lacks is cached as none for a day.
    expect(await s.book.hourly('europe-west1', { ...E2_SMALL, zone: 'europe-west5-a' })).toBeNull();
    expect([s.cache.get('europe-west5#gce#e2#core#ondemand'), s.days.get('europe-west5#gce#e2#core#ondemand')]).toEqual([null, 1]);
    expect(s.asked).toHaveLength(2);
    // A cached key is not read from the Catalog again, even by another price book.
    const again = createPriceBook({ pricing: { async getProducts() { return {}; } }, store: { getPrice: async (k: string) => (s.cache.has(k) ? { usd: s.cache.get(k)! } : null), putPrice: async () => {} }, catalog: { async skus() { throw new Error('not asked'); } } });
    expect(await again.hourly('europe-west1', E2_SMALL)).toBeCloseTo(0.0184285, 6);
  });

  it('a page failing prices nothing, puts nothing, and the Catalog is not asked again for five minutes; AWS is priced as before', async () => {
    const s = setup();
    s.state.failing = (_service, page) => page === 1;
    expect(await s.book.hourly('europe-west1', E2_SMALL)).toBeNull();
    expect(s.asked).toEqual([`${COMPUTE}#0`, `${COMPUTE}#1`]);
    expect(await s.book.hourly('europe-west1', E2_SMALL)).toBeNull();
    expect(await s.book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8))).toBeNull();
    expect(s.asked, 'not asked again for five minutes').toHaveLength(2);
    expect(s.cache.size).toBe(0);
    expect(await s.book.hourly('eu-west-1', { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' })).toBeCloseTo(0.0456, 6);
    s.state.failing = () => false;
    s.advance(301_000);
    expect(await s.book.hourly('europe-west1', E2_SMALL)).toBeCloseTo(0.0184285, 6);
    expect(s.asked).toEqual([`${COMPUTE}#0`, `${COMPUTE}#1`, `${COMPUTE}#0`, `${COMPUTE}#1`]);
  });

  it('without the Catalog, reads the table only: a cached key is priced, a miss is not priced and nothing is put', async () => {
    const s = setup(undefined, { catalog: false, cached: { 'europe-west1#gce#e2#core#ondemand': 0.02399337, 'europe-west1#gce#e2#ram#ondemand': 0.00321609, 'europe-west1#gce#n2#core#ondemand': null } });
    expect(await s.book.hourly('europe-west1', E2_SMALL)).toBeCloseTo(0.0184285, 6);
    expect(await s.book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8))).toBeNull();
    expect(await s.book.hourly('europe-west1', vm('n2-standard-2', 'n2', 2, 8))).toBeNull();
    expect(await s.book.hourly('europe-west1', db('db-f1-micro'))).toBeNull();
    expect([s.cache.size, s.days.size, s.asked.length]).toEqual([3, 0, 0]);
    // The daily job priced it since: the table is read again.
    s.cache.set('europe-west1#gce#n2d#core#ondemand', 0.030253);
    s.cache.set('europe-west1#gce#n2d#ram#ondemand', 0.004055);
    expect(await s.book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8))).toBeCloseTo(0.092946, 6);
  });

  it('says each service\'s read once it is complete: its pages and SKUs, once per price book, nothing for a read that failed', async () => {
    const reads: unknown[] = [];
    let t = 1_000;
    let failing = false;
    const pages = [COMPUTE_SKUS, COMPUTE_SKUS_2];
    const catalog = { async skus(_service: string, token?: string) { t += 40; if (failing) throw new Error('timed out'); const page = Number(token ?? 0); return { skus: pages[page]!, ...(page + 1 < pages.length ? { nextPageToken: String(page + 1) } : {}) }; } };
    const store = { getPrice: async () => null, putPrice: async () => {} };
    const book = createPriceBook({ pricing: { async getProducts() { return {}; } }, store, catalog, onCatalogRead: (read) => reads.push(read), now: () => t });
    await book.hourly('europe-west1', E2_SMALL);
    await book.hourly('europe-west1', vm('n2d-standard-2', 'n2d', 2, 8));
    expect(reads).toEqual([{ service: COMPUTE, pages: 2, skus: COMPUTE_SKUS.length + COMPUTE_SKUS_2.length, ms: 80 }]);
    failing = true;
    const other = createPriceBook({ pricing: { async getProducts() { return {}; } }, store, catalog, onCatalogRead: (read) => reads.push(read), now: () => t });
    expect(await other.hourly('europe-west1', E2_SMALL)).toBeNull();
    expect(reads).toHaveLength(1);
  });
});
