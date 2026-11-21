// The region of scan-fakes.ts with standalone resources beside its load balancer (vision standalone workloads design §6):
// recorded describe answers of EC2, Auto Scaling, ECS and RDS, one case each of what the router says of a resource
// (router lambda/src/lib/onboarding.mjs resourceOf), and a recorder of every call the scan makes.
import { createHash } from 'node:crypto';
import type { ScanPorts } from '../src/scan.js';
import { BATCH_ASG_ARN, P, TGS, scanPorts } from './scan-fakes.js';

export const ACCOUNT = '111122223333';
export const REGION = 'eu-west-1';
const hash = (arn: string) => createHash('sha256').update(arn).digest('hex').slice(0, 16);
export const instanceArn = (id: string) => `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${id}`;
export const groupArn = (name: string) => `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:6d4f2c1e-0000-4000-8000-${name.length.toString().padStart(12, '0')}:autoScalingGroupName/${name}`;
export const serviceArn = (cluster: string, name: string) => `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${cluster}/${name}`;
export const dbArn = (id: string) => `arn:aws:rds:${REGION}:${ACCOUNT}:db:${id}`;
export const clusterArn = (id: string) => `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:${id}`;
// A target group of a network load balancer: no rule of an application load balancer forwards to it.
export const TCP = { TargetGroupArn: `${P}:targetgroup/tcp/1`, TargetGroupName: 'tcp', TargetType: 'instance', LoadBalancerArns: [`${P}:loadbalancer/net/nlb/x`] };

type Tags = Record<string, string>;
const list = (tags: Tags = {}) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const instance = (InstanceId: string, over: { tags?: Tags; State?: string; RootDeviceType?: string; InstanceLifecycle?: string } = {}) => ({
  InstanceId, State: { Name: over.State ?? 'running' }, RootDeviceType: over.RootDeviceType ?? 'ebs', ...(over.InstanceLifecycle ? { InstanceLifecycle: over.InstanceLifecycle } : {}), Tags: list(over.tags),
});

export const INSTANCES = [
  instance('i-lone', { tags: { Name: 'build-agent', team: 'ci' } }),
  instance('i-noname'),
  instance('i-store', { RootDeviceType: 'instance-store' }),
  instance('i-spot', { InstanceLifecycle: 'spot' }),
  instance('i-both', { RootDeviceType: 'instance-store', InstanceLifecycle: 'spot' }),
  instance('i-nlb'), // in the network load balancer's target group
  instance('i-shop'), // the HTTP candidate shop's backend
  instance('i-member', { tags: { 'aws:autoscaling:groupName': 'workers' } }),
  instance('i-batch', { tags: { 'aws:autoscaling:groupName': 'batch-asg' } }), // its group is an HTTP candidate's backend
  instance('i-node', { tags: { 'eks:cluster-name': 'demo' } }), // a Karpenter node, in no group
  instance('i-managed', { tags: { 'dormeto:workload': hash(instanceArn('i-managed')), 'dormeto:tagged': 'onboarder' } }),
  instance('i-companion', { tags: { 'dormeto:workload': '0123456789abcdef' } }),
  instance('i-gone', { State: 'terminated' }),
];

export const GROUPS = [
  { AutoScalingGroupName: 'batch-asg', AutoScalingGroupARN: BATCH_ASG_ARN, TargetGroupARNs: [TGS.batch!.TargetGroupArn], Tags: [] },
  { AutoScalingGroupName: 'workers', AutoScalingGroupARN: groupArn('workers'), TargetGroupARNs: [], Tags: [{ Key: 'team', Value: 'batch', ResourceId: 'workers' }] },
  { AutoScalingGroupName: 'eks-nodes', AutoScalingGroupARN: groupArn('eks-nodes'), TargetGroupARNs: [], Tags: [{ Key: 'eks:nodegroup-name', Value: 'ng-1' }] },
  { AutoScalingGroupName: 'tcp-asg', AutoScalingGroupARN: groupArn('tcp-asg'), TargetGroupARNs: [TCP.TargetGroupArn], Tags: [] },
];

