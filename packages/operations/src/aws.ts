// AWS SDK adapters of the operations Lambda: the installer ports, the Kubernetes proxies' ports and the router invocations
// in a target account and region, through DmtCommandRole, and the router bundle from the artifacts bucket.
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, DescribeLogGroupsCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateTableCommand, DeleteTableCommand, DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, UpdateContinuousBackupsCommand, UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import {
  AuthorizeSecurityGroupEgressCommand, AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand, DeleteSecurityGroupCommand, DescribeNetworkInterfacesCommand, DescribeSecurityGroupsCommand,
  DescribeVpcsCommand, EC2Client, RevokeSecurityGroupEgressCommand, RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import {
  CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, GetRoleCommand, GetRolePolicyCommand, IAMClient, ListRolePoliciesCommand, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  AddPermissionCommand, CreateEventSourceMappingCommand, CreateFunctionCommand, RemovePermissionCommand, DeleteEventSourceMappingCommand, DeleteFunctionCommand, GetFunctionCommand,
  GetFunctionConfigurationCommand, GetFunctionEventInvokeConfigCommand, GetPolicyCommand, InvokeCommand, LambdaClient, ListEventSourceMappingsCommand, PutFunctionEventInvokeConfigCommand, UpdateEventSourceMappingCommand,
  UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  AssociateAccessPolicyCommand, CreateAccessEntryCommand, DeleteAccessEntryCommand, DescribeAccessEntryCommand, DescribeClusterCommand, EKSClient, ListAssociatedAccessPoliciesCommand, ListClustersCommand,
} from '@aws-sdk/client-eks';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DeleteRuleCommand, DescribeRuleCommand, EventBridgeClient, ListTargetsByRuleCommand, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'node:crypto';
import type { Blueprint } from './blueprint.js';
import type { EksPort } from './cluster-access.js';
import type { TargetAccess } from './engine.js';
import { createInstaller, type InstallerPorts } from './installer.js';
import type { KubeProxyPorts } from './kube-proxies.js';

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date };
type Send = { send(command: any): Promise<any> };
const port = <K extends string>(client: Send, commands: Record<K, new (input: any) => any>) =>
  Object.fromEntries(Object.entries(commands).map(([name, Command]) => [name, (input: unknown) => client.send(new (Command as new (i: unknown) => unknown)(input))])) as Record<K, (input: any) => Promise<any>>;

export function installerPorts(credentials: Credentials, region: string): InstallerPorts {
  const opts = { region, credentials, retryMode: 'adaptive' as const, maxAttempts: 6 };
  return {
    iam: port(new IAMClient({ ...opts, region: 'us-east-1' }), {
      getRole: GetRoleCommand, createRole: CreateRoleCommand, updateAssumeRolePolicy: UpdateAssumeRolePolicyCommand, getRolePolicy: GetRolePolicyCommand,
      putRolePolicy: PutRolePolicyCommand, listRolePolicies: ListRolePoliciesCommand, deleteRolePolicy: DeleteRolePolicyCommand, deleteRole: DeleteRoleCommand,
    }),
    dynamodb: port(new DynamoDBClient(opts), {
      describeTable: DescribeTableCommand, createTable: CreateTableCommand, describeTimeToLive: DescribeTimeToLiveCommand, updateTimeToLive: UpdateTimeToLiveCommand,
      describeContinuousBackups: DescribeContinuousBackupsCommand, updateContinuousBackups: UpdateContinuousBackupsCommand, deleteTable: DeleteTableCommand,
    }),
    sqs: port(new SQSClient(opts), {
      getQueueUrl: GetQueueUrlCommand, createQueue: CreateQueueCommand, getQueueAttributes: GetQueueAttributesCommand, setQueueAttributes: SetQueueAttributesCommand, deleteQueue: DeleteQueueCommand,
    }),
    logs: port(new CloudWatchLogsClient(opts), {
      describeLogGroups: DescribeLogGroupsCommand, createLogGroup: CreateLogGroupCommand, putRetentionPolicy: PutRetentionPolicyCommand, deleteLogGroup: DeleteLogGroupCommand,
    }),
    lambda: port(new LambdaClient(opts), {
      getFunction: GetFunctionCommand, createFunction: CreateFunctionCommand, updateFunctionConfiguration: UpdateFunctionConfigurationCommand, updateFunctionCode: UpdateFunctionCodeCommand,
      getFunctionEventInvokeConfig: GetFunctionEventInvokeConfigCommand, putFunctionEventInvokeConfig: PutFunctionEventInvokeConfigCommand, getPolicy: GetPolicyCommand,
      addPermission: AddPermissionCommand, removePermission: RemovePermissionCommand, deleteFunction: DeleteFunctionCommand,
      listEventSourceMappings: ListEventSourceMappingsCommand, createEventSourceMapping: CreateEventSourceMappingCommand,
      updateEventSourceMapping: UpdateEventSourceMappingCommand, deleteEventSourceMapping: DeleteEventSourceMappingCommand,
    }),
    scheduler: port(new SchedulerClient(opts), { getSchedule: GetScheduleCommand, createSchedule: CreateScheduleCommand, updateSchedule: UpdateScheduleCommand, deleteSchedule: DeleteScheduleCommand }),
    events: port(new EventBridgeClient(opts), {
      describeRule: DescribeRuleCommand, putRule: PutRuleCommand, listTargetsByRule: ListTargetsByRuleCommand, putTargets: PutTargetsCommand,
      removeTargets: RemoveTargetsCommand, deleteRule: DeleteRuleCommand,
    }),
  };
}

