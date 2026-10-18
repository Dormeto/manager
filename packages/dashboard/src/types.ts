// Shapes returned by the manager API (router controller actions).
export interface Settings {
  waitSeconds: number;
  idleMinutes: number;
  drainSeconds: number;
  wakeTimeoutSeconds: number;
  maxHolders: number;
}

// A pause of a workload or of its router (router management); exclusionId when a manual exclusion paused it.
export interface Pause {
  scope: 'workload' | 'router';
  by: string;
  at: string;
  reason: string;
  until: string | null;
  keepAsleep: boolean;
  exclusionId?: string;
}

import type { Failure, Fallback } from './failures';
import type { Energy, FleetEnergy } from './energy';

export interface WorkloadSummary {
  router: string;
  workloadId: string;
  account?: string; // the router's account (from its summary)
  name?: string; // routers 0.20.0 and later: for people, the id otherwise
  // R11: Dormeto's own tags (absent for routers before 0.30.0) and what the caller's grants allow.
  tags?: Record<string, string>;
  can?: { wake: boolean; nap: boolean };
  state: string;
  url: string | null;
  wakeMode: string;
  wakeCount: number;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  // Routers 0.25.0 (R7a): the last failure until a successful wake, the failures in a row, the next attempt, fallback types.
  failure?: Failure | null;
  consecutiveFailures?: number;
  nextAttemptAt?: string | null;
  fallbacks?: Fallback[];
  updatedAt: string | null;
  pendingWake: boolean;
  backends?: string[]; // the kinds of its backends, databases last (routers 0.23.3 and later)
  idleHours7d?: number; // hours without any request over the last 7 days, and the requests (from discovery)
  requests7d?: number | null;
  states7d?: StatesWeek; // seconds in each state over the last 7 days, from the history (asked with states=1)
  costs?: Costs; // its savings over the last 30 days (asked with states=1, in a manager with prices)
  energy?: Energy; // with its costs: the energy its naps did not use, as the API estimates it
  pauses?: Pause[]; // routers 0.16 and later
  stats7d: { ignored: number; deferred: number; wakes: number } | null;
  settings: Settings;
}

// Seconds in each state over a period of 7 days (UNKNOWN: without history).
export interface StatesWeek { from: string; to: string; totals: Record<string, number> }

// What a nap stopped (router 0.27.0), as the savings price it.
export type StoppedItem =
  | { kind: 'ec2'; type: string; count: number; os: string; spot?: true }
  | { kind: 'fargate'; vcpu: number; memoryGb: number; count: number; arch: string; os: string; spot?: true }
  | { kind: 'rds'; class: string; engine: string; multiAz: boolean }
  | { kind: 'aurora-serverless'; engine: string; acu: number }
  // Pods on EC2 nodes (router 0.29.0, R10.5).
  | { kind: 'k8s-pods'; count: number; cpu: number; memoryGb: number; nodeType: string | null; os: string; spot?: true; autoscaled: boolean; allocatable: { cpu: number; memoryGb: number } }
  | { kind: 'unknown'; backend: string; reason: string };

// A workload's savings over the last 30 days (the API, with its states): what its naps saved, the share of its time with
// history asleep within the baseline, its last nap's items at their hourly list prices (null: not priced).
export interface Costs {
  baseline: { kind: 'always' } | { kind: 'business-hours'; timeZone: string };
  from: string;
  to: string;
  napAt: string | null;
  savedShare: number | null;
  items: { item: StoppedItem; hourly: number | null }[];
  saved: { usd: number; hours: number; unpricedHours: number };
  discounts?: Discounts; // when one is set (R9.5)
}
// Percentages off the list prices for commitments (R9.5): compute (EC2, Fargate), databases (RDS, Aurora).
export interface Discounts { compute: number; databases: number }
export interface SavingsSettings extends Discounts { updatedAt: string | null; updatedBy: string | null }

// All the workloads the caller sees (GET /api/workloads/states): their seconds in each state over 7 days and their
// savings, from each workload's figures kept cacheMinutes.
export interface FleetStates {
  workloads: number;
  computedAt: string;
  cacheMinutes: number;
  states7d: StatesWeek;
  costs?: { baseline: Costs['baseline']; saved: Costs['saved']; hourly: number | null; monthly: number | null; priced: number; discounts?: Discounts };
  energy?: FleetEnergy; // with its costs: the energy the naps did not use, as the API estimates it (the Overview)
}

export interface Counts {
  ignored: Record<string, number>;
  deferred: Record<string, number>;
  wakes: Record<string, number>;
}

export interface Backend {
  kind: string;
  id: string;
  status: string;
  // A Kubernetes workload (router 0.29.0): its cluster, recorded replicas, KEDA and how the waker is switched in.
  cluster?: string;
  replicas?: number;
  keda?: boolean;
  switch?: string;
  min?: number;
  max?: number;
  desired?: number;
  companion?: boolean;
  warmPool?: { state: string; size: number; reuseOnScaleIn: boolean } | null;
}

