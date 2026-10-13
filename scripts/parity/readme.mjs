// The README of the shared cases (testdata/parity/README.md in the CLI), written with them: what the Go side needs to
// replay each topic, from the files alone.
import { PORTS } from './recorded.mjs';

// The port methods a topic's cases record answers for.
const used = (cases) => [...new Set(cases.flatMap((c) => Object.keys(c.input.answers ?? {})))].sort();

// The estimate topic as the manager's last export with the Node estimate wrote it, kept as frozen text.
const ESTIMATE = `## \`estimate\`

Frozen: this section, \`estimate.json\` and \`cache/\` were written by the manager's last export with the Node estimate (manager 0.10.0, commit 580867f), are kept in Dormeto/cli as they are and are no longer exported (the Node estimate is replaced by the Dormeto CLI). The Go tests still read them: their format stays documented here.

The Node estimate end to end (\`packages/estimate/src/cli.ts\` \`main\`; Go \`cli.Main\` and the packages under it),
on a recorded world: organization \`o-a1b2c3d4e5\` (management account \`111111111111\`, the profile's; member \`222222222222\` reached
through the role; member \`333333333333\` refusing it), regions \`eu-west-1\` and \`us-east-1\` in each reached account (the
management's \`us-east-1\` empty, the member's failing).

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
where the Node one says \`npm run estimate --\` (the usage error case's \`errors\`).

Recorded answers used: \`autoscaling.describeAutoScalingGroups\`, \`cloudwatch.getMetricData\`, \`ec2.describeInstances\`, \`ec2.describeRegions\`, \`ec2.describeSecurityGroups\`, \`ecs.describeServices\`, \`ecs.describeTaskDefinition\`, \`ecs.listClusters\`, \`ecs.listServices\`, \`eks.describeCluster\`, \`eks.listClusters\`, \`elbv2.describeListeners\`, \`elbv2.describeLoadBalancers\`, \`elbv2.describeRules\`, \`elbv2.describeTags\`, \`elbv2.describeTargetGroups\`, \`elbv2.describeTargetHealth\`, \`kubernetes.get\`, \`kubernetes.list\`, \`kubernetes.of\`, \`organizations.describeOrganization\`, \`organizations.listAccountsForParent\`, \`organizations.listOrganizationalUnitsForParent\`, \`organizations.listRoots\`, \`pricing.getProducts\`, \`rds.describeDBClusters\`, \`rds.describeDBInstances\`, \`spot.history\`, \`sts.assumeRole\`, \`sts.getCallerIdentity\`.

Cases (5):

- the world: every account and region, --uptime, --exclude-tags env=dev (its cache is cache/)
- the world without uptime: business hours in Paris, discounts, a 15-minute window, --max-wakes, --min-saving and --max-wakes-rds none, one account at a time
- --accounts (one of them not in the organization), --regions, --role, --max-wakes 1, --min-saving 5
- a bad option: its message and the usage, exit code 2
- credentials that do not work: AWS's message, exit code 1
`;

export function readme({ manager, router, commit, now, topics }) {
  return `# Shared cases

Manager ${manager}, router ${router}, manager commit \`${commit}\`.

Written by the manager's \`scripts/parity/export.mjs\`: the product's Node functions run over the corpus of
\`scripts/parity/cases/\`, each case's input and output as JSON. Do not edit these files: export them again in the
manager (\`npm ci\`, then \`node scripts/parity/export.mjs --out ../cli/testdata/parity\`) and commit them here.

## Files

- \`<topic>.json\`: \`{"manager", "router", "commit", "cases": [{"name", "input", "output"}]}\`, one per topic below
  (\`internal/parity\` \`Load\`); \`estimate.json\` is frozen, see below.
- \`versions.json\`: \`{"manager", "router", "commit"}\` (\`dormeto version\`).
- \`cache/\`: frozen, no longer exported (manager 0.10.0, commit 580867f; see \`estimate\` below): the cache directory the
  Node estimate wrote for the first \`estimate\` case (its \`cacheRoot\`, same layout:
  \`<organization>/regions/<account>.json\`, \`discovery/<account>-<region>.json\`, \`requests/…\`, \`uptime/…\`,
  \`prices.json\`; each file but \`prices.json\` is \`{"writtenAt": <ms>, "value": …}\`).

## Conventions

- JSON as Node writes it: dates as \`toISOString()\` (\`${now}\`), fields that are undefined absent (absent and \`null\`
  differ).
- Every case runs at \`${now}\`: \`input.now\` where the function takes a time.
- Outputs are compared with \`internal/parity\` \`Equal\`: numbers to a relative 1e-9, object keys in any order,
  everything else exactly (array order included).
- Where a topic has several functions, \`input.function\` names the Node function; the Go one is given beside it.

## Recorded answers

\`input.answers\`: \`{"<port>.<method>": [{"input": …, "output": …} or {"input": …, "error": …}]}\`, the AWS and
Kubernetes calls the Node code made in the case, each input once, in the order of their first call.

- A call is answered by the first entry whose input equals its own: both as JSON, object keys sorted, compared
  exactly. A call without one fails the case (the Node export fails on it, even where the code would catch it).
- An input is the method's argument as the Node code passes it, fields absent when undefined (\`{}\` when it passes
  none, or only undefined ones, such as a first page). Shapes beyond one argument:
  - \`spot.history\`: \`{"region", "input"}\` (the price book's \`history(region, input)\`).
  - \`kubernetes.of\`: \`{"cluster"}\`, the client of a cluster made (\`kubernetesOf(cluster)\`; for real: the
    cluster's endpoint and certificate authority from \`DescribeCluster\`, an EKS token), output \`{}\` or an error.
  - \`kubernetes.get\`: \`{"cluster", "path"}\`, output the object; \`kubernetes.list\`: \`{"cluster", "path"}\` and
    \`"query"\` when the caller passes one (\`{"labelSelector": …}\`), output the items of every page, as the router's
    client returns them.
  - In the \`estimate\` topic, every input is \`{"account", "region", "input": <the shape above>}\`: the account whose
    credentials make the call and the client's region (\`us-east-1\` for STS, Organizations, the Price List and the
    enabled regions; the region asked for Spot price history, from the profile's account).
- An output is the API's answer as the Node ports return it: the SDK's JSON (PascalCase; ECS and EKS camelCase), dates
  as ISO strings, Price List products as JSON strings.
- An \`error\` is \`{"name", "message"}\`, with \`"status"\` and \`"reason"\` for a Kubernetes one (\`KubernetesError\`):
  the call fails with it (Node throws an \`Error\` with these fields; the Go fake returns an error carrying them, its
  message the \`message\`).
- Port methods:
${Object.entries(PORTS).map(([port, methods]) => `  - ${methods.map((m) => `\`${port}.${m}\``).join(', ')}`).join('\n')}

${topics.map(({ topic, cases }) => `## \`${topic.name}\`

${topic.readme}

${used(cases).length ? `Recorded answers used: ${used(cases).map((m) => `\`${m}\``).join(', ')}.\n\n` : ''}Cases (${cases.length}):

${cases.map((c) => `- ${c.name}`).join('\n')}
`).join('\n')}
${ESTIMATE}`;
}
