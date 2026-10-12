// Display helpers: relative times, durations, state colors and labels.
export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
  const text = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

const STATE_COLORS: Record<string, string> = { AWAKE: 'success', ASLEEP: 'info', WAKING: 'warning', NAPPING: 'warning', FAILED: 'error' };
export const stateColor = (state: string): string => STATE_COLORS[state] ?? 'grey';

const BACKEND_LABELS: Record<string, string> = {
  instance: 'EC2 instance', asg: 'Auto Scaling group', ecs: 'ECS service', 'rds-instance': 'RDS instance', 'rds-cluster': 'Aurora cluster',
};
export const backendLabel = (kind: string): string => BACKEND_LABELS[kind] ?? kind;

// "service/cluster/name" → "name"; ARNs are long.
export const shortId = (id: string): string => (id.startsWith('arn:') ? id.split('/').at(-1) ?? id : id);

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
