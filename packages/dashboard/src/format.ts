// Display helpers: relative times, durations, state colors and labels.
import { partitionOf } from './regions';

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
  const text = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

// A duration of days as days and hours (6 d 2 h), a shorter one as duration() does.
export function longDuration(seconds: number): string {
  if (seconds < 86_400) return duration(Math.round(seconds));
  const hours = Math.round(seconds / 3600);
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${hours / 24} d`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

// The same in the state chip, the history and the 7-day bar; napping's own color is in the themes (theme.ts).
const STATE_COLORS: Record<string, string> = { AWAKE: 'success', ASLEEP: 'info', WAKING: 'warning', NAPPING: 'napping', FAILED: 'error' };
export const stateColor = (state: string): string => STATE_COLORS[state] ?? 'grey';

const BACKEND_LABELS: Record<string, string> = {
  instance: 'EC2 instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'Aurora cluster',
};
export const backendLabel = (kind: string): string => BACKEND_LABELS[kind] ?? kind;
const BACKEND_HELP: Record<string, string> = {
  instance: 'started and stopped by Dormeto',
  asg: 'its instances are started and stopped through the group',
  ecs: 'scaled to zero tasks when it naps, and back when it wakes',
  'rds-instance': 'a companion database, stopped after the application and started before it',
  'rds-cluster': 'a companion database, stopped after the application and started before it',
};
// What Dormeto does with a kind of backend, for its tooltip.
export const backendHelp = (kind: string): string => `${backendLabel(kind)}${BACKEND_HELP[kind] ? `: ${BACKEND_HELP[kind]}` : ''}`;

// The ARN of a candidate's backend: recorded by discovery (scans since 2026-10-05), or rebuilt for an instance or an ECS
// service of an older scan; an Auto Scaling group's needs its id (null).
export function backendArn(backend: { kind: string; id: string; arn?: string }, where: { account: string; region: string }): string | null {
  if (backend.arn) return backend.arn;
  if (backend.id.startsWith('arn:')) return backend.id;
  if (!where.account || !where.region) return null;
  // An Auto Scaling group's ARN holds an id AWS gives it: not known from its name.
  const resource = { instance: `ec2:${where.region}:${where.account}:instance/`, 'rds-instance': `rds:${where.region}:${where.account}:db:`, 'rds-cluster': `rds:${where.region}:${where.account}:cluster:` }[backend.kind];
  return resource ? `arn:${partitionOf(where.region)}:${resource}${backend.id}` : null;
}

const BACKEND_SERVICES: Record<string, string> = {
  instance: 'Amazon EC2', asg: 'Amazon EC2 Auto Scaling', ecs: 'Amazon ECS', 'rds-instance': 'Amazon RDS', 'rds-cluster': 'Amazon Aurora',
};
// The AWS service of a kind of backend, for its tooltip.
export const backendService = (kind: string): string => BACKEND_SERVICES[kind] ?? kind;

// A load balancer target, from its id: an instance, an IP address (an ECS task's, with an ECS backend), or a function.
export function targetInfo(id: string, where: { account: string; region: string }, backends: { kind: string }[]): { service: string; arn: string | null } {
  if (id.startsWith('i-')) return { service: 'Amazon EC2 instance', arn: backendArn({ kind: 'instance', id }, where) };
  if (id.startsWith('arn:')) return { service: id.split(':')[2] === 'lambda' ? 'AWS Lambda function' : id.split(':')[2] ?? 'AWS', arn: id };
  return { service: backends.some((b) => b.kind === 'ecs') ? 'Amazon ECS task (its IP address)' : 'IP address', arn: null };
}

// A workload name (routers 0.20.0 and later): for people only, at most 64 characters without control characters; empty
// means the default (the target group name) at onboarding.
export function nameRule(value: string): true | string {
  const name = value.trim();
  if (name.length > 64) return 'at most 64 characters';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'no control characters';
  return true;
}

// "service/cluster/name" → "name"; ARNs are long.
export const shortId = (id: string): string => (id.startsWith('arn:') ? id.split('/').at(-1) ?? id : id);

// Link to the source of an IP list: the URL itself, or the S3 console object page for s3://bucket/key.
export function listSourceHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(url) ?? [];
  if (bucket && key) return `https://s3.console.aws.amazon.com/s3/object/${bucket}?prefix=${encodeURIComponent(key)}`;
  return /^https?:\/\//.test(url) ? url : null;
}

