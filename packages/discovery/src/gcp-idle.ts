// A Google Cloud project's idle share (Google Cloud manager design §7.3), as AWS's candidates get theirs from CloudWatch
// (scan.ts idleHours): Cloud Monitoring's load balancer request counts over the 168 hours ending at the current hour,
// summed by hour per backend service and URL map. One query per metric type of the kinds present, every page; the metric
// types and the regional ones' region follow the router's own reads (router gcp/src/monitoring.mjs:16-19). A query that
// fails (Monitoring turned off, a refusal, a timeout) gives nulls to the candidates of its metric type and is logged once;
// it never fails the scan.
import type { GooglePort } from './google.js';
import type { ScannedRule } from './types.js';

type LbKind = NonNullable<ScannedRule['lb']>['kind'];
type Call = GooglePort['call'];

const MONITORING = 'https://monitoring.googleapis.com/v3';
const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 168;
// By kind: the metric, and whether the region names the service too (monitoring.mjs METRICS).
const METRICS: Record<LbKind, { metric: string; inRegion: boolean }> = {
  global: { metric: 'loadbalancing.googleapis.com/https/request_count', inRegion: false },
  classic: { metric: 'loadbalancing.googleapis.com/https/request_count', inRegion: false },
  regional: { metric: 'loadbalancing.googleapis.com/https/external/regional/request_count', inRegion: true },
  internal: { metric: 'loadbalancing.googleapis.com/https/internal/request_count', inRegion: true },
  'cross-region-internal': { metric: 'loadbalancing.googleapis.com/https/internal/request_count', inRegion: false },
};

export interface IdleShare { idleHours7d: number | null; requests7d: number | null }
export interface IdleCandidate { id: string; backendService: string; urlMap: string; region: string; kind?: LbKind }
interface Series { resource?: { labels?: Record<string, string> }; points?: { interval?: { startTime?: string }; value?: { int64Value?: string | number; doubleValue?: number } }[] }
interface Answer { timeSeries?: Series[]; nextPageToken?: string }

const NONE: IdleShare = { idleHours7d: null, requests7d: null };
const keyOf = (backend: string, urlMap: string, region: string) => `${backend}\n${urlMap}\n${region}`;

// `candidates`: those not ineligible. A candidate with no load balancer kind reads nothing.
export async function idleOfProject(
  port: { call: Call },
  { project, candidates, now, log }: { project: string; candidates: IdleCandidate[]; now: () => number; log?: { warn(event: string, data?: object): void } },
): Promise<Map<string, IdleShare>> {
  const out = new Map<string, IdleShare>(candidates.map((c) => [c.id, NONE]));
  const end = Math.floor(now() / HOUR_MS) * HOUR_MS;
  const start = end - WINDOW_HOURS * HOUR_MS;
  const byMetric = new Map<string, { inRegion: boolean; members: IdleCandidate[] }>();
  for (const c of candidates) {
    if (!c.kind) continue;
    const { metric, inRegion } = METRICS[c.kind];
    const entry = byMetric.get(`${metric}|${inRegion}`) ?? { inRegion, members: [] };
    entry.members.push(c);
    byMetric.set(`${metric}|${inRegion}`, entry);
  }
  await Promise.all([...byMetric].map(async ([id, { inRegion, members }]) => {
    const metric = id.slice(0, id.indexOf('|'));
    try {
      // The requests of each (backend service, URL map, region) per hour start.
      const hours = new Map<string, Map<string, number>>();
      let token: string | undefined;
      do {
        const query = new URLSearchParams({
          filter: `metric.type = "${metric}"`,
          'interval.startTime': new Date(start).toISOString(),
          'interval.endTime': new Date(end).toISOString(),
          'aggregation.alignmentPeriod': '3600s',
          'aggregation.perSeriesAligner': 'ALIGN_SUM',
          'aggregation.crossSeriesReducer': 'REDUCE_SUM',
          ...(token ? { pageToken: token } : {}),
        });
        for (const field of ['backend_target_name', 'url_map_name', ...(inRegion ? ['region'] : [])]) query.append('aggregation.groupByFields', `resource.label.${field}`);
        const page = await port.call<Answer>('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
        for (const series of page.timeSeries ?? []) {
          const labels = series.resource?.labels ?? {};
          const key = keyOf(labels.backend_target_name ?? '', labels.url_map_name ?? '', inRegion ? labels.region ?? '' : '');
          const perHour = hours.get(key) ?? new Map<string, number>();
          for (const point of series.points ?? []) {
            const at = point.interval?.startTime;
            const ms = at ? Date.parse(at) : Number.NaN;
            if (!(ms >= start && ms < end)) continue;
            perHour.set(at!, (perHour.get(at!) ?? 0) + Number(point.value?.int64Value ?? point.value?.doubleValue ?? 0));
          }
          hours.set(key, perHour);
        }
        token = page.nextPageToken || undefined;
      } while (token);
      for (const c of members) {
        const values = [...(hours.get(keyOf(c.backendService, c.urlMap, inRegion ? c.region : ''))?.values() ?? [])];
        out.set(c.id, {
          idleHours7d: WINDOW_HOURS - values.filter((v) => v > 0).length,
          requests7d: Math.round(values.reduce((sum, v) => sum + v, 0)),
        });
      }
    } catch (err) {
      log?.warn('GoogleIdleFailed', { project, metric, error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  }));
  return out;
}
