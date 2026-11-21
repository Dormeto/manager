// The levels' settings (vision settings at scale design §4, §5), checked before a write in the router's words: the
// organization's defaults and types, a router's defaults and a workload's settings. The router checks them again and
// keeps the last word (router lambda/src/lib/settings-levels.mjs and no-wake.mjs).
import { isIP } from 'node:net';
import type { Cloud } from '@dormeto/fleet/clouds';

export const SETTING_RANGES: Record<string, [number, number]> = {
  idleMinutes: [5, 1440], waitSeconds: [5, 120], drainSeconds: [0, 300], wakeTimeoutSeconds: [60, 3600], maxHolders: [1, 500], failedRetrySeconds: [10, 600],
};
// A Google Cloud router's and workload's (router gcp/src/levels.mjs levelProblems): the wake timeout at most 1700 s (one
// controller request lasts at most 1800 s); the hold, the drain and the holders fixed at 0, which the router refuses in its
// own words. The organization's and the types' levels, which both clouds share, keep AWS's ranges.
const GOOGLE_WAKE_TIMEOUT_MAX = 1700;
const GOOGLE_FIXED_ZERO = ['waitSeconds', 'drainSeconds', 'maxHolders'];
export const SCALAR_KEYS = [...Object.keys(SETTING_RANGES), 'wakeMode'];
export const RULE_KEYS = ['noWakeRules', 'wakeRules'];
// A standalone workload's idle signals (vision standalone workloads design §4; router settings-levels.mjs IDLE_KEYS, its
// ranges and texts): each a value or 'off'. The waker's keys are an HTTP workload's only (WAKER_KEYS).
import { IDLE_SIGNAL_KEYS } from '@dormeto/fleet';

export const IDLE_KEYS = IDLE_SIGNAL_KEYS;
export const STANDALONE_KEYS = ['idleMinutes', 'wakeTimeoutSeconds', ...IDLE_KEYS];
export const WAKER_KEYS = [...SCALAR_KEYS.filter((key) => !STANDALONE_KEYS.includes(key)), ...RULE_KEYS];
export type Kind = 'http' | 'standalone';
const IDLE_METRIC_STATISTICS = ['Maximum', 'Average', 'Sum'];
const IDLE_NETWORK_BYTES_MAX = 10_000_000_000;
const DIMENSIONS_MAX = 30;
const RESOURCE = '${resource}';
export const BUILT_IN_TYPES = ['instance', 'asg', 'ecs', 'k8s', 'databases'];
// The levels from the most specific: a value comes from one of them (a workload's `settingsFrom`).
export const LEVELS = ['workload', 'type', 'router', 'organization', 'default'] as const;
export type Level = typeof LEVELS[number];
const RULES_MAX = 20;
const TYPES_MAX = 20;
const TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RULE_NAME_MAX = 64;
const DESCRIPTION_MAX = 200;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const present = (value: unknown) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

function regexProblem(name: string, source: unknown): string | null {
  try {
    new RegExp(String(source));
    return null;
  } catch (err) {
    return `${name}: ${(err as Error).message}`;
  }
}

// What the router's compileRule would throw for a rule, or null.
function ruleProblem(rule: Json): string | null {
  const conditions = ['sourceIps', 'pathPrefixes', 'pathPattern', 'userAgentPattern', 'headers'].filter((key) => present(rule[key]));
  if (!conditions.length) return 'no condition';
  if (present(rule.sourceIps)) {
    if (!Array.isArray(rule.sourceIps)) return 'sourceIps: a list of addresses and ranges';
    for (const entry of rule.sourceIps) {
      const [address, bits] = String(entry).split('/');
      const family = isIP(address ?? '');
      if (!family) return `sourceIps: invalid address ${entry}`;
      if (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (family === 6 ? 128 : 32))) return `sourceIps: invalid range ${entry}`;
    }
  }
  if (present(rule.pathPrefixes) && !(Array.isArray(rule.pathPrefixes) && rule.pathPrefixes.every((p) => typeof p === 'string'))) return 'pathPrefixes: a list of paths';
  if (present(rule.pathPattern)) {
    const problem = regexProblem('pathPattern', rule.pathPattern);
    if (problem) return problem;
  }
  if (present(rule.userAgentPattern)) {
    const problem = regexProblem('userAgentPattern', rule.userAgentPattern);
    if (problem) return problem;
  }
  if (present(rule.headers)) {
    if (!Array.isArray(rule.headers)) return 'headers: a list of headers';
    for (const h of rule.headers as Json[]) {
      if (!isObject(h) || !h.name || present(h.value) === present(h.pattern)) return 'headers: each header needs a name and either value or pattern';
      if (present(h.pattern)) {
        const problem = regexProblem(`headers ${h.name}`, h.pattern);
        if (problem) return problem;
      }
    }
  }
  return null;
}

