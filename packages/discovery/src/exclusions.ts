// Manual exclusions (router management, vision docs/specs/2026-10-05-router-management-design.md section 5): each active
// exclusion is one more global exclude, after the configured ones, whose reason names its author and reason.
import type { Criterion, DiscoveryConfig, Exclusion } from './types.js';

export const activeExclusions = (exclusions: Exclusion[], now: number) => exclusions.filter((e) => !e.expiresAt || Date.parse(e.expiresAt) > now);

export function exclusionCriterion(e: Exclusion): Criterion {
  const label = `manual exclusion by ${e.by}: ${e.reason}`;
  if (e.target.kind === 'account') return { accountIds: [e.target.account], label };
  if (e.target.kind === 'load-balancer') return { loadBalancers: [e.target.arn!], label };
  return { targetGroups: [e.target.arn!], label };
}

export const withExclusions = (config: DiscoveryConfig, exclusions: Exclusion[], now: number): DiscoveryConfig => ({
  ...config,
  globalExcludes: [...config.globalExcludes, ...activeExclusions(exclusions, now).map(exclusionCriterion)],
});
