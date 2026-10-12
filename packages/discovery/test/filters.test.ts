import { describe, expect, it } from 'vitest';
import { decide, matches, scanAccounts, targetPairs } from '../src/filters.js';
import { A, B, C, INVENTORY, OU1, OU5, PROD, ROOT, config, filter, rule } from './fixtures.js';

const m = (c: Parameters<typeof matches>[0], account = A, r = rule()) => matches(c, account, r, INVENTORY);

describe('matches', () => {
  it('matches everything with an empty criterion', () => {
    expect(m({})).toBe(true);
  });

  it('matches account IDs, values being alternatives', () => {
    expect(m({ accountIds: [A.id, C.id] })).toBe(true);
    expect(m({ accountIds: [C.id] })).toBe(false);
  });

  it('matches an OU recursively, five levels deep, and the root for every account', () => {
    expect(m({ ouIds: [OU1] }, B, rule({ account: B.id }))).toBe(true);
    expect(m({ ouIds: [OU5] }, B, rule({ account: B.id }))).toBe(true);
    expect(m({ ouIds: [OU1] }, C, rule({ account: C.id }))).toBe(false);
    expect(m({ ouIds: [ROOT] }, C, rule({ account: C.id }))).toBe(true);
  });

  it('matches account tags with given values, or any value with an empty list', () => {
    expect(m({ accountTags: { env: ['prod', 'staging'] } }, C)).toBe(true);
    expect(m({ accountTags: { env: ['dev'] } }, C)).toBe(false);
    expect(m({ accountTags: { team: [] } }, C)).toBe(true);
    expect(m({ accountTags: { team: [] } }, B)).toBe(false);
  });

  it('requires every dimension it sets', () => {
    expect(m({ accountIds: [A.id], regions: ['eu-west-1'] })).toBe(true);
    expect(m({ accountIds: [A.id], regions: ['eu-west-3'] })).toBe(false);
  });

  it('matches load balancers by name pattern, exact name or full ARN', () => {
    expect(m({ loadBalancers: ['web-*'] })).toBe(true);
    expect(m({ loadBalancers: ['web-shop'] })).toBe(true);
    expect(m({ loadBalancers: ['web'] })).toBe(false);
    expect(m({ loadBalancers: [rule().loadBalancerArn] })).toBe(true);
    expect(m({ loadBalancers: ['arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/other/1'] })).toBe(false);
  });

  it('matches host patterns against the rule host names; a rule without host condition never matches', () => {
    expect(m({ hosts: ['*.example.com'] })).toBe(true);
    expect(m({ hosts: ['SHOP.example.com'] })).toBe(true);
    expect(m({ hosts: ['*.example.org'] })).toBe(false);
    expect(m({ hosts: ['*'] }, A, rule({ hosts: [] }))).toBe(false);
  });

  it('matches resource tags of the load balancer, rule or target group (merged by the scan)', () => {
    expect(m({ resourceTags: { env: ['preview'] } })).toBe(true);
    expect(m({ resourceTags: { env: [] } })).toBe(true);
    expect(m({ resourceTags: { env: ['prod'] } })).toBe(false);
  });

  it('matches backend kinds, never for an ineligible rule', () => {
    expect(m({ backendKinds: ['instance', 'asg'] })).toBe(true);
    expect(m({ backendKinds: ['ecs'] })).toBe(false);
    expect(m({ backendKinds: ['instance'] }, A, rule({ eligibility: 'ineligible', backend: null, reason: 'fixed response' }))).toBe(false);
  });
});

