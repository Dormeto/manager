// A model of an AWS region and its EKS clusters, answering the product's calls from data as the Node tests' fakes do
// (discovery test/scan-fakes.ts, kubernetes.test.ts, router test/fakes.mjs): the corpus describes a world with it, the
// export records what the product asks (recorded.mjs). Lists come in pages (Marker, NextToken, nextToken).

export const error = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });
const notFound = (path) => error('KubernetesError', `${path} not found`, { status: 404, reason: 'NotFound' });

// A page of a list from its marker (the index of its first item).
function page(items, marker, size, key, next) {
  const start = Number(marker ?? 0);
  return { [key]: items.slice(start, start + size), ...(start + size < items.length ? { [next]: String(start + size) } : {}) };
}

const selects = (selector, labels = {}) => !selector || selector.split(',').every((term) => {
  const [key, value] = term.split('=');
  return labels[key] === value;
});

// A cluster's API: lists by collection path (filtered by a labelSelector of key=value terms), gets by collection path
// and name; refuse: every call fails with it; fail: a path's calls fail with their error; karpenter: its API is there.
function kubernetesOf(cluster, { path, query }, method) {
  if (cluster.refuse) throw cluster.refuse;
  if (cluster.fail?.[path]) throw cluster.fail[path];
  if (method === 'get') {
    if (path === '/apis/karpenter.sh/v1') {
      if (cluster.karpenter) return { kind: 'APIResourceList' };
      throw notFound(path);
    }
    const at = path.lastIndexOf('/');
    const found = (cluster.objects[path.slice(0, at)] ?? []).find((o) => o.metadata?.name === path.slice(at + 1));
    if (!found) throw notFound(path);
    return found;
  }
  if (!(path in cluster.objects)) {
    if (path.includes('keda.sh')) throw notFound(path);
    return [];
  }
  return cluster.objects[path].filter((o) => selects(query?.labelSelector, o.metadata?.labels));
}

// The CloudWatch results of a GetMetricData call: metric(query, input) gives a query's fields ({ Timestamps, Values,
// StatusCode, Messages }), answered as they are on one page; past `size` values, in pages of `size` (query order, then
// time), as CloudWatch pages a large answer.
function metricData(input, metric, size) {
  const results = input.MetricDataQueries.map((q) => ({ Id: q.Id, ...metric(q, input) }));
  const points = results.flatMap((r) => (r.Timestamps ?? []).map((t, i) => ({ id: r.Id, t, v: r.Values[i] })));
  if (points.length <= size) return { MetricDataResults: results };
  const start = Number(input.NextToken ?? 0);
  const slice = points.slice(start, start + size);
  const more = start + size < points.length;
  const out = results.map((r) => {
    if (!r.Timestamps || (r.StatusCode && r.StatusCode !== 'Complete')) return start ? null : r;
    const mine = slice.filter((p) => p.id === r.Id);
    if (start && !mine.length) return null;
    return { Id: r.Id, StatusCode: more ? 'PartialData' : 'Complete', Timestamps: mine.map((p) => p.t), Values: mine.map((p) => p.v) };
  }).filter(Boolean);
  return { MetricDataResults: out, ...(more ? { NextToken: String(start + size) } : {}) };
}

