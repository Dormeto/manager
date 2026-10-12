// A synthetic organization for the acceptance at scale (scale design §7), enabled in dev only: accounts 000000000001 and
// on, in the OU "synthetic", each with one application load balancer in one of 17 regions, 10 target groups behind it
// and 5 rules per target group. Their scans answer without any role or AWS call, the same at every run.
import type { OrgInventory, RuleRef, ScannedRule } from './types.js';

export const SYNTHETIC_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'eu-north-1', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'sa-east-1',
];
const OU = 'ou-synthetic';
const TARGET_GROUPS = 10;
const RULES = 5;

export const isSynthetic = (account: string) => /^000000\d{6}$/.test(account);
const indexOf = (account: string) => Number(account.slice(6));
const hex = (n: number, size: number) => n.toString(16).padStart(size, '0');

export function syntheticInventory(accounts: number, root = 'r-synthetic'): OrgInventory {
  return {
    accounts: Array.from({ length: accounts }, (_, i) => ({ id: `000000${String(i + 1).padStart(6, '0')}`, name: `synthetic-${String(i + 1).padStart(4, '0')}`, ouPath: [root, OU], tags: {} })),
    ous: { [root]: { name: 'Root', parent: null }, [OU]: { name: 'synthetic', parent: root } },
  };
}

export function syntheticRules(account: string, region: string): ScannedRule[] {
  const i = indexOf(account);
  if (!isSynthetic(account) || SYNTHETIC_REGIONS[i % SYNTHETIC_REGIONS.length] !== region) return [];
  const lb = `syn-${i}`;
  const lbArn = `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/${lb}/${hex(i, 16)}`;
  return Array.from({ length: TARGET_GROUPS }, (_, t) => {
    const tg = `syn-${i}-${t}`;
    const host = `app${t}.syn${i}.example.com`;
    const rules: RuleRef[] = Array.from({ length: RULES }, (_, r) => ({
      id: `arn:aws:elasticloadbalancing:${region}:${account}:listener-rule/app/${lb}/${hex(i, 16)}/${hex(1, 16)}/${hex(t * RULES + r + 1, 16)}`,
      listener: 'HTTPS:443', priority: String(t * RULES + r + 1), conditions: `host ${host}${r ? ` path /p${r}/*` : ''}`, hosts: [host], managed: false,
    }));
    // Every tenth target group is shared with another rule set: ineligible; idle hours spread over the week.
    const ineligible = t === TARGET_GROUPS - 1;
    return {
      id: `arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/${tg}/${hex(i * TARGET_GROUPS + t, 16)}`,
      account, region, loadBalancer: lb, loadBalancerArn: lbArn, listener: 'HTTPS:443', priority: rules[0]!.priority, conditions: rules[0]!.conditions,
      hosts: [host], targetGroup: tg, targetGroupArn: `arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/${tg}/${hex(i * TARGET_GROUPS + t, 16)}`,
      backend: { kind: 'instance', id: `i-${hex(i * TARGET_GROUPS + t, 17)}` }, tags: { env: [t % 2 ? 'preview' : 'dev'] }, rules,
      eligibility: ineligible ? 'ineligible' : 'eligible', ...(ineligible ? { reason: 'its target group serves another listener rule set' } : {}),
      idleHours7d: (i * 7 + t * 13) % 169, requests7d: (i * 31 + t * 17) % 5000,
    };
  });
}
