// Lambda entry point of the watchdog (R6a), run every 5 minutes by EventBridge Scheduler: AWS SDK v3 clients provided by
// the nodejs24.x runtime (not bundled). Each run first has the fleet function probe the Google Cloud routers that are silent
// or never reported (FLEET_FUNCTION, router push design 2026-11-14 §6.3).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { S3Client } from '@aws-sdk/client-s3';
import { createFleetStore } from '@dormeto/fleet';
import { createRecords } from '@dormeto/operations';
import { createAlarmStore } from './alarms.js';
import type { TerraformRouter } from './routers.js';
import { readJson } from './s3-json.js';
import { createWatchdog, fleetProbe, idleLevelsOf, listObservations, snsInput, workloadObservations, type ListStatusLine } from './watchdog.js';

const table = process.env.TABLE ?? '';
const dynamo = new DynamoDBClient({});
const sns = new SNSClient({});
const s3 = new S3Client({});
const listsBucket = process.env.LISTS_BUCKET;
const fleetFunction = process.env.FLEET_FUNCTION;
const log = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));

const fleet = createFleetStore({ dynamo, table });
const watchdog = createWatchdog({
  env: process.env.ENV ?? 'dev',
  managerAccount: process.env.MANAGER_ACCOUNT ?? '',
  dashboardUrl: process.env.DASHBOARD_URL ?? '',
  routerVersion: process.env.ROUTER_VERSION,
  terraformRouters: JSON.parse(process.env.ROUTERS ?? '[]') as TerraformRouter[],
  fleet,
  ...(fleetFunction ? { probe: fleetProbe(new LambdaClient({ maxAttempts: 1 }), fleetFunction) } : {}),
  registry: createRecords({ dynamo, table }),
  alarms: createAlarmStore({ dynamo, table }),
  notify: {
    async publish(notification) {
      await sns.send(new PublishCommand(snsInput(notification, process.env.ALERTS_TOPIC ?? '')));
    },
  },
  log: { info: log('info'), warn: log('warn'), error: log('error') },
  // The organization's levels that hold idle signals (settings.json): a router that does not know them is warned on.
  ...(listsBucket ? { idleLevels: async () => idleLevelsOf(await readJson<unknown>(s3, listsBucket, 'settings.json')) } : {}),
  // The manager's IP lists (R6b), from the list function's status.
  // The manager's IP lists (R6b), from the list function's status; failed wakes (R7b), from the fleet's failure index.
  extraObservations: async () => [
    ...(listsBucket ? listObservations(await readJson<{ lists?: ListStatusLine[] }>(s3, listsBucket, 'status.json'), Date.now()) : []),
    ...workloadObservations(await fleet.listFailures(), Date.now()),
  ],
});

export const handler = async () => {
  await watchdog.run();
};
