// Router management display helpers: pauses, router health, manual exclusions.
import { mdiAlertOctagonOutline, mdiAlertOutline, mdiCheckCircleOutline, mdiClockAlertOutline, mdiCloudOffOutline, mdiHelpCircleOutline, mdiLanDisconnect } from '@mdi/js';
import { cloudOf } from '@dormeto/fleet/clouds';
import { cloudWords, type CloudWords } from './cloud-words';
import { checkHealth, relative } from './format';
import { resourceName } from './google';
import type { AlarmInfo, ExclusionKind, ExclusionTarget, Pause, RouterInfo } from './types';

export function pauseLabel(pauses: Pause[] | undefined): 'excluded' | 'paused' | null {
  if (!pauses?.length) return null;
  return pauses.some((p) => p.exclusionId) ? 'excluded' : 'paused';
}

// Who paused, when, why and the automatic resume; `when` says a date (relative to now by default).
export function pauseLine(p: Pause, now = Date.now(), when = (iso: string) => relative(iso, now)): string {
  const who = p.exclusionId ? 'Excluded' : p.scope === 'router' ? 'Router paused' : 'Paused';
  const reason = p.exclusionId ? p.reason.replace(/^excluded: /, '') : p.reason;
  return [`${who} by ${p.by} ${when(p.at)}: ${reason}`, ...(p.until ? [`resumes ${when(p.until)}`] : []), ...(p.keepAsleep ? ['asleep workloads left asleep'] : [])].join('; ');
}

// The pauses in words for an export and a search (a table's Pause column): their dates as ISO 8601.
export const pausesText = (pauses: Pause[] | undefined): string => (pauses ?? []).map((p) => pauseLine(p, 0, (iso) => `at ${iso}`)).join(' · ');

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
const HEALTH_ICONS: Record<string, string> = { ok: mdiCheckCircleOutline, warning: mdiAlertOutline, error: mdiAlertOctagonOutline };
// A health status' or a problem level's icon.
export const healthIcon = (level: string): string => HEALTH_ICONS[level] ?? mdiHelpCircleOutline;

// A router's health as a mark (tables design §3): unreachable, its status, or none before router 0.16; its word is the label.
export function healthMark(r: Pick<RouterInfo, 'error' | 'health'>): { icon: string; color?: string; label: string } {
  if (r.error) return { icon: mdiLanDisconnect, color: 'error', label: 'unreachable' };
  if (r.health) return { icon: healthIcon(r.health.status), color: healthColor(r.health.status), label: r.health.status };
  return { icon: mdiHelpCircleOutline, label: 'no health report' };
}
// Why a router does not report, said where its health is.
export const NOT_REPORTING = 'the manager calls this router at each view: it does not send its state (a router older than 0.21, or without the manager\'s event bus).';

// A router's health in words for an export and a search (Routers' Health column): the status, each problem (its level when
// it is not the status'), the open alert and since when (ISO 8601), the error's text, not reporting.
export function healthText(r: Pick<RouterInfo, 'error' | 'health' | 'reporting'>, alarm?: Pick<AlarmInfo, 'level' | 'since'> | null): string {
  const health = r.health;
  const status = r.error
    ? `unreachable: ${r.error}`
    : health
      ? [health.status, health.problems.map((p) => (p.level === health.status ? p.text : `${p.text} (${p.level})`)).join('; ')].filter(Boolean).join(': ')
      : 'no health report: upgrade to 0.16 for health';
  return [status, ...(alarm ? [`alert since ${alarm.since}`] : []), ...(r.reporting === false && !r.error ? ['not reporting'] : [])].join(' · ');
}

// A router's count of workloads where no state has one to show: 0 for none, its count when only that is known; null while its
// states' counts say it.
export function workloadsCount(r: Pick<RouterInfo, 'workloads' | 'workloadStates'>): number | null {
  if (r.workloadStates && Object.keys(r.workloadStates).length) return null;
  return r.workloadStates ? 0 : r.workloads ?? null;
}

// A router's workloads in words (Routers' Workloads column): a count per state, or its count alone, then how many of them
// are paused (among those counts, not added to them).
export function workloadsText(r: Pick<RouterInfo, 'workloads' | 'workloadStates' | 'paused'>): string {
  const count = workloadsCount(r);
  const counts = count === null ? Object.entries(r.workloadStates ?? {}).map(([state, n]) => `${n} ${state.toLowerCase()}`).join(', ') : String(count);
  if (!r.paused) return counts;
  return counts ? `${counts}; ${r.paused} of them paused` : `${r.paused} paused`;
}

