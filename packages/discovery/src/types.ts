// Organization discovery (vision docs/specs/2026-10-04-org-discovery-design.md).

export type BackendKind = 'instance' | 'asg' | 'ecs';
export const BACKEND_KINDS: readonly BackendKind[] = ['instance', 'asg', 'ecs'];

export interface Criterion {
  note?: string;
  accountIds?: string[];
  ouIds?: string[];
  accountTags?: Record<string, string[]>; // [] = any value
  regions?: string[];
  loadBalancers?: string[]; // names with * or full ARNs
  hosts?: string[]; // with *
  resourceTags?: Record<string, string[]>; // load balancer, rule or target group
  backendKinds?: BackendKind[];
}

export interface Filter {
  name: string;
  include: Criterion[];
  exclude: Criterion[];
}

export interface DiscoveryConfig {
  version: 1;
  mode: 'organization' | 'account';
  regions: string[]; // or ['*']
  refreshHours: number;
  globalExcludes: Criterion[];
  filters: Filter[];
}

export interface Account {
  id: string;
  name: string;
  ouPath: string[]; // root first, parent last
  tags: Record<string, string>;
}

export interface OrgInventory {
  accounts: Account[];
  ous: Record<string, { name: string; parent: string | null }>; // the root included, with parent null
}

export interface ScannedRule {
  id: string; // rule ARN
  account: string;
  region: string;
  loadBalancer: string;
  loadBalancerArn: string;
  listener: string;
  priority: string;
  conditions: string;
  hosts: string[];
  targetGroup: string | null;
  targetGroupArn: string | null;
  suggestedId: string | null;
  backend: { kind: BackendKind; id: string } | null;
  tags: Record<string, string[]>; // every value of each tag on the load balancer, the target group or the rule
  eligibility: 'managed' | 'eligible' | 'ineligible';
  reason?: string;
  workloadId?: string;
  idleHours7d: number | null;
  requests7d: number | null;
}

export interface Decision {
  scope: 'in' | 'out' | 'excluded';
  reason: string;
}

export interface AccountPlan {
  account: string;
  scan: boolean;
  reason: string;
}

export interface PairPlan {
  account: string;
  region: string;
  scan: boolean;
  reason: string;
}

export interface PairResult {
  account: string;
  region: string;
  ok: boolean;
  error?: string;
  rules: ScannedRule[];
  ms: number;
}

export type Status =
  | 'pending-onboarding'
  | 'dismissed'
  | 'managed'
  | 'pending-offboarding'
  | 'ineligible'
  | 'out-of-scope'
  | 'excluded'
  | 'gone';

export interface Candidate extends ScannedRule {
  accountName: string;
  ouPath: string[];
  scope: Decision['scope'];
  scopeReason: string;
  status: Status;
  statusReason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  goneAt?: string;
  dismissed?: { by: string; at: string; note?: string };
  history: { at: string; status: Status; reason: string }[]; // newest last, at most 20
}

export interface LintFinding {
  code:
    | 'include-shadowed-by-global-exclude'
    | 'include-shadowed-by-filter-exclude'
    | 'include-everything'
    | 'include-matches-nothing'
    | 'include-only-globally-excluded';
  level: 'warning' | 'info';
  filter: string;
  include: number; // 1-based
  by?: string;
  message: string;
}

export interface RunTarget {
  account: string;
  region: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  reason?: string;
  ms?: number;
  rules?: number;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  trigger: 'schedule' | 'manual';
  by?: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  skippedReason?: string;
  error?: string;
  targets: RunTarget[]; // scanned and failed account-regions
  skipped?: { reason: string; accounts: number; pairs: number }[]; // skipped pairs per reason (absent in older records)
  counts: Partial<Record<Status, number>>;
  lint: LintFinding[];
}
