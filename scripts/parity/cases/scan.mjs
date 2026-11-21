// Discovery's scan of a region (discovery src/scan.ts, kubernetes.ts, filters.ts, org.ts): the cases of discovery
// test/scan.test.ts (its region: test/scan-fakes.ts), kubernetes.test.ts, filters.test.ts (fixtures.ts) and org.test.ts,
// and the edge cases of the spec's §6 (Kubernetes owners, an empty region).
import { createHash } from 'node:crypto';
import { eksCluster, error, regionModel } from './aws.mjs';

export const name = 'scan';

// The region of the router discovery cases (scan-fakes.ts): one application load balancer, a network one, pages of 5.
const P = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333';
const LB = `${P}:loadbalancer/app/web/abc`;
const L443 = `${P}:listener/app/web/abc/l443`;
const L80 = `${P}:listener/app/web/abc/l80`;
const tg = (tgName, type = 'instance') => ({ TargetGroupArn: `${P}:targetgroup/${tgName}/1`, TargetGroupName: tgName, TargetType: type });
const TGS = {
  shop: tg('shop'), api: tg('api', 'ip'), batch: tg('batch'), fn: tg('fn', 'lambda'), shared: tg('shared'), orphan: tg('orphan', 'ip'),
  empty: tg('empty'), demo: tg('demo-app'), waker: tg('dmt-dev-demo', 'lambda'), green: tg('green'), blue: tg('blue'),
};
const forward = (...groups) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: groups.map(([g, w]) => ({ TargetGroupArn: TGS[g].TargetGroupArn, Weight: w })) } }];
const host = (...h) => [{ Field: 'host-header', HostHeaderConfig: { Values: h } }];
const BATCH_ASG_ARN = 'arn:aws:autoscaling:eu-west-1:111122223333:autoScalingGroup:6d4f2c1e-0000-4000-8000-000000000001:autoScalingGroupName/batch-asg';
const DEMO = { RuleArn: 'r-demo', Priority: '10', Conditions: host('dev.example.com'), Actions: forward(['demo', 1], ['waker', 0]) };
const rules = (demo = DEMO) => ({
  [L80]: [{ RuleArn: 'r80', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'redirect', Order: 1 }] }],
  [L443]: [
    demo,
    { RuleArn: 'r-admin', Priority: '5', Conditions: host('dev.example.com'), Actions: forward(['waker', 1]) },
    { RuleArn: 'r-shop', Priority: '20', Conditions: host('shop.example.com', 'www.shop.example.com'), Actions: [{ Type: 'forward', Order: 1, TargetGroupArn: TGS.shop.TargetGroupArn }] },
    { RuleArn: 'r-api', Priority: '30', Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }], Actions: forward(['api', 1]) },
    { RuleArn: 'r-batch', Priority: '40', Conditions: [{ Field: 'host-header', Values: ['batch.example.com'] }], Actions: forward(['batch', 1]) },
    { RuleArn: 'r-canary', Priority: '50', Conditions: host('canary.example.com'), Actions: forward(['shop', 0], ['green', 1], ['blue', 1]) },
    { RuleArn: 'r-fn', Priority: '60', Conditions: host('fn.example.com'), Actions: forward(['fn', 1]) },
    { RuleArn: 'r-shared-1', Priority: '70', Conditions: host('a.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-shared-2', Priority: '71', Conditions: host('b.example.com'), Actions: forward(['shared', 1]) },
    { RuleArn: 'r-orphan', Priority: '80', Conditions: host('orphan.example.com'), Actions: forward(['orphan', 1]) },
    { RuleArn: 'r-empty', Priority: '90', Conditions: host('empty.example.com'), Actions: forward(['empty', 1]) },
    { RuleArn: 'r-fixed', Priority: '95', Conditions: host('down.example.com'), Actions: [{ Type: 'fixed-response', Order: 1 }] },
    { RuleArn: 'r-default', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response', Order: 1 }] },
  ],
});
const TAGS = {
  'r-demo': { 'dormeto:workload': 'demo' },
  'r-admin': { 'dormeto:workload': 'demo', 'dormeto:role': 'admin' },
  [LB]: { env: 'dev', team: 'web' },
  [TGS.shop.TargetGroupArn]: { team: 'shop' },
  'r-shop': { env: 'preview' },
};
const TARGETS = { shop: ['i-shop'], api: ['10.0.1.5'], batch: [], shared: ['i-s'], orphan: ['10.0.9.9'], empty: [], demo: ['i-demo'], green: ['i-g'], blue: ['i-b'] };
const dimension = (q, d) => q.MetricStat.Metric.Dimensions.find((x) => x.Name === d).Value;

function routerRegion({ hourly = {}, demo, tags = TAGS, groups, instances, clusters, fail } = {}) {
  return {
    page: 5,
    loadBalancers: [{ LoadBalancerArn: LB, LoadBalancerName: 'web', Type: 'application' }, { LoadBalancerArn: `${P}:loadbalancer/net/nlb/x`, LoadBalancerName: 'nlb', Type: 'network' }],
    listeners: { [LB]: [{ ListenerArn: L80, Port: 80, Protocol: 'HTTP' }, { ListenerArn: L443, Port: 443, Protocol: 'HTTPS' }] },
    rules: rules(demo),
    targetGroups: Object.values(TGS),
    tags,
    targets: Object.fromEntries(Object.entries(TARGETS).map(([k, ids]) => [TGS[k].TargetGroupArn, ids])),
    autoScalingGroups: [{ AutoScalingGroupName: 'batch-asg', AutoScalingGroupARN: BATCH_ASG_ARN, TargetGroupARNs: [TGS.batch.TargetGroupArn], ...(groups ?? {}) }],
    ecsClusters: { 'arn:aws:ecs:eu-west-1:111122223333:cluster/main': [{ serviceArn: 'arn:aws:ecs:eu-west-1:111122223333:service/main/api', loadBalancers: [{ targetGroupArn: TGS.api.TargetGroupArn }] }] },
    metrics: (q) => ({ Values: hourly[dimension(q, 'TargetGroup')] ?? [] }),
    instances, clusters, fail,
  };
}

