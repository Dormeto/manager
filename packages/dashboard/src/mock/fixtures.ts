// The demo's reference data (npm run dev:mock): the shapes of a demo organization, AWS prices, the router's built-in
// rules, and the names a scenario draws from. The organization itself is generated (scenario.ts), not written here.
import type { BackendKind, Candidate } from '@dormeto/discovery/types';
import type { Rule } from '../types';

// Discovery's description of a Kubernetes candidate (R10.5).
export type KubernetesCandidate = NonNullable<NonNullable<Candidate['backend']>['kubernetes']>;

// The router version the manager carries (an upgrade is offered below it), and the one before.
export const AVAILABLE = { version: '0.29.0', build: '4f2a9c71d0e3' };
export const PREVIOUS = { version: '0.28.1', build: 'b81e04d6a5c2' };

export interface AccountSpec { id: string; name: string; ou: string; command: boolean }

// Hours from UTC of the people using each region's workloads (October: summer time).
export const TIME_ZONES: Record<string, number> = { 'eu-west-1': 1, 'eu-west-3': 2, 'eu-central-1': 2, 'us-east-1': -4, 'us-west-2': -7 };

// AWS list prices an hour (Linux, on demand). A scenario's regions are among these.
export const EC2_PRICES: Record<string, Record<string, number>> = {
  'eu-west-1': { 't3.small': 0.0228, 't3.medium': 0.0456, 't4g.large': 0.0736, 'm6i.large': 0.107, 'm6i.xlarge': 0.214 },
  'eu-west-3': { 't3.small': 0.0238, 't3.medium': 0.0476, 't4g.large': 0.0768, 'm6i.large': 0.112, 'm6i.xlarge': 0.224 },
  'eu-central-1': { 't3.small': 0.024, 't3.medium': 0.048, 't4g.large': 0.0768, 'm6i.large': 0.115, 'm6i.xlarge': 0.23 },
  'us-east-1': { 't3.small': 0.0208, 't3.medium': 0.0416, 't4g.large': 0.0672, 'm6i.large': 0.096, 'm6i.xlarge': 0.192 },
  'us-west-2': { 't3.small': 0.0208, 't3.medium': 0.0416, 't4g.large': 0.0672, 'm6i.large': 0.096, 'm6i.xlarge': 0.192 },
};
export const REGIONS = Object.keys(EC2_PRICES);
// Fargate: per vCPU and per GB an hour (x86; Graviton 20% less).
export const FARGATE_PRICES: Record<string, [number, number]> = {
  'eu-west-1': [0.04048, 0.004445], 'eu-west-3': [0.04656, 0.00511], 'eu-central-1': [0.04656, 0.00511], 'us-east-1': [0.04048, 0.004445],
  'us-west-2': [0.04048, 0.004445],
};
export const RDS_PRICES: Record<string, Record<string, number>> = {
  'eu-west-1': { 'db.t4g.medium': 0.072, 'db.r6g.large': 0.258 },
  'eu-west-3': { 'db.t4g.medium': 0.076, 'db.r6g.large': 0.271 },
  'eu-central-1': { 'db.t4g.medium': 0.074, 'db.r6g.large': 0.265 },
  'us-east-1': { 'db.t4g.medium': 0.065, 'db.r6g.large': 0.225 },
  'us-west-2': { 'db.t4g.medium': 0.065, 'db.r6g.large': 0.225 },
};

export interface RouterSpec {
  name: string;
  account: string;
  region: string;
  source: 'terraform' | 'manager';
  version: string;
  build: string;
  installedDays: number;
  metrics: boolean | null;
  concurrency: { limit: number; needed: number; worstCase: number };
  peak: number;
  clusters?: string[];
  // A router written in Terraform may download lists of its own.
  ownLists?: { name: string; url: string; action: string; refreshHours: number; entries: number }[];
}

// The router's built-in no-wake rules (health checks, an uptime monitor).
export const ROUTER_RULES: Rule[] = [
  { name: 'health-checks', level: 'router', conditions: { userAgentPattern: '^(ELB-HealthChecker|Amazon-Route53-Health-Check-Service|kube-probe)' } },
  { name: 'uptime-monitor', level: 'router', conditions: { sourceIps: ['198.51.100.0/24'] } },
];

export interface IpList { name: string; url: string; action: 'ignore' | 'defer'; refreshHours: number; entries: number }

