// Phase 1 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §4): each reached account's regions,
// discovery's scan of each (the product's eligibility), and what each eligible workload's backend would stop (the
// router's description, priced later). Kept per account and region: a run reuses what is fresh and resumes the rest; a
// region that fails is said and tried again next time. Four accounts at a time, an account's regions one by one; an
// account's role is assumed only when one of its regions is not kept.
import type { Rule, ScannedRule } from '@dormeto/discovery';
import type { Credentials } from '@dormeto/discovery/aws';
import type { StoppedItem } from '@dormeto/fleet';
import type { Reached } from './accounts.js';
import { freshDiscovery, type Cache } from './cache.js';
import { describeStopped, type RouterBackend, type StoppedPorts } from './stopped.js';

export interface Workload {
  account: string;
  region: string;
  loadBalancer: string;
  loadBalancerArn: string;
  targetGroup: string;
  targetGroupArn: string;
  hosts: string[];
  backend: { kind: 'instance' | 'asg' | 'ecs'; id: string };
  stopped: StoppedItem[];
  // Every value of each tag on its load balancer, target group or rule (discovery's), for --exclude-tags.
  tags: Record<string, string[]>;
  // An instance's state when discovered (not one Dormeto manages): one stopped is described all the same, estimated only
  // from its measured uptime (--ec2-uptime).
  instanceState?: string;
  // Already managed by Dormeto: its requests while asleep go to its waker target group, added up (as R10).
  managed?: true;
  wakerTargetGroupArn?: string;
}
export interface Ineligible { loadBalancer: string; targetGroup: string | null; hosts: string[]; reason: string }
export interface RegionDiscovery { account: string; region: string; workloads: Workload[]; ineligible: Ineligible[]; error?: string }
export interface RegionPorts extends StoppedPorts {
  scan(): Promise<ScannedRule[]>;
  autoscaling: { describeAutoScalingGroups(input: { AutoScalingGroupNames: string[] }): Promise<{ AutoScalingGroups?: { AutoScalingGroupName?: string; DesiredCapacity?: number; Instances?: { InstanceId?: string }[] }[] }> };
  elbv2: { describeRules(input: { RuleArns: string[] }): Promise<{ Rules?: Rule[] }> };
}
export type Progress = (event: { phase: 'discovery' | 'requests' | 'uptime'; account: string; region: string; from: 'cache' | 'aws'; workloads: number; error?: string }) => void;

// An ECS service ARN names its cluster (arn:aws:ecs:<region>:<account>:service/<cluster>/<service>); the old format
// (service/<service>) is in the default cluster.
const clusterOf = (serviceArn: string) => {
  const parts = serviceArn.split(':').at(-1)!.split('/');
  return parts.length >= 3 ? parts[1]! : 'default';
};

// Discovery's backend as the router describes it: an Auto Scaling group's desired capacity and instances, an ECS
// service's cluster and desired count, an instance (with its state, unless Dormeto manages it).
async function routerBackend(ports: RegionPorts, backend: NonNullable<ScannedRule['backend']>, managed: boolean): Promise<{ running: RouterBackend | null; instanceState?: string }> {
  if (backend.kind === 'asg') {
    const { AutoScalingGroups: [group] = [] } = await ports.autoscaling.describeAutoScalingGroups({ AutoScalingGroupNames: [backend.id] });
    return { running: { kind: 'asg', name: backend.id, desired: group?.DesiredCapacity ?? 0, instances: (group?.Instances ?? []).map((i) => i.InstanceId).filter((id): id is string => Boolean(id)) } };
  }
  if (backend.kind === 'ecs') {
    const cluster = clusterOf(backend.id);
    const { services: [service] = [] } = await ports.ecs.describeServices({ cluster, services: [backend.id] });
    return { running: { kind: 'ecs', id: backend.id, cluster, desired: service?.desiredCount ?? 0 } };
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

export async function discoverRegion(ports: RegionPorts, { account, region }: { account: string; region: string }): Promise<RegionDiscovery> {
  const workloads: Workload[] = [];
  const ineligible: Ineligible[] = [];
  for (const rule of await ports.scan()) {
    if (rule.eligibility === 'ineligible' || !rule.backend || !rule.targetGroupArn) {
      ineligible.push({ loadBalancer: rule.loadBalancer, targetGroup: rule.targetGroup, hosts: rule.hosts, reason: rule.reason ?? 'no backend' });
      continue;
    }
    // The estimate scans without the clusters' API: no Kubernetes backend comes here.
    if (rule.backend.kind === 'k8s') continue;
    const managed = rule.eligibility === 'managed' ? await wakerOf(ports, rule) : null;
    let stopped: StoppedItem[];
    let instanceState: string | undefined;
    try {
      const found = await routerBackend(ports, rule.backend, managed !== null);
      instanceState = found.instanceState;
      stopped = found.running ? await describeStopped(ports, [found.running]) : [];
    } catch (err) {
      // Never guessed: an item that cannot be priced, said in the estimate.
      stopped = [{ kind: 'unknown', backend: `${rule.backend.kind}:${rule.backend.id}`, reason: (err as Error).message.slice(0, 200) } as unknown as StoppedItem];
    }
    workloads.push({
      account, region, loadBalancer: rule.loadBalancer, loadBalancerArn: rule.loadBalancerArn, targetGroup: rule.targetGroup ?? '',
      targetGroupArn: rule.targetGroupArn, hosts: rule.hosts, backend: { kind: rule.backend.kind, id: rule.backend.id }, stopped, tags: rule.tags,
      ...(instanceState ? { instanceState } : {}),
      ...(managed ? { managed: true as const, ...(managed.waker ? { wakerTargetGroupArn: managed.waker } : {}) } : {}),
    });
  }
  return { account, region, workloads, ineligible };
}

// regions: --regions, used as given (never cached as an account's enabled regions); null: each account's enabled ones.
export async function discoverAll({ reached, regions: given, regionsOf, portsOf, cache, refresh, now, progress = () => {}, concurrency = 4 }: {
  reached: Reached;
  regions: string[] | null;
  regionsOf: (account: string, credentials: Credentials | null) => Promise<string[]>;
  portsOf: (account: string, region: string, credentials: Credentials | null) => RegionPorts;
  cache: Cache;
  refresh: 'discovery' | 'metrics' | null;
  now: () => number;
  progress?: Progress;
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
      try {
        const regionsPath = `regions/${account}.json`;
        let regions = given ?? (again ? null : await cache.get<string[]>(regionsPath, freshDiscovery(now())));
        if (!regions) {
          regions = await regionsOf(account, await credentials());
          await cache.put(regionsPath, regions);
        }
        for (const region of regions) {
          const path = `discovery/${account}-${region}.json`;
          const kept = again ? null : await cache.get<RegionDiscovery>(path, freshDiscovery(now()));
          // Kept before workloads had their tags, or instances their state: scanned again.
          if (kept && kept.workloads.every((w) => w.tags && (w.backend.kind !== 'instance' || w.managed || w.instanceState))) {
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
        if (!reached.unreachable.some((u) => u.account === account)) {
          found.push({ account, region: '*', workloads: [], ineligible: [], error: `${(err as Error).name}: ${(err as Error).message}` });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, reached.accounts.length) }, work));
  // In the organization's order, whatever finished first.
  return { regions: reached.accounts.flatMap((a) => byAccount.get(a.account) ?? []) };
}
