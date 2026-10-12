// Perimeter evaluation (spec section 4): criteria, global excludes first, then filters (one including filter is enough,
// a filter's excludes only apply to that filter), and the account-region pairs worth scanning.
import type { Account, AccountPlan, Criterion, Decision, DiscoveryConfig, OrgInventory, PairPlan, ScannedRule } from './types.js';

const ACCOUNT_DIMENSIONS = ['accountIds', 'ouIds', 'accountTags'] as const;
const RESOURCE_DIMENSIONS = ['loadBalancers', 'hosts', 'resourceTags', 'backendKinds'] as const;

const isSet = (value: unknown): boolean => value !== undefined;
const setsAny = (c: Criterion, dims: readonly (keyof Criterion)[]) => dims.some((d) => isSet(c[d]));

// Glob with * wildcards, case-insensitive (host and load balancer names are).
export function globMatches(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(value);
}

function tagsMatch(wanted: Record<string, string[]>, tags: Record<string, string>): boolean {
  return Object.entries(wanted).every(([key, values]) => key in tags && (values.length === 0 || values.includes(tags[key]!)));
}

// Account dimensions only: account IDs, OUs (recursive, the root matches every account), account tags.
export function matchesAccount(c: Criterion, account: Account, _inventory?: OrgInventory): boolean {
  if (c.accountIds && !c.accountIds.includes(account.id)) return false;
  if (c.ouIds && !c.ouIds.some((ou) => account.ouPath.includes(ou))) return false;
  if (c.accountTags && !tagsMatch(c.accountTags, account.tags)) return false;
  return true;
}

const matchesRegion = (c: Criterion, region: string) => !c.regions || c.regions.includes(region);

export function matches(c: Criterion, account: Account, rule: ScannedRule, inventory: OrgInventory): boolean {
  if (!matchesAccount(c, account, inventory) || !matchesRegion(c, rule.region)) return false;
  if (c.loadBalancers && !c.loadBalancers.some((p) => (p.startsWith('arn:') ? p === rule.loadBalancerArn : globMatches(p, rule.loadBalancer)))) return false;
  if (c.hosts && !c.hosts.some((p) => rule.hosts.some((h) => globMatches(p, h)))) return false;
  if (c.resourceTags && !tagsMatch(c.resourceTags, rule.tags)) return false;
  if (c.backendKinds && !(rule.backend && c.backendKinds.includes(rule.backend.kind))) return false;
  return true;
}

const plural = (one: string, many: string, values: string[]) => `${values.length > 1 ? many : one} ${values.join(', ')}`;
const tagText = (tags: Record<string, string[]>) => Object.entries(tags).map(([k, v]) => (v.length ? `${k}=${v.join('|')}` : k)).join(', ');

// "account 111111111111, region eu-west-1": what the criterion sets, for reasons and lint messages.
export function describeCriterion(c: Criterion): string {
  const parts: string[] = [];
  if (c.accountIds) parts.push(plural('account', 'accounts', c.accountIds));
  if (c.ouIds) parts.push(plural('OU', 'OUs', c.ouIds));
  if (c.accountTags) parts.push(`account tags ${tagText(c.accountTags)}`);
  if (c.regions) parts.push(plural('region', 'regions', c.regions));
  if (c.loadBalancers) parts.push(plural('load balancer', 'load balancers', c.loadBalancers));
  if (c.hosts) parts.push(plural('host', 'hosts', c.hosts));
  if (c.resourceTags) parts.push(`tags ${tagText(c.resourceTags)}`);
  if (c.backendKinds) parts.push(plural('backend', 'backends', c.backendKinds));
  return parts.join(', ') || 'everything';
}

const globalReason = (index: number, c: Criterion) => `excluded: global exclude ${index + 1}${c.note ? ` "${c.note}"` : ''} (${describeCriterion(c)})`;

export function decide(config: DiscoveryConfig, account: Account, rule: ScannedRule, inventory: OrgInventory): Decision {
  const global = config.globalExcludes.findIndex((c) => matches(c, account, rule, inventory));
  if (global >= 0) return { scope: 'excluded', reason: globalReason(global, config.globalExcludes[global]!) };
  let excludedBy: string | null = null;
  for (const f of config.filters) {
    const include = f.include.findIndex((c) => matches(c, account, rule, inventory));
    if (include < 0) continue;
    const exclude = f.exclude.findIndex((c) => matches(c, account, rule, inventory));
    if (exclude < 0) return { scope: 'in', reason: `in scope: filter "${f.name}", include ${include + 1}` };
    excludedBy ??= `excluded: filter "${f.name}", exclude ${exclude + 1}`;
  }
  return excludedBy ? { scope: 'excluded', reason: excludedBy } : { scope: 'out', reason: 'out of scope: no filter includes it' };
}

// A global exclude that sets only account dimensions removes the whole account before any call.
const excludesAccount = (c: Criterion) => !setsAny(c, ['regions', ...RESOURCE_DIMENSIONS]);
// A global exclude without resource dimension removes the account-region pair before any call.
const excludesPair = (c: Criterion) => !setsAny(c, RESOURCE_DIMENSIONS);

const includes = (config: DiscoveryConfig) => config.filters.flatMap((f) => f.include);

export function scanAccounts(config: DiscoveryConfig, inventory: OrgInventory): AccountPlan[] {
  return inventory.accounts.map((account) => {
    const global = config.globalExcludes.findIndex((c) => excludesAccount(c) && matchesAccount(c, account, inventory));
    if (global >= 0) return { account: account.id, scan: false, reason: globalReason(global, config.globalExcludes[global]!) };
    const filter = config.filters.find((f) => f.include.some((c) => matchesAccount(c, account, inventory)));
    return filter
      ? { account: account.id, scan: true, reason: `included by filter "${filter.name}"` }
      : { account: account.id, scan: false, reason: 'no filter includes this account' };
  });
}

export function targetPairs(config: DiscoveryConfig, inventory: OrgInventory, enabledRegions: Record<string, string[]>): PairPlan[] {
  const accounts = new Map(inventory.accounts.map((a) => [a.id, a]));
  const pairs: PairPlan[] = [];
  for (const plan of scanAccounts(config, inventory)) {
    const all = config.regions.includes('*');
    if (!plan.scan) {
      for (const region of all ? ['*'] : config.regions) pairs.push({ account: plan.account, region, scan: false, reason: plan.reason });
      continue;
    }
    const account = accounts.get(plan.account)!;
    for (const region of all ? enabledRegions[plan.account] ?? [] : config.regions) {
      const global = config.globalExcludes.findIndex((c) => excludesPair(c) && matchesAccount(c, account, inventory) && matchesRegion(c, region));
      if (global >= 0) {
        pairs.push({ account: plan.account, region, scan: false, reason: globalReason(global, config.globalExcludes[global]!) });
        continue;
      }
      const included = includes(config).some((c) => matchesAccount(c, account, inventory) && matchesRegion(c, region));
      pairs.push({ account: plan.account, region, scan: included, reason: included ? plan.reason : 'no filter includes this region' });
    }
  }
  return pairs;
}

export { ACCOUNT_DIMENSIONS, RESOURCE_DIMENSIONS };
