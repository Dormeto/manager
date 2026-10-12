// One account and region: every rule of the application load balancers, with what Dormeto could do with it (managed,
// eligible, ineligible and why), its host names and tags, and how idle its target group was over the last 7 days.
// Ported from the router discovery (router lambda/src/lib/candidates.mjs).
import type { BackendKind, RuleRef, ScannedRule } from './types.js';

const WORKLOAD_TAG = 'dormeto:workload';
const ROLE_TAG = 'dormeto:role';
const SHADOWS_TAG = 'dormeto:shadows'; // a Dormeto rule before a customer rule (R4c)
const HOUR_MS = 3_600_000;
const IDLE_WINDOW_HOURS = 168;

type Tag = { Key?: string; Value?: string };
type Condition = { Field?: string; Values?: string[]; HostHeaderConfig?: { Values?: string[] }; PathPatternConfig?: { Values?: string[] } };
type Action = { Type?: string; Order?: number; TargetGroupArn?: string; ForwardConfig?: { TargetGroups?: { TargetGroupArn?: string; Weight?: number }[] } };
type Rule = { RuleArn?: string; Priority?: string; IsDefault?: boolean; Conditions?: Condition[]; Actions?: Action[] };
type LoadBalancer = { LoadBalancerArn?: string; LoadBalancerName?: string; Type?: string };
type Listener = { ListenerArn?: string; Port?: number; Protocol?: string };
type TargetGroup = { TargetGroupArn?: string; TargetGroupName?: string; TargetType?: string };
type MetricQuery = {
  Id: string;
  ReturnData: boolean;
  MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] }; Period: number; Stat: string };
};

// Read-only calls of the discovery role (DmtDiscoveryRole), as plain functions: AWS SDK clients or fakes.
export interface ScanPorts {
  elbv2: {
    describeLoadBalancers(input: { Marker?: string }): Promise<{ LoadBalancers?: LoadBalancer[]; NextMarker?: string }>;
    describeListeners(input: { LoadBalancerArn: string; Marker?: string }): Promise<{ Listeners?: Listener[]; NextMarker?: string }>;
    describeRules(input: { ListenerArn: string; Marker?: string }): Promise<{ Rules?: Rule[]; NextMarker?: string }>;
    describeTags(input: { ResourceArns: string[] }): Promise<{ TagDescriptions?: { ResourceArn?: string; Tags?: Tag[] }[] }>;
    describeTargetGroups(input: { Marker?: string }): Promise<{ TargetGroups?: TargetGroup[]; NextMarker?: string }>;
    describeTargetHealth(input: { TargetGroupArn: string }): Promise<{ TargetHealthDescriptions?: { Target?: { Id?: string } }[] }>;
  };
  autoscaling?: {
    describeAutoScalingGroups(input: { NextToken?: string }): Promise<{ AutoScalingGroups?: { AutoScalingGroupName?: string; TargetGroupARNs?: string[] }[]; NextToken?: string }>;
  };
  ecs?: {
    listClusters(input: { nextToken?: string }): Promise<{ clusterArns?: string[]; nextToken?: string }>;
    listServices(input: { cluster: string; nextToken?: string }): Promise<{ serviceArns?: string[]; nextToken?: string }>;
    describeServices(input: { cluster: string; services: string[] }): Promise<{ services?: { serviceArn?: string; loadBalancers?: { targetGroupArn?: string }[] }[] }>;
  };
  cloudwatch?: {
    getMetricData(input: { StartTime: Date; EndTime: Date; MetricDataQueries: MetricQuery[] }): Promise<{ MetricDataResults?: { Id?: string; Values?: number[] }[] }>;
  };
}

// The IAM actions of these calls and of the enabled regions: the discovery role's policy grants them, nothing more
// (infra/terraform/modules/access/discovery-policy.json; a test keeps them in line).
export const DISCOVERY_ACTIONS = [
  'ec2:DescribeRegions',
  'elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:DescribeTags', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth',
  'autoscaling:DescribeAutoScalingGroups',
  'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices',
  'cloudwatch:GetMetricData',
  // Event refresh: whether a trail logs the management writes of the region (aws.ts trailCovers).
  'cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus', 'cloudtrail:GetEventSelectors',
  // Its own role's tags: an account set up for discovery only (aws.ts discoveryOnlyOf).
  'iam:GetRole',
];

