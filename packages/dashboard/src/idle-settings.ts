// A standalone workload's idle signals and settings in words (vision standalone workloads design §4; the router's
// settings-levels.mjs ranges): the idle window, the wake timeout, CPU, network bytes, a custom metric (CloudWatch's or Cloud Monitoring's), or off; their words by cloud in cloud-words.ts.
import { duration } from './format';
import { IDLE_KEYS as IDLE_SIGNAL_KEYS } from '@dormeto/fleet/idle-signals';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from './cloud-words';
import { isGoogleMetric, type AwsIdleMetric, type GoogleIdleMetric, type IdleMetric, type IdleSettings, type IdleSignal, type Settings, type SettingsFrom } from './types';

export type StandaloneKey = 'idleMinutes' | 'wakeTimeoutSeconds' | keyof IdleSettings;
export const STANDALONE_KEYS: StandaloneKey[] = ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
export const IDLE_KEYS = IDLE_SIGNAL_KEYS as (keyof IdleSettings)[];
// The waker's settings, an HTTP workload's only.
export const WAKER_KEYS = ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules'];
export const IDLE_NETWORK_BYTES_MAX = 10_000_000_000;
export const IDLE_METRIC_STATISTICS = ['Maximum', 'Average', 'Sum'] as const;
// Google Cloud's (the router's and the API's IDLE_METRIC_ALIGNERS).
export const IDLE_METRIC_ALIGNERS = ['ALIGN_MAX', 'ALIGN_MEAN', 'ALIGN_SUM'] as const;
// A metric's name: AWS's own, a Google Cloud type's last two parts (custom.googleapis.com/queue/depth: queue/depth).
const metricName = (m: IdleMetric) => (isGoogleMetric(m) ? m.type.split('/').slice(1).slice(-2).join('/') : m.name);

