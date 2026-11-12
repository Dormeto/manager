// The price cache of both clouds' price books (AWS's prices.ts, Google Cloud's google-prices.ts; review I5): one price from
// memory (an hour), else the table (the fleet store), else asked (the Price List API, Spot history, the Billing Catalog's
// index). A failed ask prices nothing, caches nothing in the table, and is not asked again for five minutes; a price being
// asked is shared. Without an ask, the table only: a miss is not priced, nor written, nor remembered (the table is read
// again for the price the daily savings job writes). This module imports types only.
import type { PriceCache } from './prices.js';

const MEMORY_MS = 3_600_000;
// A failure is remembered this long (the Catalog's index of a service too, google-prices.ts).
export const FAILURE_MS = 300_000;

export type Ask = () => Promise<number | null>;

// `days`: how long the table keeps a price, `noneDays` its absence (the store keeps a null a day whatever it is given).
export function createPriceCache({ store, now }: { store: PriceCache; now: () => number }) {
  const memory = new Map<string, { usd: number | null; until: number }>();
  const pending = new Map<string, Promise<number | null>>();
  async function lookup(key: string, ask: Ask | null, days: number, noneDays: number): Promise<number | null> {
    const cached = await store.getPrice(key);
    if (cached) {
      memory.set(key, { usd: cached.usd, until: now() + MEMORY_MS });
      return cached.usd;
    }
    if (!ask) return null;
    let usd: number | null;
    try {
      usd = await ask();
    } catch {
      memory.set(key, { usd: null, until: now() + FAILURE_MS });
      return null;
    }
    await store.putPrice(key, usd, usd === null ? noneDays : days);
    memory.set(key, { usd, until: now() + MEMORY_MS });
    return usd;
  }
  return function price(key: string, ask: Ask | null, days: number, noneDays = days): Promise<number | null> {
    const known = memory.get(key);
    if (known && known.until > now()) return Promise.resolve(known.usd);
    const asked = pending.get(key) ?? lookup(key, ask, days, noneDays).finally(() => pending.delete(key));
    pending.set(key, asked);
    return asked;
  };
}
