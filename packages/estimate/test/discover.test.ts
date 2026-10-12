// Phase 1 of the estimate (spec §4): each account's regions, discovery's scan of each, and what each eligible workload's
// backend would stop, kept per account and region.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScannedRule } from '@dormeto/discovery';
import { createCache } from '../src/cache.js';
import { discoverAll, discoverRegion, type AccountEvent, type RegionPorts } from '../src/discover.js';
import type { Reached } from '../src/accounts.js';

const A = '111111111111';
const B = '222222222222';
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

  it('an ECS service keeps its desired count; one at 0 tasks is described as one task (its measured uptime may estimate it), unless Dormeto manages it', async () => {
    const service = `arn:aws:ecs:${R}:${A}:service/prod/api`;
    const at = (desired: number, over: Partial<ScannedRule> = {}) => {
      const { ports } = regionPorts([rule('api', { backend: { kind: 'ecs', id: service, arn: service }, ...over })]);
      ports.ecs = { ...ports.ecs, describeServices: async (input) => ({ services: [{ serviceArn: input.services[0], desiredCount: desired, launchType: 'FARGATE', taskDefinition: 'api:7' }] }) };
      return discoverRegion(ports, { account: A, region: R }).then((r) => r.workloads[0]!);
    };
    const task = { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, arch: 'arm64', os: 'Linux' };
    expect(await at(3)).toMatchObject({ ecsDesired: 3, stopped: [{ ...task, count: 3 }] });
    expect(await at(0)).toMatchObject({ ecsDesired: 0, stopped: [{ ...task, count: 1 }] });
    const ruleArn = `arn:aws:elasticloadbalancing:${R}:${A}:listener-rule/app/web/0123456789abcdef/aaaa/dddd`;
    const napped = await at(0, { eligibility: 'managed', workloadId: 'abc', rules: [{ id: ruleArn, listener: 'HTTPS:443', priority: '10', conditions: '', hosts: [], managed: true }] });
    expect([napped.ecsDesired, napped.stopped]).toEqual([undefined, []]);
  });

  it('keeps each workload\'s tags: every value of each tag on its load balancer, target group or rule, as discovery reads them', async () => {
    const { ports } = regionPorts([rule('web', { tags: { env: ['dev'], team: ['web', 'shop'] } })]);
    expect((await discoverRegion(ports, { account: A, region: R })).workloads[0]!.tags).toEqual({ env: ['dev'], team: ['web', 'shop'] });
  });

  const inState = (state: string | undefined) => {
    const { ports } = regionPorts([rule('admin', { backend: { kind: 'instance', id: 'i-9' } })]);
    ports.ec2 = { describeInstances: async ({ InstanceIds }) => ({ Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, InstanceType: 'm5.large', PlatformDetails: 'Linux/UNIX', ...(state ? { State: { Name: state } } : {}) })) }] }) };
    return discoverRegion(ports, { account: A, region: R }).then((r) => r.workloads[0]!);
  };

  it('an instance keeps its state; one already stopped is described all the same (its measured uptime may estimate it)', async () => {
    expect(await inState('running')).toMatchObject({ instanceState: 'running', stopped: [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Linux' }] });
    expect(await inState('stopped')).toMatchObject({ instanceState: 'stopped', stopped: [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Linux' }] });
    // No state said: running, as before.
    expect(await inState(undefined)).toMatchObject({ instanceState: 'running' });
  });

  it('a terminated instance stops nothing', async () => {
    expect(await inState('terminated')).toMatchObject({ instanceState: 'terminated', stopped: [] });
  });

  it('an instance Dormeto manages that is stopped is napping: still estimated (it runs when woken)', async () => {
    const ruleArn = `arn:aws:elasticloadbalancing:${R}:${A}:listener-rule/app/web/0123456789abcdef/aaaa/cccc`;
    const { ports } = regionPorts([rule('napping', { eligibility: 'managed', workloadId: 'abc', backend: { kind: 'instance', id: 'i-9' }, rules: [{ id: ruleArn, listener: 'HTTPS:443', priority: '10', conditions: '', hosts: [], managed: true }] })]);
    ports.ec2 = { describeInstances: async ({ InstanceIds }) => ({ Reservations: [{ Instances: InstanceIds.map((id) => ({ InstanceId: id, InstanceType: 'm5.large', PlatformDetails: 'Linux/UNIX', State: { Name: 'stopped' } })) }] }) };
    expect((await discoverRegion(ports, { account: A, region: R })).workloads[0]!.stopped).toEqual([{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Linux' }]);
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

// Companion databases (the user, 2026-10-11): an RDS instance or an Aurora provisioned cluster whose security group lets
// a workload's in, found in discovery and attached in the estimate (after the wakes filter).
describe('a region\'s companion databases', () => {
  const sgOf: Record<string, string> = { 'i-9': 'sg-app', 'i-1': 'sg-web', 'i-2': 'sg-web' };
  const db = (id: string, over: Record<string, unknown> = {}) => ({ DBInstanceIdentifier: id, DBInstanceStatus: 'available', Engine: 'mysql', DBInstanceClass: 'db.t3.medium', MultiAZ: false, VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-db', Status: 'active' }], TagList: [], ...over });
  const INSTANCES = [
    db('shop-db', { TagList: [{ Key: 'env', Value: 'dev' }] }),
    db('replica', { ReadReplicaSourceDBInstanceIdentifier: 'shop-db' }),
    db('with-replicas', { ReadReplicaDBInstanceIdentifiers: ['far'], VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-db2', Status: 'active' }] }),
    db('other-db', { VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-other', Status: 'active' }] }),
    db('aur-1', { DBClusterIdentifier: 'aurora', Engine: 'aurora-postgresql', DBInstanceClass: 'db.r6g.large' }),
    db('aur-2', { DBClusterIdentifier: 'aurora', Engine: 'aurora-postgresql', DBInstanceClass: 'db.r6g.large' }),
    db('sls-1', { DBClusterIdentifier: 'aurora-sls', Engine: 'aurora-postgresql', DBInstanceClass: 'db.serverless' }),
  ];
  const CLUSTERS = [
    { DBClusterIdentifier: 'aurora', Status: 'available', Engine: 'aurora-postgresql', EngineMode: 'provisioned', VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-aur', Status: 'active' }], TagList: [{ Key: 'team', Value: 'shop' }] },
    { DBClusterIdentifier: 'aurora-sls', Status: 'available', Engine: 'aurora-postgresql', EngineMode: 'provisioned', VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-aur', Status: 'active' }], TagList: [] },
  ];
  const INGRESS: Record<string, string[]> = { 'sg-db': ['sg-web'], 'sg-db2': ['sg-api'], 'sg-aur': ['sg-app'], 'sg-other': ['sg-elsewhere'] };
  const service = `arn:aws:ecs:${R}:${A}:service/prod/api`;
  function ports(rds?: RegionPorts['rds']) {
    const { ports: base } = regionPorts([rule('web'), rule('api', { backend: { kind: 'ecs', id: service, arn: service } }), rule('admin', { backend: { kind: 'instance', id: 'i-9' } })]);
    const instances = base.ec2!.describeInstances;
    base.ec2 = {
      describeInstances: async (input) => {
        const out = await instances(input);
        for (const r of out.Reservations ?? []) for (const i of r.Instances ?? []) Object.assign(i, { SecurityGroups: [{ GroupId: sgOf[i.InstanceId!] }] });
        return out;
      },
      describeSecurityGroups: async ({ GroupIds }) => ({ SecurityGroups: GroupIds.map((g) => ({ GroupId: g, IpPermissions: [{ UserIdGroupPairs: (INGRESS[g] ?? []).map((from) => ({ GroupId: from })) }, { IpRanges: [{ CidrIp: '10.0.0.0/16' }] }] })) }),
    };
    const services = base.ecs.describeServices;
    base.ecs = { ...base.ecs, describeServices: async (input) => {
      const out = await services(input);
      return { services: (out.services ?? []).map((x) => ({ ...x, networkConfiguration: { awsvpcConfiguration: { securityGroups: ['sg-api'] } } })) };
    } };
    if (rds) base.rds = rds;
    return base;
  }
  const RDS: RegionPorts['rds'] = {
    describeDBInstances: async ({ Marker }) => (Marker ? { DBInstances: INSTANCES.slice(4) } : { DBInstances: INSTANCES.slice(0, 4), Marker: 'next' }),
    describeDBClusters: async () => ({ DBClusters: CLUSTERS }),
  };

  it('each workload\'s security groups, and the databases whose security group lets one in, with what they stop or why they cannot be stopped', async () => {
    const found = await discoverRegion(ports(RDS), { account: A, region: R });
    expect(found.workloads.map((w) => [w.targetGroup, w.securityGroups])).toEqual([['web', ['sg-web']], ['api', ['sg-api']], ['admin', ['sg-app']]]);
    const item = (cls: string, engine = 'mysql') => ({ kind: 'rds', class: cls, engine, multiAz: false });
    expect(found.databases).toEqual([
      { kind: 'rds-instance', id: 'shop-db', allowedFrom: ['sg-web'], tags: { env: ['dev'] }, stopped: [item('db.t3.medium')] },
      { kind: 'rds-instance', id: 'replica', allowedFrom: ['sg-web'], tags: {}, stopped: [], notStoppable: 'a read replica: cannot be stopped' },
      { kind: 'rds-instance', id: 'with-replicas', allowedFrom: ['sg-api'], tags: {}, stopped: [], notStoppable: 'it has read replicas: cannot be stopped' },
      { kind: 'rds-cluster', id: 'aurora', allowedFrom: ['sg-app'], tags: { team: ['shop'] }, stopped: [item('db.r6g.large', 'aurora-postgresql'), item('db.r6g.large', 'aurora-postgresql')] },
      { kind: 'rds-cluster', id: 'aurora-sls', allowedFrom: ['sg-app'], tags: {}, stopped: [], notStoppable: 'Aurora Serverless: not yet' },
    ]);
  });

  it('without RDS rights the databases are not read, said; without an RDS port (before) none', async () => {
    const denied = { describeDBInstances: async () => { throw Object.assign(new Error('not authorized to perform: rds:DescribeDBInstances'), { name: 'AccessDenied' }); }, describeDBClusters: async () => ({}) };
    const found = await discoverRegion(ports(denied), { account: A, region: R });
    expect([found.databases, found.databasesError]).toEqual([[], 'AccessDenied: not authorized to perform: rds:DescribeDBInstances']);
    expect((await discoverRegion(ports(), { account: A, region: R })).databases).toEqual([]);
  });
});

describe('the discovery of every account and region', () => {
  const account = (id: string, credentials: () => Promise<null | { accessKeyId: string; secretAccessKey: string; sessionToken: string }> = async () => null) => ({ account: id, name: id, credentials });
  const reachedOf = (accounts: ReturnType<typeof account>[]): Reached => ({ organization: 'o-abc123', why: null, accounts, unreachable: [], listed: accounts.length });

  function setup({ accounts = [account(A)], regions = [R, 'eu-west-3'], failing = new Set<string>(), delay = 0, unreachable = [] as Reached['unreachable'] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const calls = { scans: [] as string[], regions: 0, active: 0, most: 0 };
    const events: AccountEvent[] = [];
    const run = (over: { refresh?: 'discovery' | 'metrics' | null; regions?: string[] | null; concurrency?: number } = {}) => discoverAll({
      reached: { ...reachedOf(accounts), unreachable }, cache: createCache({ dir, now: () => T }), refresh: over.refresh ?? null, now: () => T, regions: over.regions ?? null,
      ...(over.concurrency ? { concurrency: over.concurrency } : {}), accountProgress: (e) => events.push(e),
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
    return { run, calls, dir, events };
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

  it('a region kept before instances had their state is scanned again', async () => {
    const s = setup({ regions: [R] });
    const { regions } = await s.run();
    const instance = { ...regions[0]!.workloads[0]!, backend: { kind: 'instance' as const, id: 'i-1' }, stopped: [] };
    await createCache({ dir: s.dir, now: () => T }).put(`discovery/${A}-${R}.json`, { ...regions[0]!, workloads: [instance] });
    await s.run();
    expect(s.calls.scans).toEqual([`${A}/${R}`, `${A}/${R}`]);
    // With its state: kept.
    await createCache({ dir: s.dir, now: () => T }).put(`discovery/${A}-${R}.json`, { ...regions[0]!, workloads: [{ ...instance, instanceState: 'terminated' }] });
    await s.run();
    expect(s.calls.scans).toHaveLength(2);
  });

  it('a region kept before workloads had their tags is scanned again', async () => {
    const s = setup({ regions: [R] });
    const { regions } = await s.run();
    const { tags: _tags, ...untagged } = regions[0]!.workloads[0]!;
    await createCache({ dir: s.dir, now: () => T }).put(`discovery/${A}-${R}.json`, { ...regions[0]!, workloads: [untagged] });
    const again = await s.run();
    expect(s.calls.scans).toEqual([`${A}/${R}`, `${A}/${R}`]);
    expect(again.regions[0]!.workloads[0]!.tags).toEqual({});
  });

  it('an account whose role cannot be assumed is not scanned; an account cached entirely assumes nothing', async () => {
    let assumed = 0;
    // As reachAccounts does: a refusal is listed in reached.unreachable before it is thrown.
    const unreachable: Reached['unreachable'] = [];
    const refused = account('222222222222', async () => { assumed += 1; unreachable.push({ account: '222222222222', name: 'b', reason: 'denied', fix: 'create a role' }); throw new Error('not authorized to perform: sts:AssumeRole'); });
    const s = setup({ accounts: [account(A), refused], unreachable });
    const { regions } = await s.run();
    expect(regions.map((r) => r.account)).toEqual([A, A]);
    expect(assumed).toBe(1);
    const cachedOnly = account(A, async () => { throw new Error('should not be asked'); });
    const again = await discoverAll({
      reached: reachedOf([cachedOnly]), cache: createCache({ dir: s.dir, now: () => T }), refresh: null, now: () => T, regions: null,
      regionsOf: async () => { throw new Error('should not be asked'); }, portsOf: () => { throw new Error('should not be asked'); },
    });
    expect(again.regions).toHaveLength(2);
  });

  it('--regions is used as given, whatever the cache holds, and never cached as the enabled regions', async () => {
    const s = setup();
    await s.run();
    const only = await s.run({ regions: [R] });
    expect(only.regions.map((r) => r.region)).toEqual([R]);
    const t2 = setup();
    await t2.run({ regions: [R] });
    expect(t2.calls.regions).toBe(0);
    const all = await t2.run();
    expect(all.regions.map((r) => r.region)).toEqual([R, 'eu-west-3']);
    expect(t2.calls.regions).toBe(1);
  });

  it('an account that fails for another reason than its role (its regions unreadable) is said, not dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const out = await discoverAll({
      reached: reachedOf([account(A)]), cache: createCache({ dir, now: () => T }), refresh: null, now: () => T, regions: null,
      regionsOf: async () => { throw Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' }); },
      portsOf: () => { throw new Error('not asked'); },
    });
    expect(out.regions).toEqual([{ account: A, region: '*', workloads: [], ineligible: [], error: 'UnauthorizedOperation: You are not authorized to perform this operation.' }]);
  });

  it('five accounts at a time by default, as many as asked (--parallel)', async () => {
    const accounts = ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => account(n.repeat(12)));
    const s = setup({ accounts, regions: [R], delay: 20 });
    await s.run();
    expect(s.calls.scans).toHaveLength(8);
    expect(s.calls.most).toBe(5);
    for (const concurrency of [1, 2]) {
      const t = setup({ accounts, regions: [R], delay: 10 });
      await t.run({ concurrency });
      expect(t.calls.most).toBe(concurrency);
    }
  });

  it('says when each account starts, with its regions, and when it is done (the phase\'s progress)', async () => {
    const s = setup({ accounts: [account(A), account(B)], failing: new Set(['eu-west-3']) });
    await s.run({ concurrency: 1 });
    expect(s.events).toEqual([
      { account: A, state: 'started', regions: 2 }, { account: A, state: 'done', regions: 2 },
      { account: B, state: 'started', regions: 2 }, { account: B, state: 'done', regions: 2 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const events: AccountEvent[] = [];
    await discoverAll({
      reached: reachedOf([account(A)]), cache: createCache({ dir, now: () => T }), refresh: null, now: () => T, regions: null, accountProgress: (e) => events.push(e),
      regionsOf: async () => { throw Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }); }, portsOf: () => { throw new Error('not asked'); },
    });
    expect(events).toEqual([{ account: A, state: 'done', regions: 0, error: 'UnauthorizedOperation: not authorized' }]);
  });
});

// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, section 9): read with the profile's own access.
describe('a region\'s Kubernetes workloads', () => {
  const k8sRule = (name: string, namespace: string) => rule(name, {
    backend: { kind: 'k8s', id: `eks-demo/${namespace}/Deployment/${name}`, kubernetes: { cluster: 'eks-demo', namespace, owner: { kind: 'Deployment', name }, switch: 'ingress', hpa: false, keda: false, capacity: namespace === 'fargate' ? 'fargate' : 'nodes', autoscaler: 'karpenter' } },
  });
  // The cluster as the router's client reads it: the owners, their ReplicaSets and pods (on Fargate or a Karpenter node), the node.
  const cluster = {
    async get(path: string) {
      if (path.endsWith('/deployments/web') || path.endsWith('/deployments/docs')) return { spec: { replicas: 1, selector: { matchLabels: { app: path.split('/').at(-1) } } } };
      if (path.startsWith('/api/v1/nodes/')) return { metadata: { labels: { 'node.kubernetes.io/instance-type': 'm5.large', 'kubernetes.io/os': 'linux', 'karpenter.sh/nodepool': 'demo' } }, status: { allocatable: { cpu: '1930m', memory: '7220184Ki' } } };
      throw Object.assign(new Error(`${path} not found`), { status: 404 });
    },
    async list(path: string, query: Record<string, string> = {}) {
      const owned = (app: string) => ({ ownerReferences: [{ kind: 'ReplicaSet', name: `${app}-5d4f8`, controller: true }] });
      const sets = /^\/apis\/apps\/v1\/namespaces\/[^/]+\/replicasets$/.test(path) && query.labelSelector?.startsWith('app=');
      if (sets) return [{ metadata: { name: `${query.labelSelector!.slice(4)}-5d4f8`, ownerReferences: [{ kind: 'Deployment', name: query.labelSelector!.slice(4), controller: true }] } }];
      const pod = (app: string, extra: Record<string, unknown>) => ({ metadata: { name: `${app}-1`, labels: { app }, ...owned(app) }, spec: { nodeName: 'ip-10-0-1-1', containers: [{ resources: { requests: { cpu: '250m', memory: '512Mi' } } }], ...extra }, status: { phase: 'Running' } });
      if (path === '/api/v1/namespaces/demo/pods' && query.labelSelector === 'app=web') return [pod('web', {})];
      if (path === '/api/v1/namespaces/fargate/pods' && query.labelSelector === 'app=docs') return [{ ...pod('docs', { schedulerName: 'fargate-scheduler', nodeName: 'fargate-ip-1' }), metadata: { name: 'docs-1', labels: { app: 'docs' }, annotations: { CapacityProvisioned: '0.25vCPU 0.5GB' }, ...owned('docs') } }];
      return [];
    },
  };

  it('describes the pods a nap would stop: on a node, its share; on Fargate, its size', async () => {
    const { ports } = regionPorts([k8sRule('web', 'demo'), k8sRule('docs', 'fargate')]);
    const found = await discoverRegion({ ...ports, kubernetesOf: async () => cluster }, { account: A, region: R });
    expect(found.workloads.map((w) => [w.targetGroup, w.backend, w.stopped])).toEqual([
      ['web', { kind: 'k8s', id: 'eks-demo/demo/Deployment/web' }, [{ kind: 'k8s-pods', count: 1, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } }]],
      ['docs', { kind: 'k8s', id: 'eks-demo/fargate/Deployment/docs' }, [{ kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'x86_64', os: 'Linux' }]],
    ]);
  });

  it('lists the clusters the profile cannot read, with the reason', async () => {
    const { ports } = regionPorts([]);
    const found = await discoverRegion({ ...ports, unreadableClusters: () => [{ name: 'eks-prod', reason: 'the cluster does not let the profile read it (an access entry with AmazonEKSViewPolicy): Unauthorized' }] }, { account: A, region: R });
    expect(found.clusters).toEqual([{ name: 'eks-prod', reason: 'the cluster does not let the profile read it (an access entry with AmazonEKSViewPolicy): Unauthorized' }]);
  });
});

