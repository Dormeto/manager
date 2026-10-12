// Discovery Lambda, the steps of the discovery state machine (scale design §5): { step: 'plan', input: { source, by } },
// { step: 'account', runId, account } (one per account, in a Distributed Map), { step: 'finalize', plan }, and
// { step: 'abandon', plan, error } when finalize failed. Without a step, a whole run in process (the accounts one after
// another).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { commandCheck, createAssumeRole, ec2For, enabledRegionsOf, organizationsPort, regionalClients, scanPorts, trailCovers, trailsPort, type Credentials } from './aws.js';
import { abandonRun, finalizeRun, planRun, refreshAccounts, runDiscovery, runSummary, scanAccount, type Logger, type RunDeps, type RunPlan } from './run.js';
import { scanRegion } from './scan.js';
import { createStore } from './store.js';

const region = process.env.AWS_REGION ?? 'eu-west-1';
const roleName = process.env.ROLE_NAME ?? 'DmtDiscoveryRole';
// The command role of each account, checked by the access check function (it runs as the operations role, which the role
// trusts; packaging design §3). Discovery may invoke that function only.
const lambda = new LambdaClient({ region, maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 30_000 } });
const accessCheck = process.env.ACCESS_CHECK_FUNCTION ?? '';
const invokeCheck = async (payload: Record<string, unknown>) => {
  const out = await lambda.send(new InvokeCommand({ FunctionName: accessCheck, Payload: Buffer.from(JSON.stringify(payload)) }));
  const text = out.Payload ? Buffer.from(out.Payload).toString('utf8') : 'null';
  if (out.FunctionError) throw new Error((JSON.parse(text) as { errorMessage?: string }).errorMessage ?? out.FunctionError);
  return JSON.parse(text) as unknown;
};
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
  | { step: 'abandon'; plan: RunPlan; error?: string }
  | { step?: undefined; source?: string; by?: string; action?: string }
  // Forwarded load balancer changes, in batches from the refresh queue (packaging design §5).
  | { step?: undefined; Records: { body: string }[] };

const trigger = (e: { source?: string; by?: string } = {}) => ({ source: e.source === 'manual' ? 'manual' as const : 'schedule' as const, ...(e.by ? { by: e.by } : {}) });

export const handler = async (event: Event = {}) => {
  managerAccount ??= (await sts.send(new GetCallerIdentityCommand({}))).Account ?? '';
  const deps: RunDeps = {
    store,
    organizations,
    managerAccount,
    roleName,
    assumeRole: createAssumeRole({ sts, roleName, sessionName: `dmt-${process.env.ENV ?? 'dev'}-discovery` }),
    ...(accessCheck ? { assumeCommand: commandCheck(invokeCheck) } : {}),
    enabledRegions: (credentials) => enabledRegionsOf(ec2For(credentials as Credentials, region)),
    scan: (credentials, where) => scanRegion(scanPorts(regionalClients(credentials as Credentials, where.region)), where),
    trails: (credentials, region) => trailCovers(trailsPort(credentials as Credentials, region), region),
    ...(synthetic > 0 ? { synthetic: { accounts: synthetic } } : {}),
    log,
  };
  if (event.step === 'plan') {
    // Without its record: the state machine passes the plan on, small.
    const { record: _record, ...plan } = await planRun(deps, trigger(event.input));
    return plan;
  }
  if (event.step === 'account') return scanAccount(deps, { runId: event.runId, account: event.account });
  if ('Records' in event) {
    const events = event.Records.map((r) => { try { return JSON.parse(r.body) as { account?: unknown; region?: unknown }; } catch { return {}; } });
    return refreshAccounts(deps, events);
  }
  const run = event.step === 'finalize' ? await finalizeRun(deps, event.plan)
    : event.step === 'abandon' ? await abandonRun(deps, event.plan, event.error ?? 'unknown error')
      : await runDiscovery(deps, trigger(event));
  return runSummary(run);
};