// The EKS calls of the access entries step (cluster-access.ts), with the command role's credentials in a region.
export function eksPort(credentials: Credentials, region: string): EksPort {
  const client = new EKSClient({ region, credentials, maxAttempts: 5 });
  return {
    listClusters: (input) => client.send(new ListClustersCommand(input)),
    describeCluster: (input) => client.send(new DescribeClusterCommand(input)),
    describeAccessEntry: (input) => client.send(new DescribeAccessEntryCommand(input)),
    createAccessEntry: (input) => client.send(new CreateAccessEntryCommand(input)),
    deleteAccessEntry: (input) => client.send(new DeleteAccessEntryCommand(input)),
    listAssociatedAccessPolicies: (input) => client.send(new ListAssociatedAccessPoliciesCommand(input)),
    associateAccessPolicy: (input) => client.send(new AssociateAccessPolicyCommand(input)),
  };
}

// The calls of the Kubernetes proxies step (kube-proxies.ts), through the given clients.
export function kubeProxyClientPorts(clients: Record<'ec2' | 'lambda' | 'iam' | 'logs' | 'eks', Send>): KubeProxyPorts {
  return {
    ec2: port(clients.ec2, {
      describeVpcs: DescribeVpcsCommand, describeSecurityGroups: DescribeSecurityGroupsCommand, createSecurityGroup: CreateSecurityGroupCommand, authorizeSecurityGroupEgress: AuthorizeSecurityGroupEgressCommand,
      revokeSecurityGroupEgress: RevokeSecurityGroupEgressCommand, authorizeSecurityGroupIngress: AuthorizeSecurityGroupIngressCommand, revokeSecurityGroupIngress: RevokeSecurityGroupIngressCommand,
      deleteSecurityGroup: DeleteSecurityGroupCommand, describeNetworkInterfaces: DescribeNetworkInterfacesCommand,
    }),
    lambda: port(clients.lambda, {
      getFunctionConfiguration: GetFunctionConfigurationCommand, createFunction: CreateFunctionCommand, updateFunctionConfiguration: UpdateFunctionConfigurationCommand,
      updateFunctionCode: UpdateFunctionCodeCommand, deleteFunction: DeleteFunctionCommand,
    }),
    iam: port(clients.iam, {
      getRole: GetRoleCommand, createRole: CreateRoleCommand, updateAssumeRolePolicy: UpdateAssumeRolePolicyCommand, getRolePolicy: GetRolePolicyCommand,
      putRolePolicy: PutRolePolicyCommand, listRolePolicies: ListRolePoliciesCommand, deleteRolePolicy: DeleteRolePolicyCommand, deleteRole: DeleteRoleCommand,
    }),
    logs: port(clients.logs, { describeLogGroups: DescribeLogGroupsCommand, createLogGroup: CreateLogGroupCommand, putRetentionPolicy: PutRetentionPolicyCommand, deleteLogGroup: DeleteLogGroupCommand }),
    eks: port(clients.eks, { listClusters: ListClustersCommand, describeCluster: DescribeClusterCommand }),
  };
}

