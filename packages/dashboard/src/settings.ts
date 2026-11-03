// Workload settings as shown on the workload view: value, what it changes, and the range it must stay in.
import { duration } from './format';
import type { Rule, Settings, SettingsFrom, WorkloadStatus, WorkloadType } from './types';

export interface SettingRow {
  key: keyof Settings;
  label: string;
  value: string;
  help: string;
  range: string;
  from?: string; // the level it comes from (routers 0.37.0)
}

const DESCRIPTIONS: Record<keyof Settings, { label: string; format: (v: number) => string; help: string; range: string }> = {
  idleMinutes: {
    label: 'Idle window',
    format: (v) => `${v} min`,
    help: 'Time without any request before the workload naps. The idle check runs every 5 minutes, so a nap starts between this window and 5 minutes later. Shorter saves more but wakes more often, and each wake makes its first visitor wait.',
    range: 'At least 5 min (the check period). Recommended: 15 to 60 min.',
  },
  waitSeconds: {
    label: 'Hold',
    format: (v) => `${v} s`,
    help: 'How long the waker holds a request while the workload wakes. A wake that ends within it sends the visitor straight to the application; otherwise the visitor gets the waiting page, which reloads by itself. 0 sends the waiting page at once.',
    range: 'From 0 to the waker Lambda timeout minus 5 s, and below the load balancer idle timeout (else the load balancer answers 504). Recommended: the usual wake time plus 15 s.',
  },
  drainSeconds: {
    label: 'Drain',
    format: (v) => `${v} s`,
    help: 'Wait between the switch of the load balancer rule to the waker and the stop of the backends. It covers the rule propagation and the requests in flight; a request during the drain cancels the nap.',
    range: 'Longer than the rule propagation (about 12 s measured): at least 20 s. Recommended: 30 s.',
  },
  wakeTimeoutSeconds: {
    label: 'Wake timeout',
    format: (v) => duration(v),
    help: 'Longest a wake may take before the workload is marked FAILED; the next request then retries the wake. Wakes continue across Lambda invocations, so long starts such as databases are supported.',
    range: 'Longer than the slowest start of the backends: about 1 min for instances, Auto Scaling groups and Fargate; 30 min with an RDS or Aurora database (6 to 14 min measured).',
  },
  maxHolders: {
    label: 'Held requests',
    format: (v) => `≤ ${v}`,
    help: 'Most requests held at the same time. Each one keeps a waker Lambda running for up to the hold time; beyond this number, visitors get the waiting page at once.',
    range: 'From 1 to a share of the account Lambda concurrency quota, which all workloads share. Recommended: 50.',
  },
  failedRetrySeconds: {
    label: 'Retry after a failed wake',
    format: (v) => `${v} s`,
    help: 'After a failed wake, how long requests wait before they try again; the wait doubles after each failure in a row, at most 30 minutes. A wake from the manager does not wait.',
    range: 'From 10 to 600 s. Recommended: 60 s.',
  },
};

