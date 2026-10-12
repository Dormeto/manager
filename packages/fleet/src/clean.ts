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
    updatedAt: time(w.updatedAt),
    pendingWake: w.pendingWake === true,
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
