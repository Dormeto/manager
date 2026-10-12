// The daily savings job (vision docs/specs/2026-10-08-savings-design.md, R9b): each workload's previous UTC day priced
// from its history (a day item, idempotent by key), then the summary the Overview reads in one request: the last 30
// days, this month, the cumulative total (a day added once), the top workloads, what is not priced, Dormeto's own cost.
import { historyView, savingsOf, type Baseline, type Discounts, type FleetStore, type SavingsDay, type SavingsSummary, type StoppedItem } from '@dormeto/fleet';

const DAY_MS = 86_400_000;
const WORKERS = 10;
const TOP = 10;
// The cost model (vision docs/architecture/costs.md): the manager, each router, each workload, a month.
const COST = { manager: 5, router: 0.26, workload: 0.13 };

const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10);

type Log = { info: (event: string, data?: object) => void; warn: (event: string, data?: object) => void; error: (event: string, data?: object) => void };

export function createSavingsJob({ fleet, prices, baseline, now = Date.now, log }: {
  fleet: Pick<FleetStore, 'listWorkloads' | 'listHistory' | 'historyBefore' | 'putSavingsDay' | 'listSavingsDay' | 'getSavingsSummary' | 'putSavingsSummary' | 'getSavingsSettings'>;
  prices: { hourly(region: string, item: StoppedItem, discounts?: Discounts): Promise<number | null> };
  baseline: Baseline;
  now?: () => number;
  log: Log;
}) {
  async function priceDay(date: string, discounts: Discounts) {
    const from = `${date}T00:00:00.000Z`;
    const to = new Date(Date.parse(from) + DAY_MS).toISOString();
    const workloads = await fleet.listWorkloads();
    const queue = [...workloads];
    let failed = 0;
    const work = async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        try {
          const [{ entries }, before] = await Promise.all([
            fleet.listHistory(w.account, w.region, w.workloadId, from, to), fleet.historyBefore(w.account, w.region, w.workloadId, from),
          ]);
          const view = historyView({ before, entries, from, to, now: to });
          const region = w.region;
          const savings = await savingsOf(view.phases, { hourly: (item) => prices.hourly(region, item, discounts), baseline });
          const day: SavingsDay = {
            account: w.account, region, router: w.router, workloadId: w.workloadId, ...(w.name ? { name: w.name } : {}),
            usd: savings.usd, asleepHours: (view.totals.ASLEEP ?? 0) / 3600, hours: savings.hours,
            unpriced: savings.unpriced.map(({ reason, hours }) => ({ reason, hours })),
          };
          await fleet.putSavingsDay(date, day);
        } catch (err) {
          // One workload's error is said (the run counts it), never the whole day's (review I1).
          failed += 1;
          log.error('SavingsDayFailed', { day: date, workload: `${w.account}/${w.region}/${w.workloadId}`, error: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, work));
    return { counted: workloads.length, failed };
  }

  return {
    // day: a UTC date (YYYY-MM-DD), the previous day by default.
    async run(input: { day?: string } = {}) {
      const t = now();
      const date = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : dateOf(t - DAY_MS);
      // The discounts for commitments (R9.5), read once: a day computed keeps them.
      const { compute, databases } = await fleet.getSavingsSettings();
      const discounts = { compute, databases };
      const { counted, failed } = await priceDay(date, discounts);
      const previous = await fleet.getSavingsSummary();
      const latest = previous && previous.day > date ? previous.day : date;
      // The 31 days to the latest one: the last 30, and this month.
      const dates = Array.from({ length: 31 }, (_, i) => dateOf(Date.parse(`${latest}T00:00:00.000Z`) - (30 - i) * DAY_MS));
      const days = new Map<string, SavingsDay[]>();
      for (const d of dates) days.set(d, await fleet.listSavingsDay(d));
      const sum = (list: SavingsDay[]) => list.reduce((n, d) => n + d.usd, 0);
      const last30 = dates.slice(1);
      const byWorkload = new Map<string, SavingsSummary['top'][number]>();
      for (const d of last30) {
        for (const w of days.get(d)!) {
          const key = `${w.account}#${w.region}#${w.workloadId}`;
          const known = byWorkload.get(key) ?? { account: w.account, region: w.region, router: w.router, workloadId: w.workloadId, ...(w.name ? { name: w.name } : {}), usd: 0 };
          known.usd += w.usd;
          byWorkload.set(key, known);
        }
      }
      const total = sum(days.get(date)!);
      // Each day's total, replaced when the day is run again: the cumulative total is their sum, in any order.
      const totals = { ...(previous?.counted ?? {}), [date]: total };
      const since = Object.keys(totals).sort()[0]!;
      const latestDay = days.get(latest)!;
      const unpricedDay = latestDay.filter((d) => d.unpriced.length);
      // A router per account and region with managed workloads (the cost model's).
      const routers = new Set(latestDay.map((d) => `${d.account}#${d.region}`)).size;
      const summary: SavingsSummary = {
        computedAt: new Date(t).toISOString(),
        day: latest,
        baseline,
        last30: { usd: last30.reduce((n, d) => n + sum(days.get(d)!), 0), asleepHours: last30.reduce((n, d) => n + days.get(d)!.reduce((m, w) => m + w.asleepHours, 0), 0), days: last30.map((d) => ({ date: d, usd: sum(days.get(d)!) })) },
        month: { month: latest.slice(0, 7), usd: dates.filter((d) => d.startsWith(latest.slice(0, 7))).reduce((n, d) => n + sum(days.get(d)!), 0) },
        cumulative: { usd: Object.values(totals).reduce((n, v) => n + v, 0), since, lastDay: latest },
        counted: totals,
        failed,
        top: [...byWorkload.values()].filter((w) => w.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, TOP),
        unpriced: { workloads: unpricedDay.length, hours: unpricedDay.reduce((n, d) => n + d.unpriced.reduce((m, u) => m + u.hours, 0), 0) },
        workloads: latestDay.length,
        dormeto: { usdMonth: COST.manager + COST.router * routers + COST.workload * latestDay.length },
        // Those of its latest day: an earlier day run again keeps them.
        discounts: date === latest ? discounts : previous?.discounts ?? discounts,
      };
      await fleet.putSavingsSummary(summary);
      log.info('SavingsComputed', { day: date, workloads: counted, usd: Number(total.toFixed(2)) });
      return summary;
    },
  };
}
