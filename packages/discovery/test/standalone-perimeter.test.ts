// The perimeter's standalone scan (vision standalone workloads design §6): its validation, the criteria and exclusions on
// the resource, and the lifecycle of a standalone candidate (gone, managed, out of scope while the scan is off, kept while
// its kind can't be read).
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import { exclusionCriterion, withExclusions } from '../src/exclusions.js';
import { decide, globalAccountExclude, globalPairExclude, matches } from '../src/filters.js';
import { nextCandidates } from '../src/lifecycle.js';
import type { AnyCandidate, Criterion, Exclusion, StandaloneRule } from '../src/types.js';
import { A, INVENTORY, config, filter, rule } from './fixtures.js';

const ARN = `arn:aws:rds:eu-west-1:${A.id}:db:shop-db`;
const standalone = (over: Partial<StandaloneRule> = {}): StandaloneRule => ({
  kind: 'standalone', id: ARN, account: A.id, region: 'eu-west-1', resourceArn: ARN, name: 'shop-db',
  backend: { kind: 'rds-instance', id: 'shop-db', arn: ARN }, tags: { env: ['dev'] }, eligibility: 'eligible', idleHours7d: null, ...over,
});
const ON = { standalone: 'on' as const };
const T = Date.UTC(2026, 10, 21, 12);

describe('the perimeter\'s standalone', () => {
  it('is off or on, absent by default, and kept as given', () => {
    expect(validateConfig(config()).config).not.toHaveProperty('standalone');
    expect(validateConfig(config(ON)).config!.standalone).toBe('on');
    expect(validateConfig(config({ standalone: 'off' })).config!.standalone).toBe('off');
    expect(validateConfig({ ...config(), standalone: true }).errors).toEqual(['standalone: must be "off" or "on"']);
  });

  it('takes the resources\' kinds in a backend kind criterion', () => {
    const cfg = config({ filters: [filter('db', [{ backendKinds: ['rds-instance', 'rds-cluster', 'instance'] }])] });
    expect(validateConfig(cfg).errors).toEqual([]);
  });
});

describe('criteria on a standalone candidate', () => {
  const on = (c: Criterion) => matches(c, A, standalone(), INVENTORY);
  it('apply the account, region, resource tag and backend kind criteria to the resource', () => {
    expect([on({ accountIds: [A.id] }), on({ regions: ['eu-west-1'] }), on({ resourceTags: { env: ['dev'] } }), on({ backendKinds: ['rds-instance'] })]).toEqual([true, true, true, true]);
    expect([on({ accountIds: ['222222222222'] }), on({ regions: ['eu-west-3'] }), on({ resourceTags: { env: ['prod'] } }), on({ backendKinds: ['instance'] })]).toEqual([false, false, false, false]);
  });

  it('never match a load balancer, host or target group criterion: it has none', () => {
    expect([on({ loadBalancers: ['*'] }), on({ hosts: ['*'] }), on({ targetGroups: ['*'] })]).toEqual([false, false, false]);
  });

  it('are out of scope while the perimeter\'s standalone scan is off, whatever includes them', () => {
    const cfg = config({ filters: [filter('all', [{ accountIds: [A.id] }])] });
    expect(decide(cfg, A, standalone(), INVENTORY)).toEqual({ scope: 'out', reason: 'out of scope: the perimeter\'s standalone scan is off' });
    expect(decide({ ...cfg, ...ON }, A, standalone(), INVENTORY)).toEqual({ scope: 'in', reason: 'in scope: filter "all", include 1' });
    // An HTTP candidate is decided as before.
    expect(decide(cfg, A, rule(), INVENTORY)).toEqual({ scope: 'in', reason: 'in scope: filter "all", include 1' });
  });
});

