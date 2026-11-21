// The demo's standalone workloads and candidates (vision standalone workloads design §6): a workload of each kind of resource
// in several states (awake, asleep by its schedule, asleep on its idle signals, failed, its resource missing), the
// standalone candidates of a run with the perimeter's standalone scan on (eligible, and each family of the router's
// reasons), in the shapes the manager answers.
import type { Candidate, StandaloneCandidate } from '@dormeto/discovery/types';
import type { IdleMetric, IdleSignal, Settings, WorkloadStatus, WorkloadSummary } from '../types';
import type { Schedule } from '../schedule';
import { ORG, accountName } from './org';
import { DAY, HOUR, MINUTE, SECOND, hex, iso } from './util';
import type { BackendSpec } from './fixtures';
import type { Demo, DemoRouter, DemoWorkload } from './state';

type ResourceKind = StandaloneCandidate['backend']['kind'];
export interface StandaloneSpec {
  name: string; kind: ResourceKind; state: 'AWAKE' | 'ASLEEP' | 'FAILED'; by?: 'schedule' | 'idle'; missing?: boolean; metric?: IdleMetric; backends: BackendSpec[];
  // A failed one's failure (else a database's slow start, retried), and whether the check retries it now.
  failure?: { kind: string; step: 'wake' | 'nap'; message: string }; retried?: boolean;
  // Its own network threshold (a Cloud SQL instance's is not read: the router says why).
  network?: number;
}

const arnOf = (kind: ResourceKind, id: string, account: string, region: string, cluster: string) => ({
  instance: `arn:aws:ec2:${region}:${account}:instance/${id}`,
  asg: `arn:aws:autoscaling:${region}:${account}:autoScalingGroup:${hex(`asg:${id}`, 8)}-0000-4000-8000-${hex(`asg2:${id}`, 12)}:autoScalingGroupName/${id}`,
  ecs: `arn:aws:ecs:${region}:${account}:service/${cluster}/${id}`,
  'rds-instance': `arn:aws:rds:${region}:${account}:db:${id}`,
  'cloudsql-instance': `projects/${account}/instances/${id}`,
  'rds-cluster': `arn:aws:rds:${region}:${account}:cluster:${id}`,
}[kind]);
// A Google Cloud resource's path (discovery's GOOGLE_RESOURCE_PATH): a VM in its region's zone b, a regional group, a Cloud SQL
// instance.
export const googlePathOf = (kind: ResourceKind, name: string, project: string, region: string) => (kind === 'instance' ? `projects/${project}/zones/${region}-b/instances/${name}`
  : kind === 'asg' ? `projects/${project}/regions/${region}/instanceGroupManagers/${name}` : `projects/${project}/instances/${name}`);
const resourceId = (kind: ResourceKind, name: string) => (kind === 'instance' ? `i-0${hex(`standalone:${name}`, 16)}` : name);