export function percent(part: number | null, total: number): string {
  return part === null ? '—' : `${Math.round((100 * part) / total)} %`;
}

// No-wake and wake rule conditions as text, as on the router admin page.
export function ruleText(conditions: Record<string, unknown>): string {
  const c = conditions as { sourceIps?: string[]; pathPrefixes?: string[]; pathPattern?: string; userAgentPattern?: string; headers?: { name: string; value?: string; pattern?: string }[] };
  return [
    c.sourceIps && `source ${c.sourceIps.join(' | ')}`,
    c.pathPrefixes && `path ${c.pathPrefixes.map((p) => `${p}*`).join(' | ')}`,
    c.pathPattern && `path ~ ${c.pathPattern}`,
    c.userAgentPattern && `user agent ~ ${c.userAgentPattern}`,
    ...(c.headers ?? []).map((h) => (h.pattern ? `header ${h.name} ~ ${h.pattern}` : `header ${h.name} = ${h.value}`)),
  ].filter(Boolean).join(', ');
}

// Health of the automatic naps: the router's idle check must have run within 3 periods of its schedule.
export function checkHealth(router: { checkSchedule?: string | null; lastScheduledCheckAt?: string | null }, now = Date.now()) {
  if (!router.lastScheduledCheckAt) return { late: true, text: 'no scheduled idle check recorded' };
  const rate = /rate\((\d+) (minute|minutes|hour|hours)\)/.exec(router.checkSchedule ?? '');
  const periodMs = rate ? Number(rate[1]) * (rate[2]!.startsWith('hour') ? 3_600_000 : 60_000) : 5 * 60_000;
  const late = now - Date.parse(router.lastScheduledCheckAt) > 3 * periodMs;
  const ago = relative(router.lastScheduledCheckAt, now);
  return { late, text: late ? `idle check late: last run ${ago}` : `idle check ${ago}` };
}

// The account's Lambda concurrency limit against what the router can need (its waker's 24-hour peak and queues); the worst case (every workload not awake
// woken at once) is information only. Routers before 0.22.3 give that worst case as the need.
export function concurrencyText(c: { limit?: number; needed?: number; worstCase?: number; error?: string } | null | undefined): string {
  if (!c) return '—';
  if (c.error) return c.error;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US');
  if (c.worstCase === undefined) return `limit ${n(c.limit)}, needs up to ${n(c.needed)}`;
  return `limit ${n(c.limit)}, needs up to ${n(c.needed)} (waker 24-hour peak and queues); ${n(c.worstCase)} if every workload not awake woke at once`;
}

// The workloads needing attention beyond those the Overview shows, or null.
export function attentionMore(total: number, shown: number): string | null {
  const more = total - shown;
  return more > 0 ? `${more} more need${more === 1 ? 's' : ''} attention` : null;
}

// Countdown shown next to the refresh button.
export function refreshLabel({ seconds, nextAt, loading }: { seconds: number; nextAt: number | null; loading: boolean }, now = Date.now()) {
  if (loading) return 'Refreshing…';
  if (!seconds || nextAt === null) return 'Auto-refresh off';
  return `Refreshing in ${duration(Math.max(0, Math.ceil((nextAt - now) / 1000)))}`;
}

// Route of a workload over all its rules (router status).
const ROUTES: Record<string, { label: string; color: string }> = {
  app: { label: 'application', color: 'success' },
  waker: { label: 'waker', color: 'info' },
  mixed: { label: 'mixed: the rules disagree (repaired at the next idle check)', color: 'warning' },
  unknown: { label: 'unknown: a rule is missing or changed', color: 'error' },
};
export const routeLabel = (route: string): string => ROUTES[route]?.label ?? route;
export const routeColor = (route: string): string => ROUTES[route]?.color ?? 'grey';

// An amount in US dollars (the estimates use AWS's USD list prices).
export const usd = (v: number): string => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

