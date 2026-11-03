// Settings at scale in the demo (vision settings at scale design §5, §6): the router's resolution on the demo's levels, its
// routes' answers (the organization's defaults and types, what a level reaches, a router's and a workload's defaults).
import { atLeast } from '../format';
import { BUILT_IN, BUILT_IN_TYPES, type Defaults } from '../defaults';
import type { Level, Rule, Settings, SettingsFrom, WorkloadType } from '../types';
import { ROUTER_RULES } from './fixtures';
import { audited, fail } from './state';
import type { Demo, DemoRouter, DemoWorkload } from './state';
import { ME } from './org';

type Body = Record<string, unknown>;

export interface DemoType { name: string; description?: string; tags?: Record<string, string>; settings?: Defaults }
export const knowsLevels = (version: string) => atLeast(version, '0.37.0');
const SCALARS = ['idleMinutes', 'waitSeconds', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode'] as const;
type Scalar = typeof SCALARS[number];
const RULE_KEYS = ['noWakeRules', 'wakeRules'] as const;
const RANGES: Record<string, [number, number]> = { idleMinutes: [5, 1440], waitSeconds: [5, 120], drainSeconds: [0, 300], wakeTimeoutSeconds: [60, 3600], maxHolders: [1, 500], failedRetrySeconds: [10, 600] };
const typesOf = (d: Demo): DemoType[] => d.hibernation.types ?? [];

// The keys a workload sets itself: those it was given, else those that differ from the built-in values.
const ownKeys = (w: DemoWorkload): string[] => w.ownKeys ?? [
  ...(Object.keys(w.settings) as (keyof Settings)[]).filter((k) => w.settings[k] !== BUILT_IN[k]), ...(w.wakeMode !== BUILT_IN.wakeMode ? ['wakeMode'] : []),
];
const builtInType = (w: DemoWorkload): string | null => {
  const kinds: string[] = w.backends.map((b) => b.kind);
  if (kinds.includes('rds')) return 'databases';
  return ['instance', 'asg', 'ecs', 'k8s'].find((k) => kinds.includes(k)) ?? null;
};
export function typeOf(d: Demo, w: DemoWorkload): WorkloadType {
  const custom = typesOf(d).filter((t) => !BUILT_IN_TYPES.includes(t.name));
  if (w.type && (BUILT_IN_TYPES.includes(w.type) || custom.some((t) => t.name === w.type))) return { name: w.type, from: 'workload' };
  const lost = w.type ? { missing: w.type } : {};
  const matched = custom.find((t) => Object.keys(t.tags ?? {}).length && Object.entries(t.tags ?? {}).every(([k, v]) => w.tags[k] === v));
  if (matched) return { name: matched.name, from: 'tags', ...lost };
  const builtIn = builtInType(w);
  return builtIn ? { name: builtIn, from: 'backends', ...lost } : { name: null, from: null, ...lost };
}

const described = (level: string, rules: unknown[] | undefined): Rule[] => (rules ?? []).map((r) => {
  const { name, ...conditions } = r as { name: string } & Record<string, unknown>;
  return { name, level, conditions };
});

// The resolved settings of a workload, their levels, its type and its rules, as a router 0.37.0 answers them.
export function resolvedOf(d: Demo, w: DemoWorkload) {
  const router = d.routers.find((r) => r.name === w.router)!;
  const type = typeOf(d, w);
  const typeSettings = typesOf(d).find((t) => t.name === type.name)?.settings ?? {};
  const own = ownKeys(w);
  const organization = router.readsManager ? d.hibernation.defaults ?? {} : {};
  const levels: [Level, Defaults][] = [['type', typeSettings], ['router', router.defaults ?? {}], ['organization', organization]];
  const values: Record<string, number | string> = {};
  const from: SettingsFrom = {};
  for (const key of SCALARS) {
    const mine = key === 'wakeMode' ? w.wakeMode : w.settings[key as keyof Settings];
    if (own.includes(key) && mine !== undefined) {
      values[key] = mine;
      from[key] = 'workload';
      continue;
    }
    const found = levels.find(([, set]) => set[key] !== undefined);
    // The built-in values follow the backends, whatever type picks the workload (as the router, review 2026-11-04).
    values[key] = found ? found[1][key]! : key === 'wakeTimeoutSeconds' && builtInType(w) === 'databases' ? 1800 : BUILT_IN[key as Scalar];
    from[key] = found ? found[0] : 'default';
  }
  const ruleLevels = (key: typeof RULE_KEYS[number]) => [
    ...described('organization', organization[key]), ...(key === 'noWakeRules' ? ROUTER_RULES.map((r) => ({ ...r, terraform: true as const })) : []), ...described('router', router.defaults?.[key]),
    ...described('type', typeSettings[key]), ...(key === 'noWakeRules' ? w.noWakeRules : described('workload', w.wakeRules as unknown[])),
  ];
  const { wakeMode, ...settings } = values;
  return {
    settings: settings as unknown as Settings, wakeMode: String(wakeMode), settingsFrom: from, type,
    noWakeRules: ruleLevels('noWakeRules'),
    wakeRules: ruleLevels('wakeRules').map((r) => ({ ...r, level: 'wake', from: r.level })),
  };
}

function checked(defaults: unknown, workload = false): Record<string, unknown> {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) fail(400, 'bad_request', 'settings must be an object');
  for (const [key, value] of Object.entries(defaults as object)) {
    if (value === null) continue;
    if (RANGES[key]) {
      const [min, max] = RANGES[key]!;
      if (!Number.isInteger(value) || value < min || value > max) fail(400, 'bad_request', `${key} must be a whole number from ${min} to ${max}`);
    } else if (key === 'wakeMode') {
      if (value !== 'any' && value !== 'browser') fail(400, 'bad_request', 'wakeMode must be any or browser');
    } else if ((RULE_KEYS as readonly string[]).includes(key)) {
      if (!Array.isArray(value) || value.length > 20 || !value.every((r) => r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string')) fail(400, 'bad_request', `${key} must be a list of at most 20 named rules`);
    } else if (!(workload && key === 'type')) fail(400, 'bad_request', `unknown setting ${key}`);
  }
  return defaults as Record<string, unknown>;
}
const merged = (held: Defaults | undefined, sent: Record<string, unknown> | null): Defaults | undefined => {
  if (sent === null) return undefined;
  const next = Object.fromEntries(Object.entries({ ...held, ...sent }).filter(([, v]) => v !== null)) as Defaults;
  return Object.keys(next).length ? next : undefined;
};

export const organizationDefaults = (d: Demo) => ({ ...d.hibernation, defaults: d.hibernation.defaults ?? {}, types: undefined });

export function putOrganizationDefaults(d: Demo, body: Body, now: number) {
  const sent = body.defaults === null ? null : checked(body.defaults);
  return audited(d, 'settings', 'workloads', () => {
    d.hibernation.defaults = merged(d.hibernation.defaults, sent);
    d.hibernation.updatedAt = new Date(now).toISOString();
    d.hibernation.updatedBy = ME;
    return { result: 'defaults', response: { ...organizationDefaults(d), note: 'routers apply it at their next check, within 5 minutes' } };
  });
}

export const typesAnswer = (d: Demo) => ({ types: typesOf(d), builtIn: BUILT_IN_TYPES, updatedAt: d.hibernation.updatedAt, updatedBy: d.hibernation.updatedBy });
export function putTypes(d: Demo, body: Body, now: number) {
  const types = body.types;
  if (!Array.isArray(types)) fail(400, 'bad_request', 'types must be a list');
  for (const t of types as DemoType[]) {
    if (!BUILT_IN_TYPES.includes(t.name) && !/^[a-z][a-z0-9-]{0,31}$/.test(t.name)) fail(400, 'bad_request', `type ${t.name}: a name is lower-case letters, digits and hyphens, starting with a letter (at most 32)`);
    checked(t.settings ?? {});
  }
  return audited(d, 'types', 'organization', () => {
    d.hibernation.types = (types as DemoType[]).length ? types as DemoType[] : undefined;
    d.hibernation.updatedAt = new Date(now).toISOString();
    d.hibernation.updatedBy = ME;
    return { result: (types as DemoType[]).map((t) => t.name).join(', ') || 'none', response: { ...typesAnswer(d), note: 'routers apply it at their next check, within 5 minutes' } };
  });
}

const ORDER: Level[] = ['workload', 'type', 'router', 'organization', 'default'];
export function reach(d: Demo, query: Record<string, string>) {
  const level = query.level as Level;
  if (!['organization', 'router', 'type'].includes(level)) fail(400, 'bad_request', 'level must be organization, router or type');
  const scope = d.workloads.filter((w) => knowsLevels(d.routers.find((r) => r.name === w.router)!.version))
    .filter((w) => level === 'organization' || (level === 'router' ? w.router === query.name : typeOf(d, w).name === query.name));
  const keys = Object.fromEntries(SCALARS.map((key) => [key, scope.filter((w) => ORDER.indexOf(resolvedOf(d, w).settingsFrom[key] ?? 'default') >= ORDER.indexOf(level)).length]));
  return { workloads: scope.length, keys };
}

export function putRouterDefaults(d: Demo, router: DemoRouter, sent: unknown) {
  const defaults = sent === null ? null : checked(sent);
  if (!knowsLevels(router.version)) fail(409, 'conflict', 'upgrade the router to 0.37.0');
  router.defaults = merged(router.defaults, defaults);
}

export function putWorkloadLevels(d: Demo, w: DemoWorkload, body: Body) {
  const { hibernate: _h, ...rest } = body;
  checked(rest, true);
  const router = d.routers.find((r) => r.name === w.router)!;
  if (!knowsLevels(router.version)) fail(409, 'conflict', 'upgrade the router to 0.37.0');
  if (w.source === 'terraform') fail(409, 'conflict', `workload ${w.workloadId} was written by Terraform: set ${Object.keys(rest)[0]} in its workload module`);
  const own = new Set(ownKeys(w));
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'type') w.type = (value as string | null) ?? undefined;
    else if (key === 'noWakeRules') w.noWakeRules = described('workload', (value as unknown[] | null) ?? []);
    else if (key === 'wakeRules') w.wakeRules = described('workload', (value as unknown[] | null) ?? []) as never;
    else if (value === null) own.delete(key);
    else {
      own.add(key);
      if (key === 'wakeMode') w.wakeMode = value as 'any' | 'browser';
      else (w.settings as unknown as Record<string, unknown>)[key] = value;
    }
  }
  w.ownKeys = [...own];
}
