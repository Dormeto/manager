// Lambda entry point of the daily update check, run at 07:00 UTC by EventBridge Scheduler: AWS SDK v3 clients provided by
// the nodejs24.x runtime (not bundled).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { createFleetStore } from '@dormeto/fleet';
import { fetchText } from './update.js';
import { runUpdateCheck } from './update-check.js';
import { snsInput } from './watchdog.js';

const store = createFleetStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '' });
const sns = new SNSClient({});

export const handler = async () => {
  const result = await runUpdateCheck({
    store, fetchText: (url) => fetchText(url), now: () => new Date(), running: process.env.VERSION ?? '0.0.0',
    releasesUrl: process.env.RELEASES_URL || 'https://releases.dormeto.com/manager', env: process.env.ENV ?? 'dev', dashboardUrl: process.env.DASHBOARD_URL ?? '',
    publish: async (notification) => { await sns.send(new PublishCommand(snsInput(notification, process.env.ALERTS_TOPIC ?? ''))); },
  });
  console.log(JSON.stringify({ level: 'info', event: 'UpdateCheckRan', ...(result ?? { enabled: false }) }));
  return result;
};
