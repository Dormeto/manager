// The README of the shared cases (testdata/parity/README.md in the CLI), written with them: what the Go side needs to
// replay each topic, from the files alone.
import { PORTS } from './recorded.mjs';

// The port methods a topic's cases record answers for.
const used = (cases) => [...new Set(cases.flatMap((c) => Object.keys(c.input.answers ?? {})))].sort();

export function readme({ manager, router, commit, now, topics }) {
  return `# Shared cases

Manager ${manager}, router ${router}, manager commit \`${commit}\`.

Written by the manager's \`scripts/parity/export.mjs\`: the product's Node functions run over the corpus of
\`scripts/parity/cases/\`, each case's input and output as JSON. Do not edit these files: export them again in the
manager (\`npm ci\`, then \`node scripts/parity/export.mjs --out ../cli/testdata/parity\`) and commit them here.

## Files

- \`<topic>.json\`: \`{"manager", "router", "commit", "cases": [{"name", "input", "output"}]}\`, one per topic below
  (\`internal/parity\` \`Load\`).
- \`versions.json\`: \`{"manager", "router", "commit"}\` (\`dormeto version\`).
- \`cache/\`: the cache directory the Node estimate wrote for the first \`estimate\` case (its \`cacheRoot\`, same layout:
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
`).join('\n')}`;
}
