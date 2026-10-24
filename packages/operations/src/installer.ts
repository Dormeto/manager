// Router installation by AWS API calls (vision docs/specs/2026-10-05-onboarding-design.md, R4b): one step per resource kind,
// each finding what exists before creating or updating it, so that a step can run again; `pending` asks the workflow to
// come back (a table being created, a function being updated), RetryLater to retry after a delay (IAM propagation).
import { createHash } from 'node:crypto';
import type { Blueprint, Forwarder } from './blueprint.js';

// Loose SDK shapes: the adapters (aws.ts) pass the commands' inputs and outputs through.
type Call = (input: any) => Promise<any>;
export interface InstallerPorts {
  iam: Record<'getRole' | 'createRole' | 'updateAssumeRolePolicy' | 'getRolePolicy' | 'putRolePolicy' | 'listRolePolicies' | 'deleteRolePolicy' | 'deleteRole', Call>;
  dynamodb: Record<'describeTable' | 'createTable' | 'describeTimeToLive' | 'updateTimeToLive' | 'describeContinuousBackups' | 'updateContinuousBackups' | 'deleteTable', Call>;
  sqs: Record<'getQueueUrl' | 'createQueue' | 'getQueueAttributes' | 'setQueueAttributes' | 'deleteQueue', Call>;
  logs: Record<'describeLogGroups' | 'createLogGroup' | 'putRetentionPolicy' | 'deleteLogGroup', Call>;
  lambda: Record<'getFunction' | 'createFunction' | 'updateFunctionConfiguration' | 'updateFunctionCode' | 'getFunctionEventInvokeConfig' | 'putFunctionEventInvokeConfig' | 'getPolicy' | 'addPermission' | 'removePermission' | 'deleteFunction'
    | 'listEventSourceMappings' | 'createEventSourceMapping' | 'updateEventSourceMapping' | 'deleteEventSourceMapping', Call>;
  scheduler: Record<'getSchedule' | 'createSchedule' | 'updateSchedule' | 'deleteSchedule', Call>;
  events: Record<'describeRule' | 'putRule' | 'listTargetsByRule' | 'putTargets' | 'removeTargets' | 'deleteRule', Call>;
}

// pending with changed: this call changed something and the step comes back (the workflow records the step as done).
export interface StepResult {
  status: 'done' | 'skipped' | 'pending';
  detail?: string;
  changed?: boolean;
}

// Retry the step after `seconds`: a dependency is not ready yet (IAM propagation).
export class RetryLater extends Error {
  override name = 'RetryLater';
  constructor(message: string, readonly seconds = 10) {
    super(message);
  }
}

// AWS errors that pass: the step waits and runs again (a resource being updated, a throttled API).
export const TRANSIENT = new Set([
  'ContinuousBackupsUnavailableException', 'ResourceInUseException', 'LimitExceededException', 'TooManyRequestsException', 'ThrottlingException', 'Throttling',
  'ResourceConflictException', 'ConcurrentModificationException', 'ServiceUnavailableException', 'InternalFailure',
]);

export const INSTALL_STEPS = ['roles', 'table', 'queues', 'log groups', 'functions', 'async invoke', 'event source mappings', 'permissions', 'event rule', 'schedule'] as const;
export const UNINSTALL_STEPS = ['event rule', 'schedule', 'event source mappings', 'functions', 'queues', 'log groups', 'table', 'roles'] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];
export type UninstallStep = (typeof UNINSTALL_STEPS)[number];

const NOT_FOUND = new Set(['NoSuchEntityException', 'NoSuchEntity', 'ResourceNotFoundException', 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);
const notFound = (err: unknown) => NOT_FOUND.has((err as Error).name);
// What a call answers, null when the resource does not exist (shared with the Kubernetes proxies, kube-proxies.ts).
export async function find<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

// Equal whatever the key order (AWS answers objects in its own order).
const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value);
export const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Every field Dormeto sets has its value in the current resource (AWS adds defaults that were not sent).
const covers = (current: unknown, wanted: unknown): boolean => (wanted && typeof wanted === 'object' && !Array.isArray(wanted)
  ? Boolean(current && typeof current === 'object') && Object.entries(wanted).every(([k, v]) => covers((current as Record<string, unknown>)[k], v))
  : same(current, wanted));
