// The activity step of the discovery function (vision standalone workloads design §6): a standalone workload's idle signals
// over its last days, read under DmtDiscoveryRole (the role member accounts trust to read CloudWatch) for the API's Activity
// history. The queries are the router's (the API builds them from the workload's status: @dormeto/fleet activityPlan);
// 5-minute points, the window ending 10 minutes behind at a 5-minute boundary, as the router reads them.
import type { ScanPorts } from './scan.js';

const PERIOD_MS = 300_000;
const METRIC_LAG_MS = 600_000;
const DAY_MS = 86_400_000;
const MAX_DAYS = 14;

export interface ActivityQueryIn { id: string; namespace: string; name: string; dimensions: { Name: string; Value: string }[]; stat: string }

export async function activityPoints(ports: { cloudwatch: NonNullable<ScanPorts['cloudwatch']> }, { queries, days, now }: { queries: ActivityQueryIn[]; days: number; now: number }) {
  if (!Array.isArray(queries) || !queries.length || queries.length > 30 || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error('the activity of a workload needs its queries (1 to 30) and days (1 to 14)');
  const to = Math.floor((now - METRIC_LAG_MS) / PERIOD_MS) * PERIOD_MS;
  const from = to - days * DAY_MS;
  const points: Record<string, [number, number][]> = Object.fromEntries(queries.map((q) => [q.id, []]));
  let token: string | undefined;
  do {
    const page = await ports.cloudwatch.getMetricData({
      StartTime: new Date(from), EndTime: new Date(to), ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}),
      MetricDataQueries: queries.map((q) => ({ Id: q.id, ReturnData: true, MetricStat: { Metric: { Namespace: q.namespace, MetricName: q.name, Dimensions: q.dimensions }, Period: PERIOD_MS / 1000, Stat: q.stat } })),
    });
    for (const result of page.MetricDataResults ?? []) {
      // A metric CloudWatch could not read has no values: an error, never an idle week.
      if (result.StatusCode && result.StatusCode !== 'Complete' && result.StatusCode !== 'PartialData') {
        const why = result.Messages?.map((m) => m.Value ?? m.Code).filter(Boolean).join('; ');
        throw new Error(`CloudWatch could not read the metrics (${result.StatusCode}${why ? `: ${why}` : ''})`);
      }
      const list = points[result.Id ?? ''];
      if (!list) continue;
      (result.Timestamps ?? []).forEach((timestamp, i) => {
        const v = result.Values?.[i];
        const minute = Math.round((new Date(timestamp).getTime() - from) / 60_000);
        if (typeof v === 'number' && Number.isFinite(v) && minute >= 0 && minute < days * 1440) list.push([minute, v]);
      });
    }
    token = page.NextToken;
  } while (token);
  for (const list of Object.values(points)) list.sort((a, b) => a[0] - b[0]);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), points };
}

// The step's event: { step: 'activity', account, region, queries, days }.
export async function activityStep(aws: (account: string, region: string) => Promise<{ cloudwatch: NonNullable<ScanPorts['cloudwatch']> }>, event: Record<string, unknown>, now: number) {
  const { account, region, queries, days } = event;
  if (typeof account !== 'string' || typeof region !== 'string') throw new Error('the activity of a workload needs its account and region');
  return activityPoints(await aws(account, region), { queries: queries as ActivityQueryIn[], days: days as number, now });
}
