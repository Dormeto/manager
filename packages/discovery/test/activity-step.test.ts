// A standalone workload's signals over its last days, read by the discovery function under DmtDiscoveryRole (the Activity
// card's history, vision standalone workloads design §6): the queries asked, 5-minute points, every page, an unreadable
// metric an error, never silence.
import { describe, expect, it } from 'vitest';
import { activityPoints } from '../src/activity-step.js';
import { routeOf } from '../src/route.js';

const NOW = Date.UTC(2026, 10, 21, 12, 7);
const QUERIES = [
  { id: 'cpu_0', namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: [{ Name: 'InstanceId', Value: 'i-1' }], stat: 'Maximum' },
  { id: 'metric', namespace: 'CI/Agents', name: 'QueuedJobs', dimensions: [{ Name: 'Agent', Value: 'i-1' }], stat: 'Maximum' },
];

describe('the activity step', () => {
  it('is a step of the discovery function', () => {
    expect(routeOf({ step: 'activity' })).toBe('activity');
  });

  it('reads each query in 5-minute points over the days, the window 10 minutes behind, every page by its points\' minute', async () => {
    const asked: { StartTime: Date; EndTime: Date; NextToken?: string; MetricDataQueries: { Id: string; MetricStat: { Period: number; Stat: string; Metric: { Namespace: string } } }[] }[] = [];
    const end = Date.UTC(2026, 10, 21, 11, 55);
    const start = end - 7 * 86_400_000;
    const cloudwatch = {
      async getMetricData(input: (typeof asked)[number]) {
        asked.push(input);
        return input.NextToken
          ? { MetricDataResults: [{ Id: 'cpu_0', StatusCode: 'Complete', Timestamps: [new Date(start + 10 * 60_000)], Values: [3] }] }
          : { MetricDataResults: [{ Id: 'cpu_0', StatusCode: 'PartialData', Timestamps: [new Date(start)], Values: [2.5] }, { Id: 'metric', StatusCode: 'Complete', Timestamps: [new Date(start + 5 * 60_000)], Values: [0] }], NextToken: 'n' };
      },
    };
    const out = await activityPoints({ cloudwatch } as never, { queries: QUERIES, days: 7, now: NOW });
    expect(out).toEqual({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), points: { cpu_0: [[0, 2.5], [10, 3]], metric: [[5, 0]] } });
    expect(asked[0]!.MetricDataQueries.map((q) => [q.Id, q.MetricStat.Period, q.MetricStat.Stat, q.MetricStat.Metric.Namespace])).toEqual([['cpu_0', 300, 'Maximum', 'AWS/EC2'], ['metric', 300, 'Maximum', 'CI/Agents']]);
    expect([asked[0]!.StartTime.getTime(), asked[0]!.EndTime.getTime(), asked[1]!.NextToken]).toEqual([start, end, 'n']);
  });

  it('fails on a metric CloudWatch could not read, and on queries that are not a list', async () => {
    const cloudwatch = { async getMetricData() { return { MetricDataResults: [{ Id: 'cpu_0', StatusCode: 'Forbidden', Messages: [{ Code: 'Forbidden', Value: 'not authorized' }] }] }; } };
    await expect(activityPoints({ cloudwatch } as never, { queries: QUERIES, days: 7, now: NOW })).rejects.toThrow('CloudWatch could not read the metrics (Forbidden: not authorized)');
    await expect(activityPoints({ cloudwatch } as never, { queries: 'x' as never, days: 7, now: NOW })).rejects.toThrow('the activity of a workload needs its queries');
  });
});