// A signal's name: "CPU", "Network", the custom metric's own name.
export function signalName(signal: IdleSignal['signal'], metric?: IdleMetric | 'off'): string {
  if (signal === 'cpu') return 'CPU';
  if (signal === 'network') return 'Network';
  return metric && metric !== 'off' ? metricName(metric) : 'Custom metric';
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

// The labels; the helps and ranges are the cloud's (cloud-words.ts), but the idle window's, CPU's, network's and the metric's ranges.
const LABELS: Record<StandaloneKey, { label: string; range?: string }> = {
  idleMinutes: { label: 'Idle window', range: '5 to 1,440 min; built-in 120 min.' },
  wakeTimeoutSeconds: { label: 'Wake timeout' },
  idleCpuPercent: { label: 'CPU', range: '0 to 100, or off;' },
  idleNetworkBytes: { label: 'Network', range: '0 to 10,000,000,000, or off; built-in off.' },
  idleMetric: { label: 'Custom metric', range: 'A metric and a threshold, or off; built-in off.' },
};
const helpOf = (key: StandaloneKey, cloud?: Cloud | null) => {
  const words = cloudWords(cloud).standalone;
  const range = key === 'wakeTimeoutSeconds' ? words.ranges.wakeTimeoutSeconds : key === 'idleCpuPercent' ? `${LABELS[key].range} built-in 5, off for ${words.database}.` : LABELS[key].range!;
  return { label: LABELS[key].label, help: words.help[key], range };
};
export const standaloneLabel = (key: StandaloneKey) => LABELS[key].label;
export const standaloneHelp = (key: StandaloneKey, cloud?: Cloud | null) => { const h = helpOf(key, cloud); return `${h.help} ${h.range}`; };

export function metricText(m: IdleMetric | 'off' | undefined): string {
  if (!m || m === 'off') return 'off';
  return `${metricName(m)} under ${number(m.below)} (${isGoogleMetric(m) ? m.aligner : m.statistic})`;
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
export const standaloneSettingRows = (settings: Partial<Settings & IdleSettings>, from?: SettingsFrom, cloud?: Cloud | null): StandaloneRow[] => STANDALONE_KEYS.flatMap((key) => {
  const value = standaloneValue(key, settings);
  const h = helpOf(key, cloud);
  return value === null ? [] : [{ key, label: h.label, value, help: h.help, range: h.range, ...(from?.[key] ? { from: from[key] } : {}) }];
});

// The dialogs' form of the idle signals: each number as typed (empty: inherit) with its Off; the metric inherited, off or one, in
// its cloud's shape (`metricCloud`: AWS's fields or Google Cloud's, absent: AWS's), each shape's fields kept while the other is
// shown; Google Cloud's (`gcp`) present once that shape is held or shown (the fields add it).
export interface MetricForm { namespace: string; name: string; dimensions: { name: string; value: string }[]; statistic: AwsIdleMetric['statistic']; below: string }
export interface GoogleMetricForm { type: string; filter: string; aligner: GoogleIdleMetric['aligner']; below: string }
export interface IdleForm {
  idleCpuPercent: string; cpuOff: boolean; idleNetworkBytes: string; networkOff: boolean; metricMode: 'inherit' | 'off' | 'metric';
  metricCloud?: Cloud; metric: MetricForm; gcp?: GoogleMetricForm;
}
const EMPTY_METRIC: MetricForm = { namespace: '', name: '', dimensions: [], statistic: 'Maximum', below: '' };
export const EMPTY_GOOGLE: GoogleMetricForm = { type: '', filter: '', aligner: 'ALIGN_MAX', below: '' };

// A level's own values (or a workload's: `own` says which keys are its own), the others empty; `cloud`, the metric's cloud when
// it holds none (Google Cloud's level or workload).
export function idleFormOf(values: Partial<IdleSettings>, own: (key: keyof IdleSettings) => boolean = (key) => values[key] !== undefined, cloud?: Cloud): IdleForm {
  const mine = (key: keyof IdleSettings) => (own(key) ? values[key] : undefined);
  const cpu = mine('idleCpuPercent');
  const network = mine('idleNetworkBytes');
  const metric = mine('idleMetric') as IdleMetric | 'off' | undefined;
  const one = metric && metric !== 'off' ? metric : null;
  return {
    idleCpuPercent: typeof cpu === 'number' ? String(cpu) : '', cpuOff: cpu === 'off',
    idleNetworkBytes: typeof network === 'number' ? String(network) : '', networkOff: network === 'off',
    metricMode: metric === 'off' ? 'off' : metric ? 'metric' : 'inherit',
    ...((one ? (isGoogleMetric(one) ? 'gcp' : 'aws') : cloud) === 'gcp' ? { metricCloud: 'gcp' as const } : {}),
    metric: one && !isGoogleMetric(one) && !Array.isArray(one.dimensions)
      ? { namespace: one.namespace, name: one.name, dimensions: Object.entries(one.dimensions).map(([name, value]) => ({ name, value: String(value) })), statistic: one.statistic, below: String(one.below) }
      : { ...EMPTY_METRIC, dimensions: [] },
    ...(one && isGoogleMetric(one) ? { gcp: { type: one.type, filter: one.filter ?? '', aligner: one.aligner, below: String(one.below) } } : cloud === 'gcp' ? { gcp: { ...EMPTY_GOOGLE } } : {}),
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
  if (form.metricCloud === 'gcp') {
    const g = form.gcp ?? EMPTY_GOOGLE;
    const below = numberOf(g.below);
    if (!g.type.trim() || below === null || !Number.isFinite(below)) return { value: null, problem: 'Custom metric: its type and threshold are needed' };
    return { value: { type: g.type.trim(), ...(g.filter.trim() ? { filter: g.filter.trim() } : {}), aligner: g.aligner, below } };
  }
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

// The built-in values, as the levels' placeholders say them (the router's STANDALONE_BUILT_IN), in the cloud's words.
export const IDLE_BUILT_IN_OF = (cloud?: Cloud | null): Record<keyof IdleSettings, string> => ({ ...cloudWords(cloud).standalone.builtIn });
export const IDLE_BUILT_IN = IDLE_BUILT_IN_OF('aws');
