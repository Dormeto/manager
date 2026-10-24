// The demo organization in memory (npm run dev:mock): built once per page load from the generated one (org.ts), relative to that
// time; the dashboard's actions change it (naps, wakes, pauses, renames, operations, discovery decisions, users) and
// what they start finishes over time, as the routers and the workflow would.
import type { Candidate, DiscoveryConfig, LintFinding, RunRecord, Status } from '@dormeto/discovery/types';
import type { Failure } from '../failures';
import type { Day, Schedule } from '../schedule';
import type { Me } from '../stores/session';
import type { ClusterCheck, DescriptionInfo, Exclusion, HistoryEntry, OperationType, Pause, Rule, SavingsSettings, Settings, StoppedItem } from '../types';
import {
  AVAILABLE, EC2_PRICES, PREVIOUS, FARGATE_PRICES, RDS_PRICES, TIME_ZONES, type BackendSpec, type CandidateSpec, type RouterSpec, type State, type WorkloadSpec,
} from './fixtures';
import { ACCOUNTS, ME, ORG, accountName } from './org';
import { bursts, checkAfter, entriesOf, sessions, wakeCause, type Burst } from './history';
import { DAY, HOUR, MINUTE, SECOND, hash, hex, iso, random, uuid } from './util';

export class MockError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string, body: Record<string, unknown> = {}): never => {
  throw new MockError(status, code, message, body);
};

export interface DemoRouter {
  name: string;
  account: string;
  region: string;
  source: 'terraform' | 'manager';
  version: string;
  build: string;
  installedAt: number;
  metrics: boolean | null;
  concurrency: RouterSpec['concurrency'];
  peak: number;
  clusters: ClusterCheck[];
  ownLists: NonNullable<RouterSpec['ownLists']>;
  pauses: Pause[];
  // EC2 hibernation (router 0.32.0): its own value (null: inherit), and whether it reads the manager's settings (a catalog).
  hibernate: boolean | null;
  hibernateBy: string | null;
  hibernateAt: number | null;
  readsManager: boolean;
  description: DescriptionInfo | null; // Markdown, by people (manager 0.19.0)
}

export interface DemoWorkload {
  workloadId: string;
  name: string;
  router: string;
  account: string;
  region: string;
  hosts: string[];
  wakeMode: 'any' | 'browser';
  source: 'terraform' | 'manager';
  tags: Record<string, string>; // R11: Dormeto's own tags
  schedule: Schedule | null; // R12
  hibernate: boolean | null; // its own value (null: inherit)
  description: DescriptionInfo | null;
  fallbackTypes: string[];
  settings: Settings;
  backends: BackendSpec[];
  items: { item: StoppedItem; hourly: number }[];
  itemsKnown: boolean; // what a nap stops is known from its first nap
  wakeMs: number;
  napMs: number;
  state: State;
  entries: HistoryEntry[];
  bursts: Burst[];
  pauses: Pause[]; // its own and its exclusions' (the router's are on the router)
  failure: Failure | null;
  consecutiveFailures: number;
  nextAttemptAt: number | null;
  awakeSince: number | null;
  wakeStartedAt: number | null;
  failedAt: number | null;
  updatedAt: number | null;
  pendingWake: boolean;
  pending: { to: State; at: number; durationMs?: number } | null;
  activeUntil: number; // requests keep coming until then (Infinity: its users are at work)
  lastRequestAt: number | null; // the last one, once they stopped
  wakeCount: number;
  targetGroupArn: string;
  loadBalancerArn: string;
  ruleArns: string[];
  priority: number;
  instanceId: string;
  drift: { at: string; kind: string; detail: string; by: string }[];
  wakeRules: Rule[];
  noWakeRules: Rule[];
  idleHours7d: number | null;
  requests7d: number | null;
  seed: number;
}

interface PlannedStep { name: string; start: number; end: number; outcome: 'done' | 'skipped' | 'failed'; detail?: string; every?: number }
export interface DemoOperation {
  id: string;
  type: OperationType;
  target: Record<string, string>;
  input: Record<string, unknown>;
  context?: Record<string, unknown>;
  by: string;
  createdAt: number;
  steps: PlannedStep[];
  error?: string;
  effect?: (at: number) => void;
  applied: boolean;
}

export interface DemoUser { email: string; role: string; status: string; enabled: boolean; createdAt: string | null; mfa: boolean | null; groups?: string[] }
export interface DemoGroup { name: string; description: string; grants: { tags: Record<string, string>; permissions: ('read' | 'wake' | 'nap')[] }[]; updatedAt: string | null; updatedBy: string | null }
export interface AuditEntry { id: string; at: string; who: string; role: string; action: string; target: string; result: string }
type StoredExclusion = Omit<Exclusion, 'expired' | 'lifting'>;

// The steps of each operation the workflow runs (packages/operations engine PLANS): not the manager's updates.
export type WorkflowType = Exclude<OperationType, 'update-manager'>;
const INSTALL = ['roles', 'table', 'queues', 'log groups', 'functions', 'async invoke', 'event source mappings', 'permissions', 'event rule', 'schedule'].map((s) => `install ${s}`);
const UNINSTALL = ['event rule', 'schedule', 'event source mappings', 'functions', 'queues', 'log groups', 'table', 'roles'].map((s) => `uninstall ${s}`);
const CLUSTER = ['access entries', 'check clusters'];
const PLANS: Record<WorkflowType, string[]> = {
  'install-router': ['find router', 'lock router', ...INSTALL, 'register router', ...CLUSTER, 'verify router'],
  'upgrade-router': ['find router', 'lock router', ...INSTALL, 'register router', ...CLUSTER, 'verify router'],
  'uninstall-router': ['find router', 'lock router', 'mark uninstalling', 'check empty', 'remove access entries', ...UNINSTALL, 'unregister router'],
  onboard: ['find router', 'lock router', ...INSTALL, 'register router', ...CLUSTER, 'slot', 'lock load balancer', 'preview', 'onboard', 'verify', 'candidate'],
  offboard: ['locate', 'slot', 'lock load balancer', 'pause', 'wait awake', 'offboard', 'candidate'],
  exclude: ['pause workloads'],
  'lift-exclusion': ['resume workloads'],
  'connect-account': ['forwarder role', 'forwarder rules', 'connected'],
  'disconnect-account': ['remove forwarder rules', 'remove forwarder role', 'disconnected'],
};

const CAPACITY = (type: string, zone: string) => `We currently do not have sufficient ${type} capacity in the Availability Zone you requested (${zone}). Our system will be working on provisioning additional capacity.`;

// --- Prices and backends ---------------------------------------------------------------------------------------------

const ALLOCATABLE: Record<string, { cpu: number; memoryGb: number }> = { 'm6i.large': { cpu: 1.93, memoryGb: 7.1 }, 'm6i.xlarge': { cpu: 3.92, memoryGb: 14.8 } };

export function itemOf(b: BackendSpec, region: string): { item: StoppedItem; hourly: number } {
  const ec2 = (type: string) => EC2_PRICES[region]?.[type] ?? 0.1;
  switch (b.kind) {
    case 'instance': return { item: { kind: 'ec2', type: b.type, count: 1, os: 'Linux' }, hourly: ec2(b.type) };
    case 'asg': return { item: { kind: 'ec2', type: b.type, count: b.count, os: 'Linux' }, hourly: ec2(b.type) * b.count };
    case 'ecs': {
      const [cpu, memory] = FARGATE_PRICES[region] ?? [0.04048, 0.004445];
      return {
        item: { kind: 'fargate', vcpu: b.vcpu, memoryGb: b.memoryGb, count: b.count, arch: b.arm ? 'arm64' : 'x86_64', os: 'Linux' },
        hourly: b.count * (b.vcpu * cpu + b.memoryGb * memory) * (b.arm ? 0.8 : 1),
      };
    }
    case 'k8s': {
      const allocatable = ALLOCATABLE[b.nodeType] ?? { cpu: 3.92, memoryGb: 14.8 };
      const share = Math.max(b.vcpu / allocatable.cpu, b.memoryGb / allocatable.memoryGb);
      return {
        item: { kind: 'k8s-pods', count: b.count, cpu: b.vcpu, memoryGb: b.memoryGb, nodeType: b.nodeType, os: 'Linux', autoscaled: true, allocatable },
        hourly: b.count * share * ec2(b.nodeType),
      };
    }
    case 'rds': return { item: { kind: 'rds', class: b.class, engine: 'postgres', multiAz: false }, hourly: RDS_PRICES[region]?.[b.class] ?? 0.1 };
  }
}

