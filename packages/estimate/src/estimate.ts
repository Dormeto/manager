// Phase 3 of the estimate (vision docs/specs/2026-10-10-savings-estimate-design.md §6): each eligible workload's
// requests replayed by the product's idle window advisor (R10) and priced by its price book, at the report's window
// (--window, an hour by default) and at the recommended one; what cannot be estimated, with the reason; the totals by account,
// region and all, net of Dormeto's cost. Conservative where the facts are unknown before install (decision 5).
import { DORMETO_COST, idleWindowAdvice, type Baseline, type StoppedItem } from '@dormeto/fleet';
import type { Reached, Unreachable } from './accounts.js';
import type { Ineligible, RegionDiscovery, Workload } from './discover.js';
import type { Options } from './options.js';
import type { RegionRequests } from './requests.js';

const WAKE_MS = 60_000;

export interface WorkloadEstimate {
  workload: Workload;
  quiet: boolean; // no request in 14 days
  // At the report's window (options.window).
  atWindow: { usdMonth: number; wakesPerDay: number; asleepHours: number };
  recommended: { minutes: number; usdMonth: number; wakesPerDay: number };
}
export interface LeftOut { workload: Workload; reason: string }
export interface Totals { workloads: number; usdMonthWindow: number; usdMonthRecommended: number; dormetoMonth: number }
export interface Estimate {
  generatedAt: string;
  organization: string | null;
  why: string | null;
  options: Omit<Options, 'out' | 'profile'>;
  accounts: number;
  totals: Totals;
  byAccount: Record<string, Totals>;
  byRegion: Record<string, Totals>;
  workloads: WorkloadEstimate[];
  leftOut: LeftOut[];
  ineligible: (Ineligible & { account: string; region: string })[];
  unreachable: Unreachable[];
  failedRegions: { account: string; region: string; error: string }[];
  assumptions: string[];
}

const NOTHING = 'nothing running to stop (an Auto Scaling group at 0, an ECS service on EC2 capacity, or a stopped instance)';

function assumptionsOf(baseline: Baseline, options: Omit<Options, 'out' | 'profile'>): string[] {
  return [
    'Every request counts as activity and as a wake: no waker is installed yet to set scanners and other filtered requests apart, so the workloads stay awake longer here than they would (smaller savings).',
    'A wake lasts 60 seconds in the replay; the visitors\' wait is not estimated before install.',
    'Databases are not attached to load balancers: they are not counted (an installed router naps the ones attached to a workload).',
    `Prices: AWS's on-demand list prices, Spot prices for Spot capacity, less the discounts given (compute ${options.discounts.compute}%, databases ${options.discounts.databases}%); storage, load balancers and data transfer are not counted.`,
    `Savings counted within ${baseline.kind === 'always' ? 'every hour (24/7)' : `business hours (weekdays 08:00 to 20:00, ${baseline.timeZone})`}.`,
    `Dormeto's cost: about $${DORMETO_COST.manager} a month for the manager, $${DORMETO_COST.router} per account and region with workloads, $${DORMETO_COST.workload} per workload.`,
  ];
}

const empty = (): Totals => ({ workloads: 0, usdMonthWindow: 0, usdMonthRecommended: 0, dormetoMonth: 0 });

export async function estimateAll({ reached, regions, requests, hourly, priceFailure = () => null, baseline, options, now }: {
  reached: Reached;
  regions: RegionDiscovery[];
  requests: RegionRequests[];
  hourly: (region: string, item: StoppedItem) => Promise<number | null>;
  // A price lookup AWS refused (the Price List API, Spot price history): unpriced workloads say so.
  priceFailure?: () => string | null;
  baseline: Baseline;
  options: Omit<Options, 'out' | 'profile'>;
  now: number;
}): Promise<Estimate> {
  const workloads: WorkloadEstimate[] = [];
  const leftOut: LeftOut[] = [];
  for (const region of regions) {
    const read = requests.find((r) => r.account === region.account && r.region === region.region);
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
      if (!workload.stopped.length) {
        leftOut.push({ workload, reason: NOTHING });
        continue;
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
        wakerTargetGroup: false, now,
      });
      if (!advice.priced) {
        const failure = priceFailure();
        leftOut.push({ workload, reason: failure ? `prices unreadable (${failure})` : 'what it stops has no AWS list price' });
        continue;
      }
      const row = (m: number) => advice.windows.find((w) => w.minutes === m)!;
      const at = row(options.window);
      const best = row(advice.recommended);
      workloads.push({
        workload, quiet: minutes.length === 0,
        atWindow: { usdMonth: at.usdMonth!, wakesPerDay: at.wakesPerDay, asleepHours: at.asleepHours },
        recommended: { minutes: advice.recommended, usdMonth: best.usdMonth!, wakesPerDay: best.wakesPerDay },
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
      t.usdMonthWindow += x.atWindow.usdMonth;
      t.usdMonthRecommended += x.recommended.usdMonth;
      t.dormetoMonth += router + DORMETO_COST.workload;
    }
  }
  if (workloads.length) totals.dormetoMonth += DORMETO_COST.manager;
  return {
    generatedAt: new Date(now).toISOString(), organization: reached.organization, why: reached.why, options, accounts: reached.accounts.length,
    totals, byAccount, byRegion, workloads, leftOut,
    ineligible: regions.flatMap((r) => r.ineligible.map((i) => ({ account: r.account, region: r.region, ...i }))),
    unreachable: reached.unreachable,
    failedRegions: regions.filter((r) => r.error).map((r) => ({ account: r.account, region: r.region, error: r.error! })),
    assumptions: assumptionsOf(baseline, options),
  };
}
