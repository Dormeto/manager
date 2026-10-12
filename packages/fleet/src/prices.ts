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

// The first on-demand hourly price in USD of the products answered.
function onDemand(list: unknown[] = []): number | null {
  for (const raw of list) {
    const product = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }> } };
    for (const offer of Object.values(product.terms?.OnDemand ?? {})) {
      for (const dimension of Object.values(offer.priceDimensions ?? {})) {
        const usd = Number(dimension.pricePerUnit?.USD);
        if (Number.isFinite(usd) && usd > 0) return usd;
      }
    }
  }
  return null;
}

export function createPriceBook({ pricing, store }: { pricing: PricingPort; store: PriceCache; now?: () => number }) {
  // One price, cached; a failed call prices nothing and caches nothing.
  async function price(key: string, ServiceCode: string, Filters: { Type: string; Field: string; Value: string }[]): Promise<number | null> {
    const cached = await store.getPrice(key);
    if (cached) return cached.usd;
    let usd: number | null;
    try {
      usd = onDemand((await pricing.getProducts({ ServiceCode, Filters, MaxResults: 10 })).PriceList);
    } catch {
      return null;
    }
    await store.putPrice(key, usd);
    return usd;
  }

  return {
    // USD an hour of an item, in its region; null when it cannot be priced.
    async hourly(region: string, item: StoppedItem): Promise<number | null> {
      switch (item.kind) {
        case 'ec2': {
          if (!OS.has(item.os)) return null;
          const usd = await price(`${region}#ec2#${item.type}#${item.os}`, 'AmazonEC2', [
            term('instanceType', item.type), term('regionCode', region), term('operatingSystem', item.os), term('tenancy', 'Shared'),
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
            term('instanceType', item.class), term('regionCode', region), term('databaseEngine', engine), term('deploymentOption', deployment),
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
