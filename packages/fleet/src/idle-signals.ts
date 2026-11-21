// A standalone workload's idle signals at the organization's level (vision standalone workloads design §4, §6): the router's
// settings-levels.mjs IDLE_KEYS. A Google Cloud router has none yet: settings.json is pushed to it without them.
export const IDLE_KEYS = ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
// The first router that knows standalone workloads (its onboarding, status and idle signals): the API's organization-level
// gate, the operations' preview and the dashboard's words read it; a test ties it to the router's checkout.
export const STANDALONE_ROUTER = '0.42.0';
// A standalone resource's kind, in words (the router's onboarding.mjs texts).
export const RESOURCE_KIND_TEXT: Record<string, string> = { instance: 'instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'RDS cluster' };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// settings.json without the idle signals of its defaults and of each type's settings; anything else as it is.
export function withoutIdleSignals(doc: unknown): unknown {
  if (!isObject(doc) || !isObject(doc.workloads)) return doc;
  const strip = (settings: unknown) => (isObject(settings) ? Object.fromEntries(Object.entries(settings).filter(([key]) => !IDLE_KEYS.includes(key))) : settings);
  const { defaults, types, ...rest } = doc.workloads;
  return {
    ...doc,
    workloads: {
      ...rest, ...(defaults !== undefined ? { defaults: strip(defaults) } : {}),
      ...(types !== undefined ? { types: Array.isArray(types) ? types.map((t) => (isObject(t) && t.settings !== undefined ? { ...t, settings: strip(t.settings) } : t)) : types } : {}),
    },
  };
}
