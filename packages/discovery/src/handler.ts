// Discovery Lambda: { source: 'schedule' } from the hourly schedule (runs when due), { source: 'manual', by } from the API.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createAssumeRole, ec2For, enabledRegionsOf, organizationsPort, regionalClients, scanPorts, type Credentials } from './aws.js';
import { runDiscovery, type Logger } from './run.js';
import { scanRegion } from './scan.js';
import { createStore } from './store.js';

const region = process.env.AWS_REGION ?? 'eu-west-1';
const roleName = process.env.ROLE_NAME ?? 'DmtDiscoveryRole';
const store = createStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '' });
const sts = new STSClient({ region });
// Organizations is a global service served from us-east-1.
const organizations = organizationsPort(new OrganizationsClient({ region: 'us-east-1' }));
const write = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const log: Logger = { info: write('info'), warn: write('warn'), error: write('error') };
let managerAccount: string | undefined;

export const handler = async (event: { source?: string; by?: string } = {}) => {
  managerAccount ??= (await sts.send(new GetCallerIdentityCommand({}))).Account ?? '';
  const run = await runDiscovery({
    store,
    organizations,
    managerAccount,
    roleName,
    assumeRole: createAssumeRole({ sts, roleName, sessionName: `dmt-${process.env.ENV ?? 'dev'}-discovery` }),
    enabledRegions: (credentials) => enabledRegionsOf(ec2For(credentials as Credentials, region)),
    scan: (credentials, where) => scanRegion(scanPorts(regionalClients(credentials as Credentials, where.region)), where),
    log,
  }, { source: event.source === 'manual' ? 'manual' : 'schedule', ...(event.by ? { by: event.by } : {}) });
  return {
    startedAt: run.startedAt,
    status: run.status,
    ...(run.skippedReason ? { skippedReason: run.skippedReason } : {}),
    ...(run.error ? { error: run.error } : {}),
    counts: run.counts,
    targets: run.targets.filter((t) => t.status !== 'skipped').map((t) => `${t.account}/${t.region} ${t.status}${t.error ? `: ${t.error}` : ''}`),
  };
};
