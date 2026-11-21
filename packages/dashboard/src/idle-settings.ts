// A standalone workload's idle signals and settings in words (vision standalone workloads design §4; the router's
// settings-levels.mjs ranges): the idle window, the wake timeout, CPU, network bytes, a custom CloudWatch metric, or off.
import { duration } from './format';
import { IDLE_KEYS as IDLE_SIGNAL_KEYS } from '@dormeto/fleet/idle-signals';
import type { IdleMetric, IdleSettings, IdleSignal, Settings, SettingsFrom } from './types';

export type StandaloneKey = 'idleMinutes' | 'wakeTimeoutSeconds' | keyof IdleSettings;
export const STANDALONE_KEYS: StandaloneKey[] = ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
export const IDLE_KEYS = IDLE_SIGNAL_KEYS as (keyof IdleSettings)[];
// The waker's settings, an HTTP workload's only.
export const WAKER_KEYS = ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules'];
export const IDLE_NETWORK_BYTES_MAX = 10_000_000_000;
export const IDLE_METRIC_STATISTICS = ['Maximum', 'Average', 'Sum'] as const;

// A signal's name: "CPU", "Network", the custom metric's own name.
export function signalName(signal: IdleSignal['signal'], metric?: IdleMetric | 'off'): string {
  if (signal === 'cpu') return 'CPU';
  if (signal === 'network') return 'Network';
  return metric && metric !== 'off' ? metric.name : 'Custom metric';
}
const number = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
// A value of a signal, in its unit.
export function signalValue(signal: IdleSignal['signal'], v: number | null): string {
  if (v === null) return '—';
  return signal === 'cpu' ? `${number(v)} %` : signal === 'network' ? `${number(v)} bytes a minute` : number(v);
}
// A signal's threshold: under it is idle; off, it does not apply.
export const thresholdText = (signal: IdleSignal['signal'], below: number | null | 'off'): string => (below === null || below === 'off' ? 'off' : `under ${signalValue(signal, below)}`);

export interface StandaloneRow { key: StandaloneKey; label: string; value: string; help: string; range: string; from?: string }

const HELP: Record<StandaloneKey, { label: string; help: string; range: string }> = {
  idleMinutes: { label: 'Idle window', help: 'Time with every idle signal under its threshold before the workload naps; the check reads them every 5 minutes, and an idle nap comes up to 15 minutes after the window, as CloudWatch publishes the signals late. Nothing wakes it on demand: a schedule, a person or a start made in AWS does.', range: '5 to 1,440 min; built-in 120 min.' },
  wakeTimeoutSeconds: { label: 'Wake timeout', help: 'Longest a wake may take before the workload is marked FAILED; the check retries it.', range: '60 to 3,600 s; built-in 10 min, 30 min for a database.' },
  idleCpuPercent: { label: 'CPU', help: 'Idle while the CPU\'s maximum stays under this percentage (CloudWatch\'s CPUUtilization of the instance, group, service or database).', range: '0 to 100, or off; built-in 5, off for a database.' },
  idleNetworkBytes: { label: 'Network', help: 'Idle while the bytes in and out, a minute, stay under this number (EC2\'s NetworkIn and NetworkOut, RDS\'s throughput); an ECS service has none without Container Insights.', range: '0 to 10,000,000,000, or off; built-in off.' },
  idleMetric: { label: 'Custom metric', help: 'Idle while one CloudWatch metric stays under its threshold; ${resource} in a dimension is the resource\'s own id. A database\'s built-in: its connections under 1.', range: 'A metric and a threshold, or off; built-in off.' },
};
export const standaloneLabel = (key: StandaloneKey) => HELP[key].label;
export const standaloneHelp = (key: StandaloneKey) => `${HELP[key].help} ${HELP[key].range}`;

export function metricText(m: IdleMetric | 'off' | undefined): string {
  if (!m || m === 'off') return 'off';
  return `${m.name} under ${number(m.below)} (${m.statistic})`;
}
export function standaloneValue(key: StandaloneKey, settings: Partial<Settings & IdleSettings>): string | null {
  const v = settings[key];
  if (v === undefined) return null;
  if (key === 'idleMinutes') return `${v} min`;
  if (key === 'wakeTimeoutSeconds') return duration(v as number);
  if (key === 'idleCpuPercent') return thresholdText('cpu', v as number | 'off');
  if (key === 'idleNetworkBytes') return thresholdText('network', v as number | 'off');
  return metricText(v as IdleMetric | 'off');
}

