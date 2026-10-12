// Operations Lambda: the tasks of the Step Functions workflow ({ task: 'next' | 'fail', operationId }).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { createStore } from '@dormeto/discovery';
import { createBundle, createTargets } from './aws.js';
import { createEngine } from './engine.js';
import { createRecords } from './records.js';
import { routersOf } from './routers.js';

const env = process.env.ENV ?? 'dev';
const dynamo = new DynamoDBClient({});
const table = process.env.TABLE ?? '';
const records = createRecords({ dynamo, table });
const write = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const log = { info: write('info'), warn: write('warn'), error: write('error') };

const engine = createEngine({
  records,
  discovery: createStore({ dynamo, table }),
  routers: () => routersOf(JSON.parse(process.env.ROUTERS ?? '[]'), records),
  target: createTargets({ sts: new STSClient({}), roleName: process.env.COMMAND_ROLE ?? 'DmtCommandRole', sessionName: `dmt-${env}-operations` }),
  bundle: createBundle({ s3: new S3Client({}), bucket: process.env.ARTIFACTS_BUCKET ?? '', version: process.env.ROUTER_VERSION ?? '' }),
  settings: {
    env,
    principals: JSON.parse(process.env.MANAGER_PRINCIPALS ?? '[]'),
    routerSettings: { checkSchedule: 'rate(5 minutes)', ipLists: process.env.ROUTER_IP_LISTS ?? '[]', noWakeRules: '[]', metrics: 'false' },
  },
  // Executions are started by the API; the workflow only runs tasks.
  start: async () => { throw new Error('operations are created by the API'); },
  log,
});

export const handler = async (event: { task: string; operationId: string; error?: { Error?: string; Cause?: string } }) => {
  if (event.task === 'next') return engine.next(event.operationId);
  // One-off: operations of versions before R4.5 indexed by time (dev migration).
  if (event.task === 'migrate') return { indexed: await records.indexOperations() };
  if (event.task === 'fail') {
    await engine.fail(event.operationId, [event.error?.Error, event.error?.Cause].filter(Boolean).join(': ') || 'workflow failed');
    return { done: true, status: 'failed' };
  }
  throw new Error(`unknown task: ${event.task}`);
};
