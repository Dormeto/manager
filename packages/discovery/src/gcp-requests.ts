// A Google Cloud workload's requests per minute for the idle window advisor (Google Cloud manager design §9.4), as AWS's
// requestMinutes reads them from CloudWatch (requests.ts): Cloud Monitoring's load balancer request count of the
// workload's application backend service and of its waker's, under its URL map (the waker's service is the router's,
// shared by its workloads: the URL map keeps another workload's requests out, as AWS's LoadBalancer dimension does),
// per minute over the last days, read as the discovery account. Whole minutes to the current one; a minute with no request
// is absent. The counts are Monitoring's, hence estimated (§12).
import { googlePath, isProject, isRegion } from '@dormeto/fleet/clouds';
import type { GooglePort } from './google.js';
import { METRICS } from './gcp-idle.js';
import type { RequestMinutesAnswer } from './requests.js';

const MONITORING = 'https://monitoring.googleapis.com/v3';
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const last = (path: string) => path.split('/').at(-1) ?? path;

export interface GoogleRequestsInput {
  project: string; region: string; backendService: string; wakerBackendService: string; urlMap: string;
  lb: { kind: keyof typeof METRICS; region?: string }; days: number; now: number;
}
export type GoogleRequestMinutesAnswer = Omit<RequestMinutesAnswer, 'wakerTargetGroupArn'> & { wakerTargetGroupArn: null; wakerBackendService: string };
interface Series { points?: { interval?: { endTime?: string }; value?: { int64Value?: string | number; doubleValue?: number } }[] }
interface Page { timeSeries?: Series[]; nextPageToken?: string }

export async function googleRequestMinutes(port: Pick<GooglePort, 'call'>, { project, backendService, wakerBackendService, urlMap, lb, days, now }: GoogleRequestsInput): Promise<GoogleRequestMinutesAnswer> {
  const { metric, inRegion } = METRICS[lb.kind];
  const to = Math.floor(now / MIN_MS) * MIN_MS;
  const from = to - days * DAY_MS;
  const services = [...new Set([last(backendService), last(wakerBackendService)])].map((s) => `"${s}"`).join(', ');
  const filter = [
    `metric.type = "${metric}"`, `resource.labels.url_map_name = "${last(urlMap)}"`, `resource.labels.backend_target_name = one_of(${services})`,
    ...(inRegion && lb.region ? [`resource.labels.region = "${lb.region}"`] : []),
  ].join(' AND ');
  const counts = new Map<number, number>();
  let token: string | undefined;
  try {
    do {
      const query = new URLSearchParams({
        filter, 'interval.startTime': new Date(from).toISOString(), 'interval.endTime': new Date(to).toISOString(),
        'aggregation.alignmentPeriod': '60s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM',
        ...(token ? { pageToken: token } : {}),
      });
      const page = await port.call<Page>('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
      for (const series of page.timeSeries ?? []) {
        for (const point of series.points ?? []) {
          // A point is dated by its interval's end: its minute starts a minute before.
          const end = point.interval?.endTime ? Date.parse(point.interval.endTime) : Number.NaN;
          const value = Number(point.value?.int64Value ?? point.value?.doubleValue ?? 0);
          const minute = Math.round((end - MIN_MS - from) / MIN_MS);
          if (value > 0 && minute >= 0 && minute < days * 1440) counts.set(minute, (counts.get(minute) ?? 0) + value);
        }
      }
      token = page.nextPageToken || undefined;
    } while (token);
  } catch (err) {
    throw new Error(`Cloud Monitoring could not read the requests (monitoring.timeSeries.list): ${String((err as Error)?.message ?? err).slice(0, 300)}`);
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes: [...counts].sort((a, b) => a[0] - b[0]), wakerTargetGroupArn: null, wakerBackendService };
}

// The step's Google form, checked: a project, Google Cloud paths of that project, a known load balancer kind, days 1 to 31.
export async function googleRequestsStep(port: Pick<GooglePort, 'call'>, event: Record<string, unknown>, now: number): Promise<GoogleRequestMinutesAnswer> {
  const { account, region, backendService, wakerBackendService, urlMap, lb, days } = event;
  const paths = [googlePath(backendService), googlePath(wakerBackendService), googlePath(urlMap)];
  const kinds = ['backendServices', 'backendServices', 'urlMaps'];
  const l = lb as { kind?: unknown; region?: unknown } | null | undefined;
  const lbOk = typeof l === 'object' && l !== null && typeof l.kind === 'string' && Object.hasOwn(METRICS, l.kind) && (l.region === undefined || isRegion('gcp', l.region));
  if (!isProject(account) || typeof region !== 'string' || !lbOk || paths.some((p, i) => !p || p.kind !== kinds[i] || p.project !== account)
    || typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 31) {
    throw new Error('the requests of a Google Cloud workload need a project, its backend service, waker backend service and URL map paths, its load balancer and days from 1 to 31');
  }
  return googleRequestMinutes(port, { project: account, region, backendService: backendService as string, wakerBackendService: wakerBackendService as string, urlMap: urlMap as string, lb: l as GoogleRequestsInput['lb'], days, now });
}
