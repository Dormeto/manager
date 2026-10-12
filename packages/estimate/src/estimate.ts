// Phase 3 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §6): each eligible workload's
// requests replayed by the product's idle window advisor (R10) and priced by its price book, at the report's window
// (--window, an hour by default) and at the recommended one; what cannot be estimated, with the reason; the totals by account,
// region and all, net of Dormeto's cost. Conservative where the facts are unknown before install (decision 5).
import { resourceTagsMatch } from '@dormeto/discovery';
import { DORMETO_COST, idleWindowAdvice, savingsOf, type Baseline, type IdleWindowAdvice, type StoppedItem } from '@dormeto/fleet';
import type { Reached, Unreachable } from './accounts.js';
import type { Database, Ineligible, RegionDiscovery, Workload } from './discover.js';
import type { Options } from './options.js';
import type { RegionRequests } from './requests.js';
import { describeTags, type Excluded } from './tags.js';
import { measured, type RegionUptime } from './uptime.js';

const WAKE_MS = 60_000;

export interface WorkloadEstimate {
  workload: Workload;
  quiet: boolean; // no request in 14 days
  // What its naps would stop, running every hour of the baseline (or, measured, the hours it ran): its cost a month now.
  actualMonth: number;
  // An EC2 instance without an Auto Scaling group, with --ec2-uptime: the hours it ran a day, or why they are unknown
  // (then 24/7).
  uptime?: { hoursPerDay: number } | { unreadable: string };
  // At the report's window (options.window).
  atWindow: { usdMonth: number; wakesPerDay: number; asleepHours: number };
  recommended: { minutes: number; usdMonth: number; wakesPerDay: number };
  // Its companion databases, napped with it: their saving (included in the workload's) at the report's window and at
  // its recommended one.
  databases?: Companion[];
}
export interface Companion { kind: Database['kind']; id: string; usdMonth: number; recommendedUsdMonth: number }
export interface DatabaseLeftOut { workload: Workload; database: { kind: Database['kind']; id: string }; reason: string }
export interface LeftOut { workload: Workload; reason: string }
// Left out at its recommended window (minutes): waking more than --max-wakes a day (Busy), or saving less than
// --min-saving a month (Small), with what it would add.
export interface Busy { workload: Workload; wakesPerDay: number; usdMonth: number; minutes: number }
export interface Small { workload: Workload; usdMonth: number; minutes: number }
// withDormetoMonth: the actual cost less the savings at the report's window, plus Dormeto's cost (an account's: its
// routers and workloads; the total's: the manager too).
// kinds: the workloads by backend (an Auto Scaling group, an EC2 instance, an ECS service, a Kubernetes owner on EKS);
// excluded: the workloads not estimated, whatever the reason (tags, left out, too many wakes, too small a saving).
export interface Kinds { asg: number; ec2: number; ecs: number; eks: number }
export interface Totals { workloads: number; kinds: Kinds; excluded: number; databases: number; actualMonth: number; usdMonthWindow: number; usdMonthRecommended: number; dormetoMonth: number; withDormetoMonth: number }
// Dormeto's cost by part: how many, the cost of one a month, theirs.
export interface CostPart { count: number; unitMonth: number; usdMonth: number }
export interface DormetoCost { manager: CostPart; routers: CostPart & { where: { account: string; region: string }[] }; workloads: CostPart; usdMonth: number }
export interface Estimate {
  generatedAt: string;
  organization: string | null;
  why: string | null;
  options: Omit<Options, 'out' | 'profiles'>;
  accounts: number;
  // The accounts reached before --accounts restricted them.
  accountsListed: number;
  accountNames: Record<string, string>;
  totals: Totals;
  dormeto: DormetoCost;
  byAccount: Record<string, Totals>;
  byRegion: Record<string, Totals>;
  workloads: WorkloadEstimate[];
  leftOut: LeftOut[];
  // Excluded by their tags (--exclude-tags), before their requests were read.
  excluded: Excluded[];
  // Left out at their recommended window: waking more than options.maxWakes a day, saving less than options.minSaving.
  busy: Busy[];
  small: Small[];
  // Companion databases left out, with why; the regions whose databases could not be read.
  databasesLeftOut: DatabaseLeftOut[];
  databasesUnread: { account: string; region: string; reason: string }[];
  ineligible: (Ineligible & { account: string; region: string })[];
  unreachable: Unreachable[];
  failedRegions: { account: string; region: string; error: string }[];
  // The EKS clusters the profile cannot read (R10.5): their workloads are not estimated.
  unreadableClusters: { account: string; region: string; name: string; reason: string }[];
  assumptions: string[];
}

