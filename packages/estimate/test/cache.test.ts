// The estimate's cache (spec §7): each phase's result per account and region, fresh for a while, written atomically.
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheDir, createCache, freshDiscovery, freshRequests } from '../src/cache.js';

const DAY = 86_400_000;
const T = Date.parse('2026-10-10T12:00:00.000Z');
const fresh = () => mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));

describe('the estimate\'s cache', () => {
  it('reads back what it wrote while it is fresh, through a temporary file renamed', async () => {
    const dir = fresh();
    const cache = createCache({ dir, now: () => T });
    await cache.put('discovery/111122223333-eu-west-1.json', { workloads: 3 });
    expect(await cache.get('discovery/111122223333-eu-west-1.json', () => true)).toEqual({ workloads: 3 });
    expect(readdirSync(join(dir, 'discovery'))).toEqual(['111122223333-eu-west-1.json']);
    expect(await cache.get('discovery/111122223333-eu-west-1.json', () => false)).toBeNull();
    expect(await cache.get('discovery/missing.json', () => true)).toBeNull();
  });

  it('a file that cannot be parsed is missing', async () => {
    const dir = fresh();
    mkdirSync(join(dir, 'requests'));
    writeFileSync(join(dir, 'requests', 'broken.json'), '{"writtenAt": 1, "value": ');
    expect(await createCache({ dir, now: () => T }).get('requests/broken.json', () => true)).toBeNull();
  });

  it('discovery is fresh a day; requests while their 14 days end on the same UTC day', () => {
    expect([freshDiscovery(T)(T - DAY + 1000), freshDiscovery(T)(T - DAY - 1000)]).toEqual([true, false]);
    // Written at 00:10 UTC the same day, or at 23:50 UTC the day before.
    expect([freshRequests(T)(Date.parse('2026-10-10T00:10:00.000Z')), freshRequests(T)(Date.parse('2026-10-09T23:50:00.000Z'))]).toEqual([true, false]);
  });

  it('keeps prices as the product does: 30 days, a missing one a day', async () => {
    const dir = fresh();
    let t = T;
    const cache = createCache({ dir, now: () => t });
    await cache.prices.putPrice('eu-west-1#ec2#t3.medium#Linux', 0.0456);
    await cache.prices.putPrice('eu-west-1#ec2#x9.huge#Linux', null);
    await cache.prices.putPrice('eu-west-1#ec2-spot#t3.medium#Linux', 0.015, 1);
    // A new run reads them from the file.
    const again = createCache({ dir, now: () => t });
    expect(await again.prices.getPrice('eu-west-1#ec2#t3.medium#Linux')).toEqual({ usd: 0.0456 });
    expect(await again.prices.getPrice('eu-west-1#ec2#x9.huge#Linux')).toEqual({ usd: null });
    t += DAY + 1000;
    expect(await again.prices.getPrice('eu-west-1#ec2#x9.huge#Linux')).toBeNull();
    expect(await again.prices.getPrice('eu-west-1#ec2-spot#t3.medium#Linux')).toBeNull();
    expect(await again.prices.getPrice('eu-west-1#ec2#t3.medium#Linux')).toEqual({ usd: 0.0456 });
  });

  it('lives under XDG_CACHE_HOME when it is set, else ~/.cache', () => {
    expect(cacheDir({ XDG_CACHE_HOME: '/var/cache/me' })).toBe('/var/cache/me/dormeto/estimate');
    expect(cacheDir({})).toBe(join(homedir(), '.cache', 'dormeto', 'estimate'));
  });
});