// How long a wake and a nap take with these backends (a database is the slowest).
function timings(backends: BackendSpec[]): { wake: [number, number]; nap: number } {
  const wake = { instance: [45, 70], asg: [110, 170], ecs: [40, 75], k8s: [25, 55], rds: [360, 470] } as const;
  const stop = { instance: 40, asg: 60, ecs: 20, k8s: 10, rds: 150 } as const;
  let range: [number, number] = [0, 0];
  let nap = 0;
  for (const b of backends) {
    const w: readonly [number, number] = b.kind === 'asg' && b.warmPool ? [60, 90] : wake[b.kind];
    if (w[1] > range[1]) range = [w[0], w[1]];
    nap = Math.max(nap, stop[b.kind]);
  }
  return { wake: range, nap: (30 + nap) * SECOND };
}

const settingsOf = (backends: BackendSpec[], idleMinutes: number): Settings => ({
  waitSeconds: 60, idleMinutes, drainSeconds: 30, maxHolders: 50,
  wakeTimeoutSeconds: backends.some((b) => b.kind === 'rds') ? 1800 : backends.some((b) => b.kind === 'k8s') ? 300 : 600,
});

const lbKey = (account: string, region: string) => `${account}/${region}`;
const lbOf = (account: string, region: string) => ORG.loadBalancers[lbKey(account, region)] ?? { name: `${accountName(account)}-alb`, cluster: 'apps' };
export const lbArn = (account: string, region: string) => `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/${lbOf(account, region).name}/${hex(`lb:${account}:${region}`, 16)}`;
export const tgArn = (account: string, region: string, name: string) => `arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/${name}/${hex(`tg:${account}:${region}:${name}`, 16)}`;
const ruleArn = (account: string, region: string, name: string, i: number) =>
  `arn:aws:elasticloadbalancing:${region}:${account}:listener-rule/app/${lbOf(account, region).name}/${hex(`lb:${account}:${region}`, 16)}/${hex(`listener:${account}:${region}`, 16)}/${hex(`rule:${name}:${i}`, 16)}`;
export const ecsCluster = (account: string, region: string) => lbOf(account, region).cluster;

// Hours of the last 7 days without any request, and the requests (discovery's figures, from the load balancer).
function idleOf(list: Burst[], now: number): { idleHours7d: number; requests7d: number } {
  const end = Math.floor(now / HOUR) * HOUR;
  const start = end - 168 * HOUR;
  const busy = new Set<number>();
  let requests = 0;
  for (const b of list) {
    if (b.end <= start || b.start >= end) continue;
    requests += b.requests;
    for (let h = Math.floor(Math.max(b.start, start) / HOUR); h * HOUR < Math.min(b.end, end); h += 1) busy.add(h);
  }
  return { idleHours7d: 168 - busy.size, requests7d: requests };
}

// --- The state ---------------------------------------------------------------------------------------------------------

export interface Demo {
  t0: number;
  me: Me;
  preferences: { refreshSeconds: number; dismissedUpdate?: string };
  updateCheck: { enabled: boolean; alert: boolean; updatedAt: string | null; updatedBy: string | null };
  savings: SavingsSettings;
  hibernation: { hibernate: boolean; updatedAt: string | null; updatedBy: string | null }; // the manager's default for every workload
  routers: DemoRouter[];
  workloads: DemoWorkload[];
  candidates: Candidate[];
  exclusions: StoredExclusion[];
  operations: DemoOperation[];
  runs: { record: RunRecord; finishAt: number }[];
  config: { config: DiscoveryConfig; updatedAt: string | null; updatedBy: string | null };
  users: DemoUser[];
  groups: DemoGroup[];
  audit: AuditEntry[];
}

let demo: Demo | null = null;
export function state(): Demo {
  demo ??= build(Date.now());
  return demo;
}

function makeRouter(spec: RouterSpec, now: number): DemoRouter {
  return {
    name: spec.name, account: spec.account, region: spec.region, source: spec.source, version: spec.version, build: spec.build,
    installedAt: now - spec.installedDays * DAY, metrics: spec.metrics, concurrency: spec.concurrency, peak: spec.peak,
    clusters: (spec.clusters ?? []).map((name) => ({ name, reachable: true, allowed: true, missing: [], checkedAt: iso(now - 2 * DAY - 3 * HOUR) })),
    ownLists: spec.ownLists ?? [], pauses: [], hibernate: null, hibernateBy: null, hibernateAt: null, readsManager: true, description: null,
  };
}

// R12: the schedules some demo workloads have, of different shapes (office hours of different lengths, nights asleep with and
// without the wake header, weekends asleep, holidays, a maximum nap only), given in turn to every other workload of the scenario (build).
const WEEK: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const BY = { by: 'ops@dormeto.example', at: '2026-10-01T09:00:00.000Z' };
const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const SCHEDULES: (() => Schedule)[] = [
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: WEEK, start: '08:00', end: '18:00' },
    { kind: 'nap', days: WEEK, start: '20:00', end: '07:00', wake: 'header' },
    { kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00' },
  ], maxNapDays: 7, ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: WEEK, start: '07:30', end: '20:00' },
    { kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00', wake: 'never' },
  ], ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: WEEK, start: '09:00', end: '17:30' },
    { kind: 'nap', days: WEEK, start: '19:00', end: '08:00', wake: 'never' },
  ], maxNapDays: 10, ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '22:00', end: '06:00', wake: 'header' },
  ], ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'nap', days: WEEK, start: '21:00', end: '07:00', wake: 'never' },
    { kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00', wake: 'header' },
  ], ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: WEEK, start: '08:30', end: '19:00' },
    { kind: 'nap', days: WEEK, start: '20:00', end: '07:00', wake: 'header' },
  ], exceptions: [dateIn(2), dateIn(9)], maxNapDays: 7, ...BY }),
  () => ({ maxNapDays: 14, timeZone: 'Europe/Paris', ...BY }),
  () => ({ timeZone: 'America/New_York', windows: [
    { kind: 'awake', days: WEEK, start: '09:00', end: '18:00' },
    { kind: 'nap', days: WEEK, start: '19:30', end: '08:00', wake: 'header' },
    { kind: 'nap', days: ['sat'], start: '00:00', end: '00:00', wake: 'never' },
  ], ...BY }),
  () => ({ timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: ['mon', 'tue', 'wed', 'thu'], start: '08:00', end: '19:30' },
    { kind: 'awake', days: ['fri'], start: '08:00', end: '16:00' },
    { kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00', wake: 'never' },
  ], ...BY }),
];

// R11: the demo's teams, whose workloads the groups below pick by their team tag.
const TEAMS = ['payments', 'platform', 'data', 'web'];

function baseWorkload(fields: { name: string; router: DemoRouter; backends: BackendSpec[]; idleMinutes: number; wakeMode: 'any' | 'browser'; source: 'terraform' | 'manager'; hosts: string[] }): DemoWorkload {
  const { name, router, backends } = fields;
  const { account, region } = router;
  const time = timings(backends);
  const seed = hash(name);
  return {
    workloadId: hex(`workload:${name}`, 16), name, router: router.name, account, region, hosts: fields.hosts, wakeMode: fields.wakeMode, source: fields.source,
    tags: { team: TEAMS[seed % TEAMS.length]!, env: seed % 3 === 0 ? 'staging' : 'dev' },
    schedule: null, hibernate: null, description: null, fallbackTypes: [],
    settings: settingsOf(backends, fields.idleMinutes), backends, items: backends.map((b) => itemOf(b, region)), itemsKnown: true,
    wakeMs: ((time.wake[0] + time.wake[1]) / 2) * SECOND, napMs: time.nap, state: 'ASLEEP', entries: [], bursts: [], pauses: [],
    failure: null, consecutiveFailures: 0, nextAttemptAt: null, awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null,
    pendingWake: false, pending: null, activeUntil: 0, lastRequestAt: null, wakeCount: 0,
    targetGroupArn: tgArn(account, region, name), loadBalancerArn: lbArn(account, region), ruleArns: fields.hosts.map((_, i) => ruleArn(account, region, name, i)),
    priority: 10 + (seed % 80), instanceId: `i-0${hex(`instance:${name}`, 16)}`, drift: [], wakeRules: [], noWakeRules: [], idleHours7d: null, requests7d: null, seed,
  };
}

