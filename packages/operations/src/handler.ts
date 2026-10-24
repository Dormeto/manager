// Operations Lambda: the tasks of the Step Functions workflow ({ task: 'next' | 'fail', operationId }), and the
// connections a discovery run decided ({ task: 'connections', runId }, packaging design §5).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { STSClient } from '@aws-sdk/client-sts';
import { createStore } from '@dormeto/discovery';
import { createBundle, createTargets } from './aws.js';
import { runConnections } from './connections.js';
import { createEngine } from './engine.js';
import { createRecords } from './records.js';
import { CHECK_SCHEDULE, routersOf } from './routers.js';

const env = process.env.ENV ?? 'dev';
const dynamo = new DynamoDBClient({});
const table = process.env.TABLE ?? '';
const records = createRecords({ dynamo, table });
const write = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const log = { info: write('info'), warn: write('warn'), error: write('error') };
const sfn = new SFNClient({});
const commandRole = process.env.COMMAND_ROLE ?? 'DmtCommandRole';

const discovery = createStore({ dynamo, table });
const engine = createEngine({
  records,
  discovery,
  routers: () => routersOf(JSON.parse(process.env.ROUTERS ?? '[]'), records),
  target: createTargets({ sts: new STSClient({}), roleName: commandRole, sessionName: `dmt-${env}-operations` }),
  bundle: createBundle({ s3: new S3Client({}), bucket: process.env.ARTIFACTS_BUCKET ?? '', version: process.env.ROUTER_VERSION ?? '' }),
  settings: {
    env,
    // The manager's version (VERSION), in what to apply where an account's organization access is older.
    ...(process.env.VERSION ? { version: process.env.VERSION } : {}),
    principals: JSON.parse(process.env.MANAGER_PRINCIPALS ?? '[]'),
    routerSettings: {
      checkSchedule: CHECK_SCHEDULE, ipLists: process.env.ROUTER_IP_LISTS ?? '[]', noWakeRules: '[]', metrics: 'false', managerBus: process.env.MANAGER_BUS ?? '',
      // The manager's IP lists (R6b): its catalog, and the bucket its routers may read.
      ipListsCatalog: process.env.ROUTER_IP_LISTS_CATALOG ?? '', ipListsBucket: process.env.ROUTER_IP_LISTS_BUCKET ?? 'none',
      // The role's name in an assumed-role ARN, without its path.
      commandRole: commandRole.split('/').at(-1)!,
    },
  },
  // The connections a discovery run decides start their executions here, as the API's operations.
  start: async (op) => (await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.OPERATIONS_STATE_MACHINE, name: op.id, input: JSON.stringify({ operationId: op.id }) }))).executionArn ?? '',
  log,
});

export const handler = async (event: { task: string; operationId?: string; runId?: string; error?: { Error?: string; Cause?: string } }) => {
  if (event.task === 'next') return engine.next(event.operationId!);
  if (event.task === 'connections') return runConnections(discovery, engine, String(event.runId ?? ''));
  if (event.task === 'fail') {
    await engine.fail(event.operationId!, [event.error?.Error, event.error?.Cause].filter(Boolean).join(': ') || 'workflow failed');
    return { done: true, status: 'failed' };
  }
  throw new Error(`unknown task: ${event.task}`);
};
