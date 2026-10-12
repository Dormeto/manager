// Recorded AWS and Kubernetes answers (vision docs/specs/2026-10-13-cli-design.md §6), the ports the shared cases give
// the product's Node code and, in Go, internal/parity's Recorded: {"<port>.<method>": [{input, output} | {input,
// error}]}. A call is answered by the first entry whose input equals its own (JSON with sorted keys, as Node writes it:
// dates as toISOString(), undefined fields dropped); a call without one fails. The recorder writes them from a model of
// an AWS world (the corpus), so a case holds exactly the calls the product made.

// The ports and methods the product's code calls, as its Node ports name them: an answer for anything else is a typo.
export const PORTS = {
  elbv2: ['describeLoadBalancers', 'describeListeners', 'describeRules', 'describeTags', 'describeTargetGroups', 'describeTargetHealth'],
  autoscaling: ['describeAutoScalingGroups'],
  ec2: ['describeInstances', 'describeSecurityGroups', 'describeRegions'],
  ecs: ['listClusters', 'listServices', 'describeServices', 'describeTaskDefinition'],
  rds: ['describeDBInstances', 'describeDBClusters'],
  cloudwatch: ['getMetricData'],
  eks: ['listClusters', 'describeCluster'],
  // A cluster's API: its client made (kubernetesOf), then GETs of one object and lists of a collection.
  kubernetes: ['of', 'get', 'list'],
  pricing: ['getProducts'],
  spot: ['history'],
  sts: ['getCallerIdentity', 'assumeRole'],
  organizations: ['describeOrganization', 'listRoots', 'listOrganizationalUnitsForParent', 'listAccountsForParent', 'listTagsForResource'],
};
const KNOWN = new Set(Object.entries(PORTS).flatMap(([port, methods]) => methods.map((m) => `${port}.${m}`)));

// JSON with every object's keys sorted: two equal inputs write the same text.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// A value as JSON gives it back: what a case holds.
export const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// An AWS or Kubernetes error as recorded: its name and message, and the status and reason a Kubernetes one carries.
const errorOf = (err) => ({
  name: err?.name ?? 'Error', message: String(err?.message ?? err),
  ...Object.fromEntries(['status', 'reason', 'code'].filter((k) => err?.[k] !== undefined).map((k) => [k, err[k]])),
});
const thrown = (recorded) => Object.assign(new Error(recorded.message), recorded);

// The ports over call(name, input): each method's arguments as one JSON input. Spot price history takes its region
// apart ({region, input}); a cluster's client is asked for by name, its calls carry it ({cluster, path[, query]}).
function portsOver(call) {
  const ports = {};
  for (const [port, methods] of Object.entries(PORTS)) {
    if (port === 'kubernetes') continue;
    ports[port] = Object.fromEntries(methods.map((method) => [method, (arg) => call(`${port}.${method}`, arg === undefined ? {} : json(arg))]));
  }
  ports.spot.history = (region, input) => call('spot.history', json({ region, input }));
  ports.kubernetesOf = async (cluster) => {
    await call('kubernetes.of', { cluster });
    return {
      get: (path) => call('kubernetes.get', { cluster, path }),
      list: (path, query) => call('kubernetes.list', json(query === undefined ? { cluster, path } : { cluster, path, query })),
    };
  };
  // The estimate's world: calls made in an account and region, their input inside; Spot price history in the region it
  // names, from that account.
  ports.at = (account, region) => portsOver((name, input) => (name === 'spot.history'
    ? call(name, { account, region: input.region, input: input.input })
    : call(name, { account, region, input })));
  return ports;
}

const describe = (name, input) => `${name}(${JSON.stringify(input)})`;

export function recordedPorts(answers = {}) {
  for (const name of Object.keys(answers)) if (!KNOWN.has(name)) throw new Error(`unknown port method ${name} in the recorded answers`);
  const index = Object.fromEntries(Object.entries(answers).map(([name, entries]) => [name, entries.map((e) => ({ key: canonical(e.input), entry: e }))]));
  const missed = [];
  const ports = portsOver(async (name, input) => {
    const key = canonical(input);
    const found = (index[name] ?? []).find((e) => e.key === key)?.entry;
    if (!found) {
      missed.push({ call: name, input });
      throw new Error(`no recorded answer for ${describe(name, input)}`);
    }
    if (found.error) throw thrown(found.error);
    return json(found.output);
  });
  // The calls no entry answered: the product may catch their failure, the export may not.
  ports.missed = () => missed;
  return ports;
}

// model(name, input): the answer (or a throw, AWS's error); undefined when the model does not know the call (a gap of
// the corpus, never recorded as an answer).
export function recorder(model) {
  const recorded = new Map();
  const gaps = [];
  const ports = portsOver(async (name, input) => {
    let output;
    let error;
    try {
      output = await model(name, json(input));
      if (output === undefined) {
        gaps.push({ call: name, input });
        throw Object.assign(new Error(`the model has no answer for ${describe(name, input)}`), { gap: true });
      }
    } catch (err) {
      if (err?.gap) throw err;
      error = errorOf(err);
    }
    const entry = error ? { input, error } : { input, output: json(output) };
    const entries = recorded.get(name) ?? [];
    const known = entries.find((e) => canonical(e.input) === canonical(input));
    if (known && canonical(known) !== canonical(entry)) throw new Error(`the model answered ${describe(name, input)} two ways: a replay could not tell them apart`);
    if (!known) recorded.set(name, [...entries, entry]);
    if (error) throw thrown(error);
    return json(entry.output);
  });
  return {
    ports,
    // By port and method name, each method's entries in the order of their first call.
    answers: () => Object.fromEntries([...recorded].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entries]) => [name, json(entries)])),
    gaps: () => gaps,
  };
}
