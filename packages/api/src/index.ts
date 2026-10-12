// Lambda entry point: AWS SDK v3 clients provided by the nodejs24.x runtime (not bundled).
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { CreateEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createApi, RouterError, type AuditEntry, type Router } from './api.js';
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

const idp = new CognitoIdentityProviderClient({});
const cognito: CognitoPort = {
  listUsers: (input) => idp.send(new ListUsersCommand(input)),
  listUsersInGroup: (input) => idp.send(new ListUsersInGroupCommand(input)),
  adminCreateUser: (input) => idp.send(new AdminCreateUserCommand(input as never)),
  adminAddUserToGroup: (input) => idp.send(new AdminAddUserToGroupCommand(input)),
  adminRemoveUserFromGroup: (input) => idp.send(new AdminRemoveUserFromGroupCommand(input)),
  adminDisableUser: (input) => idp.send(new AdminDisableUserCommand(input)),
  adminEnableUser: (input) => idp.send(new AdminEnableUserCommand(input)),
};
const sesClient = new SESv2Client({});
const ses: SesPort = {
  getAccount: () => sesClient.send(new GetAccountCommand({})),
  getEmailIdentity: (input) => sesClient.send(new GetEmailIdentityCommand(input)),
  createEmailIdentity: (input) => sesClient.send(new CreateEmailIdentityCommand(input)),
};

export const handler = createApi({
  routers, invoke, audit, version: process.env.VERSION ?? '0.0.0',
  users: createUsers({ cognito, ses, userPoolId: process.env.USER_POOL_ID ?? '' }),
});
