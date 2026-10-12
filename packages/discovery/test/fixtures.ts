// A small organization: root, a chain of five nested OUs, a sibling OU; three accounts.
import type { Account, Criterion, DiscoveryConfig, OrgInventory, ScannedRule } from '../src/types.js';

export const ROOT = 'r-1u0b';
export const [OU1, OU2, OU3, OU4, OU5, PROD] = ['ou-1u0b-aaaaaaa1', 'ou-1u0b-aaaaaaa2', 'ou-1u0b-aaaaaaa3', 'ou-1u0b-aaaaaaa4', 'ou-1u0b-aaaaaaa5', 'ou-1u0b-pppppppp'] as const;
export const A: Account = { id: '111111111111', name: 'tools', ouPath: [ROOT], tags: {} };
export const B: Account = { id: '222222222222', name: 'deep', ouPath: [ROOT, OU1, OU2, OU3, OU4, OU5], tags: { env: 'dev' } };
export const C: Account = { id: '333333333333', name: 'shop-prod', ouPath: [ROOT, PROD], tags: { env: 'prod', team: 'shop' } };
export const INVENTORY: OrgInventory = {
  accounts: [A, B, C],
  ous: {
    [ROOT]: { name: 'Root', parent: null },
    [OU1]: { name: 'one', parent: ROOT },
    [OU2]: { name: 'two', parent: OU1 },
    [OU3]: { name: 'three', parent: OU2 },
    [OU4]: { name: 'four', parent: OU3 },
    [OU5]: { name: 'five', parent: OU4 },
    [PROD]: { name: 'prod', parent: ROOT },
  },
};

export function rule(over: Partial<ScannedRule> = {}): ScannedRule {
  return {
    id: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:listener-rule/app/web-shop/1/2/3',
    account: A.id,
    region: 'eu-west-1',
    loadBalancer: 'web-shop',
    loadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/web-shop/1',
    listener: 'HTTPS:443',
    priority: '10',
    conditions: 'host shop.example.com',
    hosts: ['shop.example.com'],
    targetGroup: 'shop',
    targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/1',
    suggestedId: 'shop',
    backend: { kind: 'instance', id: 'i-1' },
    tags: { env: ['preview'] },
    eligibility: 'eligible',
    idleHours7d: 100,
    requests7d: 10,
    ...over,
  };
}

export function config(over: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return { version: 1, mode: 'organization', regions: ['eu-west-1', 'eu-west-3'], refreshHours: 24, globalExcludes: [], filters: [], ...over };
}

export const filter = (name: string, include: Criterion[], exclude: Criterion[] = []) => ({ name, include, exclude });
