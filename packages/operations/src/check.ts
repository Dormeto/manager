// Access check Lambda (packaging design §3): assumes an account's command role afresh, only to tell discovery whether it
// can be assumed. It runs as the operations role (the role trusts that one only) but does nothing else: discovery may
// invoke this function, never the operations function. For a Google Cloud project (`{ account: <project>, controllers }`)
// it asks Google, as the command account, what that account may do there (Google Cloud manager design §7.4).
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { STSClient } from '@aws-sdk/client-sts';
import { createGoogle, createGoogleSource, type GoogleConnection } from '@dormeto/google';
import { checkHandler, checkRole } from './aws.js';
import { checkProject } from './google-check.js';

// A slow STS answers within the account step, never holding it for minutes.
const sts = new STSClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } });
const dynamo = new DynamoDBClient({});
// The connection (`DISC#GOOGLE`), as discovery reads it; one Google instance per execution environment keeps its tokens.
const googleSource = createGoogleSource({
  async read() {
    const item = (await dynamo.send(new GetItemCommand({ TableName: process.env.TABLE ?? '', Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true }))).Item;
    return item?.data?.S ? (JSON.parse(item.data.S) as GoogleConnection) : null;
  },
  create: (connection) => createGoogle({ connection }),
});

export const handler = checkHandler(
  checkRole({ sts, roleName: process.env.COMMAND_ROLE ?? 'DmtCommandRole', sessionName: `dmt-${process.env.ENV ?? 'dev'}-access` }),
  checkProject({ call: (method, url, body) => googleSource.call('command', method, url, body), connection: googleSource.connection, env: process.env.ENV ?? 'dev' }),
);
