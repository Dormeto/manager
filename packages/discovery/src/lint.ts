// Useless inclusions (spec section 4.3): an include that a global exclude, or its own filter's exclude, covers; an include
// of everything; and, after a run, includes that matched nothing or only globally excluded accounts, regions or rules.
import { describeCriterion, globMatches, globalAccountExclude, globalPairExclude, matches, matchesAccount, tagsMatch } from './filters.js';
import type { Criterion, DiscoveryConfig, LintFinding, OrgInventory, ScannedRule } from './types.js';

const DIMENSIONS = ['accountIds', 'ouIds', 'accountTags', 'regions', 'loadBalancers', 'hosts', 'resourceTags', 'backendKinds', 'targetGroups'] as const;

function isUnder(ou: string, ancestor: string, inventory: OrgInventory): boolean {
  for (let current: string | null = ou; current; current = inventory.ous[current]?.parent ?? null) {
    if (current === ancestor) return true;
  }
  return false;
}

const isRoot = (id: string, inventory: OrgInventory) => inventory.ous[id]?.parent === null;

const subset = (inner: string[] | undefined, outer: string[]) => inner !== undefined && inner.every((v) => outer.includes(v));

// Every key the exclude sets is on the include, with values at least as narrow ([] = any value).
function tagsCover(outer: Record<string, string[]>, inner: Record<string, string[]> | undefined): boolean {
  if (!inner) return false;
  return Object.entries(outer).every(([key, values]) => key in inner && (values.length === 0 || (inner[key]!.length > 0 && subset(inner[key], values))));
}

function patternCovers(outer: string, inner: string): boolean {
  if (outer === '*' || outer === inner) return true;
  if (outer.startsWith('arn:') || inner.startsWith('arn:') || inner.includes('*')) return false;
  return globMatches(outer, inner);
}

// Account dimensions, resolved through the organization tree: listed accounts by their OU path and tags, OUs by ancestry.
function accountsCovered(e: Criterion, i: Criterion, inventory: OrgInventory): boolean {
  const known = new Map(inventory.accounts.map((a) => [a.id, a]));
  const listed = (check: (account: NonNullable<ReturnType<typeof known.get>>) => boolean) =>
    i.accountIds !== undefined && i.accountIds.every((id) => {
      const account = known.get(id);
      return account !== undefined && check(account);
    });
  if (e.accountIds && !subset(i.accountIds, e.accountIds)) return false;
  if (e.ouIds) {
    const ous = e.ouIds;
    const proven = ous.some((ou) => isRoot(ou, inventory))
      || listed((a) => ous.some((ou) => a.ouPath.includes(ou)))
      || (i.accountIds === undefined && i.ouIds !== undefined && i.ouIds.every((inner) => ous.some((ou) => isUnder(inner, ou, inventory))));
    if (!proven) return false;
  }
  if (e.accountTags) {
    const tags = e.accountTags;
    if (!tagsCover(tags, i.accountTags) && !listed((a) => tagsMatch(tags, a.tags))) return false;
  }
  return true;
}

// The exclude covers the include when, for every dimension it sets, the include is at least as narrow.
export function covers(e: Criterion, i: Criterion, inventory: OrgInventory): boolean {
  if (!accountsCovered(e, i, inventory)) return false;
  if (e.regions && !subset(i.regions, e.regions)) return false;
  if (e.backendKinds && !subset(i.backendKinds, e.backendKinds)) return false;
  for (const key of ['loadBalancers', 'hosts', 'targetGroups'] as const) {
    const outer = e[key];
    if (outer && !(i[key] !== undefined && i[key]!.every((p) => outer.some((q) => patternCovers(q, p))))) return false;
  }
  if (e.resourceTags && !tagsCover(e.resourceTags, i.resourceTags)) return false;
  return true;
}

const isEverything = (c: Criterion) => DIMENSIONS.every((d) => c[d] === undefined);
const noted = (c: Criterion) => (c.note ? ` "${c.note}"` : '');