const NOTHING = 'nothing running to stop (an Auto Scaling group at 0, an ECS service on EC2 capacity, or a stopped instance)';

function assumptionsOf(baseline: Baseline, options: Omit<Options, 'out' | 'profiles'>, kubernetes: boolean): string[] {
  return [
    'Every request counts as activity and as a wake: no waker is installed yet to set scanners and other filtered requests apart, so the workloads stay awake longer here than they would (smaller savings).',
    'A wake lasts 60 seconds in the replay; the visitors\' wait is not estimated before install.',
    'Databases are not attached to load balancers: they are not counted (an installed router naps the ones attached to a workload).',
    `Prices: AWS's on-demand list prices, Spot prices for Spot capacity, less the discounts given (compute ${options.discounts.compute}%, databases ${options.discounts.databases}%); storage, load balancers and data transfer are not counted.`,
    `Savings counted within ${baseline.kind === 'always' ? 'every hour (24/7)' : `business hours (weekdays 08:00 to 20:00, ${baseline.timeZone})`}.`,
    options.ec2Uptime
      ? 'EC2 instances without an Auto Scaling group: their uptime measured over the 14 days (CloudWatch CPUUtilization, published every 5 minutes while an instance runs); their actual cost counts the hours they ran, their savings only the hours Dormeto would nap them while they ran. Instances Dormeto already manages and Auto Scaling groups are assumed to run all the time.'
      : 'EC2 instances without an Auto Scaling group are assumed to run 24/7 (--ec2-uptime measures it): one stopped at night by a schedule saves less than estimated here.',
    options.ecsUptime
      ? 'ECS services: their uptime measured over the 14 days (CloudWatch CPUUtilization of the service, published every minute while it has a task); their actual cost counts the hours they had a task, their savings only the hours Dormeto would nap them then, at their desired count when discovered (one task for a service found at 0). Services Dormeto already manages are assumed to run all the time.'
      : 'ECS services are assumed to run all the time at their desired count when discovered (--ecs-uptime measures when they had a task): one scaled to 0 at night by a schedule saves less than estimated here.',
    'Companion databases are found by security group (a database whose security group lets a workload\'s in), RDS instances and Aurora provisioned clusters, not yet Aurora Serverless; one another workload reaches, a read replica or one with replicas is left out; their storage keeps billing, and a database takes minutes to start (its workload\'s wakes are held that long, not counted here).',
    ...(kubernetes ? ['Kubernetes pods: their share of their nodes (the larger of CPU and memory over the node\'s allocatable) at the node\'s price, saved only where a node autoscaler removes the nodes they free; the EKS control plane and the nodes\' DaemonSets keep running.'] : []),
    `Dormeto's cost: about $${DORMETO_COST.manager} a month for the manager, $${DORMETO_COST.router} per account and region with workloads, $${DORMETO_COST.workload} per workload.`,
  ];
}

const empty = (): Totals => ({ workloads: 0, kinds: { asg: 0, ec2: 0, ecs: 0, eks: 0 }, excluded: 0, databases: 0, actualMonth: 0, usdMonthWindow: 0, usdMonthRecommended: 0, dormetoMonth: 0, withDormetoMonth: 0 });
const KIND: Record<string, keyof Kinds> = { instance: 'ec2', asg: 'asg', ecs: 'ecs', k8s: 'eks' };

