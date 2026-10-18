// Lambda entry point: AWS SDK v3 clients provided by the nodejs24.x runtime (not bundled).
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminRemoveUserFromGroupCommand,
  AdminSetUserMFAPreferenceCommand, CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { CreateEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ListSubscriptionsByTopicCommand, SNSClient, type Subscription } from '@aws-sdk/client-sns';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { BatchGetBuildsCommand, CodeBuildClient, ListBuildsForProjectCommand } from '@aws-sdk/client-codebuild';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing';
import { createStore } from '@dormeto/discovery';
import { createFleetStore, createPriceBook } from '@dormeto/fleet';
import { createSpotPort } from './spot.js';
import { baselineOf } from './baseline.js';
import { createEngine, createRecords } from '@dormeto/operations';
import { createApi, RouterError, type AuditEntry, type MfaMode, type Preferences, type PreferencesStore, type Router } from './api.js';
import { createAlarmStore } from './alarms.js';
import { createIdleRequests } from './idle-requests.js';
import { readJson } from './s3-json.js';
import { absent, createUpdate, fetchText, missingStream, type Build, type Pending } from './update.js';
import { createUsers, type CognitoPort, type SesPort } from './users.js';

const routers: Router[] = JSON.parse(process.env.ROUTERS ?? '[]');
const table = process.env.TABLE ?? '';
const AUDIT_DAYS = 90;

const lambdas = new Map<string, LambdaClient>();
const lambdaFor = (region: string) => {
  if (!lambdas.has(region)) lambdas.set(region, new LambdaClient({ region }));
  return lambdas.get(region)!;
};

async function invoke(router: Router, payload: Record<string, unknown>, options: { async?: boolean } = {}) {
  const out = await lambdaFor(router.region).send(new InvokeCommand({
    FunctionName: router.controller,
    InvocationType: options.async ? 'Event' : 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  if (options.async) return null;
  const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : 'null';
  if (out.FunctionError) {
    const { errorMessage } = JSON.parse(text) as { errorMessage?: string };
    throw new RouterError(errorMessage ?? out.FunctionError);
  }
  return JSON.parse(text);
}

const dynamo = new DynamoDBClient({});
const audit = {
  async write(entry: AuditEntry) {
    await dynamo.send(new PutItemCommand({
      TableName: table,
      Item: {
        pk: { S: 'T#default' },
        sk: { S: `AUDIT#${entry.at}#${entry.id}` },
        entry: { S: JSON.stringify(entry) },
        expiresAt: { N: String(Math.floor(Date.parse(entry.at) / 1000) + AUDIT_DAYS * 86_400) },
      },
    }));
  },
  async list() {
    const { Items = [] } = await dynamo.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'T#default' }, ':prefix': { S: 'AUDIT#' } },
      ScanIndexForward: false,
      Limit: 200,
    }));
    return Items.map((item) => JSON.parse(item.entry?.S ?? '{}') as AuditEntry);
  },
};

// Dashboard preferences: T#default / USER#<sub>#PREFS.
const preferences: PreferencesStore = {
  async get(sub) {
    const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'T#default' }, sk: { S: `USER#${sub}#PREFS` } } }));
    return Item?.prefs?.S ? (JSON.parse(Item.prefs.S) as Preferences) : null;
  },
  async put(sub, prefs) {
    await dynamo.send(new PutItemCommand({
      TableName: table,
      Item: { pk: { S: 'T#default' }, sk: { S: `USER#${sub}#PREFS` }, prefs: { S: JSON.stringify(prefs) } },
    }));
  },
};

const idp = new CognitoIdentityProviderClient({});
const cognito: CognitoPort = {
  listUsers: (input) => idp.send(new ListUsersCommand(input)),
  listUsersInGroup: (input) => idp.send(new ListUsersInGroupCommand(input)),
  adminCreateUser: (input) => idp.send(new AdminCreateUserCommand(input as never)),
  adminAddUserToGroup: (input) => idp.send(new AdminAddUserToGroupCommand(input)),
  adminRemoveUserFromGroup: (input) => idp.send(new AdminRemoveUserFromGroupCommand(input)),
  adminDisableUser: (input) => idp.send(new AdminDisableUserCommand(input)),
  adminEnableUser: (input) => idp.send(new AdminEnableUserCommand(input)),
  adminGetUser: (input) => idp.send(new AdminGetUserCommand(input)),
  adminSetUserMFAPreference: (input) => idp.send(new AdminSetUserMFAPreferenceCommand(input)),
};
// AdminDeleteSoftwareToken (August 2026): the Cognito client is bundled (package.json build), so the command is there; a
// build without it still turns TOTP off.
const DeleteSoftwareToken = (cognitoSdk as Record<string, unknown>).AdminDeleteSoftwareTokenCommand as (new (input: object) => object) | undefined;
if (DeleteSoftwareToken) cognito.adminDeleteSoftwareToken = (input) => idp.send(new DeleteSoftwareToken(input) as never);
const sesClient = new SESv2Client({});
const ses: SesPort = {
  getAccount: () => sesClient.send(new GetAccountCommand({})),
  getEmailIdentity: (input) => sesClient.send(new GetEmailIdentityCommand(input)),
  createEmailIdentity: (input) => sesClient.send(new CreateEmailIdentityCommand(input)),
};