// Pages of an AWS list call: ELBv2 (Marker/NextMarker), Auto Scaling (NextToken), ECS (nextToken).
async function all<T>(call: (token: Record<string, string>) => Promise<Record<string, unknown>>, key: string, token = { in: 'Marker', out: 'NextMarker' }): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined;
  do {
    const page = await call(next ? { [token.in]: next } : {});
    items.push(...((page[key] as T[] | undefined) ?? []));
    next = page[token.out] as string | undefined;
  } while (next);
  return items;
}

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function tagsOf(elbv2: ScanPorts['elbv2'], arns: string[]): Promise<Map<string, Record<string, string>>> {
  const tags = new Map<string, Record<string, string>>();
  for (const batch of chunks([...new Set(arns)], 20)) {
    const { TagDescriptions = [] } = await elbv2.describeTags({ ResourceArns: batch });
    for (const d of TagDescriptions) {
      if (d.ResourceArn) tags.set(d.ResourceArn, Object.fromEntries((d.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])));
    }
  }
  return tags;
}

// Target group → Auto Scaling group name and ECS service ARN (the backends that register targets in it).
async function backendOwners({ autoscaling, ecs }: ScanPorts) {
  const groups = new Map<string, { name: string; arn?: string }>();
  const services = new Map<string, string>();
  if (autoscaling) {
    const asgs = await all<{ AutoScalingGroupName?: string; AutoScalingGroupARN?: string; TargetGroupARNs?: string[] }>((i) => autoscaling.describeAutoScalingGroups(i), 'AutoScalingGroups', { in: 'NextToken', out: 'NextToken' });
    for (const g of asgs) for (const arn of g.TargetGroupARNs ?? []) groups.set(arn, { name: g.AutoScalingGroupName ?? '', ...(g.AutoScalingGroupARN ? { arn: g.AutoScalingGroupARN } : {}) });
  }
  if (ecs) {
    const clusters = await all<string>((i) => ecs.listClusters(i), 'clusterArns', { in: 'nextToken', out: 'nextToken' });
    for (const cluster of clusters) {
      const arns = await all<string>((i) => ecs.listServices({ ...i, cluster }), 'serviceArns', { in: 'nextToken', out: 'nextToken' });
      for (const batch of chunks(arns, 10)) {
        const { services: described = [] } = await ecs.describeServices({ cluster, services: batch });
        for (const s of described) for (const lb of s.loadBalancers ?? []) if (lb.targetGroupArn && s.serviceArn) services.set(lb.targetGroupArn, s.serviceArn);
      }
    }
  }
  return { groups, services };
}

interface Forward {
  type: string | undefined;
  groups: string[]; // weight > 0
  all: string[];
}

// Target groups that receive traffic from the rule (weight > 0), and the type of its final action.
function forwardOf(rule: Rule): Forward {
  const action = [...(rule.Actions ?? [])].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0)).at(-1) ?? {};
  if (action.Type !== 'forward') return { type: action.Type, groups: [], all: [] };
  const groups = action.ForwardConfig?.TargetGroups ?? [{ TargetGroupArn: action.TargetGroupArn, Weight: 1 }];
  return {
    type: 'forward',
    groups: groups.filter((g) => (g.Weight ?? 1) > 0).map((g) => g.TargetGroupArn ?? ''),
    all: groups.map((g) => g.TargetGroupArn ?? ''),
  };
}

const hostsOf = (rule: Rule): string[] =>
  (rule.Conditions ?? []).filter((c) => c.Field === 'host-header').flatMap((c) => c.HostHeaderConfig?.Values ?? c.Values ?? []);

