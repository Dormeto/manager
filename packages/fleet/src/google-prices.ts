// Google's list prices of what a nap stops (vision docs/specs/2026-11-09-google-cloud-manager-design.md §9.2), from the
// Cloud Billing Catalog API as the discovery account reads it (USD list prices). The Catalog has no filter: a service's
// SKUs come page by page (Compute Engine: about 33,600 SKUs in 7 pages of 6.7 MB), so each service's index (a price key
// and the prices its SKUs give it, not the SKUs) is built once per price book from every page, and kept while the
// execution environment lives; each key priced is then cached in the table as AWS's (30 days, none a day). What the rules
// below don't name, an ambiguous match, or a Catalog that failed is null (not priced, never $0, never another family's
// price); a failure caches nothing and is not asked again for five minutes. Without the Catalog (the API: a request would
// wait for 45 MB), the table only: a miss is not priced and nothing is written (the daily savings job prices it).
// This module imports types only.
import type { CatalogSku, Discounts, GoogleCatalogPort, PriceCache, StoppedItem } from './prices.js';

export const COMPUTE_SERVICE = '6F81-5844-456A';
export const CLOUD_SQL_SERVICE = '9662-B51E-5089';

// Compute Engine's SKU names by series (measured 2026-11-10): `<name> Core running in ` and `<name> Ram running in `,
// after `Spot Preemptible ` for Spot. Another series (the GPU series among them) is not priced.
const PREDEFINED = new Map(Object.entries({
  e2: 'E2 Instance', n1: 'N1 Predefined Instance', n2: 'N2 Instance', n2d: 'N2D AMD Instance', n4: 'N4 Instance', n4a: 'N4A Instance',
  n4d: 'N4D Instance', t2d: 'T2D AMD Instance', c2: 'Compute optimized', c2d: 'C2D AMD Instance', c3: 'C3 Instance', c3d: 'C3D Instance',
  c4: 'C4 Instance', c4a: 'C4A Arm Instance', c4d: 'C4D Instance', h3: 'H3 Instance', m1: 'Memory-optimized Instance',
  m2: 'Memory-optimized Instance', m3: 'M3 Memory-optimized Instance', z3: 'Z3 Instance',
}));
// A custom machine type (it holds `custom-`): its series' custom SKUs.
const CUSTOM = new Map(Object.entries({
  e2: 'E2 Custom Instance', n1: 'Custom Instance', n2: 'N2 Custom Instance', n2d: 'N2D AMD Custom Instance', n4: 'N4 Custom Instance',
  n4a: 'N4A Custom Instance', n4d: 'N4D Custom Instance',
}));
// The key families each name prices (m1 and m2 share one).
const FAMILIES = new Map<string, string[]>();
for (const [family, name] of PREDEFINED) FAMILIES.set(name, [...(FAMILIES.get(name) ?? []), family]);
for (const [family, name] of CUSTOM) FAMILIES.set(name, [...(FAMILIES.get(name) ?? []), `${family}-custom`]);

const SPOT = 'Spot Preemptible ';
const SERIES = /^(.+?) (Core|Ram) running in /;
// f1-micro and g1-small: a whole VM's hour.
const SHARED_CORE = /^(Micro Instance with burstable CPU|Small Instance with 1 VCPU) running in /;
const SUSPENDED = 'VM state: suspended RAM in ';
const SUSPENDED_KEY = 'gce#suspended#ram#ondemand';
const SQL = /^Cloud SQL for (MySQL|PostgreSQL): (Zonal|Regional) - (vCPU|RAM|Enterprise Plus N vCPU|Enterprise Plus N RAM|Micro instance|Small instance) in /;
const SQL_PRICES: Record<string, [edition: string, resource: string]> = {
  vCPU: ['enterprise', 'vcpu'], RAM: ['enterprise', 'ram'], 'Enterprise Plus N vCPU': ['enterprise-plus', 'vcpu'], 'Enterprise Plus N RAM': ['enterprise-plus', 'ram'],
  'Micro instance': ['enterprise', 'micro'], 'Small instance': ['enterprise', 'small'],
};
const SQL_SHARED_TIERS = new Map([['db-f1-micro', 'micro'], ['db-g1-small', 'small']]);
// A GB is 10^9 bytes, a GiB 2^30: a price per GB-hour is 1.073741824 times that per GiB-hour.
const GIB_PER_GB = 1.073741824;

