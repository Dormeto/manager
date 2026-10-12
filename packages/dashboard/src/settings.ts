// Workload settings as shown on the workload view: value, what it changes, and the range it must stay in.
import { duration } from './format';
import type { Settings } from './types';

export interface SettingRow {
  key: keyof Settings;
  label: string;
  value: string;
  help: string;
  range: string;
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
};

const ORDER: (keyof Settings)[] = ['idleMinutes', 'waitSeconds', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders'];

export const settingRows = (settings: Settings): SettingRow[] => ORDER.map((key) => {
  const d = DESCRIPTIONS[key];
  return { key, label: d.label, value: d.format(settings[key]), help: d.help, range: d.range };
});
