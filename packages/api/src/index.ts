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
import { S3Client } from '@aws-sdk/client-s3';
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing';
import { createStore } from '@dormeto/discovery';
import { createFleetStore, createPriceBook } from '@dormeto/fleet';
import { baselineOf } from './baseline.js';
import { createEngine, createRecords } from '@dormeto/operations';
import { createApi, RouterError, type AuditEntry, type MfaMode, type Preferences, type PreferencesStore, type Router } from './api.js';
import { createAlarmStore } from './alarms.js';
import { readJson } from './s3-json.js';
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

const users = createUsers({ cognito, ses, userPoolId: process.env.USER_POOL_ID ?? '', sender: process.env.EMAIL_SENDER === 'cognito' ? 'cognito' : 'ses' });
// The MFA policy (R6c): the manager module's mfa.
// A missing or unknown value is the module's default, never less (review M2).
const mfaMode = (['optional', 'operators', 'required'] as const).find((m) => m === process.env.MFA_MODE) ?? 'operators';

const fleet = createFleetStore({ dynamo, table });
const pricing = new PricingClient({ region: 'us-east-1' });
const prices = createPriceBook({ pricing: { getProducts: (input) => pricing.send(new GetProductsCommand(input as GetProductsCommandInput)) }, store: fleet });

export const handler = createApi({
  routers, invoke, audit, version: process.env.VERSION ?? '0.0.0',
  accessRoles: { discoveryRole: process.env.DISCOVERY_ROLE ?? 'DmtDiscoveryRole', commandRole: process.env.COMMAND_ROLE ?? 'DmtCommandRole' },
  users,
  // Under required, an authenticator set up at sign-in (managed login) is turned on in the user's settings.
  mfa: { mode: mfaMode satisfies MfaMode, enabled: (username) => users.mfaEnabled(username, { activate: mfaMode === 'required' }) },
  preferences,
  discovery,
  operations: process.env.OPERATIONS ? operations : undefined,
  managerAccount: process.env.MANAGER_ACCOUNT,
  // Routers and workloads as the routers report them (scale design §4).
  fleet,
  // A workload view's savings (R9): AWS's list prices (the Price List API answers in us-east-1), cached in the table.
  savings: { baseline: baselineOf(process.env.SAVINGS_BASELINE, process.env.SAVINGS_TIMEZONE), hourly: (region, item) => prices.hourly(region, item) },
  routerVersion: process.env.ROUTER_VERSION,
  alerts,
  ipLists,
});
