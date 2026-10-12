// Phase 1 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §4): each reached account's regions,
// discovery's scan of each (the product's eligibility), and what each eligible workload's backend would stop (the
// router's description, priced later). Kept per account and region: a run reuses what is fresh and resumes the rest; a
// region that fails is said and tried again next time. --parallel accounts at a time (5 by default), an account's regions
// one by one, a region's workloads eight at a time; an account's role is assumed only when one of its regions is not kept.
import type { Rule, ScannedRule } from '@dormeto/discovery';
import type { Credentials } from '@dormeto/discovery/aws';
import type { StoppedItem } from '@dormeto/fleet';
import type { Reached } from './accounts.js';
import { freshDiscovery, type Cache } from './cache.js';
import { mapLimit } from './limit.js';
import { describeStopped, type RouterBackend, type StoppedPorts } from './stopped.js';

export interface Workload {
  account: string;
  region: string;
  loadBalancer: string;
  loadBalancerArn: string;
  targetGroup: string;
  targetGroupArn: string;
  hosts: string[];
  backend: { kind: 'instance' | 'asg' | 'ecs' | 'k8s'; id: string };
  stopped: StoppedItem[];
  // Every value of each tag on its load balancer, target group or rule (discovery's), for --exclude-tags.
  tags: Record<string, string[]>;
  // An instance's state when discovered (not one Dormeto manages): one stopped is described all the same, estimated only
  // from its measured uptime (--ec2-uptime).
  instanceState?: string;
  // An ECS service's desired count when discovered (not one Dormeto manages): one at 0 is described as one task, estimated
  // only from its measured uptime (--ecs-uptime).
  ecsDesired?: number;
  // Already managed by Dormeto: its requests while asleep go to its waker target group, added up (as R10).
  managed?: true;
  wakerTargetGroupArn?: string;
  // Its backend's security groups (an instance's, its Auto Scaling group's instances', an ECS service's): a database whose
  // security group lets one in is its companion. Kubernetes pods share their nodes' groups: not matched yet.
  securityGroups?: string[];
}
// A companion database candidate of the region (the user, 2026-10-11): an RDS instance, or an Aurora provisioned cluster
// (its instances), whose security groups let in allowedFrom; what a nap would stop, as the router describes it; why it
// cannot be stopped with a workload, if so (then nothing to price).
export interface Database {
  kind: 'rds-instance' | 'rds-cluster';
  id: string;
  // Its status when discovered: one stopped (a schedule may start it) is a companion all the same, its uptime measured.
  status: string;
  allowedFrom: string[];
  tags: Record<string, string[]>;
  stopped: StoppedItem[];
  notStoppable?: string;
}
export interface Ineligible { loadBalancer: string; targetGroup: string | null; hosts: string[]; reason: string }
// clusters: the region's EKS clusters the profile cannot read, with why (R10.5).
// databases: the region's companion candidates (letting in a workload's security group); databasesError: why they could
// not be read.
export interface RegionDiscovery {
  account: string; region: string; workloads: Workload[]; ineligible: Ineligible[]; clusters?: { name: string; reason: string }[]; error?: string;
  databases?: Database[]; databasesError?: string;
}
type DbInstance = {
  DBInstanceIdentifier?: string; DBInstanceStatus?: string; Engine?: string; DBInstanceClass?: string; MultiAZ?: boolean; DBClusterIdentifier?: string;
  ReadReplicaSourceDBInstanceIdentifier?: string; ReadReplicaDBInstanceIdentifiers?: string[]; VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[];
  TagList?: { Key?: string; Value?: string }[];
};
type DbCluster = {
  DBClusterIdentifier?: string; Status?: string; Engine?: string; EngineMode?: string; VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[];
  TagList?: { Key?: string; Value?: string }[];
};
export interface RegionPorts extends StoppedPorts {
  scan(): Promise<ScannedRule[]>;
  // The clusters the last scan could not read (set by the scan).
  unreadableClusters?: () => { name: string; reason: string }[];
  autoscaling: { describeAutoScalingGroups(input: { AutoScalingGroupNames: string[] }): Promise<{ AutoScalingGroups?: { AutoScalingGroupName?: string; DesiredCapacity?: number; Instances?: { InstanceId?: string }[] }[] }> };
  elbv2: { describeRules(input: { RuleArns: string[] }): Promise<{ Rules?: Rule[] }> };
  ec2: StoppedPorts['ec2'] & {
    describeSecurityGroups?(input: { GroupIds: string[] }): Promise<{ SecurityGroups?: { GroupId?: string; IpPermissions?: { UserIdGroupPairs?: { GroupId?: string }[] }[] }[] }>;
  };
  rds?: {
    describeDBInstances(input: { Marker?: string }): Promise<{ DBInstances?: DbInstance[]; Marker?: string }>;
    describeDBClusters(input: { Marker?: string }): Promise<{ DBClusters?: DbCluster[]; Marker?: string }>;
  };
}
export type ProgressEvent = { phase: 'discovery' | 'requests' | 'uptime'; account: string; region: string; from: 'cache' | 'aws'; workloads: number; error?: string };
export type Progress = (event: ProgressEvent) => void;
// An account of the discovery phase: started once its regions are known, done after the last (error: none could be read).
export type AccountEvent = { account: string; state: 'started' | 'done'; regions: number; error?: string };

