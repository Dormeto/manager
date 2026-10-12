// What a router event may store (vision scale design §4). Any principal of the organization can publish to the bus, so
// only the known fields are kept, each of its type and size, and a time ahead of the manager's clock is refused: a newer
// state always wins, so one event dated in the future would pin a summary for good.

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
export const regionOf = (v: unknown) => (typeof v === 'string' && /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(v) ? v : null);
// Workloads of one chunk: 64 KB hold far fewer.
export const CHUNK_WORKLOADS_MAX = 1000;

// A time the manager accepts: ISO, and not ahead of its clock by more than the skew.
export const timely = (v: unknown, now: number) => {
  const t = time(v);
  return t !== null && Date.parse(t) <= now + SKEW_MS ? t : null;
};

// A pause as shown: its known texts, each short.
const pauseOf = (p: unknown) => (isObject(p)
  ? defined({
    scope: text(p.scope, 16), workloadId: text(p.workloadId, 64) ?? (p.workloadId === null ? null : undefined), reason: text(p.reason, 300), by: text(p.by, 320),
    at: time(p.at) ?? undefined, until: time(p.until) ?? undefined, exclusionId: text(p.exclusionId, 64),
  })
  : null);
export const pausesOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, PAUSES_MAX).map(pauseOf).filter(Boolean) : []);

// The kinds of a workload's backends (routers 0.23.3): the known ones, once each.
const BACKEND_KINDS = new Set(['instance', 'asg', 'ecs', 'rds-instance', 'rds-cluster']);
const backendsOf = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === 'string' && BACKEND_KINDS.has(k)))] : undefined);

// Why a wake (or a nap) failed (routers 0.25.0, R7a): a known kind, else unknown; the message cut to 300 characters.
const FAILURE_KINDS = new Set(['capacity', 'quota', 'permission', 'configuration', 'unhealthy', 'throttled', 'timeout', 'unknown']);
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
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
export interface Fallback { instance: string; from: string; to: string }
const fallbacksOf = (v: unknown): Fallback[] | undefined => (Array.isArray(v)
  ? v.filter((f): f is Fallback => isObject(f) && typeof f.instance === 'string' && INSTANCE_ID.test(f.instance)
    && typeof f.from === 'string' && INSTANCE_TYPE.test(f.from) && typeof f.to === 'string' && INSTANCE_TYPE.test(f.to))
    .slice(0, 20).map(({ instance, from, to }) => ({ instance, from, to }))
  : undefined);

// What a nap stopped (routers 0.27.0, R9): the known kinds, well-formed, at most 50; what ran on Spot (0.28.0, R9.5).
const spotOf = (v: Record<string, unknown>) => (v.spot === true ? { spot: true } : {});
const TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const DB_CLASS = /^db\.[a-z0-9.]+$/;
const between = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function stoppedItemOf(v: unknown): Json | null {
  if (!isObject(v)) return null;
  if (v.kind === 'ec2' && typeof v.type === 'string' && TYPE.test(v.type) && between(v.count, 1, 10_000) && typeof v.os === 'string') return { kind: 'ec2', type: v.type, count: v.count, os: v.os.slice(0, 40), ...spotOf(v) };
  if (v.kind === 'fargate' && between(v.vcpu, 0.25, 64) && between(v.memoryGb, 0.5, 512) && between(v.count, 1, 10_000) && (v.arch === 'x86_64' || v.arch === 'arm64') && typeof v.os === 'string') {
    return { kind: 'fargate', vcpu: v.vcpu, memoryGb: v.memoryGb, count: v.count, arch: v.arch, os: v.os.slice(0, 40), ...spotOf(v) };
  }
  if (v.kind === 'rds' && typeof v.class === 'string' && DB_CLASS.test(v.class) && typeof v.engine === 'string') return { kind: 'rds', class: v.class, engine: v.engine.slice(0, 40), multiAz: v.multiAz === true };
  if (v.kind === 'aurora-serverless' && typeof v.engine === 'string' && between(v.acu, 0, 256)) return { kind: 'aurora-serverless', engine: v.engine.slice(0, 40), acu: v.acu };
  if (v.kind === 'unknown') return { kind: 'unknown', backend: text(v.backend, 200) ?? '', reason: text(v.reason, 200) ?? '' };
  return null;
}
export const stoppedOf = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).map(stoppedItemOf).filter((i): i is Json => i !== null) : undefined);

// What a state change event says of its transition, for the history (R8): what started it, its wake, the wake's
// duration, the failure, who asked it from the manager.
export function transitionOf(d: Json, at: string) {
  return defined({
    from: stateOf(d.from),
    cause: text(d.cause, 64),
    wakeId: text(d.wakeId, 64),
    durationMs: count(d.durationMs),
    failure: failureOf(d.failure, at),
    by: text(d.by, 320),
    stopped: stoppedOf(d.stopped),
  });
}

// A workload of a check, or null when it has no valid id.
export function workloadOf(w: unknown): Json | null {
  if (!isObject(w) || typeof w.workloadId !== 'string' || !WORKLOAD_ID.test(w.workloadId)) return null;
  return defined({
    workloadId: w.workloadId,
    name: text(w.name, 64),
    targetGroupArn: typeof w.targetGroupArn === 'string' && w.targetGroupArn.startsWith('arn:') ? w.targetGroupArn.slice(0, 512) : undefined,
    source: w.source === 'manager' ? 'manager' : 'terraform',
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
    fallbacks: fallbacksOf(w.fallbacks),
    updatedAt: time(w.updatedAt),
    pendingWake: w.pendingWake === true,
    backends: backendsOf(w.backends),
    pauses: pausesOf(w.pauses),
    stats7d: numbers(w.stats7d, new Set(['wakes', 'ignored', 'deferred'])) ?? null,
    settings: numbers(w.settings, new Set(['waitSeconds', 'idleMinutes', 'drainSeconds', 'wakeTimeoutSeconds', 'maxHolders'])),
  });
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
