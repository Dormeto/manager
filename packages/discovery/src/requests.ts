// The idle window advisor's requests (vision docs/specs/2026-10-10-idle-window-advisor-design.md §3, R10): a workload's
// requests per minute over the last days, read under DmtDiscoveryRole (the only role member accounts trust to read them)
// for the API. Its application target group (requests while awake) and its waker target group (while asleep, found from
// the load balancer's rules that forward to both) are added up: every request counts.
import { all, lbDimension, tgDimension, type Rule, type ScanPorts } from './scan.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

export interface RequestsPorts {
  elbv2: Pick<ScanPorts['elbv2'], 'describeTargetGroups' | 'describeListeners' | 'describeRules'>;
  cloudwatch: NonNullable<ScanPorts['cloudwatch']>;
}
export interface RequestMinutesAnswer { from: string; to: string; minutes: [number, number][]; wakerTargetGroupArn: string | null }

// The other target group of a rule forwarding to the application target group and one more: Dormeto's instrumented and
// shadow rules forward to the application and the waker target groups only.
async function wakerOf(elbv2: RequestsPorts['elbv2'], loadBalancerArn: string, targetGroupArn: string): Promise<string | null> {
  const listeners = await all<{ ListenerArn?: string }>((t) => elbv2.describeListeners({ LoadBalancerArn: loadBalancerArn, ...t }), 'Listeners');
  for (const { ListenerArn } of listeners) {
    if (!ListenerArn) continue;
    const rules = await all<Rule>((t) => elbv2.describeRules({ ListenerArn, ...t }), 'Rules');
    for (const rule of rules) {
      for (const action of rule.Actions ?? []) {
        const groups = (action.ForwardConfig?.TargetGroups ?? []).map((g) => g.TargetGroupArn).filter((arn): arn is string => Boolean(arn));
        if (groups.length === 2 && groups.includes(targetGroupArn)) return groups.find((arn) => arn !== targetGroupArn)!;
      }
    }
  }
  return null;
}

export async function requestMinutes(ports: RequestsPorts, { targetGroupArn, days, now }: { targetGroupArn: string; days: number; now: number }): Promise<RequestMinutesAnswer> {
  const { TargetGroups = [] } = await ports.elbv2.describeTargetGroups({ TargetGroupArns: [targetGroupArn] });
  const loadBalancerArn = TargetGroups[0]?.LoadBalancerArns?.[0];
  if (!loadBalancerArn) throw new Error('the target group is not attached to a load balancer');
  const waker = await wakerOf(ports.elbv2, loadBalancerArn, targetGroupArn);
  // Whole minutes to the current one (not yet complete, not read).
  const to = Math.floor(now / MIN_MS) * MIN_MS;
  const from = to - days * DAY_MS;
  const groups = [targetGroupArn, ...(waker ? [waker] : [])];
  const queries = groups.map((tg, i) => ({
    Id: `tg${i}`, ReturnData: true,
    MetricStat: {
      Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount', Dimensions: [{ Name: 'LoadBalancer', Value: lbDimension(loadBalancerArn) }, { Name: 'TargetGroup', Value: tgDimension(tg) }] },
      Period: 60, Stat: 'Sum',
    },
  }));
  const counts = new Map<number, number>();
  let token: string | undefined;
  do {
    const page = await ports.cloudwatch.getMetricData({ StartTime: new Date(from), EndTime: new Date(to), MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
    // By each value's timestamp, whatever the order of the pages and their values.
    for (const result of page.MetricDataResults ?? []) {
      // A metric CloudWatch could not read (Forbidden, InternalError) has no values: an error, never silence.
      if (result.StatusCode && result.StatusCode !== 'Complete' && result.StatusCode !== 'PartialData') {
        const why = result.Messages?.map((m) => m.Value ?? m.Code).filter(Boolean).join('; ');
        throw new Error(`CloudWatch could not read the requests (${result.StatusCode}${why ? `: ${why}` : ''})`);
      }
      (result.Timestamps ?? []).forEach((timestamp, i) => {
        const value = result.Values?.[i] ?? 0;
        const minute = Math.round((new Date(timestamp).getTime() - from) / MIN_MS);
        if (value > 0 && minute >= 0 && minute < days * 1440) counts.set(minute, (counts.get(minute) ?? 0) + value);
      });
    }
    token = page.NextToken;
  } while (token);
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    minutes: [...counts].sort((a, b) => a[0] - b[0]), wakerTargetGroupArn: waker,
  };
}
