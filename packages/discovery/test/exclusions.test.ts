import { describe, expect, it } from 'vitest';
import { activeExclusions, exclusionCriterion, withExclusions } from '../src/exclusions.js';
import { decide, scanAccounts } from '../src/filters.js';
import { nextCandidates, rescope } from '../src/lifecycle.js';
import { lint } from '../src/lint.js';
import { runDiscovery, type RunDeps } from '../src/run.js';
import { createStore } from '../src/store.js';
import type { Candidate, Exclusion, ScannedRule } from '../src/types.js';
import { fakeDynamo } from './dynamo-fake.js';
import { A, B, C, INVENTORY, config, filter, rule } from './fixtures.js';

const T0 = Date.UTC(2026, 9, 5, 12, 0);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const TG = rule().targetGroupArn!;
const LB = rule().loadBalancerArn;

const exclusion = (target: Exclusion['target'], over: Partial<Exclusion> = {}): Exclusion => ({
  id: 'x1', target, reason: 'migration', by: 'ops@example.com', at: iso(T0), ...over,
});
const tgExclusion = exclusion({ kind: 'target-group', arn: TG, account: A.id, region: 'eu-west-1', name: 'shop' });
const lbExclusion = exclusion({ kind: 'load-balancer', arn: LB, account: A.id, region: 'eu-west-1', name: 'web-shop' }, { id: 'x2' });
const accountExclusion = exclusion({ kind: 'account', account: C.id, name: 'shop-prod' }, { id: 'x3', reason: 'payments, never' });
const IN_AC = config({ filters: [filter('ac', [{ accountIds: [A.id, C.id] }])] });
const REASON = 'excluded: manual exclusion by ops@example.com: migration';

describe('exclusion criteria', () => {
  it('turns a target group, a load balancer or an account into a global exclude with its reason', () => {
    expect(exclusionCriterion(tgExclusion)).toEqual({ targetGroups: [TG], label: 'manual exclusion by ops@example.com: migration' });
    expect(exclusionCriterion(lbExclusion)).toEqual({ loadBalancers: [LB], label: 'manual exclusion by ops@example.com: migration' });
    expect(exclusionCriterion(accountExclusion)).toEqual({ accountIds: [C.id], label: 'manual exclusion by ops@example.com: payments, never' });
  });

  it('leaves expired exclusions out', () => {
    const expired = { ...tgExclusion, expiresAt: iso(T0 - 1) };
    const later = { ...lbExclusion, expiresAt: iso(T0 + DAY) };
    expect(activeExclusions([expired, later, accountExclusion], T0).map((e) => e.id)).toEqual(['x2', 'x3']);
    expect(withExclusions(IN_AC, [expired], T0).globalExcludes).toEqual([]);
  });

  it('excludes the candidate of the target group, or every candidate of the load balancer, after the configured global excludes', () => {
    const cfg = withExclusions({ ...IN_AC, globalExcludes: [{ regions: ['eu-central-1'] }] }, [tgExclusion], T0);
    expect(cfg.globalExcludes).toHaveLength(2);
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'excluded', reason: REASON });
    expect(decide(cfg, A, rule({ id: 'other', targetGroupArn: TG.replace('shop/1', 'blog/2'), targetGroup: 'blog' }), INVENTORY).scope).toBe('in');
    const byLb = withExclusions(IN_AC, [lbExclusion], T0);
    expect(decide(byLb, A, rule({ id: 'other', targetGroupArn: TG.replace('shop/1', 'blog/2') }), INVENTORY).scope).toBe('excluded');
  });

  it('never reads an excluded account', () => {
    const cfg = withExclusions(IN_AC, [accountExclusion], T0);
    expect(scanAccounts(cfg, INVENTORY).find((p) => p.account === C.id)).toEqual({ account: C.id, scan: false, reason: 'excluded: manual exclusion by ops@example.com: payments, never' });
  });

  it('reports the includes an exclusion makes useless', () => {
    const cfg = withExclusions(config({ filters: [filter('c', [{ accountIds: [C.id] }])] }), [accountExclusion], T0);
    expect(lint(cfg, INVENTORY)).toEqual([expect.objectContaining({
      code: 'include-shadowed-by-global-exclude', by: 'manual exclusion by ops@example.com: payments, never',
      message: 'filter "c", include 1 can never match: manual exclusion by ops@example.com: payments, never covers it (account 333333333333)',
    })]);
  });
});