export interface Rule {
  name: string;
  level: string;
  conditions: Record<string, unknown>;
  invalid?: string;
}

export interface WorkloadStatus {
  workloadId: string;
  name?: string; // routers 0.20.0 and later
  tags?: Record<string, string>; // R11: absent for routers before 0.30.0
  can?: { wake: boolean; nap: boolean }; // R11: what the caller's grants allow
  url?: string | null; // from its summary (manager 0.2 and later)
  router: { version: string; build: string };
  state: string;
  updatedAt: string | null;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  failure?: Failure | null; // routers 0.25.0 (R7a)
  consecutiveFailures?: number;
  nextAttemptAt?: string | null;
  fallbacks?: Fallback[];
  wakeCount: number;
  holders: number;
  pendingWake: boolean;
  pauses?: Pause[];
  targetGroupArn?: string;
  source?: 'terraform' | 'manager'; // routers 0.18.2 and later
  account?: string; // the manager's: where the workload is (the ARNs of its backends and targets)
  region?: string;
  states7d?: StatesWeek; // the manager's: as on its Workloads row
  costs?: Costs;
  energy?: Energy;
  idleHours7d?: number;
  requests7d?: number | null;
  drift?: { at: string; kind: string; detail: string; by: string }[]; // repairs of what onboarding added, newest first
  lastRequestAt: string | null;
  nap: { eligibleAt: string; latestAt: string; inSeconds: number } | null;
  route: string; // over all the rules: app, waker, mixed, unknown
  rules?: { arn: string; priority: string | null; conditions: string; route: string; issue?: string }[];
  issues?: string[]; // rules forwarding to the target group that the router cannot switch: no nap while any
  backends: Backend[];
  ignoredTargets: { id: string; reason: string }[];
  recommendations: { backend: string; message: string }[];
  targets: { id: string; state: string }[];
  settings: Settings;
  stats: { days: number; since: string; today: Counts; total: Counts } | { error: string } | null;
  ipLists: { name: string; action: string; url?: string; entries: number; fetchedAt: string | null; error?: string }[];
  wakeMode: string;
  wakeRules: Rule[];
  noWakeRules: Rule[];
}

export interface Problem {
  level: 'warning' | 'error';
  code?: string; // routers 0.24.0
  text: string;
}

// Health alarms (R6a): the watchdog's open alarms, and where the alert topic sends them.
export interface AlarmInfo {
  id: string;
  kind: 'router' | 'list' | 'workload';
  name: string;
  account?: string;
  region?: string;
  // A failed wake (R7b): the workload's router, as the Routers view names it, and its id.
  router?: string;
  workloadId?: string;
  level: 'warning' | 'error';
  since: string;
  problems: (Problem & { code: string; since: string; hint?: string })[];
}
// The manager's IP lists (R6b): its catalog, with what the list function last did for each list.
export interface IpListRow {
  name: string;
  url: string;
  action: 'defer' | 'ignore';
  refreshHours: number;
  version?: string;
  entries?: number;
  dropped?: number;
  fetchedAt?: string;
  lastAttemptAt?: string;
  error?: string;
}
export interface IpListsInfo { catalog: string | null; lists: IpListRow[] }

export interface AlertsInfo {
  alarms: AlarmInfo[];
  notifications: { topicArn: string; confirmed: number; pending: number; endpoints?: { protocol: string; endpoint: string; pending: boolean }[] } | null;
}

// One row of the Routers view (health, pauses and workload states from routers 0.16 and later).
export interface RouterInfo {
  name: string;
  region: string;
  account?: string;
  clusters?: ClusterCheck[];
  reporting?: boolean; // its state comes from its events (router 0.21.0 and later with the manager's bus)
  checkedAt?: string;
  source?: 'terraform' | 'manager';
  version?: string | null;
  build?: string | null;
  workloads?: number;
  error?: string;
  checkSchedule?: string | null;
  lastScheduledCheckAt?: string | null;
  health?: { status: 'ok' | 'warning' | 'error'; problems: Problem[] };
  pauses?: Pause[];
  workloadStates?: Record<string, number>;
  paused?: number;
  lastActivityAt?: string | null;
  operation?: { id: string; type: RouterOperationType }; // the install, upgrade or uninstall running on it
}

export type RouterOperationType = 'install-router' | 'upgrade-router' | 'uninstall-router';

export interface Configured<T> {
  value: T;
  source: 'terraform' | 'manager';
}

// GET /api/routers/{name}: the router action.
// An EKS cluster of a router's account and region, as the router's last check found it (R10.5).
export interface ClusterCheck { name: string; reachable: boolean; allowed: boolean; missing: string[]; reason?: string; checkedAt: string }