export const STANDALONE_WORKLOADS: StandaloneSpec[] = [
  { name: 'build-agent', kind: 'instance', state: 'AWAKE', backends: [{ kind: 'instance', type: 't3.large' }], metric: { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 } },
  { name: 'batch-workers', kind: 'asg', state: 'ASLEEP', by: 'schedule', backends: [{ kind: 'asg', type: 'c6g.xlarge', count: 3 }] },
  { name: 'queue-worker', kind: 'ecs', state: 'ASLEEP', by: 'idle', backends: [{ kind: 'ecs', vcpu: 1, memoryGb: 2, count: 2 }] },
  { name: 'reports-db', kind: 'rds-instance', state: 'FAILED', backends: [{ kind: 'rds', id: 'reports-db', class: 'db.t4g.medium' }] },
  { name: 'analytics', kind: 'rds-cluster', state: 'AWAKE', missing: true, backends: [{ kind: 'rds', id: 'analytics', class: 'db.r6g.large' }] },
];
// Google Cloud's (plan 5), on the demo's router of 0.42.0 in dormeto-dev: a VM with its own Cloud Monitoring metric, a managed
// instance group asleep by its schedule, a Cloud SQL instance asleep on its connections, a VM whose wake timed out (retried), a
// Cloud SQL instance whose start Google refused for the tag (the kept permission failure, retried until it succeeds or napped).
export const GOOGLE_STANDALONE_WORKLOADS: StandaloneSpec[] = [
  { name: 'batch', kind: 'instance', state: 'AWAKE', backends: [{ kind: 'instance', type: 'e2-standard-4' }], metric: { type: 'custom.googleapis.com/queue/depth', filter: 'metric.labels.agent = "${resource}"', aligner: 'ALIGN_MAX', below: 1 } },
  { name: 'render-workers', kind: 'asg', state: 'ASLEEP', by: 'schedule', backends: [{ kind: 'asg', type: 'n2-standard-8', count: 4 }] },
  { name: 'orders-sql', kind: 'cloudsql-instance', state: 'ASLEEP', by: 'idle', network: 1000, backends: [{ kind: 'rds', id: 'orders-sql', class: 'db-custom-2-7680' }] },
  { name: 'etl-vm', kind: 'instance', state: 'FAILED', backends: [{ kind: 'instance', type: 'e2-medium' }], retried: true,
    failure: { kind: 'timeout', step: 'wake', message: 'VM etl-vm is still STAGING after 10 minutes: Compute Engine had no e2-medium capacity in europe-west1-b' } },
  { name: 'reports-sql', kind: 'cloudsql-instance', state: 'FAILED', backends: [{ kind: 'rds', id: 'reports-sql', class: 'db-custom-1-3840' }], retried: true,
    failure: { kind: 'permission', step: 'wake', message: 'Cloud SQL instance reports-sql: Google refused the change of its activation policy: the router may change only an instance with the tag dormeto=managed: The client is not authorized to make this request.' } },
];
const NIGHTS: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '07:00', end: '19:00' }, { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '19:00', end: '07:00' }], maxNapDays: 7 };

const isDatabase = (kind: ResourceKind) => kind.startsWith('rds-') || kind === 'cloudsql-instance';
// The built-in idle signals of its kind (the router's STANDALONE_BUILT_IN, a database's connections under 1).
function builtIns(kind: ResourceKind, id: string): Settings & Record<string, unknown> {
  return {
    idleMinutes: 120, wakeTimeoutSeconds: kind === 'cloudsql-instance' ? 1700 : isDatabase(kind) ? 1800 : 600, idleCpuPercent: isDatabase(kind) ? 'off' : 5, idleNetworkBytes: 'off',
    idleMetric: kind === 'cloudsql-instance' ? { type: 'cloudsql.googleapis.com/database/network/connections', aligner: 'ALIGN_MAX', below: 1 }
      : isDatabase(kind) ? { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { [kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: id }, statistic: 'Maximum', below: 1 } : 'off',
  } as unknown as Settings & Record<string, unknown>;
}

// A standalone workload of the demo, from a generated one (its history, its prices), as a router 0.42.0 keeps it.
export function standaloneWorkload(spec: StandaloneSpec, router: DemoRouter, build: (backends: BackendSpec[]) => DemoWorkload, now: number): DemoWorkload {
  const w = build(spec.backends);
  const google = router.cloud === 'gcp';
  const id = google ? spec.name : resourceId(spec.kind, spec.name);
  const settings = builtIns(spec.kind, id);
  if (spec.metric) settings.idleMetric = spec.metric;
  if (spec.network !== undefined) settings.idleNetworkBytes = spec.network;
  Object.assign(w, {
    workloadId: hex(`standalone:${spec.name}`, 16), name: spec.name, kind: 'standalone', resourceKind: spec.kind,
    ...(google ? { cloud: 'gcp', resource: googlePathOf(spec.kind, spec.name, router.account, router.region) } : { resourceArn: arnOf(spec.kind, id, router.account, router.region, `${router.name}-jobs`) }),
    resourceId: id, resourceMissing: Boolean(spec.missing), hosts: [], ruleArns: [], targetGroupArn: '', loadBalancerArn: '', source: 'manager', settings, ownKeys: [...(spec.metric ? ['idleMetric'] : []), ...(spec.network !== undefined ? ['idleNetworkBytes'] : [])],
    wakeRules: [], noWakeRules: [], schedule: spec.by === 'schedule' ? NIGHTS : null, instanceId: id,
  });
  // Nothing wakes it on demand (the generated history says requests): its wakes are its schedule's, else a person's (named)
  // or a start made in the cloud, by turns; no request reaches it either.
  let turn = 0;
  for (const e of w.entries) {
    if (e.to !== 'WAKING' || ['manager', 'pause', 'schedule', 'maintenance'].includes(e.cause ?? '')) continue;
    if (spec.by === 'schedule') Object.assign(e, { cause: 'schedule', by: undefined });
    else Object.assign(e, (turn += 1) % 3 === 0 ? { cause: 'external-start', by: undefined } : { cause: 'manager', by: ORG.people[turn % ORG.people.length]!.email });
  }
  w.bursts = [];
  w.activeUntil = spec.state === 'AWAKE' ? Infinity : 0;
  if (spec.state === 'FAILED') {
    const failure = spec.failure ?? { kind: 'timeout', step: 'wake', message: 'reports-db is still starting after 30 minutes: its storage is being restored' };
    w.failure = { ...failure, at: iso(now - 25 * MINUTE) } as DemoWorkload['failure'];
    w.consecutiveFailures = failure.kind === 'permission' ? 4 : 2;
    // Router 4c1fe78: a time only while a retry is coming.
    w.nextAttemptAt = spec.retried === false ? null : now + 4 * MINUTE;
  }
  return w;
}
export const isStandaloneDemo = (w: DemoWorkload) => (w as { kind?: string }).kind === 'standalone';
const resourceKind = (w: DemoWorkload) => (w as unknown as { resourceKind: ResourceKind }).resourceKind;
const resourceArn = (w: DemoWorkload) => (w as unknown as { resourceArn: string }).resourceArn;
// The resource as the row names it: AWS's ARN, or Google Cloud's path.
const resourceOf = (w: DemoWorkload) => ((w as unknown as { resource?: string }).resource ? { resource: (w as unknown as { resource: string }).resource } : { resourceArn: resourceArn(w) });
const googleOf = (w: DemoWorkload) => Boolean((w as unknown as { resource?: string }).resource);
const resourceIdOf = (w: DemoWorkload) => (w as unknown as { resourceId: string }).resourceId;
const missing = (w: DemoWorkload) => Boolean((w as unknown as { resourceMissing?: boolean }).resourceMissing);
const STANDALONE_KEYS = ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];