// The demo cluster of kubernetes.test.ts: web (a Deployment behind a grouped Ingress, an HPA, Argo CD), cache (a
// StatefulSet behind a lone Ingress, on Fargate), and pods Dormeto must not take for workloads.
const NS = 'demo';
const pod = (podName, ip, owner, extra = {}) => ({
  metadata: { name: podName, namespace: NS, labels: { app: podName.split('-')[0] }, ...(owner ? { ownerReferences: [{ kind: owner.kind, name: owner.name, controller: true }] } : {}) },
  spec: { nodeName: 'ip-10-0-1-1.eu-west-1.compute.internal', schedulerName: 'default-scheduler', ...extra },
  status: { phase: 'Running', podIP: ip },
});
const rs = (rsName, deployment) => ({ metadata: { name: rsName, namespace: NS, ownerReferences: [{ kind: 'Deployment', name: deployment, controller: true }] } });
const owner = (kind, ownerName, metadata = {}) => ({ kind, metadata: { name: ownerName, namespace: NS, ...metadata }, spec: { replicas: 2, selector: { matchLabels: { app: ownerName } } } });
const ingress = (ingressName, service, annotations = {}) => ({
  metadata: { name: ingressName, namespace: NS, annotations },
  spec: { rules: [
    { host: 'docs.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'docs', port: { number: 80 } } } }] } },
    { host: `${service}.example.com`, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: service, port: { number: 80 } } } }] } },
  ] },
});
const service = (serviceName, selector) => ({ metadata: { name: serviceName, namespace: NS }, spec: { selector, ports: [{ port: 80 }] } });
const demo = (extra = {}) => ({
  '/api/v1/pods': [
    pod('web-5d9c-a1', '10.0.1.1', { kind: 'ReplicaSet', name: 'web-5d9c' }), pod('web-5d9c-a2', '10.0.1.2', { kind: 'ReplicaSet', name: 'web-5d9c' }),
    pod('cache-0', '10.0.2.1', { kind: 'StatefulSet', name: 'cache' }, { schedulerName: 'fargate-scheduler', nodeName: 'fargate-ip-10-0-2-1.eu-west-1.compute.internal' }),
    pod('agent-x1', '10.0.3.1', { kind: 'DaemonSet', name: 'agent' }), pod('migrate-q', '10.0.3.2', { kind: 'Job', name: 'migrate' }), pod('lonely', '10.0.3.3'),
    pod('api-1a-b', '10.0.4.1', { kind: 'ReplicaSet', name: 'api-1a' }), pod('api2-2b-c', '10.0.4.2', { kind: 'ReplicaSet', name: 'api2-2b' }),
  ],
  [`/apis/apps/v1/namespaces/${NS}/replicasets`]: [rs('web-5d9c', 'web'), rs('api-1a', 'api'), rs('api2-2b', 'api2')],
  [`/apis/apps/v1/namespaces/${NS}/deployments`]: [
    owner('Deployment', 'web', { labels: { 'app.kubernetes.io/instance': 'web' }, annotations: { 'argocd.argoproj.io/tracking-id': 'web:apps/Deployment:demo/web' } }),
    owner('Deployment', 'api'), owner('Deployment', 'api2'),
  ],
  [`/apis/apps/v1/namespaces/${NS}/statefulsets`]: [owner('StatefulSet', 'cache', { labels: { 'kustomize.toolkit.fluxcd.io/name': 'apps' } })],
  [`/api/v1/namespaces/${NS}/services`]: [service('web', { app: 'web' }), service('cache', { app: 'cache' })],
  [`/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`]: [
    ingress('web', 'web', { 'alb.ingress.kubernetes.io/group.name': 'demo-group', 'alb.ingress.kubernetes.io/group.order': '10' }),
    ingress('cache', 'cache'),
  ],
  [`/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers`]: [{ metadata: { name: 'web' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' } } }],
  [`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`]: [],
  ...extra,
});
const PRIVATE = { endpointPublicAccess: false, endpointPrivateAccess: true, vpcId: 'vpc-1' };
const NO_PROXY = error('KubernetesError', 'the cluster\'s endpoint is private and its proxy dmt-dev-kube-unproxied is not set up: upgrade the router or set up its cluster access (Terraform: module kubernetes-proxy)', { status: 0, reason: 'NoProxy' });
const UNAUTHORIZED = error('KubernetesError', 'Unauthorized', { status: 401, reason: 'Unauthorized' });
// The discovery role may invoke only functions tagged as proxies, and Lambda checks the rights first: an absent proxy (no tag)
// or an older organization access answers AccessDeniedException, as the router's transport maps it (ruling 23).
const INVOKE_DENIED = error('KubernetesError', 'GET /api/v1/pods: the proxy dmt-dev-kube-refused failed: User: arn:aws:sts::111122223333:assumed-role/DmtDiscoveryRole/dmt-dev-discovery is not authorized to perform: lambda:InvokeFunction on resource: arn:aws:lambda:eu-west-1:111122223333:function:dmt-dev-kube-refused because no identity-based policy allows the lambda:InvokeFunction action', { status: 0, reason: 'AccessDeniedException' });
const ready = (objects, more = {}) => ({ description: eksCluster('eks-demo'), objects, karpenter: true, ...more });
const ARN = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup';
const group = (groupName, type, targets, tags = {}) => ({ arn: `${ARN}/${groupName}/1`, type, vpcId: 'vpc-1', tags, targets });
const controllerTags = (resource) => ({ 'elbv2.k8s.aws/cluster': 'eks-demo', 'ingress.k8s.aws/stack': 'demo-group', 'ingress.k8s.aws/resource': resource });

// An onboarded Ingress workload (kubernetes.test.ts): the controller's rules in a group, Dormeto's target group and the
// waker's, before the customer rule it shadows.
function ingressRegion(groupRules, awake = true) {
  const tgOf = (tgName, type, targets, tags) => ({ group: { TargetGroupArn: `${ARN}/${tgName}/1`, TargetGroupName: tgName, TargetType: type }, targets, tags });
  const customer = tgOf('k8s-demo-web-c', 'ip', ['10.0.1.1', '10.0.1.2'], controllerTags('demo/web-web:80'));
  const dormeto = tgOf('k8s-demo-web-d', 'ip', ['10.0.1.1', '10.0.1.2'], controllerTags('demo/dormeto-wl1-web:80'));
  const waker = tgOf('dmt-dev-wl1', 'lambda', [], { 'dormeto:workload': 'wl1', 'dormeto:router': 'dmt-dev' });
  const all = [customer, dormeto, waker];
  const L = `${ARN.replace(':targetgroup', ':listener')}/app/group/1/l443`;
  const lb = `${ARN.replace(':targetgroup', ':loadbalancer')}/app/group/1`;
  const conditions = [{ Field: 'host-header', HostHeaderConfig: { Values: ['web.example.com'] } }, { Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } }];
  const fwd = (...pairs) => [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: pairs.map(([g, w]) => ({ TargetGroupArn: g.group.TargetGroupArn, Weight: w })) } }];
  const base = routerRegion({ clusters: { 'eks-demo': ready(demo(awake ? {} : { '/api/v1/pods': [] })) } });
  return {
    ...base, page: 100,
    loadBalancers: [{ LoadBalancerArn: lb, LoadBalancerName: 'group', Type: 'application' }],
    listeners: { [lb]: [{ ListenerArn: L, Port: 443, Protocol: 'HTTPS' }] },
    rules: { [L]: [...groupRules({ customer, dormeto, waker, conditions, fwd }), { RuleArn: 'r-default', Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response', Order: 1 }] }] },
    targetGroups: all.map((g) => g.group),
    tags: Object.fromEntries(all.map((g) => [g.group.TargetGroupArn, g.tags])),
    targets: Object.fromEntries(all.map((g) => [g.group.TargetGroupArn, awake ? g.targets : []])),
  };
}
const grouped = (app, wake) => ({ dormeto, customer, waker, conditions, fwd }) => [
  { RuleArn: 'r-dormeto', Priority: '1', Conditions: conditions, Actions: fwd([dormeto, app], [waker, wake]) },
  { RuleArn: 'r-customer', Priority: '2', Conditions: conditions, Actions: fwd([customer, 1]) },
];

// The organization of fixtures.ts: root, a chain of five nested OUs, a sibling OU; three accounts.
const ROOT = 'r-1u0b';
const [OU1, OU2, OU3, OU4, OU5, PROD] = ['ou-1u0b-aaaaaaa1', 'ou-1u0b-aaaaaaa2', 'ou-1u0b-aaaaaaa3', 'ou-1u0b-aaaaaaa4', 'ou-1u0b-aaaaaaa5', 'ou-1u0b-pppppppp'];
const A = { id: '111111111111', name: 'tools', ouPath: [ROOT], tags: {} };
const B = { id: '222222222222', name: 'deep', ouPath: [ROOT, OU1, OU2, OU3, OU4, OU5], tags: { env: 'dev' } };
const C = { id: '333333333333', name: 'shop-prod', ouPath: [ROOT, PROD], tags: { env: 'prod', team: 'shop' } };
const INVENTORY = {
  accounts: [A, B, C],
  ous: { [ROOT]: { name: 'Root', parent: null }, [OU1]: { name: 'one', parent: ROOT }, [OU2]: { name: 'two', parent: OU1 }, [OU3]: { name: 'three', parent: OU2 }, [OU4]: { name: 'four', parent: OU3 }, [OU5]: { name: 'five', parent: OU4 }, [PROD]: { name: 'prod', parent: ROOT } },
};
const rule = (over = {}) => ({
  id: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:listener-rule/app/web-shop/1/2/3', account: A.id, region: 'eu-west-1', loadBalancer: 'web-shop',
  loadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/web-shop/1', listener: 'HTTPS:443', priority: '10', conditions: 'host shop.example.com',
  hosts: ['shop.example.com'], targetGroup: 'shop', targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/1', backend: { kind: 'instance', id: 'i-1' },
  tags: { env: ['preview'] }, rules: [], eligibility: 'eligible', idleHours7d: 100, requests7d: 10, ...over,
});
const config = (over = {}) => ({ version: 1, mode: 'organization', regions: ['eu-west-1', 'eu-west-3'], refreshHours: 24, globalExcludes: [], filters: [], ...over });
const filter = (filterName, include, exclude = []) => ({ name: filterName, include, exclude });
const REGIONS = { [A.id]: ['eu-west-1', 'us-east-1'], [B.id]: ['eu-west-1'], [C.id]: ['eu-west-1'] };

// The organization of org.test.ts: two accounts at the root (one suspended), an OU with one, a nested one with three
// (two pages of two).
const OUS = { 'r-1u0b': [{ Id: 'ou-1u0b-aaaaaaaa', Name: 'a' }], 'ou-1u0b-aaaaaaaa': [{ Id: 'ou-1u0b-bbbbbbbb', Name: 'b' }], 'ou-1u0b-bbbbbbbb': [] };
const MEMBERS = {
  'r-1u0b': [{ Id: '100000000001', Name: 'one', State: 'ACTIVE' }, { Id: '100000000002', Name: 'two', State: 'SUSPENDED' }],
  'ou-1u0b-aaaaaaaa': [{ Id: '100000000003', Name: 'three', State: 'ACTIVE' }],
  'ou-1u0b-bbbbbbbb': [{ Id: '100000000004', Name: 'four', State: 'ACTIVE' }, { Id: '100000000005', Name: 'five', Status: 'ACTIVE' }, { Id: '100000000006', Name: 'six', State: 'ACTIVE' }],
};
const organizations = (call, input) => {
  const paged = (items) => {
    const start = Number(input.NextToken ?? 0);
    return { items: items.slice(start, start + 2), next: start + 2 < items.length ? { NextToken: String(start + 2) } : {} };
  };
  if (call === 'organizations.listRoots') return { Roots: [{ Id: 'r-1u0b', Name: 'Root' }] };
  if (call === 'organizations.listOrganizationalUnitsForParent') { const p = paged(OUS[input.ParentId] ?? []); return { OrganizationalUnits: p.items, ...p.next }; }
  if (call === 'organizations.listAccountsForParent') { const p = paged(MEMBERS[input.ParentId] ?? []); return { Accounts: p.items, ...p.next }; }
  if (call === 'organizations.listTagsForResource') return { Tags: input.ResourceId === '100000000004' ? [{ Key: 'env', Value: 'dev' }] : [] };
  return undefined;
};

export function cases(now) {
  const WHERE = { account: '111122223333', region: 'eu-west-1' };
  const BASE = ['elbv2', 'autoscaling', 'ecs', 'cloudwatch'];
  const scan = (title, spec, { ports = BASE, reader, router, fails } = {}) => ({
    name: `scanRegion: ${title}`, input: { function: 'scanRegion', where: WHERE, now, ports, ...(reader ? { reader } : {}), ...(router ? { router } : {}) }, model: regionModel(spec), ...(fails ? { fails } : {}),
  });
  const K = [...BASE, 'kubernetes'];
  const backend = (title, clusters, groups, reader) => ({ name: `kubernetesBackend: ${title}`, input: { function: 'kubernetesBackend', where: WHERE, groups, ...(reader ? { reader } : {}) }, model: regionModel({ clusters }) });
  const m = (title, criterion, account = A, r = rule()) => ({ name: `matches: ${title}`, input: { function: 'matches', criterion, account, rule: r, inventory: INVENTORY } });
  const decide = (title, cfg) => ({ name: `decide: ${title}`, input: { function: 'decide', config: cfg, account: A, rule: rule(), inventory: INVENTORY } });
  const plans = (title, cfg) => [
    { name: `scanAccounts: ${title}`, input: { function: 'scanAccounts', config: cfg, inventory: INVENTORY } },
    { name: `targetPairs: ${title}`, input: { function: 'targetPairs', config: cfg, inventory: INVENTORY, enabledRegions: REGIONS } },
  ];
  const nodeTags = (id) => (id === 'i-shop' ? [{ Key: 'kubernetes.io/cluster/eks-demo', Value: 'owned' }] : id === 'i-s' ? [{ Key: 'karpenter.sh/nodepool', Value: 'demo' }, { Key: 'eks:eks-cluster-name', Value: 'eks-demo' }] : []);
  const other = [{ Field: 'host-header', HostHeaderConfig: { Values: ['other.example.com'] } }];
  return [
    scan('the region of the router discovery cases: one candidate per application target group, one per rule forwarding to none', routerRegion()),
    scan('the idle hours of the last 7 days, for eligible and managed target groups only', routerRegion({ hourly: { 'targetgroup/shop/1': [5, 0, 3], 'targetgroup/demo-app/1': [] } })),
    scan('a managed rule that no longer forwards to its application', routerRegion({ demo: { ...DEMO, Actions: [{ Type: 'redirect', Order: 1 }] } })),
    scan('a sleeping managed workload: its application target group, not the waker', routerRegion({ demo: { ...DEMO, Actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: TGS.demo.TargetGroupArn, Weight: 0 }, { TargetGroupArn: TGS.waker.TargetGroupArn, Weight: 1 }] } }] } })),
    scan('an empty region', { loadBalancers: [], ecsClusters: {}, autoScalingGroups: [] }),
    scan('a region with a network load balancer only, and clusters none can read', { loadBalancers: [{ LoadBalancerArn: `${P}:loadbalancer/net/nlb/x`, LoadBalancerName: 'nlb', Type: 'network' }], clusters: { 'eks-private': { description: eksCluster('eks-private', PRIVATE), objects: {} } } }, { ports: K }),
    scan('load balancers refused: the region fails', { fail: { 'elbv2.describeLoadBalancers': error('AccessDenied', 'User: arn:aws:sts::111122223333:assumed-role/ReadOnly/x is not authorized to perform: elasticloadbalancing:DescribeLoadBalancers') } }, { fails: true }),
    scan('IP targets traced to their Kubernetes owner', routerRegion({ clusters: { 'eks-demo': ready(demo({ '/api/v1/pods': [pod('web-5d9c-a1', '10.0.9.9', { kind: 'ReplicaSet', name: 'web-5d9c' })] })) } }), { ports: K }),
    scan('a cluster it cannot read leaves its target groups ineligible, the rest scanned', routerRegion({
      tags: { ...TAGS, [TGS.orphan.TargetGroupArn]: { 'elbv2.k8s.aws/cluster': 'eks-demo' } }, clusters: { 'eks-demo': ready({}, { refuse: UNAUTHORIZED }) },
    }), { ports: K }),
    scan('a discovery role without EKS rights scans the region as before', routerRegion({ fail: { 'eks.listClusters': error('AccessDeniedException', 'not authorized to perform: eks:ListClusters') } }), { ports: K }),
    scan('the clusters as read, who reads them named in the reason of one refused', routerRegion({ clusters: { 'eks-demo': ready(demo()), 'eks-prod': { description: eksCluster('eks-prod'), objects: {}, refuse: UNAUTHORIZED } } }), { ports: K, reader: 'the profile' }),
    scan('instance targets that are a cluster\'s nodes, and a node group\'s Auto Scaling group, never offered to nap', routerRegion({
      groups: { Tags: [{ Key: 'eks:cluster-name', Value: 'eks-demo' }, { Key: 'eks:nodegroup-name', Value: 'system' }] },
      instances: Object.fromEntries(['i-shop', 'i-s', 'i-demo', 'i-g', 'i-b'].map((id) => [id, { Tags: nodeTags(id) }])),
      clusters: { 'eks-demo': ready(demo()) },
    }), { ports: [...K, 'ec2'] }),
    scan('an onboarded Ingress workload, awake: managed by its waker target group, the customer rule it shadows with it', ingressRegion(grouped(1, 0)), { ports: K }),
    scan('an onboarded Ingress workload, asleep', ingressRegion(grouped(0, 1), false), { ports: K }),
    scan('a lone Ingress patched: its own rule forwards to its target group and the waker', ingressRegion(({ customer, waker, conditions, fwd }) => [{ RuleArn: 'r-solo', Priority: '1', Conditions: conditions, Actions: fwd([customer, 1], [waker, 0]) }]), { ports: K }),
    scan('a customer rule with other conditions is not the workload\'s', ingressRegion((r) => [...grouped(1, 0)(r), { RuleArn: 'r-other', Priority: '3', Conditions: other, Actions: r.fwd([r.customer, 1]) }]), { ports: K }),
    { name: 'clustersOf: the region\'s clusters, those it cannot reach or read with the reason', input: { function: 'clustersOf', where: WHERE }, model: regionModel({ clusters: {
      'eks-demo': ready(demo()),
      private: { description: eksCluster('private', PRIVATE), objects: {} },
      office: { description: eksCluster('office', { endpointPublicAccess: true, publicAccessCidrs: ['198.51.100.0/24'], vpcId: 'vpc-1' }), objects: {} },
      denied: { description: eksCluster('denied'), objects: {}, refuse: UNAUTHORIZED },
    } }) },
    { name: 'clustersOf: with the account\'s router, a private cluster is read through its proxy, one without its proxy says so', input: { function: 'clustersOf', where: WHERE, router: 'dmt-dev' }, model: regionModel({ clusters: {
      proxied: { description: eksCluster('proxied', PRIVATE), objects: demo(), karpenter: true },
      limited: { description: eksCluster('limited', { ...PRIVATE, endpointPublicAccess: true, publicAccessCidrs: ['198.51.100.0/24'] }), objects: demo() },
      unproxied: { description: eksCluster('unproxied', PRIVATE), objects: {}, connect: NO_PROXY },
      office: { description: eksCluster('office', { endpointPublicAccess: true, publicAccessCidrs: ['198.51.100.0/24'], vpcId: 'vpc-1' }), objects: {} },
    } }) },
    { name: 'clustersOf: with the account\'s router, a proxy the discovery role may not invoke (absent, or an older organization access) is not set up', input: { function: 'clustersOf', where: WHERE, router: 'dmt-dev' }, model: regionModel({ clusters: {
      refused: { description: eksCluster('refused', PRIVATE), objects: {}, refuse: INVOKE_DENIED },
      proxied: { description: eksCluster('proxied', PRIVATE), objects: demo(), karpenter: true },
    } }) },
    backend('an Ingress in a group: its Deployment, the switch through Dormeto\'s Ingress, HPA, Argo CD, Karpenter', { 'eks-demo': ready(demo()) },
      [group('k8s-demo-web', 'ip', ['10.0.1.1', '10.0.1.2'], controllerTags('demo/web-web:80'))]),
    backend('a lone Ingress (instance targets): its StatefulSet on Fargate, the switch by patching it, Flux', { 'eks-demo': ready(demo(), { karpenter: false }) },
      [group('k8s-demo-cache', 'instance', ['i-0abc'], controllerTags('demo/cache-cache:80'))]),
    backend('KEDA: none in a cluster without its API', { 'eks-demo': ready(Object.fromEntries(Object.entries(demo()).filter(([path]) => !path.includes('keda.sh')))) },
      [group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80'))]),
    backend('KEDA: unknown (null) when the cluster refuses to show its ScaledObjects', { 'eks-demo': ready(demo(), { fail: { [`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`]: error('KubernetesError', 'forbidden', { status: 403, reason: 'Forbidden' }) } }) },
      [group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80'))]),
    backend('a target group no Ingress claims: a TargetGroupBinding; IP targets no pod has, instance targets: not Kubernetes', { 'eks-demo': ready(demo()) },
      [group('bound', 'ip', ['10.0.1.1']), group('other', 'ip', ['10.9.9.9']), group('vm', 'instance', ['i-0aaa'])]),
    backend('what cannot be napped as one owner, with each reason', { 'eks-demo': ready(demo({ [`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`]: [{ metadata: { name: 'web' }, spec: { scaleTargetRef: { name: 'web' }, minReplicaCount: 0 } }] })) },
      [group('x', 'ip', ['10.0.3.1']), group('x', 'ip', ['10.0.3.2']), group('x', 'ip', ['10.0.3.3']), group('x', 'ip', ['10.0.4.1', '10.0.4.2']), group('x', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80'))]),
    backend('a cluster it cannot reach: its target groups ineligible with the cluster\'s reason', { 'eks-demo': { ...ready(demo()), description: eksCluster('eks-demo', PRIVATE) } },
      [group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80')), group('gone', 'ip', ['10.0.1.1'], { 'elbv2.k8s.aws/cluster': 'eks-gone' })]),
    backend('pods gone (a workload asleep): its owner cannot be told', { 'eks-demo': ready(demo({ '/api/v1/pods': [] })) }, [group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80'))]),
    m('an empty criterion matches everything', {}),
    m('account IDs, values being alternatives', { accountIds: [A.id, C.id] }),
    m('another account ID', { accountIds: [C.id] }),
    m('an OU, five levels deep', { ouIds: [OU1] }, B, rule({ account: B.id })),
    m('the deepest OU', { ouIds: [OU5] }, B, rule({ account: B.id })),
    m('an OU the account is not under', { ouIds: [OU1] }, C, rule({ account: C.id })),
    m('the root matches every account', { ouIds: [ROOT] }, C, rule({ account: C.id })),
    m('account tags with given values', { accountTags: { env: ['prod', 'staging'] } }, C),
    m('account tags with another value', { accountTags: { env: ['dev'] } }, C),
    m('an account tag with any value', { accountTags: { team: [] } }, C),
    m('an account tag the account lacks', { accountTags: { team: [] } }, B),
    m('every dimension it sets', { accountIds: [A.id], regions: ['eu-west-1'] }),
    m('a region it does not set', { accountIds: [A.id], regions: ['eu-west-3'] }),
    m('a load balancer name pattern', { loadBalancers: ['web-*'] }),
    m('a load balancer name', { loadBalancers: ['web-shop'] }),
    m('another load balancer name', { loadBalancers: ['web'] }),
    m('a load balancer ARN', { loadBalancers: [rule().loadBalancerArn] }),
    m('another load balancer ARN', { loadBalancers: ['arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/other/1'] }),
    m('a host pattern', { hosts: ['*.example.com'] }),
    m('a host in another case', { hosts: ['SHOP.example.com'] }),
    m('another host pattern', { hosts: ['*.example.org'] }),
    m('a rule without a host condition never matches a host', { hosts: ['*'] }, A, rule({ hosts: [] })),
    m('a resource tag value', { resourceTags: { env: ['preview'] } }),
    m('a resource tag with any value', { resourceTags: { env: [] } }),
    m('another resource tag value', { resourceTags: { env: ['prod'] } }),
    m('a tag value of any of the three resources', { resourceTags: { env: ['prod'] } }, A, rule({ tags: { env: ['prod', 'preview'] } })),
    m('a tag named as an object property', { resourceTags: { constructor: [] } }),
    m('backend kinds', { backendKinds: ['instance', 'asg'] }),
    m('another backend kind', { backendKinds: ['ecs'] }),
    m('backend kinds never match an ineligible rule', { backendKinds: ['instance'] }, A, rule({ eligibility: 'ineligible', backend: null, reason: 'fixed response' })),
    m('a target group name pattern', { targetGroups: ['sh*'] }),
    m('a target group ARN', { targetGroups: ['arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/shop/1'] }),
    m('a target group pattern and a rule without a target group', { targetGroups: ['*'] }, A, rule({ targetGroup: null, targetGroupArn: null })),
    decide('a global exclude wins over any filter, its note in the reason', config({ globalExcludes: [{ note: 'tools account', accountIds: [A.id] }], filters: [filter('all', [{}])] })),
    decide('a global exclude with a label', config({ globalExcludes: [{ label: 'the tools account', accountIds: [A.id] }], filters: [filter('all', [{}])] })),
    decide('a filter\'s exclude applies to that filter only', config({ filters: [filter('dev', [{ accountIds: [A.id] }], [{ backendKinds: ['instance'] }]), filter('preview', [{ resourceTags: { env: ['preview'] } }])] })),
    decide('every including filter excludes it: the filter and exclude numbers', config({ filters: [filter('dev', [{ ouIds: [OU1] }, { accountIds: [A.id] }], [{ regions: ['eu-west-3'] }, { backendKinds: ['instance'] }])] })),
    decide('no filter includes it: out of scope', config({ filters: [filter('prod', [{ ouIds: [PROD] }])] })),
    decide('the include that brought it in scope', config({ filters: [filter('dev', [{ ouIds: [PROD] }, { hosts: ['*.example.com'] }])] })),
    ...plans('nothing scanned without filters', config()),
    ...plans('an account no filter includes', config({ filters: [filter('a', [{ accountIds: [A.id] }])] })),
    ...plans('a globally excluded account, by ID', config({ globalExcludes: [{ accountIds: [A.id] }], filters: [filter('a', [{ accountIds: [A.id, B.id] }])] })),
    ...plans('a globally excluded account, through its OU', config({ globalExcludes: [{ note: 'deep OUs', ouIds: [OU1] }], filters: [filter('b', [{ accountIds: [B.id] }])] })),
    ...plans('an account whose includable regions are all globally excluded', config({ globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('b', [{ accountIds: [B.id], regions: ['eu-west-3'] }])] })),
    ...plans('the same with every region', config({ regions: ['*'], globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('b', [{ accountIds: [B.id], regions: ['eu-west-3'] }])] })),
    ...plans('an account and both its regions globally excluded', config({ globalExcludes: [{ accountIds: [A.id], regions: ['eu-west-1', 'eu-west-3'] }], filters: [filter('a', [{ accountIds: [A.id] }])] })),
    ...plans('every region, one globally excluded', config({ regions: ['*'], globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('b', [{ accountIds: [B.id] }])] })),
    ...plans('a region globally excluded in every account', config({ globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('all', [{ ouIds: [ROOT] }])] })),
    ...plans('a global exclude with a resource dimension keeps the pair', config({ globalExcludes: [{ accountIds: [A.id], backendKinds: ['ecs'] }], filters: [filter('a', [{ accountIds: [A.id] }])] })),
    ...plans('regions no include allows', config({ filters: [filter('a', [{ accountIds: [A.id], regions: ['eu-west-3'] }])] })),
    ...plans('each account\'s enabled regions with every region', config({ regions: ['*'], filters: [filter('a', [{ accountIds: [A.id] }])] })),
    { name: 'resourceTagsMatch: every key, one of its values', input: { function: 'resourceTagsMatch', wanted: { env: ['dev', 'test'], team: [] }, tags: { env: ['test'], team: ['web'] } } },
    { name: 'resourceTagsMatch: a key missing', input: { function: 'resourceTagsMatch', wanted: { env: ['dev'], team: [] }, tags: { env: ['dev'] } } },
    { name: 'resourceTagsMatch: no criterion', input: { function: 'resourceTagsMatch', wanted: {}, tags: {} } },
    { name: 'loadInventory: the OU tree walked, pages followed, each active account with its OU path from the root', input: { function: 'loadInventory', tags: false }, model: organizations },
    { name: 'loadInventory: account tags read when asked', input: { function: 'loadInventory', tags: true }, model: organizations },
    // The standalone scan (vision standalone workloads design §6; discovery test/standalone-scan.test.ts): the router's region
    // with standalone resources beside its load balancer, and their idle share.
    standalone('each kind of resource no route uses, eligible, ineligible in the router\'s words, managed, or left out', standaloneRegion(now, { points: true })),
    standalone('the discovery role without the RDS actions: the other kinds listed, each RDS list said', standaloneRegion(now, {
      fail: { 'rds.describeDBInstances': denied('rds:DescribeDBInstances'), 'rds.describeDBClusters': denied('rds:DescribeDBClusters') },
    })),
    standalone('the ECS services\' tags refused: described without them, said', standaloneRegion(now, {
      fail: { 'ecs.describeServices': (i) => (i.include ? denied('ecs:ListTagsForResource') : undefined) },
    })),
    standalone('CloudWatch failing for the idle share: no share, said', standaloneRegion(now, {
      fail: { 'cloudwatch.getMetricData': (i) => (i.MetricDataQueries[0].MetricStat.Period === 300 ? error('ThrottlingException', 'Rate exceeded') : undefined) },
    })),
  ];

  function standalone(title, spec) {
    return { name: `scanRegion: standalone: ${title}`, input: { function: 'scanRegion', where: WHERE, now, ports: [...BASE, 'ec2', 'rds'], standalone: true }, model: regionModel(spec) };
  }
}

// --- The standalone scan's region (discovery test/standalone-fakes.ts) -----------------------------------------------------
const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';
const sha = (arn) => createHash('sha256').update(arn).digest('hex').slice(0, 16);
const instanceArn = (id) => `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${id}`;
const groupArn = (n) => `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:6d4f2c1e-0000-4000-8000-${String(n.length).padStart(12, '0')}:autoScalingGroupName/${n}`;
const serviceArn = (n) => `arn:aws:ecs:${REGION}:${ACCOUNT}:service/main/${n}`;
const dbArn = (id) => `arn:aws:rds:${REGION}:${ACCOUNT}:db:${id}`;
const clusterArn = (id) => `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:${id}`;
const TCP = { TargetGroupArn: `${P}:targetgroup/tcp/1`, TargetGroupName: 'tcp', TargetType: 'instance', LoadBalancerArns: [`${P}:loadbalancer/net/nlb/x`] };
const tagList = (tags = {}) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const denied = (action) => error('AccessDenied', `User: arn:aws:sts::${ACCOUNT}:assumed-role/DmtDiscoveryRole/dmt-dev-discovery is not authorized to perform: ${action} on resource: *`);
const machine = (over = {}) => ({ State: { Name: over.state ?? 'running' }, RootDeviceType: over.root ?? 'ebs', ...(over.lifecycle ? { InstanceLifecycle: over.lifecycle } : {}), Tags: tagList(over.tags) });
const STANDALONE_INSTANCES = {
  'i-lone': machine({ tags: { Name: 'build-agent', team: 'ci' } }),
  'i-noname': machine(),
  'i-store': machine({ root: 'instance-store' }),
  'i-spot': machine({ lifecycle: 'spot' }),
  'i-both': machine({ root: 'instance-store', lifecycle: 'spot' }),
  'i-nlb': machine(), // in the network load balancer's target group
  'i-shop': machine(), // the HTTP candidate shop's backend: left out
  'i-member': machine({ tags: { 'aws:autoscaling:groupName': 'workers' } }),
  'i-batch': machine({ tags: { 'aws:autoscaling:groupName': 'batch-asg' } }), // its group feeds an HTTP candidate: left out
  'i-node': machine({ tags: { 'eks:cluster-name': 'demo' } }), // a Kubernetes node: left out
  'i-managed': machine({ tags: { 'dormeto:workload': sha(instanceArn('i-managed')), 'dormeto:tagged': 'onboarder' } }),
  'i-companion': machine({ tags: { 'dormeto:workload': '0123456789abcdef' } }), // another workload's: left out
  'i-gone': machine({ state: 'terminated' }),
};
// The 5-minute points of a standalone resource's default signal (CPU, or a database's connections) over the week before
// `now`'s last hour 10 minutes behind: build-agent busy 09:00 to 10:00 UTC each day and missing one point on day 2; shop-db
// without a connection all week but its first hour; every other resource without a point (stopped: no share).
function standaloneMetric(now) {
  const end = Math.floor((Date.parse(now) - 600_000) / 3_600_000) * 3_600_000;
  const start = end - 168 * 3_600_000;
  const series = (value) => {
    const Timestamps = [];
    const Values = [];
    for (let t = start; t < end; t += 300_000) {
      const v = value(t);
      if (v === undefined) continue;
      Timestamps.push(new Date(t).toISOString());
      Values.push(v);
    }
    return { StatusCode: 'Complete', Timestamps, Values };
  };
  return (q) => {
    const d = Object.fromEntries(q.MetricStat.Metric.Dimensions.map((x) => [x.Name, x.Value]));
    if (d.InstanceId === 'i-lone') return series((t) => (t === start + 24 * 3_600_000 + 1_800_000 ? undefined : new Date(t).getUTCHours() === 9 ? 64.5 : 1.25));
    if (d.DBInstanceIdentifier === 'shop-db') return series((t) => (t < start + 3_600_000 ? 2 : 0));
    return { StatusCode: 'Complete', Timestamps: [], Values: [] };
  };
}
// points: the idle share's points (the first case's only: the others say what fails, with no point to read).
function standaloneRegion(now, { fail, points = false } = {}) {
  const base = routerRegion();
  const metric = points ? standaloneMetric(now) : () => ({ StatusCode: 'Complete', Timestamps: [], Values: [] });
  return {
    ...base,
    page: 4,
    // Pages of CloudWatch's answer: the week of two series comes in several (NextToken, PartialData).
    metricsPage: 1500,
    targetGroups: [...base.targetGroups, TCP],
    targets: { ...base.targets, [TCP.TargetGroupArn]: ['i-nlb'] },
    instances: STANDALONE_INSTANCES,
    autoScalingGroups: [
      ...base.autoScalingGroups.map((g) => ({ ...g, Tags: [] })),
      { AutoScalingGroupName: 'workers', AutoScalingGroupARN: groupArn('workers'), TargetGroupARNs: [], Tags: [{ Key: 'team', Value: 'batch', ResourceId: 'workers' }] },
      { AutoScalingGroupName: 'eks-nodes', AutoScalingGroupARN: groupArn('eks-nodes'), TargetGroupARNs: [], Tags: [{ Key: 'eks:nodegroup-name', Value: 'ng-1' }] },
      { AutoScalingGroupName: 'tcp-asg', AutoScalingGroupARN: groupArn('tcp-asg'), TargetGroupARNs: [TCP.TargetGroupArn], Tags: [] },
    ],
    ecsClusters: {
      'arn:aws:ecs:eu-west-1:111122223333:cluster/main': [
        ...base.ecsClusters['arn:aws:ecs:eu-west-1:111122223333:cluster/main'].map((x) => ({ ...x, serviceName: 'api', status: 'ACTIVE', schedulingStrategy: 'REPLICA', tags: [] })),
        { serviceArn: serviceArn('worker'), serviceName: 'worker', status: 'ACTIVE', schedulingStrategy: 'REPLICA', loadBalancers: [], tags: [{ key: 'team', value: 'jobs' }] },
        { serviceArn: serviceArn('agent'), serviceName: 'agent', status: 'ACTIVE', schedulingStrategy: 'DAEMON', loadBalancers: [], tags: [] },
        { serviceArn: serviceArn('old'), serviceName: 'old', status: 'INACTIVE', schedulingStrategy: 'REPLICA', loadBalancers: [], tags: [] },
      ],
    },
    dbInstances: [
      { DBInstanceIdentifier: 'shop-db', DBInstanceArn: dbArn('shop-db'), DBInstanceStatus: 'available', TagList: tagList({ env: 'dev' }) },
      { DBInstanceIdentifier: 'replica', DBInstanceArn: dbArn('replica'), DBInstanceStatus: 'available', ReadReplicaSourceDBInstanceIdentifier: 'shop-db', TagList: [] },
      { DBInstanceIdentifier: 'aurora-1', DBInstanceArn: dbArn('aurora-1'), DBInstanceStatus: 'available', DBClusterIdentifier: 'aurora', TagList: [] },
      { DBInstanceIdentifier: 'companion-db', DBInstanceArn: dbArn('companion-db'), DBInstanceStatus: 'available', TagList: tagList({ 'dormeto:workload': 'demo' }) },
      { DBInstanceIdentifier: 'reports', DBInstanceArn: dbArn('reports'), DBInstanceStatus: 'stopped', TagList: tagList({ 'dormeto:workload': sha(dbArn('reports')) }) },
    ],
    dbClusters: [
      { DBClusterIdentifier: 'aurora', DBClusterArn: clusterArn('aurora'), Status: 'available', EngineMode: 'provisioned', TagList: [] },
      { DBClusterIdentifier: 'serverless', DBClusterArn: clusterArn('serverless'), Status: 'available', EngineMode: 'serverless', TagList: [] },
    ],
    metrics: (q, input) => (q.MetricStat.Period === 300 ? metric(q) : base.metrics(q, input)),
    fail,
  };
}

const clusterView = (clusters) => clusters.map((c) => ({ name: c.name, reason: c.reason ?? null }));
const kubernetesPorts = (ports, { reader, router }) => ({ eks: ports.eks, kubernetesOf: ports.kubernetesOf, ...(router ? { router } : {}), ...(reader ? { reader } : {}) });

export async function run(product, input, ports, context) {
  switch (input.function) {
    case 'scanRegion': {
      const given = Object.fromEntries(input.ports.filter((p) => p !== 'kubernetes').map((p) => [p, ports[p]]));
      if (input.ports.includes('kubernetes')) given.kubernetes = kubernetesPorts(ports, input);
      let clusters = [];
      try {
        // standalone: the standalone scan on; its report (what it could not read) beside the rules.
        let report;
        const rules = await product.scanRegion(given, input.where, {
          now: () => Date.parse(input.now), onClusters: (found) => { clusters = clusterView(found); },
          ...(input.standalone ? { standalone: true, onStandalone: (r) => { report = r; } } : {}),
        });
        return input.standalone ? { rules, clusters, standalone: report } : { rules, clusters };
      } catch (err) {
        if (!context.fails) throw err;
        return { error: { name: err.name, message: err.message } };
      }
    }
    case 'clustersOf': return clusterView(await product.clustersOf(kubernetesPorts(ports, input), input.where));
    case 'kubernetesBackend': {
      const clusters = await product.clustersOf(kubernetesPorts(ports, input), input.where);
      const out = [];
      for (const g of input.groups) out.push(await product.kubernetesBackend(clusters, g));
      return out;
    }
    case 'matches': return product.matches(input.criterion, input.account, input.rule, input.inventory);
    case 'decide': return product.decide(input.config, input.account, input.rule, input.inventory);
    case 'scanAccounts': return product.scanAccounts(input.config, input.inventory);
    case 'targetPairs': return product.targetPairs(input.config, input.inventory, input.enabledRegions);
    case 'resourceTagsMatch': return product.resourceTagsMatch(input.wanted, input.tags);
    case 'loadInventory': return product.loadInventory(ports.organizations, { tags: input.tags });
    default: throw new Error(`unknown function ${input.function}`);
  }
}

export const readme = `Discovery's scan of a region (\`packages/discovery/src/scan.ts\`, \`kubernetes.ts\`, \`filters.ts\`, \`org.ts\`;
Go \`internal/discover\`). \`input.function\` names the function:

- \`scanRegion\` (Go \`discover.ScanRegion\`): \`{where: {account, region}, now, ports, reader?}\`. \`ports\` lists the
  ports the scan is given: \`elbv2\` always, \`autoscaling\`, \`ecs\`, \`cloudwatch\`, \`ec2\`, \`kubernetes\` when listed
  (one not listed is absent from the Node \`ScanPorts\`: the scan reads nothing of it — no Auto Scaling groups, ECS
  services, idle hours, nodes or clusters). \`kubernetes\` is \`eks\` and the clusters' API (\`kubernetes.of\`, \`get\`,
  \`list\`); \`router\`: as for \`clustersOf\`; \`reader\` names who reads the clusters in the reason of one refused (\`DmtDiscoveryRole\` when absent). Output: \`{rules, clusters}\` — the \`ScannedRule\`s in the scan's order, and the
  region's clusters as read (\`{name, reason}\`, \`reason\` null for one read); \`{error: {name, message}}\` when the scan
  fails.
  With \`standalone: true\` (the perimeter's standalone scan on; vision standalone workloads design §6) the scan also lists
  the region's EC2 instances (\`ec2.describeInstances\` with no id, \`NextToken\` pages), its Auto Scaling groups, its ECS
  services described with their tags (\`include: ["TAGS"]\`; refused: again without, said), its RDS instances and clusters
  (\`rds.describeDBInstances\`, \`describeDBClusters\`, \`Marker\` pages, tags from \`TagList\`; one refused: that kind
  unread, said) that no route uses: after the HTTP rules, a \`StandaloneRule\` each (\`kind: "standalone"\`, \`id\` and
  \`resourceArn\` its ARN, \`backend {kind, id, arn}\`, \`name\`, \`tags\`, \`eligibility\`, \`reason\` (the router's texts,
  joined by \`; \`), \`workloadId\` when managed, \`idleHours7d\` as the \`standalone-idle\` topic's \`standaloneIdle\` gives it
  for the eligible and managed ones), instances, then groups, services, RDS instances, RDS clusters. Its output adds
  \`standalone: {problems, unread}\`: what the scan could not read (sentences), and the kinds whose stored candidates stay.
  \`ports\` then also lists \`ec2\` and \`rds\`.
- \`clustersOf\`: \`{where: {account, region}, reader?, router?}\`; \`router\` (the name of the router of the account and region)
  is on a kubernetes port when one is there: a cluster whose private access is on and whose public endpoint is not open to
  \`0.0.0.0/0\` is read through its proxy (the recorded \`kubernetes.of\`), or, without \`router\`, not reached (\`where\` named in its
  reason); private access off and the public endpoint limited: not reached either, with the router's \`UNREACHABLE\` text. With
  \`router\`, a private cluster whose proxy the role may not invoke (a call failing with the reason \`AccessDeniedException\`, or a
  message saying \`not authorized to perform: lambda:InvokeFunction\`: an absent proxy has no tag, and Lambda checks the rights
  first) has the reason of a proxy not set up followed by \` (or apply the organization access again)\`. Output: \`[{name, reason}]\`.
- \`kubernetesBackend\`: \`{where, groups, reader?}\`: the clusters read once (\`clustersOf\`), then each group
  (\`{arn, type, vpcId, tags, targets}\`) traced in turn. Output: one result per group — the
  \`{kind: "k8s", id, kubernetes}\` backend, the reason it cannot be napped, or null (not Kubernetes).
- \`matches\`: \`{criterion, account, rule, inventory}\`. Output: a boolean.
- \`decide\`: \`{config, account, rule, inventory}\`. Output: \`{scope, reason}\`.
- \`scanAccounts\`: \`{config, inventory}\`; \`targetPairs\`: \`{config, inventory, enabledRegions}\`. Output: the plans.
- \`resourceTagsMatch\`: \`{wanted, tags}\`. Output: a boolean.
- \`loadInventory\` (\`org.ts\`, the organization's inventory): \`{tags}\` and \`organizations.*\` answers. Output:
  \`{accounts, ous}\`.`;
