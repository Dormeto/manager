// The estimate topic's recorded world (cases/estimate.mjs): organization o-a1b2c3d4e5, its management account (the
// profile's) and two members, one reached through the role and one refusing it; in each reached account eu-west-1 (the
// management's rich: workloads of every backend kind, companion databases, ineligible rules, an EKS cluster read and
// one refusing; the member's small) and us-east-1 (the management's empty, the member's failing). A model answering
// each call made in an account and region ({account, region, input}), as recorded.mjs's scoped ports ask.
import { eksCluster, error, filtersOf, product as priceProduct, regionModel } from './aws.mjs';

export const MGMT = '111111111111';
export const SHOP = '222222222222';
export const LEGACY = '333333333333';
// A profile whose credentials no longer work.
export const EXPIRED = '555555555555';
export const ORG = 'o-a1b2c3d4e5';
export const EU = 'eu-west-1';
export const US = 'us-east-1';
const HOUR_MS = 3_600_000;
const DAY_MINUTES = 1440;
// The estimate reads the requests of the 14 days before now (rounded to the minute).
const DAYS = 14;

const elb = (account, kind, path) => `arn:aws:elasticloadbalancing:${EU}:${account}:${kind}/${path}`;

// Minute offsets from the requests' start (Monday 08:00 UTC, 14 days before now) of hh:mm UTC on calendar day `day`
// (0: that Monday), on the days chosen, within the 14 days.
const span = DAYS * DAY_MINUTES;
const minuteOf = (day, hh, mm = 0) => day * DAY_MINUTES + hh * 60 + mm - 480;
const weekday = (day) => day % 7 < 5;
const times = (days, clock) => days.flatMap((d) => clock.map(([hh, mm = 0]) => minuteOf(d, hh, mm))).filter((m) => m >= 0 && m < span);
const ALL_DAYS = Array.from({ length: DAYS + 1 }, (_, d) => d);
const WEEKDAYS = ALL_DAYS.filter(weekday);
const every = (minutes, offset = 0) => Array.from({ length: Math.ceil((span - offset) / minutes) }, (_, k) => offset + k * minutes).filter((m) => m < span);
// Running periods [start, end) in minutes, hh:mm to hh:mm on the days chosen.
const running = (days, [fromH, fromM = 0], [toH, toM = 0]) => days.map((d) => [Math.max(0, minuteOf(d, fromH, fromM)), Math.min(span, minuteOf(d, toH, toM))]).filter(([a, b]) => a < b);