// A generated workload with its history: its users' requests, then the end its current state needs.
function buildWorkload(spec: WorkloadSpec, router: DemoRouter, now: number): DemoWorkload {
  const w = baseWorkload({ ...spec, router, hosts: spec.hosts ?? [`${spec.name}.${ORG.scenario.domain}`] });
  w.wakeRules = spec.wakeRules ?? [];
  w.noWakeRules = spec.noWakeRules ?? [];
  const seed = `${ORG.scenario.seed}:${spec.name}`;
  const r = random(`history:${seed}`);
  const tz = TIME_ZONES[router.region] ?? 0;
  const time = timings(spec.backends);
  const wake = () => Math.round(r.between(time.wake[0], time.wake[1])) * SECOND;
  const idleMs = spec.idleMinutes * MINUTE;
  const rule = w.wakeRules[0]?.name ?? null;
  const cause = () => wakeCause(r, spec.wakeMode === 'browser', rule, ORG.actors[0]);
  const since = now - (spec.days ?? 40) * DAY - r.between(0, 6) * HOUR;

  // The end of the history its state needs, and where the generated days stop.
  const tail: HistoryEntry[] = [];
  const tailBursts: Burst[] = [];
  let cut = now - 3 * MINUTE;
  if (spec.state === 'AWAKE') {
    const start = spec.paused ? now - spec.paused.hoursAgo * HOUR : now - (spec.awakeFor ?? 90) * MINUTE;
    const ms = wake();
    cut = start - 10 * MINUTE;
    tail.push({ from: 'ASLEEP', to: 'WAKING', at: iso(start), ...(spec.paused ? { cause: 'pause', by: spec.paused.by } : cause()) });
    tail.push({ from: 'WAKING', to: 'AWAKE', at: iso(start + ms), durationMs: ms });
    tailBursts.push({ start, end: start + 3 * MINUTE, requests: 14 }, ...bursts(seed, spec.profile, tz, start + 4 * MINUTE, now - MINUTE));
    w.activeUntil = Infinity;
  } else if (spec.state === 'NAPPING') {
    const napStart = now - 25 * SECOND;
    const start = napStart - idleMs - r.between(40, 110) * MINUTE;
    const ms = wake();
    cut = start - 10 * MINUTE;
    tail.push({ from: 'ASLEEP', to: 'WAKING', at: iso(start), ...cause() }, { from: 'WAKING', to: 'AWAKE', at: iso(start + ms), durationMs: ms });
    tail.push({ from: 'AWAKE', to: 'NAPPING', at: iso(napStart), cause: 'idle' });
    tailBursts.push(...bursts(seed, 'busy', tz, start, napStart - idleMs), { start, end: start + 2 * MINUTE, requests: 9 });
    w.pending = { to: 'ASLEEP', at: napStart + w.napMs };
    w.lastRequestAt = napStart - idleMs - 20 * SECOND;
  } else if (spec.state === 'WAKING') {
    const start = now - (spec.backends.some((b) => b.kind === 'rds') ? 150 : 20) * SECOND;
    const ms = Math.max(wake(), now - start + 45 * SECOND);
    cut = start - 10 * MINUTE;
    tail.push({ from: 'ASLEEP', to: 'WAKING', at: iso(start), ...cause() });
    tailBursts.push({ start, end: start + MINUTE, requests: 3 });
    w.pending = { to: 'AWAKE', at: start + ms, durationMs: ms };
    w.activeUntil = start + ms + 20 * MINUTE;
    w.lastRequestAt = start;
  } else if (spec.state === 'FAILED') {
    // Two wakes in a row without capacity for its instance type (no fallback type set).
    const instance = spec.backends.find((b): b is Extract<BackendSpec, { kind: 'instance' }> => b.kind === 'instance');
    const type = instance?.type ?? 'm6i.large';
    const zone = `${router.region}a`;
    const [first, second] = [now - 47 * MINUTE, now - 9 * MINUTE];
    const failure = (at: number): Failure => ({ kind: 'capacity', step: 'wake', backend: `instance:${w.instanceId}`, message: CAPACITY(type, zone), at: iso(at) });
    cut = first - 10 * MINUTE;
    tail.push({ from: 'ASLEEP', to: 'WAKING', at: iso(first), ...cause() });
    tail.push({ from: 'WAKING', to: 'FAILED', at: iso(first + 38 * SECOND), failure: { kind: 'capacity', step: 'wake', message: CAPACITY(type, zone) } });
    tail.push({ from: 'FAILED', to: 'WAKING', at: iso(second), cause: spec.wakeMode === 'browser' ? 'probe' : 'normal' });
    tail.push({ from: 'WAKING', to: 'FAILED', at: iso(second + 41 * SECOND), failure: { kind: 'capacity', step: 'wake', message: CAPACITY(type, zone) } });
    tailBursts.push({ start: first, end: first + MINUTE, requests: 2 }, { start: second, end: second + MINUTE, requests: 4 });
    w.failure = failure(second + 41 * SECOND);
    w.consecutiveFailures = 2;
    w.nextAttemptAt = second + 41 * SECOND + 120 * SECOND;
    w.lastRequestAt = second + MINUTE;
  }

  const generated = bursts(seed, spec.profile, tz, since, cut, spec.noise ?? 0);
  const kept = sessions(generated.filter((b) => !b.noise), idleMs, wake, w.napMs).filter((s) => s.start > since + MINUTE && s.asleep < cut);
  const lastAsleep = kept.at(-1)?.asleep ?? since;
  const nap = () => (r.chance(0.03) ? { cause: 'manager', by: ORG.actors[1] } : { cause: 'idle' });
  w.entries = [{ from: null, to: 'ASLEEP', at: iso(since) }, ...entriesOf(kept, () => cause(), nap), ...tail];
  w.bursts = [...generated.filter((b) => b.noise || b.start < lastAsleep), ...tailBursts].sort((a, b) => a.start - b.start);
  if (spec.state === 'ASLEEP') w.lastRequestAt = [...w.bursts].reverse().find((b) => !b.noise)?.end ?? null;

  w.state = spec.state;
  const last = (to: string) => {
    const e = [...w.entries].reverse().find((x) => x.to === to);
    return e ? Date.parse(e.at) : null;
  };
  w.awakeSince = last('AWAKE');
  w.wakeStartedAt = last('WAKING');
  w.failedAt = last('FAILED');
  w.updatedAt = Date.parse(w.entries.at(-1)!.at);
  w.wakeCount = w.entries.filter((e) => e.to === 'WAKING').length + (spec.days ? 0 : r.int(15, 80));
  if (spec.paused) {
    w.pauses = [{
      scope: 'workload', by: spec.paused.by, at: iso(now - spec.paused.hoursAgo * HOUR), reason: spec.paused.reason,
      until: spec.paused.untilHours === null ? null : iso(now + spec.paused.untilHours * HOUR), keepAsleep: false,
    }];
  }
  if (spec.drift) {
    w.drift = [{
      at: iso(now - 3 * DAY - 2 * HOUR), kind: 'waker forward removed', by: `arn:aws:sts::${router.account}:assumed-role/terraform-ci/apply`,
      detail: `rule priority ${w.priority + 1} forwarded to the application only: the waker target group was put back`,
    }];
  }
  Object.assign(w, idleOf(w.bursts, now));
  return w;
}

