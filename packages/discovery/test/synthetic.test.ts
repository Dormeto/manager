// The synthetic organization of the acceptance at scale (scale design §7), enabled in dev only.
import { describe, expect, it } from 'vitest';
import { runDiscovery } from '../src/run.js';
import { SYNTHETIC_REGIONS, isSynthetic, syntheticInventory, syntheticRules } from '../src/synthetic.js';
import { A, ROOT, config, filter } from './fixtures.js';
import { setup } from './run-fakes.js';

describe('synthetic organization', () => {
  it('holds 1,000 accounts over 17 regions, 1,000 load balancers, 10,000 target groups and 50,000 rules, the same at each call', () => {
    const inventory = syntheticInventory(1000, ROOT);
    expect([inventory.accounts.length, SYNTHETIC_REGIONS.length, inventory.ous['ou-synthetic']]).toEqual([1000, 17, { name: 'synthetic', parent: ROOT }]);
    const candidates = inventory.accounts.flatMap((a) => SYNTHETIC_REGIONS.flatMap((region) => syntheticRules(a.id, region)));
    expect(new Set(candidates.map((c) => c.loadBalancerArn)).size).toBe(1000);
    expect(new Set(candidates.map((c) => c.targetGroupArn)).size).toBe(10_000);
    expect(candidates.reduce((n, c) => n + c.rules.length, 0)).toBe(50_000);
    const [first] = inventory.accounts;
    expect(SYNTHETIC_REGIONS.map((r) => syntheticRules(first!.id, r))).toEqual(SYNTHETIC_REGIONS.map((r) => syntheticRules(first!.id, r)));
    expect([isSynthetic(first!.id), isSynthetic(A.id)]).toEqual([true, false]);
  });

  it('adds its accounts to the organization; they are scanned without any role or AWS call', async () => {
    const s = setup({ cfg: config({ regions: ['*'], filters: [filter('all', [{}])] }) });
    await s.ready;
    s.deps.synthetic = { accounts: 3 };
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(s.assumed.every((account) => !isSynthetic(account))).toBe(true);
    expect(s.scanned.every((pair) => !isSynthetic(pair.split('/')[0]!))).toBe(true);
    const synthetic = (await s.store.listCandidates()).filter((c) => isSynthetic(c.account));
    expect([synthetic.length, run.status]).toEqual([30, 'ok']);
  });
});