// The management account's rich region: one application load balancer, a listener redirecting, one forwarding to
// each workload; Auto Scaling, ECS, EKS (one cluster read, one refusing), RDS.
function mainRegion(from) {
  const A = MGMT;
  const lb = elb(A, 'loadbalancer', 'app/web/0123456789abcdef');
  const l80 = elb(A, 'listener', 'app/web/0123456789abcdef/80aa80aa80aa80aa');
  const l443 = elb(A, 'listener', 'app/web/0123456789abcdef/443bb443bb443bb4');
  const tgArn = (tg) => elb(A, 'targetgroup', `${tg}/${Buffer.from(tg).toString('hex').padEnd(16, '0').slice(0, 16)}`);
  const service = (svc) => `arn:aws:ecs:${EU}:${A}:service/main/${svc}`;
  const CLUSTER = `arn:aws:ecs:${EU}:${A}:cluster/main`;
  const TASK = (family, rev) => `arn:aws:ecs:${EU}:${A}:task-definition/${family}:${rev}`;
  // Each workload: its host, target group (type, targets, tags), and the requests on it (minutes from the start).
  const W = {
    shop: { host: 'shop.example.com', type: 'instance', targets: ['i-shop'], requests: times(ALL_DAYS, [[10]]), count: 3 },
    batch: { host: 'batch.example.com', type: 'instance', targets: ['i-batch-1', 'i-batch-2'], requests: times(ALL_DAYS, [[9], [17]]) },
    api: { host: 'api.example.com', type: 'ip', targets: ['10.0.1.10', '10.0.1.11'], requests: times(WEEKDAYS, Array.from({ length: 19 }, (_, k) => [9 + Math.floor(k / 2), (k % 2) * 30])), count: 4 },
    jobs: { host: 'jobs.example.com', type: 'ip', targets: ['10.0.1.20'], requests: times(ALL_DAYS, [[2]]) },
    'k8s-demo-web': { host: 'www.example.com', type: 'ip', targets: ['10.0.2.1', '10.0.2.2'], requests: times(WEEKDAYS, [[8, 30], [12], [16, 30]]),
      tags: { 'elbv2.k8s.aws/cluster': 'eks-demo', 'ingress.k8s.aws/stack': 'demo', 'ingress.k8s.aws/resource': 'demo/web-web:80' } },
    'k8s-docs': { host: 'docs.example.com', type: 'ip', targets: ['10.0.3.1'], requests: [] },
    busy: { host: 'busy.example.com', type: 'instance', targets: ['i-busy'], requests: every(180, 7) },
    tiny: { host: 'tiny.example.com', type: 'instance', targets: ['i-tiny'], requests: every(70, 3) },
    dev: { host: 'dev.example.com', type: 'instance', targets: ['i-dev'], requests: times(ALL_DAYS, [[11]]), tags: { env: 'dev' } },
    night: { host: 'night.example.com', type: 'instance', targets: ['i-night'], requests: times(WEEKDAYS, [[9], [11]]) },
    zero: { host: 'zero.example.com', type: 'ip', targets: [], requests: times(WEEKDAYS, [[10]]) },
    rhel: { host: 'legacy.example.com', type: 'instance', targets: ['i-rhel'], requests: times(ALL_DAYS, [[10]]) },
    // The same backend behind a second target group: estimated once, at the first.
    'rhel-alt': { host: 'legacy2.example.com', type: 'instance', targets: ['i-rhel'], requests: times(ALL_DAYS, [[15]]) },
    portal: { host: 'portal.example.com', type: 'instance', targets: ['i-portal'], requests: times(ALL_DAYS, [[9], [14]]), managed: 'portal' },
  };
  const WAKER = tgArn('dmt-prd-portal');
  const wakerRequests = times(ALL_DAYS, [[21]]);
  const rules = Object.entries(W).map(([tg, w], i) => ({
    RuleArn: `${l443.replace(':listener/', ':listener-rule/')}/${(i + 1).toString(16).padStart(16, '0')}`, Priority: String((i + 1) * 10),
    Conditions: [{ Field: 'host-header', Values: [w.host], HostHeaderConfig: { Values: [w.host] } }],
    Actions: [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: tgArn(tg), Weight: 1 }, ...(w.managed ? [{ TargetGroupArn: WAKER, Weight: 0 }] : [])] } }],
  }));
  const portalRule = rules[Object.keys(W).indexOf('portal')].RuleArn;
  const instance = (type, sg, extra = {}) => ({ InstanceType: type, PlatformDetails: 'Linux/UNIX', State: { Name: 'running' }, SecurityGroups: [{ GroupId: sg }], Tags: [], ...extra });
  const db = (id, cls, engine, sg, extra = {}) => ({
    DBInstanceIdentifier: id, DBInstanceClass: cls, Engine: engine, DBInstanceStatus: 'available', MultiAZ: false,
    VpcSecurityGroups: [{ VpcSecurityGroupId: sg, Status: 'active' }], TagList: [], ...extra,
  });
  // When each instance, service and database ran (minutes from the start); none: it never ran; absent: unreadable.
  const UPTIME = {
    'i-shop': [[11 * DAY_MINUTES, span]],
    'i-tiny': running(WEEKDAYS, [9], [10]),
    'i-night': running(WEEKDAYS, [8], [12]),
    'i-rhel': [],
    'main/api': running(WEEKDAYS, [8], [12]),
    'main/jobs': running(ALL_DAYS, [1], [3]),
    jobsdb: running(ALL_DAYS, [1], [3]),
    'main/zero': running([3, 10], [10], [11]),
    shopdb: running(WEEKDAYS, [8], [11]), shareddb: [], devdb: [], portaldb: [], archivedb: [],
    reports: running(WEEKDAYS, [8], [9]),
    nightdb: running(WEEKDAYS, [8], [12]),
    legacydb: running(WEEKDAYS, [9], [10]),
  };
  const series = { ...Object.fromEntries(Object.entries(W).map(([tg, w]) => [tgArn(tg).split(':').at(-1), { minutes: w.requests, count: w.count ?? 1 }])), [WAKER.split(':').at(-1)]: { minutes: wakerRequests, count: 1 } };
  return {
    page: 5,
    metricsPage: 400,
    loadBalancers: [{ LoadBalancerArn: lb, LoadBalancerName: 'web', Type: 'application' }],
    listeners: { [lb]: [{ ListenerArn: l443, Port: 443, Protocol: 'HTTPS' }, { ListenerArn: l80, Port: 80, Protocol: 'HTTP' }] },
    rules: {
      [l80]: [{ RuleArn: `${l80.replace(':listener/', ':listener-rule/')}/default`, Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'redirect', Order: 1, RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }] }],
      [l443]: [...rules, { RuleArn: `${l443.replace(':listener/', ':listener-rule/')}/default`, Priority: 'default', IsDefault: true, Conditions: [], Actions: [{ Type: 'fixed-response', Order: 1, FixedResponseConfig: { StatusCode: '404' } }] }],
    },
    targetGroups: [...Object.entries(W).map(([tg, w]) => ({ TargetGroupArn: tgArn(tg), TargetGroupName: tg, TargetType: w.type, VpcId: 'vpc-0a1b2c3d' })), { TargetGroupArn: WAKER, TargetGroupName: 'dmt-prd-portal', TargetType: 'lambda' }],
    tags: {
      [lb]: { team: 'web' },
      ...Object.fromEntries(Object.entries(W).filter(([, w]) => w.tags).map(([tg, w]) => [tgArn(tg), w.tags])),
      [portalRule]: { 'dormeto:workload': 'portal' },
      [WAKER]: { 'dormeto:workload': 'portal', 'dormeto:router': 'dmt-prd' },
    },
    targets: Object.fromEntries(Object.entries(W).map(([tg, w]) => [tgArn(tg), w.targets])),
    autoScalingGroups: [{
      AutoScalingGroupName: 'batch-asg', AutoScalingGroupARN: `arn:aws:autoscaling:${EU}:${A}:autoScalingGroup:1f2e3d4c-0000-4000-8000-00000000000b:autoScalingGroupName/batch-asg`,
      TargetGroupARNs: [tgArn('batch')], DesiredCapacity: 2, Instances: [{ InstanceId: 'i-batch-1' }, { InstanceId: 'i-batch-2' }], Tags: [],
    }],
    instances: {
      'i-shop': instance('t3.medium', 'sg-shop'),
      'i-batch-1': instance('t3.small', 'sg-batch'),
      'i-batch-2': instance('t3.small', 'sg-batch', { InstanceLifecycle: 'spot' }),
      'i-busy': instance('t3.large', 'sg-busy'),
      'i-tiny': instance('t4g.nano', 'sg-tiny'),
      'i-dev': instance('t3.small', 'sg-dev'),
      'i-night': instance('t3.medium', 'sg-night', { State: { Name: 'stopped' } }),
      'i-rhel': instance('m5.large', 'sg-rhel', { PlatformDetails: 'Red Hat Enterprise Linux' }),
      'i-portal': instance('t3.micro', 'sg-portal', { State: { Name: 'stopped' } }),
    },
    securityGroups: {
      'sg-shopdb': ['sg-shop'], 'sg-shared': ['sg-api', 'sg-jobs'], 'sg-devdb': ['sg-batch'], 'sg-reports': ['sg-batch'], 'sg-nightdb': ['sg-night'],
      'sg-portaldb': ['sg-portal'], 'sg-legacydb': ['sg-tiny'], 'sg-archive': ['sg-shop'], 'sg-jobsdb': ['sg-jobs'],
    },
    ecsClusters: {
      [CLUSTER]: [
        { serviceArn: service('api'), desiredCount: 2, launchType: 'FARGATE', taskDefinition: TASK('api', 7), loadBalancers: [{ targetGroupArn: tgArn('api') }], networkConfiguration: { awsvpcConfiguration: { securityGroups: ['sg-api'] } } },
        { serviceArn: service('jobs'), desiredCount: 4, capacityProviderStrategy: [{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }], taskDefinition: TASK('jobs', 2), loadBalancers: [{ targetGroupArn: tgArn('jobs') }], networkConfiguration: { awsvpcConfiguration: { securityGroups: ['sg-jobs'] } } },
        { serviceArn: service('zero'), desiredCount: 0, launchType: 'FARGATE', taskDefinition: TASK('zero', 1), loadBalancers: [{ targetGroupArn: tgArn('zero') }], networkConfiguration: { awsvpcConfiguration: { securityGroups: ['sg-zero'] } } },
      ],
    },
    taskDefinitions: {
      [TASK('api', 7)]: { cpu: '512', memory: '1024', runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' } },
      [TASK('jobs', 2)]: { cpu: '256', memory: '512' },
      [TASK('zero', 1)]: { cpu: '256', memory: '512' },
    },
    dbInstances: [
      db('shopdb', 'db.t4g.micro', 'postgres', 'sg-shopdb'),
      db('shopdb-replica', 'db.t4g.micro', 'postgres', 'sg-shopdb', { ReadReplicaSourceDBInstanceIdentifier: 'shopdb' }),
      db('archivedb', 'db.t4g.micro', 'postgres', 'sg-archive'),
      db('shareddb', 'db.t4g.small', 'mysql', 'sg-shared'),
      db('devdb', 'db.t4g.micro', 'postgres', 'sg-devdb', { TagList: [{ Key: 'env', Value: 'dev' }] }),
      db('reports-1', 'db.r6g.large', 'aurora-postgresql', 'sg-reports', { DBClusterIdentifier: 'reports' }),
      db('nightdb', 'db.t4g.micro', 'postgres', 'sg-nightdb', { DBInstanceStatus: 'stopped' }),
      db('jobsdb', 'db.t4g.micro', 'postgres', 'sg-jobsdb', { DBInstanceStatus: 'stopped' }),
      db('portaldb', 'db.t4g.micro', 'mariadb', 'sg-portaldb'),
      db('legacydb', 'db.t3.small', 'sqlserver-ex', 'sg-legacydb'),
    ],
    dbClusters: [{ DBClusterIdentifier: 'reports', Status: 'available', Engine: 'aurora-postgresql', EngineMode: 'provisioned', VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-reports', Status: 'active' }], TagList: [{ Key: 'team', Value: 'data' }] }],
    clusters: {
      'eks-demo': { description: eksCluster('eks-demo', { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], vpcId: 'vpc-0a1b2c3d' }), karpenter: true, objects: demoCluster() },
      'eks-prod': { description: eksCluster('eks-prod', { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], vpcId: 'vpc-0a1b2c3d' }), objects: {}, refuse: error('KubernetesError', 'Unauthorized', { status: 401, reason: 'Unauthorized' }) },
    },
    metrics: metricsOf(series, UPTIME, from),
  };
}

