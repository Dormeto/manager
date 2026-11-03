// The levels' settings (vision settings at scale design §4, §5), checked before a write in the router's words: the
// organization's defaults and types, a router's defaults and a workload's settings. The router checks them again and
// keeps the last word (router lambda/src/lib/settings-levels.mjs and no-wake.mjs).
import { isIP } from 'node:net';

export const SETTING_RANGES: Record<string, [number, number]> = {
  idleMinutes: [5, 1440], waitSeconds: [5, 120], drainSeconds: [0, 300], wakeTimeoutSeconds: [60, 3600], maxHolders: [1, 500], failedRetrySeconds: [10, 600],
};
export const SCALAR_KEYS = [...Object.keys(SETTING_RANGES), 'wakeMode'];
export const RULE_KEYS = ['noWakeRules', 'wakeRules'];
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

// A level's settings: each a value or null (unset); `type` only at a workload's.
export function defaultsProblems(defaults: unknown, { workload = false } = {}): string[] {
  if (!isObject(defaults)) return ['settings must be an object'];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (value === null && (SCALAR_KEYS.includes(key) || RULE_KEYS.includes(key) || (workload && key === 'type'))) continue;
    const range = SETTING_RANGES[key];
    if (range) {
      if (!Number.isInteger(value) || (value as number) < range[0] || (value as number) > range[1]) problems.push(`${key} must be a whole number from ${range[0]} to ${range[1]}`);
    } else if (key === 'wakeMode') {
      if (value !== 'any' && value !== 'browser') problems.push('wakeMode must be any or browser');
    } else if (RULE_KEYS.includes(key)) {
      problems.push(...rulesProblems(key, value));
    } else if (key === 'type' && workload) {
      if (typeof value !== 'string' || !(TYPE_NAME.test(value) || BUILT_IN_TYPES.includes(value))) problems.push('type must be a type\'s name (lower-case letters, digits and hyphens) or null');
    } else problems.push(`unknown setting ${key}`);
  }
  return problems;
}

const customTypes = (types: unknown[]) => types.filter((t) => isObject(t) && !BUILT_IN_TYPES.includes(t.name as string));

// The organization's types: the built-in ones' defaults (no tags) and at most 20 custom ones, each selected by its tags.
export function typesProblems(types: unknown): string[] {
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
    if (type.settings !== undefined && type.settings !== null) problems.push(...defaultsProblems(type.settings).map((p) => `${at}: settings: ${p}`));
  }
  return problems;
}

// The valid keys of a stored level (a hand-written settings.json may hold others): what people are shown.
export function validDefaults(value: unknown): Json {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== null && !defaultsProblems({ [key]: v }).length));
}

// The valid types of a stored list, each on its own.
export function validTypes(value: unknown): Json[] {
  if (!Array.isArray(value) || typesProblems(value).some((p) => p.startsWith('at most'))) return [];
  const kept: Json[] = [];
  for (const type of value) if (!typesProblems([...kept, type]).length) kept.push(type as Json);
  return kept;
}

// How many workloads a level reaches, per setting (design §8): those of its scope whose value comes from it or a level below.
export function reachOf(summaries: { settingsFrom?: Record<string, string> }[], level: 'organization' | 'router' | 'type') {
  const from = LEVELS.indexOf(level);
  const keys: Record<string, number> = Object.fromEntries(SCALAR_KEYS.map((key) => [key, 0]));
  for (const summary of summaries) {
    for (const key of SCALAR_KEYS) {
      const at = LEVELS.indexOf((summary.settingsFrom?.[key] ?? '') as Level);
      if (at >= from) keys[key]! += 1;
    }
  }
  return { workloads: summaries.length, keys };
}
