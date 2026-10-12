// The Node estimate end to end (packages/estimate/src/cli.ts main, wired as bin.ts wires it) on a recorded AWS world:
// an organization with two member accounts (one reached through the role, one refusing it), two regions each (one
// empty, one failing), workloads of every backend kind, companion databases, ineligible rules, an unreadable EKS
// cluster; its cases run it with the options the estimate's tests cover (discover, requests, uptime, estimate, cli).
// Frozen at the switch to the Go CLI, since the Node estimate is then removed.
import { join } from 'node:path';
import { EU, EXPIRED, LEGACY, MGMT, ORG, SHOP, US, worldModel } from './world.mjs';

export const name = 'estimate';

export function cases(now) {
  const world = (title, argv, { profiles = { management: MGMT }, cache } = {}) => ({
    name: title, input: { argv, now, profiles }, model: worldModel(Date.parse(now)), ...(cache ? { cache } : {}),
  });
  return [
    world('the world: every account and region, --uptime, --exclude-tags env=dev (its cache is cache/)', ['--profile', 'management', '--uptime', '--exclude-tags', 'env=dev', '--parallel', '1', '--out', 'reports'], { cache: true }),
    world('the world without uptime: business hours in Paris, discounts, a 15-minute window, --max-wakes, --min-saving and --max-wakes-rds none, one account at a time',
      ['--profile', 'management', '--baseline', 'business-hours', '--timezone', 'Europe/Paris', '--discount-compute', '20', '--discount-databases', '30', '--window', '15', '--max-wakes', 'none', '--min-saving', 'none', '--max-wakes-rds', 'none', '--parallel', '1', '--out', 'reports']),
    world('--accounts (one of them not in the organization), --regions, --role, --max-wakes 1, --min-saving 5', ['--profile', 'management', '--accounts', `${SHOP},444444444444`, '--regions', EU, '--role', 'DormetoReadOnly', '--max-wakes', '1', '--min-saving', '5', '--out', 'reports']),
    world('a bad option: its message and the usage, exit code 2', ['--profile', 'management', '--window', '3']),
    world('credentials that do not work: AWS\'s message, exit code 1', ['--profile', 'expired', '--out', 'reports'], { profiles: { expired: EXPIRED } }),
  ];
}

// The estimate's AWS as bin.ts wires it, over the recorded answers: a profile's calls from its account (STS,
// Organizations, the Price List and the enabled regions in us-east-1), each account's in its regions.
function worldAws(product, ports, profiles, now) {
  return (_options, profile) => {
    const self = profiles[profile];
    const global = ports.at(self, US);
    return {
      accounts: {
        whoami: async () => (await global.sts.getCallerIdentity({})).Account ?? '',
        organization: async () => (await global.organizations.describeOrganization({})).Organization?.Id ?? '',
        inventory: () => product.loadInventory(global.organizations),
        assume: async (account, role) => {
          const { Credentials: c } = await global.sts.assumeRole({ RoleArn: `arn:aws:iam::${account}:role/${role}`, RoleSessionName: 'dormeto-estimate', DurationSeconds: 3600 });
          return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
        },
      },
      regionsOf: async (account) => ((await ports.at(account, US).ec2.describeRegions({})).Regions ?? []).map((r) => r.RegionName ?? '').filter(Boolean),
      portsOf: (account, region) => {
        const p = ports.at(account, region);
        const kubernetes = { eks: p.eks, kubernetesOf: p.kubernetesOf, reader: 'the profile' };
        let unreadable = [];
        return {
          scan: () => product.scanRegion({ elbv2: p.elbv2, autoscaling: p.autoscaling, ec2: { describeInstances: p.ec2.describeInstances }, ecs: p.ecs, cloudwatch: p.cloudwatch, kubernetes }, { account, region }, {
            now: () => now, onClusters: (clusters) => { unreadable = clusters.flatMap((c) => (c.reason ? [{ name: c.name, reason: c.reason }] : [])); },
          }),
          unreadableClusters: () => unreadable,
          kubernetesOf: p.kubernetesOf,
          autoscaling: p.autoscaling, elbv2: p.elbv2, ec2: p.ec2, rds: p.rds, ecs: p.ecs,
        };
      },
      cloudwatchOf: (account, region) => ports.at(account, region).cloudwatch,
      // The price book takes a refused lookup as no price: the first refusal is kept, so the report says why.
      prices: (cache) => {
        let failure = null;
        const record = (err) => {
          failure ??= `${err.name}: ${err.message}`;
          throw err;
        };
        const book = product.createPriceBook({
          pricing: { getProducts: (input) => global.pricing.getProducts(input).catch(record) },
          spot: { history: (region, input) => global.spot.history(region, input).catch(record) },
          store: cache, now: () => now,
        });
        return { hourly: book.hourly, failure: () => failure };
      },
    };
  };
}

