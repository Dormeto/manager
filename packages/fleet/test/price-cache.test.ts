// The price cache of both clouds' price books (prices.ts for AWS, google-prices.ts for Google Cloud; review I5): a price from
// memory for an hour, else the table, else asked; a failed ask prices nothing, caches nothing and is not asked again for five
// minutes; a price being asked is shared. Each book's own tests say what it asks and for how long the table keeps it.
import { describe, expect, it } from 'vitest';
import { createPriceCache } from '../src/price-cache.js';

function setup(table: Record<string, number | null> = {}) {
  let t = 0;
  const reads: string[] = [];
  const puts: [string, number | null, number | undefined][] = [];
  const store = {
    getPrice: async (key: string) => { reads.push(key); return key in table ? { usd: table[key]! } : null; },
    putPrice: async (key: string, usd: number | null, days?: number) => { puts.push([key, usd, days]); table[key] = usd; },
  };
  return { price: createPriceCache({ store, now: () => t }), reads, puts, advance: (ms: number) => { t += ms; } };
}
const asking = (answer: () => Promise<number | null>) => {
  const asked: number[] = [];
  return { asked, ask: () => { asked.push(1); return answer(); } };
};

describe('createPriceCache', () => {
  it('reads the table first, and keeps what it holds an hour in memory', async () => {
    const s = setup({ k: 0.5 });
    const a = asking(async () => 9);
    expect([await s.price('k', a.ask, 30), await s.price('k', a.ask, 30)]).toEqual([0.5, 0.5]);
    expect([s.reads, a.asked.length]).toEqual([['k'], 0]);
    s.advance(3_600_000);
    await s.price('k', a.ask, 30);
    expect(s.reads).toEqual(['k', 'k']);
  });

  it('asks on a miss and puts the answer for its days, a null for its own (the same unless given)', async () => {
    const s = setup();
    expect([await s.price('a', async () => 0.2, 30), await s.price('b', async () => null, 30), await s.price('c', async () => null, 30, 1), await s.price('d', async () => 0.1, 1)]).toEqual([0.2, null, null, 0.1]);
    expect(s.puts).toEqual([['a', 0.2, 30], ['b', null, 30], ['c', null, 1], ['d', 0.1, 1]]);
  });

  it('prices nothing for a failed ask, puts nothing, and asks again only after five minutes', async () => {
    const s = setup();
    const a = asking(async () => { throw new Error('throttled'); });
    expect(await s.price('k', a.ask, 30)).toBeNull();
    s.advance(299_999);
    expect(await s.price('k', a.ask, 30)).toBeNull();
    expect([a.asked.length, s.puts]).toEqual([1, []]);
    s.advance(1);
    await s.price('k', a.ask, 30);
    expect(a.asked.length).toBe(2);
  });

  it('shares a price being asked', async () => {
    const s = setup();
    let answer: (usd: number) => void = () => {};
    const a = asking(() => new Promise<number>((resolve) => { answer = resolve; }));
    const both = Promise.all([s.price('k', a.ask, 30), s.price('k', a.ask, 30)]);
    await Promise.resolve();
    await Promise.resolve();
    answer(0.3);
    expect(await both).toEqual([0.3, 0.3]);
    expect([a.asked.length, s.reads.length, s.puts.length]).toEqual([1, 1, 1]);
  });

  it('without an ask, reads the table only: a miss is not priced, put or remembered', async () => {
    const s = setup();
    expect([await s.price('k', null, 30), await s.price('k', null, 30)]).toEqual([null, null]);
    expect([s.reads, s.puts]).toEqual([['k', 'k'], []]);
  });
});
