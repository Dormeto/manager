// AWS's on-demand list prices of what a nap stops (vision docs/specs/2026-10-08-savings-design.md, R9b), from the Price
// List API (free, us-east-1), cached per region and item. What it cannot price is null: another OS, Oracle or SQL Server,
// an unknown item, a product the API does not return, or an API that failed (not cached: the next run asks again).

export type StoppedItem =
  | { kind: 'ec2'; type: string; count: number; os: string }
  | { kind: 'fargate'; vcpu: number; memoryGb: number; count: number; arch: string; os: string }
  | { kind: 'rds'; class: string; engine: string; multiAz: boolean }
  | { kind: 'aurora-serverless'; engine: string; acu: number }
  | { kind: 'unknown'; backend: string; reason: string };

// The Price List API, as the manager's handlers give it (GetProducts).
export interface PricingPort {
  getProducts(input: { ServiceCode: string; Filters: { Type: string; Field: string; Value: string }[]; MaxResults?: number }): Promise<{ PriceList?: unknown[] }>;
}
// The cache (the fleet store): a price per key, null when the API has none.
export interface PriceCache {
  getPrice(key: string): Promise<{ usd: number | null } | null>;
  putPrice(key: string, usd: number | null): Promise<void>;
}

const ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', 'aurora-postgresql': 'Aurora PostgreSQL', 'aurora-mysql': 'Aurora MySQL', aurora: 'Aurora MySQL',
};
const OS = new Set(['Linux', 'Windows']);
const term = (Field: string, Value: string) => ({ Type: 'TERM_MATCH', Field, Value });
const contains = (Field: string, Value: string) => ({ Type: 'CONTAINS', Field, Value });

// The on-demand hourly price in USD of the products answered: the SDK gives each product as a String object (or a
// string). Several products of different prices are no price (review I2: an ambiguous answer is not guessed).
function onDemand(list: unknown[] = []): number | null {
  const prices = new Set<number>();
  for (const raw of list) {
    const product = (raw !== null && typeof raw === 'object' && 'terms' in raw ? raw : JSON.parse(String(raw))) as { terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }> } };
    const found = Object.values(product.terms?.OnDemand ?? {}).flatMap((offer) => Object.values(offer.priceDimensions ?? {}))
      .map((d) => Number(d.pricePerUnit?.USD)).find((usd) => Number.isFinite(usd) && usd > 0);
    if (found !== undefined) prices.add(found);
  }
  return prices.size === 1 ? [...prices][0]! : null;
}

// In memory (review I5): a price an hour, a failure five minutes; a price being asked is shared.
const MEMORY_MS = 3_600_000;
const FAILURE_MS = 300_000;

export function createPriceBook({ pricing, store, now = Date.now }: { pricing: PricingPort; store: PriceCache; now?: () => number }) {
  const memory = new Map<string, { usd: number | null; until: number }>();
  const pending = new Map<string, Promise<number | null>>();
  // One price: from memory, the table, else the API; a failed call prices nothing, caches nothing in the table, and is not
  // asked again for five minutes.
  async function lookup(key: string, ServiceCode: string, Filters: { Type: string; Field: string; Value: string }[]): Promise<number | null> {
    const cached = await store.getPrice(key);
    if (cached) {
      memory.set(key, { usd: cached.usd, until: now() + MEMORY_MS });
      return cached.usd;
    }
    let usd: number | null;
    try {
      usd = onDemand((await pricing.getProducts({ ServiceCode, Filters, MaxResults: 10 })).PriceList);
    } catch {
      memory.set(key, { usd: null, until: now() + FAILURE_MS });
      return null;
    }
    await store.putPrice(key, usd);
    memory.set(key, { usd, until: now() + MEMORY_MS });
    return usd;
  }
  function price(key: string, ServiceCode: string, Filters: { Type: string; Field: string; Value: string }[]): Promise<number | null> {
    const known = memory.get(key);
    if (known && known.until > now()) return Promise.resolve(known.usd);
    const asked = pending.get(key) ?? lookup(key, ServiceCode, Filters).finally(() => pending.delete(key));
    pending.set(key, asked);
    return asked;
  }

  return {
    // USD an hour of an item, in its region; null when it cannot be priced.
    async hourly(region: string, item: StoppedItem): Promise<number | null> {
      switch (item.kind) {
        case 'ec2': {
          if (!OS.has(item.os)) return null;
          const usd = await price(`${region}#ec2#${item.type}#${item.os}`, 'AmazonEC2', [
            term('instanceType', item.type), term('regionCode', region), term('locationType', 'AWS Region'), term('operatingSystem', item.os), term('tenancy', 'Shared'),
            term('preInstalledSw', 'NA'), term('capacitystatus', 'Used'), term('licenseModel', 'No License required'),
          ]);
          return usd === null ? null : usd * item.count;
        }
        case 'fargate': {
          if (!OS.has(item.os)) return null;
          const prefix = item.os === 'Windows' ? 'Fargate-Windows-' : item.arch === 'arm64' ? 'Fargate-ARM-' : 'Fargate-';
          const vcpu = await price(`${region}#fargate#${prefix}vcpu`, 'AmazonECS', [term('regionCode', region), contains('usagetype', `${prefix}vCPU-Hours:perCPU`)]);
          const gb = await price(`${region}#fargate#${prefix}gb`, 'AmazonECS', [term('regionCode', region), contains('usagetype', `${prefix}GB-Hours`)]);
          return vcpu === null || gb === null ? null : (vcpu * item.vcpu + gb * item.memoryGb) * item.count;
        }
        case 'rds': {
          const engine = ENGINES[item.engine];
          if (!engine) return null;
          const deployment = item.multiAz ? 'Multi-AZ' : 'Single-AZ';
          return price(`${region}#rds#${item.class}#${engine}#${deployment}`, 'AmazonRDS', [
            term('instanceType', item.class), term('regionCode', region), term('locationType', 'AWS Region'), term('databaseEngine', engine), term('deploymentOption', deployment),
            // Standard storage, not I/O-Optimized (InstanceUsageIOOptimized:), whose instances cost about 30% more.
            contains('usagetype', item.multiAz ? 'Multi-AZUsage:' : 'InstanceUsage:'),
          ]);
        }
        case 'aurora-serverless': {
          const engine = ENGINES[item.engine];
          if (!engine) return null;
          const usd = await price(`${region}#aurora-serverless#${engine}`, 'AmazonRDS', [term('regionCode', region), term('databaseEngine', engine), contains('usagetype', 'Aurora:ServerlessV2Usage')]);
          return usd === null ? null : usd * item.acu;
        }
        default:
          return null;
      }
    },
  };
}
export type PriceBook = ReturnType<typeof createPriceBook>;
