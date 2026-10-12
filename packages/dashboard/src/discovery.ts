// Organization discovery in the dashboard: statuses, run targets, and criterion editing (dimension values as text).
import type { BackendKind, Criterion, LintFinding, RuleRef, RunTarget, Status } from '@dormeto/discovery/types';
import { percent } from './format';

export const STATUSES: Status[] = ['pending-onboarding', 'pending-offboarding', 'managed', 'ineligible', 'dismissed', 'excluded', 'out-of-scope', 'gone'];

// What each status means, the actions that leave it (operators; the perimeter: administrators) and what changes it by
// itself at the next discovery run.
interface StatusMeta {
  label: string;
  color: string;
  help: string;
  transitions: { action: string; to: string }[];
  changes?: string;
}
const META: Record<Status, StatusMeta> = {
  'pending-onboarding': {
    label: 'To onboard', color: 'primary', help: 'Eligible and in the perimeter, not onboarded yet: Dormeto can nap it once onboarded.',
    transitions: [{ action: 'Onboard', to: 'Managed' }, { action: 'Dismiss', to: 'Dismissed' }, { action: 'Exclude', to: 'Excluded' }],
    changes: 'Ineligible, Out of scope or Gone when its rules, the perimeter or its load balancer change.',
  },
  'pending-offboarding': {
    label: 'To offboard', color: 'warning', help: 'Onboarded, but out of the perimeter, excluded or no longer eligible (see the reason).',
    transitions: [{ action: 'Offboard', to: 'Out of scope, Excluded or Ineligible' }, { action: 'Include it again (Perimeter)', to: 'Managed' }],
    changes: 'Managed again when its rule is eligible and in the perimeter.',
  },
  managed: {
    label: 'Managed', color: 'success', help: 'Onboarded: Dormeto naps it when idle.',
    transitions: [{ action: 'Offboard', to: 'To onboard' }, { action: 'Exclude', to: 'To offboard, kept awake until offboarded' }],
    changes: 'To offboard when it leaves the perimeter or is no longer eligible; Gone when its rule is deleted.',
  },
  ineligible: {
    label: 'Ineligible', color: 'grey', help: 'In the perimeter, but Dormeto cannot nap it (see the reason).',
    transitions: [{ action: 'Dismiss', to: 'Dismissed' }, { action: 'Exclude', to: 'Excluded' }],
    changes: 'To onboard at the next discovery run once its reason is fixed.',
  },
  dismissed: {
    label: 'Dismissed', color: 'grey', help: 'An operator chose not to onboard it, whatever later runs find.',
    transitions: [{ action: 'Restore', to: 'its status again' }],
  },
  excluded: {
    label: 'Excluded', color: 'error', help: 'Kept away by an exclusion, a global exclude or a filter exclude.',
    transitions: [{ action: 'Lift the exclusion (Exclusions)', to: 'its status again' }, { action: 'Remove the exclude (Perimeter)', to: 'its status again' }],
  },
  'out-of-scope': {
    label: 'Out of scope', color: 'grey', help: 'No filter of the perimeter includes it.',
    transitions: [{ action: 'Include it (Perimeter)', to: 'To onboard or Ineligible' }],
  },
  gone: {
    label: 'Gone', color: 'grey', help: 'Not found in the last scan of its account and region.',
    transitions: [],
    changes: 'Back to its status if a scan finds it again; a managed workload is offboarded from its workload view.',
  },
};

export const statusLabel = (s: Status): string => META[s]?.label ?? s;
export const statusColor = (s: Status): string => META[s]?.color ?? 'grey';
export const statusHelp = (s: Status): string => META[s]?.help ?? '';
export const statusTransitions = (s: Status): { action: string; to: string }[] => META[s]?.transitions ?? [];
export const statusChanges = (s: Status): string | null => META[s]?.changes ?? null;

export function targetText(t: RunTarget): string {
  const where = `${t.account} · ${t.region === '*' ? 'all regions' : t.region}`;
  if (t.status === 'ok') return `${where}: ${t.rules ?? 0} rule${t.rules === 1 ? '' : 's'} in ${((t.ms ?? 0) / 1000).toFixed(1)} s`;
  return `${where}: ${t.status === 'error' ? t.error : t.reason}`;
}

export const idleShare = (c: { idleHours7d: number | null }): string | null => (c.idleHours7d === null ? null : percent(c.idleHours7d, 168));