describe('rescope', () => {
  const candidates = (cfg = IN_AC): Candidate[] => nextCandidates({
    previous: new Map(),
    results: [{ account: A.id, region: 'eu-west-1', ok: true, ms: 1, rules: [rule(), rule({ id: 'managed', targetGroupArn: TG, eligibility: 'managed', workloadId: 'shop', backend: null })] }],
    inventory: INVENTORY, config: cfg, now: T0,
  });

  it('re-scopes stored candidates when an exclusion is created and lifted, returning the changed ones only', () => {
    const before = candidates();
    expect(before.map((c) => c.status)).toEqual(['pending-onboarding', 'managed']);
    const excluded = rescope(before, withExclusions(IN_AC, [tgExclusion], T0), INVENTORY, T0 + 1000);
    expect(excluded.map((c) => [c.status, c.statusReason])).toEqual([['excluded', REASON], ['pending-offboarding', REASON]]);
    expect(rescope(excluded, withExclusions(IN_AC, [tgExclusion], T0), INVENTORY, T0 + 2000)).toEqual([]);
    const lifted = rescope(excluded, IN_AC, INVENTORY, T0 + 3000);
    expect(lifted.map((c) => c.status)).toEqual(['pending-onboarding', 'managed']);
    expect(lifted[0]!.history.map((h) => h.status)).toEqual(['pending-onboarding', 'excluded', 'pending-onboarding']);
  });
});

describe('exclusions in the store and in runs', () => {
  it('stores exclusions, kept 30 days after they expire', async () => {
    const dynamo = fakeDynamo();
    const store = createStore({ dynamo, table: 't', now: () => T0 });
    await store.putExclusion(tgExclusion);
    await store.putExclusion({ ...accountExclusion, expiresAt: iso(T0 + DAY) });
    expect((await store.listExclusions()).map((e) => e.id)).toEqual(['x1', 'x3']);
    expect(await store.getExclusion('x3')).toEqual({ ...accountExclusion, expiresAt: iso(T0 + DAY) });
    expect(dynamo.items.get('EXCL#x3')!.expiresAt).toEqual({ N: String((T0 + DAY) / 1000 + 30 * 86_400) });
    expect(dynamo.items.get('EXCL#x1')!.expiresAt).toBeUndefined();
    await store.deleteExclusion('x1');
    expect(await store.getExclusion('x1')).toBeNull();
  });

  it('a run never assumes a role in an excluded account and excludes the candidates of an excluded target group', async () => {
    const dynamo = fakeDynamo();
    const store = createStore({ dynamo, table: 't', now: () => T0 });
    await store.putConfig(config({ regions: ['eu-west-1'], filters: [filter('all', [{ accountIds: [A.id, B.id, C.id] }])] }), 'admin@example.com');
    await store.putExclusion(tgExclusion);
    await store.putExclusion(accountExclusion);
    await store.putExclusion({ ...lbExclusion, account: B.id, expiresAt: iso(T0 - 1), target: { ...lbExclusion.target, account: B.id } } as Exclusion);
    const assumed: string[] = [];
    const deps: RunDeps = {
      store, managerAccount: A.id, now: () => T0, log: { info() {}, warn() {}, error() {} },
      organizations: {
        async listRoots() { return { Roots: [{ Id: 'r-1u0b', Name: 'Root' }] }; },
        async listOrganizationalUnitsForParent() { return { OrganizationalUnits: [] }; },
        async listAccountsForParent() { return { Accounts: [A, B, C].map((a) => ({ Id: a.id, Name: a.name, State: 'ACTIVE' })) }; },
        async listTagsForResource() { return { Tags: [] }; },
      },
      async assumeRole(account) { assumed.push(account); return { account }; },
      async enabledRegions() { return ['eu-west-1']; },
      async scan(_c, where): Promise<ScannedRule[]> { return [rule({ id: `${TG}-${where.account}`, account: where.account, targetGroupArn: where.account === A.id ? TG : `${TG}-${where.account}` })]; },
    };
    const result = await runDiscovery(deps, { source: 'manual' });
    expect(assumed.sort()).toEqual([A.id, B.id]);
    expect(result.skipped).toEqual([{ reason: 'excluded: manual exclusion by ops@example.com: payments, never', accounts: 1, pairs: 1 }]);
    const byAccount = Object.fromEntries((await store.listCandidates()).map((c) => [c.account, c.status]));
    expect(byAccount).toEqual({ [A.id]: 'excluded', [B.id]: 'pending-onboarding' });
  });
});