function rulesProblems(key: string, rules: unknown): string[] {
  if (!Array.isArray(rules)) return [`${key} must be a list of rules`];
  if (rules.length > RULES_MAX) return [`${key}: at most ${RULES_MAX} rules`];
  const problems: string[] = [];
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > RULE_NAME_MAX) {
      problems.push(`${key}: each rule needs a name (at most ${RULE_NAME_MAX} characters)`);
      continue;
    }
    const problem = ruleProblem(rule);
    if (problem) problems.push(`${key}: rule ${rule.name}: ${problem}`);
  }
  return problems;
}

const isText = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max;
function idleMetricProblems(value: unknown): string[] {
  if (value === 'off') return [];
  if (!isObject(value)) return ['idleMetric: must be off or a metric { namespace, name, dimensions, statistic, below }'];
  const problems: string[] = [];
  const fields = ['namespace', 'name', 'dimensions', 'statistic', 'below'];
  problems.push(...Object.keys(value).filter((key) => !fields.includes(key)).map((key) => `idleMetric: unknown field ${key}`));
  if (!isText(value.namespace, 255)) problems.push('idleMetric: namespace must be text of 1 to 255 characters');
  if (!isText(value.name, 255)) problems.push('idleMetric: name must be text of 1 to 255 characters');
  const { dimensions } = value;
  if (!isObject(dimensions) || Object.keys(dimensions).length > DIMENSIONS_MAX || !Object.entries(dimensions).every(([name, v]) => isText(name, 255) && isText(v, 1024))) {
    problems.push(`idleMetric: dimensions must be an object of at most ${DIMENSIONS_MAX} names, each with text of 1 to 1024 characters`);
  } else if (Object.values(dimensions).some((v) => (v as string).replaceAll(RESOURCE, '').includes('${'))) problems.push(`idleMetric: dimensions: only ${RESOURCE} is replaced`);
  if (!IDLE_METRIC_STATISTICS.includes(value.statistic as string)) problems.push(`idleMetric: statistic must be ${IDLE_METRIC_STATISTICS.slice(0, -1).join(', ')} or ${IDLE_METRIC_STATISTICS.at(-1)}`);
  if (typeof value.below !== 'number' || !Number.isFinite(value.below)) problems.push('idleMetric: below must be a number');
  return problems;
}
function idleProblems(key: string, value: unknown): string[] {
  if (key === 'idleMetric') return idleMetricProblems(value);
  if (value === 'off') return [];
  if (key === 'idleCpuPercent') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? [] : ['idleCpuPercent: must be a number from 0 to 100, or off'];
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= IDLE_NETWORK_BYTES_MAX ? [] : [`idleNetworkBytes: must be a whole number from 0 to ${IDLE_NETWORK_BYTES_MAX}, or off`];
}
// A key the workload's kind has not (the router's notForKind).
export const notForKind = (key: string, kind: Kind) => (kind === 'standalone'
  ? `${key}: a standalone workload has no waker: ${key} is for an HTTP workload`
  : `${key}: an HTTP workload naps on its requests: the idle signals are for a standalone workload`);

// A level's settings: each a value or null (unset); `type` only at a workload's; `cloud` the router's, for a router's or a
// workload's. `idle`: the idle signals are known (AWS's levels: a type, a router or the organization holds both kinds' keys);
// `kind`: a workload's, which refuses the other kind's keys whatever their value. A Google Cloud router has no idle signal yet.
export function defaultsProblems(defaults: unknown, { workload = false, cloud = 'aws', idle = false, kind = null }: { workload?: boolean; cloud?: Cloud; idle?: boolean; kind?: Kind | null } = {}): string[] {
  if (!isObject(defaults)) return ['settings must be an object'];
  const problems: string[] = [];
  const idleKnown = cloud !== 'gcp' && (idle || kind !== null);
  for (const [key, value] of Object.entries(defaults)) {
    if (cloud !== 'gcp' && kind !== null && (kind === 'standalone' ? WAKER_KEYS : IDLE_KEYS).includes(key)) {
      problems.push(notForKind(key, kind));
      continue;
    }
    if (idleKnown && IDLE_KEYS.includes(key)) {
      if (value !== null) problems.push(...idleProblems(key, value));
      continue;
    }
    if (value === null && (SCALAR_KEYS.includes(key) || RULE_KEYS.includes(key) || (workload && key === 'type'))) continue;
    if (cloud === 'gcp' && GOOGLE_FIXED_ZERO.includes(key)) continue;
    const range: [number, number] | undefined = cloud === 'gcp' && key === 'wakeTimeoutSeconds' ? [SETTING_RANGES.wakeTimeoutSeconds![0], GOOGLE_WAKE_TIMEOUT_MAX] : SETTING_RANGES[key];
    if (range) {
      if (!Number.isInteger(value) || (value as number) < range[0] || (value as number) > range[1]) problems.push(`${key}: must be a whole number from ${range[0]} to ${range[1]}`);
    } else if (key === 'wakeMode') {
      if (value !== 'any' && value !== 'browser') problems.push('wakeMode: must be any or browser');
    } else if (RULE_KEYS.includes(key)) {
      problems.push(...rulesProblems(key, value));
    } else if (key === 'type' && workload) {
      if (typeof value !== 'string' || !(TYPE_NAME.test(value) || BUILT_IN_TYPES.includes(value))) problems.push('type: must be a type\'s name (lower-case letters, digits and hyphens) or null');
    } else problems.push(`unknown setting ${key}`);
  }
  return problems;
}

