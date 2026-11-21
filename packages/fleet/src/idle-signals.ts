// A standalone workload's idle signals at the organization's level (vision standalone workloads design §4, §6): the router's
// settings-levels.mjs IDLE_KEYS. A Google Cloud router has none yet: settings.json is pushed to it without them.
export const IDLE_KEYS = ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
// The first router that knows standalone workloads (its onboarding, status and idle signals): the API's organization-level
// gate, the operations' preview and the dashboard's words read it; a test ties it to the router's checkout.
export const STANDALONE_ROUTER = '0.42.0';
// Each cloud's first router that knows them (plan 5: Google Cloud's routers know them from the same version, its own release
// line could part one day): the gate, the push of the organization's idle signals and the watchdog read it by the router's cloud.
export const STANDALONE_ROUTERS: Record<'aws' | 'gcp', string> = { aws: STANDALONE_ROUTER, gcp: '0.42.0' };
// Whether a router of the cloud at the version knows the idle signals: by its major.minor.patch (a dev build of it does too); an
// unknown version does not.
export function knowsIdleSignals(cloud: 'aws' | 'gcp', version: string | null | undefined): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!v) return false;
  const floor = STANDALONE_ROUTERS[cloud].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (Number(v[i + 1]) !== floor[i]) return Number(v[i + 1]) > floor[i]!;
  return true;
}
// A standalone resource's kind, in words (the router's onboarding.mjs texts).
export const RESOURCE_KIND_TEXT: Record<string, string> = { instance: 'instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'RDS cluster', 'cloudsql-instance': 'Cloud SQL instance' };

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