const ORDER: (keyof Settings)[] = ['idleMinutes', 'waitSeconds', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders', 'failedRetrySeconds'];
export const SETTING_KEYS = ORDER;
// A setting's name and a value of it, as the cards say them.
export const settingLabel = (key: keyof Settings): string => DESCRIPTIONS[key].label;
export const settingText = (key: keyof Settings, value: number): string => DESCRIPTIONS[key].format(value);
export const settingHelp = (key: keyof Settings): string => `${DESCRIPTIONS[key].help} ${DESCRIPTIONS[key].range}`;

// Each setting the router gives (an older one gives no retry), with the level it comes from when it says so.
export const settingRows = (settings: Settings, from?: SettingsFrom): SettingRow[] => ORDER.filter((key) => typeof settings[key] === 'number').map((key) => {
  const d = DESCRIPTIONS[key];
  return { key, label: d.label, value: d.format(settings[key] as number), help: d.help, range: d.range, ...(from?.[key] ? { from: from[key] } : {}) };
});

// Where a setting comes from, in a few words (settings at scale design §9); nothing from an older router.
export function sourceText(from: string | undefined, type?: Partial<WorkloadType>): string {
  switch (from) {
    case 'workload': return 'set on this workload';
    case 'type': return `type ${type?.name ?? ''}`.trim();
    case 'router': return 'router';
    case 'organization': return 'organization';
    case 'default': return 'built-in';
    default: return '';
  }
}

const TYPE_FROM: Record<string, string> = { workload: 'set on this workload', tags: 'from its tags', backends: 'from its backends' };
// A workload's type and why: its own, its tags or its backends; a type it named that is gone.
export function typeText(type: WorkloadType): string {
  if (!type.name) return type.missing ? `none (its type ${type.missing} no longer exists)` : 'none';
  return `${type.name}, ${TYPE_FROM[type.from ?? ''] ?? ''}${type.missing ? ` (its type ${type.missing} no longer exists)` : ''}`;
}

// The settings dialog's form: each setting the workload's own value or null (inherited), its wake mode and type alike,
// its own rules as JSON.
export interface SettingsForm {
  idleMinutes: number | null; waitSeconds: number | null; drainSeconds: number | null; wakeTimeoutSeconds: number | null; maxHolders: number | null;
  failedRetrySeconds: number | null; wakeMode: string | null; type: string | null; noWakeRules: string; wakeRules: string;
}

// A rule as the router takes it, from its description.
const ruleOf = (rule: Rule) => ({ name: rule.name, ...rule.conditions });
const rulesJson = (rules: Rule[]) => (rules.length ? JSON.stringify(rules.map(ruleOf), null, 2) : '[]');

export function formOf(status: Pick<WorkloadStatus, 'settings' | 'wakeMode' | 'settingsFrom' | 'type' | 'noWakeRules' | 'wakeRules'>): SettingsForm {
  const own = (key: keyof Settings) => (status.settingsFrom?.[key] === 'workload' ? (status.settings[key] ?? null) : null);
  return {
    idleMinutes: own('idleMinutes'), waitSeconds: own('waitSeconds'), drainSeconds: own('drainSeconds'), wakeTimeoutSeconds: own('wakeTimeoutSeconds'),
    maxHolders: own('maxHolders'), failedRetrySeconds: own('failedRetrySeconds'),
    wakeMode: status.settingsFrom?.wakeMode === 'workload' ? status.wakeMode : null,
    // A type it named that no longer exists is still stored: Inherit then clears it (review, 2026-11-04).
    type: status.type?.from === 'workload' ? status.type.name : status.type?.missing ?? null,
    noWakeRules: rulesJson(status.noWakeRules.filter((r) => r.level === 'workload')),
    wakeRules: rulesJson(status.wakeRules.filter((r) => r.from === 'workload')),
  };
}

const RULE_LABELS = { noWakeRules: 'No-wake rules', wakeRules: 'Wake rules' } as const;
// What the dialog sends: each key changed, null where an own value went back to the levels; the rules parsed (an empty
// text or an empty list is none).
export function settingsChanges(initial: SettingsForm, edited: SettingsForm): { changes: Record<string, unknown>; problem: string | null } {
  const changes: Record<string, unknown> = {};
  const value = (v: unknown) => (v === '' || v === null || v === undefined ? null : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  for (const key of [...ORDER, 'wakeMode', 'type'] as const) {
    const next = value(edited[key]);
    if (next !== value(initial[key])) changes[key] = next;
  }
  for (const key of ['noWakeRules', 'wakeRules'] as const) {
    const text = edited[key].trim();
    if (text === initial[key].trim()) continue;
    if (!text) {
      changes[key] = null;
      continue;
    }
    let rules: unknown;
    try {
      rules = JSON.parse(text);
    } catch (err) {
      return { changes, problem: `${RULE_LABELS[key]}: ${(err as Error).message}` };
    }
    if (!Array.isArray(rules)) return { changes, problem: `${RULE_LABELS[key]}: a JSON list of rules` };
    changes[key] = rules.length ? rules : null;
  }
  return { changes, problem: null };
}