// Its row (the handover's keys): no URL, wake mode nor target group; its kind's settings and where each comes from.
export function standaloneRow(w: DemoWorkload, row: WorkloadSummary): WorkloadSummary {
  const { url: _u, wakeMode: _m, targetGroupArn: _t, ...rest } = row as WorkloadSummary & { targetGroupArn?: string };
  const own = w.ownKeys ?? [];
  return {
    ...rest, kind: 'standalone', ...resourceOf(w), ...(missing(w) ? { resourceMissing: true as const } : {}),
    ...(googleOf(w) ? { backends: [resourceKind(w)] } : {}),
    stats7d: { wakes: row.stats7d?.wakes ?? 0 },
    settings: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, (w.settings as unknown as Record<string, unknown>)[k]])) as unknown as WorkloadSummary['settings'],
    settingsFrom: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, own.includes(k) ? 'workload' : 'default'])),
    type: isDatabase(resourceKind(w)) ? 'databases' : resourceKind(w),
  };
}

// The router's reason (gcp/src/idle-signals.mjs).
const NO_SQL_NETWORK = 'a Cloud SQL instance\'s network is not read: its connections are its signal';
// Its idle signals, by its state: awake and busy on one, under on the others; asleep, none read; failed, not applying.
function signalsOf(w: DemoWorkload, now: number): IdleSignal[] {
  const s = w.settings as unknown as { idleCpuPercent: number | 'off'; idleNetworkBytes: number | 'off'; idleMetric: IdleMetric | 'off' };
  const own = w.ownKeys ?? [];
  const from = (k: string) => (own.includes(k) ? 'workload' as const : 'default' as const);
  const awake = w.state === 'AWAKE';
  const signal = (key: 'cpu' | 'network' | 'metric', setting: number | 'off' | IdleMetric, value: number, under: boolean, k: string): IdleSignal => {
    if (setting === 'off') return { signal: key, below: null, value: null, underSince: null, applies: false, reason: 'off', from: from(k) };
    if (key === 'network' && resourceKind(w) === 'cloudsql-instance') return { signal: key, below: setting as number, value: null, underSince: null, applies: false, reason: NO_SQL_NETWORK, from: from(k) };
    const below = typeof setting === 'number' ? setting : setting.below;
    if (!awake) return { signal: key, below, value: null, underSince: null, applies: true, from: from(k) };
    return { signal: key, below, value, underSince: under ? iso(now - 35 * MINUTE) : null, applies: true, from: from(k) };
  };
  return [
    signal('cpu', s.idleCpuPercent, 1.4, true, 'idleCpuPercent'),
    signal('network', s.idleNetworkBytes, 0, true, 'idleNetworkBytes'),
    signal('metric', s.idleMetric, missing(w) ? 0 : 3, missing(w), 'idleMetric'),
  ];
}

