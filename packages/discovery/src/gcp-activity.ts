// A Google Cloud standalone workload's signals over its last days (plan 5, M51): the activity step's Google Cloud form, as the
// discovery account (dormetoDiscovery: compute.instanceGroupManagers.get for a group's VMs, monitoring.timeSeries.list). The reads
// are the router's (gcp/src/idle-signals.mjs, through @dormeto/fleet googleActivityPlan), in 5-minute points to the window's end 10
// minutes behind; each series' points merged by its label as the router merges them, keyed `<read>:<label>`.
import { googleActivityPlan, type GoogleBackend, type GoogleMetric, type PlannedSignal } from '@dormeto/fleet';
import type { GooglePort } from './google.js';

type Call = GooglePort['call'];
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const PERIOD_MS = 300_000;
const METRIC_LAG_MS = 600_000;
const DAY_MS = 86_400_000;
const nameOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

interface Series { metric?: { labels?: Record<string, string> }; points?: { interval?: { endTime?: string }; value?: { doubleValue?: number; int64Value?: string | number } }[] }

export async function googleActivityStep(call: Call, { project, backends, settings, days, now }: {
  project: string; backends: GoogleBackend[]; settings: { idleCpuPercent?: number | 'off'; idleNetworkBytes?: number | 'off'; idleMetric?: GoogleMetric | 'off' }; days: number; now: number;
}): Promise<{ from: string; to: string; points: Record<string, [number, number][]>; signals: PlannedSignal[] }> {
  if (!Array.isArray(backends) || !Number.isInteger(days) || days < 1 || days > 14) throw new Error('the activity of a Google Cloud workload needs its backends and days (1 to 14)');
  // A group's VMs: the status names none (the router reads them at each check); read as its listManagedInstances gives them.
  const known = await Promise.all(backends.map(async (b) => {
    if (b.kind !== 'asg' || !b.location) return b;
    const scope = /-[a-z]$/.test(b.location) ? 'zones' : 'regions';
    const answer = await call<{ managedInstances?: { instance?: string }[] }>('POST', `${COMPUTE}/projects/${project}/${scope}/${b.location}/instanceGroupManagers/${b.id}/listManagedInstances`);
    return { ...b, vms: (answer.managedInstances ?? []).flatMap((m) => (m.instance ? [nameOf(m.instance)] : [])) };
  }));
  const plan = googleActivityPlan(known, settings, project);
  const to = Math.floor((now - METRIC_LAG_MS) / PERIOD_MS) * PERIOD_MS;
  const from = to - days * DAY_MS;
  const merged = new Map<string, Map<number, number>>();
  await Promise.all(plan.specs.map(async (spec) => {
    let token: string | undefined;
    do {
      const query = new URLSearchParams({
        filter: spec.filter,
        'interval.startTime': new Date(from).toISOString(),
        'interval.endTime': new Date(to).toISOString(),
        'aggregation.alignmentPeriod': `${PERIOD_MS / 1000}s`,
        'aggregation.perSeriesAligner': spec.aligner,
        ...(token ? { pageToken: token } : {}),
      });
      const page = await call<{ timeSeries?: Series[]; nextPageToken?: string }>('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
      for (const series of page.timeSeries ?? []) {
        const label = spec.label === 'instance_name' ? series.metric?.labels?.instance_name ?? '' : spec.label;
        const key = `${spec.id}:${label}`;
        const at = merged.get(key) ?? new Map<number, number>();
        for (const point of series.points ?? []) {
          // An aligned point is its period's: its interval's end minus the period (the router's reading).
          const t = Date.parse(point.interval?.endTime ?? '') - PERIOD_MS;
          const v = Number(point.value?.doubleValue ?? point.value?.int64Value);
          if (!Number.isFinite(t) || !Number.isFinite(v) || t < from || t >= to) continue;
          const was = at.get(t);
          at.set(t, was === undefined ? v : spec.merge === 'sum' ? was + v : Math.max(was, v));
        }
        merged.set(key, at);
      }
      token = page.nextPageToken || undefined;
    } while (token);
  }));
  const points = Object.fromEntries([...merged].map(([key, at]) => [key, [...at].sort((a, b) => a[0] - b[0]).map(([t, v]) => [Math.round((t - from) / 60_000), v] as [number, number])]));
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), points, signals: plan.signals };
}
