// The standalone scan of one account and region (vision standalone workloads design §6): the EC2 instances, Auto Scaling
// groups, ECS services, RDS instances and clusters that no route uses, each a candidate of its own resource, eligible or
// ineligible with the router's reasons, or managed when the router tagged it as a standalone workload's resource.
// The texts and the workload id are the router's (router lambda/src/lib/onboarding.mjs resourceOf, workloadIdOf); a test
// runs the router's onboarding preview on the same answers.
import { createHash } from 'node:crypto';
import { all, type AutoScalingGroup, type DbCluster, type DbInstance, type Instance, type ScanPorts, type Service, type Tag, type TargetGroup } from './scan.js';
import type { ResourceKind, StandaloneRule } from './types.js';
import { RESOURCE_KIND_TEXT } from '@dormeto/fleet/idle-signals';

const WORKLOAD_TAG = 'dormeto:workload';
const GROUP_TAG = 'aws:autoscaling:groupName';
// The tags EKS, its node groups, eksctl, Karpenter and the cluster autoscaler put on a cluster's nodes (the router's).
const EKS_NODE_TAG = /^(eks:cluster-name|eks:nodegroup-name|alpha\.eksctl\.io\/cluster-name|karpenter\.sh\/|kubernetes\.io\/cluster\/|k8s\.io\/cluster-autoscaler\/)/;
const KIND_TEXT = RESOURCE_KIND_TEXT as Record<ResourceKind, string>;
const AGAIN = 'apply the access module or the AWS CLI script of this release again';

// The router's workload id of a resource: the first 16 hex characters of the SHA-256 of its ARN.
export const workloadIdOf = (arn: string) => createHash('sha256').update(arn).digest('hex').slice(0, 16);

// What the scan could not read: a sentence each for the run's problems, and the kinds whose stored candidates stay as they
// were (a kind without its port, as the estimate's scan, is unread without a problem).
export interface StandaloneReport { problems: string[]; unread: ResourceKind[] }

const tagsOf = (list: Tag[] = []): Record<string, string> => Object.fromEntries(list.map((t) => [t.Key ?? '', t.Value ?? '']));
const targetGroupName = (arn: string) => arn.split(':').at(-1)!.split('/')[1] ?? arn;
const partitionOf = (region: string) => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');
export const refused = (err: unknown) => /AccessDenied|UnauthorizedOperation|not authorized/i.test(`${(err as Error).name} ${(err as Error).message}`);
const isNode = (tags: Record<string, string>) => Object.keys(tags).some((k) => EKS_NODE_TAG.test(k));
const feeds = (label: string, arns: string[]) => arns.map((arn) => `${label} feeds target group ${targetGroupName(arn)}: it belongs to an HTTP workload (onboard its target group)`);

// A resource as read: what it is, its tags, and why the router would refuse it (in the router's order).
interface Resource { kind: ResourceKind; id: string; arn: string; name: string; tags: Record<string, string>; problems: string[] }
type Outcome = 'managed' | 'listed' | 'out';