export async function estimateAll({ reached, regions, requests, hourly, priceFailure = () => null, baseline, options, now, excluded = [], uptime = null }: {
  reached: Reached;
  regions: RegionDiscovery[];
  requests: RegionRequests[];
  hourly: (region: string, item: StoppedItem) => Promise<number | null>;
  // A price lookup AWS refused (the Price List API, Spot price history): unpriced workloads say so.
  priceFailure?: () => string | null;
  baseline: Baseline;
  options: Omit<Options, 'out' | 'profiles'>;
  now: number;
  excluded?: Excluded[];
  // With --ec2-uptime: when the EC2 instances without an Auto Scaling group ran.
  uptime?: RegionUptime[] | null;
}): Promise<Estimate> {
  const workloads: WorkloadEstimate[] = [];
  const leftOut: LeftOut[] = [];
  const busy: Busy[] = [];
  const small: Small[] = [];
  const databasesLeftOut: DatabaseLeftOut[] = [];
  for (const region of regions) {
    const elected: { workload: Workload; quiet: boolean; days: number; running: { from: string; to: string }[]; measuredUptime: WorkloadEstimate['uptime']; advice: IdleWindowAdvice; wakesPerDay: number; replay: (items: StoppedItem[]) => Promise<IdleWindowAdvice>; companions: Database[] }[] = [];
    const read = requests.find((r) => r.account === region.account && r.region === region.region);
    const ran = uptime?.find((u) => u.account === region.account && u.region === region.region);
    // A backend behind several target groups is estimated once, at its first, with every target group's requests: it
    // can nap only when none of them is called.
    const key = (w: Workload) => `${w.backend.kind}#${w.backend.id}`;
    const sharing = new Map<string, Workload[]>();
    for (const workload of region.workloads) sharing.set(key(workload), [...(sharing.get(key(workload)) ?? []), workload]);
    for (const workload of region.workloads) {
      const group = sharing.get(key(workload))!;
      if (group[0] !== workload) {
        leftOut.push({ workload, reason: `its backend (${workload.backend.kind} ${workload.backend.id}) also serves ${group[0]!.targetGroup}: estimated there, with every target group's requests` });
        continue;
      }
      const kinds = { ec2: options.ec2Uptime, ecs: options.ecsUptime };
      const measure = Boolean(uptime) && measured(workload, kinds);
      const stoppedNow = workload.instanceState === 'stopped' || workload.instanceState === 'stopping';
      if (stoppedNow && !measure) {
        leftOut.push({ workload, reason: 'a stopped instance: nothing running to stop (--ec2-uptime estimates it from the hours it ran)' });
        continue;
      }
      if (workload.ecsDesired === 0 && !measure) {
        leftOut.push({ workload, reason: 'an ECS service at 0 tasks: nothing running to stop (--ecs-uptime estimates it as one task from the hours it ran)' });
        continue;
      }
      if (!workload.stopped.length) {
        leftOut.push({ workload, reason: NOTHING });
        continue;
      }
      // Measured: its running periods; unreadable, 24/7 (null).
      let running: { from: string; to: string }[] | null = null;
      let measuredUptime: WorkloadEstimate['uptime'];
      if (measure) {
        const periods = ran?.running[workload.backend.id];
        if (periods) {
          if (!periods.length) {
            leftOut.push({ workload, reason: 'it did not run in the last 14 days (its measured uptime)' });
            continue;
          }
          const at = (m: number) => new Date(Date.parse(ran!.from) + m * 60_000).toISOString();
          running = periods.map(([a, b]) => ({ from: at(a), to: at(b) }));
          const days = (Date.parse(ran!.to) - Date.parse(ran!.from)) / 86_400_000;
          measuredUptime = { hoursPerDay: periods.reduce((n, [a, b]) => n + b - a, 0) / 60 / days };
        } else measuredUptime = { unreadable: ran?.unreadable[workload.backend.id] ?? 'not read' };
      }
      const unreadable = group.map((w) => read?.unreadable[w.targetGroupArn]).find(Boolean);
      const series = group.map((w) => read?.minutes[w.targetGroupArn]);
      if (unreadable || !read || series.some((m) => !m)) {
        leftOut.push({ workload, reason: `requests unreadable: ${unreadable ?? 'not read'}` });
        continue;
      }
      const merged = new Map<number, number>();
      for (const [minute, count] of series.flat() as [number, number][]) merged.set(minute, (merged.get(minute) ?? 0) + count);
      const minutes = [...merged].sort((a, b) => a[0] - b[0]);
      const unknown = workload.stopped.find((i) => (i as { kind: string }).kind === 'unknown') as { reason?: string } | undefined;
      if (unknown) {
        leftOut.push({ workload, reason: `its backend could not be described (${unknown.reason ?? 'unknown'})` });
        continue;
      }
      const advice = await idleWindowAdvice({
        requests: { from: read.from, to: read.to, minutes }, current: options.window, checkMinutes: 5, wakeMs: WAKE_MS, startAsleep: false,
        actualWakes: 0, actualFrom: null, stopped: workload.stopped, hourly: (item) => hourly(workload.region, item).catch(() => null), baseline,
        wakerTargetGroup: false, now, running,
      });
      if (!advice.priced) {
        const failure = priceFailure();
        leftOut.push({ workload, reason: failure ? `prices unreadable (${failure})` : 'what it stops has no AWS list price' });
        continue;
      }
      const row = (m: number) => advice.windows.find((w) => w.minutes === m)!;
      const at = row(options.window);
      const best = row(advice.recommended);
      // Judged at its recommended window, the one a customer would set.
      if (options.maxWakes !== null && best.wakesPerDay > options.maxWakes) {
        busy.push({ workload, wakesPerDay: best.wakesPerDay, usdMonth: best.usdMonth!, minutes: advice.recommended });
        continue;
      }
      // Elected: its companion databases are attached once every workload of the region is known.
      const replay = (items: StoppedItem[]) => idleWindowAdvice({
        requests: { from: read.from, to: read.to, minutes }, current: options.window, checkMinutes: 5, wakeMs: WAKE_MS, startAsleep: false,
        actualWakes: 0, actualFrom: null, stopped: items, hourly: (item) => hourly(workload.region, item).catch(() => null), baseline,
        wakerTargetGroup: false, now, running,
      });
      elected.push({ workload, quiet: minutes.length === 0, days: (Date.parse(read.to) - Date.parse(read.from)) / 86_400_000, running: running ?? [{ from: read.from, to: read.to }], measuredUptime, advice, wakesPerDay: best.wakesPerDay, replay, companions: [] });
    }
    // Companion databases (the user, 2026-10-11): a database whose security group lets in an elected workload's naps with
    // it, unless another workload of the region reaches it too (excluded ones included: it would cut them off), its tags
    // are excluded, it cannot be stopped, or its workload wakes more than --max-wakes-rds a day (it takes minutes to start).
    const inRegion = [...region.workloads, ...excluded.filter((x) => x.workload.account === region.account && x.workload.region === region.region).map((x) => x.workload)];
    for (const database of region.databases ?? []) {
      const users = inRegion.filter((w) => database.allowedFrom.some((g) => w.securityGroups?.includes(g)));
      const owner = elected.find((e) => users.includes(e.workload));
      if (!owner) continue;
      const leave = (reason: string) => databasesLeftOut.push({ workload: owner.workload, database: { kind: database.kind, id: database.id }, reason });
      const matched = options.excludeTags.find((c) => resourceTagsMatch(c, database.tags));
      if (users.length > 1) leave(`reached by ${users.length} workloads: stopping it with one would cut the others off`);
      else if (matched) leave(`excluded by its tags (${describeTags(matched)})`);
      else if (database.notStoppable) leave(database.notStoppable);
      else if (options.maxWakesRds !== null && owner.wakesPerDay > options.maxWakesRds) {
        leave(`its workload wakes ${owner.wakesPerDay.toFixed(1)} times a day at its recommended window, more than --max-wakes-rds ${options.maxWakesRds} (a database takes minutes to start)`);
      } else owner.companions.push(database);
    }
    for (const e of elected) {
      const { workload } = e;
      let { advice } = e;
      let stopped = workload.stopped;
      const databases: Companion[] = [];
      if (e.companions.length) {
        const together = [...workload.stopped, ...e.companions.flatMap((d) => d.stopped)];
        const combined = await e.replay(together);
        if (combined.priced) {
          for (const d of e.companions) {
            const own = await e.replay(d.stopped);
            const usd = (m: number) => own.windows.find((w) => w.minutes === m)!.usdMonth!;
            databases.push({ kind: d.kind, id: d.id, usdMonth: usd(options.window), recommendedUsdMonth: usd(combined.recommended) });
          }
          advice = combined;
          stopped = together;
        } else {
          for (const d of e.companions) databasesLeftOut.push({ workload, database: { kind: d.kind, id: d.id }, reason: 'what it stops has no AWS list price' });
        }
      }
      const row = (m: number) => advice.windows.find((w) => w.minutes === m)!;
      const at = row(options.window);
      const best = row(advice.recommended);
      // With its databases: worth installing Dormeto for?
      if (options.minSaving !== null && best.usdMonth! < options.minSaving) {
        small.push({ workload, usdMonth: best.usdMonth!, minutes: advice.recommended });
        continue;
      }
      // Its cost now: asleep never (while it ran, measured), priced as the savings are (the same baseline, prices and month).
      const always = await savingsOf(e.running.map((p) => ({ state: 'ASLEEP', ...p, stopped })), { hourly: (item) => hourly(workload.region, item).catch(() => null), baseline });
      workloads.push({
        workload, quiet: e.quiet, actualMonth: (always.usd * 30) / e.days, ...(e.measuredUptime ? { uptime: e.measuredUptime } : {}),
        atWindow: { usdMonth: at.usdMonth!, wakesPerDay: at.wakesPerDay, asleepHours: at.asleepHours },
        recommended: { minutes: advice.recommended, usdMonth: best.usdMonth!, wakesPerDay: best.wakesPerDay },
        ...(databases.length ? { databases } : {}),
      });
    }
  }
  // Totals, with Dormeto's cost: a router per account and region with workloads, each workload, the manager once.
  const totals = empty();
  const byAccount: Record<string, Totals> = {};
  const byRegion: Record<string, Totals> = {};
  const routed = new Set<string>();
  for (const x of workloads) {
    const where = `${x.workload.account}#${x.workload.region}`;
    const router = routed.has(where) ? 0 : DORMETO_COST.router;
    routed.add(where);
    for (const t of [totals, (byAccount[x.workload.account] ??= empty()), (byRegion[x.workload.region] ??= empty())]) {
      t.workloads += 1;
      t.kinds[KIND[x.workload.backend.kind]!] += 1;
      t.databases += x.databases?.length ?? 0;
      t.actualMonth += x.actualMonth;
      t.usdMonthWindow += x.atWindow.usdMonth;
      t.usdMonthRecommended += x.recommended.usdMonth;
      t.dormetoMonth += router + DORMETO_COST.workload;
    }
  }
  // Each account's (and region's) workloads not estimated, whatever the reason: an account whose all are is listed too.
  for (const { workload: x } of [...excluded, ...leftOut, ...busy, ...small]) {
    for (const t of [totals, (byAccount[x.account] ??= empty()), (byRegion[x.region] ??= empty())]) t.excluded += 1;
  }
  if (workloads.length) totals.dormetoMonth += DORMETO_COST.manager;
  for (const t of [totals, ...Object.values(byAccount), ...Object.values(byRegion)]) t.withDormetoMonth = t.actualMonth - t.usdMonthWindow + t.dormetoMonth;
  const part = (count: number, unitMonth: number): CostPart => ({ count, unitMonth, usdMonth: count * unitMonth });
  const dormeto: DormetoCost = {
    manager: part(workloads.length ? 1 : 0, DORMETO_COST.manager),
    routers: { ...part(routed.size, DORMETO_COST.router), where: [...routed].map((w) => ({ account: w.split('#')[0]!, region: w.split('#')[1]! })) },
    workloads: part(workloads.length, DORMETO_COST.workload),
    usdMonth: totals.dormetoMonth,
  };
  return {
    generatedAt: new Date(now).toISOString(), organization: reached.organization, why: reached.why, options, accounts: reached.accounts.length, accountsListed: reached.listed,
    accountNames: Object.fromEntries(reached.accounts.map((a) => [a.account, a.name])),
    totals, dormeto, byAccount, byRegion, workloads, leftOut, excluded, busy, small, databasesLeftOut,
    databasesUnread: regions.flatMap((r) => (r.databasesError ? [{ account: r.account, region: r.region, reason: r.databasesError }] : [])),
    ineligible: regions.flatMap((r) => r.ineligible.map((i) => ({ account: r.account, region: r.region, ...i }))),
    unreachable: reached.unreachable,
    failedRegions: regions.filter((r) => r.error).map((r) => ({ account: r.account, region: r.region, error: r.error! })),
    unreadableClusters: regions.flatMap((r) => (r.clusters ?? []).map((c) => ({ account: r.account, region: r.region, name: c.name, reason: c.reason }))),
    assumptions: assumptionsOf(baseline, options, regions.some((r) => r.workloads.some((x) => x.backend.kind === 'k8s'))),
  };
}
