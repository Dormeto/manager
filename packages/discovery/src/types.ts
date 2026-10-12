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
  targetGroups?: string[]; // names with * or full ARNs (manual exclusions only, not in the configuration)
  label?: string; // set by manual exclusions: their reason in decisions and lint, instead of "global exclude N"
}

// A manual exclusion (router management): a target group, a load balancer or an account, kept away from Dormeto.
export type ExclusionKind = 'target-group' | 'load-balancer' | 'account';
export const EXCLUSION_KINDS: readonly ExclusionKind[] = ['target-group', 'load-balancer', 'account'];

export interface Exclusion {
  id: string;
  target: { kind: ExclusionKind; arn?: string; account: string; region?: string; name: string };
  reason: string;
  by: string;
  at: string;
  expiresAt?: string;
  paused?: { router: string; workloadId: string }[]; // managed workloads paused for it (still to resume once lifted)
  liftedAt?: string; // lifted, but some workloads could not be resumed yet: no longer applies, Lift again retries
  lapsedAt?: string; // expired, and the stored candidates re-scoped since
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

// A listener rule of a candidate.
export interface RuleRef {
  id: string; // rule ARN
  listener: string;
  priority: string;
  conditions: string;
  hosts: string[];
  managed: boolean; // tagged dormeto:workload
}

// A candidate: an application target group with every rule forwarding to it (id = target group ARN), or a rule that
// forwards to no single application target group (id = rule ARN).
export interface ScannedRule {
  id: string; // target group ARN, or rule ARN
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
  backend: { kind: BackendKind; id: string; arn?: string } | null; // arn: from 2026-10-05 scans
  tags: Record<string, string[]>; // every value of each tag on the load balancer, the target group or the rule
  rules: RuleRef[]; // sorted by priority; the first one gives priority, listener and conditions
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