// The keys a SKU prices, without their region, and whether it prices memory (per GiB-hour) or an hour; null when the
// rules don't name it.
type Named = { keys: string[]; memory: boolean } | null;
function computeKeys(sku: CatalogSku): Named {
  const description = sku.description ?? '';
  const usage = sku.category?.usageType;
  if (sku.category?.resourceFamily !== 'Compute') return null;
  if (usage === 'OnDemand' && description.startsWith(SUSPENDED)) return { keys: [SUSPENDED_KEY], memory: true };
  const model = usage === 'OnDemand' ? 'ondemand' : usage === 'Preemptible' ? 'spot' : null;
  if (!model || description.startsWith(SPOT) !== (model === 'spot')) return null;
  const name = model === 'spot' ? description.slice(SPOT.length) : description;
  const shared = SHARED_CORE.exec(name);
  if (shared) return { keys: [`gce#${shared[1]!.startsWith('Micro') ? 'f1' : 'g1'}#instance#${model}`], memory: false };
  const series = SERIES.exec(name);
  const families = series ? FAMILIES.get(series[1]!) : undefined;
  if (!series || !families) return null;
  const resource = series[2] === 'Core' ? 'core' : 'ram';
  return { keys: families.map((family) => `gce#${family}#${resource}#${model}`), memory: resource === 'ram' };
}
function cloudSqlKeys(sku: CatalogSku): Named {
  const m = sku.category?.usageType === 'OnDemand' ? SQL.exec(sku.description ?? '') : null;
  if (!m) return null;
  const [edition, resource] = SQL_PRICES[m[3]!]!;
  return { keys: [`cloudsql#${m[1] === 'MySQL' ? 'mysql' : 'postgres'}#${edition}#${m[2]!.toLowerCase()}#${resource}`], memory: resource === 'ram' };
}
const SERVICES: Record<string, (sku: CatalogSku) => Named> = { [COMPUTE_SERVICE]: computeKeys, [CLOUD_SQL_SERVICE]: cloudSqlKeys };

// A SKU's price in USD an hour (or a GiB-hour): its single tier's; several tiers, an unexpected unit, or no positive
// price is none.
function skuPrice(sku: CatalogSku, memory: boolean): number | null {
  const expression = sku.pricingInfo?.[0]?.pricingExpression;
  const tiers = expression?.tieredRates ?? [];
  const unit = expression?.usageUnit;
  const factor = memory ? (unit === 'GiBy.h' ? 1 : unit === 'GBy.h' ? GIB_PER_GB : null) : unit === 'h' ? 1 : null;
  if (tiers.length !== 1 || factor === null) return null;
  const usd = Number(tiers[0]!.unitPrice?.units ?? 0) + Number(tiers[0]!.unitPrice?.nanos ?? 0) / 1e9;
  return Number.isFinite(usd) && usd > 0 ? usd * factor : null;
}

// A service's index: each key (with its region: a SKU counts in each of its regions) and the prices seen for it; the
// highest suspended memory price listed.
interface Index { prices: Map<string, Set<number>>; suspendedMax: number | null }
const MAX_PAGES = 100;
async function loadIndex(catalog: GoogleCatalogPort, service: string): Promise<Index> {
  const keysOf = SERVICES[service]!;
  const index: Index = { prices: new Map(), suspendedMax: null };
  let pageToken: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) throw new Error(`The Cloud Billing Catalog answered more than ${MAX_PAGES} pages for services/${service}`);
    const answer = await catalog.skus(service, pageToken);
    for (const sku of answer.skus ?? []) {
      const named = keysOf(sku);
      const usd = named ? skuPrice(sku, named.memory) : null;
      if (!named || usd === null) continue;
      if (named.keys[0] === SUSPENDED_KEY) index.suspendedMax = Math.max(index.suspendedMax ?? 0, usd);
      for (const region of sku.serviceRegions ?? []) {
        for (const key of named.keys) {
          const prices = index.prices.get(`${region}#${key}`) ?? new Set<number>();
          index.prices.set(`${region}#${key}`, prices.add(usd));
        }
      }
    }
    pageToken = answer.nextPageToken || undefined;
    if (!pageToken) return index;
  }
}
// A key's price: its single price; several prices are none (an ambiguous match is not guessed). A region without the
// suspended memory SKU (16 of 48 on 2026-11-10) takes the highest one listed: the smallest saving.
function indexPrice(index: Index, key: string): number | null {
  const prices = index.prices.get(key);
  if (prices) return prices.size === 1 ? [...prices][0]! : null;
  return key.endsWith(`#${SUSPENDED_KEY}`) ? index.suspendedMax : null;
}

// In memory, as AWS's prices (prices.ts, review I5): a price an hour, a failure five minutes; a price being read is shared.
const MEMORY_MS = 3_600_000;
const FAILURE_MS = 300_000;
const PRICE_DAYS = 30;
const NONE_DAYS = 1;

type Gce = Extract<StoppedItem, { kind: 'gce' }>;
type CloudSql = Extract<StoppedItem, { kind: 'cloudsql' }>;
const off = (usd: number, percent: number) => usd * (1 - percent / 100);

