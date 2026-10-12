// Candidates by application target group: every rule forwarding to one target group forms one candidate.
import { describe, expect, it } from 'vitest';
import { scanRegion, type ScanPorts } from '../src/scan.js';
import type { ScannedRule } from '../src/types.js';

const P = 'arn:aws:elasticloadbalancing:eu-west-3:038606077307';
const lbArn = (name: string) => `${P}:loadbalancer/app/${name}/1`;
const tgArn = (name: string) => `${P}:targetgroup/${name}/1`;
type Rule = { RuleArn: string; Priority: string; IsDefault?: boolean; Conditions: unknown[]; Actions: unknown[] };
const host = (h: string) => ({ Field: 'host-header', HostHeaderConfig: { Values: [h] } });
const path = (...p: string[]) => ({ Field: 'path-pattern', PathPatternConfig: { Values: p } });
const to = (...groups: [string, number][]) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([g, w]) => ({ TargetGroupArn: tgArn(g), Weight: w })) } }];
const rule = (id: string, priority: string, conditions: unknown[], actions: unknown[], over: Partial<Rule> = {}): Rule => ({ RuleArn: `${P}:listener-rule/app/x/${id}`, Priority: priority, Conditions: conditions, Actions: actions, ...over });

// One region: listeners per load balancer, target groups (type, targets), Auto Scaling owners, tags.
function ports({ lbs = { web: { listeners: { l443: [] as Rule[] } } } as Record<string, { listeners: Record<string, Rule[]> }>,
  groups = {} as Record<string, { type?: string; targets?: string[] }>, asgs = {} as Record<string, string>, tags = {} as Record<string, Record<string, string>> }): ScanPorts {
  return {
    elbv2: {
      async describeLoadBalancers() { return { LoadBalancers: Object.keys(lbs).map((n) => ({ LoadBalancerArn: lbArn(n), LoadBalancerName: n, Type: 'application' })) }; },
      async describeListeners({ LoadBalancerArn }) {
        const name = Object.keys(lbs).find((n) => lbArn(n) === LoadBalancerArn)!;
        return { Listeners: Object.keys(lbs[name]!.listeners).map((l) => ({ ListenerArn: `${name}/${l}`, Port: 443, Protocol: 'HTTPS' })) };
      },
      async describeRules({ ListenerArn }) {
        const [name, l] = ListenerArn.split('/');
        return { Rules: lbs[name!]!.listeners[l!]! as never };
      },
      async describeTags({ ResourceArns }) { return { TagDescriptions: ResourceArns.map((a) => ({ ResourceArn: a, Tags: Object.entries(tags[a] ?? {}).map(([Key, Value]) => ({ Key, Value })) })) }; },
      async describeTargetGroups() { return { TargetGroups: Object.entries(groups).map(([n, g]) => ({ TargetGroupArn: tgArn(n), TargetGroupName: n, TargetType: g.type ?? 'instance' })) }; },
      async describeTargetHealth({ TargetGroupArn }) {
        const name = Object.keys(groups).find((n) => tgArn(n) === TargetGroupArn)!;
        return { TargetHealthDescriptions: (groups[name]?.targets ?? []).map((Id) => ({ Target: { Id } })) };
      },
    },
    autoscaling: { async describeAutoScalingGroups() { return { AutoScalingGroups: Object.entries(asgs).map(([tg, name]) => ({ AutoScalingGroupName: name, TargetGroupARNs: [tgArn(tg)] })) }; } },
  };
}

const WHERE = { account: '038606077307', region: 'eu-west-3' };
const scan = (p: ScanPorts) => scanRegion(p, WHERE, { now: () => Date.UTC(2026, 9, 4, 12) });
const byTarget = (candidates: ScannedRule[]) => Object.fromEntries(candidates.map((c) => [c.targetGroup ?? c.id, c]));

// The ligoj load balancer: five rules of one host on one target group, an HTTP redirect, a default fixed response.
const LIGOJ = [
  rule('p10', '10', [host('saas.ligoj.io'), path('/logout.html', '/main/public/*')], to(['ligoj', 1])),
  rule('p20', '20', [{ Field: 'http-header' }, host('saas.ligoj.io')], to(['ligoj', 1])),
  rule('p30', '30', [{ Field: 'query-string' }, host('saas.ligoj.io')], to(['ligoj', 1])),
  rule('p40', '40', [path('/themes/*', '/assets/*'), host('saas.ligoj.io')], to(['ligoj', 1])),
  rule('p50', '50', [host('saas.ligoj.io'), path('*')], to(['ligoj', 1])),
  rule('default', 'default', [], [{ Type: 'fixed-response', Order: 1 }], { IsDefault: true }),
];