// A discovery candidate: a target group with every rule forwarding to it, or a rule alone.
function candidateOf(fields: {
  name: string; account: string; region: string; host: string; backend: Candidate['backend']; eligibility: Candidate['eligibility']; reason?: string;
  workloadId?: string; idleHours7d: number | null; requests7d: number | null; firstSeenAt: number; ruleOnly?: boolean; rules?: string[]; priority?: number;
}, lastSeen: number): Candidate {
  const { name, account, region } = fields;
  const lb = lbOf(account, region).name;
  const tg = fields.ruleOnly ? null : tgArn(account, region, name);
  const hosts = fields.rules?.length ? fields.rules : [fields.host];
  const priority = fields.priority ?? 10 + (hash(name) % 80);
  const rules = hosts.map((h, i) => ({
    id: ruleArn(account, region, name, i), listener: 'HTTPS:443', priority: String(priority + i), conditions: `host ${h}`, hosts: [h], managed: Boolean(fields.workloadId),
  }));
  const first = rules[0]!;
  const org = ACCOUNTS.find((a) => a.id === account);
  return {
    id: tg ?? first.id, account, region, loadBalancer: lb, loadBalancerArn: lbArn(account, region), listener: first.listener, priority: first.priority,
    conditions: `${first.conditions}${rules.length > 1 ? ` (+${rules.length - 1} rules)` : ''}`, hosts, targetGroup: tg ? name : null, targetGroupArn: tg,
    backend: fields.backend, tags: { environment: [environmentOf(accountName(account))], ...(fields.workloadId ? { 'dormeto:workload': [fields.workloadId] } : {}) },
    rules, eligibility: fields.eligibility, ...(fields.reason ? { reason: fields.reason } : {}), ...(fields.workloadId ? { workloadId: fields.workloadId } : {}),
    idleHours7d: fields.idleHours7d, requests7d: fields.requests7d, accountName: accountName(account), ouPath: [ORG.root, org?.ou ?? ORG.ous.nonprod],
    scope: 'in', scopeReason: IN_SCOPE, status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: iso(fields.firstSeenAt), lastSeenAt: iso(lastSeen), history: [],
  };
}
const IN_SCOPE = 'in scope: filter "non-production", include 1';
// The environment tag of an account's resources, from its name.
const environmentOf = (name: string) => (name.includes('staging') ? 'staging' : name.includes('qa') ? 'qa' : 'dev');

// The backend discovery records for a workload or a candidate.
function discoveredBackend(kind: string, name: string, account: string, region: string, extra: Partial<NonNullable<Candidate['backend']>> = {}): NonNullable<Candidate['backend']> {
  if (kind === 'instance') return { kind: 'instance', id: `i-0${hex(`instance:${name}`, 16)}`, ...extra };
  if (kind === 'asg') return { kind: 'asg', id: `${name}-asg`, ...extra };
  if (kind === 'k8s') return { kind: 'k8s', id: `${extra.kubernetes?.cluster ?? ORG.cluster ?? 'eks'}/${extra.kubernetes?.namespace ?? name}/Deployment/${extra.kubernetes?.owner.name ?? name}`, ...extra };
  const arn = `arn:aws:ecs:${region}:${account}:service/${ecsCluster(account, region)}/${name}`;
  return { kind: 'ecs', id: arn, arn, ...extra };
}

function workloadBackend(w: DemoWorkload): NonNullable<Candidate['backend']> {
  const b = w.backends[0]!;
  if (b.kind === 'k8s') {
    return { kind: 'k8s', id: `${b.cluster}/${b.namespace}/Deployment/${b.owner}` };
  }
  return discoveredBackend(b.kind === 'rds' ? 'instance' : b.kind, w.name, w.account, w.region);
}

function managedCandidate(w: DemoWorkload, firstSeenAt: number, lastSeen: number): Candidate {
  return candidateOf({
    name: w.name, account: w.account, region: w.region, host: w.hosts[0]!, rules: w.hosts, priority: w.priority, backend: workloadBackend(w), eligibility: 'managed',
    workloadId: w.workloadId, idleHours7d: w.idleHours7d, requests7d: w.requests7d, firstSeenAt,
  }, lastSeen);
}

// A candidate's status (discovery lifecycle computeStatus): gone, managed (to offboard when excluded), dismissed,
// excluded, ineligible, to onboard.
export function decide(d: Demo, c: Candidate, now: number): { status: Status; statusReason: string; scope: Candidate['scope']; scopeReason: string } {
  const exclusion = activeExclusions(d, now).find((e) => matches(e, c));
  const scope: Candidate['scope'] = exclusion ? 'excluded' : 'in';
  const scopeReason = exclusion ? `excluded: manual exclusion by ${exclusion.by}: ${exclusion.reason}` : IN_SCOPE;
  const managed = c.eligibility === 'managed';
  const out = (status: Status, statusReason: string) => ({ status, statusReason, scope, scopeReason });
  if (c.goneAt) return out('gone', managed ? 'managed rule not found in the last scan: offboard it' : 'not found in the last scan');
  if (managed) return scope === 'in' ? out('managed', 'managed') : out('pending-offboarding', scopeReason);
  if (c.dismissed) return out('dismissed', `dismissed by ${c.dismissed.by}${c.dismissed.note ? `: ${c.dismissed.note}` : ''}`);
  if (scope === 'excluded') return out('excluded', scopeReason);
  if (c.eligibility === 'ineligible') return out('ineligible', c.reason ?? 'ineligible');
  return out('pending-onboarding', 'eligible');
}

export function restatus(d: Demo, now: number): number {
  let changed = 0;
  for (const c of d.candidates) {
    const next = decide(d, c, now);
    const moved = c.status !== next.status || c.statusReason !== next.statusReason;
    Object.assign(c, next);
    if (moved) {
      c.history = [...c.history, { at: iso(now), status: next.status, reason: next.statusReason }].slice(-20);
      changed += 1;
    }
  }
  return changed;
}

export const activeExclusions = (d: Demo, now: number) => d.exclusions.filter((e) => !e.liftedAt && !(e.expiresAt && Date.parse(e.expiresAt) <= now));
export function matches(e: StoredExclusion, c: { account: string; targetGroupArn: string | null; loadBalancerArn: string }): boolean {
  if (e.target.kind === 'account') return c.account === e.target.account;
  if (e.target.kind === 'load-balancer') return c.loadBalancerArn === e.target.arn;
  return c.targetGroupArn === e.target.arn;
}

// Each place a workload's hibernation can come from, among the demo's routers and workloads: the first router reads no manager
// settings (built-in default), the others read them; some workloads set a value of their own or have fallback instance types
// (a router's own value is set from the dashboard).
function seedHibernation(routers: DemoRouter[], workloads: DemoWorkload[]): void {
  // The first router is written in Terraform without a catalog: it reads no manager settings.
  routers[0]!.readsManager = false;
  workloads.forEach((w, i) => {
    if (i % 9 === 2) w.hibernate = w.source === 'manager' ? false : true;
    else if (i % 9 === 5 && w.source === 'manager') w.fallbackTypes = ['m6i.large', 'm5.large'];
  });
}

// A few descriptions with a heading, a list and a link, written by people: the first router and some workloads have one.
function seedDescriptions(routers: DemoRouter[], workloads: DemoWorkload[], now: number): void {
  const by = (i: number) => ['fab@example.com', 'ops@example.com'][i % 2]!;
  routers[0]!.description = {
    text: '# Production routers of the shop team\n\nOwned by **platform**. Escalate to the on-call:\n\n- page *platform-oncall* first\n- runbook: [router runbook](https://wiki.example.com/runbooks/router)',
    by: by(0), at: iso(now - 9 * DAY),
  };
  workloads.forEach((w, i) => {
    if (i % 4 !== 1) return;
    w.description = {
      text: `# ${w.name}\n\nStorefront for the **${w.tags.team ?? 'shop'}** team. Naps overnight.\n\n1. check the health page after a wake\n2. open [the dashboard](https://wiki.example.com/dashboards/${w.name})\n\n> Wakes on the first browser request.`,
      by: by(i), at: iso(now - (i + 1) * DAY),
    };
  });
}

