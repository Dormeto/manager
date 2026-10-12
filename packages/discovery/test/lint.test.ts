import { describe, expect, it } from 'vitest';
import { covers, lint } from '../src/lint.js';
import { A, B, C, INVENTORY, OU1, OU3, PROD, config, filter, rule } from './fixtures.js';

const cov = (e: Parameters<typeof covers>[0], i: Parameters<typeof covers>[1]) => covers(e, i, INVENTORY);

describe('covers', () => {
  it('covers listed accounts only when all of them are excluded', () => {
    expect(cov({ accountIds: [A.id] }, { accountIds: [A.id] })).toBe(true);
    expect(cov({ accountIds: [A.id] }, { accountIds: [A.id, B.id] })).toBe(false);
  });

  it('resolves accounts and OUs through the organization tree', () => {
    expect(cov({ ouIds: [OU1] }, { accountIds: [B.id] })).toBe(true);
    expect(cov({ ouIds: [OU1] }, { accountIds: [C.id] })).toBe(false);
    expect(cov({ ouIds: [OU1] }, { ouIds: [OU3] })).toBe(true);
    expect(cov({ ouIds: [OU3] }, { ouIds: [OU1] })).toBe(false);
    expect(cov({ accountIds: [B.id] }, { ouIds: [OU3] })).toBe(false);
  });

  it('covers regions and backend kinds by subset', () => {
    expect(cov({ regions: ['eu-west-1', 'eu-west-3'] }, { regions: ['eu-west-3'] })).toBe(true);
    expect(cov({ regions: ['eu-west-1'] }, { regions: ['eu-west-1', 'us-east-1'] })).toBe(false);
    expect(cov({ backendKinds: ['ecs'] }, { backendKinds: ['ecs'] })).toBe(true);
  });

  it('does not cover an include that is broader on a dimension the exclude sets', () => {
    expect(cov({ accountIds: [A.id], regions: ['eu-west-1'] }, { accountIds: [A.id] })).toBe(false);
    expect(cov({ accountIds: [A.id] }, {})).toBe(false);
  });

  it('compares patterns: * covers anything, a wildcard covers literal values, wildcards only when identical', () => {
    expect(cov({ loadBalancers: ['*'] }, { loadBalancers: ['web*'] })).toBe(true);
    expect(cov({ loadBalancers: ['web-*'] }, { loadBalancers: ['web-shop'] })).toBe(true);
    expect(cov({ loadBalancers: ['web-*'] }, { loadBalancers: ['web*'] })).toBe(false);
    expect(cov({ hosts: ['*.example.com'] }, { hosts: ['*.example.com'] })).toBe(true);
  });

  it('covers resource tags with an empty value list as any value', () => {
    expect(cov({ resourceTags: { env: [] } }, { resourceTags: { env: ['preview'] } })).toBe(true);
    expect(cov({ resourceTags: { env: ['prod'] } }, { resourceTags: { env: ['preview'] } })).toBe(false);
    expect(cov({ resourceTags: { env: ['prod'] } }, { resourceTags: { env: [] } })).toBe(false);
  });
});

describe('lint', () => {
  it('reports an include that a global exclude directly contradicts', () => {
    const cfg = config({
      globalExcludes: [{ note: 'production', ouIds: [PROD] }, { accountIds: [B.id] }],
      filters: [filter('shops', [{ accountIds: [A.id] }, { accountIds: [C.id] }])],
    });
    expect(lint(cfg, INVENTORY)).toEqual([{
      code: 'include-shadowed-by-global-exclude', level: 'warning', filter: 'shops', include: 2, by: 'global exclude 1',
      message: `filter "shops", include 2 can never match: global exclude 1 "production" covers it (OU ${PROD})`,
    }]);
  });

  it('reports an include that its own filter excludes, and an include of everything', () => {
    const cfg = config({ filters: [filter('dev', [{ accountIds: [A.id], regions: ['eu-west-3'] }, {}], [{ regions: ['eu-west-3'] }])] });
    expect(lint(cfg, INVENTORY).map((f) => [f.code, f.include, f.by])).toEqual([
      ['include-shadowed-by-filter-exclude', 1, 'exclude 1'],
      ['include-everything', 2, undefined],
    ]);
  });

  it('after a run, reports includes that matched nothing', () => {
    const cfg = config({ filters: [filter('hosts', [{ hosts: ['*.example.org'] }, { hosts: ['*.example.com'] }])] });
    const findings = lint(cfg, INVENTORY, { rules: [rule()] });
    expect(findings).toEqual([{
      code: 'include-matches-nothing', level: 'info', filter: 'hosts', include: 1,
      message: 'filter "hosts", include 1 matched no rule in the last run',
    }]);
  });

  it('after a run, reports includes that several global excludes cover together', () => {
    const cfg = config({ globalExcludes: [{ accountIds: [A.id] }, { accountIds: [B.id] }], filters: [filter('two', [{ accountIds: [A.id, B.id] }])] });
    expect(lint(cfg, INVENTORY).map((f) => f.code)).toEqual([]);
    expect(lint(cfg, INVENTORY, { rules: [] }).map((f) => [f.code, f.level])).toEqual([['include-only-globally-excluded', 'warning']]);
  });

  it('after a run, reports includes whose rules were all globally excluded', () => {
    const cfg = config({
      globalExcludes: [{ backendKinds: ['instance'] }, { backendKinds: ['ecs'] }],
      filters: [filter('preview', [{ resourceTags: { env: ['preview'] } }])],
    });
    const rules = [rule(), rule({ id: 'r2', backend: { kind: 'ecs', id: 'svc' } })];
    expect(lint(cfg, INVENTORY, { rules }).map((f) => f.code)).toEqual(['include-only-globally-excluded']);
  });
});
