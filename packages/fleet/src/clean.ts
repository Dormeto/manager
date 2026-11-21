// What a router event may store (vision scale design §4). Any principal of the organization can publish to the bus, so
// only the known fields are kept, each of its type and size, and a time ahead of the manager's clock is refused: a newer
// state always wins, so one event dated in the future would pin a summary for good.

import { cloudOf, isRegion, type Cloud } from './clouds.js';

// Clock difference accepted between a router and the manager.
export const SKEW_MS = 5 * 60_000;
// Chunks of one check, 64 KB each: about 50,000 workloads, far more than one router has.
export const MAX_CHUNKS = 200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Shown as a link: https only, without characters that could break out of it.
const URL = /^https:\/\/[^\s"'<>\\]{1,2040}$/;
const STATES = new Set(['ASLEEP', 'WAKING', 'AWAKE', 'NAPPING', 'FAILED', 'UNKNOWN']);
const PAUSES_MAX = 20;
const HEALTH_MAX = 16 * 1024; // bytes of JSON

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const time = (v: unknown) => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const defined = <T extends Json>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const numbers = (v: unknown, keys?: Set<string>) => (isObject(v)
  ? Object.fromEntries(Object.entries(v).filter(([k, n]) => (!keys || keys.has(k)) && count(n) !== undefined)) as Record<string, number>
  : undefined);

export const stateOf = (v: unknown) => (typeof v === 'string' && STATES.has(v) ? v : null);
export const workloadIdOf = (v: unknown) => (typeof v === 'string' && WORKLOAD_ID.test(v) ? v : null);
// A region of the account's cloud (either cloud's when the account is neither).
export const regionOf = (v: unknown, account?: string) => {
  const cloud = account ? cloudOf(account) : null;
  return (cloud ? isRegion(cloud, v) : isRegion('aws', v) || isRegion('gcp', v)) ? (v as string) : null;
};
// Workloads of one chunk: 64 KB hold far fewer.
export const CHUNK_WORKLOADS_MAX = 1000;

// A time the manager accepts: ISO, and not ahead of its clock by more than the skew.
export const timely = (v: unknown, now: number) => {
  const t = time(v);
  return t !== null && Date.parse(t) <= now + SKEW_MS ? t : null;
};

// A workload's tags (routers 0.30.0), under the rules of the API's tagsProblem (access.ts): at most 50, a key of 1 to 128
// characters and a value of at most 256 (code points), the AWS characters, no dormeto: prefix in any case. A map that
// breaks one rule is kept as no tags at all (fail closed: untagged, never trimmed); none reported (a router before
// 0.30.0, or not an object): undefined, which the API reads as no tags.
const TAGS_MAX = 50;
const TAG_CHARS = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;
const tagsOf = (v: unknown) => {
  if (!isObject(v)) return undefined;
  const entries = Object.entries(v);
  const ok = entries.length <= TAGS_MAX && entries.every(([key, value]) => typeof value === 'string'
    && [...key].length >= 1 && [...key].length <= 128 && [...value].length <= 256
    && TAG_CHARS.test(key) && TAG_CHARS.test(value) && !key.toLowerCase().startsWith('dormeto:'));
  return ok ? Object.fromEntries(entries) as Record<string, string> : {};
};

// A pause as shown: its known texts, each short.
const pauseOf = (p: unknown) => (isObject(p)
  ? defined({
    scope: text(p.scope, 16), workloadId: text(p.workloadId, 64) ?? (p.workloadId === null ? null : undefined), reason: text(p.reason, 300), by: text(p.by, 320),
    at: time(p.at) ?? undefined, until: time(p.until) ?? undefined, exclusionId: text(p.exclusionId, 64),
  })
  : null);
export const pausesOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, PAUSES_MAX).map(pauseOf).filter(Boolean) : []);

// The kinds of a workload's backends (routers 0.23.3): the known ones, once each. A Google Cloud row's (routers 0.40.0) are
// instance, asg, k8s and cloudsql-instance (Cloud SQL, the twin of rds-instance).
const BACKEND_KINDS = new Set(['instance', 'asg', 'ecs', 'k8s', 'rds-instance', 'rds-cluster', 'cloudsql-instance']);
const backendsOf = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === 'string' && BACKEND_KINDS.has(k)))] : undefined);