export type State = 'AWAKE' | 'ASLEEP' | 'NAPPING' | 'WAKING' | 'FAILED';
// office: weekdays, working hours; busy: every day, long hours; sporadic: a few visits a week.
export type Profile = 'office' | 'busy' | 'sporadic';
export type BackendSpec =
  | { kind: 'instance'; type: string }
  | { kind: 'asg'; type: string; count: number; warmPool?: boolean }
  | { kind: 'ecs'; vcpu: number; memoryGb: number; count: number; arm?: boolean }
  | { kind: 'k8s'; cluster: string; namespace: string; owner: string; count: number; vcpu: number; memoryGb: number; nodeType: string }
  | { kind: 'rds'; id: string; class: string };

export interface WorkloadSpec {
  name: string;
  router: string;
  state: State;
  profile: Profile;
  backends: BackendSpec[];
  idleMinutes: number;
  wakeMode: 'any' | 'browser';
  source: 'terraform' | 'manager';
  days?: number; // of history (40 by default)
  awakeFor?: number; // minutes, when awake
  noise?: number; // scanner requests a day, ignored by the waker
  hosts?: string[];
  paused?: { by: string; hoursAgo: number; reason: string; untilHours: number | null };
  wakeRules?: Rule[];
  noWakeRules?: Rule[];
  drift?: boolean;
}

export const API_CLIENTS: Rule = { name: 'api-clients', level: 'wake', conditions: { headers: [{ name: 'x-api-key', pattern: '.+' }] } };
export const STATIC: Rule = { name: 'static-assets', level: 'workload', conditions: { pathPrefixes: ['/static/', '/favicon.ico'] } };

// Discovery candidates that are not workloads (the managed ones come from the workloads). Those an exclusion covers
// are listed with the status they would have without it.
export interface CandidateSpec {
  name: string;
  account: string;
  region: string;
  host: string;
  backend: { kind: BackendKind; kubernetes?: KubernetesCandidate } | null;
  status: 'pending-onboarding' | 'ineligible' | 'dismissed' | 'gone';
  reason?: string;
  ruleOnly?: boolean; // a rule forwarding to no single application target group (its id is the rule's ARN)
  idleHours7d: number | null;
  requests7d: number | null;
  firstSeenDays: number;
  dismissed?: { by: string; daysAgo: number; note: string };
  goneDays?: number;
  excluded?: { by: string; daysAgo: number; reason: string }; // a manual exclusion of its target group
}

export interface Person { email: string; role: 'admin' | 'operator' | 'viewer'; status: string; enabled: boolean; createdDays: number; mfa: boolean | null }

// --- What a scenario draws from ------------------------------------------------------------------------------------

export const FIRST_NAMES = ['alex', 'sam', 'jordan', 'taylor', 'casey', 'morgan', 'riley', 'jamie', 'robin', 'charlie', 'drew', 'quinn', 'avery', 'emery', 'kai', 'noa'];
export const LAST_NAMES = ['martin', 'lee', 'diaz', 'brooks', 'nguyen', 'bernard', 'kim', 'rossi', 'dubois', 'silva', 'novak', 'haddad', 'moreau', 'okafor', 'lindqvist', 'tanaka'];
// Non-production accounts (the perimeter never reaches production); 'sandbox' ones go in the sandbox OU.
export const ACCOUNT_NAMES = ['dev', 'staging', 'sandbox', 'data-platform', 'qa', 'marketing-sites', 'analytics-dev', 'mobile-dev', 'platform-dev', 'integration',
  'research', 'training', 'partners-sandbox', 'ml-dev', 'ops-tools', 'web-dev', 'payments-dev', 'support-sandbox'];
export const APPS = ['shop', 'billing', 'hr-portal', 'docs', 'partner-api', 'checkout', 'data-lab', 'admin', 'search', 'crm', 'events', 'support-kb', 'ml-notebook',
  'payroll', 'media', 'labs-api', 'intranet', 'wiki', 'etl-console', 'reporting', 'catalog-api', 'promo-site', 'inventory', 'booking', 'analytics', 'notifications',
  'pricing', 'onboarding', 'loyalty', 'chat', 'forms', 'maps', 'invoicing', 'quotes', 'tickets', 'survey', 'recruiting', 'expenses', 'warehouse', 'portal', 'scheduler'];
export const STAGES = ['dev', 'staging', 'uat', 'qa', 'sandbox', 'demo', 'test'];
export const PAUSE_REASONS = ['Load test of the 4.2 release candidate', 'Customer demo this week', 'Data migration in progress', 'Security review: must stay up',
  'Training session all week'];
export const DISMISS_NOTES = ['Embedded in the public site: must answer at once', 'Called by a partner every minute', 'Kept warm for the sales team'];
export const EXCLUSION_REASONS = ["Vendor-managed: the vendor's monitoring expects it always on", 'Shared with an external auditor', 'Being decommissioned'];
export const ACCOUNT_EXCLUSION_REASONS = ['Performance tests until the end of the release', 'Penetration test in progress', 'Quarterly close: everything stays up'];