function conditionsOf(rule: Rule): string {
  if (rule.IsDefault) return 'default';
  const parts = (rule.Conditions ?? []).map((c) => {
    if (c.Field === 'host-header') return `host ${(c.HostHeaderConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    if (c.Field === 'path-pattern') return `path ${(c.PathPatternConfig?.Values ?? c.Values ?? []).join(' | ')}`;
    return c.Field ?? '';
  });
  return parts.join(', ') || 'any';
}

const REASONS: Record<string, string> = {
  redirect: 'redirect action',
  'fixed-response': 'fixed response',
  'authenticate-oidc': 'authentication only',
  'authenticate-cognito': 'authentication only',
};

const lbDimension = (arn: string) => arn.split(':loadbalancer/')[1] ?? arn;
const tgDimension = (arn: string) => arn.split(':').at(-1) ?? arn;

// Hourly request sums of the last 7 days per target group: idle hours = hours without data or with 0 requests.
async function idleHours(cloudwatch: NonNullable<ScanPorts['cloudwatch']>, pairs: { lb: string; tg: string }[], now: () => number) {
  const end = Math.floor(now() / HOUR_MS) * HOUR_MS;
  const start = end - IDLE_WINDOW_HOURS * HOUR_MS;
  const out = new Map<string, { idleHours7d: number; requests7d: number }>();
  for (const batch of chunks(pairs, 500)) {
    const { MetricDataResults = [] } = await cloudwatch.getMetricData({
      StartTime: new Date(start),
      EndTime: new Date(end),
      MetricDataQueries: batch.map((p, i) => ({
        Id: `q${i}`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApplicationELB',
            MetricName: 'RequestCount',
            Dimensions: [{ Name: 'LoadBalancer', Value: lbDimension(p.lb) }, { Name: 'TargetGroup', Value: tgDimension(p.tg) }],
          },
          Period: 3600,
          Stat: 'Sum',
        },
      })),
    });
    for (const result of MetricDataResults) {
      const pair = batch[Number((result.Id ?? '').slice(1))];
      if (!pair) continue;
      const values = result.Values ?? [];
      out.set(pair.tg, {
        idleHours7d: IDLE_WINDOW_HOURS - values.filter((v) => v > 0).length,
        requests7d: Math.round(values.reduce((sum, v) => sum + v, 0)),
      });
    }
  }
  return out;
}

// A rule of a candidate, as listed on the dashboard.
const ruleRef = (row: Row): RuleRef => ({
  id: row.rule.RuleArn ?? '',
  listener: `${row.listener.Protocol}:${row.listener.Port}`,
  priority: row.rule.Priority ?? '',
  conditions: conditionsOf(row.rule),
  hosts: hostsOf(row.rule),
  managed: Boolean(row.managed),
});

const MAX_RULES = 10;
const rank = (priority: string | undefined) => (priority === undefined || priority === 'default' ? Infinity : Number(priority));

interface Row {
  lb: LoadBalancer;
  listener: Listener;
  rule: Rule;
  forward: Forward;
  managed?: string; // workload of a rule tagged dormeto:workload
  shadowedBy?: string; // workload whose shadow rule (dormeto:shadows) covers this customer rule
  app?: TargetGroup; // the one application target group it forwards to
}

export async function scanRegion(ports: ScanPorts, where: { account: string; region: string }, { now = Date.now }: { now?: () => number } = {}): Promise<ScannedRule[]> {
  const { elbv2 } = ports;
  const lbs = (await all<LoadBalancer>((i) => elbv2.describeLoadBalancers(i), 'LoadBalancers')).filter((lb) => lb.Type === 'application');
  const rows: Row[] = [];
  for (const lb of lbs) {
    const listeners = await all<Listener>((i) => elbv2.describeListeners({ ...i, LoadBalancerArn: lb.LoadBalancerArn ?? '' }), 'Listeners');
    for (const listener of listeners.sort((a, b) => (a.Port ?? 0) - (b.Port ?? 0))) {
      const rules = await all<Rule>((i) => elbv2.describeRules({ ...i, ListenerArn: listener.ListenerArn ?? '' }), 'Rules');
      for (const rule of rules) rows.push({ lb, listener, rule, forward: forwardOf(rule) });
    }
  }
  const groups = new Map((await all<TargetGroup>((i) => elbv2.describeTargetGroups(i), 'TargetGroups')).map((g) => [g.TargetGroupArn ?? '', g]));
  const tags = await tagsOf(elbv2, [
    ...lbs.map((lb) => lb.LoadBalancerArn ?? ''),
    ...rows.map((r) => r.rule.RuleArn ?? ''),
    ...rows.flatMap((r) => r.forward.all),
  ].filter(Boolean));
  const visible = rows.filter((r) => tags.get(r.rule.RuleArn ?? '')?.[ROLE_TAG] !== 'admin');
  const owners = await backendOwners(ports);

  // The application target group of each rule: the one it forwards to, or, managed, its target group that is not the waker.
  for (const row of visible) {
    row.managed = tags.get(row.rule.RuleArn ?? '')?.[WORKLOAD_TAG];
    if (row.forward.type !== 'forward') continue;
    if (row.managed) row.app = row.forward.all.map((arn) => groups.get(arn)).find((g) => g && g.TargetType !== 'lambda');
    else if (row.forward.groups.length === 1) {
      const g = groups.get(row.forward.groups[0]!);
      if (g && g.TargetType !== 'lambda' && g.TargetType !== 'alb') row.app = g;
    }
  }
  // Customer rules covered by a workload's shadow (R4c): left untouched, they are part of the workload.
  for (const row of visible) {
    const covered = row.managed ? tags.get(row.rule.RuleArn ?? '')?.[SHADOWS_TAG] : undefined;
    const customer = covered ? visible.find((r) => r.rule.RuleArn === covered) : undefined;
    if (customer) customer.shadowedBy = row.managed;
  }
  // Target groups receiving traffic from a weighted forward of several target groups (canary, blue-green).
  const weighted = new Set(visible.filter((r) => !r.managed && r.forward.type === 'forward' && r.forward.groups.length > 1).flatMap((r) => r.forward.groups));
  const byGroup = new Map<string, Row[]>();
  for (const row of visible) if (row.app?.TargetGroupArn) byGroup.set(row.app.TargetGroupArn, [...(byGroup.get(row.app.TargetGroupArn) ?? []), row]);

  const candidates: ScannedRule[] = [];
  for (const [arn, members] of byGroup) {
    candidates.push(await groupCandidate(arn, members.sort((a, b) => rank(a.rule.Priority) - rank(b.rule.Priority)), { where, tags, weighted, elbv2, owners }));
  }
  for (const row of visible.filter((r) => !r.app)) candidates.push(ruleCandidate(row, where, tags, groups));

  const measured = candidates.filter((c) => c.eligibility !== 'ineligible' && c.targetGroupArn);
  const pairs = [...new Map(measured.map((c) => [c.targetGroupArn!, { lb: c.loadBalancerArn, tg: c.targetGroupArn! }])).values()];
  const idle = pairs.length && ports.cloudwatch ? await idleHours(ports.cloudwatch, pairs, now) : new Map();
  for (const c of measured) Object.assign(c, idle.get(c.targetGroupArn!) ?? {});
  return candidates;
}

// One candidate per application target group, with every rule forwarding to it.
async function groupCandidate(arn: string, members: Row[], ctx: {
  where: { account: string; region: string };
  tags: Map<string, Record<string, string>>;
  weighted: Set<string>;
  elbv2: ScanPorts['elbv2'];
  owners: { groups: Map<string, { name: string; arn?: string }>; services: Map<string, string> };
}): Promise<ScannedRule> {
  const first = members[0]!;
  const app = first.app!;
  const managedRules = members.filter((m) => m.managed);
  const base: ScannedRule = {
    id: arn,
    account: ctx.where.account,
    region: ctx.where.region,
    loadBalancer: first.lb.LoadBalancerName ?? '',
    loadBalancerArn: first.lb.LoadBalancerArn ?? '',
    listener: `${first.listener.Protocol}:${first.listener.Port}`,
    priority: first.rule.Priority ?? '',
    conditions: `${conditionsOf(first.rule)}${members.length > 1 ? ` (+${members.length - 1} rules)` : ''}`,
    hosts: [...new Set(members.flatMap((m) => hostsOf(m.rule)))],
    targetGroup: app.TargetGroupName ?? null,
    targetGroupArn: arn,
    backend: null,
    tags: tagValues([...new Set(members.map((m) => m.lb.LoadBalancerArn ?? ''))].map((a) => ctx.tags.get(a))
      .concat([ctx.tags.get(arn)], members.map((m) => ctx.tags.get(m.rule.RuleArn ?? '')))),
    rules: members.map(ruleRef),
    eligibility: 'eligible',
    idleHours7d: null,
    requests7d: null,
  };
  // What keeps the group from being napped as one workload, in order.
  const workloads = [...new Set(managedRules.map((m) => m.managed!))];
  const outside = members.filter((m) => !m.managed && !(m.shadowedBy && workloads.includes(m.shadowedBy)));
  const issue = members.some((m) => m.rule.IsDefault) ? 'listener default action (not supported yet)'
    // Napping one workload would leave the other's rules in front of a stopped backend.
    : workloads.length > 1 ? `rules of ${workloads.length} workloads share the target group (${workloads.join(', ')})`
    : managedRules.length && outside.length ? `${outside.length} of ${members.length} rules sharing the target group are not part of the workload`
    : ctx.weighted.has(arn) ? 'target group also in a weighted forward'
    : new Set(members.map((m) => m.lb.LoadBalancerArn)).size > 1 ? 'target group used by several load balancers'
    : members.length > MAX_RULES ? `more than ${MAX_RULES} rules`
    : null;
  const backend = await backendOf(ctx.elbv2, app, ctx.owners);
  if (managedRules.length) {
    return { ...base, eligibility: 'managed', workloadId: managedRules[0]!.managed, backend: typeof backend === 'string' ? null : backend, ...(issue ? { reason: issue } : {}) };
  }
  if (issue) return { ...base, eligibility: 'ineligible', reason: issue };
  return typeof backend === 'string' ? { ...base, eligibility: 'ineligible', reason: backend } : { ...base, backend };
}

// A rule that forwards to no single application target group: a candidate of its own, never eligible.
function ruleCandidate(row: Row, where: { account: string; region: string }, tags: Map<string, Record<string, string>>, groups: Map<string, TargetGroup>): ScannedRule {
  const { lb, rule, forward } = row;
  const group = forward.groups.length === 1 ? groups.get(forward.groups[0]!) : undefined;
  const reason = forward.type !== 'forward' ? REASONS[forward.type ?? ''] ?? `${forward.type} action`
    : forward.groups.length !== 1 ? 'weighted forward to several target groups'
    : !group ? 'target group not found'
    : group.TargetType === 'lambda' ? 'Lambda target group'
    : group.TargetType === 'alb' ? 'load balancer target group'
    : 'application target group not found';
  return {
    id: rule.RuleArn ?? '',
    account: where.account,
    region: where.region,
    loadBalancer: lb.LoadBalancerName ?? '',
    loadBalancerArn: lb.LoadBalancerArn ?? '',
    listener: `${row.listener.Protocol}:${row.listener.Port}`,
    priority: rule.Priority ?? '',
    conditions: conditionsOf(rule),
    hosts: hostsOf(rule),
    targetGroup: group?.TargetGroupName ?? null,
    targetGroupArn: group?.TargetGroupArn ?? null,
    backend: null,
    tags: tagValues([tags.get(lb.LoadBalancerArn ?? ''), group ? tags.get(group.TargetGroupArn ?? '') : undefined, tags.get(rule.RuleArn ?? '')]),
    rules: [ruleRef(row)],
    // A managed rule that no longer forwards to its application waits for offboarding.
    ...(row.managed ? { eligibility: 'managed' as const, workloadId: row.managed, reason } : { eligibility: 'ineligible' as const, reason }),
    idleHours7d: null,
    requests7d: null,
  };
}

// Every value of each tag over the load balancer, target group and rule: a tag criterion matches any of the three.
function tagValues(sets: (Record<string, string> | undefined)[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const set of sets) {
    for (const [key, value] of Object.entries(set ?? {})) {
      out[key] ??= [];
      if (!out[key].includes(value)) out[key].push(value);
    }
  }
  return out;
}

// The backend behind a target group (Auto Scaling group, ECS service or instance), or why there is none.
async function backendOf(
  elbv2: ScanPorts['elbv2'],
  group: TargetGroup,
  owners: { groups: Map<string, { name: string; arn?: string }>; services: Map<string, string> },
): Promise<string | { kind: BackendKind; id: string; arn?: string }> {
  const arn = group.TargetGroupArn ?? '';
  const asg = owners.groups.get(arn);
  if (asg) return { kind: 'asg', id: asg.name, ...(asg.arn ? { arn: asg.arn } : {}) };
  const service = owners.services.get(arn);
  if (service) return { kind: 'ecs', id: service, arn: service };
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: arn });
  const ids = TargetHealthDescriptions.map((d) => d.Target?.Id).filter((id): id is string => Boolean(id));
  if (!ids.length) return 'no backend: no registered target, Auto Scaling group or ECS service';
  if (group.TargetType === 'ip') return 'IP targets without an ECS service';
  // The instance's ARN in the target group's partition, region and account.
  const [, partition, , region, account] = arn.split(':');
  return { kind: 'instance', id: ids[0]!, arn: `arn:${partition}:ec2:${region}:${account}:instance/${ids[0]}` };
}