// An ECS service ARN names its cluster (arn:aws:ecs:<region>:<account>:service/<cluster>/<service>); the old format
// (service/<service>) is in the default cluster.
export const clusterOf = (serviceArn: string) => {
  const parts = serviceArn.split(':').at(-1)!.split('/');
  return parts.length >= 3 ? parts[1]! : 'default';
};

// Discovery's backend as the router describes it: an Auto Scaling group's desired capacity and instances, an ECS
// service's cluster and desired count, an instance (with its state, unless Dormeto manages it).
async function routerBackend(ports: RegionPorts, backend: NonNullable<ScannedRule['backend']>, managed: boolean): Promise<{ running: RouterBackend | null; instanceState?: string; ecsDesired?: number }> {
  if (backend.kind === 'k8s') {
    const k = backend.kubernetes!;
    return { running: { kind: 'k8s', id: backend.id, cluster: k.cluster, namespace: k.namespace, owner: k.owner, autoscaler: k.autoscaler } };
  }
  if (backend.kind === 'asg') {
    const { AutoScalingGroups: [group] = [] } = await ports.autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [backend.id] });
    return { running: { kind: 'asg', name: backend.id, desired: group?.DesiredCapacity ?? 0, instances: (group?.Instances ?? []).map((i) => i.InstanceId).filter((id): id is string => Boolean(id)) } };
  }
  if (backend.kind === 'ecs') {
    const cluster = clusterOf(backend.id);
    const { services: [service] = [] } = await ports.ecs.describeServices({ cluster, services: [backend.id] });
    const desired = service?.desiredCount ?? 0;
    if (managed) return { running: { kind: 'ecs', id: backend.id, cluster, desired } };
    return { running: { kind: 'ecs', id: backend.id, cluster, desired: Math.max(desired, 1) }, ecsDesired: desired };
  }
  // Dormeto manages it: stopped for a nap, it runs when woken. Otherwise its state: one stopped is described all the same
  // (the estimate says it stops nothing, unless its measured uptime shows it ran); one terminated stops nothing. No
  // state said: running.
  if (managed) return { running: { kind: 'instance', id: backend.id } };
  const { Reservations = [] } = await ports.ec2.describeInstances({ InstanceIds: [backend.id] });
  const state = Reservations.flatMap((r) => r.Instances ?? [])[0]?.State?.Name ?? 'running';
  return { running: state === 'terminated' || state === 'shutting-down' ? null : { kind: 'instance', id: backend.id }, instanceState: state };
}

// A managed workload's waker target group: the other target group of its Dormeto rule's forward (application and waker
// only), or none found (its requests while asleep are then not counted).
async function wakerOf(ports: RegionPorts, rule: ScannedRule): Promise<{ waker: string | null }> {
  const ref = rule.rules.find((r) => r.managed) ?? rule.rules[0];
  if (!ref) return { waker: null };
  const { Rules = [] } = await ports.elbv2.describeRules({ RuleArns: [ref.id] });
  for (const action of Rules[0]?.Actions ?? []) {
    const groups = (action.ForwardConfig?.TargetGroups ?? []).map((g) => g.TargetGroupArn).filter((arn): arn is string => Boolean(arn));
    if (groups.length === 2 && groups.includes(rule.targetGroupArn!)) return { waker: groups.find((arn) => arn !== rule.targetGroupArn)! };
  }
  return { waker: null };
}

