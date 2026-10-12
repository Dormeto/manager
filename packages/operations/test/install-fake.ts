// An in-memory AWS account and region for the installer: IAM, DynamoDB, SQS, CloudWatch Logs, Lambda and EventBridge
// Scheduler, with their not-found errors, a table that is CREATING once, a new role Lambda cannot assume at first, and a
// function update in progress once.
import { createHash } from 'node:crypto';
import type { InstallerPorts } from '../src/installer.js';

const error = (name: string, message = name) => Object.assign(new Error(message), { name });

export function fakeInstallAccount() {
  const state = {
    roles: new Map<string, { path?: string; trust: string; boundary?: string; tags: Record<string, string>; policies: Map<string, string> }>(),
    tables: new Map<string, { status: string; ttl?: string; pitr: boolean; tags: Record<string, string> }>(),
    queues: new Map<string, { attributes: Record<string, string>; tags: Record<string, string> }>(),
    logGroups: new Map<string, { retention?: number; tags: Record<string, string> }>(),
    functions: new Map<string, { config: Record<string, unknown>; codeSha256: string; updating: boolean; asyncInvoke?: Record<string, unknown>; permissions: Map<string, string> }>(),
    schedules: new Map<string, Record<string, unknown>>(),
    newRoles: new Set<string>(), // roles Lambda cannot assume yet (one failed CreateFunction each)
    calls: [] as string[],
  };
  const call = (name: string) => state.calls.push(name);
  const sha = (zip: Uint8Array) => createHash('sha256').update(zip).digest('base64');
  const ports: InstallerPorts = {
    iam: {
      async getRole({ RoleName }) {
        call('getRole');
        const r = state.roles.get(RoleName);
        if (!r) throw error('NoSuchEntityException');
        return { Role: { RoleName, AssumeRolePolicyDocument: encodeURIComponent(r.trust), ...(r.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: r.boundary } } : {}) } };
      },
      async createRole({ RoleName, Path, AssumeRolePolicyDocument, PermissionsBoundary, Tags = [] }) {
        call('createRole');
        state.roles.set(RoleName, { path: Path, trust: AssumeRolePolicyDocument, boundary: PermissionsBoundary, tags: Object.fromEntries(Tags.map((t: { Key: string; Value: string }) => [t.Key, t.Value])), policies: new Map() });
        state.newRoles.add(RoleName);
        return {};
      },
      async updateAssumeRolePolicy({ RoleName, PolicyDocument }) { call('updateAssumeRolePolicy'); state.roles.get(RoleName)!.trust = PolicyDocument; return {}; },
      async getRolePolicy({ RoleName, PolicyName }) {
        call('getRolePolicy');
        const doc = state.roles.get(RoleName)?.policies.get(PolicyName);
        if (!doc) throw error('NoSuchEntityException');
        return { PolicyDocument: encodeURIComponent(doc) };
      },
      async putRolePolicy({ RoleName, PolicyName, PolicyDocument }) { call('putRolePolicy'); state.roles.get(RoleName)!.policies.set(PolicyName, PolicyDocument); return {}; },
      async listRolePolicies({ RoleName }) {
        call('listRolePolicies');
        const r = state.roles.get(RoleName);
        if (!r) throw error('NoSuchEntityException');
        return { PolicyNames: [...r.policies.keys()] };
      },
      async deleteRolePolicy({ RoleName, PolicyName }) { call('deleteRolePolicy'); state.roles.get(RoleName)!.policies.delete(PolicyName); return {}; },
      async deleteRole({ RoleName }) {
        call('deleteRole');
        if (!state.roles.has(RoleName)) throw error('NoSuchEntityException');
        if (state.roles.get(RoleName)!.policies.size) throw error('DeleteConflictException', 'Cannot delete entity, must delete policies first.');
        state.roles.delete(RoleName);
        return {};
      },
    },
    dynamodb: {
      async describeTable({ TableName }) {
        call('describeTable');
        const t = state.tables.get(TableName);
        if (!t) throw error('ResourceNotFoundException');
        const status = t.status;
        if (t.status === 'CREATING') t.status = 'ACTIVE';
        return { Table: { TableName, TableStatus: status } };
      },
      async createTable({ TableName, Tags = [] }) {
        call('createTable');
        state.tables.set(TableName, { status: 'CREATING', pitr: false, tags: Object.fromEntries(Tags.map((t: { Key: string; Value: string }) => [t.Key, t.Value])) });
        return {};
      },
      async describeTimeToLive({ TableName }) {
        call('describeTimeToLive');
        const ttl = state.tables.get(TableName)!.ttl;
        return { TimeToLiveDescription: ttl ? { TimeToLiveStatus: 'ENABLED', AttributeName: ttl } : { TimeToLiveStatus: 'DISABLED' } };
      },
      async updateTimeToLive({ TableName, TimeToLiveSpecification }) { call('updateTimeToLive'); state.tables.get(TableName)!.ttl = TimeToLiveSpecification.AttributeName; return {}; },
      async describeContinuousBackups({ TableName }) {
        call('describeContinuousBackups');
        return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: state.tables.get(TableName)!.pitr ? 'ENABLED' : 'DISABLED' } } };
      },
      async updateContinuousBackups({ TableName }) { call('updateContinuousBackups'); state.tables.get(TableName)!.pitr = true; return {}; },
      async deleteTable({ TableName }) {
        call('deleteTable');
        if (!state.tables.delete(TableName)) throw error('ResourceNotFoundException');
        return {};
      },
    },
    sqs: {
      async getQueueUrl({ QueueName }) {
        call('getQueueUrl');
        if (!state.queues.has(QueueName)) throw error('QueueDoesNotExist');
        return { QueueUrl: `https://sqs/${QueueName}` };
      },
      async createQueue({ QueueName, Attributes = {}, tags = {} }) { call('createQueue'); state.queues.set(QueueName, { attributes: Attributes, tags }); return { QueueUrl: `https://sqs/${QueueName}` }; },
      async deleteQueue({ QueueUrl }) { call('deleteQueue'); state.queues.delete(QueueUrl.split('/').at(-1)!); return {}; },
    },
    logs: {
      async describeLogGroups({ logGroupNamePrefix }) {
        call('describeLogGroups');
        return { logGroups: [...state.logGroups].filter(([n]) => n.startsWith(logGroupNamePrefix)).map(([logGroupName, g]) => ({ logGroupName, ...(g.retention ? { retentionInDays: g.retention } : {}) })) };
      },
      async createLogGroup({ logGroupName, tags = {} }) { call('createLogGroup'); state.logGroups.set(logGroupName, { tags }); return {}; },
      async putRetentionPolicy({ logGroupName, retentionInDays }) { call('putRetentionPolicy'); state.logGroups.get(logGroupName)!.retention = retentionInDays; return {}; },
      async deleteLogGroup({ logGroupName }) {
        call('deleteLogGroup');
        if (!state.logGroups.delete(logGroupName)) throw error('ResourceNotFoundException');
        return {};
      },
    },
    lambda: {
      async getFunction({ FunctionName }) {
        call('getFunction');
        const f = state.functions.get(FunctionName);
        if (!f) throw error('ResourceNotFoundException');
        const updating = f.updating;
        f.updating = false;
        // Lambda answers the environment variables in its own order, not the order they were sent in.
        const variables = (f.config.Environment as { Variables?: Record<string, string> } | undefined)?.Variables ?? {};
        const reordered = Object.fromEntries(Object.entries(variables).reverse());
        return { Configuration: { ...f.config, Environment: { Variables: reordered }, CodeSha256: f.codeSha256, State: 'Active', LastUpdateStatus: updating ? 'InProgress' : 'Successful' } };
      },
      async createFunction(input) {
        call('createFunction');
        const role = String(input.Role).split('/').at(-1)!;
        if (state.newRoles.delete(role)) throw error('InvalidParameterValueException', 'The role defined for the function cannot be assumed by Lambda.');
        const { Code, Tags: _t, ...config } = input;
        state.functions.set(String(input.FunctionName), { config, codeSha256: sha(Code.ZipFile), updating: false, permissions: new Map() });
        return {};
      },
      async updateFunctionConfiguration(input) {
        call('updateFunctionConfiguration');
        const f = state.functions.get(String(input.FunctionName))!;
        f.config = { ...f.config, ...input };
        f.updating = true;
        return {};
      },
      async updateFunctionCode({ FunctionName, ZipFile }) {
        call('updateFunctionCode');
        const f = state.functions.get(FunctionName)!;
        f.codeSha256 = sha(ZipFile);
        f.updating = true;
        return {};
      },
      async getFunctionEventInvokeConfig({ FunctionName }) {
        call('getFunctionEventInvokeConfig');
        const config = state.functions.get(FunctionName)?.asyncInvoke;
        if (!config) throw error('ResourceNotFoundException');
        return config;
      },
      async putFunctionEventInvokeConfig(input) { call('putFunctionEventInvokeConfig'); state.functions.get(String(input.FunctionName))!.asyncInvoke = input; return {}; },
      async getPolicy({ FunctionName }) {
        call('getPolicy');
        const f = state.functions.get(FunctionName)!;
        if (!f.permissions.size) throw error('ResourceNotFoundException');
        return { Policy: JSON.stringify({ Statement: [...f.permissions].map(([Sid, principal]) => ({ Sid, Principal: { AWS: principal } })) }) };
      },
      async addPermission({ FunctionName, StatementId, Principal }) {
        call('addPermission');
        const f = state.functions.get(FunctionName)!;
        if (f.permissions.has(StatementId)) throw error('ResourceConflictException');
        f.permissions.set(StatementId, Principal);
        return {};
      },
      async deleteFunction({ FunctionName }) {
        call('deleteFunction');
        if (!state.functions.delete(FunctionName)) throw error('ResourceNotFoundException');
        return {};
      },
    },
    scheduler: {
      async getSchedule({ Name }) {
        call('getSchedule');
        const s = state.schedules.get(Name);
        if (!s) throw error('ResourceNotFoundException');
        // EventBridge Scheduler answers defaults that were not sent.
        const target = s.Target as Record<string, any>;
        return { ...s, State: 'ENABLED', Target: { ...target, RetryPolicy: { MaximumEventAgeInSeconds: 86400, ...target.RetryPolicy } } };
      },
      async createSchedule(input) { call('createSchedule'); state.schedules.set(String(input.Name), input); return {}; },
      async updateSchedule(input) { call('updateSchedule'); state.schedules.set(String(input.Name), input); return {}; },
      async deleteSchedule({ Name }) {
        call('deleteSchedule');
        if (!state.schedules.delete(Name)) throw error('ResourceNotFoundException');
        return {};
      },
    },
  };
  return { state, ports };
}
