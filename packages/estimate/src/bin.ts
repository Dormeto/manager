// The estimate command's entry (vision docs/specs/2026-10-10-savings-estimate-design.md): the AWS SDK wired to the
// command — the profile's credentials (its SSO session included), a role assumed per member account, discovery's
// clients per account and region, the Price List API (us-east-1) and Spot price history for the product's price book.
// Read-only: Describe, List and Get calls, and sts:AssumeRole.
import { fromIni } from '@aws-sdk/credential-providers';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DescribeOrganizationCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { DescribeServicesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { DescribeRulesCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing';
import { loadInventory, scanRegion } from '@dormeto/discovery';
import { createAssumeRole, enabledRegionsOf, organizationsPort, regionalClients, scanPorts, type Credentials } from '@dormeto/discovery/aws';
import { createPriceBook } from '@dormeto/fleet';
import { createSpotPort } from '@dormeto/manager-api/spot';
import { cacheDir } from './cache.js';
import { main, type EstimateAws } from './cli.js';
import type { Options } from './options.js';

// The SDK takes static credentials or a provider: the profile's own account uses its provider (refreshed by the SDK).
type AnyCredentials = Credentials | ReturnType<typeof fromIni>;

// One profile's AWS: several are given with --profile a,b (each reaching its accounts).
function awsOf(_options: Options, name: string): EstimateAws {
  const profile = fromIni({ profile: name });
  const sts = new STSClient({ region: 'us-east-1', credentials: profile });
  const organizations = new OrganizationsClient({ region: 'us-east-1', credentials: profile });
  const creds = (credentials: Credentials | null): AnyCredentials => credentials ?? profile;
  return {
    accounts: {
      whoami: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account ?? '',
      organization: async () => (await organizations.send(new DescribeOrganizationCommand({}))).Organization?.Id ?? '',
      inventory: () => loadInventory(organizationsPort(organizations)),
      assume: (account, role) => createAssumeRole({ sts, roleName: role, sessionName: 'dormeto-estimate' })(account),
    },
    regionsOf: (_account, credentials) => enabledRegionsOf(new EC2Client({ region: 'us-east-1', credentials: creds(credentials) })),
    portsOf: (account, region, credentials) => {
      const clients = regionalClients(creds(credentials) as Credentials, region);
      const ec2 = new EC2Client({ region, credentials: creds(credentials) });
      return {
        scan: () => scanRegion(scanPorts(clients), { account, region }),
        autoscaling: { describeAutoScalingGroups: (input) => clients.autoscaling.send(new DescribeAutoScalingGroupsCommand(input)) },
        elbv2: { describeRules: (input) => clients.elbv2.send(new DescribeRulesCommand(input)) },
        ec2: { describeInstances: (input) => ec2.send(new DescribeInstancesCommand(input)) },
        ecs: {
          describeServices: (input) => clients.ecs.send(new DescribeServicesCommand(input)),
          describeTaskDefinition: (input) => clients.ecs.send(new DescribeTaskDefinitionCommand(input)),
        },
      } as ReturnType<EstimateAws['portsOf']>;
    },
    cloudwatchOf: (_account, region, credentials) => scanPorts(regionalClients(creds(credentials) as Credentials, region)).cloudwatch!,
    prices: (cache) => {
      const pricing = new PricingClient({ region: 'us-east-1', credentials: profile });
      const spot = createSpotPort((region) => new EC2Client({ region, credentials: profile }));
      // The price book takes a refused lookup as no price: the first refusal is kept, so the report says why.
      let failure: string | null = null;
      const record = (err: unknown): never => {
        failure ??= `${(err as Error).name}: ${(err as Error).message}`;
        throw err;
      };
      const book = createPriceBook({
        pricing: { getProducts: (input) => pricing.send(new GetProductsCommand(input as GetProductsCommandInput)).catch(record) },
        spot: { history: (region, input) => spot.history(region, input).catch(record) },
        store: cache,
      });
      return { hourly: book.hourly, failure: () => failure };
    },
  };
}

const code = await main(process.argv.slice(2), {
  now: Date.now, cacheRoot: cacheDir(), log: (line) => console.log(line), error: (line) => console.error(line), aws: awsOf,
});
process.exit(code);
