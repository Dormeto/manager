// Lambda entry point of the watchdog (R6a), run every 5 minutes by EventBridge Scheduler: AWS SDK v3 clients provided by
// the nodejs24.x runtime (not bundled).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { S3Client } from '@aws-sdk/client-s3';
import { createFleetStore } from '@dormeto/fleet';
import { createRecords } from '@dormeto/operations';
import { createAlarmStore } from './alarms.js';
import type { TerraformRouter } from './routers.js';
import { readJson } from './s3-json.js';
import { createWatchdog, listObservations, type ListStatusLine } from './watchdog.js';

const table = process.env.TABLE ?? '';
const dynamo = new DynamoDBClient({});
const sns = new SNSClient({});
const s3 = new S3Client({});
const listsBucket = process.env.LISTS_BUCKET;
const log = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));

const watchdog = createWatchdog({
  env: process.env.ENV ?? 'dev',
  managerAccount: process.env.MANAGER_ACCOUNT ?? '',
  dashboardUrl: process.env.DASHBOARD_URL ?? '',
  terraformRouters: JSON.parse(process.env.ROUTERS ?? '[]') as TerraformRouter[],
  fleet: createFleetStore({ dynamo, table }),
  registry: createRecords({ dynamo, table }),
  alarms: createAlarmStore({ dynamo, table }),
  notify: {
    async publish({ subject, message, attributes }) {
      await sns.send(new PublishCommand({
        TopicArn: process.env.ALERTS_TOPIC, Subject: subject, Message: message,
        MessageAttributes: { level: { DataType: 'String', StringValue: attributes.level }, kind: { DataType: 'String', StringValue: attributes.kind } },
      }));
    },
  },
  log: { info: log('info'), warn: log('warn'), error: log('error') },
  // The manager's IP lists (R6b), from the list function's status.
  extraObservations: async () => (listsBucket ? listObservations(await readJson<{ lists?: ListStatusLine[] }>(s3, listsBucket, 'status.json'), Date.now()) : []),
});

export const handler = async () => {
  await watchdog.run();
};