// The same with the command role's credentials in a region.
export function kubeProxyPorts(credentials: Credentials, region: string): KubeProxyPorts {
  const opts = { region, credentials, retryMode: 'adaptive' as const, maxAttempts: 6 };
  return kubeProxyClientPorts({
    ec2: new EC2Client(opts), lambda: new LambdaClient(opts), iam: new IAMClient({ ...opts, region: 'us-east-1' }), logs: new CloudWatchLogsClient(opts), eks: new EKSClient({ region, credentials, maxAttempts: 5 }),
  });
}

// DmtCommandRole of the target account; credentials cached until 5 minutes before they expire.
export function createTargets({ sts, roleName, sessionName }: { sts: STSClient; roleName: string; sessionName: string }) {
  const cache = new Map<string, Credentials>();
  async function credentialsFor(account: string): Promise<Credentials> {
    const cached = cache.get(account);
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > 5 * 60_000) return cached;
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${account}:role/${roleName}`, RoleSessionName: sessionName, DurationSeconds: 3600 }));
    const c = out.Credentials!;
    const credentials = { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken!, expiration: c.Expiration };
    cache.set(account, credentials);
    return credentials;
  }
  return async function target(account: string, region: string): Promise<TargetAccess> {
    const credentials = await credentialsFor(account);
    const lambda = new LambdaClient({ region, credentials });
    return {
      eks: eksPort(credentials, region),
      // Made when a step asks for them (the cluster steps only).
      get kubeProxies() { return kubeProxyPorts(credentials, region); },
      installer: (options) => createInstaller(installerPorts(credentials, region), options),
      async invoke(functionArn, payload) {
        const out = await lambda.send(new InvokeCommand({ FunctionName: functionArn, Payload: Buffer.from(JSON.stringify(payload)) }));
        const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : 'null';
        if (out.FunctionError) throw new Error((JSON.parse(text) as { errorMessage?: string }).errorMessage ?? out.FunctionError);
        return JSON.parse(text);
      },
    };
  };
}

// The command role assumed afresh (never from the cache: a role deleted since shows at once), only to check it: discovery
// asks, since the role trusts the operations Lambda only (packaging design §3).
export function checkRole({ sts, roleName, sessionName }: { sts: Pick<STSClient, 'send'>; roleName: string; sessionName: string }) {
  return async (account: string): Promise<{ ok: true } | { ok: false; name: string; message: string }> => {
    try {
      await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${account}:role/${roleName}`, RoleSessionName: sessionName, DurationSeconds: 900 }));
      return { ok: true };
    } catch (err) {
      return { ok: false, name: (err as Error).name ?? 'Error', message: (err as Error).message ?? String(err) };
    }
  };
}

// The access check function (packaging design §3): an account id, nothing else, then the check. Discovery may invoke this
// function only, never the operations function (which could run any operation under the command role).
export function checkHandler(check: (account: string) => Promise<{ ok: true } | { ok: false; name: string; message: string }>) {
  return async (event: { account?: unknown }) => {
    if (typeof event?.account !== 'string' || !/^\d{12}$/.test(event.account)) return { ok: false as const, name: 'InvalidInput', message: 'account must be 12 digits' };
    return check(event.account);
  };
}

// The router bundle of the manager's router version: router/<version>/blueprint.json and router.zip, cached.
export function createBundle({ s3, bucket, version }: { s3: S3Client; bucket: string; version: string }) {
  let cached: { blueprint: Blueprint; zip: Uint8Array; codeSha256: string } | undefined;
  return async () => {
    if (cached) return cached;
    const read = async (key: string) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `router/${version}/${key}` }))).Body!.transformToByteArray();
    const [blueprint, zip] = await Promise.all([read('blueprint.json'), read('router.zip')]);
    cached = { blueprint: JSON.parse(Buffer.from(blueprint).toString('utf8')) as Blueprint, zip, codeSha256: createHash('sha256').update(zip).digest('base64') };
    return cached;
  };
}