export async function standaloneRules(ports: ScanPorts, where: { account: string; region: string }, read: {
  targetGroups: TargetGroup[]; // every target group of the region
  routed: Set<string>; // the target groups an application load balancer's rule forwards to: their backends are HTTP candidates'
  groups: AutoScalingGroup[];
  services: Service[]; // described with their tags
}): Promise<{ rules: StandaloneRule[] } & StandaloneReport> {
  const problems: string[] = [];
  const unread: ResourceKind[] = [];
  // A list the discovery role may not read: said, and its kind left as it was; any other failure fails the region.
  const listed = async <T>(kind: ResourceKind, what: string, action: string, list: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await list();
    } catch (err) {
      if (!refused(err)) throw err;
      problems.push(`${what} not listed: the discovery role may not call ${action} (${AGAIN})`);
      unread.push(kind);
      return [];
    }
  };
  const byKind: Record<ResourceKind, StandaloneRule[]> = { instance: [], asg: [], ecs: [], 'rds-instance': [], 'rds-cluster': [] };
  // Managed: the router's tag of the resource's own workload. Left out: tagged by another workload (its backend or its
  // companion), or `leftOut` (an HTTP candidate's backend, a Kubernetes node, a member of a group left out or managed).
  const settle = (r: Resource, leftOut = false): Outcome => {
    const tagged = r.tags[WORKLOAD_TAG];
    const own = tagged !== undefined && tagged === workloadIdOf(r.arn);
    if (!own && (leftOut || tagged !== undefined)) return 'out';
    byKind[r.kind].push({
      kind: 'standalone', id: r.arn, account: where.account, region: where.region, resourceArn: r.arn, name: r.name,
      backend: { kind: r.kind, id: r.id, arn: r.arn },
      tags: Object.fromEntries(Object.entries(r.tags).map(([k, v]) => [k, [v]])),
      ...(own ? { eligibility: 'managed' as const, workloadId: tagged } : { eligibility: r.problems.length ? 'ineligible' as const : 'eligible' as const }),
      ...(r.problems.length ? { reason: r.problems.join('; ') } : {}),
      idleHours7d: null,
    });
    return own ? 'managed' : 'listed';
  };
  const routed = (arns: string[]) => arns.some((arn) => read.routed.has(arn));

  // Groups before their instances: an instance of a group left out or managed is left out with it.
  const groups = new Map<string, Outcome>();
  for (const g of read.groups) {
    if (!g.AutoScalingGroupName || !g.AutoScalingGroupARN) continue;
    const label = `${KIND_TEXT.asg} ${g.AutoScalingGroupName}`;
    const tags = tagsOf(g.Tags);
    const tgs = g.TargetGroupARNs ?? [];
    groups.set(g.AutoScalingGroupName, settle({
      kind: 'asg', id: g.AutoScalingGroupName, arn: g.AutoScalingGroupARN, name: g.AutoScalingGroupName, tags,
      problems: [...feeds(label, tgs), ...(isNode(tags) ? [`${label} holds EKS nodes: onboard the Kubernetes workloads that run on them`] : [])],
    }, routed(tgs)));
  }

  // The instances, and the instance target groups each one is registered in (the router reads every one, in their order).
  if (ports.ec2) {
    const ec2 = ports.ec2;
    const targets = new Map<string, string[]>();
    const instances = await listed('instance', 'EC2 instances', 'ec2:DescribeInstances', async () => {
      const found: Instance[] = [];
      let token: string | undefined;
      do {
        const page = await ec2.describeInstances(token ? { NextToken: token } : {});
        found.push(...(page.Reservations ?? []).flatMap((r) => r.Instances ?? []));
        token = page.NextToken;
      } while (token);
      return found;
    });
    if (instances.length) {
      for (const g of read.targetGroups.filter((t) => t.TargetType === 'instance' && t.TargetGroupArn)) {
        const { TargetHealthDescriptions = [] } = await ports.elbv2.describeTargetHealth({ TargetGroupArn: g.TargetGroupArn! });
        for (const d of TargetHealthDescriptions) if (d.Target?.Id) targets.set(d.Target.Id, [...(targets.get(d.Target.Id) ?? []), g.TargetGroupArn!]);
      }
    }
    for (const i of instances) {
      if (!i.InstanceId || ['terminated', 'shutting-down'].includes(i.State?.Name ?? '')) continue;
      const tags = tagsOf(i.Tags);
      const label = `${KIND_TEXT.instance} ${i.InstanceId}`;
      const group = tags[GROUP_TAG];
      const tgs = targets.get(i.InstanceId) ?? [];
      const parent = group ? groups.get(group) : undefined;
      settle({
        kind: 'instance', id: i.InstanceId, arn: `arn:${partitionOf(where.region)}:ec2:${where.region}:${where.account}:instance/${i.InstanceId}`, name: tags.Name || i.InstanceId, tags,
        problems: [
          ...(group ? [`${label} is in Auto Scaling group ${group}: onboard the group (it would replace a stopped instance)`] : []),
          ...(i.RootDeviceType === 'instance-store' ? [`${label} has an instance store root volume: it cannot be stopped`] : []),
          ...(i.InstanceLifecycle === 'spot' ? [`${label} is a Spot instance: Dormeto stops On-Demand instances only`] : []),
          ...(group ? [] : feeds(label, tgs)),
        ],
      }, isNode(tags) || routed(tgs) || parent === 'out' || parent === 'managed');
    }
  } else unread.push('instance');

  for (const s of read.services) {
    if (!s.serviceArn || s.status === 'INACTIVE') continue;
    const id = s.serviceArn.split(':service/')[1] ?? s.serviceArn;
    const label = `${KIND_TEXT.ecs} ${id}`;
    const tgs = (s.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter((arn): arn is string => Boolean(arn));
    settle({
      kind: 'ecs', id: s.serviceArn, arn: s.serviceArn, name: id.split('/').at(-1)!, tags: Object.fromEntries((s.tags ?? []).map((t) => [t.key ?? '', t.value ?? ''])),
      problems: [...feeds(label, tgs), ...(s.schedulingStrategy === 'DAEMON' ? [`${label} uses the daemon scheduling strategy: it has no desired count to set to 0`] : [])],
    }, routed(tgs));
  }

  // Clusters before their members: a member of a cluster left out or managed is left out with it.
  if (ports.rds) {
    const rds = ports.rds;
    const databases = await listed('rds-instance', 'RDS instances', 'rds:DescribeDBInstances', () => all<DbInstance>((i) => rds.describeDBInstances(i), 'DBInstances', { in: 'Marker', out: 'Marker' }));
    const clusters = await listed('rds-cluster', 'RDS clusters', 'rds:DescribeDBClusters', () => all<DbCluster>((i) => rds.describeDBClusters(i), 'DBClusters', { in: 'Marker', out: 'Marker' }));
    const clusterOf = new Map<string, Outcome>();
    for (const c of clusters) {
      if (!c.DBClusterIdentifier || !c.DBClusterArn) continue;
      const label = `${KIND_TEXT['rds-cluster']} ${c.DBClusterIdentifier}`;
      clusterOf.set(c.DBClusterIdentifier, settle({
        kind: 'rds-cluster', id: c.DBClusterIdentifier, arn: c.DBClusterArn, name: c.DBClusterIdentifier, tags: tagsOf(c.TagList),
        problems: c.EngineMode === 'serverless' ? [`${label} is Aurora Serverless v1: it cannot be stopped`] : [],
      }));
    }
    for (const d of databases) {
      if (!d.DBInstanceIdentifier || !d.DBInstanceArn) continue;
      const label = `${KIND_TEXT['rds-instance']} ${d.DBInstanceIdentifier}`;
      const parent = d.DBClusterIdentifier ? clusterOf.get(d.DBClusterIdentifier) : undefined;
      settle({
        kind: 'rds-instance', id: d.DBInstanceIdentifier, arn: d.DBInstanceArn, name: d.DBInstanceIdentifier, tags: tagsOf(d.TagList),
        problems: [
          ...(d.DBClusterIdentifier ? [`${label} is a member of Aurora cluster ${d.DBClusterIdentifier}: onboard the cluster`] : []),
          ...(d.ReadReplicaSourceDBInstanceIdentifier ? [`${label} is a read replica: it cannot be stopped`] : []),
        ],
      }, parent === 'out' || parent === 'managed');
    }
  } else unread.push('rds-instance', 'rds-cluster');

  const rules = [...byKind.instance, ...byKind.asg, ...byKind.ecs, ...byKind['rds-instance'], ...byKind['rds-cluster']];
  return { rules, problems, unread };
}
