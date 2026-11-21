// The standalone scan on AWS (vision standalone workloads design §6): instances outside a group, groups with no target
// group, ECS services with no load balancer, RDS instances and Aurora clusters, each a candidate of its own resource, with
// the router's eligibility texts (router lambda/src/lib/onboarding.mjs resourceOf).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRegion } from '../src/scan.js';
import { workloadIdOf } from '../src/standalone.js';
import type { DiscoveredRule, StandaloneRule } from '../src/types.js';
import { scanPorts } from './scan-fakes.js';
import { ACCOUNT, REGION, clusterArn, dbArn, groupArn, instanceArn, serviceArn, standalonePorts } from './standalone-fakes.js';

const NOW = () => Date.UTC(2026, 9, 4, 12, 30);
const WHERE = { account: ACCOUNT, region: REGION };
const standaloneOf = (found: DiscoveredRule[]) => found.filter((c): c is StandaloneRule => c.kind === 'standalone');
const byArn = (found: DiscoveredRule[]) => Object.fromEntries(standaloneOf(found).map((c) => [c.id, c]));

// Each listed resource: its eligibility and reason (none when eligible).
const EXPECTED: Record<string, [string, string?]> = {
  [instanceArn('i-lone')]: ['eligible'],
  [instanceArn('i-noname')]: ['eligible'],
  [instanceArn('i-store')]: ['ineligible', 'instance i-store has an instance store root volume: it cannot be stopped'],
  [instanceArn('i-spot')]: ['ineligible', 'instance i-spot is a Spot instance: Dormeto stops On-Demand instances only'],
  [instanceArn('i-both')]: ['ineligible', 'instance i-both has an instance store root volume: it cannot be stopped; instance i-both is a Spot instance: Dormeto stops On-Demand instances only'],
  [instanceArn('i-nlb')]: ['ineligible', 'instance i-nlb feeds target group tcp: it belongs to an HTTP workload (onboard its target group)'],
  [instanceArn('i-member')]: ['ineligible', 'instance i-member is in Auto Scaling group workers: onboard the group (it would replace a stopped instance)'],
  [instanceArn('i-managed')]: ['managed'],
  [groupArn('workers')]: ['eligible'],
  [groupArn('eks-nodes')]: ['ineligible', 'Auto Scaling group eks-nodes holds EKS nodes: onboard the Kubernetes workloads that run on them'],
  [groupArn('tcp-asg')]: ['ineligible', 'Auto Scaling group tcp-asg feeds target group tcp: it belongs to an HTTP workload (onboard its target group)'],
  [serviceArn('main', 'worker')]: ['eligible'],
  [serviceArn('main', 'agent')]: ['ineligible', 'ECS service main/agent uses the daemon scheduling strategy: it has no desired count to set to 0'],
  [dbArn('shop-db')]: ['eligible'],
  [dbArn('replica')]: ['ineligible', 'RDS instance replica is a read replica: it cannot be stopped'],
  [dbArn('aurora-1')]: ['ineligible', 'RDS instance aurora-1 is a member of Aurora cluster aurora: onboard the cluster'],
  [clusterArn('aurora')]: ['eligible'],
  [clusterArn('serverless')]: ['ineligible', 'RDS cluster serverless is Aurora Serverless v1: it cannot be stopped'],
};