const MAIN = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/main`;
export const SERVICES = [
  { serviceArn: serviceArn('main', 'api'), serviceName: 'api', status: 'ACTIVE', schedulingStrategy: 'REPLICA', loadBalancers: [{ targetGroupArn: TGS.api!.TargetGroupArn }], tags: [] },
  { serviceArn: serviceArn('main', 'worker'), serviceName: 'worker', status: 'ACTIVE', schedulingStrategy: 'REPLICA', loadBalancers: [], tags: [{ key: 'team', value: 'jobs' }] },
  { serviceArn: serviceArn('main', 'agent'), serviceName: 'agent', status: 'ACTIVE', schedulingStrategy: 'DAEMON', loadBalancers: [], tags: [] },
  { serviceArn: serviceArn('main', 'old'), serviceName: 'old', status: 'INACTIVE', schedulingStrategy: 'REPLICA', loadBalancers: [], tags: [] },
];

export const DATABASES = [
  { DBInstanceIdentifier: 'shop-db', DBInstanceArn: dbArn('shop-db'), DBInstanceStatus: 'available', TagList: [{ Key: 'env', Value: 'dev' }] },
  { DBInstanceIdentifier: 'replica', DBInstanceArn: dbArn('replica'), DBInstanceStatus: 'available', ReadReplicaSourceDBInstanceIdentifier: 'shop-db', TagList: [] },
  { DBInstanceIdentifier: 'aurora-1', DBInstanceArn: dbArn('aurora-1'), DBInstanceStatus: 'available', DBClusterIdentifier: 'aurora', TagList: [] },
  { DBInstanceIdentifier: 'companion-db', DBInstanceArn: dbArn('companion-db'), DBInstanceStatus: 'available', TagList: [{ Key: 'dormeto:workload', Value: 'demo' }] },
];
export const CLUSTERS = [
  { DBClusterIdentifier: 'aurora', DBClusterArn: clusterArn('aurora'), Status: 'available', EngineMode: 'provisioned', TagList: [] },
  { DBClusterIdentifier: 'serverless', DBClusterArn: clusterArn('serverless'), Status: 'available', EngineMode: 'serverless', TagList: [] },
];

// A page of `size` items, with the token of the next.
const page = <T>(items: T[], key: string, token: string | undefined, out: string, size = 2) => {
  const start = Number(token ?? 0);
  return { [key]: items.slice(start, start + size), ...(start + size < items.length ? { [out]: String(start + size) } : {}) };
};
const denied = (action: string) => Object.assign(new Error(`User: arn:aws:sts::${ACCOUNT}:assumed-role/DmtDiscoveryRole/dmt-dev-discovery is not authorized to perform: ${action} on resource: *`), { name: 'AccessDenied' });

// deny: the actions the discovery role may not call (a role applied before the standalone scan: the RDS ones).
export function standalonePorts({ deny = [] as string[] } = {}) {
  const { ports: base } = scanPorts();
  const calls: string[] = [];
  const ports: ScanPorts = {
    ...base,
    elbv2: {
      ...base.elbv2,
      async describeTargetGroups(input) {
        // The fake's pages, then the network load balancer's target group on a page of its own.
        if (input.Marker === 'tcp') return { TargetGroups: [TCP] };
        const out = await base.elbv2.describeTargetGroups(input);
        return { TargetGroups: out.TargetGroups ?? [], NextMarker: out.NextMarker ?? 'tcp' };
      },
      async describeTargetHealth(input) {
        if (input.TargetGroupArn === TCP.TargetGroupArn) return { TargetHealthDescriptions: [{ Target: { Id: 'i-nlb' } }] };
        return base.elbv2.describeTargetHealth(input);
      },
    },
    // The standalone candidates' signals (5-minute points) have no data; the HTTP idle share is the base fake's.
    cloudwatch: {
      async getMetricData(input) {
        if (input.MetricDataQueries.every((q) => q.MetricStat.Period === 300)) return { MetricDataResults: [] };
        return base.cloudwatch!.getMetricData(input);
      },
    },
    autoscaling: {
      async describeAutoScalingGroups(input) {
        const names = (input as { AutoScalingGroupNames?: string[] }).AutoScalingGroupNames;
        return page(names ? GROUPS.filter((g) => names.includes(g.AutoScalingGroupName)) : GROUPS, 'AutoScalingGroups', input.NextToken, 'NextToken');
      },
    },
    ec2: {
      async describeInstances(input) {
        if (deny.includes('ec2:DescribeInstances')) throw denied('ec2:DescribeInstances');
        const found = input.InstanceIds ? INSTANCES.filter((i) => input.InstanceIds!.includes(i.InstanceId)) : INSTANCES;
        const { Instances, NextToken } = page(found, 'Instances', input.NextToken, 'NextToken', 4) as { Instances: typeof INSTANCES; NextToken?: string };
        return { Reservations: [{ Instances }], ...(NextToken ? { NextToken } : {}) };
      },
    },
    ecs: {
      async listClusters() { return { clusterArns: [MAIN] }; },
      async listServices(input) { return page(input.cluster === MAIN ? SERVICES.map((s) => s.serviceArn) : [], 'serviceArns', input.nextToken, 'nextToken'); },
      async describeServices(input) {
        // A role that may describe services but not with their tags (to be checked live: the review's question).
        if (deny.includes('ecs:DescribeServices with tags') && (input as { include?: string[] }).include?.includes('TAGS')) throw denied('ecs:ListTagsForResource');
        return { services: SERVICES.filter((s) => input.services.includes(s.serviceArn)).map(({ tags, ...s }) => ({ ...s, ...((input as { include?: string[] }).include?.includes('TAGS') ? { tags } : {}) })) };
      },
    },
    rds: {
      async describeDBInstances(input) {
        if (deny.includes('rds:DescribeDBInstances')) throw denied('rds:DescribeDBInstances');
        const id = (input as { DBInstanceIdentifier?: string }).DBInstanceIdentifier;
        const found = id ? DATABASES.filter((d) => d.DBInstanceIdentifier === id) : DATABASES;
        return page(found, 'DBInstances', input.Marker, 'Marker');
      },
      async describeDBClusters(input) {
        if (deny.includes('rds:DescribeDBClusters')) throw denied('rds:DescribeDBClusters');
        const id = (input as { DBClusterIdentifier?: string }).DBClusterIdentifier;
        const found = id ? CLUSTERS.filter((d) => d.DBClusterIdentifier === id) : CLUSTERS;
        return page(found, 'DBClusters', input.Marker, 'Marker');
      },
    },
  };
  return { ports: recorded(ports, calls), calls };
}

// Every call of the ports, as `<port>.<method> <input>`.
export function recorded(ports: ScanPorts, calls: string[]): ScanPorts {
  const wrap = (name: string, port: Record<string, (input: unknown) => Promise<unknown>>) => Object.fromEntries(Object.entries(port).map(([method, call]) => [method, (input: unknown) => {
    calls.push(`${name}.${method} ${JSON.stringify(input)}`);
    return call(input);
  }]));
  return Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, name === 'kubernetes' ? port : wrap(name, port as never)])) as unknown as ScanPorts;
}