function build(now: number): Demo {
  const routers = ORG.routers.map((r) => makeRouter(r, now));
  const workloads = ORG.workloads.map((spec) => buildWorkload(spec, routers.find((r) => r.name === spec.router)!, now));
  seedHibernation(routers, workloads);
  seedDescriptions(routers, workloads, now);
  workloads.forEach((w, i) => { if (i % 2 === 0) w.schedule = SCHEDULES[(i / 2) % SCHEDULES.length]!(); });
  const lastRun = now - 2 * HOUR - 13 * MINUTE;
  const d: Demo = {
    t0: now,
    me: { email: ME, role: 'admin', effectiveRole: 'admin', mfa: { mode: 'optional', enabled: true, required: false, method: 'app', passkeys: true } },
    preferences: { refreshSeconds: 10 },
    updateCheck: { enabled: false, alert: false, updatedAt: null, updatedBy: null },
    savings: { compute: 0, databases: 0, updatedAt: null, updatedBy: null },
    hibernation: { hibernate: true, updatedAt: iso(now - 5 * DAY - 2 * HOUR), updatedBy: ME },
    routers,
    workloads,
    candidates: [],
    exclusions: [],
    operations: [],
    runs: [],
    config: { config: configOf(), updatedAt: iso(now - 3 * DAY - 5 * HOUR), updatedBy: ME },
    users: ORG.people.map((u) => ({ email: u.email, role: u.role, status: u.status, enabled: u.enabled, createdAt: iso(now - u.createdDays * DAY - 4 * HOUR), mfa: u.mfa })),
    groups: [
      { name: 'payments', description: 'The payments team: its workloads, to wake and nap', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }], updatedAt: iso(now - 6 * DAY), updatedBy: ME },
      { name: 'auditors', description: 'Read-only on staging', grants: [{ tags: { env: 'staging' }, permissions: ['read'] }], updatedAt: iso(now - 12 * DAY), updatedBy: ME },
    ],
    audit: [],
  };

  // Discovery: a candidate per workload, and the generated ones.
  d.candidates = [
    ...workloads.map((w) => managedCandidate(w, Date.parse(w.entries[0]!.at) - 2 * DAY, lastRun)),
    ...ORG.candidates.map((c) => specCandidate(c, now, lastRun)),
  ].sort((a, b) => a.account.localeCompare(b.account) || a.region.localeCompare(b.region) || a.id.localeCompare(b.id));
  // The exclusions: a candidate's target group, an account for a while.
  for (const spec of ORG.candidates) {
    const c = spec.excluded && d.candidates.find((x) => x.targetGroup === spec.name);
    if (!c || !spec.excluded) continue;
    d.exclusions.push({
      id: uuid(`exclusion:${spec.name}`), target: { kind: 'target-group', arn: c.targetGroupArn!, account: c.account, region: c.region, name: spec.name },
      reason: spec.excluded.reason, by: spec.excluded.by, at: iso(now - spec.excluded.daysAgo * DAY - 3 * HOUR),
    });
  }
  const ex = ORG.accountExclusion;
  if (ex) {
    d.exclusions.push({
      id: uuid(`exclusion:${ex.account}`), target: { kind: 'account', account: ex.account, name: accountName(ex.account) }, reason: ex.reason,
      by: ex.by, at: iso(now - ex.daysAgo * DAY - 2 * HOUR), expiresAt: iso(now + ex.expiresInDays * DAY),
    });
  }
  // Each candidate's history: first seen to onboard, then what it became.
  for (const c of d.candidates) {
    const next = decide(d, c, now);
    Object.assign(c, next);
    const first = { at: c.firstSeenAt, status: (c.eligibility === 'ineligible' ? 'ineligible' : 'pending-onboarding') as Status, reason: c.eligibility === 'ineligible' ? c.reason ?? '' : 'eligible' };
    c.history = next.status === first.status ? [first] : [first, { at: iso(Math.min(now, Date.parse(c.firstSeenAt) + 2 * DAY)), status: next.status, reason: next.statusReason }];
  }

  d.runs = [{ record: runRecord(d, lastRun, lastRun + 47 * SECOND, 'schedule'), finishAt: lastRun + 47 * SECOND }];
  for (const w of workloads) {
    const ids = hibernatedIds(d, w);
    if (ids.length) for (const e of w.entries) if (e.from === 'NAPPING' && e.to === 'ASLEEP') e.hibernated = ids;
  }
  seedOperations(d, now);
  seedAudit(d, now);
  return d;
}

function specCandidate(c: CandidateSpec, now: number, lastRun: number): Candidate {
  const backend = c.backend ? discoveredBackend(c.backend.kind, c.name, c.account, c.region, c.backend.kubernetes ? { kubernetes: c.backend.kubernetes } : {}) : null;
  const candidate = candidateOf({
    name: c.name, account: c.account, region: c.region, host: c.host, backend, eligibility: c.status === 'ineligible' ? 'ineligible' : 'eligible',
    ...(c.reason ? { reason: c.reason } : {}), idleHours7d: c.idleHours7d, requests7d: c.requests7d, firstSeenAt: now - c.firstSeenDays * DAY - 5 * HOUR, ruleOnly: c.ruleOnly,
  }, c.goneDays ? now - c.goneDays * DAY : lastRun);
  if (c.dismissed) candidate.dismissed = { by: c.dismissed.by, at: iso(now - c.dismissed.daysAgo * DAY), note: c.dismissed.note };
  if (c.goneDays) candidate.goneAt = iso(now - c.goneDays * DAY + 47 * SECOND);
  return candidate;
}

// The perimeter: the non-production OU and the accounts tagged so, previews by host; never production.
const configOf = (): DiscoveryConfig => ({
  version: 1, mode: 'organization', regions: [...ORG.scenario.regions], refreshHours: 6,
  globalExcludes: [{ note: 'production', accountTags: { environment: ['production'] } }],
  filters: [
    { name: 'non-production', include: [{ ouIds: [ORG.ous.nonprod, ORG.ous.sandbox] }, { accountTags: { environment: ['dev', 'staging', 'qa'] } }], exclude: [{ hosts: ['status.*'] }] },
    { name: 'previews', include: [{ hosts: [`preview-*.${ORG.scenario.domain}`] }, { resourceTags: { team: ['marketing'] }, regions: [ORG.scenario.regions[0]!] }], exclude: [] },
  ],
  eventRefresh: { enabled: true },
});
export const lintOf = (config: DiscoveryConfig): LintFinding[] => (config.filters.some((f) => f.name === 'previews' && f.include.length > 1)
  ? [{ code: 'include-matches-nothing', level: 'info', filter: 'previews', include: 2, message: 'filter "previews", include 2 matched no rule in the last run' }]
  : []);

// A discovery run's record: the account-regions with rules, the empty and skipped ones, the counts.
export function runRecord(d: Demo, startedAt: number, finishedAt: number, trigger: 'schedule' | 'manual', by?: string): RunRecord {
  const pairs = new Map<string, number>();
  for (const c of d.candidates) {
    if (c.goneAt || c.account === ORG.accountExclusion?.account) continue;
    pairs.set(`${c.account} ${c.region}`, (pairs.get(`${c.account} ${c.region}`) ?? 0) + 1);
  }
  const r = random(`run:${startedAt}`);
  const counts: Partial<Record<Status, number>> = {};
  for (const c of d.candidates) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return {
    startedAt: iso(startedAt), finishedAt: iso(finishedAt), trigger, ...(by ? { by } : {}), status: 'ok',
    targets: [...pairs].map(([key, rules]) => {
      const [account, region] = key.split(' ') as [string, string];
      return { account, region, status: 'ok' as const, rules, ms: Math.round(r.between(900, 3200)) };
    }),
    emptyPairs: 8,
    skipped: [{ reason: 'excluded account', accounts: 1, pairs: 3 }, { reason: 'no load balancer in the last 3 scans', accounts: 3, pairs: 4 }],
    counts, lint: lintOf(d.config.config), delegation: 'ok',
  };
}

// --- Workload transitions ----------------------------------------------------------------------------------------------

export const routerOf = (d: Demo, name: string) => d.routers.find((r) => r.name === name) ?? fail(404, 'not_found', `unknown router: ${name}`);
export const workloadOf = (d: Demo, router: string, id: string) => {
  routerOf(d, router);
  return d.workloads.find((w) => w.router === router && w.workloadId === id) ?? fail(404, 'not_found', `workload not configured: ${id}`);
};
// Its pauses as the router reports them: its own, its exclusions', its router's.
export const pausesOf = (d: Demo, w: DemoWorkload): Pause[] => [...w.pauses, ...(d.routers.find((r) => r.name === w.router)?.pauses ?? [])];

