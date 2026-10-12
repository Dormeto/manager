// One account and region: every rule of the application load balancers, with what Dormeto could do with it (managed,
// eligible, ineligible and why), its host names and tags, and how idle its target group was over the last 7 days.
// Ported from the router discovery (router lambda/src/lib/candidates.mjs).
import type { BackendKind, ScannedRule } from './types.js';

const WORKLOAD_TAG = 'dormeto:workload';
const ROLE_TAG = 'dormeto:role';
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
  const groups = new Map<string, string>();
  const services = new Map<string, string>();
  if (autoscaling) {
    const asgs = await all<{ AutoScalingGroupName?: string; TargetGroupARNs?: string[] }>((i) => autoscaling.describeAutoScalingGroups(i), 'AutoScalingGroups', { in: 'NextToken', out: 'NextToken' });
    for (const g of asgs) for (const arn of g.TargetGroupARNs ?? []) groups.set(arn, g.AutoScalingGroupName ?? '');
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

export async function scanRegion(ports: ScanPorts, where: { account: string; region: string }, { now = Date.now }: { now?: () => number } = {}): Promise<ScannedRule[]> {
  const { elbv2 } = ports;
  const lbs = (await all<LoadBalancer>((i) => elbv2.describeLoadBalancers(i), 'LoadBalancers')).filter((lb) => lb.Type === 'application');
  const rows: { lb: LoadBalancer; listener: Listener; rule: Rule; forward: Forward }[] = [];
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

  const usage = new Map<string, number>();
  for (const r of visible) for (const arn of r.forward.groups) usage.set(arn, (usage.get(arn) ?? 0) + 1);
  const owners = await backendOwners(ports);

  const scanned: ScannedRule[] = [];
  for (const { lb, listener, rule, forward } of visible) {
    const ruleTags = tags.get(rule.RuleArn ?? '') ?? {};
    const managed = ruleTags[WORKLOAD_TAG];
    // The application target group of a managed rule, whatever the weights (asleep, the waker has weight 1).
    const group = managed
      ? forward.all.map((arn) => groups.get(arn)).find((g) => g && g.TargetType !== 'lambda')
      : forward.groups.length === 1 ? groups.get(forward.groups[0]!) : undefined;
    const base: ScannedRule = {
      id: rule.RuleArn ?? '',
      account: where.account,
      region: where.region,
      loadBalancer: lb.LoadBalancerName ?? '',
      loadBalancerArn: lb.LoadBalancerArn ?? '',
      listener: `${listener.Protocol}:${listener.Port}`,
      priority: rule.Priority ?? '',
      conditions: conditionsOf(rule),
      hosts: hostsOf(rule),
      targetGroup: group?.TargetGroupName ?? null,
      targetGroupArn: group?.TargetGroupArn ?? null,
      suggestedId: managed ? null : group?.TargetGroupName ?? null,
      backend: null,
      tags: tagValues([tags.get(lb.LoadBalancerArn ?? ''), group ? tags.get(group.TargetGroupArn ?? '') : undefined, ruleTags]),
      eligibility: 'eligible',
      idleHours7d: null,
      requests7d: null,
    };
    if (managed) {
      // Its backend too, so that backend type filters apply to managed workloads (pending offboarding).
      const backend = group?.TargetGroupArn ? await backendOf(elbv2, group, owners) : null;
      const issue = managedIssue(forward, group, usage);
      scanned.push({ ...base, eligibility: 'managed', workloadId: managed, backend: typeof backend === 'string' ? null : backend, ...(issue ? { reason: issue } : {}) });
      continue;
    }
    const verdict = await ineligibility(elbv2, forward, group, usage, owners);
    scanned.push(typeof verdict === 'string' ? { ...base, eligibility: 'ineligible', reason: verdict } : { ...base, backend: verdict });
  }

  const measured = scanned.filter((r) => r.eligibility !== 'ineligible' && r.targetGroupArn);
  const pairs = [...new Map(measured.map((r) => [r.targetGroupArn!, { lb: r.loadBalancerArn, tg: r.targetGroupArn! }])).values()];
  const idle = pairs.length && ports.cloudwatch ? await idleHours(ports.cloudwatch, pairs, now) : new Map();
  for (const r of measured) Object.assign(r, idle.get(r.targetGroupArn!) ?? {});
  return scanned;
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

// What makes a managed rule no longer manageable (it then waits for offboarding), or null.
function managedIssue(forward: Forward, group: TargetGroup | undefined, usage: Map<string, number>): string | null {
  if (forward.type !== 'forward') return REASONS[forward.type ?? ''] ?? `${forward.type} action`;
  if (!group?.TargetGroupArn) return 'application target group not found';
  // Asleep, the rule sends no traffic to its application target group: other rules using it count, not this one.
  const others = (usage.get(group.TargetGroupArn) ?? 0) - (forward.groups.includes(group.TargetGroupArn) ? 1 : 0);
  return others > 0 ? `target group shared by ${others + 1} rules` : null;
}

// Why Dormeto cannot manage the rule, or its backend when it can.
async function ineligibility(
  elbv2: ScanPorts['elbv2'],
  forward: Forward,
  group: TargetGroup | undefined,
  usage: Map<string, number>,
  owners: { groups: Map<string, string>; services: Map<string, string> },
): Promise<string | { kind: BackendKind; id: string }> {
  if (forward.type !== 'forward') return REASONS[forward.type ?? ''] ?? `${forward.type} action`;
  if (forward.groups.length !== 1) return 'weighted forward to several target groups';
  if (!group?.TargetGroupArn) return 'target group not found';
  if (group.TargetType === 'lambda') return 'Lambda target group';
  if (group.TargetType === 'alb') return 'load balancer target group';
  const shared = usage.get(group.TargetGroupArn) ?? 0;
  if (shared > 1) return `target group shared by ${shared} rules`;
  return backendOf(elbv2, group, owners);
}

// The backend behind a target group (Auto Scaling group, ECS service or instance), or why there is none.
async function backendOf(
  elbv2: ScanPorts['elbv2'],
  group: TargetGroup,
  owners: { groups: Map<string, string>; services: Map<string, string> },
): Promise<string | { kind: BackendKind; id: string }> {
  const arn = group.TargetGroupArn ?? '';
  const asg = owners.groups.get(arn);
  if (asg) return { kind: 'asg', id: asg };
  const service = owners.services.get(arn);
  if (service) return { kind: 'ecs', id: service };
  const { TargetHealthDescriptions = [] } = await elbv2.describeTargetHealth({ TargetGroupArn: arn });
  const ids = TargetHealthDescriptions.map((d) => d.Target?.Id).filter((id): id is string => Boolean(id));
  if (!ids.length) return 'no backend: no registered target, Auto Scaling group or ECS service';
  if (group.TargetType === 'ip') return 'IP targets without an ECS service';
  return { kind: 'instance', id: ids[0]! };
}