// Why a wake (or a nap) failed (routers 0.25.0, R7a): a known kind, else unknown; the message cut to 300 characters.
const FAILURE_KINDS = new Set(['capacity', 'quota', 'permission', 'configuration', 'unhealthy', 'throttled', 'timeout', 'cluster', 'unknown']);
export interface Failure { kind: string; step: 'wake' | 'nap'; backend?: string; message: string; at: string }
export function failureOf(v: unknown, fallbackAt?: string | null): Failure | undefined {
  if (!isObject(v)) return undefined;
  // ISO; milliseconds in the events of router 0.25.0's first build.
  const ms = typeof v.at === 'number' && Number.isFinite(v.at) && v.at > 0 ? new Date(v.at).toISOString() : null;
  const at = time(v.at) ?? ms ?? fallbackAt ?? null;
  if (!at) return undefined;
  return defined({
    kind: typeof v.kind === 'string' && FAILURE_KINDS.has(v.kind) ? v.kind : 'unknown',
    step: v.step === 'nap' ? 'nap' as const : 'wake' as const,
    backend: text(v.backend, 200),
    message: text(v.message, 300) ?? '',
    at,
  });
}

// The fallback instance types its instances run on (routers 0.25.0, R7a): well-formed ones, at most 20.
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
// A Google Cloud VM's name.
const VM_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
export interface Fallback { instance: string; from: string; to: string }
// A Google Cloud machine type: e2-medium, n2d-standard-2, e2-custom-4-8192.
const MACHINE_TYPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const fallbacksOf = (v: unknown, cloud: Cloud | null = 'aws'): Fallback[] | undefined => (Array.isArray(v)
  ? v.filter((f): f is Fallback => isObject(f) && typeof f.instance === 'string' && (cloud === 'gcp' ? VM_NAME : INSTANCE_ID).test(f.instance)
    && typeof f.from === 'string' && (cloud === 'gcp' ? MACHINE_TYPE : INSTANCE_TYPE).test(f.from) && typeof f.to === 'string' && (cloud === 'gcp' ? MACHINE_TYPE : INSTANCE_TYPE).test(f.to))
    .slice(0, 20).map(({ instance, from, to }) => ({ instance, from, to }))
  : undefined);

