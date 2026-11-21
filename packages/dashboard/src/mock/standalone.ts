// The demo's standalone workloads and candidates (vision standalone workloads design §6): a workload of each kind of resource
// in several states (awake, asleep by its schedule, asleep on its idle signals, failed, its resource missing), the
// standalone candidates of a run with the perimeter's standalone scan on (eligible, and each family of the router's
// reasons), as the manager answers them (task-M45-report.md's shapes).
import type { Candidate, StandaloneCandidate } from '@dormeto/discovery/types';
import type { IdleMetric, IdleSignal, Settings, WorkloadStatus, WorkloadSummary } from '../types';
import type { Schedule } from '../schedule';
import { ORG, accountName } from './org';
import { DAY, HOUR, MINUTE, SECOND, hex, iso } from './util';
import type { BackendSpec } from './fixtures';
import type { Demo, DemoRouter, DemoWorkload } from './state';

type ResourceKind = StandaloneCandidate['backend']['kind'];
export interface StandaloneSpec { name: string; kind: ResourceKind; state: 'AWAKE' | 'ASLEEP' | 'FAILED'; by?: 'schedule' | 'idle'; missing?: boolean; metric?: IdleMetric; backends: BackendSpec[] }

const arnOf = (kind: ResourceKind, id: string, account: string, region: string, cluster: string) => ({
  instance: `arn:aws:ec2:${region}:${account}:instance/${id}`,
  asg: `arn:aws:autoscaling:${region}:${account}:autoScalingGroup:${hex(`asg:${id}`, 8)}-0000-4000-8000-${hex(`asg2:${id}`, 12)}:autoScalingGroupName/${id}`,
  ecs: `arn:aws:ecs:${region}:${account}:service/${cluster}/${id}`,
  'rds-instance': `arn:aws:rds:${region}:${account}:db:${id}`,
  'rds-cluster': `arn:aws:rds:${region}:${account}:cluster:${id}`,
}[kind]);
const resourceId = (kind: ResourceKind, name: string) => (kind === 'instance' ? `i-0${hex(`standalone:${name}`, 16)}` : name);

export const STANDALONE_WORKLOADS: StandaloneSpec[] = [
  { name: 'build-agent', kind: 'instance', state: 'AWAKE', backends: [{ kind: 'instance', type: 't3.large' }], metric: { namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: { Agent: '${resource}' }, statistic: 'Maximum', below: 1 } },
  { name: 'batch-workers', kind: 'asg', state: 'ASLEEP', by: 'schedule', backends: [{ kind: 'asg', type: 'c6g.xlarge', count: 3 }] },
  { name: 'queue-worker', kind: 'ecs', state: 'ASLEEP', by: 'idle', backends: [{ kind: 'ecs', vcpu: 1, memoryGb: 2, count: 2 }] },
  { name: 'reports-db', kind: 'rds-instance', state: 'FAILED', backends: [{ kind: 'rds', id: 'reports-db', class: 'db.t4g.medium' }] },
  { name: 'analytics', kind: 'rds-cluster', state: 'AWAKE', missing: true, backends: [{ kind: 'rds', id: 'analytics', class: 'db.r6g.large' }] },
];
const NIGHTS: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '07:00', end: '19:00' }, { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '19:00', end: '07:00' }], maxNapDays: 7 };