// After a run: every account-region pair the include can reach was removed by global excludes before the scan.
function onlyExcludedPairs(config: DiscoveryConfig, include: Criterion, inventory: OrgInventory): boolean {
  const accounts = inventory.accounts.filter((a) => matchesAccount(include, a, inventory));
  if (!accounts.length) return false;
  const regions = config.regions.includes('*') ? null : config.regions.filter((r) => !include.regions || include.regions.includes(r));
  return accounts.every((a) => globalAccountExclude(config, a, inventory) >= 0
    || (regions !== null && regions.length > 0 && regions.every((r) => globalPairExclude(config, a, r, inventory) >= 0)));
}

// Per include ("<filter>#<include index>"), the rules of a run it matched and how many of them a global exclude matched:
// each account step counts its own rules, the run sums them (scale design §5).
export type LintCounters = Record<string, { matched: number; excluded: number }>;
const includeKey = (filter: string, index: number) => `${filter}#${index + 1}`;

export function lintCounters(config: DiscoveryConfig, inventory: OrgInventory, rules: ScannedRule[]): LintCounters {
  const accounts = new Map(inventory.accounts.map((a) => [a.id, a]));
  const counters: LintCounters = {};
  for (const f of config.filters) {
    f.include.forEach((include, index) => {
      const matched = rules.filter((r) => {
        const account = accounts.get(r.account);
        return account !== undefined && matches(include, account, r, inventory);
      });
      const excluded = matched.filter((r) => config.globalExcludes.some((g) => matches(g, accounts.get(r.account)!, r, inventory)));
      counters[includeKey(f.name, index)] = { matched: matched.length, excluded: excluded.length };
    });
  }
  return counters;
}

export function sumCounters(all: LintCounters[]): LintCounters {
  const sum: LintCounters = {};
  for (const counters of all) {
    for (const [key, c] of Object.entries(counters)) {
      const s = (sum[key] ??= { matched: 0, excluded: 0 });
      s.matched += c.matched;
      s.excluded += c.excluded;
    }
  }
  return sum;
}

export function lint(config: DiscoveryConfig, inventory: OrgInventory, last?: { rules: ScannedRule[] } | { counters: LintCounters }): LintFinding[] {
  const findings: LintFinding[] = [];
  const counters = last && ('rules' in last ? lintCounters(config, inventory, last.rules) : last.counters);
  for (const f of config.filters) {
    f.include.forEach((include, index) => {
      const at = `filter "${f.name}", include ${index + 1}`;
      const base = { filter: f.name, include: index + 1 };
      const global = config.globalExcludes.findIndex((g) => covers(g, include, inventory));
      if (global >= 0) {
        const g = config.globalExcludes[global]!;
        const by = g.label ?? `global exclude ${global + 1}`;
        findings.push({ code: 'include-shadowed-by-global-exclude', level: 'warning', ...base, by, message: `${at} can never match: ${by}${g.label ? '' : noted(g)} covers it (${describeCriterion(g)})` });
        return;
      }
      const own = f.exclude.findIndex((e) => covers(e, include, inventory));
      if (own >= 0) {
        findings.push({ code: 'include-shadowed-by-filter-exclude', level: 'warning', ...base, by: `exclude ${own + 1}`, message: `${at} can never match: its exclude ${own + 1}${noted(f.exclude[own]!)} covers it (${describeCriterion(f.exclude[own]!)})` });
        return;
      }
      if (isEverything(include)) findings.push({ code: 'include-everything', level: 'warning', ...base, message: `${at} includes every account and region` });
      if (!last) return;
      const onlyExcluded = { code: 'include-only-globally-excluded', level: 'warning', ...base, message: `${at} only matched globally excluded accounts, regions or rules in the last run` } as const;
      if (onlyExcludedPairs(config, include, inventory)) {
        findings.push(onlyExcluded);
        return;
      }
      const c = counters?.[includeKey(f.name, index)] ?? { matched: 0, excluded: 0 };
      if (!c.matched) findings.push({ code: 'include-matches-nothing', level: 'info', ...base, message: `${at} matched no rule in the last run` });
      else if (c.excluded === c.matched) findings.push(onlyExcluded);
    });
  }
  return findings;
}