const customTypes = (types: unknown[]) => types.filter((t) => isObject(t) && !BUILT_IN_TYPES.includes(t.name as string));

// The organization's types: the built-in ones' defaults (no tags) and at most 20 custom ones, each selected by its tags.
export function typesProblems(types: unknown, { idle = false }: { idle?: boolean } = {}): string[] {
  if (!Array.isArray(types)) return ['types must be a list'];
  if (customTypes(types).length > TYPES_MAX) return [`at most ${TYPES_MAX} custom types`];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    if (!isObject(type) || typeof type.name !== 'string') {
      problems.push('each type needs a name');
      continue;
    }
    const at = `type ${type.name}`;
    if (seen.has(type.name)) problems.push(`${at}: named twice`);
    seen.add(type.name);
    if (BUILT_IN_TYPES.includes(type.name)) {
      if (type.tags !== undefined && type.tags !== null && !(isObject(type.tags) && !Object.keys(type.tags).length)) problems.push(`${at}: a built-in type has no tags`);
    } else {
      if (!TYPE_NAME.test(type.name)) problems.push(`${at}: a name is lower-case letters, digits and hyphens, starting with a letter (at most 32)`);
      if (!isObject(type.tags) || !Object.keys(type.tags).length || !Object.values(type.tags).every((v) => typeof v === 'string')) {
        problems.push(`${at}: tags must select at least one tag (key and value)`);
      }
    }
    if (type.description !== undefined && type.description !== null && (typeof type.description !== 'string' || type.description.length > DESCRIPTION_MAX)) {
      problems.push(`${at}: description must be text of at most ${DESCRIPTION_MAX} characters`);
    }
    if (type.settings !== undefined && type.settings !== null) problems.push(...defaultsProblems(type.settings, { idle }).map((p) => `${at}: settings: ${p}`));
  }
  return problems;
}

// The valid keys of a stored level (a hand-written settings.json may hold others): what people are shown.
// The organization's level knows the idle signals (AWS's routers read them; a Google Cloud router is never pushed them).
export function validDefaults(value: unknown): Json {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== null && !defaultsProblems({ [key]: v }, { idle: true }).length));
}

// The valid types of a stored list, each on its own.
export function validTypes(value: unknown): Json[] {
  if (!Array.isArray(value) || typesProblems(value, { idle: true }).some((p) => p.startsWith('at most'))) return [];
  const kept: Json[] = [];
  for (const type of value) if (!typesProblems([...kept, type], { idle: true }).length) kept.push(type as Json);
  return kept;
}

// The idle signals a settings.json sets (its defaults' and each type's), by where: what the organization-level gate compares.
export function idleSignalsOf(doc: unknown): Record<string, string> {
  const workloads = isObject(doc) && isObject(doc.workloads) ? doc.workloads : {};
  const out: Record<string, string> = {};
  const add = (at: string, settings: unknown) => {
    if (!isObject(settings)) return;
    for (const key of IDLE_KEYS) if (settings[key] !== undefined && settings[key] !== null) out[`${at}${key}`] = JSON.stringify(settings[key]);
  };
  add('defaults.', workloads.defaults);
  if (Array.isArray(workloads.types)) for (const t of workloads.types) if (isObject(t)) add(`type ${String(t.name)}.`, t.settings);
  return out;
}

// settings.json without its idle signals: what a Google Cloud router is pushed (it has none yet, design §11's plan 5).
export { withoutIdleSignals } from '@dormeto/fleet';

// How many workloads a level reaches, per setting (design §8): those of its scope whose value comes from it or a level below.
// The idle signals are counted when the scope holds a standalone workload (their only holders).
export function reachOf(summaries: { settingsFrom?: Record<string, string>; kind?: unknown }[], level: 'organization' | 'router' | 'type') {
  const from = LEVELS.indexOf(level);
  const counted = [...SCALAR_KEYS, ...(summaries.some((s) => s.kind === 'standalone') ? IDLE_KEYS : [])];
  const keys: Record<string, number> = Object.fromEntries(counted.map((key) => [key, 0]));
  for (const summary of summaries) {
    for (const key of counted) {
      const at = LEVELS.indexOf((summary.settingsFrom?.[key] ?? '') as Level);
      if (at >= from) keys[key]! += 1;
    }
  }
  return { workloads: summaries.length, keys };
}
