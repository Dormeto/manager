// Phase 1 of the estimate (spec §4): each account's regions, discovery's scan of each, and what each eligible workload's
// backend would stop, kept per account and region.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScannedRule } from '@dormeto/discovery';
import { createCache } from '../src/cache.js';
import { discoverAll, discoverRegion, type RegionPorts } from '../src/discover.js';
import type { Reached } from '../src/accounts.js';

const A = '111111111111';
const R = 'eu-west-1';
const T = Date.parse('2026-10-10T12:00:00.000Z');
const LB = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/web/0123456789abcdef`;
const tg = (name: string) => `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/${name}/fedcba9876543210`;
const rule = (name: string, over: Partial<ScannedRule> = {}): ScannedRule => ({
  id: tg(name), account: A, region: R, loadBalancer: 'web', loadBalancerArn: LB, listener: 'HTTPS:443', priority: '10',
  conditions: `host ${name}.example.com`, hosts: [`${name}.example.com`], targetGroup: name, targetGroupArn: tg(name),
  backend: { kind: 'asg', id: `${name}-asg` }, tags: {}, rules: [], eligibility: 'eligible', idleHours7d: 120, requests7d: 40, ...over,
});

function regionPorts(rules: ScannedRule[], { desired = 2 } = {}) {
  const asked: { services: unknown[] } = { services: [] };
  const ports: RegionPorts = {
    scan: async () => rules,
    autoscaling: { describeAutoScalingGroups: async ({ AutoScalingGroupNames }) => ({ AutoScalingGroups: AutoScalingGroupNames.map((n) => ({ AutoScalingGroupName: n, DesiredCapacity: desired, Instances: [{ InstanceId: 'i-1' }, { InstanceId: 'i-2' }] })) }) },
    ec2: {
      describeInstances: async ({ InstanceIds }) => ({ Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, InstanceType: id === 'i-9' ? 'm5.large' : 't3.medium', PlatformDetails: 'Linux/UNIX' })) }] }),
    },
    elbv2: { describeRules: async () => ({ Rules: [] }) },
    ecs: {
      describeServices: async (input) => { asked.services.push(input); return { services: [{ serviceArn: input.services[0], desiredCount: 3, launchType: 'FARGATE', taskDefinition: 'api:7' }] }; },
      describeTaskDefinition: async () => ({ taskDefinition: { cpu: '256', memory: '512', runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' } } }),
    },
  };
  return { ports, asked };
}

describe('a region\'s discovery', () => {
  it('describes what each eligible workload would stop: an Auto Scaling group, an ECS service, an instance', async () => {
    const service = `arn:aws:ecs:${R}:${A}:service/prod/api`;
    const { ports, asked } = regionPorts([
      rule('web'),
      rule('api', { backend: { kind: 'ecs', id: service, arn: service } }),
      rule('admin', { backend: { kind: 'instance', id: 'i-9' } }),
    ]);
    const found = await discoverRegion(ports, { account: A, region: R });
    expect(found.workloads.map((w) => [w.targetGroup, w.stopped])).toEqual([
      ['web', [{ kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' }]],
      ['api', [{ kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, arch: 'arm64', os: 'Linux', count: 3 }]],
      ['admin', [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Linux' }]],
    ]);
    // The service's cluster from its ARN.
    expect(asked.services[0]).toEqual({ cluster: 'prod', services: [service] });
    expect(found.workloads[0]).toMatchObject({ account: A, region: R, loadBalancer: 'web', loadBalancerArn: LB, targetGroupArn: tg('web'), hosts: ['web.example.com'], backend: { kind: 'asg', id: 'web-asg' } });
  });

  it('an Auto Scaling group at a desired capacity of 0 stops nothing', async () => {
    const { ports } = regionPorts([rule('web')], { desired: 0 });
    expect((await discoverRegion(ports, { account: A, region: R })).workloads[0]!.stopped).toEqual([]);
  });

  it('keeps the ineligible rules with discovery\'s reason', async () => {
    const { ports } = regionPorts([rule('shared', { eligibility: 'ineligible', reason: 'its target group is shared by another rule' })]);
    const found = await discoverRegion(ports, { account: A, region: R });
    expect(found.workloads).toEqual([]);
    expect(found.ineligible).toEqual([{ loadBalancer: 'web', targetGroup: 'shared', hosts: ['shared.example.com'], reason: 'its target group is shared by another rule' }]);
  });

  it('estimates a workload Dormeto already manages too, with its waker target group from its rule\'s forward', async () => {
    const ruleArn = `arn:aws:elasticloadbalancing:${R}:${A}:listener-rule/app/web/0123456789abcdef/aaaa/bbbb`;
    const waker = `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/dmtr-dev-napping/0000000000000000`;
    const { ports } = regionPorts([rule('napping', { eligibility: 'managed', workloadId: 'abc', rules: [{ id: ruleArn, listener: 'HTTPS:443', priority: '10', conditions: '', hosts: [], managed: true }] })]);
    const asked: unknown[] = [];
    ports.elbv2 = { describeRules: async (input) => { asked.push(input); return { Rules: [{ RuleArn: ruleArn, Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: tg('napping'), Weight: 0 }, { TargetGroupArn: waker, Weight: 1 }] } }] }] }; } };
    const found = await discoverRegion(ports, { account: A, region: R });
    expect(asked).toEqual([{ RuleArns: [ruleArn] }]);
    expect(found.ineligible).toEqual([]);
    expect(found.workloads[0]).toMatchObject({ targetGroup: 'napping', managed: true, wakerTargetGroupArn: waker, stopped: [{ kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' }] });
  });
});

describe('the discovery of every account and region', () => {
  const account = (id: string, credentials: () => Promise<null | { accessKeyId: string; secretAccessKey: string; sessionToken: string }> = async () => null) => ({ account: id, name: id, credentials });
  const reachedOf = (accounts: ReturnType<typeof account>[]): Reached => ({ organization: 'o-abc123', why: null, accounts, unreachable: [] });

  function setup({ accounts = [account(A)], regions = [R, 'eu-west-3'], failing = new Set<string>(), delay = 0 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const calls = { scans: [] as string[], regions: 0, active: 0, most: 0 };
    const run = (over: { refresh?: 'discovery' | 'metrics' | null } = {}) => discoverAll({
      reached: reachedOf(accounts), cache: createCache({ dir, now: () => T }), refresh: over.refresh ?? null, now: () => T,
      regionsOf: async () => { calls.regions += 1; return regions; },
      portsOf: (acct, region) => ({
        ...regionPorts([rule(`${acct}-${region}`)]).ports,
        scan: async () => {
          calls.scans.push(`${acct}/${region}`);
          calls.active += 1;
          calls.most = Math.max(calls.most, calls.active);
          await new Promise((r) => setTimeout(r, delay));
          calls.active -= 1;
          if (failing.has(region)) throw new Error('The security token included in the request is invalid (an opt-in region not enabled)');
          return [rule(`${acct}-${region}`)];
        },
      }),
    });
    return { run, calls, dir };
  }

  it('every account\'s regions; a region that fails is said and the others go on', async () => {
    const s = setup({ failing: new Set(['eu-west-3']) });
    const { regions } = await s.run();
    expect(regions.map((r) => [r.region, r.workloads.length, r.error ?? null])).toEqual([
      [R, 1, null], ['eu-west-3', 0, 'The security token included in the request is invalid (an opt-in region not enabled)'],
    ]);
  });

  it('kept per account and region: a second run reads the cache, a failed region is tried again, --refresh discovery scans again', async () => {
    const s = setup({ failing: new Set(['eu-west-3']) });
    await s.run();
    expect(s.calls.scans).toEqual([`${A}/${R}`, `${A}/eu-west-3`]);
    await s.run();
    // The cached region is not scanned again, nor its regions listed; the failed one is.
    expect(s.calls.scans).toEqual([`${A}/${R}`, `${A}/eu-west-3`, `${A}/eu-west-3`]);
    expect(s.calls.regions).toBe(1);
    await s.run({ refresh: 'discovery' });
    expect(s.calls.scans.slice(3)).toEqual([`${A}/${R}`, `${A}/eu-west-3`]);
  });

  it('an account whose role cannot be assumed is not scanned; an account cached entirely assumes nothing', async () => {
    let assumed = 0;
    const refused = account('222222222222', async () => { assumed += 1; throw new Error('not authorized to perform: sts:AssumeRole'); });
    const s = setup({ accounts: [account(A), refused] });
    const { regions } = await s.run();
    expect(regions.map((r) => r.account)).toEqual([A, A]);
    expect(assumed).toBe(1);
    const cachedOnly = account(A, async () => { throw new Error('should not be asked'); });
    const again = await discoverAll({
      reached: reachedOf([cachedOnly]), cache: createCache({ dir: s.dir, now: () => T }), refresh: null, now: () => T,
      regionsOf: async () => { throw new Error('should not be asked'); }, portsOf: () => { throw new Error('should not be asked'); },
    });
    expect(again.regions).toHaveLength(2);
  });

  it('four accounts at a time at most', async () => {
    const s = setup({ accounts: ['1', '2', '3', '4', '5', '6'].map((n) => account(n.repeat(12))), regions: [R], delay: 20 });
    await s.run();
    expect(s.calls.scans).toHaveLength(6);
    expect(s.calls.most).toBe(4);
  });
});
