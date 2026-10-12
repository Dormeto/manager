// What a workload's backends cost and save (user request): its last nap's items, priced by the API, matched to its
// backends by kind (EC2 instances and Auto Scaling groups, ECS services, databases); several backends of a kind share the
// price of their items, which the nap does not tell apart. A month is 730 hours, saved at the share of the last 30 days
// asleep within the baseline.
import type { Costs, StoppedItem } from './types';

export const MONTH_HOURS = 730;
const BACKEND_GROUPS: Record<string, string> = { instance: 'ec2', asg: 'ec2', ecs: 'fargate', 'rds-instance': 'db', 'rds-cluster': 'db' };
const ITEM_GROUPS: Record<string, string> = { ec2: 'ec2', fargate: 'fargate', rds: 'db', 'aurora-serverless': 'db' };

export interface BackendCost {
  hourly: number | null;
  monthly: number | null;
  savedMonthly: number | null;
  shared: number; // the backends of its kind sharing the price
  unpriced: string[];
}

// An item in a few words, for what is not priced.
export function itemText(item: StoppedItem): string {
  switch (item.kind) {
    case 'ec2': return `${item.count} × ${item.type} (${item.os})`;
    case 'fargate': return `${item.count} × ${item.vcpu} vCPU, ${item.memoryGb} GB (${item.os}, ${item.arch})`;
    case 'rds': return `${item.class} ${item.engine}${item.multiAz ? ' Multi-AZ' : ''}`;
    case 'aurora-serverless': return `${item.engine} Serverless v2, ${item.acu} ACU`;
    default: return item.reason;
  }
}

export function backendCost(backend: { kind: string; id: string }, backends: { kind: string; id: string }[], costs: Costs | undefined | null): BackendCost | null {
  if (!costs?.items.length) return null;
  const group = BACKEND_GROUPS[backend.kind];
  const items = costs.items.filter(({ item }) => (item.kind === 'unknown' ? item.backend === `${backend.kind}:${backend.id}` : ITEM_GROUPS[item.kind] === group));
  const priced = items.filter((i) => i.hourly !== null);
  const hourly = priced.length ? priced.reduce((n, i) => n + i.hourly!, 0) : null;
  const monthly = hourly === null ? null : hourly * MONTH_HOURS;
  return {
    hourly, monthly, savedMonthly: monthly === null || costs.savedShare === null ? null : monthly * costs.savedShare,
    shared: backends.filter((b) => BACKEND_GROUPS[b.kind] === group).length, unpriced: items.filter((i) => i.hourly === null).map((i) => itemText(i.item)),
  };
}

// The workload's saving a month at the rate of the last 30 days, from what its last nap stopped; null before a priced nap.
export function monthlySaving(costs: Costs | undefined | null): number | null {
  const priced = (costs?.items ?? []).filter((i) => i.hourly !== null);
  if (!costs || !priced.length || costs.savedShare === null) return null;
  return priced.reduce((n, i) => n + i.hourly!, 0) * MONTH_HOURS * costs.savedShare;
}

// What the 7-day bar says of a workload's savings: the base cost an hour of what its last nap stopped, what its naps
// saved in the last 30 days, and a month's saving at that rate.
export function barSavings(costs: Costs | undefined | null): { saved: Costs['saved']; hourly: number | null; monthly: number | null } | null {
  if (!costs) return null;
  const priced = costs.items.filter((i) => i.hourly !== null);
  return { saved: costs.saved, hourly: priced.length ? priced.reduce((n, i) => n + i.hourly!, 0) : null, monthly: monthlySaving(costs) };
}
