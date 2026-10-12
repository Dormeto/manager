// The idle window advisor's requests (R10): a workload's requests per minute over the last days, its application and
// waker target groups added up, read under DmtDiscoveryRole for the API.
import { describe, expect, it } from 'vitest';
import { requestMinutes } from '../src/requests.js';
import { routeOf } from '../src/route.js';
import type { Rule } from '../src/scan.js';

const APP = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/dmt-dev-demo-app/cdccfbae00eb59a6';
const WAKER = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/dmtr-dev-demo/0123456789abcdef';
const OTHER = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/other/fedcba9876543210';
const LB = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:loadbalancer/app/dmt-dev-demo/a336209fd67a8375';
const L1 = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:listener/app/dmt-dev-demo/a336209fd67a8375/82d8ed749a1b2c3d';
const L2 = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:listener/app/dmt-dev-demo/a336209fd67a8375/6e2b58c3b4d5e6f7';
const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const TO = Date.parse('2026-10-10T12:00:00.000Z');
const FROM = TO - 14 * 86_400_000;
const minute = (m: number) => new Date(FROM + m * 60_000);

const weighted = (arn: string, groups: [string, number][]): Rule => ({
  RuleArn: arn, Priority: '10', Actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([TargetGroupArn, Weight]) => ({ TargetGroupArn, Weight })) } }],
});
const plain = (arn: string, tg: string, IsDefault = false): Rule => ({ RuleArn: arn, Priority: IsDefault ? 'default' : '20', IsDefault, Actions: [{ Type: 'forward', Order: 1, TargetGroupArn: tg }] });
type Page = { MetricDataResults?: { Id?: string; Timestamps?: Date[]; Values?: number[]; StatusCode?: string }[]; NextToken?: string };

function ports({ loadBalancers = [LB], rules = { [L1]: [[weighted('r1', [[APP, 1], [WAKER, 0]])]] } as Record<string, Rule[][]>, pages = [{}] as Page[] } = {}) {
  const metrics: Record<string, unknown>[] = [];
  return {
    metrics,
    elbv2: {
      describeTargetGroups: async (input: { TargetGroupArns?: string[] }) => ({ TargetGroups: (input.TargetGroupArns ?? []).map((TargetGroupArn) => ({ TargetGroupArn, LoadBalancerArns: loadBalancers })) }),
      describeListeners: async ({ LoadBalancerArn }: { LoadBalancerArn: string }) => ({ Listeners: LoadBalancerArn === LB ? Object.keys(rules).map((ListenerArn, i) => ({ ListenerArn, Port: 443 + i, Protocol: 'HTTPS' })) : [] }),
      // Each listener's rules in pages (Marker: the page's index).
      describeRules: async ({ ListenerArn, Marker }: { ListenerArn: string; Marker?: string }) => {
        const listed = rules[ListenerArn] ?? [[]];
        const page = Number(Marker ?? 0);
        return { Rules: listed[page] ?? [], ...(page + 1 < listed.length ? { NextMarker: String(page + 1) } : {}) };
      },
    },
    cloudwatch: {
      getMetricData: async (input: Record<string, unknown>) => { metrics.push(input); return pages[Number((input.NextToken as string | undefined) ?? 0)] ?? {}; },
    },
  };
}

describe('a workload\'s requests per minute', () => {
  it('the application and waker target groups added up by minute, every page, from the timestamps', async () => {
    const p = ports({
      rules: { [L1]: [[plain('default', OTHER, true)], [weighted('r1', [[APP, 1], [WAKER, 0]]), weighted('shadow', [[APP, 1], [WAKER, 0]])]] },
      pages: [
        // Newest first, as GetMetricData answers by default; a zero is no request.
        { MetricDataResults: [{ Id: 'tg0', Timestamps: [minute(10), minute(5)], Values: [3, 0], StatusCode: 'PartialData' }, { Id: 'tg1', Timestamps: [minute(5)], Values: [2], StatusCode: 'PartialData' }], NextToken: '1' },
        { MetricDataResults: [{ Id: 'tg0', Timestamps: [minute(1)], Values: [1], StatusCode: 'Complete' }, { Id: 'tg1', Timestamps: [minute(10)], Values: [4], StatusCode: 'Complete' }] },
      ],
    });
    const out = await requestMinutes(p, { targetGroupArn: APP, days: 14, now: NOW });
    expect(out).toEqual({ from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), minutes: [[1, 1], [5, 2], [10, 7]], wakerTargetGroupArn: WAKER });
    expect(p.metrics).toHaveLength(2);
    expect(p.metrics[1]!.NextToken).toBe('1');
    expect(p.metrics[0]).toMatchObject({
      StartTime: new Date(FROM), EndTime: new Date(TO),
      MetricDataQueries: [
        { Id: 'tg0', ReturnData: true, MetricStat: { Period: 60, Stat: 'Sum', Metric: { Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount', Dimensions: [{ Name: 'LoadBalancer', Value: 'app/dmt-dev-demo/a336209fd67a8375' }, { Name: 'TargetGroup', Value: 'targetgroup/dmt-dev-demo-app/cdccfbae00eb59a6' }] } } },
        { Id: 'tg1', MetricStat: { Metric: { Dimensions: [{ Name: 'LoadBalancer', Value: 'app/dmt-dev-demo/a336209fd67a8375' }, { Name: 'TargetGroup', Value: 'targetgroup/dmtr-dev-demo/0123456789abcdef' }] } } },
      ],
    });
  });

  it('finds the waker on another listener', async () => {
    const p = ports({ rules: { [L1]: [[plain('r0', OTHER)]], [L2]: [[weighted('r2', [[APP, 0], [WAKER, 1]])]] } });
    expect((await requestMinutes(p, { targetGroupArn: APP, days: 14, now: NOW })).wakerTargetGroupArn).toBe(WAKER);
  });

  it('without a rule forwarding to both, the application target group alone', async () => {
    const p = ports({ rules: { [L1]: [[plain('r1', APP), plain('default', OTHER, true)]] }, pages: [{ MetricDataResults: [{ Id: 'tg0', Timestamps: [minute(3)], Values: [2] }] }] });
    const out = await requestMinutes(p, { targetGroupArn: APP, days: 14, now: NOW });
    expect(out).toMatchObject({ minutes: [[3, 2]], wakerTargetGroupArn: null });
    expect((p.metrics[0]!.MetricDataQueries as unknown[])).toHaveLength(1);
  });

  it('a target group on no load balancer cannot be read', async () => {
    await expect(requestMinutes(ports({ loadBalancers: [] }), { targetGroupArn: APP, days: 14, now: NOW })).rejects.toThrow('the target group is not attached to a load balancer');
  });
});

describe('the discovery function\'s steps', () => {
  it('routes the requests step to itself, never to a discovery run', () => {
    expect(routeOf({ step: 'requests', account: '121014831971', region: 'eu-west-1', targetGroupArn: APP, days: 14 })).toBe('requests');
    expect([routeOf({ step: 'plan' }), routeOf({ step: 'account' }), routeOf({ step: 'finalize' }), routeOf({ step: 'abandon' })]).toEqual(['plan', 'account', 'finalize', 'abandon']);
    expect(routeOf({ Records: [] })).toBe('refresh');
    // The schedule and the dashboard's run on demand: a whole run.
    expect([routeOf({}), routeOf({ source: 'manual', by: 'ops@example.com' })]).toEqual(['run', 'run']);
  });

  it('an unknown step is refused rather than run as a discovery', () => {
    expect(() => routeOf({ step: 'request' })).toThrow('unknown step: request');
  });
});