export function change(w: DemoWorkload, to: State, at: number, extra: Partial<HistoryEntry> = {}): void {
  w.entries.push({ from: w.state, to, at: iso(at), ...extra });
  w.state = to;
  w.updatedAt = at;
  w.pending = null;
  if (to === 'WAKING') {
    w.wakeStartedAt = at;
    w.wakeCount += 1;
    const ms = Math.round(w.wakeMs * (0.85 + Math.random() * 0.3));
    w.pending = { to: 'AWAKE', at: at + ms, durationMs: ms };
  } else if (to === 'AWAKE') {
    w.awakeSince = at;
    w.failure = null;
    w.consecutiveFailures = 0;
    w.nextAttemptAt = null;
  } else if (to === 'NAPPING') {
    w.pending = { to: 'ASLEEP', at: at + w.napMs };
  } else if (to === 'ASLEEP') {
    // Its first nap tells what it stops (router 0.27.0).
    w.itemsKnown = true;
    if (w.pendingWake) {
      w.pendingWake = false;
      change(w, 'WAKING', at, { cause: 'pending-wake' });
    }
  }
}

// Requests keep an awake workload awake; once they stop, it naps at the idle check after its idle window.
export function lastRequest(w: DemoWorkload, now: number): number | null {
  if (w.state !== 'AWAKE') return w.lastRequestAt;
  if (w.activeUntil === Infinity) return now - ((((Math.floor(now / 10_000) + w.seed) % 17) * 10) + 4) * SECOND;
  return Math.min(now, w.activeUntil);
}

// Everything due by now: workload transitions, idle naps, pauses ending, operations ending, the discovery run.
export function advance(d: Demo, now: number): void {
  for (const r of d.routers) r.pauses = r.pauses.filter((p) => !p.until || Date.parse(p.until) > now);
  for (const w of d.workloads) {
    w.pauses = w.pauses.filter((p) => p.exclusionId || !p.until || Date.parse(p.until) > now);
    for (let guard = 0; guard < 8; guard += 1) {
      if (w.pending && w.pending.at <= now) {
        const { to, at, durationMs } = w.pending;
        change(w, to, at, durationMs ? { durationMs } : {});
        continue;
      }
      if (w.state === 'AWAKE' && w.activeUntil !== Infinity && !pausesOf(d, w).length) {
        const napAt = Math.max(checkAfter(w.activeUntil + w.settings.idleMinutes * MINUTE), (w.updatedAt ?? 0) + MINUTE);
        if (napAt <= now) {
          w.lastRequestAt = w.activeUntil;
          change(w, 'NAPPING', napAt, { cause: 'idle' });
          continue;
        }
      }
      break;
    }
  }
  for (const op of d.operations) {
    if (op.applied || operationStatus(op, now) === 'running') continue;
    op.applied = true;
    if (operationStatus(op, now) === 'succeeded') op.effect?.(op.steps.at(-1)!.end);
  }
  for (const run of d.runs) {
    if (run.record.status !== 'running' || run.finishAt > now) continue;
    for (const c of d.candidates) if (!c.goneAt) c.lastSeenAt = iso(run.finishAt);
    run.record = runRecord(d, Date.parse(run.record.startedAt), run.finishAt, run.record.trigger, run.record.by);
  }
}

// --- Operations --------------------------------------------------------------------------------------------------------

export function operationStatus(op: DemoOperation, now: number): 'running' | 'succeeded' | 'failed' {
  const failed = op.steps.find((s) => s.outcome === 'failed');
  if (failed && failed.end <= now) return 'failed';
  return op.steps.every((s) => s.end <= now) ? 'succeeded' : 'running';
}

// The steps of an operation from its start: each takes a second or two, the skipped ones none; one may wait longer
// (slow) or fail (it ends the operation, undone).
export function plan(type: WorkflowType, start: number, options: {
  skip?: (step: string) => boolean; details?: Record<string, string>; slow?: { step: string; ms: number; every: number };
  fail?: { step: string; detail: string }; seed?: string;
} = {}): PlannedStep[] {
  const r = random(options.seed ?? `${type}:${start}`);
  const steps: PlannedStep[] = [];
  let t = start;
  let stopped = false;
  for (const name of PLANS[type]) {
    if (stopped) {
      steps.push({ name, start: Infinity, end: Infinity, outcome: 'done' });
      continue;
    }
    const skipped = options.skip?.(name) ?? false;
    const failing = options.fail?.step === name;
    const ms = skipped ? 0 : options.slow?.step === name ? options.slow.ms : Math.round(r.between(900, 2400));
    const detail = failing ? options.fail!.detail : options.details?.[name];
    steps.push({ name, start: t, end: t + ms, outcome: failing ? 'failed' : skipped ? 'skipped' : 'done', ...(detail ? { detail } : {}), ...(options.slow?.step === name ? { every: options.slow.every } : {}) });
    t += ms;
    if (failing) stopped = true;
  }
  return steps;
}

export function addOperation(d: Demo, op: Omit<DemoOperation, 'applied'>): DemoOperation {
  const created = { ...op, applied: false };
  d.operations.unshift(created);
  return created;
}

// The router of an account and region (the manager installs one per account and region).
export const routerIn = (d: Demo, account: string, region: string) => d.routers.find((r) => r.account === account && r.region === region) ?? null;

// A workload onboarded from a candidate: awake, its costs known from its first nap.
export function onboardedWorkload(d: Demo, c: Candidate, router: DemoRouter, input: { name?: string; settings?: Record<string, unknown>; databases?: { kind: string; id: string }[]; tags?: Record<string, string> }, at: number): DemoWorkload {
  const kind = c.backend?.kind ?? 'instance';
  const backends: BackendSpec[] = [
    kind === 'asg' ? { kind: 'asg', type: 't3.small', count: 1 }
      : kind === 'ecs' ? { kind: 'ecs', vcpu: 0.5, memoryGb: 1, count: 1 }
        : kind === 'k8s' ? { kind: 'k8s', cluster: c.backend?.kubernetes?.cluster ?? ORG.cluster ?? 'eks', namespace: c.backend?.kubernetes?.namespace ?? 'default', owner: c.backend?.kubernetes?.owner.name ?? c.targetGroup ?? 'app', count: 2, vcpu: 0.5, memoryGb: 1, nodeType: 'm6i.xlarge' }
          : { kind: 'instance', type: 't3.small' },
    ...(input.databases ?? []).map((db): BackendSpec => ({ kind: 'rds', id: db.id, class: 'db.t4g.medium' })),
  ];
  const name = input.name ?? c.targetGroup ?? c.id;
  const idle = Number(input.settings?.idleMinutes ?? 15);
  const w = baseWorkload({
    name: c.targetGroup ?? name, router, backends, idleMinutes: Number.isFinite(idle) && idle >= 5 ? idle : 15,
    wakeMode: input.settings?.wakeMode === 'browser' ? 'browser' : 'any', source: 'manager', hosts: c.hosts.length ? c.hosts : [`${name}.${ORG.scenario.domain}`],
  });
  return Object.assign(w, {
    name, tags: { ...(input.tags ?? {}) }, schedule: null, itemsKnown: false, state: 'AWAKE' as State, entries: [{ from: null, to: 'AWAKE', at: iso(at) }], awakeSince: at, updatedAt: at, activeUntil: at + 4 * MINUTE,
    targetGroupArn: c.targetGroupArn ?? w.targetGroupArn, loadBalancerArn: c.loadBalancerArn, ruleArns: c.rules.map((x) => x.id), priority: Number(c.priority) || w.priority,
    idleHours7d: c.idleHours7d, requests7d: c.requests7d,
  });
}