export interface RouterDetails {
  name: string;
  region: string;
  account?: string;
  clusters?: ClusterCheck[];
  router: { name: string; version: string; build: string };
  configuration: {
    checkSchedule: Configured<string | null>;
    ipLists: Configured<{ name: string; url: string; action: string; refreshHours: number }[]>;
    // The manager's lists (routers 0.24.0 with a catalog).
    ipListsCatalog?: Configured<{ url: string; lists: { name: string; action: string; refreshHours: number }[] }>;
    noWakeRules: Configured<Rule[]>;
    metrics: Configured<boolean | null>;
  };
  pauses: Pause[];
  workloads: { total: number; byState: Record<string, number>; paused: number; lastActivityAt: string | null };
  health: {
    status: 'ok' | 'warning' | 'error';
    problems: Problem[];
    checkSchedule: string | null;
    lastScheduledCheckAt: string | null;
    lambda: { error?: string; controller?: { errors: number; throttles: number }; waker?: { errors: number; throttles: number; peakConcurrency: number } };
    queues: { error?: string; check?: number; controller?: number };
    ipLists: { name: string; entries: number; fetchedAt: string | null; error?: string; source?: 'terraform' | 'manager'; pending?: boolean }[];
    concurrency?: { limit?: number; needed?: number; worstCase?: number; error?: string } | null;
  };
}

export type ExclusionKind = 'target-group' | 'load-balancer' | 'account';

export interface ExclusionTarget {
  kind: ExclusionKind;
  arn?: string;
  account: string;
  region?: string;
  name: string;
}

export interface Exclusion {
  id: string;
  target: ExclusionTarget;
  reason: string;
  by: string;
  at: string;
  expiresAt?: string;
  paused?: { router: string; workloadId: string; account?: string; region?: string; name?: string }[]; // name: from its summary
  expired?: boolean;
  liftedAt?: string;
  lifting?: boolean; // lifted, some workloads not resumed yet: Lift again retries
}

// Operations (onboarding, R4b): run by the workflow, step by step.
// update-manager: a request of the Update page, run by the install build (its context gives the build and its console page).
export type OperationType = 'install-router' | 'upgrade-router' | 'uninstall-router' | 'onboard' | 'offboard' | 'exclude' | 'lift-exclusion'
  | 'connect-account' | 'disconnect-account' | 'update-manager';
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface Operation {
  id: string;
  type: OperationType;
  target: Record<string, string>;
  input: Record<string, unknown>;
  context?: Record<string, unknown>; // learnt during the run: the workload id and name of an onboarding, a manager update's build
  status: 'running' | 'succeeded' | 'failed';
  steps: { name: string; status: StepStatus; startedAt?: string; finishedAt?: string; detail?: string; attempts?: number }[];
  cursor: number;
  by: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

// A workload's state history over a period (R8): GET /api/workloads/{router}/{id}/history.
export interface HistoryEntry {
  from: string | null;
  to: string;
  at: string;
  cause?: string;
  by?: string;
  durationMs?: number;
  failure?: { kind: string; step: string; message: string };
  inferred?: boolean;
}
export interface WorkloadHistory {
  from: string;
  to: string;
  phases: import('./history').Phase[];
  totals: Record<string, number>;
  wakes: { count: number; failed: number; medianMs: number | null; maxMs: number | null };
  before: HistoryEntry | null;
  entries: HistoryEntry[];
  truncated: boolean;
  savings?: PeriodSavings; // R9
}

// Savings (R9): a period's estimate (the workload history), and the daily job's summary (the Overview).
export interface PeriodSavings {
  usd: number;
  hours: number;
  items: { item: Record<string, unknown> & { kind: string }; hourly: number; hours: number; usd: number }[];
  unpriced: { reason: string; item?: Record<string, unknown>; hours: number }[];
  baseline: { kind: string; timeZone?: string };
  discounts?: Discounts;
}
export interface SavingsSummary {
  computedAt: string;
  day: string;
  baseline: { kind: string; timeZone?: string };
  last30: { usd: number; asleepHours: number; days: { date: string; usd: number }[] };
  month: { month: string; usd: number };
  cumulative: { usd: number; since: string; lastDay: string };
  top: { account: string; region: string; router: string; workloadId: string; name?: string; usd: number }[];
  unpriced: { workloads: number; hours: number };
  workloads: number;
  dormeto: { usdMonth: number };
  discounts?: Discounts; // those of its latest day (R9.5)
}


// A workload's idle window advice (R10): GET /api/workloads/<router>/<id>/idle-window. asleepHours: hours asleep a day.
export interface IdleWindowRow { minutes: number; asleepHours: number; usdMonth: number | null; wakesPerDay: number; waitSecondsPerDay: number | null }
export interface IdleWindowAdvice {
  computedAt: string;
  from: string;
  to: string;
  current: number;
  recommended: number;
  checkMinutes: number;
  wakeSeconds: number | null;
  priced: boolean;
  windows: IdleWindowRow[];
  actual: { wakes: number; replayedWakes: number; noisy: boolean };
  wakerTargetGroup: boolean;
}