export function createGooglePrices({ catalog, store, now }: { catalog?: GoogleCatalogPort; store: PriceCache; now: () => number }) {
  const memory = new Map<string, { usd: number | null; until: number }>();
  const pending = new Map<string, Promise<number | null>>();
  const indexes = new Map<string, Promise<Index>>();
  const failedUntil = new Map<string, number>();

  // A service's index, read at most once per price book (shared while it is read); a page failing fails it, dropped so
  // that a read five minutes later loads it again.
  function indexOf(catalog: GoogleCatalogPort, service: string): Promise<Index> {
    const known = indexes.get(service);
    if (known) return known;
    if ((failedUntil.get(service) ?? 0) > now()) return Promise.reject(new Error(`The Cloud Billing Catalog failed for services/${service} minutes ago`));
    const loading = loadIndex(catalog, service).catch((error: unknown) => {
      indexes.delete(service);
      failedUntil.set(service, now() + FAILURE_MS);
      throw error;
    });
    indexes.set(service, loading);
    return loading;
  }
  // One price: from memory, the table, else the service's index; a failed read prices nothing, caches nothing in the
  // table, and is not asked again for five minutes. Without the Catalog, a miss is not priced, and not remembered: the
  // table is read again for the daily job's price.
  async function lookup(key: string): Promise<number | null> {
    const cached = await store.getPrice(key);
    if (cached) {
      memory.set(key, { usd: cached.usd, until: now() + MEMORY_MS });
      return cached.usd;
    }
    if (!catalog) return null;
    let usd: number | null;
    try {
      usd = indexPrice(await indexOf(catalog, key.includes('#gce#') ? COMPUTE_SERVICE : CLOUD_SQL_SERVICE), key);
    } catch {
      memory.set(key, { usd: null, until: now() + FAILURE_MS });
      return null;
    }
    await store.putPrice(key, usd, usd === null ? NONE_DAYS : PRICE_DAYS);
    memory.set(key, { usd, until: now() + MEMORY_MS });
    return usd;
  }
  function price(key: string): Promise<number | null> {
    const known = memory.get(key);
    if (known && known.until > now()) return Promise.resolve(known.usd);
    const asked = pending.get(key) ?? lookup(key).finally(() => pending.delete(key));
    pending.set(key, asked);
    return asked;
  }

  // A VM group's net hour in its zone's region: count × (vCPUs × core + memory × RAM) (a whole VM's hour for f1-micro and
  // g1-small), less the compute discount unless Spot; suspended, less the memory still paid, never below 0. Windows is
  // priced as Linux, its license not counted (the smallest saving).
  async function gce(item: Gce, discounts: Discounts): Promise<number | null> {
    const region = item.zone.slice(0, item.zone.lastIndexOf('-'));
    const model = item.spot ? 'spot' : 'ondemand';
    let usd: number | null;
    if (item.family === 'f1' || item.family === 'g1') {
      const vm = await price(`${region}#gce#${item.family}#instance#${model}`);
      usd = vm === null ? null : item.count * vm;
    } else {
      const custom = item.machineType.includes('custom-');
      if (!(custom ? CUSTOM : PREDEFINED).has(item.family)) return null;
      const family = custom ? `${item.family}-custom` : item.family;
      const core = await price(`${region}#gce#${family}#core#${model}`);
      const ram = core === null ? null : await price(`${region}#gce#${family}#ram#${model}`);
      usd = core === null || ram === null ? null : item.count * (item.vcpus * core + item.memoryGb * ram);
    }
    if (usd === null) return null;
    if (!item.spot) usd = off(usd, discounts.compute);
    if (!item.suspended) return usd;
    const kept = await price(`${region}#${SUSPENDED_KEY}`);
    return kept === null ? null : Math.max(0, usd - item.count * item.memoryGb * kept);
  }

  // A Cloud SQL instance's net hour in its region: vCPUs × vCPU + memory × RAM (a custom tier on Enterprise, an N tier on
  // Enterprise Plus), or the shared core's hour, less the databases discount. SQL Server, another tier or edition, or a
  // dedicated tier without its shape is not priced.
  async function cloudsql(item: CloudSql, discounts: Discounts): Promise<number | null> {
    if (item.engine !== 'postgres' && item.engine !== 'mysql') return null;
    const base = `${item.region}#cloudsql#${item.engine}#${item.edition}#${item.ha ? 'regional' : 'zonal'}`;
    const shared = SQL_SHARED_TIERS.get(item.tier);
    let usd: number | null;
    if (shared) {
      if (item.edition !== 'enterprise') return null;
      usd = await price(`${base}#${shared}`);
    } else {
      const dedicated = (item.edition === 'enterprise' && item.tier.startsWith('db-custom-')) || (item.edition === 'enterprise-plus' && item.tier.startsWith('db-perf-optimized-N-'));
      if (!dedicated || item.vcpus === undefined || item.memoryGb === undefined) return null;
      const vcpu = await price(`${base}#vcpu`);
      const ram = vcpu === null ? null : await price(`${base}#ram`);
      usd = vcpu === null || ram === null ? null : item.vcpus * vcpu + item.memoryGb * ram;
    }
    return usd === null ? null : off(usd, discounts.databases);
  }

  return {
    hourly: (item: Gce | CloudSql, discounts: Discounts) => (item.kind === 'gce' ? gce(item, discounts) : cloudsql(item, discounts)),
  };
}