export async function run(product, input, ports, context) {
  const now = Date.parse(input.now);
  const cacheRoot = join(context.scratch, 'cache');
  const log = [];
  const errors = [];
  const written = {};
  const exitCode = await product.main(input.argv, {
    now: () => now, cacheRoot, log: (line) => log.push(line), error: (line) => errors.push(line), aws: worldAws(product, ports, input.profiles, now),
    writeFile: async (path, text) => { written[path] = text; },
  });
  context.cache = cacheRoot;
  const paths = Object.keys(written);
  const json = paths.find((p) => p.endsWith('.json'));
  const md = paths.find((p) => p.endsWith('.md'));
  // The run's time removed: the JSON's generatedAt, the Markdown's "estimated <date> <time> UTC".
  const report = json ? JSON.parse(written[json]) : null;
  if (report) delete report.generatedAt;
  const local = (line) => line.replaceAll(cacheRoot, '<cacheRoot>');
  return {
    exitCode, report, markdown: md ? written[md].replace(/estimated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, 'estimated <generatedAt> UTC') : null,
    written: paths, log: log.map(local), errors: errors.map(local),
  };
}

export const readme = `The Node estimate end to end (\`packages/estimate/src/cli.ts\` \`main\`; Go \`cli.Main\` and the packages under it),
on a recorded world: organization \`${ORG}\` (management account \`${MGMT}\`, the profile's; member \`${SHOP}\` reached
through the role; member \`${LEGACY}\` refusing it), regions \`${EU}\` and \`${US}\` in each reached account (the
management's \`${US}\` empty, the member's failing).

Input: \`argv\` (the command's arguments after \`estimate\`), \`now\`, \`profiles\` (\`{profile: account}\`: the account a
profile's calls are made from, as \`sts.getCallerIdentity\` answers it), \`answers\`. The run's dependencies, as \`bin.ts\`
wires them and the Go command must: \`now\`; a fresh empty cache directory as \`cacheRoot\`; no terminal (no
\`status\`: the log gets a line per account and per region); reports captured, not written. Each profile's AWS:

- the accounts: \`sts.getCallerIdentity({})\`, \`organizations.describeOrganization({})\`, the inventory
  (\`organizations.listRoots\`, \`listAccountsForParent\`, \`listOrganizationalUnitsForParent\`), and
  \`sts.assumeRole({RoleArn: "arn:aws:iam::<account>:role/<role>", RoleSessionName: "dormeto-estimate",
  DurationSeconds: 3600})\` for a member account, all in the profile's account and \`us-east-1\`;
- an account's enabled regions: \`ec2.describeRegions({})\` in that account and \`us-east-1\`;
- a region's ports in that account and region: discovery's \`scanRegion\` (run at \`now\`, where \`bin.ts\` lets it read
  the clock; given \`elbv2\`,
  \`autoscaling\`, \`ec2\`, \`ecs\`, \`cloudwatch\` and the EKS clusters with reader "the profile"), then
  \`autoscaling\`, \`elbv2.describeRules\`, \`ec2\` (instances, security groups), \`rds\`, \`ecs\` and the clusters' API
  (\`kubernetes.of\`, \`get\`, \`list\`) for what the workloads stop and their companion databases; \`cloudwatch\` for the
  requests and the uptime;
- the prices: the product's price book made at \`now\` over the estimate's cache, \`pricing.getProducts\` in the
  profile's account and \`us-east-1\`, \`spot.history\` from the profile's account in the item's region (the first
  refused lookup kept, as \`bin.ts\` does).

Output: \`{exitCode, report, markdown, written, log, errors}\` — the exit code; the JSON report parsed, without
\`generatedAt\` (null when none was written); the Markdown report with its time replaced (\`estimated <generatedAt> UTC\`
in place of \`estimated YYYY-MM-DD HH:MM UTC\`; null when none was written); the report paths written (relative to the
working directory: \`--out reports\`); the lines logged and the lines written as errors, the cache directory replaced by
\`<cacheRoot>\`. The cases reading several accounts or regions run one at a time (\`--parallel 1\`), so the log lines
come in an order Go can give too (concurrent reads log in the order they end). The first case's cache directory is
\`cache/\`.

Where the Go command differs by design (the plan's global constraints): its JSON report adds
\`"tool": {"name": "dormeto", "version": …}\` (remove it before comparing), and its usage names \`dormeto estimate\`
where the Node one says \`npm run estimate --\` (the usage error case's \`errors\`).`;