const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];

// The security groups of a workload's backend: an instance's, its Auto Scaling group's instances', an ECS service's
// (awsvpc). None for a Kubernetes owner (its pods share their nodes' groups) or when they cannot be read.
async function securityGroupsOf(ports: RegionPorts, backend: NonNullable<ScannedRule['backend']>, running: RouterBackend | null): Promise<string[]> {
  try {
    if (backend.kind === 'instance' || backend.kind === 'asg') {
      const ids = backend.kind === 'instance' ? [backend.id] : running?.kind === 'asg' ? running.instances : [];
      if (!ids.length) return [];
      const { Reservations = [] } = await ports.ec2.describeInstances({ InstanceIds: ids });
      return unique(Reservations.flatMap((r) => r.Instances ?? []).flatMap((i) => i.SecurityGroups ?? []).map((g) => g.GroupId));
    }
    if (backend.kind === 'ecs') {
      const { services: [service] = [] } = await ports.ecs.describeServices({ cluster: clusterOf(backend.id), services: [backend.id] });
      return unique(service?.networkConfiguration?.awsvpcConfiguration?.securityGroups ?? []);
    }
  } catch {
    // Not read: the workload gets no companion.
  }
  return [];
}

async function pages<T>(call: (marker?: string) => Promise<Record<string, unknown> & { Marker?: string }>, key: string): Promise<T[]> {
  const items: T[] = [];
  let marker: string | undefined;
  do {
    const page = await call(marker);
    items.push(...((page[key] as T[] | undefined) ?? []));
    marker = page.Marker;
  } while (marker);
  return items;
}

const tagsOf = (list: { Key?: string; Value?: string }[] = []) => {
  const tags: Record<string, string[]> = {};
  for (const t of list) if (t.Key) (tags[t.Key] ??= []).push(t.Value ?? '');
  return tags;
};
// What a nap of the database would stop, as the router describes it (lambda/src/lib/stopped.mjs).
const dbItem = (db: DbInstance) => ({ kind: 'rds', class: db.DBInstanceClass, engine: db.Engine, multiAz: db.MultiAZ === true }) as unknown as StoppedItem;
// The statuses of a database a nap can stop, or one stopped (a schedule may start it again: its uptime says when).
const NAPPABLE = new Set(['available', 'stopped', 'stopping', 'starting']);
const activeGroups = (groups: { VpcSecurityGroupId?: string; Status?: string }[] = []) => unique(groups.filter((g) => g.Status !== 'inactive').map((g) => g.VpcSecurityGroupId));