// The idle share in words: hours of the last 7 days (168) without any request to the target group.
export function idleText(c: { idleHours7d: number; requests7d: number | null }): { title: string; detail: string } {
  const requests = !c.requests7d ? 'no request' : `${c.requests7d.toLocaleString('en-US')} request${c.requests7d === 1 ? '' : 's'}`;
  return {
    title: `Idle ${percent(c.idleHours7d, 168)} of the last 7 days`,
    detail: `${c.idleHours7d} of 168 hours without any request to its target group (${requests} in 7 days).`,
  };
}

// From red (always busy) through amber to green (always idle: the most to save).
export const idleColor = (idleHours7d: number): string => `hsl(${Math.round((120 * Math.min(Math.max(idleHours7d, 0), 168)) / 168)} 70% 42%)`;

export type DimensionKey = Exclude<keyof Criterion, 'note'>;
export const BACKEND_KINDS: BackendKind[] = ['instance', 'asg', 'ecs'];

export const DIMENSIONS: { key: DimensionKey; label: string; kind: 'list' | 'tags'; hint: string }[] = [
  { key: 'accountIds', label: 'Accounts', kind: 'list', hint: '12-digit account IDs' },
  { key: 'ouIds', label: 'OUs', kind: 'list', hint: 'ou-… or the root r-…, sub-OUs included' },
  { key: 'accountTags', label: 'Account tags', kind: 'tags', hint: 'key=value, key= for any value' },
  { key: 'regions', label: 'Regions', kind: 'list', hint: 'for example eu-west-1' },
  { key: 'loadBalancers', label: 'Load balancers', kind: 'list', hint: 'names with *, or ARNs' },
  { key: 'hosts', label: 'Hosts', kind: 'list', hint: 'host names with *, for example *.example.com' },
  { key: 'resourceTags', label: 'Resource tags', kind: 'tags', hint: 'tags of the load balancer, rule or target group: key=value' },
  { key: 'backendKinds', label: 'Backend types', kind: 'list', hint: 'instance, asg, ecs' },
];

export const dimensionOf = (key: DimensionKey) => DIMENSIONS.find((d) => d.key === key)!;

export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))];
}

export const formatList = (values: string[] | undefined): string => (values ?? []).join(', ');

export function parseTags(text: string): Record<string, string[]> {
  const tags: Record<string, string[]> = {};
  for (const part of text.split(/[,\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    const key = (at < 0 ? part : part.slice(0, at)).trim();
    const value = at < 0 ? '' : part.slice(at + 1).trim();
    if (!key) continue;
    tags[key] ??= [];
    if (value && !tags[key].includes(value)) tags[key].push(value);
  }
  return tags;
}

export const formatTags = (tags: Record<string, string[]> | undefined): string =>
  Object.entries(tags ?? {}).flatMap(([k, values]) => (values.length ? values.map((v) => `${k}=${v}`) : [`${k}=`])).join(', ');

export const formatDimension = (c: Criterion, key: DimensionKey): string =>
  (dimensionOf(key).kind === 'tags' ? formatTags(c[key] as Record<string, string[]> | undefined) : formatList(c[key] as string[] | undefined));

export function setDimension(c: Criterion, key: DimensionKey, text: string): Criterion {
  if (dimensionOf(key).kind === 'tags') return { ...c, [key]: parseTags(text) };
  const values = parseList(text);
  return { ...c, [key]: key === 'backendKinds' ? values.filter((v): v is BackendKind => (BACKEND_KINDS as string[]).includes(v)) : values };
}

export function removeDimension(c: Criterion, key: DimensionKey): Criterion {
  const { [key]: _, ...rest } = c;
  return rest;
}

export const usedDimensions = (c: Criterion): DimensionKey[] => DIMENSIONS.map((d) => d.key).filter((k) => c[k] !== undefined);
export const availableDimensions = (c: Criterion): DimensionKey[] => DIMENSIONS.map((d) => d.key).filter((k) => c[k] === undefined);

// Lint findings about one include criterion of a filter.
export const lintFor = (findings: LintFinding[], filter: string, include: number) => findings.filter((f) => f.filter === filter && f.include === include);

// The rules of a candidate, one line each, by priority.
export const ruleLines = (rules: RuleRef[]): string[] => rules.map((r) => `priority ${r.priority} · ${r.listener} · ${r.conditions}`);
