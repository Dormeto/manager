// A region with one application load balancer and the router discovery cases (ported from the router tests).
import { expect } from 'vitest';
import type { ScanPorts } from '../src/scan.js';

export const P = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333';
export const LB = `${P}:loadbalancer/app/web/abc`;
const L443 = `${P}:listener/app/web/abc/l443`;
const L80 = `${P}:listener/app/web/abc/l80`;
type Group = { TargetGroupArn: string; TargetGroupName: string; TargetType: string };
const tg = (name: string, type = 'instance'): Group => ({ TargetGroupArn: `${P}:targetgroup/${name}/1`, TargetGroupName: name, TargetType: type });
export const TGS: Record<string, Group> = {
  shop: tg('shop'), api: tg('api', 'ip'), batch: tg('batch'), fn: tg('fn', 'lambda'), shared: tg('shared'), orphan: tg('orphan', 'ip'),
  empty: tg('empty'), demo: tg('demo-app'), waker: tg('dmt-dev-demo', 'lambda'), green: tg('green'), blue: tg('blue'),
};
const forward = (...groups: [string, number][]) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([g, w]) => ({ TargetGroupArn: TGS[g]!.TargetGroupArn, Weight: w })) } }];
const host = (...h: string[]) => [{ Field: 'host-header', HostHeaderConfig: { Values: h } }];
export const RULES: Record<string, Record<string, unknown>[]> = {
  [L80]: [{ RuleArn: 'r80', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'redirect', Order: 1 }] }],
  [L443]: [
    { RuleArn: 'r-demo', Priority: '10', Conditions: host('dev.example.com'), Actions: forward(['demo', 1], ['waker', 0]) },
    { RuleArn: 'r-admin', Priority: '5', Conditions: host('dev.example.com'), Actions: forward(['waker', 1]) },
    { RuleArn: 'r-shop', Priority: '20', Conditions: host('shop.example.com', 'www.shop.example.com'), Actions: [{ Type: 'forward', Order: 1, TargetGroupArn: TGS.shop!.TargetGroupArn }] },
    { RuleArn: 'r-api', Priority: '30', Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }], Actions: forward(['api', 1]) },
    { RuleArn: 'r-batch', Priority: '40', Conditions: [{ Field: 'host-header', Values: ['batch.example.com'] }], Actions: forward(['batch', 1]) },
    { RuleArn: 'r-canary', Priority: '50', Conditions: host('canary.example.com'), Actions: forward(['shop', 0], ['green', 1], ['blue', 1]) },
    { RuleArn: 'r-fn', Priority: '60', Conditions: host('fn.example.com'), Actions: forward(['fn', 1]) },
    { RuleArn: 'r-shared-1', Priority: '70', Conditions: host('a.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-shared-2', Priority: '71', Conditions: host('b.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-orphan', Priority: '80', Conditions: host('orphan.example.com'), Actions: forward(['orphan', 1]) },
    { RuleArn: 'r-empty', Priority: '90', Conditions: host('empty.example.com'), Actions: forward(['empty', 1]) },
    { RuleArn: 'r-fixed', Priority: '95', Conditions: host('down.example.com'), Actions: [{ Type: 'fixed-response', Order: 1 }] },
    { RuleArn: 'r-default', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response', Order: 1 }] },
  ],
};
export const TAGS: Record<string, Record<string, string>> = {
  'r-demo': { 'dormeto:workload': 'demo' },
  'r-admin': { 'dormeto:workload': 'demo', 'dormeto:role': 'admin' },
  [LB]: { env: 'dev', team: 'web' },
  [TGS.shop!.TargetGroupArn]: { team: 'shop' },
  'r-shop': { env: 'preview' },
};
const TARGETS: Record<string, string[]> = {
  shop: ['i-shop'], api: ['10.0.1.5'], batch: [], shared: ['i-s'], orphan: ['10.0.9.9'], empty: [], demo: ['i-demo'], green: ['i-g'], blue: ['i-b'],
};

export function scanPorts({ hourly = {} as Record<string, number[]> } = {}) {
  const calls = { metricQueries: 0, tagBatches: [] as number[] };
  const page = <T>(items: T[], key: string, input: { Marker?: string } | undefined, size = 5) => {
    const start = Number(input?.Marker ?? 0);
    const next = start + size < items.length ? String(start + size) : undefined;
    return { [key]: items.slice(start, start + size), NextMarker: next };
  };
  const ports: ScanPorts = {
    elbv2: {
      async describeLoadBalancers(input) {
        return page([{ LoadBalancerArn: LB, LoadBalancerName: 'web', Type: 'application' }, { LoadBalancerArn: `${P}:loadbalancer/net/nlb/x`, LoadBalancerName: 'nlb', Type: 'network' }], 'LoadBalancers', input);
      },
      async describeListeners({ LoadBalancerArn }) {
        return { Listeners: LoadBalancerArn === LB ? [{ ListenerArn: L80, Port: 80, Protocol: 'HTTP' }, { ListenerArn: L443, Port: 443, Protocol: 'HTTPS' }] : [] };
      },
      async describeRules(input) { return page(RULES[input.ListenerArn]!, 'Rules', input); },
      async describeTags({ ResourceArns }) {
        expect(ResourceArns.length).toBeLessThanOrEqual(20);
        calls.tagBatches.push(ResourceArns.length);
        return { TagDescriptions: ResourceArns.map((a) => ({ ResourceArn: a, Tags: Object.entries(TAGS[a] ?? {}).map(([Key, Value]) => ({ Key, Value })) })) };
      },
      async describeTargetGroups(input) { return page(Object.values(TGS), 'TargetGroups', input); },
      async describeTargetHealth({ TargetGroupArn }) {
        const name = Object.keys(TGS).find((k) => TGS[k]!.TargetGroupArn === TargetGroupArn)!;
        return { TargetHealthDescriptions: (TARGETS[name] ?? []).map((Id) => ({ Target: { Id }, TargetHealth: { State: 'healthy' } })) };
      },
    },
    autoscaling: {
      async describeAutoScalingGroups() {
        return { AutoScalingGroups: [{ AutoScalingGroupName: 'batch-asg', TargetGroupARNs: [TGS.batch!.TargetGroupArn] }] };
      },
    },
    ecs: {
      async listClusters() { return { clusterArns: ['arn:aws:ecs:eu-west-1:111122223333:cluster/main'] }; },
      async listServices() { return { serviceArns: ['arn:aws:ecs:eu-west-1:111122223333:service/main/api'] }; },
      async describeServices({ services }) {
        return { services: services.map((s) => ({ serviceArn: s, loadBalancers: [{ targetGroupArn: TGS.api!.TargetGroupArn }] })) };
      },
    },
    cloudwatch: {
      async getMetricData({ MetricDataQueries, StartTime, EndTime }) {
        calls.metricQueries += MetricDataQueries.length;
        expect((EndTime.getTime() - StartTime.getTime()) / 3_600_000).toBe(168);
        return {
          MetricDataResults: MetricDataQueries.map((q) => {
            const dim = q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'TargetGroup')!.Value;
            return { Id: q.Id, Values: hourly[dim] ?? [] };
          }),
        };
      },
    },
  };
  return { ports, calls };
}