// eks-demo: web (a Deployment behind a lone Ingress, its pods on a Karpenter Spot node) and docs (a Deployment on
// Fargate behind a TargetGroupBinding).
function demoCluster() {
  const rsOf = (owner) => `${owner}-6b7c8d`;
  const pod = (podName, namespace, ip, extra = {}, annotations = {}) => ({
    metadata: { name: podName, namespace, labels: { app: podName.split('-')[0] }, annotations, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: rsOf(podName.split('-')[0]), controller: true }] },
    spec: { nodeName: 'ip-10-0-2-9.eu-west-1.compute.internal', schedulerName: 'default-scheduler', containers: [{ name: 'app', resources: { requests: { cpu: '500m', memory: '1Gi' } } }], ...extra },
    status: { phase: 'Running', podIP: ip, conditions: [{ type: 'Ready', status: 'True' }] },
  });
  const deployment = (owner, namespace) => ({ kind: 'Deployment', metadata: { name: owner, namespace, labels: {}, annotations: {} }, spec: { replicas: 2, selector: { matchLabels: { app: owner } } } });
  const rs = (owner, namespace) => ({ metadata: { name: rsOf(owner), namespace, labels: { app: owner }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: owner, controller: true }] } });
  const web = [pod('web-6b7c8d-a', 'demo', '10.0.2.1'), pod('web-6b7c8d-b', 'demo', '10.0.2.2')];
  const docs = [pod('docs-6b7c8d-a', 'docs', '10.0.3.1', { nodeName: 'fargate-ip-10-0-3-1.eu-west-1.compute.internal', schedulerName: 'fargate-scheduler' }, { CapacityProvisioned: '0.25vCPU 0.5GB' })];
  return {
    '/api/v1/pods': [...web, ...docs],
    '/api/v1/namespaces/demo/pods': web,
    '/api/v1/namespaces/docs/pods': docs,
    '/apis/apps/v1/namespaces/demo/replicasets': [rs('web', 'demo')],
    '/apis/apps/v1/namespaces/docs/replicasets': [rs('docs', 'docs')],
    '/apis/apps/v1/namespaces/demo/deployments': [deployment('web', 'demo')],
    '/apis/apps/v1/namespaces/docs/deployments': [deployment('docs', 'docs')],
    '/api/v1/namespaces/demo/services': [{ metadata: { name: 'web', namespace: 'demo' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } }],
    '/apis/networking.k8s.io/v1/namespaces/demo/ingresses': [{
      metadata: { name: 'web', namespace: 'demo', annotations: {} },
      spec: { rules: [{ host: 'www.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] },
    }],
    '/api/v1/nodes': [{
      metadata: { name: 'ip-10-0-2-9.eu-west-1.compute.internal', labels: { 'node.kubernetes.io/instance-type': 'm5.large', 'kubernetes.io/os': 'linux', 'karpenter.sh/nodepool': 'default', 'karpenter.sh/capacity-type': 'spot' } },
      status: { allocatable: { cpu: '1930m', memory: '7220184Ki' } },
    }],
  };
}

// CloudWatch from the world: a target group's requests (minutes from `start`, the requests' first minute, a count
// each), summed by the query's period between its start and end; an instance's, service's or database's datapoints
// every 5 minutes while it ran (none: it never ran; not given: unreadable).
function metricsOf(series, uptime, start) {
  return (q, input) => {
    const from = Date.parse(input.StartTime);
    const to = Date.parse(input.EndTime);
    const period = q.MetricStat.Period * 1000;
    const dims = Object.fromEntries(q.MetricStat.Metric.Dimensions.map((d) => [d.Name, d.Value]));
    const buckets = new Map();
    const add = (t, v) => {
      if (t < from || t >= to) return;
      const b = from + Math.floor((t - from) / period) * period;
      buckets.set(b, (buckets.get(b) ?? 0) + v);
    };
    if (q.MetricStat.Metric.Namespace === 'AWS/ApplicationELB') {
      const s = series[dims.TargetGroup];
      if (!s) return { StatusCode: 'InternalError', Messages: [{ Code: 'InternalError', Value: 'An internal error occurred while reading the metric.' }], Timestamps: [], Values: [] };
      for (const m of s.minutes) add(start + m * 60_000, s.count);
    } else {
      const key = dims.InstanceId ?? dims.DBInstanceIdentifier ?? dims.DBClusterIdentifier ?? `${dims.ClusterName}/${dims.ServiceName}`;
      const periods = uptime[key];
      if (!periods) return { StatusCode: 'InternalError', Messages: [{ Code: 'InternalError', Value: 'An internal error occurred while reading the metric.' }], Timestamps: [], Values: [] };
      for (const [a, b] of periods) for (let m = a; m < b; m += 5) add(start + m * 60_000, 1);
    }
    const sorted = [...buckets].sort((x, y) => x[0] - y[0]);
    return { StatusCode: 'Complete', Timestamps: sorted.map(([t]) => new Date(t).toISOString()), Values: sorted.map(([, v]) => v) };
  };
}
// The member account's region: an Auto Scaling group of Spot instances, an instance whose requests CloudWatch cannot
// read, an instance of a type the Price List does not know.
function shopRegion(from) {
  const A = SHOP;
  const lb = elb(A, 'loadbalancer', 'app/app/fedcba9876543210');
  const l443 = elb(A, 'listener', 'app/app/fedcba9876543210/443cc443cc443cc4');
  const tgArn = (tg) => elb(A, 'targetgroup', `${tg}/${Buffer.from(tg).toString('hex').padEnd(16, '0').slice(0, 16)}`);
  const W = { app: ['i-app'], admin: ['i-admin'], gpu: ['i-gpu'] };
  return {
    loadBalancers: [{ LoadBalancerArn: lb, LoadBalancerName: 'app', Type: 'application' }],
    listeners: { [lb]: [{ ListenerArn: l443, Port: 443, Protocol: 'HTTPS' }] },
    rules: { [l443]: Object.keys(W).map((tg, i) => ({ RuleArn: `${l443.replace(':listener/', ':listener-rule/')}/${String(i + 1).padStart(16, '0')}`, Priority: String(i + 1), Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [`${tg}.shop.example.com`] } }], Actions: [{ Type: 'forward', Order: 1, TargetGroupArn: tgArn(tg) }] })) },
    targetGroups: Object.keys(W).map((tg) => ({ TargetGroupArn: tgArn(tg), TargetGroupName: tg, TargetType: 'instance' })),
    tags: { [lb]: { team: 'shop' } },
    targets: Object.fromEntries(Object.entries(W).map(([tg, ids]) => [tgArn(tg), ids])),
    autoScalingGroups: [{ AutoScalingGroupName: 'app-asg', TargetGroupARNs: [tgArn('app')], DesiredCapacity: 1, Instances: [{ InstanceId: 'i-app' }] }],
    instances: {
      'i-app': { InstanceType: 't3.small', PlatformDetails: 'Linux/UNIX', InstanceLifecycle: 'spot', State: { Name: 'running' }, SecurityGroups: [{ GroupId: 'sg-app' }] },
      'i-admin': { InstanceType: 't3.small', PlatformDetails: 'Linux/UNIX', State: { Name: 'running' }, SecurityGroups: [{ GroupId: 'sg-admin' }] },
      'i-gpu': { InstanceType: 'g9.xlarge', PlatformDetails: 'Linux/UNIX', State: { Name: 'running' }, SecurityGroups: [{ GroupId: 'sg-gpu' }] },
    },
    ecsClusters: {},
    metrics: metricsOf({
      [tgArn('app').split(':').at(-1)]: { minutes: times(ALL_DAYS, [[9], [18]]), count: 2 },
      [tgArn('gpu').split(':').at(-1)]: { minutes: times(WEEKDAYS, [[14]]), count: 1 },
    }, { 'i-admin': running(WEEKDAYS, [9], [10]), 'i-gpu': running(WEEKDAYS, [13], [15]) }, from),
  };
}