const sfn = new SFNClient({});

// The idle window advisor (R10): the discovery function reads a workload's requests (member accounts trust only its
// role). One attempt, answered within 25 s: API Gateway answers within 29 s.
const discoveryLambda = new LambdaClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 3_000, requestTimeout: 25_000, socketTimeout: 25_000, throwOnRequestTimeout: true } });
const idleRequests = process.env.DISCOVERY_FUNCTION
  ? createIdleRequests({ functionName: process.env.DISCOVERY_FUNCTION, invoke: (input) => discoveryLambda.send(new InvokeCommand(input)) })
  : undefined;

// Discovery: items of the manager table, runs on demand by the discovery state machine (plan, accounts, finalize).
const discovery = {
  store: createStore({ dynamo, table }),
  async run(by: string) {
    await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.DISCOVERY_STATE_MACHINE, input: JSON.stringify({ source: 'manual', by }) }));
  },
};

// Operations: the API creates them and starts the workflow; the operations Lambda runs their steps.
const records = createRecords({ dynamo, table });
const unused = () => { throw new Error('steps run in the operations Lambda'); };
const engine = createEngine({
  records,
  discovery: discovery.store,
  routers: async () => [],
  target: async () => unused(),
  bundle: async () => unused(),
  settings: { env: process.env.ENV ?? 'dev', principals: [], routerSettings: { checkSchedule: '', ipLists: '', ipListsCatalog: '', ipListsBucket: '', noWakeRules: '', metrics: '', managerBus: '', commandRole: '' } },
  start: async (op) => (await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.OPERATIONS, name: op.id, input: JSON.stringify({ operationId: op.id }) }))).executionArn ?? '',
  log: { info: (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data })), warn: (event, data = {}) => console.log(JSON.stringify({ level: 'warn', event, ...data })), error: (event, data = {}) => console.log(JSON.stringify({ level: 'error', event, ...data })) },
});
const operations = {
  create: engine.create,
  list: () => records.listOperations(),
  get: (id: string) => records.getOperation(id),
  installedRouters: () => records.listRouters(),
};

// Health alarms (R6a): written by the watchdog; the topic's subscriptions, an email pending until its owner confirms.
const sns = new SNSClient({});
const alarmStore = createAlarmStore({ dynamo, table });
const alerts = process.env.ALERTS_TOPIC ? {
  open: () => alarmStore.open(),
  async subscriptions() {
    const topicArn = process.env.ALERTS_TOPIC!;
    const all: Subscription[] = [];
    let token: string | undefined;
    do {
      const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: token }));
      all.push(...(page.Subscriptions ?? []));
      token = page.NextToken;
    } while (token);
    return { topicArn, subscriptions: all.map((x) => ({ protocol: x.Protocol ?? '', endpoint: x.Endpoint ?? '', pending: x.SubscriptionArn === 'PendingConfirmation' })) };
  },
} : undefined;

// The manager's IP lists (R6b): the catalog Terraform writes, the status the list function writes.
const listsBucket = process.env.LISTS_BUCKET;
const s3 = new S3Client({});
const ipLists = listsBucket ? {
  catalogUrl: `s3://${listsBucket}/catalog.json`,
  catalog: () => readJson<{ lists?: { name: string; url: string; action: string; refreshHours: number }[] }>(s3, listsBucket, 'catalog.json'),
  status: () => readJson<{ lists?: [] }>(s3, listsBucket, 'status.json'),
} : undefined;