// Its status (the handover's keys): its resource, its signals and nap estimate, its backends; no route, rule, target, waker,
// request or list.
export function standaloneStatus(w: DemoWorkload, status: WorkloadStatus, now: number): WorkloadStatus {
  const kind = resourceKind(w);
  const { url: _u, route: _r, rules: _ru, issues: _i, targets: _t, ipLists: _l, wakeMode: _m, wakeRules: _w, noWakeRules: _n, targetGroupArn: _g, lastRequestAt: _la, holders: _h, ...rest } = status;
  const signals = signalsOf(w, now);
  const busy = signals.some((s) => s.applies && s.underSince === null);
  const backendStatus = missing(w) ? 'unknown' : w.state === 'AWAKE' ? 'running' : w.state === 'FAILED' ? 'starting' : 'stopped';
  const id = resourceIdOf(w);
  const backend = googleOf(w) ? { kind, id: (w as unknown as { resource: string }).resource, status: backendStatus, ...(kind === 'asg' ? { min: 0, desired: w.state === 'AWAKE' ? 4 : 0, max: 4, warmPool: null } : {}) }
    : kind === 'asg' ? { kind, id, status: backendStatus, min: 0, desired: w.state === 'AWAKE' ? 3 : 0, max: 3, warmPool: null }
    : kind === 'ecs' ? { kind, id: resourceArn(w), status: backendStatus, desired: w.state === 'AWAKE' ? 2 : 0 } : { kind, id, status: backendStatus };
  const own = w.ownKeys ?? [];
  return {
    ...rest, kind: 'standalone', ...resourceOf(w), idle: signals,
    nap: w.state === 'AWAKE' && !busy && !status.pauses?.length ? { eligibleAt: iso(now + 85 * MINUTE), latestAt: iso(now + 90 * MINUTE), inSeconds: 85 * 60 } : null,
    backends: missing(w) ? [] : [backend], ...(missing(w) ? { resourceMissing: true as const } : {}), ignoredTargets: [], recommendations: [],
    settings: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, (w.settings as unknown as Record<string, unknown>)[k]])) as unknown as WorkloadStatus['settings'],
    settingsFrom: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, own.includes(k) ? 'workload' : 'default'])),
    type: { name: isDatabase(kind) ? 'databases' : kind, from: 'backends' },
    stats: status.stats && 'total' in status.stats ? { ...status.stats, today: { wakes: status.stats.today.wakes } as never, total: { wakes: status.stats.total.wakes } as never } : status.stats,
  } as unknown as WorkloadStatus;
}