describe('candidates by target group', () => {
  it('groups the rules of one target group into one eligible candidate', async () => {
    const candidates = await scan(ports({ lbs: { ligoj: { listeners: { l443: LIGOJ } } }, groups: { ligoj: { targets: ['i-ligoj'] } } }));
    expect(candidates).toHaveLength(2);
    const group = byTarget(candidates).ligoj!;
    expect(group.id).toBe(tgArn('ligoj'));
    expect([group.eligibility, group.backend]).toEqual(['eligible', { kind: 'instance', id: 'i-ligoj', arn: 'arn:aws:ec2:eu-west-3:038606077307:instance/i-ligoj' }]);
    expect(group.rules.map((r) => r.priority)).toEqual(['10', '20', '30', '40', '50']);
    expect(group.priority).toBe('10');
    expect(group.conditions).toBe('host saas.ligoj.io, path /logout.html | /main/public/* (+4 rules)');
    expect(group.hosts).toEqual(['saas.ligoj.io']);
    expect(group.suggestedId).toBe('ligoj');
    expect(byTarget(candidates)[LIGOJ[5]!.RuleArn]!.rules).toHaveLength(1);
  });

  it('refuses a group with a listener default rule', async () => {
    const rules = [rule('p10', '10', [host('a.example.com')], to(['app', 1])), rule('default', 'default', [], to(['app', 1]), { IsDefault: true })];
    const [group] = await scan(ports({ lbs: { web: { listeners: { l443: rules } } }, groups: { app: { targets: ['i-1'] } } }));
    expect([group!.eligibility, group!.reason]).toEqual(['ineligible', 'listener default action (not supported yet)']);
  });

  it('refuses a target group that also takes traffic in a weighted forward', async () => {
    const rules = [rule('p10', '10', [host('a.example.com')], to(['app', 1])), rule('p20', '20', [host('canary.example.com')], to(['app', 1], ['green', 1]))];
    const found = byTarget(await scan(ports({ lbs: { web: { listeners: { l443: rules } } }, groups: { app: { targets: ['i-1'] }, green: { targets: ['i-2'] } } })));
    expect([found.app!.eligibility, found.app!.reason]).toEqual(['ineligible', 'target group also in a weighted forward']);
    expect(found[rules[1]!.RuleArn]!.reason).toBe('weighted forward to several target groups');
  });

  it('refuses a target group used by rules of several load balancers, or by more than 10 rules', async () => {
    const one = (id: string) => rule(id, id.slice(1), [host(`${id}.example.com`)], to(['app', 1]));
    const two = byTarget(await scan(ports({ lbs: { web: { listeners: { l443: [one('p1')] } }, api: { listeners: { l443: [one('p2')] } } }, groups: { app: { targets: ['i-1'] } } })));
    expect(two.app!.reason).toBe('target group used by several load balancers');
    const many = Array.from({ length: 11 }, (_, i) => one(`p${i + 1}`));
    const crowded = byTarget(await scan(ports({ lbs: { web: { listeners: { l443: many } } }, groups: { app: { targets: ['i-1'] } } })));
    expect(crowded.app!.reason).toBe('more than 10 rules');
  });

  it('counts a customer rule covered by a shadow of the workload as part of it', async () => {
    const customer = rule('p20', '20', [host('a.example.com')], to(['app', 1]));
    const shadow = rule('p19', '19', [host('a.example.com')], to(['app', 1], ['dmt-dev-a', 0]));
    const [group] = await scan(ports({
      lbs: { web: { listeners: { l443: [shadow, customer] } } }, groups: { app: {}, 'dmt-dev-a': { type: 'lambda' } }, asgs: { app: 'a-asg' },
      tags: { [shadow.RuleArn]: { 'dormeto:workload': 'a', 'dormeto:shadows': customer.RuleArn } },
    }));
    expect([group!.eligibility, group!.workloadId, group!.reason]).toEqual(['managed', 'a', undefined]);
  });

  it('flags a managed group where some rules are not part of the workload', async () => {
    const rules = [rule('p10', '10', [host('a.example.com')], to(['app', 1], ['dmt-dev-a', 0])), rule('p20', '20', [host('a.example.com'), path('/static/*')], to(['app', 1]))];
    const [group] = await scan(ports({
      lbs: { web: { listeners: { l443: rules } } }, groups: { app: {}, 'dmt-dev-a': { type: 'lambda' } }, asgs: { app: 'a-asg' },
      tags: { [rules[0]!.RuleArn]: { 'dormeto:workload': 'a' } },
    }));
    expect([group!.eligibility, group!.workloadId, group!.reason]).toEqual(['managed', 'a', '1 of 2 rules sharing the target group are not part of the workload']);
    expect(group!.rules.map((r) => r.managed)).toEqual([true, false]);
  });

  it('flags rules of several workloads sharing one target group', async () => {
    const rules = [rule('p10', '10', [host('a.example.com')], to(['app', 1], ['dmt-dev-a', 0])), rule('p20', '20', [host('b.example.com')], to(['app', 1], ['dmt-dev-b', 0]))];
    const [group] = await scan(ports({
      lbs: { web: { listeners: { l443: rules } } }, groups: { app: {}, 'dmt-dev-a': { type: 'lambda' }, 'dmt-dev-b': { type: 'lambda' } }, asgs: { app: 'a-asg' },
      tags: { [rules[0]!.RuleArn]: { 'dormeto:workload': 'a' }, [rules[1]!.RuleArn]: { 'dormeto:workload': 'b' } },
    }));
    expect([group!.eligibility, group!.reason]).toEqual(['managed', 'rules of 2 workloads share the target group (a, b)']);
  });

  it('keeps a fully managed group managed, asleep or awake', async () => {
    const asleep = to(['app', 0], ['dmt-dev-a', 1]);
    const rules = [rule('p10', '10', [host('a.example.com')], asleep), rule('p20', '20', [host('a.example.com'), path('/static/*')], asleep)];
    const workload = { 'dormeto:workload': 'a' };
    const [group] = await scan(ports({
      lbs: { web: { listeners: { l443: rules } } }, groups: { app: {}, 'dmt-dev-a': { type: 'lambda' } }, asgs: { app: 'a-asg' },
      tags: { [rules[0]!.RuleArn]: workload, [rules[1]!.RuleArn]: workload },
    }));
    expect([group!.eligibility, group!.reason, group!.rules.length, group!.backend]).toEqual(['managed', undefined, 2, { kind: 'asg', id: 'a-asg' }]);
  });
});
