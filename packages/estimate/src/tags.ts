// The workloads left out by their tags (vision docs/specs/2026-10-10-savings-estimate-design.md §3, --exclude-tags),
// after discovery and before the requests are read: any criterion excludes; in one, every key (and), each with one of
// its values ([] = any value), matched as discovery's resourceTags against the tags of the workload's load balancer,
// target group or rule.
import { resourceTagsMatch } from '@dormeto/discovery';
import type { RegionDiscovery, Workload } from './discover.js';

export type TagCriterion = Record<string, string[]>;
// criterion: the first that matched, in the product's words.
export interface Excluded { workload: Workload; criterion: string }

// "env=dev|test, team=web, dormeto:ignore", as discovery describes its resourceTags.
export const describeTags = (c: TagCriterion) => Object.entries(c).map(([k, v]) => (v.length ? `${k}=${v.join('|')}` : k)).join(', ');

export function excludeByTags(regions: RegionDiscovery[], criteria: TagCriterion[]): { regions: RegionDiscovery[]; excluded: Excluded[] } {
  if (!criteria.length) return { regions, excluded: [] };
  const excluded: Excluded[] = [];
  const kept = regions.map((region) => ({
    ...region,
    workloads: region.workloads.filter((workload) => {
      const matched = criteria.find((c) => resourceTagsMatch(c, workload.tags));
      if (matched) excluded.push({ workload, criterion: describeTags(matched) });
      return !matched;
    }),
  }));
  return { regions: kept, excluded };
}
