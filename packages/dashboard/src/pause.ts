// Router management display helpers: pauses, router health, manual exclusions.
import { checkHealth, relative } from './format';
import type { ExclusionKind, ExclusionTarget, Pause } from './types';

export function pauseLabel(pauses: Pause[] | undefined): 'excluded' | 'paused' | null {
  if (!pauses?.length) return null;
  return pauses.some((p) => p.exclusionId) ? 'excluded' : 'paused';
}

export function pauseLine(p: Pause, now = Date.now()): string {
  const who = p.exclusionId ? 'Excluded' : p.scope === 'router' ? 'Router paused' : 'Paused';
  const reason = p.exclusionId ? p.reason.replace(/^excluded: /, '') : p.reason;
  return [`${who} by ${p.by} ${relative(p.at, now)}: ${reason}`, ...(p.until ? [`resumes ${relative(p.until, now)}`] : []), ...(p.keepAsleep ? ['asleep workloads left asleep'] : [])].join('; ');
}

export type UntilChoice = 'none' | '1h' | '4h' | '1d' | '7d' | 'date';
export const UNTIL_CHOICES: { value: UntilChoice; title: string }[] = [
  { value: 'none', title: 'Never (resume by hand)' },
  { value: '1h', title: 'In 1 hour' },
  { value: '4h', title: 'In 4 hours' },
  { value: '1d', title: 'In 1 day' },
  { value: '7d', title: 'In 7 days' },
  { value: 'date', title: 'At a date' },
];
const AHEAD: Record<string, number> = { '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000 };

// The automatic resume (or expiry) of a choice; `date` is a datetime-local input value (local time).
export function untilFrom(choice: UntilChoice, now = Date.now(), date = ''): string | undefined {
  if (choice === 'date') return date ? new Date(date).toISOString() : undefined;
  const ahead = AHEAD[choice];
  return ahead ? new Date(now + ahead).toISOString() : undefined;
}

const HEALTH: Record<string, string> = { ok: 'success', warning: 'warning', error: 'error' };
export const healthColor = (status: string | undefined): string => (status && HEALTH[status]) || 'grey';

// A router's status for the Overview: unreachable, its health, not reporting (a router known by its list answer only has
// no health: its schedule alone could say ok while its checks fail), a late check, or ok.
export function routerStatus(r: { error?: string; reporting?: boolean; health?: { status: string; problems: { level?: string; text: string }[] }; checkSchedule?: string | null; lastScheduledCheckAt?: string | null }, now = Date.now()): { color: string; text: string; detail: string } {
  if (r.error) return { color: 'error', text: 'unreachable', detail: r.error };
  const check = checkHealth(r, now);
  if (r.health) return { color: healthColor(r.health.status), text: r.health.status, detail: r.health.problems[0]?.text ?? check.text };
  if (r.reporting === false) return { color: 'warning', text: 'not reporting', detail: 'no report from its idle checks for 3 periods of its schedule' };
  return check.late ? { color: 'warning', text: 'idle check late', detail: check.text } : { color: 'success', text: 'ok', detail: check.text };
}

export interface TargetOption {
  kind: ExclusionKind;
  arn?: string;
  account?: string;
  label: string;
}

// What an operator can exclude from a discovery candidate (or a workload): its target group, load balancer, account.
export function exclusionTargets(c: { targetGroupArn: string | null; targetGroup: string | null; loadBalancerArn: string; loadBalancer: string; account: string; accountName: string }): TargetOption[] {
  return [
    ...(c.targetGroupArn ? [{ kind: 'target-group' as const, arn: c.targetGroupArn, label: `Target group ${c.targetGroup ?? c.targetGroupArn}` }] : []),
    ...(c.loadBalancerArn.startsWith('arn:') ? [{ kind: 'load-balancer' as const, arn: c.loadBalancerArn, label: `Load balancer ${c.loadBalancer} (every rule on it)` }] : []),
    { kind: 'account' as const, account: c.account, label: `Account ${c.accountName === c.account ? c.account : `${c.accountName}, ${c.account}`} (never read again)` },
  ];
}

const KINDS: Record<ExclusionKind, string> = { 'target-group': 'target group', 'load-balancer': 'load balancer', account: 'account' };
export const exclusionText = (t: ExclusionTarget): string => [`${KINDS[t.kind]} ${t.name}`, t.account, ...(t.region ? [t.region] : [])].join(' · ');
