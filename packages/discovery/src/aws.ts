// AWS SDK adapters: scan ports with an account's discovery credentials, AssumeRole, enabled regions, Organizations.
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeServicesCommand, ECSClient, ListClustersCommand, ListServicesCommand } from '@aws-sdk/client-ecs';
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
import type { OrganizationsPort } from './org.js';
import type { ScanPorts } from './scan.js';

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