// What a nap stopped (routers 0.27.0, R9): the known kinds, well-formed, at most 50; what ran on Spot (0.28.0, R9.5).
const spotOf = (v: Record<string, unknown>) => (v.spot === true ? { spot: true } : {});
const TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const DB_CLASS = /^db\.[a-z0-9.]+$/;
const between = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
// A Google Cloud machine type's family (e2, n2d), a zone (europe-west1-b), a Cloud SQL tier (Enterprise Plus's hold a
// capital: db-perf-optimized-N-4), its engines and editions.
const FAMILY = /^[a-z][a-z0-9]{0,7}$/;
const ZONE = /^[a-z]+-[a-z]+\d{1,2}-[a-z]$/;
const SQL_TIER = /^db-[a-zA-Z0-9-]{1,60}$/;
const SQL_ENGINES = new Set(['postgres', 'mysql', 'sqlserver']);
const SQL_EDITIONS = new Set(['enterprise', 'enterprise-plus']);
function knownStoppedItemOf(v: unknown): Json | null {
  if (!isObject(v)) return null;
  if (v.kind === 'ec2' && typeof v.type === 'string' && TYPE.test(v.type) && between(v.count, 1, 10_000) && typeof v.os === 'string') return { kind: 'ec2', type: v.type, count: v.count, os: v.os.slice(0, 40), ...spotOf(v) };
  if (v.kind === 'fargate' && between(v.vcpu, 0.25, 64) && between(v.memoryGb, 0.5, 512) && between(v.count, 1, 10_000) && (v.arch === 'x86_64' || v.arch === 'arm64') && typeof v.os === 'string') {
    return { kind: 'fargate', vcpu: v.vcpu, memoryGb: v.memoryGb, count: v.count, arch: v.arch, os: v.os.slice(0, 40), ...spotOf(v) };
  }
  if (v.kind === 'rds' && typeof v.class === 'string' && DB_CLASS.test(v.class) && typeof v.engine === 'string') return { kind: 'rds', class: v.class, engine: v.engine.slice(0, 40), multiAz: v.multiAz === true };
  if (v.kind === 'aurora-serverless' && typeof v.engine === 'string' && between(v.acu, 0, 256)) return { kind: 'aurora-serverless', engine: v.engine.slice(0, 40), acu: v.acu };
  // Pods on EC2 nodes (routers 0.29.0, R10.5).
  if (v.kind === 'k8s-pods' && between(v.count, 1, 10_000) && between(v.cpu, 0, 1024) && between(v.memoryGb, 0, 8192) && (v.nodeType === null || (typeof v.nodeType === 'string' && TYPE.test(v.nodeType)))
    && typeof v.os === 'string' && typeof v.autoscaled === 'boolean' && isObject(v.allocatable) && between(v.allocatable.cpu, 0, 1024) && between(v.allocatable.memoryGb, 0, 8192)) {
    return {
      kind: 'k8s-pods', count: v.count, cpu: v.cpu, memoryGb: v.memoryGb, nodeType: v.nodeType, os: v.os.slice(0, 40), ...spotOf(v), autoscaled: v.autoscaled,
      allocatable: { cpu: v.allocatable.cpu, memoryGb: v.allocatable.memoryGb },
    };
  }
  // A Google Cloud router's (routers 0.40.0, Google Cloud design §9.1): VMs of one machine type in a zone, a Cloud SQL
  // instance in a region. A Cloud SQL shape out of its bounds is dropped, the instance kept (not priced, its hours kept).
  if (v.kind === 'gce' && typeof v.machineType === 'string' && MACHINE_TYPE.test(v.machineType) && typeof v.family === 'string' && FAMILY.test(v.family)
    && between(v.vcpus, 0.1, 1024) && between(v.memoryGb, 0.1, 12_288) && between(v.count, 1, 10_000) && (v.os === 'Linux' || v.os === 'Windows') && typeof v.zone === 'string' && ZONE.test(v.zone)) {
    return { kind: 'gce', machineType: v.machineType, family: v.family, vcpus: v.vcpus, memoryGb: v.memoryGb, count: v.count, os: v.os, ...spotOf(v), ...(v.suspended === true ? { suspended: true } : {}), zone: v.zone };
  }
  if (v.kind === 'cloudsql' && typeof v.tier === 'string' && SQL_TIER.test(v.tier) && SQL_ENGINES.has(v.engine as string) && SQL_EDITIONS.has(v.edition as string) && isRegion('gcp', v.region)) {
    return defined({
      kind: 'cloudsql', tier: v.tier, engine: v.engine, edition: v.edition, ha: v.ha === true, region: v.region,
      vcpus: between(v.vcpus, 0.1, 1024) ? v.vcpus : undefined, memoryGb: between(v.memoryGb, 0.1, 12_288) ? v.memoryGb : undefined,
    });
  }
  if (v.kind === 'unknown') return { kind: 'unknown', backend: text(v.backend, 200) ?? '', reason: text(v.reason, 200) ?? '' };
  return null;
}
// An item this manager can't read (a kind newer than it: a router is upgraded without its manager; a shape out of its
// bounds) stays, as an unknown one: dropped, its hours would be priced as nothing stopped ($0), not as not priced.
const stoppedItemOf = (v: unknown): Json => knownStoppedItemOf(v) ?? {
  kind: 'unknown', backend: isObject(v) && typeof v.backend === 'string' ? text(v.backend, 200)! : 'all',
  reason: `not readable by this manager: ${isObject(v) && typeof v.kind === 'string' ? v.kind.slice(0, 40) : ''}`,
};
export const stoppedOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).map(stoppedItemOf) : undefined);

// The instances a nap hibernated (routers 0.32.0): well-formed ids, at most 50; nothing when none is valid.
export function hibernatedOf(v: unknown, cloud: Cloud | null = 'aws'): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const valid = cloud === 'gcp' ? VM_NAME : INSTANCE_ID;
  const ids = v.filter((i): i is string => typeof i === 'string' && valid.test(i)).slice(0, 50);
  return ids.length ? ids : undefined;
}

// What a state change event says of its transition, for the history (R8): what started it, its wake, the wake's
// duration, the failure, who asked it from the manager.
export function transitionOf(d: Json, at: string, cloud: Cloud | null = 'aws') {
  return defined({
    from: stateOf(d.from),
    cause: text(d.cause, 64),
    wakeId: text(d.wakeId, 64),
    durationMs: count(d.durationMs),
    failure: failureOf(d.failure, at),
    by: text(d.by, 320),
    stopped: stoppedOf(d.stopped),
    hibernated: hibernatedOf(d.hibernated, cloud),
  });
}

