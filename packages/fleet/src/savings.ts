// A period's estimated savings (vision docs/specs/2026-10-08-savings-design.md, R9b): each ASLEEP phase's hours within
// the baseline × the hourly list prices of what its nap stopped. What cannot be priced is listed with its hours, never
// counted as nothing saved.
import type { Phase } from './history.js';
import type { StoppedItem } from './prices.js';

// Dormeto's estimated cost a month (vision docs/architecture/costs.md): the manager, a router per account and region with
// workloads, each workload; the savings job and the estimate before install net it off.
export const DORMETO_COST = { manager: 5, router: 0.26, workload: 0.13 };

export type Baseline = { kind: 'always' } | { kind: 'business-hours'; timeZone: string };
export interface Savings {
  usd: number;
  hours: number; // asleep hours within the baseline
  items: { item: StoppedItem; hourly: number; hours: number; usd: number }[];
  unpriced: { reason: string; item?: StoppedItem; hours: number }[];
}

const HOUR = 3_600_000;
const BUSINESS = { start: 8, end: 20 }; // weekdays, local time

// The offset of a time zone at an instant (ms to add to UTC).
function offset(t: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(t / 1000) * 1000;
}
// The instant of a local wall time in a time zone.
function instant(y: number, m: number, d: number, h: number, timeZone: string): number {
  const wall = Date.UTC(y, m, d, h);
  const first = wall - offset(wall, timeZone);
  return wall - offset(first, timeZone);
}
function localDate(t: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(t)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return { y: parts.year!, m: parts.month! - 1, d: parts.day! };
}

// Hours of [from, to] the baseline would have run.
export function baselineHours(from: string, to: string, baseline: Baseline): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return 0;
  if (baseline.kind === 'always') return (b - a) / HOUR;
  let total = 0;
  const first = localDate(a, baseline.timeZone);
  // Each local day from the period's first, its business window clipped to the period.
  for (let i = 0; ; i += 1) {
    const day = new Date(Date.UTC(first.y, first.m, first.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    const start = instant(y, m, d, BUSINESS.start, baseline.timeZone);
    if (start >= b) break;
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const end = instant(y, m, d, BUSINESS.end, baseline.timeZone);
    total += Math.max(0, Math.min(end, b) - Math.max(start, a));
  }
  return total / HOUR;
}

export async function savingsOf(phases: (Phase & { stopped?: StoppedItem[] })[], { hourly, baseline }: { hourly: (item: StoppedItem) => Promise<number | null>; baseline: Baseline }): Promise<Savings> {
  const items = new Map<string, Savings['items'][number]>();
  const unpriced = new Map<string, Savings['unpriced'][number]>();
  let hours = 0;
  for (const phase of phases.filter((p) => p.state === 'ASLEEP')) {
    const h = baselineHours(phase.from, phase.to, baseline);
    if (!h) continue;
    hours += h;
    if (!phase.stopped) {
      const known = unpriced.get('none') ?? { reason: 'not described (a router before 0.27.0)', hours: 0 };
      known.hours += h;
      unpriced.set('none', known);
      continue;
    }
    for (const item of phase.stopped) {
      const key = JSON.stringify(item);
      const price = await hourly(item);
      if (price === null) {
        const known = unpriced.get(key) ?? { reason: 'not priced', item, hours: 0 };
        known.hours += h;
        unpriced.set(key, known);
        continue;
      }
      const known = items.get(key) ?? { item, hourly: price, hours: 0, usd: 0 };
      known.hours += h;
      known.usd += price * h;
      items.set(key, known);
    }
  }
  const list = [...items.values()];
  return { usd: list.reduce((n, i) => n + i.usd, 0), hours, items: list, unpriced: [...unpriced.values()] };
}