// The run's standalone candidates: the workloads' (managed), those to onboard, and one of each family the router refuses.
interface CandidateSpec { name: string; kind: ResourceKind; reason?: string; idleHours7d?: number | null; managed?: DemoWorkload }
const REASONS = (label: (kind: ResourceKind, name: string) => string): CandidateSpec[] => [
  { name: 'ci-runner', kind: 'instance', idleHours7d: 141 },
  { name: 'nightly-export', kind: 'ecs', idleHours7d: 160 },
  { name: 'staging-db', kind: 'rds-instance', idleHours7d: 152 },
  { name: 'spot-renderer', kind: 'instance', reason: `${label('instance', 'spot-renderer')} is a Spot instance: Dormeto stops On-Demand instances only` },
  { name: 'worker-7', kind: 'instance', reason: `${label('instance', 'worker-7')} is in Auto Scaling group web-workers: onboard the group (it would replace a stopped instance)` },
  { name: 'scratch-box', kind: 'instance', reason: `${label('instance', 'scratch-box')} has an instance store root volume: it cannot be stopped` },
  { name: 'legacy-api', kind: 'instance', reason: `${label('instance', 'legacy-api')} feeds target group legacy-tcp: it belongs to an HTTP workload (onboard its target group)` },
  { name: 'eks-system-nodes', kind: 'asg', reason: `${label('asg', 'eks-system-nodes')} holds EKS nodes: onboard the Kubernetes workloads that run on them` },
  { name: 'log-agent', kind: 'ecs', reason: `${label('ecs', 'log-agent')} uses the daemon scheduling strategy: it has no desired count to set to 0` },
  { name: 'orders-aurora-1', kind: 'rds-instance', reason: `${label('rds-instance', 'orders-aurora-1')} is a member of Aurora cluster orders-aurora: onboard the cluster` },
  { name: 'orders-replica', kind: 'rds-instance', reason: `${label('rds-instance', 'orders-replica')} is a read replica: it cannot be stopped` },
  { name: 'legacy-serverless', kind: 'rds-cluster', reason: `${label('rds-cluster', 'legacy-serverless')} is Aurora Serverless v1: it cannot be stopped` },
];
const LABELS: Record<ResourceKind, string> = { instance: 'instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'RDS cluster', 'cloudsql-instance': 'Cloud SQL instance' };

export function standaloneCandidates(d: Demo, router: DemoRouter, now: number, lastSeen: number): Candidate[] {
  const { account, region } = router;
  const cluster = `${router.name}-jobs`;
  const label = (kind: ResourceKind, name: string) => `${LABELS[kind]} ${kind === 'ecs' ? `${cluster}/${name}` : resourceId(kind, name)}`;
  const specs: CandidateSpec[] = [
    ...d.workloads.filter(isStandaloneDemo).map((w) => ({ name: w.name, kind: resourceKind(w), managed: w, idleHours7d: 100 })),
    ...REASONS(label),
  ];
  return specs.map((c, i) => {
    const id = resourceId(c.kind, c.name);
    const arn = c.managed ? resourceArn(c.managed) : arnOf(c.kind, id, account, region, cluster);
    const candidate: StandaloneCandidate = {
      kind: 'standalone', id: arn, account, region, resourceArn: arn, name: c.name, backend: { kind: c.kind, id: c.kind === 'ecs' ? arn : id, arn },
      tags: { environment: ['dev'], ...(c.kind === 'instance' ? { Name: [c.name] } : {}) },
      eligibility: c.managed ? 'managed' : c.reason ? 'ineligible' : 'eligible', ...(c.reason ? { reason: c.reason } : {}), ...(c.managed ? { workloadId: c.managed.workloadId } : {}),
      idleHours7d: c.reason ? null : c.idleHours7d ?? null,
      accountName: accountName(account), ouPath: [ORG.root], scope: 'in', scopeReason: 'in scope: filter "non-production", include 1', status: 'pending-onboarding', statusReason: 'eligible',
      firstSeenAt: iso(now - (3 + i) * DAY - 2 * HOUR), lastSeenAt: iso(lastSeen), history: [],
    };
    return candidate as unknown as Candidate;
  });
}

// The time a standalone workload's nap and wake take in the demo (a database is slow to start).
export const standaloneTimings = (kind: ResourceKind) => (kind.startsWith('rds-') ? { wakeMs: 7 * MINUTE, napMs: 2 * MINUTE } : { wakeMs: 70 * SECOND, napMs: 40 * SECOND });

// Its Activity history (GET …/activity, M47): each applying signal's 5-minute values over the 7 days to 10 minutes ago, none
// while it was asleep (stopped), its hours asleep, and the advice replayed on the busy points from 5 minutes to 24 hours. The
// demo's signals: busy on weekdays' working hours with a short job at night, idle otherwise; the custom metric follows the CPU.
const STANDALONE_WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const POINT = 5 * MINUTE;
export function standaloneActivity(w: DemoWorkload, now: number, view: (from: number, to: number) => { phases: { state: string; from: string; to: string }[]; wakes: { medianMs: number | null } },
  replay: (list: { start: number; end: number; requests: number }[], current: number, from: number, to: number, wakeMs: number, napMs: number, hourly: number | null, tried: number[], recommendable: number[]) => { rows: unknown[]; recommended: number; replayedWakes: number }) {
  const to = Math.floor((now - 10 * MINUTE) / POINT) * POINT;
  const from = to - 7 * DAY;
  const settings = w.settings as unknown as Record<string, unknown>;
  const phases = view(from, to).phases;
  const asleep = phases.filter((p) => p.state === 'ASLEEP').map((p) => ({ from: p.from, to: p.to }));
  const awakeAt = (t: number) => phases.some((p) => p.state !== 'ASLEEP' && Date.parse(p.from) <= t && Date.parse(p.to) >= t + POINT);
  const level = (t: number, p: number) => {
    const hour = new Date(t).getUTCHours();
    const weekday = new Date(t).getUTCDay() % 6 !== 0;
    const busy = (weekday && hour >= 8 && hour < 17 && (p % 9 !== 0)) || (hour === 2 && new Date(t).getUTCMinutes() < 20);
    return busy ? 25 + ((p * 37) % 50) : 0.4 + ((p * 13) % 17) / 10;
  };
  const signalOf = (signal: 'cpu' | 'network' | 'metric', key: string) => {
    const v = settings[key];
    const below = v === 'off' || v === undefined ? null : typeof v === 'number' ? v : (v as { below: number }).below;
    const kind = (w as { resourceKind?: string }).resourceKind;
    const applies = below !== null && !(signal === 'network' && (kind === 'ecs' || kind === 'cloudsql-instance'));
    const values = !applies ? [] : Array.from({ length: (to - from) / POINT }, (_, p) => {
      const t = from + p * POINT;
      if (!awakeAt(t)) return null;
      const cpu = level(t, p);
      return signal === 'cpu' ? Math.round(cpu * 10) / 10 : signal === 'metric' ? (cpu > 5 ? Math.max(below!, Math.round(cpu / 10)) : 0) : Math.round(cpu * 4000);
    });
    return { signal, below, applies, ...(applies ? {} : { reason: below === null ? 'off' : kind === 'cloudsql-instance' ? NO_SQL_NETWORK : 'an ECS service has no network metric without Container Insights' }), from: 'default', values };
  };
  const signals = [signalOf('cpu', 'idleCpuPercent'), signalOf('network', 'idleNetworkBytes'), signalOf('metric', 'idleMetric')];
  const applying = signals.filter((s) => s.applies);
  if (!applying.length) return { from: iso(from), to: iso(to), signals, asleep, advice: null, reason: 'no idle signal applies: it naps on its schedule and on people\'s word only' };
  // The busy points as bursts of activity: a point at or over a threshold, or missing while awake.
  const list: { start: number; end: number; requests: number }[] = [];
  for (let p = 0; p < (to - from) / POINT; p += 1) {
    const t = from + p * POINT;
    if (!awakeAt(t)) continue;
    if (applying.some((s) => s.values[p] === null || s.values[p]! >= s.below!)) list.push({ start: t, end: t + POINT, requests: 1 });
  }
  const month = view(now - 30 * DAY, now);
  const wakeMs = month.wakes.medianMs ?? w.wakeMs;
  const current = Number(settings.idleMinutes ?? 120);
  const { rows, recommended, replayedWakes } = replay(list, current, from, to, wakeMs, w.napMs, null, STANDALONE_WINDOWS, STANDALONE_WINDOWS.filter((m) => m <= 120));
  const actual = phases.filter((p, i) => i > 0 && p.state === 'WAKING').length;
  return {
    from: iso(from), to: iso(to), signals, asleep,
    advice: {
      computedAt: iso(now - 37 * MINUTE), from: iso(from), to: iso(to), current, recommended, checkMinutes: 5, wakeSeconds: month.wakes.medianMs === null ? null : Math.round(month.wakes.medianMs / SECOND),
      priced: false, windows: rows, actual: { wakes: actual, replayedWakes, noisy: replayedWakes > actual * 1.2 + 2 }, wakerTargetGroup: false,
    },
  };
}

// Google Cloud's standalone candidates (plan 5; discovery gcp-standalone.ts): the workloads' (managed), a VM, an empty group and a
// Cloud SQL instance to onboard (one in a region without a router: the dialog asks which), and one of each family the scan
// refuses, in its words; each with its kind, its resource's path and labels, the idle share of an eligible one.
interface GoogleCandidateSpec { name: string; kind: ResourceKind; region?: string; reason?: string; idleHours7d?: number; managed?: DemoWorkload; labels?: Record<string, string[]> }
const GOOGLE_REASONS: GoogleCandidateSpec[] = [
  { name: 'nightly-build', kind: 'instance', idleHours7d: 148, labels: { team: ['ci'] } },
  { name: 'spare-workers', kind: 'asg', idleHours7d: 168 },
  { name: 'analytics-sql', kind: 'cloudsql-instance', region: 'europe-west3', idleHours7d: 155, labels: { team: ['data'] } },
  { name: 'web-mig-x7k2', kind: 'instance', reason: 'VM web-mig-x7k2 is a member of managed group web-mig: onboard the group (it would repair a stopped VM)' },
  { name: 'gke-pool-1-a9f3', kind: 'instance', reason: 'VM gke-pool-1-a9f3 is a GKE node: onboard the Kubernetes workloads that run on it' },
  { name: 'trainer-gpu', kind: 'instance', reason: 'VM trainer-gpu has a GPU: GPU VMs are not supported' },
  { name: 'cache-ssd', kind: 'instance', reason: 'VM cache-ssd has a local SSD: a stop would lose its data' },
  { name: 'portal-vm', kind: 'instance', reason: 'VM portal-vm backs backend service shared-bs: it belongs to an HTTP workload' },
  { name: 'kafka', kind: 'asg', reason: 'managed group kafka has a stateful configuration: a nap might not keep it' },
  { name: 'orders-sql-replica', kind: 'cloudsql-instance', reason: 'Cloud SQL instance orders-sql-replica is a read replica: Google cannot stop one' },
];
export function googleStandaloneCandidates(d: Demo, router: DemoRouter, now: number, lastSeen: number): Candidate[] {
  const { account } = router;
  const specs: GoogleCandidateSpec[] = [
    ...d.workloads.filter((w) => isStandaloneDemo(w) && w.router === router.name).map((w) => ({ name: w.name, kind: resourceKind(w), managed: w, idleHours7d: 110 })),
    ...GOOGLE_REASONS,
  ];
  return specs.map((c, i) => {
    const region = c.region ?? router.region;
    const path = googlePathOf(c.kind, c.name, account, region);
    const location = c.kind === 'instance' ? `${region}-b` : c.kind === 'asg' ? region : undefined;
    const candidate = {
      kind: 'standalone', id: path, resource: path, cloud: 'gcp', account, region, name: c.name,
      backend: { kind: c.kind, id: c.name, ...(location ? { location } : {}), ...(c.kind === 'cloudsql-instance' ? {} : { resourceId: String(BigInt(`0x${hex(`gce:${c.name}`, 14)}`)) }) },
      tags: { env: ['dev'], ...(c.labels ?? {}) },
      eligibility: c.managed ? 'managed' : c.reason ? 'ineligible' : 'eligible', ...(c.reason ? { reason: c.reason } : {}), ...(c.managed ? { workloadId: c.managed.workloadId } : {}),
      idleHours7d: c.reason ? null : c.idleHours7d ?? null,
      accountName: account, ouPath: [], scope: 'in', scopeReason: 'in scope: the Google Cloud connection\'s projects', status: 'pending-onboarding', statusReason: 'eligible',
      firstSeenAt: iso(now - (2 + i) * DAY - 3 * HOUR), lastSeenAt: iso(lastSeen), history: [],
    };
    return candidate as unknown as Candidate;
  });
}
// The run's Google Cloud problem: a project whose Cloud SQL instances were not listed, in the scan's words (M50).
export const googleRunProblem = (project: string) => `Cloud SQL instances not listed: the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project ${project}`;
