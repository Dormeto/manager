// AWS SDK adapters: scan ports with an account's discovery credentials, AssumeRole, enabled regions, Organizations.
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { CloudTrailClient, DescribeTrailsCommand, GetEventSelectorsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeServicesCommand, ECSClient, ListClustersCommand, ListServicesCommand } from '@aws-sdk/client-ecs';
import { DescribeClusterCommand, EKSClient, ListClustersCommand as ListEksClustersCommand } from '@aws-sdk/client-eks';
import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ListAccountsForParentCommand, ListOrganizationalUnitsForParentCommand, ListRootsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-organizations';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { KubernetesPorts } from './kubernetes.js';
import type { OrganizationsPort } from './org.js';
import type { ScanPorts } from './scan.js';
// @ts-expect-error the router's module has no type declarations
import { kubernetesConnector } from '../../../../router/lambda/src/lib/k8s.mjs';

// Any SDK client: only send() is used (fakes in tests).
export interface Sender {
  send(command: any): Promise<any>;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export function scanPorts(c: { elbv2: Sender; autoscaling: Sender; ecs: Sender; cloudwatch: Sender }): ScanPorts {
  return {
    elbv2: {
      describeLoadBalancers: (input) => c.elbv2.send(new DescribeLoadBalancersCommand(input)),
      describeListeners: (input) => c.elbv2.send(new DescribeListenersCommand(input)),
      describeRules: (input) => c.elbv2.send(new DescribeRulesCommand(input)),
      describeTags: (input) => c.elbv2.send(new DescribeTagsCommand(input)),
      describeTargetGroups: (input) => c.elbv2.send(new DescribeTargetGroupsCommand(input)),
      describeTargetHealth: (input) => c.elbv2.send(new DescribeTargetHealthCommand(input)),
    },
    autoscaling: { describeAutoScalingGroups: (input) => c.autoscaling.send(new DescribeAutoScalingGroupsCommand(input)) },
    ecs: {
      listClusters: (input) => c.ecs.send(new ListClustersCommand(input)),
      listServices: (input) => c.ecs.send(new ListServicesCommand(input)),
      describeServices: (input) => c.ecs.send(new DescribeServicesCommand(input)),
    },
    cloudwatch: { getMetricData: (input) => c.cloudwatch.send(new GetMetricDataCommand(input)) },
  };
}

// The region's EKS clusters (Kubernetes workloads, R10.5): listed and described with the discovery role; their API called
// with an EKS token signed with the same credentials (the router's client: the role's access entry, AmazonEKSViewPolicy).
// credentials: static, or a provider (the estimate's profile); reader: who reads, in the reason of a cluster it cannot read.
export function kubernetesPorts(credentials: Credentials | (() => Promise<Credentials>), region: string, client: Sender = new EKSClient({ region, credentials, maxAttempts: 5 }), reader?: string): KubernetesPorts {
  const describeCluster = (input: { name: string }) => client.send(new DescribeClusterCommand(input));
  const resolved = async () => (typeof credentials === 'function' ? credentials() : credentials);
  return {
    eks: { listClusters: (input) => client.send(new ListEksClustersCommand(input)), describeCluster },
    kubernetesOf: kubernetesConnector({ eks: { describeCluster, credentials: resolved }, region }),
    ...(reader ? { reader } : {}),
  };
}

// SDK clients of one account and region (credentials of its discovery role).
export function regionalClients(credentials: Credentials, region: string) {
  const config = { region, credentials, maxAttempts: 5 };
  return {
    elbv2: new ElasticLoadBalancingV2Client(config),
    autoscaling: new AutoScalingClient(config),
    ecs: new ECSClient(config),
    cloudwatch: new CloudWatchClient(config),
  };
}

export function createAssumeRole({ sts, roleName, sessionName, partition = 'aws' }: { sts: Sender; roleName: string; sessionName: string; partition?: string }) {
  return async (account: string): Promise<Credentials> => {
    const { Credentials: c } = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:${partition}:iam::${account}:role/${roleName}`, RoleSessionName: sessionName, DurationSeconds: 3600 }));
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  };
}

// Regions enabled in the account (opt-in regions only once opted in).
export async function enabledRegionsOf(ec2: Sender): Promise<string[]> {
  const { Regions = [] } = await ec2.send(new DescribeRegionsCommand({}));
  return (Regions as { RegionName?: string }[]).map((r) => r.RegionName ?? '').filter(Boolean);
}

export const ec2For = (credentials: Credentials, region: string): Sender => new EC2Client({ region, credentials });

export function organizationsPort(client: Sender): OrganizationsPort {
  return {
    listRoots: (input) => client.send(new ListRootsCommand(input)),
    listOrganizationalUnitsForParent: (input) => client.send(new ListOrganizationalUnitsForParentCommand(input)),
    listAccountsForParent: (input) => client.send(new ListAccountsForParentCommand(input)),
    listTagsForResource: (input) => client.send(new ListTagsForResourceCommand(input)),
  };
}

// The command role's check (packaging design §3): the access check function assumes it (it runs as the operations role,
// which the command role trusts); its refusal comes back as the error it got. A check that does not answer (the function
// throttled, missing or failing) is no verdict on the role: `unavailable`, and the account keeps its last check.
export function commandCheck(invoke: (payload: Record<string, unknown>) => Promise<unknown>) {
  return async (account: string): Promise<void> => {
    let answer: { ok?: boolean; name?: string; message?: string } | null;
    try {
      answer = (await invoke({ account })) as typeof answer;
    } catch (err) {
      throw Object.assign(err as Error, { unavailable: true });
    }
    if (answer?.ok === true) return;
    if (answer?.ok === false && answer.name && answer.name !== 'InvalidInput') throw Object.assign(new Error(answer.message ?? ''), { name: answer.name });
    throw Object.assign(new Error(`the access check answered ${JSON.stringify(answer)?.slice(0, 200)}`), { name: 'CheckUnavailable', unavailable: true });
  };
}

// CloudTrail of an account and region (packaging design §5): whether a trail logs the management writes there, so that the
// load balancer changes reach the forwarder. Trails of other regions apply when multi-region; the organization trail of
// the management account counts even when a member account cannot read its status (it logs management events).
export interface TrailsPort {
  describeTrails(input: { includeShadowTrails: boolean }): Promise<{ trailList?: { TrailARN?: string; HomeRegion?: string; IsMultiRegionTrail?: boolean; IsOrganizationTrail?: boolean }[] }>;
  getTrailStatus(input: { Name: string }): Promise<{ IsLogging?: boolean }>;
  getEventSelectors(input: { TrailName: string }): Promise<{
    EventSelectors?: { ReadWriteType?: string; IncludeManagementEvents?: boolean }[];
    AdvancedEventSelectors?: { FieldSelectors?: { Field?: string; Equals?: string[] }[] }[];
  }>;
}

const managementWrites = (s: Awaited<ReturnType<TrailsPort['getEventSelectors']>>) => {
  if (s.AdvancedEventSelectors?.length) {
    return s.AdvancedEventSelectors.some((a) => {
      const field = (name: string) => a.FieldSelectors?.find((f) => f.Field === name)?.Equals ?? [];
      return field('eventCategory').includes('Management') && !(field('readOnly').length === 1 && field('readOnly')[0] === 'true');
    });
  }
  // Without selectors, a trail logs every management event.
  if (!s.EventSelectors?.length) return true;
  return s.EventSelectors.some((e) => e.IncludeManagementEvents !== false && (e.ReadWriteType ?? 'All') !== 'ReadOnly');
};

export async function trailCovers(cloudtrail: TrailsPort, region: string): Promise<boolean> {
  for (const t of (await cloudtrail.describeTrails({ includeShadowTrails: true })).trailList ?? []) {
    if (!t.TrailARN || !(t.IsMultiRegionTrail || t.HomeRegion === region)) continue;
    try {
      if (!(await cloudtrail.getTrailStatus({ Name: t.TrailARN })).IsLogging) continue;
      if (managementWrites(await cloudtrail.getEventSelectors({ TrailName: t.TrailARN }))) return true;
    } catch (err) {
      if (t.IsOrganizationTrail && /AccessDenied|not authorized/i.test(`${(err as Error).name} ${(err as Error).message}`)) return true;
      throw err;
    }
  }
  return false;
}

// The CloudTrail calls of trailCovers, with an account's discovery role credentials in a region.
export function trailsPort(credentials: Credentials, region: string): TrailsPort {
  const client = new CloudTrailClient({ region, credentials, maxAttempts: 5 });
  return {
    describeTrails: (input) => client.send(new DescribeTrailsCommand(input)),
    getTrailStatus: (input) => client.send(new GetTrailStatusCommand(input)),
    getEventSelectors: (input) => client.send(new GetEventSelectorsCommand(input)),
  } as TrailsPort;
}

// Whether the account's discovery role declares the account set up for discovery only (the access module with
// create_command_role = false, or the AWS CLI script without a command role, tag it dormeto:command-role = none).
export async function discoveryOnlyOf(credentials: Credentials, roleName: string): Promise<boolean> {
  const iam = new IAMClient({ region: 'us-east-1', credentials, maxAttempts: 3 });
  const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName.split('/').at(-1)! }));
  return (Role?.Tags ?? []).some((t) => t.Key === 'dormeto:command-role' && t.Value === 'none');
}
