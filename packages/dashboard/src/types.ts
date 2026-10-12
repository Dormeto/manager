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

export interface WorkloadSummary {
  router: string;
  workloadId: string;
  name?: string; // routers 0.20.0 and later: for people, the id otherwise
  state: string;
  url: string | null;
  wakeMode: string;
  wakeCount: number;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  updatedAt: string | null;
  pendingWake: boolean;
  pauses?: Pause[]; // routers 0.16 and later
  stats7d: { ignored: number; deferred: number; wakes: number } | null;
  settings: Settings;
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
  router: { version: string; build: string };
  state: string;
  updatedAt: string | null;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  wakeCount: number;
  holders: number;
  pendingWake: boolean;
  pauses?: Pause[];
  targetGroupArn?: string;
  source?: 'terraform' | 'manager'; // routers 0.18.2 and later
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
  text: string;
}

// One row of the Routers view (health, pauses and workload states from routers 0.16 and later).
export interface RouterInfo {
  name: string;
  region: string;
  account?: string;
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
}

export interface Configured<T> {
  value: T;
  source: 'terraform' | 'manager';
}

// GET /api/routers/{name}: the router action.
export interface RouterDetails {
  name: string;
  region: string;
  account?: string;
  router: { name: string; version: string; build: string };
  configuration: {
    checkSchedule: Configured<string | null>;
    ipLists: Configured<{ name: string; url: string; action: string; refreshHours: number }[]>;
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
    ipLists: { name: string; entries: number; fetchedAt: string | null; error?: string }[];
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
  paused?: { router: string; workloadId: string }[];
  expired?: boolean;
  liftedAt?: string;
  lifting?: boolean; // lifted, some workloads not resumed yet: Lift again retries
}

// Operations (onboarding, R4b): run by the workflow, step by step.
export type OperationType = 'install-router' | 'upgrade-router' | 'uninstall-router' | 'onboard' | 'offboard';
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface Operation {
  id: string;
  type: OperationType;
  target: Record<string, string>;
  input: Record<string, unknown>;
  context?: Record<string, unknown>; // learnt during the run: the workload id and name of an onboarding
  status: 'running' | 'succeeded' | 'failed';
  steps: { name: string; status: StepStatus; startedAt?: string; finishedAt?: string; detail?: string; attempts?: number }[];
  cursor: number;
  by: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}
