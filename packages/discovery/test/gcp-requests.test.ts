// A Google Cloud workload's requests per minute from Cloud Monitoring (Google Cloud manager design §9.4).
import { describe, expect, it } from 'vitest';
import { GoogleError } from '@dormeto/google';
import { googleRequestMinutes, googleRequestsStep } from '../src/gcp-requests.js';

const NOW = Date.parse('2026-11-10T12:00:30.000Z');
const TO = Date.parse('2026-11-10T12:00:00.000Z');
const DAY = 86_400_000;
const FROM = TO - 14 * DAY;
const P = 'dormeto-dev';
const base = {
  project: P, region: 'europe-west2', backendService: `projects/${P}/global/backendServices/dmt-demo-mig-app`,
  wakerBackendService: `projects/${P}/regions/europe-west2/backendServices/dmtr-europe-west2-waker`,
  urlMap: `projects/${P}/global/urlMaps/dmt-demo-mig-lb`, lb: { kind: 'global' as const }, days: 14, now: NOW,
};
// A point of the minute `n` from the window's start: Monitoring dates it by its interval's end.
const point = (n: number, value: string | number, key = 'int64Value') => ({ interval: { startTime: new Date(FROM + n * 60_000).toISOString(), endTime: new Date(FROM + (n + 1) * 60_000).toISOString() }, value: { [key]: value } });
function fake(pages: unknown[]) {
  const urls: URL[] = [];
  return { urls, port: { call: async <T,>(_m: string, url: string) => { urls.push(new URL(url)); return (pages[urls.length - 1] ?? {}) as T; } } };
}

describe('a Google Cloud workload\'s requests per minute', () => {
  it('asks for the URL map\'s two services per minute, summed, over the 14 days to the current minute', async () => {
    const f = fake([{ timeSeries: [{ points: [point(5, '3'), point(7, '2')] }] }]);
    const out = await googleRequestMinutes(f.port, base);
    const q = f.urls[0]!.searchParams;
    expect(f.urls[0]!.pathname).toBe(`/v3/projects/${P}/timeSeries`);
    expect(q.get('filter')).toBe('metric.type = "loadbalancing.googleapis.com/https/request_count" AND resource.labels.url_map_name = "dmt-demo-mig-lb" AND resource.labels.backend_target_name = one_of("dmt-demo-mig-app", "dmtr-europe-west2-waker")');
    expect([q.get('interval.startTime'), q.get('interval.endTime')]).toEqual([new Date(FROM).toISOString(), new Date(TO).toISOString()]);
    expect([q.get('aggregation.alignmentPeriod'), q.get('aggregation.perSeriesAligner'), q.get('aggregation.crossSeriesReducer')]).toEqual(['60s', 'ALIGN_SUM', 'REDUCE_SUM']);
    expect(out).toEqual({ from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), minutes: [[5, 3], [7, 2]], wakerTargetGroupArn: null, wakerBackendService: base.wakerBackendService });
  });

  it('a regional load balancer\'s metric and region', async () => {
    const f = fake([{}]);
    await googleRequestMinutes(f.port, { ...base, lb: { kind: 'regional', region: 'europe-west2' } });
    expect(f.urls[0]!.searchParams.get('filter')).toBe('metric.type = "loadbalancing.googleapis.com/https/external/regional/request_count" AND resource.labels.url_map_name = "dmt-demo-mig-lb" AND resource.labels.backend_target_name = one_of("dmt-demo-mig-app", "dmtr-europe-west2-waker") AND resource.labels.region = "europe-west2"');
  });

  it('adds the two services\' points of one minute, reads every page, drops points outside the window and takes double values', async () => {
    const f = fake([
      { timeSeries: [{ points: [point(5, '3'), point(-1, '9')] }], nextPageToken: 'next' },
      { timeSeries: [{ points: [point(5, '4'), point(9, 1.5, 'doubleValue'), point(14 * 1440, '8'), point(6, '0')] }] },
    ]);
    const out = await googleRequestMinutes(f.port, base);
    expect(f.urls[1]!.searchParams.get('pageToken')).toBe('next');
    expect(out.minutes).toEqual([[5, 7], [9, 1.5]]);
  });

  it('Monitoring refused: an error naming monitoring.timeSeries.list and why', async () => {
    const port = { call: async () => { throw new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'Permission monitoring.timeSeries.list denied on project' }); } };
    await expect(googleRequestMinutes(port as never, base)).rejects.toThrow('monitoring.timeSeries.list');
    await expect(googleRequestMinutes(port as never, base)).rejects.toThrow('denied on project');
  });
});

describe('the requests step\'s Google form', () => {
  const event = { step: 'requests', account: P, region: 'europe-west2', backendService: base.backendService, wakerBackendService: base.wakerBackendService, urlMap: base.urlMap, lb: base.lb, days: 14 };
  it('is answered from the paths', async () => {
    const f = fake([{ timeSeries: [{ points: [point(1, '2')] }] }]);
    const out = await googleRequestsStep(f.port, event, NOW);
    expect(out.minutes).toEqual([[1, 2]]);
    expect(f.urls[0]!.searchParams.get('filter')).toContain('url_map_name = "dmt-demo-mig-lb"');
  });
  it('a bad path, project, load balancer or days is refused, nothing read', async () => {
    const f = fake([]);
    for (const bad of [{ backendService: 'dmt-demo-mig-app' }, { urlMap: base.backendService }, { backendService: 'projects/other-project/global/backendServices/x' }, { account: 'x' }, { lb: { kind: 'nope' } }, { lb: undefined }, { days: 0 }, { days: 32 }, { days: '14' }]) {
      await expect(googleRequestsStep(f.port, { ...event, ...bad }, NOW)).rejects.toThrow('the requests of a Google Cloud workload need');
    }
    expect(f.urls).toEqual([]);
  });
});