const isDatabase = (kind: ResourceKind) => kind.startsWith('rds-');
// The built-in idle signals of its kind (the router's STANDALONE_BUILT_IN, a database's connections under 1).
function builtIns(kind: ResourceKind, id: string): Settings & Record<string, unknown> {
  return {
    idleMinutes: 120, wakeTimeoutSeconds: isDatabase(kind) ? 1800 : 600, idleCpuPercent: isDatabase(kind) ? 'off' : 5, idleNetworkBytes: 'off',
    idleMetric: isDatabase(kind) ? { namespace: 'AWS/RDS', name: 'DatabaseConnections', dimensions: { [kind === 'rds-cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: id }, statistic: 'Maximum', below: 1 } : 'off',
  } as unknown as Settings & Record<string, unknown>;
}

// A standalone workload of the demo, from a generated one (its history, its prices), as a router 0.42.0 keeps it.
export function standaloneWorkload(spec: StandaloneSpec, router: DemoRouter, build: (backends: BackendSpec[]) => DemoWorkload, now: number): DemoWorkload {
  const w = build(spec.backends);
  const id = resourceId(spec.kind, spec.name);
  const settings = builtIns(spec.kind, id);
  if (spec.metric) settings.idleMetric = spec.metric;
  Object.assign(w, {
    workloadId: hex(`standalone:${spec.name}`, 16), name: spec.name, kind: 'standalone', resourceKind: spec.kind, resourceArn: arnOf(spec.kind, id, router.account, router.region, `${router.name}-jobs`),
    resourceId: id, resourceMissing: Boolean(spec.missing), hosts: [], ruleArns: [], targetGroupArn: '', loadBalancerArn: '', source: 'manager', settings, ownKeys: spec.metric ? ['idleMetric'] : [],
    wakeRules: [], noWakeRules: [], schedule: spec.by === 'schedule' ? NIGHTS : null, instanceId: id,
  });
  // Nothing wakes it on demand: its wakes are its schedule's, else a person's (the generated history says requests).
  for (const e of w.entries) {
    if (e.to === 'WAKING' && e.cause && !['manager', 'pause', 'schedule', 'maintenance'].includes(e.cause)) Object.assign(e, spec.by === 'schedule' ? { cause: 'schedule', by: undefined } : { cause: 'manager', by: 'ops@dormeto.example' });
  }
  if (spec.state === 'FAILED') {
    w.failure = { kind: 'timeout', step: 'wake', message: 'reports-db is still starting after 30 minutes: its storage is being restored', at: iso(now - 25 * MINUTE) } as DemoWorkload['failure'];
    w.consecutiveFailures = 2;
    w.nextAttemptAt = now + 4 * MINUTE;
  }
  return w;
}
export const isStandaloneDemo = (w: DemoWorkload) => (w as { kind?: string }).kind === 'standalone';
const resourceKind = (w: DemoWorkload) => (w as unknown as { resourceKind: ResourceKind }).resourceKind;
const resourceArn = (w: DemoWorkload) => (w as unknown as { resourceArn: string }).resourceArn;
const resourceIdOf = (w: DemoWorkload) => (w as unknown as { resourceId: string }).resourceId;
const missing = (w: DemoWorkload) => Boolean((w as unknown as { resourceMissing?: boolean }).resourceMissing);
const STANDALONE_KEYS = ['idleMinutes', 'wakeTimeoutSeconds', 'idleCpuPercent', 'idleNetworkBytes', 'idleMetric'];

// Its row (the handover's keys): no URL, wake mode nor target group; its kind's settings and where each comes from.
export function standaloneRow(w: DemoWorkload, row: WorkloadSummary): WorkloadSummary {
  const { url: _u, wakeMode: _m, targetGroupArn: _t, ...rest } = row as WorkloadSummary & { targetGroupArn?: string };
  const own = w.ownKeys ?? [];
  return {
    ...rest, kind: 'standalone', resourceArn: resourceArn(w), ...(missing(w) ? { resourceMissing: true as const } : {}),
    stats7d: { wakes: row.stats7d?.wakes ?? 0 },
    settings: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, (w.settings as unknown as Record<string, unknown>)[k]])) as unknown as WorkloadSummary['settings'],
    settingsFrom: Object.fromEntries(STANDALONE_KEYS.map((k) => [k, own.includes(k) ? 'workload' : 'default'])),
    type: isDatabase(resourceKind(w)) ? 'databases' : resourceKind(w),
  };
}

// Its idle signals, by its state: awake and busy on one, under on the others; asleep, none read; failed, not applying.
function signalsOf(w: DemoWorkload, now: number): IdleSignal[] {
  const s = w.settings as unknown as { idleCpuPercent: number | 'off'; idleNetworkBytes: number | 'off'; idleMetric: IdleMetric | 'off' };
  const own = w.ownKeys ?? [];
  const from = (k: string) => (own.includes(k) ? 'workload' as const : 'default' as const);
  const awake = w.state === 'AWAKE';
  const signal = (key: 'cpu' | 'network' | 'metric', setting: number | 'off' | IdleMetric, value: number, under: boolean, k: string): IdleSignal => {
    if (setting === 'off') return { signal: key, below: null, value: null, underSince: null, applies: false, reason: 'off', from: from(k) };
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
  const backend = kind === 'asg' ? { kind, id, status: backendStatus, min: 0, desired: w.state === 'AWAKE' ? 3 : 0, max: 3, warmPool: null }
    : kind === 'ecs' ? { kind, id: resourceArn(w), status: backendStatus, desired: w.state === 'AWAKE' ? 2 : 0 } : { kind, id, status: backendStatus };
  const own = w.ownKeys ?? [];
  return {
    ...rest, kind: 'standalone', resourceArn: resourceArn(w), idle: signals,
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
const LABELS: Record<ResourceKind, string> = { instance: 'instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'RDS cluster' };

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