describe('the standalone scan', () => {
  it('lists each kind of resource no route uses, with what Dormeto can do with it, in the order of the kinds', async () => {
    const found = standaloneOf(await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true }));
    expect(found.map((c) => c.id)).toEqual(Object.keys(EXPECTED));
    expect(Object.fromEntries(found.map((c) => [c.id, c.reason ? [c.eligibility, c.reason] : [c.eligibility]]))).toEqual(EXPECTED);
  });

  it('gives each candidate its resource as id, its backend, its default name and its own tags, and no load balancer field', async () => {
    const found = byArn(await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true }));
    expect(found[instanceArn('i-lone')]).toEqual({
      kind: 'standalone', id: instanceArn('i-lone'), account: ACCOUNT, region: REGION, resourceArn: instanceArn('i-lone'), name: 'build-agent',
      backend: { kind: 'instance', id: 'i-lone', arn: instanceArn('i-lone') }, tags: { Name: ['build-agent'], team: ['ci'] }, eligibility: 'eligible', idleHours7d: null,
    });
    expect(found[instanceArn('i-noname')]!.name).toBe('i-noname');
    expect([found[groupArn('workers')]!.name, found[groupArn('workers')]!.backend, found[groupArn('workers')]!.tags]).toEqual(['workers', { kind: 'asg', id: 'workers', arn: groupArn('workers') }, { team: ['batch'] }]);
    expect([found[serviceArn('main', 'worker')]!.name, found[serviceArn('main', 'worker')]!.backend, found[serviceArn('main', 'worker')]!.tags])
      .toEqual(['worker', { kind: 'ecs', id: serviceArn('main', 'worker'), arn: serviceArn('main', 'worker') }, { team: ['jobs'] }]);
    expect([found[dbArn('shop-db')]!.backend, found[dbArn('shop-db')]!.tags]).toEqual([{ kind: 'rds-instance', id: 'shop-db', arn: dbArn('shop-db') }, { env: ['dev'] }]);
    expect(found[clusterArn('aurora')]!.backend).toEqual({ kind: 'rds-cluster', id: 'aurora', arn: clusterArn('aurora') });
    for (const c of Object.values(found)) {
      expect(Object.keys(c).filter((k) => ['loadBalancer', 'loadBalancerArn', 'listener', 'priority', 'conditions', 'hosts', 'targetGroup', 'targetGroupArn', 'rules', 'requests7d'].includes(k)), c.id).toEqual([]);
    }
  });

  it('says a resource onboarded as a standalone workload managed by its tag, the router\'s id of its ARN', async () => {
    const managed = byArn(await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true }))[instanceArn('i-managed')]!;
    const id = createHash('sha256').update(instanceArn('i-managed')).digest('hex').slice(0, 16);
    expect([managed.eligibility, managed.workloadId, managed.reason]).toEqual(['managed', id, undefined]);
    expect(workloadIdOf(instanceArn('i-managed'))).toBe(id);
  });

  it('leaves out what belongs to an HTTP candidate or another workload, Kubernetes nodes, the members of those groups, and what is gone', async () => {
    const ids = Object.keys(byArn(await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true })));
    for (const arn of [
      instanceArn('i-shop'), // behind the rule of shop
      instanceArn('i-batch'), groupArn('batch-asg'), // the HTTP candidate batch's group
      instanceArn('i-node'), // a node of EKS cluster demo
      instanceArn('i-companion'), dbArn('companion-db'), // tagged by another workload: its backend or its companion
      instanceArn('i-gone'), serviceArn('main', 'old'), // terminated, inactive
      serviceArn('main', 'api'), // the HTTP candidate api's service
    ]) expect(ids, arn).not.toContain(arn);
  });

  it('keeps the HTTP candidates byte-equal and makes no new call when the standalone scan is off', async () => {
    const before = await scanRegion(scanPorts().ports, WHERE, { now: NOW });
    const off = standalonePorts();
    const found = await scanRegion(off.ports, WHERE, { now: NOW });
    expect(JSON.stringify(found)).toEqual(JSON.stringify(before));
    expect(off.calls.filter((c) => /^(rds|ec2)\./.test(c) || c.includes('"include"'))).toEqual([]);
    // On, the HTTP candidates are the same, first.
    const on = await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true });
    expect(JSON.stringify(on.filter((c) => c.kind !== 'standalone'))).toEqual(JSON.stringify(before));
    expect(on.slice(0, before.length).every((c) => c.kind !== 'standalone')).toBe(true);
  });

  it('reads every page of the instances, groups, services and databases', async () => {
    const { ports, calls } = standalonePorts();
    await scanRegion(ports, WHERE, { now: NOW, standalone: true });
    expect(calls.filter((c) => c.startsWith('ec2.describeInstances')).length).toBe(4);
    expect(calls.filter((c) => c.startsWith('rds.describeDBInstances')).length).toBe(2);
    expect(calls.filter((c) => c.startsWith('rds.describeDBClusters')).length).toBe(1);
    expect(calls.filter((c) => c.startsWith('ecs.describeServices')).every((c) => c.includes('"include":["TAGS"]'))).toBe(true);
  });

  it('lists the other kinds when the discovery role may not read RDS, and says what is missing', async () => {
    const reports: { problems: string[]; unread: string[] }[] = [];
    const found = byArn(await scanRegion(standalonePorts({ deny: ['rds:DescribeDBInstances', 'rds:DescribeDBClusters'] }).ports, WHERE, { now: NOW, standalone: true, onStandalone: (r) => reports.push(r) }));
    expect(Object.keys(found)).toEqual(Object.keys(EXPECTED).filter((arn) => !arn.includes(':rds:')));
    expect(reports).toEqual([{
      problems: [
        'RDS instances not listed: the discovery role may not call rds:DescribeDBInstances (apply the access module or the AWS CLI script of this release again)',
        'RDS clusters not listed: the discovery role may not call rds:DescribeDBClusters (apply the access module or the AWS CLI script of this release again)',
      ],
      unread: ['rds-instance', 'rds-cluster'],
    }]);
  });

  it('describes the ECS services without their tags when they may not be read with them, and says so', async () => {
    const reports: { problems: string[]; unread: string[] }[] = [];
    const found = byArn(await scanRegion(standalonePorts({ deny: ['ecs:DescribeServices with tags'] }).ports, WHERE, { now: NOW, standalone: true, onStandalone: (r) => reports.push(r) }));
    expect(Object.keys(found)).toEqual(Object.keys(EXPECTED));
    expect(found[serviceArn('main', 'worker')]!.tags).toEqual({});
    expect(reports).toEqual([{ problems: ['resource tags of ECS services could not be read: the discovery role may not describe them with their tags; they are listed without them'], unread: [] }]);
  });

  it('reports nothing missing when every kind was read', async () => {
    const reports: unknown[] = [];
    await scanRegion(standalonePorts().ports, WHERE, { now: NOW, standalone: true, onStandalone: (r) => reports.push(r) });
    expect(reports).toEqual([{ problems: [], unread: [] }]);
  });

  it('fails the region on a describe error that is no refusal', async () => {
    const { ports } = standalonePorts();
    ports.rds = { ...ports.rds!, async describeDBClusters() { throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }); } };
    await expect(scanRegion(ports, WHERE, { now: NOW, standalone: true })).rejects.toThrow('Rate exceeded');
  });
});