// A Google Cloud resource path or name.
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/;
const resourceOf = (v: unknown) => (typeof v === 'string' && RESOURCE.test(v) ? v : undefined);
const lbOf = (v: unknown) => (isObject(v) && typeof v.kind === 'string' && /^[a-z][a-z-]{0,31}$/.test(v.kind)
  ? defined({ kind: v.kind, region: isRegion('gcp', v.region) ? v.region : undefined })
  : undefined);

// A standalone workload's resource (vision standalone workloads design §5): an AWS ARN.
const RESOURCE_ARN = /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s]{1,1024}$/;
// Its idle signals (the router's settings-levels.mjs ranges): CPU a number from 0 to 100, network bytes a whole number from 0 to
// 10,000,000,000, a metric { namespace, name, dimensions, statistic, below } (its dimensions an object, or a list of them for
// the built-in connections of several databases), each or 'off'. One that is not of its shape is dropped.
const STATISTICS = new Set(['Maximum', 'Average', 'Sum']);
const dimensionsOf = (v: unknown) => isObject(v) && Object.keys(v).length <= 30 && Object.entries(v).every(([k, d]) => k.length >= 1 && k.length <= 255 && typeof d === 'string' && d.length >= 1 && d.length <= 1024);
function idleSettingOf(key: string, v: unknown): unknown {
  if (v === 'off') return 'off';
  if (key === 'idleCpuPercent') return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
  if (key === 'idleNetworkBytes') return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000_000 ? v : undefined;
  if (!isObject(v)) return undefined;
  const { namespace, name, dimensions, statistic, below } = v;
  const named = (t: unknown) => typeof t === 'string' && t.length >= 1 && t.length <= 255;
  const dims = Array.isArray(dimensions) ? dimensions.length <= 20 && dimensions.every(dimensionsOf) : dimensionsOf(dimensions);
  if (!named(namespace) || !named(name) || !dims || !STATISTICS.has(statistic as string) || typeof below !== 'number' || !Number.isFinite(below)) return undefined;
  return { namespace, name, dimensions, statistic, below };
}
const IDLE_KEYS = ['idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];
// A standalone workload's settings: its kind's five (the router's STANDALONE_KEYS), nothing of the waker's.
function standaloneSettingsOf(v: unknown): Json | undefined {
  if (!isObject(v)) return undefined;
  return defined({ ...numbers(v, new Set(['idleMinutes', 'wakeTimeoutSeconds'])), ...Object.fromEntries(IDLE_KEYS.map((key) => [key, idleSettingOf(key, v[key])])) });
}

// A workload of a check, or null when it has no valid id. A standalone one (`kind: 'standalone'`, routers 0.42.0) has its
// resource instead of a target group, no URL nor wake mode, and its kind's settings; an HTTP one has no `kind`.
export function workloadOf(w: unknown, cloud: Cloud | null = 'aws'): Json | null {
  if (!isObject(w) || typeof w.workloadId !== 'string' || !WORKLOAD_ID.test(w.workloadId)) return null;
  if (cloud !== 'gcp' && w.kind === 'standalone') return standaloneOf(w, cloud);
  return defined({
    workloadId: w.workloadId,
    name: text(w.name, 64),
    targetGroupArn: cloud !== 'gcp' && typeof w.targetGroupArn === 'string' && w.targetGroupArn.startsWith('arn:') ? w.targetGroupArn.slice(0, 512) : undefined,
    // A Google Cloud row (routers 0.40.0): its backend services, URL map and load balancer, as resource paths and names.
    backendService: cloud === 'gcp' ? resourceOf(w.backendService) : undefined,
    wakerBackendService: cloud === 'gcp' ? resourceOf(w.wakerBackendService) : undefined,
    urlMap: cloud === 'gcp' ? resourceOf(w.urlMap) : undefined,
    lb: cloud === 'gcp' ? lbOf(w.lb) : undefined,
    tags: tagsOf(w.tags),
    source: w.source === 'manager' || w.source === 'cli' ? w.source : 'terraform',
    state: typeof w.state === 'string' && STATES.has(w.state) ? w.state : 'UNKNOWN',
    url: typeof w.url === 'string' && URL.test(w.url) ? w.url : null,
    wakeMode: text(w.wakeMode, 16),
    wakeCount: count(w.wakeCount),
    awakeSince: time(w.awakeSince),
    wakeStartedAt: time(w.wakeStartedAt),
    failedAt: time(w.failedAt),
    // When its state began (router 0.26.0): the instant of its state change event (R8).
    stateAt: time(w.stateAt) ?? undefined,
    // Its last failure until a successful wake, the failures in a row and the next attempt (routers 0.25.0, R7a).
    failure: failureOf(w.failure),
    consecutiveFailures: count(w.consecutiveFailures),
    nextAttemptAt: time(w.nextAttemptAt) ?? undefined,
    fallbacks: fallbacksOf(w.fallbacks, cloud),
    updatedAt: time(w.updatedAt),
    pendingWake: w.pendingWake === true,
    // A schedule is set (routers 0.31.0).
    scheduled: w.scheduled === true ? true : undefined,
    // Asleep with its instances hibernated (routers 0.32.0).
    hibernated: w.hibernated === true ? true : undefined,
    backends: backendsOf(w.backends),
    pauses: pausesOf(w.pauses),
    stats7d: numbers(w.stats7d, new Set(['wakes', 'ignored', 'deferred'])) ?? null,
    settings: numbers(w.settings, new Set(['waitSeconds', 'idleMinutes', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders'])),
    // Its type and where each setting comes from (routers 0.37.0, settings at scale design §6): what a level reaches.
    type: typeof w.type === 'string' && TYPE_NAME.test(w.type) ? w.type : undefined,
    settingsFrom: settingsFromOf(w.settingsFrom),
  });
}

// A standalone workload's row (the router's handover, "The row"): the HTTP row's fields of both kinds, its kind and resource.
function standaloneOf(w: Json, cloud: Cloud | null): Json {
  const { targetGroupArn: _t, url: _u, wakeMode: _w, settings: _s, stats7d: _x, ...shared } = workloadOf({ ...w, kind: undefined }, cloud)!;
  const kept: Json = {};
  for (const [key, value] of Object.entries(shared)) {
    kept[key] = value;
    if (key === 'name') Object.assign(kept, defined({ kind: 'standalone', resourceArn: typeof w.resourceArn === 'string' && RESOURCE_ARN.test(w.resourceArn) ? w.resourceArn : undefined }));
    // Its resource deleted or untagged (the router's check): said after its backends, absent otherwise.
    if (key === 'backends' && w.resourceMissing === true) kept.resourceMissing = true;
    if (key === 'pauses') kept.stats7d = numbers(w.stats7d, new Set(['wakes'])) ?? null;
  }
  return defined({ ...kept, settings: standaloneSettingsOf(w.settings), type: kept.type, settingsFrom: kept.settingsFrom });
}

const TYPE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SETTING_KEYS = new Set(['idleMinutes', 'waitSeconds', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', ...IDLE_KEYS]);
const LEVELS = new Set(['workload', 'type', 'router', 'organization', 'default']);
// The known settings, each from a known level; none at all, undefined.
function settingsFromOf(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const kept = Object.fromEntries(Object.entries(value).filter(([key, level]) => SETTING_KEYS.has(key) && typeof level === 'string' && LEVELS.has(level)));
  return Object.keys(kept).length ? kept as Record<string, string> : undefined;
}

// The router's own fields of a check.
export function routerOf(d: Json) {
  const router = isObject(d.router) ? d.router : {};
  const health = isObject(d.health) && Buffer.byteLength(JSON.stringify(d.health)) <= HEALTH_MAX ? d.health : null;
  return {
    name: text(router.name, 64) ?? '',
    version: text(router.version, 32) ?? null,
    build: text(router.build, 64) ?? null,
    checkSchedule: text(router.checkSchedule, 64) ?? null,
    durationMs: count(d.durationMs) ?? null,
    health,
    pauses: pausesOf(d.pauses),
    counts: numbers(d.counts, STATES) ?? {},
  };
}

// The chunk of a check, or null when it cannot be one.
export function chunkOf(v: unknown) {
  if (!isObject(v)) return null;
  const { index, total } = v;
  return Number.isInteger(index) && Number.isInteger(total) && (total as number) >= 1 && (total as number) <= MAX_CHUNKS && (index as number) >= 0 && (index as number) < (total as number)
    ? { index: index as number, total: total as number }
    : null;
}