// A region: load balancers, listeners and rules by ARN, target groups, tags and targets by ARN, Auto Scaling groups,
// instances, security groups (the groups each lets in), ECS clusters with their services and task definitions, RDS
// instances and clusters, EKS clusters (description, objects), metrics; fail: calls that fail (call name → error or
// input → error); page: the lists' page size.
export function regionModel(spec) {
  const size = spec.page ?? 100;
  const ecsCluster = (cluster) => Object.keys(spec.ecsClusters ?? {}).find((arn) => arn === cluster || arn.split('/').at(-1) === cluster);
  const instances = (ids) => ids.filter((id) => spec.instances?.[id]).map((id) => ({ InstanceId: id, ...spec.instances[id] }));
  const answers = {
    'elbv2.describeLoadBalancers': (i) => page(spec.loadBalancers ?? [], i.Marker, size, 'LoadBalancers', 'NextMarker'),
    'elbv2.describeListeners': (i) => page(spec.listeners?.[i.LoadBalancerArn] ?? [], i.Marker, size, 'Listeners', 'NextMarker'),
    'elbv2.describeRules': (i) => (i.RuleArns
      ? { Rules: Object.values(spec.rules ?? {}).flat().filter((r) => i.RuleArns.includes(r.RuleArn)) }
      : page(spec.rules?.[i.ListenerArn] ?? [], i.Marker, size, 'Rules', 'NextMarker')),
    'elbv2.describeTags': (i) => ({ TagDescriptions: i.ResourceArns.map((a) => ({ ResourceArn: a, Tags: Object.entries(spec.tags?.[a] ?? {}).map(([Key, Value]) => ({ Key, Value })) })) }),
    'elbv2.describeTargetGroups': (i) => page(spec.targetGroups ?? [], i.Marker, size, 'TargetGroups', 'NextMarker'),
    'elbv2.describeTargetHealth': (i) => ({ TargetHealthDescriptions: (spec.targets?.[i.TargetGroupArn] ?? []).map((Id) => ({ Target: { Id }, TargetHealth: { State: 'healthy' } })) }),
    'autoscaling.describeAutoScalingGroups': (i) => (i.AutoScalingGroupNames
      ? { AutoScalingGroups: (spec.autoScalingGroups ?? []).filter((g) => i.AutoScalingGroupNames.includes(g.AutoScalingGroupName)) }
      : page(spec.autoScalingGroups ?? [], i.NextToken, size, 'AutoScalingGroups', 'NextToken')),
    'ec2.describeInstances': (i) => ({ Reservations: [{ Instances: instances(i.InstanceIds) }] }),
    'ec2.describeSecurityGroups': (i) => ({ SecurityGroups: i.GroupIds.filter((id) => spec.securityGroups?.[id]).map((GroupId) => ({ GroupId, IpPermissions: [{ IpProtocol: 'tcp', UserIdGroupPairs: spec.securityGroups[GroupId].map((g) => ({ GroupId: g })) }] })) }),
    'ecs.listClusters': (i) => page(Object.keys(spec.ecsClusters ?? {}), i.nextToken, size, 'clusterArns', 'nextToken'),
    'ecs.listServices': (i) => page((spec.ecsClusters?.[ecsCluster(i.cluster)] ?? []).map((s) => s.serviceArn), i.nextToken, size, 'serviceArns', 'nextToken'),
    'ecs.describeServices': (i) => ({ services: (spec.ecsClusters?.[ecsCluster(i.cluster)] ?? []).filter((s) => i.services.includes(s.serviceArn)) }),
    'ecs.describeTaskDefinition': (i) => ({ taskDefinition: spec.taskDefinitions?.[i.taskDefinition] }),
    'rds.describeDBInstances': (i) => {
      const all = spec.dbInstances ?? [];
      if (i.DBInstanceIdentifier) return { DBInstances: all.filter((d) => d.DBInstanceIdentifier === i.DBInstanceIdentifier) };
      if (i.Filters) return { DBInstances: all.filter((d) => i.Filters[0].Values.includes(d.DBClusterIdentifier)) };
      return page(all, i.Marker, size, 'DBInstances', 'Marker');
    },
    'rds.describeDBClusters': (i) => {
      const all = spec.dbClusters ?? [];
      if (i.DBClusterIdentifier) return { DBClusters: all.filter((d) => d.DBClusterIdentifier === i.DBClusterIdentifier) };
      return page(all, i.Marker, size, 'DBClusters', 'Marker');
    },
    'cloudwatch.getMetricData': (i) => metricData(i, spec.metrics ?? (() => ({ Timestamps: [], Values: [] })), spec.metricsPage ?? 100_800),
    'eks.listClusters': (i) => page(Object.keys(spec.clusters ?? {}), i.nextToken, size, 'clusters', 'nextToken'),
    'eks.describeCluster': (i) => ({ cluster: spec.clusters[i.name].description }),
    'kubernetes.of': (i) => {
      if (spec.clusters?.[i.cluster]?.connect) throw spec.clusters[i.cluster].connect;
      return {};
    },
    'kubernetes.get': (i) => kubernetesOf(spec.clusters[i.cluster], i, 'get'),
    'kubernetes.list': (i) => kubernetesOf(spec.clusters[i.cluster], i, 'list'),
  };
  return (call, input) => {
    const failure = typeof spec.fail?.[call] === 'function' ? spec.fail[call](input) : spec.fail?.[call];
    if (failure) throw failure;
    return answers[call]?.(input);
  };
}

// A described EKS cluster, public to everyone unless its VPC configuration says otherwise.
export const eksCluster = (name, vpc = { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], vpcId: 'vpc-1' }) => ({
  name, endpoint: `https://${name}.example`, version: '1.36', certificateAuthority: { data: '' }, resourcesVpcConfig: vpc, accessConfig: { authenticationMode: 'API' },
});

// A product as the Price List API answers it (a JSON string), with one on-demand term.
export const product = (attributes, usd, unit = 'Hrs') => JSON.stringify({
  product: { attributes },
  terms: { OnDemand: { 'X.JRTCKXETXF': { priceDimensions: { 'X.JRTCKXETXF.6YS6EN2CT7': { unit, pricePerUnit: { USD: usd } } } } } },
});

// A GetProducts input as the Node tests read it: the service code and each filter's value (~ before a CONTAINS field).
export const filtersOf = (input) => Object.fromEntries([['ServiceCode', input.ServiceCode], ...input.Filters.map((f) => [`${f.Type === 'CONTAINS' ? '~' : ''}${f.Field}`, f.Value])]);