// The manager's self-update (only for an install made with the CLI, which gives the API its install bucket): requests go
// to the install bucket, its builds and their logs are read, and the pending request and an operation per request are
// kept in the table.
const installBucket = process.env.INSTALL_BUCKET;
const update = installBucket ? (() => {
  const codebuild = new CodeBuildClient({});
  const logs = new CloudWatchLogsClient({});
  const project = process.env.INSTALL_PROJECT ?? '';
  const pendingKey = { pk: { S: 'T#default' }, sk: { S: 'UPDATE#REQUEST' } };
  return createUpdate({
    async get(key) {
      try {
        return await (await s3.send(new GetObjectCommand({ Bucket: installBucket, Key: key }))).Body!.transformToString();
      } catch (err) {
        if (absent(err)) return null;
        throw err;
      }
    },
    async put(key, body) {
      const out = await s3.send(new PutObjectCommand({ Bucket: installBucket, Key: key, Body: body, ContentType: 'application/json' }));
      return (out.ETag ?? '').replace(/"/g, '');
    },
    async builds() {
      const { ids = [] } = await codebuild.send(new ListBuildsForProjectCommand({ projectName: project, sortOrder: 'DESCENDING' }));
      if (ids.length === 0) return [];
      const { builds = [] } = await codebuild.send(new BatchGetBuildsCommand({ ids: ids.slice(0, 20) }));
      const byId = new Map(builds.map((b) => [b.id, b]));
      return ids.slice(0, 20).flatMap((id) => {
        const b = byId.get(id);
        return b ? [{
          id, arn: b.arn ?? null, status: b.buildStatus ?? 'UNKNOWN', phase: b.currentPhase ?? null, startedAt: b.startTime?.toISOString() ?? null, endedAt: b.endTime?.toISOString() ?? null,
          env: Object.fromEntries((b.environment?.environmentVariables ?? []).map((v) => [v.name ?? '', v.value ?? ''])), logStream: b.logs?.streamName ?? null,
        } satisfies Build] : [];
      });
    },
    async logLines(group, stream) {
      const lines: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const out = await logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: true, nextToken: token })).catch((err) => {
          if (missingStream(err)) return null;
          throw err;
        });
        if (!out) break;
        lines.push(...(out.events ?? []).map((e) => (e.message ?? '').replace(/\r?\n$/, '')));
        if (!out.nextForwardToken || out.nextForwardToken === token) break;
        token = out.nextForwardToken;
      }
      return lines;
    },
    fetchText: (url) => fetchText(url),
    pending: {
      async get() {
        const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: pendingKey }));
        return Item?.pending?.S ? (JSON.parse(Item.pending.S) as Pending) : null;
      },
      async put(p) {
        await dynamo.send(new PutItemCommand({ TableName: table, Item: { ...pendingKey, pending: { S: JSON.stringify(p) } } }));
      },
    },
    // Each request is recorded as an operation, never started: the install build runs it.
    operations: { create: (op) => records.putOperation(op), get: (id) => records.getOperation(id), update: (op) => records.putOperation(op) },
  }, {
    env: process.env.ENV ?? '', logGroup: process.env.INSTALL_LOG_GROUP ?? '', version: process.env.VERSION ?? '0.0.0',
    releasesUrl: process.env.RELEASES_URL || 'https://releases.dormeto.com/manager', now: () => new Date(), random: () => randomBytes(4).toString('hex'),
    account: process.env.MANAGER_ACCOUNT ?? '', region: process.env.AWS_REGION ?? '',
  });
})() : undefined;

const users = createUsers({ cognito, ses, userPoolId: process.env.USER_POOL_ID ?? '', sender: process.env.EMAIL_SENDER === 'cognito' ? 'cognito' : 'ses' });
// The MFA policy (R6c): the manager module's mfa.
// A missing or unknown value is the module's default, never less (review M2).
const mfaMode = (['optional', 'operators', 'required'] as const).find((m) => m === process.env.MFA_MODE) ?? 'operators';

const fleet = createFleetStore({ dynamo, table });
const pricing = new PricingClient({ region: 'us-east-1' });
const prices = createPriceBook({ pricing: { getProducts: (input) => pricing.send(new GetProductsCommand(input as GetProductsCommandInput)) }, spot: createSpotPort(), store: fleet });

export const handler = createApi({
  routers, invoke, audit, version: process.env.VERSION ?? '0.0.0',
  accessRoles: { discoveryRole: process.env.DISCOVERY_ROLE ?? 'DmtDiscoveryRole', commandRole: process.env.COMMAND_ROLE ?? 'DmtCommandRole' },
  users,
  install: { env: process.env.ENV ?? '', region: process.env.AWS_REGION ?? '' },
  update,
  // Under required, an authenticator set up at sign-in (managed login) is turned on in the user's settings.
  mfa: { mode: mfaMode satisfies MfaMode, passkeys: process.env.PASSKEYS === 'true', enabled: (username) => users.mfaEnabled(username, { activate: mfaMode === 'required' }) },
  preferences,
  discovery,
  operations: process.env.OPERATIONS ? operations : undefined,
  managerAccount: process.env.MANAGER_ACCOUNT,
  historyDays: Number(process.env.HISTORY_DAYS) || 400,
  discoveryMode: process.env.DISCOVERY_MODE,
  // Routers and workloads as the routers report them (scale design §4).
  fleet,
  idleRequests,
  // A workload view's savings (R9): AWS's list prices (the Price List API answers in us-east-1), cached in the table;
  // Spot prices and the discounts (R9.5).
  savings: { baseline: baselineOf(process.env.SAVINGS_BASELINE, process.env.SAVINGS_TIMEZONE), hourly: (region, item, discounts) => prices.hourly(region, item, discounts) },
  // The bar of all workloads: each workload's figures kept states_cache_minutes (an hour by default).
  statesCacheMs: (Number(process.env.STATES_CACHE_MINUTES) || 60) * 60_000,
  routerVersion: process.env.ROUTER_VERSION,
  alerts,
  ipLists,
});