describe('decide', () => {
  it('lets a global exclude win over any filter, with its note in the reason', () => {
    const cfg = config({ globalExcludes: [{ note: 'tools account', accountIds: [A.id] }], filters: [filter('all', [{}])] });
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'excluded', reason: `excluded: global exclude 1 "tools account" (account ${A.id})` });
  });

  it('applies a filter exclude to that filter only', () => {
    const cfg = config({
      filters: [
        filter('dev', [{ accountIds: [A.id] }], [{ backendKinds: ['instance'] }]),
        filter('preview', [{ resourceTags: { env: ['preview'] } }]),
      ],
    });
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'in', reason: 'in scope: filter "preview", include 1' });
  });

  it('reports the filter and exclude number when every including filter excludes the rule', () => {
    const cfg = config({ filters: [filter('dev', [{ ouIds: [OU1] }, { accountIds: [A.id] }], [{ regions: ['eu-west-3'] }, { backendKinds: ['instance'] }])] });
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'excluded', reason: 'excluded: filter "dev", exclude 2' });
  });

  it('is out of scope when no filter includes the rule', () => {
    const cfg = config({ filters: [filter('prod', [{ ouIds: [PROD] }])] });
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'out', reason: 'out of scope: no filter includes it' });
  });

  it('names the include that brought the rule in scope', () => {
    const cfg = config({ filters: [filter('dev', [{ ouIds: [PROD] }, { hosts: ['*.example.com'] }])] });
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'in', reason: 'in scope: filter "dev", include 2' });
  });
});

describe('scanAccounts and targetPairs', () => {
  const regions = { [A.id]: ['eu-west-1', 'us-east-1'], [B.id]: ['eu-west-1'], [C.id]: ['eu-west-1'] };
  const scanned = (plans: { account: string; region?: string; scan: boolean }[]) => plans.filter((p) => p.scan).map((p) => (p.region ? `${p.account}/${p.region}` : p.account));

  it('scans nothing without filters', () => {
    expect(scanned(scanAccounts(config(), INVENTORY))).toEqual([]);
    expect(scanned(targetPairs(config(), INVENTORY, regions))).toEqual([]);
  });

  it('skips an account no filter includes, with the reason', () => {
    const plans = scanAccounts(config({ filters: [filter('a', [{ accountIds: [A.id] }])] }), INVENTORY);
    expect(scanned(plans)).toEqual([A.id]);
    expect(plans.find((p) => p.account === B.id)).toEqual({ account: B.id, scan: false, reason: 'no filter includes this account' });
  });

  it('never scans a globally excluded account, by ID or through its OU, even when a filter names it', () => {
    const byId = config({ globalExcludes: [{ accountIds: [A.id] }], filters: [filter('a', [{ accountIds: [A.id, B.id] }])] });
    expect(scanned(scanAccounts(byId, INVENTORY))).toEqual([B.id]);
    const byOu = config({ globalExcludes: [{ note: 'deep OUs', ouIds: [OU1] }], filters: [filter('b', [{ accountIds: [B.id] }])] });
    const plans = scanAccounts(byOu, INVENTORY);
    expect(scanned(plans)).toEqual([]);
    expect(plans.find((p) => p.account === B.id)!.reason).toBe(`excluded: global exclude 1 "deep OUs" (OU ${OU1})`);
  });

  it('skips a globally excluded region in every account', () => {
    const cfg = config({ globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('all', [{ ouIds: [ROOT] }])] });
    expect(scanned(targetPairs(cfg, INVENTORY, regions))).toEqual([`${A.id}/eu-west-1`, `${B.id}/eu-west-1`, `${C.id}/eu-west-1`]);
  });

  it('keeps the pair when a global exclude sets a resource dimension', () => {
    const cfg = config({ globalExcludes: [{ accountIds: [A.id], backendKinds: ['ecs'] }], filters: [filter('a', [{ accountIds: [A.id] }])] });
    expect(scanned(targetPairs(cfg, INVENTORY, regions))).toEqual([`${A.id}/eu-west-1`, `${A.id}/eu-west-3`]);
  });

  it('skips regions no include allows', () => {
    const cfg = config({ filters: [filter('a', [{ accountIds: [A.id], regions: ['eu-west-3'] }])] });
    const plans = targetPairs(cfg, INVENTORY, regions);
    expect(scanned(plans)).toEqual([`${A.id}/eu-west-3`]);
    expect(plans.find((p) => p.account === A.id && p.region === 'eu-west-1')!.reason).toBe('no filter includes this region');
  });

  it('uses the enabled regions of each account with regions ["*"]', () => {
    const cfg = config({ regions: ['*'], filters: [filter('a', [{ accountIds: [A.id] }])] });
    expect(scanned(targetPairs(cfg, INVENTORY, regions))).toEqual([`${A.id}/eu-west-1`, `${A.id}/us-east-1`]);
  });
});
