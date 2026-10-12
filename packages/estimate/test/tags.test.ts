// The workloads left out by their tags (spec §3, --exclude-tags): any criterion excludes; in one, every key (and), each
// with one of its values ([] = any value), as discovery's resourceTags match the tags of a load balancer, target group or
// rule.
import { describe, expect, it } from 'vitest';
import type { RegionDiscovery, Workload } from '../src/discover.js';
import { describeTags, excludeByTags } from '../src/tags.js';

const w = (name: string, tags: Record<string, string[]>): Workload => ({
  account: '111111111111', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'arn:lb', targetGroup: name, targetGroupArn: `arn:tg/${name}`,
  hosts: [`${name}.example.com`], backend: { kind: 'asg', id: name }, stopped: [], tags,
});
const region = (workloads: Workload[]): RegionDiscovery => ({ account: '111111111111', region: 'eu-west-1', workloads, ineligible: [] });
const W = [
  w('shop', { env: ['prod'], team: ['web'] }), w('docs', { env: ['dev'], team: ['web'] }), w('crm', { env: ['test'], team: ['sales'] }),
  w('legacy', { 'dormeto:ignore': [''] }), w('blog', {}),
];
const kept = (criteria: Record<string, string[]>[]) => excludeByTags([region(W)], criteria).regions[0]!.workloads.map((x) => x.targetGroup);

describe('the workloads left out by their tags', () => {
  it('none given: every workload kept', () => {
    expect(excludeByTags([region(W)], [])).toEqual({ regions: [region(W)], excluded: [] });
  });

  it('a key with one of its values (or)', () => {
    expect(kept([{ env: ['dev', 'test'] }])).toEqual(['shop', 'legacy', 'blog']);
  });

  it('every key of a criterion (and)', () => {
    expect(kept([{ env: ['dev', 'prod'], team: ['web'] }])).toEqual(['crm', 'legacy', 'blog']);
    expect(kept([{ env: ['test'], team: ['web'] }])).toEqual(W.map((x) => x.targetGroup));
  });

  it('a key alone, whatever its value', () => {
    expect(kept([{ 'dormeto:ignore': [] }])).toEqual(['shop', 'docs', 'crm', 'blog']);
  });

  it('any of several criteria (or), each excluded workload with the first that matched', () => {
    const { regions, excluded } = excludeByTags([region(W)], [{ env: ['dev'] }, { team: ['sales'] }, { 'dormeto:ignore': [] }, { team: ['web'] }]);
    expect(regions[0]!.workloads.map((x) => x.targetGroup)).toEqual(['blog']);
    expect(excluded.map((x) => [x.workload.targetGroup, x.criterion])).toEqual([['shop', 'team=web'], ['docs', 'env=dev'], ['crm', 'team=sales'], ['legacy', 'dormeto:ignore']]);
  });

  it('a criterion in the product\'s words', () => {
    expect(describeTags({ env: ['dev', 'test'], team: ['web'], 'dormeto:ignore': [] })).toBe('env=dev|test, team=web, dormeto:ignore');
  });
});