// Each setting of a standalone workload the router gives, with the level it comes from.
export const standaloneSettingRows = (settings: Partial<Settings & IdleSettings>, from?: SettingsFrom): StandaloneRow[] => STANDALONE_KEYS.flatMap((key) => {
  const value = standaloneValue(key, settings);
  return value === null ? [] : [{ key, label: HELP[key].label, value, help: HELP[key].help, range: HELP[key].range, ...(from?.[key] ? { from: from[key] } : {}) }];
});

// The dialogs' form of the idle signals: each number as typed (empty: inherit) with its Off; the metric inherited, off or one.
export interface MetricForm { namespace: string; name: string; dimensions: { name: string; value: string }[]; statistic: IdleMetric['statistic']; below: string }
export interface IdleForm { idleCpuPercent: string; cpuOff: boolean; idleNetworkBytes: string; networkOff: boolean; metricMode: 'inherit' | 'off' | 'metric'; metric: MetricForm }
const EMPTY_METRIC: MetricForm = { namespace: '', name: '', dimensions: [], statistic: 'Maximum', below: '' };

// A level's own values (or a workload's: `own` says which keys are its own), the others empty.
export function idleFormOf(values: Partial<IdleSettings>, own: (key: keyof IdleSettings) => boolean = (key) => values[key] !== undefined): IdleForm {
  const mine = (key: keyof IdleSettings) => (own(key) ? values[key] : undefined);
  const cpu = mine('idleCpuPercent');
  const network = mine('idleNetworkBytes');
  const metric = mine('idleMetric') as IdleMetric | 'off' | undefined;
  return {
    idleCpuPercent: typeof cpu === 'number' ? String(cpu) : '', cpuOff: cpu === 'off',
    idleNetworkBytes: typeof network === 'number' ? String(network) : '', networkOff: network === 'off',
    metricMode: metric === 'off' ? 'off' : metric ? 'metric' : 'inherit',
    metric: metric && metric !== 'off' && !Array.isArray(metric.dimensions)
      ? { namespace: metric.namespace, name: metric.name, dimensions: Object.entries(metric.dimensions).map(([name, value]) => ({ name, value: String(value) })), statistic: metric.statistic, below: String(metric.below) }
      : { ...EMPTY_METRIC, dimensions: [] },
  };
}

const numberOf = (text: string) => (text.trim() === '' ? null : Number(text));
function valueOf(form: IdleForm, key: keyof IdleSettings): { value: number | 'off' | IdleMetric | null; problem?: string } {
  if (key === 'idleCpuPercent') {
    if (form.cpuOff) return { value: 'off' };
    const v = numberOf(form.idleCpuPercent);
    return v === null || (Number.isFinite(v) && v >= 0 && v <= 100) ? { value: v } : { value: null, problem: 'CPU: a number from 0 to 100, or off' };
  }
  if (key === 'idleNetworkBytes') {
    if (form.networkOff) return { value: 'off' };
    const v = numberOf(form.idleNetworkBytes);
    return v === null || (Number.isInteger(v) && v >= 0 && v <= IDLE_NETWORK_BYTES_MAX) ? { value: v } : { value: null, problem: `Network: a whole number from 0 to ${IDLE_NETWORK_BYTES_MAX.toLocaleString('en-US')}, or off` };
  }
  if (form.metricMode === 'inherit') return { value: null };
  if (form.metricMode === 'off') return { value: 'off' };
  const m = form.metric;
  const below = numberOf(m.below);
  if (!m.namespace.trim() || !m.name.trim() || below === null || !Number.isFinite(below)) return { value: null, problem: 'Custom metric: its namespace, name and threshold are needed' };
  const dimensions = Object.fromEntries(m.dimensions.filter((d) => d.name.trim()).map((d) => [d.name.trim(), d.value]));
  return { value: { namespace: m.namespace.trim(), name: m.name.trim(), dimensions, statistic: m.statistic, below } };
}

// What changed: each key a value, 'off', or null where the value went back to the levels; the first problem found.
export function idleChanges(initial: IdleForm, edited: IdleForm): { changes: Record<string, unknown>; problem: string | null } {
  const changes: Record<string, unknown> = {};
  for (const key of IDLE_KEYS) {
    const before = valueOf(initial, key).value;
    const after = valueOf(edited, key);
    if (after.problem) return { changes, problem: after.problem };
    if (JSON.stringify(after.value) !== JSON.stringify(before)) changes[key] = after.value;
  }
  return { changes, problem: null };
}

// The built-in values, as the levels' placeholders say them (the router's STANDALONE_BUILT_IN).
export const IDLE_BUILT_IN: Record<keyof IdleSettings, string> = { idleCpuPercent: 'under 5 %, off for a database', idleNetworkBytes: 'off', idleMetric: 'off; a database\'s connections under 1' };