// The router's onboarding preview on the same recorded answers: the scan's reasons are its problems, its names the router's
// default names, its ids the router's. Skipped when the router's checkout is not beside the manager's.
const ONBOARDING = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/onboarding.mjs');
type RouterOnboarding = {
  workloadIdOf(arn: string): string;
  createOnboarding(deps: Record<string, unknown>): { preview(event: { resourceArn: string }): Promise<{ problems: string[]; name: string }> };
};
const router = (existsSync(ONBOARDING) ? await import(/* @vite-ignore */ ONBOARDING) : null) as RouterOnboarding | null;

describe.skipIf(!router)('the standalone scan against the router\'s onboarding preview', () => {
  it('gives each listed resource the router\'s problems, joined, and its default name', async () => {
    const { ports } = standalonePorts();
    const found = standaloneOf(await scanRegion(ports, WHERE, { now: NOW, standalone: true })).filter((c) => c.eligibility !== 'managed');
    const onboarding = router!.createOnboarding({ ...ports, store: { listConfigs: async () => [] }, router: { name: 'dmtr-dev-eu-west-1' }, log: { info() {}, warn() {} } });
    for (const c of found) {
      const preview = await onboarding.preview({ resourceArn: c.resourceArn! });
      expect([preview.problems, preview.name], c.id).toEqual([c.reason ? c.reason.split('; ') : [], c.name]);
    }
    expect(found.length).toBe(Object.keys(EXPECTED).length - 1);
  });

  it('says managed with the router\'s workload id of the resource', () => {
    for (const arn of Object.keys(EXPECTED)) expect(workloadIdOf(arn)).toBe(router!.workloadIdOf(arn));
  });
});