const policyOf = (document: string) => JSON.parse(decodeURIComponent(document)) as unknown;
export const tagList = (tags: Record<string, string>) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const result = (changed: string[]): StepResult => (changed.length ? { status: 'done', detail: changed.join(', ') } : { status: 'skipped' });

// A role with the boundary, its trust and its inline policy: created, or brought in line (what changed added to `changed`).
// Shared with the Kubernetes proxies' roles (kube-proxies.ts).
export type RoleDefinition = { name: string; path: string; trust: unknown; policyName: string; policy: unknown };
export async function putRole(iam: Pick<InstallerPorts['iam'], 'getRole' | 'createRole' | 'updateAssumeRolePolicy' | 'getRolePolicy' | 'putRolePolicy'>, boundaryArn: string, role: RoleDefinition, tags: Record<string, string>, changed: string[]) {
  const existing = (await find(() => iam.getRole({ RoleName: role.name })))?.Role;
  if (!existing) {
    await iam.createRole({ RoleName: role.name, Path: role.path, AssumeRolePolicyDocument: JSON.stringify(role.trust), PermissionsBoundary: boundaryArn, Tags: tagList(tags) });
    changed.push(`role ${role.name}`);
  } else {
    if (existing.PermissionsBoundary?.PermissionsBoundaryArn !== boundaryArn) {
      throw new Error(`role ${role.name} exists without the permissions boundary ${boundaryArn.split('/').at(-1)}: not created by Dormeto`);
    }
    if (!same(policyOf(existing.AssumeRolePolicyDocument), role.trust)) {
      await iam.updateAssumeRolePolicy({ RoleName: role.name, PolicyDocument: JSON.stringify(role.trust) });
      changed.push(`trust of ${role.name}`);
    }
  }
  const current = await find(() => iam.getRolePolicy({ RoleName: role.name, PolicyName: role.policyName }));
  if (!current || !same(policyOf(current.PolicyDocument), role.policy)) {
    await iam.putRolePolicy({ RoleName: role.name, PolicyName: role.policyName, PolicyDocument: JSON.stringify(role.policy) });
    if (existing) changed.push(`policy of ${role.name}`);
  }
}

// A role and its inline policies deleted: false when it did not exist.
export async function deleteRole(iam: Pick<InstallerPorts['iam'], 'listRolePolicies' | 'deleteRolePolicy' | 'deleteRole'>, name: string): Promise<boolean> {
  const names = (await find(() => iam.listRolePolicies({ RoleName: name })))?.PolicyNames;
  if (!names) return false;
  for (const PolicyName of names) await iam.deleteRolePolicy({ RoleName: name, PolicyName });
  await iam.deleteRole({ RoleName: name });
  return true;
}