// A router's status for the Overview, as a mark (its icon; its word the mark's name): unreachable, its health, not reporting
// (a router known by its list answer only has no health: its schedule alone could say ok while its checks fail), a late
// check, or ok.
export function routerStatus(r: { error?: string; reporting?: boolean; health?: { status: string; problems: { level?: string; text: string }[] }; checkSchedule?: string | null; lastScheduledCheckAt?: string | null }, now = Date.now()): { color: string; icon: string; text: string; detail: string } {
  if (r.error) return { color: 'error', icon: mdiLanDisconnect, text: 'unreachable', detail: r.error };
  const check = checkHealth(r, now);
  if (r.health) return { color: healthColor(r.health.status), icon: healthIcon(r.health.status), text: r.health.status, detail: r.health.problems[0]?.text ?? check.text };
  if (r.reporting === false) return { color: 'warning', icon: mdiCloudOffOutline, text: 'not reporting', detail: 'no report from its idle checks for 3 periods of its schedule' };
  return check.late ? { color: 'warning', icon: mdiClockAlertOutline, text: 'idle check late', detail: check.text } : { color: 'success', icon: healthIcon('ok'), text: 'ok', detail: check.text };
}

export interface TargetOption {
  kind: ExclusionKind;
  arn?: string;
  path?: string; // Google Cloud's
  account?: string;
  label: string;
}

// A kind of exclusion target in its cloud's words: a target group or a backend service, a load balancer or a URL map, an account
// or a project.
const kindNoun = (kind: ExclusionKind, words: CloudWords): string => (kind === 'target-group' ? words.target : kind === 'load-balancer' ? words.loadBalancer : kind === 'resource' ? 'resource' : words.owner.toLowerCase());
export const capitalised = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

// What an operator can exclude from a discovery candidate (or a workload): its target group, load balancer, account. On Google
// Cloud: its backend service, its URL map (by their paths) and its project. A standalone candidate: its resource and account.
export function exclusionTargets(c: { targetGroupArn?: string | null; targetGroup?: string | null; loadBalancerArn?: string; loadBalancer?: string; account: string; accountName: string; id?: string; backendService?: string; urlMap?: string; kind?: string; resourceArn?: string; name?: string }): TargetOption[] {
  const words = cloudWords(cloudOf(c.account));
  const label = (kind: ExclusionKind, name: string, scope?: string) => `${capitalised(kindNoun(kind, words))} ${name}${scope ? ` (${scope})` : ''}`;
  const account = { kind: 'account' as const, account: c.account, label: label('account', c.accountName === c.account ? c.account : `${c.accountName}, ${c.account}`, 'never read again') };
  if (c.kind === 'standalone' && c.resourceArn) return [{ kind: 'resource' as const, arn: c.resourceArn, label: label('resource', c.name ?? c.resourceArn) }, account];
  if (cloudOf(c.account) === 'gcp') {
    const service = c.backendService ?? c.id;
    return [
      ...(service ? [{ kind: 'target-group' as const, path: service, label: label('target-group', c.targetGroup ?? resourceName(service)) }] : []),
      ...(c.urlMap ? [{ kind: 'load-balancer' as const, path: c.urlMap, label: label('load-balancer', c.loadBalancer || resourceName(c.urlMap), words.loadBalancerScope) }] : []),
      account,
    ];
  }
  return [
    ...(c.targetGroupArn ? [{ kind: 'target-group' as const, arn: c.targetGroupArn, label: label('target-group', c.targetGroup ?? c.targetGroupArn) }] : []),
    ...(c.loadBalancerArn?.startsWith('arn:') ? [{ kind: 'load-balancer' as const, arn: c.loadBalancerArn, label: label('load-balancer', c.loadBalancer ?? '', words.loadBalancerScope) }] : []),
    account,
  ];
}

export const exclusionText = (t: ExclusionTarget): string => [`${kindNoun(t.kind, cloudWords(cloudOf(t.account)))} ${t.name}`, t.account, ...(t.region ? [t.region] : [])].join(' · ');