// The operations of the last weeks, from the generated organization: router installs and an upgrade, accounts connected,
// workloads onboarded, an exclusion, a failed onboarding, an offboarding, and one onboarding still running.
function seedOperations(d: Demo, now: number) {
  const [first, second] = ORG.actors;
  const story: { at: number; add: () => void }[] = [];
  const eligible = (c: Candidate) => c.status === 'pending-onboarding' && c.eligibility === 'eligible' && !c.goneAt;
  const routerSkip = (step: string) => step.startsWith('install ') || step === 'register router' || CLUSTER.includes(step);
  const onboard = (c: Candidate, router: DemoRouter, start: number, options: Parameters<typeof plan>[2] = {}) => {
    const name = c.targetGroup ?? c.id;
    const w = d.workloads.find((x) => x.name === name);
    return addOperation(d, {
      id: uuid(`operation:onboard:${name}`), type: 'onboard', target: { account: c.account, region: c.region, targetGroupArn: c.targetGroupArn!, loadBalancerArn: c.loadBalancerArn },
      input: { candidateId: c.id, name, settings: { idleMinutes: w?.settings.idleMinutes ?? 15, wakeMode: w?.wakeMode ?? 'any' }, databases: [] },
      context: { router: router.name, ...(w ? { workloadId: w.workloadId, name } : { name }) }, by: first, createdAt: start,
      steps: plan('onboard', start, { skip: routerSkip, details: { 'find router': `${router.name} ${AVAILABLE.version}`, preview: '1 rule, the waker target group to create' }, seed: name, ...options }),
    });
  };

  // The routers the manager installed in the last weeks.
  for (const router of d.routers.filter((r) => r.source === 'manager' && now - r.installedAt <= 30 * DAY)) {
    story.push({
      at: router.installedAt, add: () => addOperation(d, {
        id: uuid(`operation:install:${router.name}`), type: 'install-router', target: { account: router.account, region: router.region }, input: { account: router.account, region: router.region },
        by: ME, createdAt: router.installedAt, steps: plan('install-router', router.installedAt, { skip: (s) => CLUSTER.includes(s), details: { 'find router': `none: installing ${router.name} ${router.version}` }, seed: router.name }),
      }),
    });
  }
  // Accounts without a router, connected by discovery.
  ACCOUNTS.filter((a) => a.command && !d.routers.some((r) => r.account === a.id)).slice(0, 2).forEach((a, i) => {
    const at = now - (12.2 - i * 0.1) * DAY;
    const region = d.candidates.find((c) => c.account === a.id)?.region ?? ORG.scenario.regions[0]!;
    story.push({
      at, add: () => addOperation(d, {
        id: uuid(`operation:connect:${a.id}`), type: 'connect-account', target: { account: a.id }, input: { regions: [region] }, by: 'discovery', createdAt: at,
        steps: plan('connect-account', at, { seed: a.id }),
      }),
    });
  });
  // Workloads the manager onboarded: the recent one, and two older ones.
  const onboarded = d.workloads.filter((w) => w.source === 'manager' && d.routers.some((r) => r.name === w.router && r.source === 'manager'));
  const recent = ORG.workloads.find((w) => w.days);
  const picks = [
    ...(recent ? [{ name: recent.name, at: now - recent.days! * DAY - 20 * MINUTE }] : []),
    ...onboarded.filter((w) => w.name !== recent?.name).slice(0, 2).map((w, i) => ({ name: w.name, at: now - (i ? 9 * DAY + 4 * HOUR : 15 * DAY) })),
  ];
  for (const { name, at } of picks) {
    const c = d.candidates.find((x) => x.targetGroup === name);
    const router = c && routerIn(d, c.account, c.region);
    if (c && router) story.push({ at, add: () => onboard(c, router, at) });
  }
  // The account excluded for a while.
  const ex = d.exclusions.find((e) => e.target.kind === 'account');
  if (ex) {
    const at = Date.parse(ex.at);
    story.push({
      at, add: () => addOperation(d, {
        id: uuid(`operation:exclude:${ex.target.account}`), type: 'exclude', target: { exclusionId: ex.id, account: ex.target.account! }, input: { exclusionId: ex.id },
        by: ex.by, createdAt: at, steps: plan('exclude', at, { details: { 'pause workloads': `no managed workload in ${ex.target.account}` }, seed: 'exclude' }),
      }),
    });
  }
  // A failed onboarding where no router was: undone, the candidate is still to onboard.
  const commanded = (c: Candidate) => ACCOUNTS.some((a) => a.id === c.account && a.command);
  const lone = d.candidates.find((c) => eligible(c) && c.scope === 'in' && commanded(c) && c.backend?.kind !== 'k8s' && !routerIn(d, c.account, c.region));
  if (lone) {
    const at = now - 5 * DAY - 6 * HOUR;
    const name = lone.targetGroup ?? lone.id;
    const why = `the rule forwards to 2 target groups with weights (${name}, ${name}-canary): not supported`;
    story.push({
      at, add: () => addOperation(d, {
        id: uuid(`operation:onboard:${name}`), type: 'onboard', target: { account: lone.account, region: lone.region, targetGroupArn: lone.targetGroupArn!, loadBalancerArn: lone.loadBalancerArn },
        input: { candidateId: lone.id, name, settings: { idleMinutes: 30, wakeMode: 'browser' }, databases: [] }, context: { name }, by: second, createdAt: at,
        steps: plan('onboard', at, {
          skip: (s) => CLUSTER.includes(s), seed: name, details: { 'find router': `none: installing dmtr-${accountName(lone.account)}-${lone.region}` },
          fail: { step: 'preview', detail: `${why}; the router was uninstalled` },
        }),
        error: `preview: ${why}`,
      }),
    });
  }
  // The offboarding of the workload discovery no longer finds.
  const gone = d.candidates.find((c) => c.goneAt);
  const goneRouter = gone && routerIn(d, gone.account, gone.region);
  if (gone && goneRouter) {
    const at = now - 4 * DAY - HOUR;
    const name = gone.targetGroup ?? gone.id;
    const target = { router: goneRouter.name, account: gone.account, region: gone.region, workloadId: hex(`workload:${name}`, 16) };
    story.push({
      at, add: () => addOperation(d, {
        id: uuid(`operation:offboard:${name}`), type: 'offboard', target, input: target, context: { name }, by: first, createdAt: at,
        steps: plan('offboard', at, { details: { locate: goneRouter.name, 'wait awake': 'awake after 52 s' }, seed: name }),
      }),
    });
  }
  // A router upgraded two days ago.
  const upgraded = d.routers.find((r, i) => i > 0 && r.source === 'manager' && r.version === AVAILABLE.version && now - r.installedAt > 3 * DAY);
  if (upgraded) {
    const at = now - 2 * DAY - 3 * HOUR;
    const where = { account: upgraded.account, region: upgraded.region };
    story.push({
      at, add: () => addOperation(d, {
        id: uuid(`operation:upgrade:${upgraded.name}`), type: 'upgrade-router', target: where, input: where, by: ME, createdAt: at,
        steps: plan('upgrade-router', at, { skip: (s) => CLUSTER.includes(s), details: { 'find router': `${upgraded.name} ${PREVIOUS.version}`, 'verify router': `${AVAILABLE.version} (${AVAILABLE.build})` }, seed: 'upgrade' }),
      }),
    });
  }
  // Oldest first (each one goes on top of the list).
  for (const step of story.sort((a, b) => a.at - b.at)) step.add();

  // Running: an onboarding waits for its rules to answer through the waker.
  const next = d.candidates.find((c) => eligible(c) && c.scope === 'in' && commanded(c) && c !== lone && routerIn(d, c.account, c.region));
  const router = next && routerIn(d, next.account, next.region);
  if (next && router) {
    const op = onboard(next, router, now - 75 * SECOND, {
      slow: { step: 'verify', ms: 4 * MINUTE, every: 15 * SECOND }, seed: 'running',
      details: { 'find router': `${router.name} ${router.version}`, preview: '1 rule, the waker target group to create', verify: 'waiting for the rule to answer through the waker target group' },
    });
    op.input = { ...op.input, settings: { idleMinutes: 15, wakeMode: 'browser' } };
    op.effect = onboardEffect(d, next.id, op);
  }
}

// What a finished onboarding changes: its router's new workload, the candidate managed.
export function onboardEffect(d: Demo, candidateId: string, op: DemoOperation) {
  return (at: number) => {
    const c = d.candidates.find((x) => x.id === candidateId);
    if (!c) return;
    let router = routerIn(d, c.account, c.region);
    if (!router) {
      router = makeRouter({ name: `dmtr-${accountName(c.account)}-${c.region}`, account: c.account, region: c.region, source: 'manager', ...AVAILABLE, installedDays: 0, metrics: false, concurrency: { limit: 1000, needed: 6, worstCase: 12 }, peak: 1 }, at);
      d.routers.push(router);
    }
    const w = onboardedWorkload(d, c, router, op.input as { name?: string; settings?: Record<string, unknown>; databases?: { kind: string; id: string }[] }, at);
    d.workloads.push(w);
    Object.assign(c, { eligibility: 'managed', workloadId: w.workloadId, rules: c.rules.map((x) => ({ ...x, managed: true })) });
    op.context = { ...op.context, workloadId: w.workloadId, name: w.name };
    restatus(d, at);
  };
}