export function createInstaller(ports: InstallerPorts, options: { boundaryArn: string; principals: string[]; zip: () => Promise<Uint8Array>; codeSha256: string }) {
  const { iam, dynamodb, sqs, logs, lambda, scheduler, events } = ports;

  async function roles(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    for (const role of b.roles) await putRole(iam, options.boundaryArn, role, b.tags, changed);
    return result(changed);
  }

  // The forwarder of event-driven discovery refresh (packaging design §5): its role (once per account) and its rule in
  // this installer's region, delivering to the manager's bus with that role.
  const forwarder = {
    async role(f: Forwarder): Promise<StepResult> {
      const changed: string[] = [];
      await putRole(iam, options.boundaryArn, f.role, f.role.tags, changed);
      return result(changed);
    },
    async rule(f: Forwarder): Promise<StepResult> {
      const r = f.rule;
      const changed: string[] = [];
      const current = await find(() => events.describeRule({ Name: r.name }));
      if (!current || !same(JSON.parse(current.EventPattern), JSON.parse(r.pattern)) || current.State !== 'ENABLED') {
        await events.putRule({ Name: r.name, EventPattern: r.pattern, State: 'ENABLED', Description: r.description, ...(current ? {} : { Tags: tagList(f.role.tags) }) });
        changed.push(`rule ${r.name}`);
      }
      const targets = ((await events.listTargetsByRule({ Rule: r.name })).Targets ?? []) as { Id: string; Arn: string; RoleArn?: string }[];
      if (!targets.some((t) => t.Id === 'manager' && t.Arn === r.targetBus && t.RoleArn === r.roleArn)) {
        await events.putTargets({ Rule: r.name, Targets: [{ Id: 'manager', Arn: r.targetBus, RoleArn: r.roleArn }] });
        changed.push(`target of ${r.name}`);
      }
      return result(changed);
    },
    async removeRule(f: Forwarder): Promise<StepResult> {
      if (!(await find(() => events.describeRule({ Name: f.rule.name })))) return { status: 'skipped' };
      await find(() => events.removeTargets({ Rule: f.rule.name, Ids: ['manager'] }));
      await events.deleteRule({ Name: f.rule.name });
      return { status: 'done', detail: `rule ${f.rule.name}` };
    },
    async removeRole(f: Forwarder): Promise<StepResult> {
      return result((await deleteRole(iam, f.role.name)) ? [`role ${f.role.name}`] : []);
    },
  };

  async function table(b: Blueprint): Promise<StepResult> {
    const t = b.table;
    const described = (await find(() => dynamodb.describeTable({ TableName: t.name })))?.Table;
    if (!described) {
      await dynamodb.createTable({
        TableName: t.name, BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: t.hashKey, AttributeType: 'S' }, { AttributeName: t.rangeKey, AttributeType: 'S' }],
        KeySchema: [{ AttributeName: t.hashKey, KeyType: 'HASH' }, { AttributeName: t.rangeKey, KeyType: 'RANGE' }],
        Tags: tagList(b.tags),
      });
      return { status: 'pending', detail: `table ${t.name} CREATING`, changed: true };
    }
    if (described.TableStatus !== 'ACTIVE') return { status: 'pending', detail: `table ${t.name} ${described.TableStatus}` };
    const changed: string[] = [];
    const ttl = (await dynamodb.describeTimeToLive({ TableName: t.name })).TimeToLiveDescription;
    if (ttl?.TimeToLiveStatus !== 'ENABLED' || ttl.AttributeName !== t.ttlAttribute) {
      await dynamodb.updateTimeToLive({ TableName: t.name, TimeToLiveSpecification: { Enabled: true, AttributeName: t.ttlAttribute } });
      changed.push('time to live');
    }
    const pitr = (await dynamodb.describeContinuousBackups({ TableName: t.name })).ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
    if (t.pointInTimeRecovery && pitr !== 'ENABLED') {
      await dynamodb.updateContinuousBackups({ TableName: t.name, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
      changed.push('point-in-time recovery');
    }
    // A table created by an earlier attempt of this step reports done once it is active.
    return changed.length ? { status: 'done', detail: `table ${t.name}: ${changed.join(', ')}` } : { status: 'skipped' };
  }

  // Queues with their attributes: retention, encryption and, from routers 0.22.0, visibility, dead-letter queue and
  // policy (set again on a queue an earlier version created). The dead-letter queues come first in the blueprint.
  const queueAttributes = (q: Blueprint['queues'][number]): Record<string, string> => ({
    MessageRetentionPeriod: String(q.retentionSeconds), SqsManagedSseEnabled: String(q.managedEncryption),
    ...(q.visibilityTimeoutSeconds !== undefined ? { VisibilityTimeout: String(q.visibilityTimeoutSeconds) } : {}),
    ...(q.deadLetter ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: q.deadLetter.queue, maxReceiveCount: q.deadLetter.maxReceiveCount }) } : {}),
    ...(q.policy ? { Policy: JSON.stringify(q.policy) } : {}),
  });
  const JSON_ATTRIBUTES = new Set(['RedrivePolicy', 'Policy']);
  async function queues(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    for (const q of b.queues) {
      const wanted = queueAttributes(q);
      const url = (await find(() => sqs.getQueueUrl({ QueueName: q.name })))?.QueueUrl as string | undefined;
      if (!url) {
        await sqs.createQueue({ QueueName: q.name, Attributes: wanted, tags: b.tags });
        changed.push(`queue ${q.name}`);
        continue;
      }
      const current = ((await sqs.getQueueAttributes({ QueueUrl: url, AttributeNames: ['All'] })).Attributes ?? {}) as Record<string, string>;
      const differ = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => (JSON_ATTRIBUTES.has(k) ? !current[k] || !same(JSON.parse(current[k]!), JSON.parse(v)) : current[k] !== v)));
      if (Object.keys(differ).length) {
        await sqs.setQueueAttributes({ QueueUrl: url, Attributes: differ });
        changed.push(`attributes of ${q.name}`);
      }
    }
    return result(changed);
  }

  // The readers of the queues (routers 0.22.0 and later): created once, put back as the blueprint has them. Lambda refuses
  // a mapping while the function's role cannot read the queue yet (IAM propagation): retried later.
  async function eventSourceMappings(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    let pending = false;
    for (const m of b.eventSourceMappings ?? []) {
      const wanted = {
        BatchSize: m.batchSize, MaximumBatchingWindowInSeconds: m.maximumBatchingWindowSeconds,
        FunctionResponseTypes: m.reportBatchItemFailures ? ['ReportBatchItemFailures'] : [], ScalingConfig: { MaximumConcurrency: m.maximumConcurrency },
      };
      const [current] = ((await lambda.listEventSourceMappings({ FunctionName: m.function, EventSourceArn: m.queue })).EventSourceMappings ?? []) as Record<string, any>[];
      if (!current) {
        try {
          await lambda.createEventSourceMapping({ FunctionName: m.function, EventSourceArn: m.queue, Enabled: true, ...wanted });
        } catch (err) {
          if ((err as Error).name === 'InvalidParameterValueException' && /permission/i.test((err as Error).message)) throw new RetryLater(`role of ${m.function} cannot read ${m.queue} yet`);
          throw err;
        }
        changed.push(`event source mapping of ${m.function}`);
        continue;
      }
      if (['Creating', 'Updating', 'Enabling'].includes(current.State)) {
        pending = true;
        continue;
      }
      if (!covers(current, wanted)) {
        await lambda.updateEventSourceMapping({ UUID: current.UUID, Enabled: true, ...wanted });
        changed.push(`event source mapping of ${m.function}`);
      }
    }
    if (pending) return { status: 'pending', detail: changed.join(', ') || 'event source mapping in progress', changed: changed.length > 0 };
    return result(changed);
  }

  async function logGroups(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    for (const g of b.logGroups) {
      const existing = ((await logs.describeLogGroups({ logGroupNamePrefix: g.name })).logGroups ?? []).find((x: { logGroupName: string }) => x.logGroupName === g.name);
      if (!existing) {
        await logs.createLogGroup({ logGroupName: g.name, tags: b.tags });
        changed.push(`log group ${g.name}`);
      }
      if (existing?.retentionInDays !== g.retentionDays) {
        await logs.putRetentionPolicy({ logGroupName: g.name, retentionInDays: g.retentionDays });
        if (existing) changed.push(`retention of ${g.name}`);
      }
    }
    return result(changed);
  }

  const configOf = (f: Blueprint['functions'][number]) => ({
    FunctionName: f.name, Role: f.roleArn, Runtime: f.runtime, Handler: f.handler, Timeout: f.timeout, MemorySize: f.memory, Environment: { Variables: f.environment },
  });

  // The router's invoke permission (routers 0.20.0 and later), as the blueprint has it: added, or replaced when its source
  // differs. A conflict is not proof it exists (a function being updated answers one too): read again, else retry later.
  async function wakerStatement(w: NonNullable<Blueprint['wakerPermission']>) {
    const policy = await find(() => lambda.getPolicy({ FunctionName: w.function }));
    const statements = (policy ? JSON.parse(policy.Policy) : { Statement: [] }).Statement as { Sid: string; Condition?: { ArnLike?: Record<string, string> } }[];
    return statements.find((st) => st.Sid === w.statementId) ?? null;
  }
  async function ensureWakerPermission(b: Blueprint): Promise<string | null> {
    const w = b.wakerPermission;
    if (!w) return null;
    const sourceOf = (st: Awaited<ReturnType<typeof wakerStatement>>) => st?.Condition?.ArnLike?.['AWS:SourceArn'];
    const current = await wakerStatement(w);
    if (current && sourceOf(current) === w.sourceArn) return null;
    if (current) await lambda.removePermission({ FunctionName: w.function, StatementId: w.statementId });
    try {
      await lambda.addPermission({ FunctionName: w.function, StatementId: w.statementId, Action: 'lambda:InvokeFunction', Principal: w.principal, SourceArn: w.sourceArn });
      return `invoke permission of ${w.function}`;
    } catch (err) {
      if ((err as Error).name !== 'ResourceConflictException') throw err;
      if (sourceOf(await wakerStatement(w)) === w.sourceArn) return null;
      throw new RetryLater(`invoke permission of ${w.function}: ${(err as Error).message}`);
    }
  }

  async function functions(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    let pending = false;
    // An upgrade adds the router's permission before any function runs the new code: its onboardings rely on it.
    const waker = b.functions.find((f) => f.key === 'waker');
    if (b.wakerPermission && waker && (await find(() => lambda.getFunction({ FunctionName: waker.name })))?.Configuration?.State === 'Active') {
      const added = await ensureWakerPermission(b);
      if (added) changed.push(added);
    }
    for (const f of b.functions) {
      const current = (await find(() => lambda.getFunction({ FunctionName: f.name })))?.Configuration;
      if (!current) {
        try {
          await lambda.createFunction({ ...configOf(f), Architectures: f.architectures, Code: { ZipFile: await options.zip() }, Tags: b.tags });
        } catch (err) {
          if ((err as Error).name === 'InvalidParameterValueException' && /cannot be assumed/.test((err as Error).message)) throw new RetryLater(`role ${f.role} not assumable by Lambda yet`);
          throw err;
        }
        changed.push(`function ${f.name}`);
        continue;
      }
      if (current.State === 'Pending' || current.LastUpdateStatus === 'InProgress') {
        pending = true;
        continue;
      }
      const wanted = configOf(f);
      const actual = { FunctionName: f.name, Role: current.Role, Runtime: current.Runtime, Handler: current.Handler, Timeout: current.Timeout, MemorySize: current.MemorySize, Environment: { Variables: current.Environment?.Variables ?? {} } };
      if (!same(actual, wanted)) {
        await lambda.updateFunctionConfiguration(wanted);
        changed.push(`configuration of ${f.name}`);
        pending = true;
      } else if (current.CodeSha256 !== options.codeSha256) {
        await lambda.updateFunctionCode({ FunctionName: f.name, ZipFile: await options.zip() });
        changed.push(`code of ${f.name}`);
        pending = true;
      }
    }
    // Configuration and code updates are sequential (one update in progress at a time): the step comes back until done.
    if (pending) return { status: 'pending', detail: changed.join(', ') || 'function update in progress', changed: changed.length > 0 };
    return result(changed);
  }

  async function asyncInvoke(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    for (const f of b.functions.filter((x) => x.asyncInvoke)) {
      const wanted = {
        FunctionName: f.name, MaximumRetryAttempts: f.asyncInvoke!.maximumRetryAttempts, MaximumEventAgeInSeconds: f.asyncInvoke!.maximumEventAgeInSeconds,
        DestinationConfig: { OnFailure: { Destination: f.asyncInvoke!.onFailure } },
      };
      const current = await find(() => lambda.getFunctionEventInvokeConfig({ FunctionName: f.name }));
      if (current && current.MaximumRetryAttempts === wanted.MaximumRetryAttempts && current.MaximumEventAgeInSeconds === wanted.MaximumEventAgeInSeconds
        && current.DestinationConfig?.OnFailure?.Destination === wanted.DestinationConfig.OnFailure.Destination) continue;
      await lambda.putFunctionEventInvokeConfig(wanted);
      changed.push(`asynchronous invocation of ${f.name}`);
    }
    return result(changed);
  }

  // The manager's principals invoke the controller (status, pause) and the onboarder (operations).
  async function permissions(b: Blueprint): Promise<StepResult> {
    const changed: string[] = [];
    for (const f of b.functions.filter((x) => x.key === 'controller' || x.key === 'onboarder')) {
      const policy = await find(() => lambda.getPolicy({ FunctionName: f.name }));
      const sids = new Set(((policy ? JSON.parse(policy.Policy) : { Statement: [] }).Statement as { Sid: string }[]).map((st) => st.Sid));
      for (const principal of options.principals) {
        const sid = `dmt-manager-${createHash('sha256').update(principal).digest('hex').slice(0, 12)}`;
        if (sids.has(sid)) continue;
        try {
          await lambda.addPermission({ FunctionName: f.name, StatementId: sid, Action: 'lambda:InvokeFunction', Principal: principal });
          changed.push(`invoke permission of ${f.name}`);
        } catch (err) {
          if ((err as Error).name !== 'ResourceConflictException') throw err;
        }
      }
    }
    // The load balancers invoke the waker from the router's waker target groups (routers 0.20.0 and later).
    const waker = await ensureWakerPermission(b);
    if (waker) changed.push(waker);
    return result(changed);
  }

  // Drift repair (R4c): the rule, its target (the onboarder), and the permission letting EventBridge invoke it.
  async function eventRule(b: Blueprint): Promise<StepResult> {
    const r = b.eventRule;
    const changed: string[] = [];
    const current = await find(() => events.describeRule({ Name: r.name }));
    let arn = current?.Arn as string | undefined;
    if (!current || !same(JSON.parse(current.EventPattern), JSON.parse(r.pattern)) || current.State !== 'ENABLED') {
      arn = (await events.putRule({ Name: r.name, EventPattern: r.pattern, State: 'ENABLED', Description: r.description, ...(current ? {} : { Tags: tagList(b.tags) }) })).RuleArn;
      changed.push(`event rule ${r.name}`);
    }
    const targets = ((await events.listTargetsByRule({ Rule: r.name })).Targets ?? []) as { Id: string; Arn: string }[];
    if (!targets.some((t) => t.Id === 'onboarder' && t.Arn === r.target)) {
      await events.putTargets({ Rule: r.name, Targets: [{ Id: 'onboarder', Arn: r.target }] });
      changed.push(`target of ${r.name}`);
    }
    // Routers 0.22.0 and later send the events to the drift queue (its policy admits the rule); earlier ones invoke the
    // onboarder, which needs EventBridge's permission.
    if (!r.target.includes(':lambda:')) return result(changed);
    const onboarder = r.target.split(':').at(-1)!;
    const policy = await find(() => lambda.getPolicy({ FunctionName: onboarder }));
    const sids = new Set(((policy ? JSON.parse(policy.Policy) : { Statement: [] }).Statement as { Sid: string }[]).map((st) => st.Sid));
    if (!sids.has('drift-events')) {
      await lambda.addPermission({ FunctionName: onboarder, StatementId: 'drift-events', Action: 'lambda:InvokeFunction', Principal: 'events.amazonaws.com', SourceArn: arn });
      changed.push(`event permission of ${onboarder}`);
    }
    return result(changed);
  }

  async function schedule(b: Blueprint): Promise<StepResult> {
    const s = b.schedule;
    const wanted = {
      Name: s.name, ScheduleExpression: s.expression, FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: s.target, RoleArn: s.roleArn, Input: s.input, RetryPolicy: { MaximumRetryAttempts: s.maximumRetryAttempts }, DeadLetterConfig: { Arn: s.deadLetter } },
    };
    const current = await find(() => scheduler.getSchedule({ Name: s.name }));
    if (current && current.ScheduleExpression === wanted.ScheduleExpression && covers(current.Target, wanted.Target)) return { status: 'skipped' };
    try {
      await (current ? scheduler.updateSchedule(wanted) : scheduler.createSchedule(wanted));
    } catch (err) {
      if ((err as Error).name === 'ValidationException' && /assume/i.test((err as Error).message)) throw new RetryLater(`role of ${s.name} not assumable by EventBridge Scheduler yet`);
      throw err;
    }
    return { status: 'done', detail: `schedule ${s.name}` };
  }

  const installSteps: Record<InstallStep, (b: Blueprint) => Promise<StepResult>> = {
    roles, table, queues, 'log groups': logGroups, functions, 'async invoke': asyncInvoke, 'event source mappings': eventSourceMappings, permissions, 'event rule': eventRule, schedule,
  };

  // Uninstall: each step deletes what exists.
  const deleted = async (call: () => Promise<unknown>) => (await find(call)) !== null;
  const uninstallSteps: Record<UninstallStep, (b: Blueprint) => Promise<StepResult>> = {
    'event rule': async (b) => {
      if (!(await find(() => events.describeRule({ Name: b.eventRule.name })))) return { status: 'skipped' };
      await find(() => events.removeTargets({ Rule: b.eventRule.name, Ids: ['onboarder'] }));
      await events.deleteRule({ Name: b.eventRule.name });
      return { status: 'done', detail: `event rule ${b.eventRule.name}` };
    },
    schedule: async (b) => result((await deleted(() => scheduler.deleteSchedule({ Name: b.schedule.name }))) ? [`schedule ${b.schedule.name}`] : []),
    'event source mappings': async (b) => {
      const changed: string[] = [];
      for (const m of b.eventSourceMappings ?? []) {
        const found = ((await find(() => lambda.listEventSourceMappings({ FunctionName: m.function, EventSourceArn: m.queue })))?.EventSourceMappings ?? []) as { UUID: string }[];
        for (const { UUID } of found) if (await deleted(() => lambda.deleteEventSourceMapping({ UUID }))) changed.push(`event source mapping of ${m.function}`);
      }
      return result(changed);
    },
    functions: async (b) => {
      const changed: string[] = [];
      for (const f of b.functions) if (await deleted(() => lambda.deleteFunction({ FunctionName: f.name }))) changed.push(`function ${f.name}`);
      return result(changed);
    },
    queues: async (b) => {
      const changed: string[] = [];
      for (const q of b.queues) {
        const url = (await find(() => sqs.getQueueUrl({ QueueName: q.name })))?.QueueUrl;
        if (!url) continue;
        await sqs.deleteQueue({ QueueUrl: url });
        changed.push(`queue ${q.name}`);
      }
      return result(changed);
    },
    'log groups': async (b) => {
      const changed: string[] = [];
      for (const g of b.logGroups) if (await deleted(() => logs.deleteLogGroup({ logGroupName: g.name }))) changed.push(`log group ${g.name}`);
      return result(changed);
    },
    table: async (b) => result((await deleted(() => dynamodb.deleteTable({ TableName: b.table.name }))) ? [`table ${b.table.name}`] : []),
    roles: async (b) => {
      const changed: string[] = [];
      for (const role of b.roles) if (await deleteRole(iam, role.name)) changed.push(`role ${role.name}`);
      return result(changed);
    },
  };

  return {
    install: (step: InstallStep, b: Blueprint) => installSteps[step](b),
    uninstall: (step: UninstallStep, b: Blueprint) => uninstallSteps[step](b),
    forwarder,
  };
}