describe('an exclusion of a resource', () => {
  const exclusion: Exclusion = { id: 'e1', target: { kind: 'resource', arn: ARN, account: A.id, region: 'eu-west-1', name: 'shop-db' }, reason: 'kept on', by: 'ops@example.com', at: '2026-11-21T00:00:00.000Z' };
  it('excludes its standalone candidate only, after the scan of its account and region', () => {
    expect(exclusionCriterion(exclusion)).toEqual({ resources: [ARN], label: 'manual exclusion by ops@example.com: kept on' });
    const cfg = withExclusions(config({ ...ON, filters: [filter('all', [{ accountIds: [A.id] }])] }), [exclusion], T);
    expect(decide(cfg, A, standalone(), INVENTORY)).toEqual({ scope: 'excluded', reason: 'excluded: manual exclusion by ops@example.com: kept on' });
    expect(decide(cfg, A, standalone({ id: `${ARN}-2`, resourceArn: `${ARN}-2` }), INVENTORY).scope).toBe('in');
    expect(decide(cfg, A, rule(), INVENTORY).scope).toBe('in');
    expect([globalAccountExclude(cfg, A, INVENTORY), globalPairExclude(cfg, A, 'eu-west-1', INVENTORY)]).toEqual([-1, -1]);
  });
});

describe('the lifecycle of a standalone candidate', () => {
  const cfg = config({ ...ON, filters: [filter('all', [{ accountIds: [A.id] }])] });
  const ok = (rules: (StandaloneRule | ReturnType<typeof rule>)[], unread?: StandaloneRule['backend']['kind'][]) => [{ account: A.id, region: 'eu-west-1', ok: true, rules, ms: 1, ...(unread ? { unread } : {}) }];
  const first = (r: StandaloneRule, c = cfg) => nextCandidates({ previous: new Map(), results: ok([r]), inventory: INVENTORY, config: c, now: T })[0]!;
  const previous = (c: AnyCandidate) => new Map([[c.id, c]]);

  it('is pending onboarding when eligible, managed when the scan says so', () => {
    expect([first(standalone()).status, first(standalone()).statusReason]).toEqual(['pending-onboarding', 'eligible']);
    expect([first(standalone({ eligibility: 'managed', workloadId: 'abc' })).status]).toEqual(['managed']);
  });

  it('is gone when its region is scanned without it, managed with the resource named', () => {
    const managed = first(standalone({ eligibility: 'managed', workloadId: 'abc' }));
    const [gone] = nextCandidates({ previous: previous(managed), results: ok([]), inventory: INVENTORY, config: cfg, now: T + 1000 });
    expect([gone!.status, gone!.statusReason]).toEqual(['gone', 'managed resource not found in the last scan: offboard it']);
    const [plain] = nextCandidates({ previous: previous(first(standalone())), results: ok([]), inventory: INVENTORY, config: cfg, now: T + 1000 });
    expect([plain!.status, plain!.statusReason]).toEqual(['gone', 'not found in the last scan']);
  });

  it('stays as it was while its kind could not be read', () => {
    const stored = first(standalone());
    expect(nextCandidates({ previous: previous(stored), results: ok([], ['rds-instance']), inventory: INVENTORY, config: cfg, now: T + 1000 })).toEqual([]);
  });

  it('is out of scope once the standalone scan is off, a managed one pending offboarding, never gone', () => {
    const off = { ...cfg, standalone: 'off' as const };
    const [plain] = nextCandidates({ previous: previous(first(standalone())), results: ok([]), inventory: INVENTORY, config: off, now: T + 1000 });
    expect([plain!.status, plain!.statusReason, plain!.goneAt]).toEqual(['out-of-scope', 'out of scope: the perimeter\'s standalone scan is off', undefined]);
    const [managed] = nextCandidates({ previous: previous(first(standalone({ eligibility: 'managed', workloadId: 'abc' }))), results: ok([]), inventory: INVENTORY, config: off, now: T + 1000 });
    expect([managed!.status, managed!.statusReason]).toEqual(['pending-offboarding', 'out of scope: the perimeter\'s standalone scan is off']);
  });
});
