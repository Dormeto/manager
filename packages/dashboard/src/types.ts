// Shapes returned by the manager API (router controller actions).
export interface Settings {
  waitSeconds: number;
  idleMinutes: number;
  drainSeconds: number;
  wakeTimeoutSeconds: number;
  maxHolders: number;
}

export interface WorkloadSummary {
  router: string;
  workloadId: string;
  state: string;
  url: string | null;
  wakeMode: string;
  wakeCount: number;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  updatedAt: string | null;
  pendingWake: boolean;
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
  router: { version: string; build: string };
  state: string;
  updatedAt: string | null;
  awakeSince: string | null;
  wakeStartedAt: string | null;
  failedAt: string | null;
  wakeCount: number;
  holders: number;
  pendingWake: boolean;
  lastRequestAt: string | null;
  nap: { eligibleAt: string; latestAt: string; inSeconds: number } | null;
  route: string; // over all the rules: app, waker, mixed, unknown
  rules?: { arn: string; priority: string | null; conditions: string; route: string }[];
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

export interface RouterInfo {
  name: string;
  region: string;
  version?: string | null;
  build?: string | null;
  workloads?: number;
  error?: string;
  checkSchedule?: string | null;
  lastScheduledCheckAt?: string | null;
}