// The Price List and Spot price history the world answers (USD an hour).
const LIST = {
  'AmazonEC2/t3.medium/Linux': '0.0456000000', 'AmazonEC2/t3.small/Linux': '0.0228000000', 'AmazonEC2/t3.large/Linux': '0.0912000000',
  'AmazonEC2/t4g.nano/Linux': '0.0046000000', 'AmazonEC2/t3.micro/Linux': '0.0114000000', 'AmazonEC2/m5.large/Linux': '0.1070000000',
  'AmazonRDS/db.t4g.micro/PostgreSQL/Single-AZ': '0.0170000000', 'AmazonRDS/db.t4g.small/MySQL/Single-AZ': '0.0340000000', 'AmazonRDS/db.r6g.large/Aurora PostgreSQL/Single-AZ': '0.2900000000',
  'AmazonECS/Fargate-vCPU-Hours:perCPU': '0.0404800000', 'AmazonECS/Fargate-GB-Hours': '0.0044450000',
};
const SPOT = { 't3.small': [['eu-west-1a', '0.007500', 1], ['eu-west-1b', '0.008100', 2], ['eu-west-1a', '0.009000', 5]], 'm5.large': [['eu-west-1a', '0.040000', 1], ['eu-west-1c', '0.044000', 3]] };

export function worldModel(now) {
  const from = Math.floor(now / 60_000) * 60_000 - DAYS * DAY_MINUTES * 60_000;
  const regions = {
    [`${MGMT}/${EU}`]: regionModel(mainRegion(from)),
    [`${MGMT}/${US}`]: regionModel({ loadBalancers: [], ecsClusters: {} }),
    [`${SHOP}/${EU}`]: regionModel(shopRegion(from)),
    [`${SHOP}/${US}`]: regionModel({ fail: { 'elbv2.describeLoadBalancers': error('AccessDenied', `User: arn:aws:sts::${SHOP}:assumed-role/OrganizationAccountAccessRole/dormeto-estimate is not authorized to perform: elasticloadbalancing:DescribeLoadBalancers because no service control policy allows the elasticloadbalancing:DescribeLoadBalancers action`) } }),
  };
  const accounts = { [MGMT]: { Id: MGMT, Name: 'management', State: 'ACTIVE' }, [SHOP]: { Id: SHOP, Name: 'shop', State: 'ACTIVE' }, [LEGACY]: { Id: LEGACY, Name: 'legacy', State: 'ACTIVE' } };
  return (call, { account, region, input }) => {
    switch (call) {
      case 'sts.getCallerIdentity':
        if (account === EXPIRED) throw error('ExpiredTokenException', 'The security token included in the request is expired');
        return { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_ReadOnly_0123456789abcdef/estimate`, UserId: 'AROAEXAMPLE:estimate' };
      case 'sts.assumeRole': {
        const target = input.RoleArn.split(':')[4];
        if (target === LEGACY) throw error('AccessDenied', `User: arn:aws:sts::${MGMT}:assumed-role/AWSReservedSSO_ReadOnly_0123456789abcdef/estimate is not authorized to perform: sts:AssumeRole on resource: ${input.RoleArn}`);
        return { Credentials: { AccessKeyId: 'ASIAEXAMPLEKEY', SecretAccessKey: 'example-secret', SessionToken: 'example-session-token', Expiration: new Date(now + HOUR_MS).toISOString() } };
      }
      case 'organizations.describeOrganization': return { Organization: { Id: ORG, Arn: `arn:aws:organizations::${MGMT}:organization/${ORG}`, MasterAccountId: MGMT } };
      case 'organizations.listRoots': return { Roots: [{ Id: 'r-a1b2', Name: 'Root' }] };
      case 'organizations.listAccountsForParent': return { Accounts: input.ParentId === 'r-a1b2' ? [accounts[MGMT]] : [accounts[SHOP], accounts[LEGACY]] };
      case 'organizations.listOrganizationalUnitsForParent': return { OrganizationalUnits: input.ParentId === 'r-a1b2' ? [{ Id: 'ou-a1b2-workload', Name: 'workloads' }] : [] };
      case 'ec2.describeRegions': return { Regions: [EU, US].map((RegionName) => ({ RegionName, Endpoint: `ec2.${RegionName}.amazonaws.com`, OptInStatus: 'opt-in-not-required' })) };
      case 'pricing.getProducts': {
        const f = filtersOf(input);
        const key = f.ServiceCode === 'AmazonEC2' ? `AmazonEC2/${f.instanceType}/${f.operatingSystem}`
          : f.ServiceCode === 'AmazonRDS' ? `AmazonRDS/${f.instanceType}/${f.databaseEngine}/${f.deploymentOption}`
            : `AmazonECS/${f['~usagetype']}`;
        return { PriceList: LIST[key] ? [priceProduct({ regionCode: f.regionCode }, LIST[key])] : [] };
      }
      case 'spot.history': return { SpotPriceHistory: (SPOT[input.InstanceTypes[0]] ?? []).map(([AvailabilityZone, SpotPrice, hours]) => ({ AvailabilityZone, SpotPrice, Timestamp: new Date(now - hours * HOUR_MS).toISOString(), InstanceType: input.InstanceTypes[0], ProductDescription: input.ProductDescriptions[0] })) };
      default: return regions[`${account}/${region}`]?.(call, input);
    }
  };
}
