// Discovery Lambda, the steps of the discovery state machine (scale design §5): { step: 'plan', input: { source, by } },
// { step: 'account', runId, account } (one per account, in a Distributed Map), { step: 'finalize', plan }. Without a
// step, a whole run in process (the accounts one after another).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createAssumeRole, ec2For, enabledRegionsOf, organizationsPort, regionalClients, scanPorts, type Credentials } from './aws.js';
import { finalizeRun, planRun, runDiscovery, scanAccount, type Logger, type RunDeps, type RunPlan } from './run.js';
import { scanRegion } from './scan.js';
import { createStore } from './store.js';

const region = process.env.AWS_REGION ?? 'eu-west-1';
const roleName = process.env.ROLE_NAME ?? 'DmtDiscoveryRole';
// A run holds its lock for the state machine's whole time limit (3 hours).
const store = createStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '', lockMs: 3 * 3_600_000 });
const sts = new STSClient({ region });
// Organizations is a global service served from us-east-1.
const organizations = organizationsPort(new OrganizationsClient({ region: 'us-east-1' }));
const write = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const log: Logger = { info: write('info'), warn: write('warn'), error: write('error') };
// Dev only: a synthetic organization of this many accounts added to the real one (acceptance at scale).
const synthetic = Number(process.env.SYNTHETIC_ACCOUNTS ?? 0);
let managerAccount: string | undefined;

type Event =
  | { step: 'plan'; input?: { source?: string; by?: string } }
  | { step: 'account'; runId: string; account: string }
  | { step: 'finalize'; plan: RunPlan }
  | { step?: undefined; source?: string; by?: string; action?: string };

const trigger = (e: { source?: string; by?: string } = {}) => ({ source: e.source === 'manual' ? 'manual' as const : 'schedule' as const, ...(e.by ? { by: e.by } : {}) });

export const handler = async (event: Event = {}) => {
  // One-off: candidates of versions before R4.5 moved to their account partition (dev migration).
  if (!event.step && event.action === 'migrate') return { migrated: await store.migrateCandidates() };
  managerAccount ??= (await sts.send(new GetCallerIdentityCommand({}))).Account ?? '';
  const deps: RunDeps = {
    store,
    organizations,
    managerAccount,
    roleName,
    assumeRole: createAssumeRole({ sts, roleName, sessionName: `dmt-${process.env.ENV ?? 'dev'}-discovery` }),
    enabledRegions: (credentials) => enabledRegionsOf(ec2For(credentials as Credentials, region)),
    scan: (credentials, where) => scanRegion(scanPorts(regionalClients(credentials as Credentials, where.region)), where),
    ...(synthetic > 0 ? { synthetic: { accounts: synthetic } } : {}),
    log,
  };
  if (event.step === 'plan') {
    // Without its record: the state machine passes the plan on, small.
    const { record: _record, ...plan } = await planRun(deps, trigger(event.input));
    return plan;
  }
  if (event.step === 'account') return scanAccount(deps, { runId: event.runId, account: event.account });
  const run = event.step === 'finalize' ? await finalizeRun(deps, event.plan) : await runDiscovery(deps, trigger(event));
  return {
    startedAt: run.startedAt,
    status: run.status,
    ...(run.skippedReason ? { skippedReason: run.skippedReason } : {}),
    ...(run.error ? { error: run.error } : {}),
    counts: run.counts,
    errors: run.targets.filter((t) => t.status === 'error').length,
  };
};
