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
  // Managed workloads paused for it (still to resume once lifted); account and region name the router (R4.5).
  paused?: { router: string; workloadId: string; account?: string; region?: string }[];
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
  // Event-driven refresh (packaging design §5): the manager connects the ready accounts (all, or those listed) with a
  // CloudTrail trail; off, it disconnects them. Absent: off.
  eventRefresh?: { enabled: boolean; accounts?: string[] };
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
export const CANDIDATE_STATUSES: readonly Status[] = ['pending-onboarding', 'pending-offboarding', 'managed', 'ineligible', 'dismissed', 'excluded', 'out-of-scope', 'gone'];

// Scan state of an account (R4.5): when it and each of its regions were last scanned, and for how many successive runs a
// region had no application load balancer (scanned less often).
// Organization access (packaging design §3): whether the manager can assume a role in an account.
export type AccessState = { ok: true } | { ok: false; reason: string };

export interface AccountScan {
  account: string;
  scannedAt: string;
  // emptyRuns: successive scans without any rule; skippedRuns: runs skipped since (scanned again at 6).
  regions: Record<string, { scannedAt: string; emptyRuns: number; skippedRuns?: number }>;
  runId?: string; // the run that scanned it last
  retiredAt?: string; // left the perimeter: its candidates were decided again, once
  result?: AccountResult;
  synthetic?: boolean; // written by the synthetic scanner (dev): deleted with its candidates once it is turned off
  // Both organization roles, checked at each scan (a synthetic account has none).
  // trails (event refresh on for the account, packaging design §5): per region of the perimeter, whether a CloudTrail trail
  // logs its management writes; trailsError: why they could not be read.
  access?: { discovery: AccessState; command: AccessState; checkedAt: string; trails?: Record<string, boolean>; trailsError?: string };
}

// An account of the perimeter whose access is not complete, for the Organization access panel.
export interface AccessRow {
  account: string;
  name: string;
  discovery: AccessState;
  command: AccessState;
  forwarder?: 'connected' | 'missing' | 'impossible';
  reason?: string;
}

export interface AccessCounts {
  ready: number;
  discoveryMissing: number;
  commandMissing: number;
  unchecked: number;
}

// Computed at the end of each run: the counts, every account not ready, the delegation policy.
// An account connected to event-driven refresh (packaging design §5): its forwarder role and a rule in each region.
export interface Connection {
  account: string;
  regions: string[]; // every region a connect attempted: a disconnect removes them all
  connectedAt: string;
  status?: 'connecting' | 'connected'; // connecting: a connect started and not finished (R5c review I4)
  lastError?: string; // the last connect or disconnect that failed, and when (R5c review I5)
  failedAt?: string;
}

export interface AccessSummary {
  counts: AccessCounts;
  accounts: AccessRow[]; // sorted by account
  delegation: 'ok' | 'missing' | null;
  checkedAt: string | null;
  // Event refresh on (packaging design §5): the forwarders connected, being connected by this run, and the accounts where
  // one is not possible, with the reason.
  // failed: a connect or disconnect that failed within the last day (not created again until then), with its error.
  forwarders?: { connected: number; connecting: number; impossible: { account: string; name: string; reason: string }[]; failed?: { account: string; name: string; reason: string }[] };
}

export interface AccessReport extends AccessSummary {
  cursor: string | null;
}

// What an account step of a run found, for the run record (scale design §5).
export interface AccountResult {
  pairs: { region: string; ok: boolean; error?: string; rules: number; ms: number }[];
  skipped: { reason: string; pairs: number }[];
  error?: string; // the account could not be reached
  lint: Record<string, { matched: number; excluded: number }>;
  written: number;
}

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
  status: 'running' | 'ok' | 'partial' | 'failed' | 'skipped'; // running: planned, its accounts being scanned
  skippedReason?: string;
  error?: string;
  targets: RunTarget[]; // failed account-regions, and those where rules were found
  emptyPairs?: number; // account-regions scanned without any rule (R4.5: not listed one by one)
  skipped?: { reason: string; accounts: number; pairs: number }[]; // skipped pairs per reason (absent in older records)
  counts: Partial<Record<Status, number>>;
  lint: LintFinding[];
  delegation?: 'ok' | 'missing'; // organization mode: the delegation policy of the management account answered
  // Event refresh (packaging design §5): the accounts to connect (with their regions) and to disconnect; the state machine
  // passes them to the operations.
  connections?: { connect: { account: string; regions: string[] }[]; disconnect: string[] };
}
