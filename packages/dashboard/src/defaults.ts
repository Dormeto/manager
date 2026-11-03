// A level's defaults (vision settings at scale design §6, §9): the organization's, a router's or a type's. Each key a value
// or absent (the level below decides); the built-in values at the bottom.
import { SETTING_KEYS, settingLabel, settingText, type SettingsForm } from './settings';
import type { Settings } from './types';

export interface Defaults extends Partial<Settings> { wakeMode?: string; noWakeRules?: unknown[]; wakeRules?: unknown[] }
export const BUILT_IN: Required<Pick<Defaults, keyof Settings | 'wakeMode'>> = {
  idleMinutes: 15, waitSeconds: 60, drainSeconds: 30, wakeTimeoutSeconds: 600, maxHolders: 50, failedRetrySeconds: 60, wakeMode: 'any',
};
export const BUILT_IN_TYPES = ['instance', 'asg', 'ecs', 'k8s', 'databases'];
export const TYPE_LABELS: Record<string, string> = { instance: 'EC2 instance', asg: 'Auto Scaling group', ecs: 'ECS service', k8s: 'Kubernetes', databases: 'With databases' };

const modeText = (mode: string) => (mode === 'browser' ? 'browser' : 'any request');
const rulesText = (rules: unknown[]) => `${rules.length} rule${rules.length === 1 ? '' : 's'}`;

// What a level sets, one line each, in the order of the settings.
export function defaultsLines(d: Defaults | null | undefined): { key: string; label: string; value: string }[] {
  if (!d) return [];
  return [
    ...SETTING_KEYS.filter((key) => typeof d[key] === 'number').map((key) => ({ key, label: settingLabel(key), value: settingText(key, d[key] as number) })),
    ...(d.wakeMode ? [{ key: 'wakeMode', label: 'Wake mode', value: modeText(d.wakeMode) }] : []),
    ...(d.noWakeRules?.length ? [{ key: 'noWakeRules', label: 'No-wake rules', value: rulesText(d.noWakeRules) }] : []),
    ...(d.wakeRules?.length ? [{ key: 'wakeRules', label: 'Wake rules', value: rulesText(d.wakeRules) }] : []),
  ];
}

// What a key gets from the built-in values, said as a field says it.
export const builtInText = (key: keyof Settings | 'wakeMode') => (key === 'wakeMode' ? modeText(BUILT_IN.wakeMode) : settingText(key, BUILT_IN[key]));
// A value of a level, said the same way.
export const levelText = (key: keyof Settings | 'wakeMode', value: number | string) => (key === 'wakeMode' ? modeText(String(value)) : settingText(key, Number(value)));

// The dialog's form of a level: its own values, the others empty; its rules as JSON.
export function defaultsFormOf(d: Defaults): SettingsForm {
  const own = (key: keyof Settings) => (typeof d[key] === 'number' ? d[key] as number : null);
  const json = (rules?: unknown[]) => (rules?.length ? JSON.stringify(rules, null, 2) : '[]');
  return {
    idleMinutes: own('idleMinutes'), waitSeconds: own('waitSeconds'), drainSeconds: own('drainSeconds'), wakeTimeoutSeconds: own('wakeTimeoutSeconds'),
    maxHolders: own('maxHolders'), failedRetrySeconds: own('failedRetrySeconds'), wakeMode: d.wakeMode ?? null, type: null,
    noWakeRules: json(d.noWakeRules), wakeRules: json(d.wakeRules),
  };
}