// The audit trail of the last week, from the generated organization: wakes and naps, a pause, a router paused, people
// invited and changed, the discovery's settings and runs, an exclusion; then the operations started from the dashboard.
function seedAudit(d: Demo, now: number) {
  const [first, second] = ORG.actors;
  const roleOf = (email: string) => ORG.people.find((p) => p.email === email)?.role ?? 'operator';
  const wl = (w: DemoWorkload) => `${w.router}/${w.workloadId}`;
  const date = (hours: number) => iso(now + hours * HOUR).slice(0, 16);
  const free = (state: State) => d.workloads.filter((w) => w.state === state && !w.pauses.length);
  const [awake, asleep] = [free('AWAKE'), free('ASLEEP')];
  const napping = free('NAPPING')[0];
  const failed = free('FAILED')[0];
  const paused = d.workloads.find((w) => w.pauses.length);
  const lastRouter = d.routers.at(-1);
  const migrated = d.workloads.find((w) => w.router === lastRouter?.name && w.backends.some((b) => b.kind === 'rds'));
  const ex = ORG.accountExclusion;
  const rows: ([number, string, string, string, string] | null | undefined | false | '')[] = [
    awake[0] && [0.35, first, 'wake', wl(awake[0]), 'WAKING'],
    [1.1, ME, 'discovery-run', 'discovery', 'requested'],
    awake[1] && [2.6, second, 'nap', wl(awake[1]), 'requested'],
    asleep[0] && [4.2, first, 'wake', wl(asleep[0]), 'WAKING'],
    napping && [6.9, second, 'nap', wl(napping), 'requested'],
    paused && [20.5, second, 'nap', wl(paused), 'error: workload paused: never napped until resumed'],
    paused && [26, paused.pauses[0]!.by, 'pause', wl(paused), `${paused.pauses[0]!.reason}; until ${date(46)}; woken ${paused.workloadId}`],
    lastRouter && [29, first, 'router-pause', lastRouter.name, `Database migration${migrated ? ` of ${migrated.name}` : ''}; until ${date(-27)}; keep asleep`],
    lastRouter && [31.5, first, 'router-resume', lastRouter.name, 'resumed'],
    ORG.invited && [47, ME, 'invite', ORG.invited, 'viewer, sent'],
    second !== ME && [51, ME, 'role', second, 'operator'],
    failed && [55, first, 'wake', wl(failed), 'WAKING'],
    asleep[1] && [70, second, 'rename', wl(asleep[1]), asleep[1].name],
    [75, ME, 'discovery-config', 'discovery', `2 filters, 1 global exclude, regions ${ORG.scenario.regions.join(' ')}, event-driven refresh on for every ready account`],
    asleep[2] && [80, first, 'nap', wl(asleep[2]), 'requested'],
    asleep[3] && [98, second, 'wake', wl(asleep[3]), 'WAKING'],
    ORG.disabled && [110, ME, 'disable', ORG.disabled, 'done'],
    asleep[4] && [122, first, 'resume', wl(asleep[4]), 'resumed'],
    ex && [146, ex.by, 'exclude', `account ${accountName(ex.account)} (${ex.account})`, `${ex.reason}; until ${iso(now + ex.expiresInDays * DAY)}; operation ${uuid(`operation:exclude:${ex.account}`)}`],
    second !== ME && [152, ME, 'mfa-reset', second, 'reset, authenticator deleted'],
    [160, second, 'discovery-run', 'discovery', 'requested'],
  ];
  d.audit = rows.filter((x): x is [number, string, string, string, string] => Boolean(x))
    .map(([hours, who, action, target, result]) => ({ id: uuid(`audit:${hours}:${action}`), at: iso(now - hours * HOUR), who, role: roleOf(who), action, target, result }));
  // The operations started from the dashboard.
  for (const op of d.operations) {
    if (op.type === 'connect-account' || op.type === 'exclude' || op.type === 'lift-exclusion') continue;
    const target = op.type === 'onboard' ? `${String(op.input.candidateId)} as ${String(op.input.name)}` : op.type === 'offboard' ? `${op.target.router}/${op.target.workloadId}` : op.type === 'install-router' ? `${op.target.account}/${op.target.region}` : routerIn(d, op.target.account!, op.target.region!)?.name ?? '';
    d.audit.push({ id: uuid(`audit:${op.id}`), at: iso(op.createdAt), who: op.by, role: roleOf(op.by), action: `operation-${op.type}`, target, result: `started ${op.id}` });
  }
  d.audit.sort((a, b) => b.at.localeCompare(a.at));
}

// A mutation of the signed-in user, recorded as the API does.
export function audited<T>(d: Demo, action: string, target: string, run: () => { result: string; response: T }): T {
  const entry = { id: crypto.randomUUID(), at: iso(Date.now()), who: d.me.email, role: d.me.role, action, target };
  try {
    const { result, response } = run();
    d.audit.unshift({ ...entry, result });
    return response;
  } catch (err) {
    d.audit.unshift({ ...entry, result: `error: ${(err as Error).message}` });
    throw err;
  }
}


// --- Hibernation (router 0.32.0) -----------------------------------------------------------------------------------------

export interface DemoHibernation {
  hibernate: boolean;
  from: 'workload' | 'fallback-types' | 'router' | 'manager' | 'default';
  workload: boolean | null;
  router: boolean | null;
  manager: { hibernate: boolean; readAt: string; error: null } | null;
  instances: { id: string; configured: boolean; hibernated: boolean }[] | null;
  freshBoot: boolean;
}

// The router's last read of the manager's settings: a few minutes ago, whatever the administrators set.
export const managerReadAt = (now: number): number => Math.floor((now - 7 * SECOND) / (5 * MINUTE)) * 5 * MINUTE + 7 * SECOND;

// The order of the spec: the workload, its fallback types (off), the router, the manager, the built-in default (on).
// Routers before 0.32.0 know nothing of it.
export const hasHibernation = (r: DemoRouter): boolean => {
  const [major, minor] = r.version.split('.').map(Number);
  return major! > 0 || minor! >= 32;
};

export function hibernationOf(d: Demo, w: DemoWorkload, now: number): DemoHibernation | null {
  const router = d.routers.find((r) => r.name === w.router)!;
  if (!hasHibernation(router)) return null;
  const manager = router.readsManager ? { hibernate: d.hibernation.hibernate, readAt: iso(managerReadAt(now)), error: null } : null;
  const resolved: Pick<DemoHibernation, 'hibernate' | 'from'> = w.hibernate !== null ? { hibernate: w.hibernate, from: 'workload' }
    : w.fallbackTypes.length ? { hibernate: false, from: 'fallback-types' }
    : router.hibernate !== null ? { hibernate: router.hibernate, from: 'router' }
    : manager ? { hibernate: manager.hibernate, from: 'manager' } : { hibernate: true, from: 'default' };
  // Standalone instances only: an Auto Scaling group's are not hibernated.
  const ids = w.backends.some((b) => b.kind === 'instance') ? [w.instanceId] : [];
  // Some instances were not launched with hibernation: the demo has one in five of them.
  const instances = ids.length
    ? ids.map((id) => ({ id, configured: (w.seed + hash(id)) % 5 !== 0, hibernated: w.state === 'ASLEEP' && resolved.hibernate && (w.seed + hash(id)) % 5 !== 0 }))
    : null;
  return { ...resolved, workload: w.hibernate, router: router.hibernate, manager, instances, freshBoot: false };
}

// The instances a nap hibernates now: the configured ones, when the value is on.
export const hibernatedIds = (d: Demo, w: DemoWorkload): string[] => {
  const h = hibernationOf(d, w, Date.now());
  return h?.hibernate ? (h.instances ?? []).filter((i) => i.configured).map((i) => i.id) : [];
};