// The region's databases letting in one of `groups`, with their tags, what they stop, why they cannot be stopped.
async function databasesOf(ports: RegionPorts, groups: Set<string>): Promise<{ databases: Database[]; error?: string }> {
  const { rds } = ports;
  if (!rds || !groups.size || !ports.ec2.describeSecurityGroups) return { databases: [] };
  try {
    const instances = await pages<DbInstance>((m) => rds.describeDBInstances(m ? { Marker: m } : {}), 'DBInstances');
    const clusters = await pages<DbCluster>((m) => rds.describeDBClusters(m ? { Marker: m } : {}), 'DBClusters');
    const found: (Omit<Database, 'allowedFrom'> & { groups: string[] })[] = [];
    for (const db of instances.filter((i) => !i.DBClusterIdentifier)) {
      const notStoppable = !NAPPABLE.has(db.DBInstanceStatus ?? '') ? `${db.DBInstanceStatus} when discovered`
        : db.ReadReplicaSourceDBInstanceIdentifier ? 'a read replica: cannot be stopped'
        : db.ReadReplicaDBInstanceIdentifiers?.length ? 'it has read replicas: cannot be stopped'
        : db.Engine?.startsWith('sqlserver') && db.MultiAZ ? 'SQL Server Multi-AZ: cannot be stopped'
        : undefined;
      found.push({ kind: 'rds-instance', id: db.DBInstanceIdentifier ?? '', status: db.DBInstanceStatus ?? '', groups: activeGroups(db.VpcSecurityGroups), tags: tagsOf(db.TagList), stopped: notStoppable ? [] : [dbItem(db)], ...(notStoppable ? { notStoppable } : {}) });
    }
    for (const cluster of clusters) {
      const members = instances.filter((i) => i.DBClusterIdentifier === cluster.DBClusterIdentifier);
      const notStoppable = cluster.EngineMode === 'serverless' || members.some((i) => i.DBInstanceClass === 'db.serverless') ? 'Aurora Serverless: not yet'
        : !cluster.Engine?.startsWith('aurora') ? 'a Multi-AZ DB cluster: not yet'
        : !NAPPABLE.has(cluster.Status ?? '') ? `${cluster.Status} when discovered`
        : !members.length ? 'no instance'
        : undefined;
      found.push({ kind: 'rds-cluster', id: cluster.DBClusterIdentifier ?? '', status: cluster.Status ?? '', groups: activeGroups(cluster.VpcSecurityGroups), tags: tagsOf(cluster.TagList), stopped: notStoppable ? [] : members.map(dbItem), ...(notStoppable ? { notStoppable } : {}) });
    }
    // Who each database security group lets in (rules naming a security group; address ranges are not followed).
    const ingress = new Map<string, string[]>();
    const asked = unique(found.flatMap((f) => f.groups));
    for (let first = 0; first < asked.length; first += 100) {
      const { SecurityGroups = [] } = await ports.ec2.describeSecurityGroups({ GroupIds: asked.slice(first, first + 100) });
      for (const sg of SecurityGroups) ingress.set(sg.GroupId ?? '', unique((sg.IpPermissions ?? []).flatMap((p) => p.UserIdGroupPairs ?? []).map((p) => p.GroupId)));
    }
    const databases = found
      .map(({ groups: own, ...db }) => ({ ...db, allowedFrom: unique(own.flatMap((g) => ingress.get(g) ?? [])) }))
      .filter((db) => db.allowedFrom.some((g) => groups.has(g)));
    return { databases };
  } catch (err) {
    return { databases: [], error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

// A region's workloads described this many at a time (an account's own calls: AWS throttles per account), in their order.
const WORKLOADS_AT_ONCE = 8;

export async function discoverRegion(ports: RegionPorts, { account, region }: { account: string; region: string }): Promise<RegionDiscovery> {
  const described = await mapLimit(await ports.scan(), WORKLOADS_AT_ONCE, (rule) => describeRule(ports, rule, { account, region }));
  const workloads = described.flatMap((d) => ('workload' in d ? [d.workload] : []));
  const ineligible = described.flatMap((d) => ('ineligible' in d ? [d.ineligible] : []));
  const clusters = ports.unreadableClusters?.() ?? [];
  const { databases, error: databasesError } = await databasesOf(ports, new Set(workloads.flatMap((w) => w.securityGroups ?? [])));
  return { account, region, workloads, ineligible, ...(clusters.length ? { clusters } : {}), databases, ...(databasesError ? { databasesError } : {}) };
}

// One rule of the scan: an eligible workload described as the router would (what it stops, its security groups), else why not.
async function describeRule(ports: RegionPorts, rule: ScannedRule, { account, region }: { account: string; region: string }): Promise<{ workload: Workload } | { ineligible: Ineligible }> {
  if (rule.eligibility === 'ineligible' || !rule.backend || !rule.targetGroupArn) {
    return { ineligible: { loadBalancer: rule.loadBalancer, targetGroup: rule.targetGroup, hosts: rule.hosts, reason: rule.reason ?? 'no backend' } };
  }
  const managed = rule.eligibility === 'managed' ? await wakerOf(ports, rule) : null;
  let stopped: StoppedItem[];
  let instanceState: string | undefined;
  let ecsDesired: number | undefined;
  let running: RouterBackend | null = null;
  try {
    const found = await routerBackend(ports, rule.backend, managed !== null);
    instanceState = found.instanceState;
    ecsDesired = found.ecsDesired;
    running = found.running;
    stopped = found.running ? await describeStopped(ports, [found.running]) : [];
  } catch (err) {
    // Never guessed: an item that cannot be priced, said in the estimate.
    stopped = [{ kind: 'unknown', backend: `${rule.backend.kind}:${rule.backend.id}`, reason: (err as Error).message.slice(0, 200) } as unknown as StoppedItem];
  }
  return { workload: {
    account, region, loadBalancer: rule.loadBalancer, loadBalancerArn: rule.loadBalancerArn, targetGroup: rule.targetGroup ?? '',
    targetGroupArn: rule.targetGroupArn, hosts: rule.hosts, backend: { kind: rule.backend.kind, id: rule.backend.id }, stopped, tags: rule.tags,
    ...(instanceState ? { instanceState } : {}),
    ...(ecsDesired !== undefined ? { ecsDesired } : {}),
    ...(managed ? { managed: true as const, ...(managed.waker ? { wakerTargetGroupArn: managed.waker } : {}) } : {}),
    securityGroups: await securityGroupsOf(ports, rule.backend, running),
  } };
}

// regions: --regions, used as given (never cached as an account's enabled regions); null: each account's enabled ones.
export async function discoverAll({ reached, regions: given, regionsOf, portsOf, cache, refresh, now, progress = () => {}, accountProgress = () => {}, concurrency = 5 }: {
  reached: Reached;
  regions: string[] | null;
  regionsOf: (account: string, credentials: Credentials | null) => Promise<string[]>;
  portsOf: (account: string, region: string, credentials: Credentials | null) => RegionPorts;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
  accountProgress?: (event: AccountEvent) => void;
  // Accounts discovered at once (--parallel).
  concurrency?: number;
}): Promise<{ regions: RegionDiscovery[] }> {
  const byAccount = new Map<string, RegionDiscovery[]>();
  const queue = [...reached.accounts];
  const again = refresh === 'discovery';
  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { account, credentials } = next;
      const found: RegionDiscovery[] = [];
      byAccount.set(account, found);
      let listed = 0;
      try {
        const regionsPath = `regions/${account}.json`;
        let regions = given ?? (again ? null : await cache.get<string[]>(regionsPath, freshDiscovery(now())));
        if (!regions) {
          regions = await regionsOf(account, await credentials());
          await cache.put(regionsPath, regions);
        }
        listed = regions.length;
        accountProgress({ account, state: 'started', regions: listed });
        for (const region of regions) {
          const path = `discovery/${account}-${region}.json`;
          const kept = again ? null : await cache.get<RegionDiscovery>(path, freshDiscovery(now()));
          // Kept before workloads had their tags and security groups, instances their state, or the region its companion
          // databases with their status: scanned again.
          if (kept && kept.databases?.every((d) => d.status) && kept.workloads.every((w) => w.tags && w.securityGroups && (w.backend.kind !== 'instance' || w.managed || w.instanceState))) {
            found.push(kept);
            progress({ phase: 'discovery', account, region, from: 'cache', workloads: kept.workloads.length });
            continue;
          }
          const ports = portsOf(account, region, await credentials());
          let result: RegionDiscovery;
          try {
            result = await discoverRegion(ports, { account, region });
            await cache.put(path, result);
          } catch (err) {
            result = { account, region, workloads: [], ineligible: [], error: (err as Error).message };
          }
          found.push(result);
          progress({ phase: 'discovery', account, region, from: 'aws', workloads: result.workloads.length, ...(result.error ? { error: result.error } : {}) });
        }
      } catch (err) {
        // A refused role is already in reached.unreachable; any other failure of the account is said, never dropped.
        const error = `${(err as Error).name}: ${(err as Error).message}`;
        if (!reached.unreachable.some((u) => u.account === account)) found.push({ account, region: '*', workloads: [], ineligible: [], error });
        accountProgress({ account, state: 'done', regions: listed, error });
        continue;
      }
      accountProgress({ account, state: 'done', regions: listed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, reached.accounts.length) }, work));
  // In the organization's order, whatever finished first.
  return { regions: reached.accounts.flatMap((a) => byAccount.get(a.account) ?? []) };
}
