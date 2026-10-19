// The idle window advisor (vision docs/specs/2026-10-10-idle-window-advisor-design.md, R10): a workload's requests per
// minute over the last 14 days replayed against idle windows with the router's rules, each window's asleep time priced
// as the savings of R9, and the window at the knee recommended. Every request counts, as activity and as a wake (the
// waker's filters are not known per minute: the advice says when the replay counts clearly more wakes than happened).
import { savingsOf, type Baseline } from './savings.js';
import type { StoppedItem } from './prices.js';

export const IDLE_WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// The knee: the shortest window that already avoids this share of the wakes the longest one avoids.
const KNEE = 0.9;

// The minutes with requests, as offsets from `from` with their counts.
export interface RequestMinutes { from: string; to: string; minutes: [number, number][] }
export interface ReplayedWindow { minutes: number; asleep: { from: string; to: string }[]; wakes: number; wokeAt: string[] }
// asleepHours: hours asleep a day (the replayed days' average).
export interface IdleWindowRow { minutes: number; asleepHours: number; usdMonth: number | null; wakesPerDay: number; waitSecondsPerDay: number | null }
export interface IdleWindowAdvice {
  computedAt: string;
  from: string;
  to: string;
  current: number;
  recommended: number;
  checkMinutes: number;
  wakeSeconds: number | null;
  priced: boolean;
  windows: IdleWindowRow[];
  actual: { wakes: number; replayedWakes: number; noisy: boolean };
  wakerTargetGroup: boolean;
}

// The windows tried: the nine, and the current one when it is not among them.
export function windowsFor(current: number): number[] {
  return [...new Set([...IDLE_WINDOWS, current])].sort((a, b) => a - b);
}

// A router's check period from its schedule: rate(n minutes), rate(n hours) or cron(0/n * * * ? *) (routers 0.31.0),
// 5 minutes otherwise.
export function checkMinutesOf(schedule: string | null): number {
  const cron = /^cron\(0\/(\d+) \* \* \* \? \*\)$/.exec(schedule ?? '');
  if (cron) return Number(cron[1]);
  const rate = /rate\((\d+) (minute|minutes|hour|hours)\)/.exec(schedule ?? '');
  return rate ? Number(rate[1]) * (rate[2]!.startsWith('hour') ? 60 : 1) : 5;
}

// One window: naps at the first check a window after both the last request's minute and the wake; a request minute
// starting at or after that check comes after the nap (a check reads only the minutes that have ended) and wakes it;
// requests during a wake are activity. Times in milliseconds from the period's start.
function replayOne(starts: number[], end: number, window: number, checkMs: number, wakeMs: number, startAsleep: boolean) {
  const windowMs = window * MIN_MS;
  const asleep: [number, number][] = [];
  const wokeAt: number[] = [];
  let awake = !startAsleep;
  let since = 0;
  let last = 0;
  let sleptAt = 0;
  const napAt = () => Math.ceil(Math.max(since + windowMs, last + windowMs) / checkMs) * checkMs;
  for (const minute of starts) {
    const t = minute * MIN_MS;
    if (awake && t >= napAt()) {
      sleptAt = napAt();
      awake = false;
    }
    if (!awake) {
      // A nap and a wake at the same check leave no asleep time; the wake counts.
      if (t > sleptAt) asleep.push([sleptAt, t]);
      wokeAt.push(t);
      awake = true;
      since = t + wakeMs;
      last = t + MIN_MS;
      continue;
    }
    last = Math.max(last, t + MIN_MS);
  }
  if (awake && napAt() < end) {
    sleptAt = napAt();
    awake = false;
  }
  if (!awake && end > sleptAt) asleep.push([sleptAt, end]);
  return { asleep, wokeAt };
}

export function replayIdle({ requests, windows, checkMinutes, wakeSeconds, startAsleep }: {
  requests: RequestMinutes; windows: number[]; checkMinutes: number; wakeSeconds: number; startAsleep: boolean;
}): ReplayedWindow[] {
  const start = Date.parse(requests.from);
  const end = Date.parse(requests.to) - start;
  const iso = (ms: number) => new Date(start + ms).toISOString();
  // Each minute once, in order: any request counts, whatever their number.
  const starts = [...new Set(requests.minutes.filter(([, n]) => n > 0).map(([m]) => m))].sort((a, b) => a - b);
  return windows.map((minutes) => {
    const { asleep, wokeAt } = replayOne(starts, end, minutes, checkMinutes * MIN_MS, wakeSeconds * 1000, startAsleep);
    return { minutes, asleep: asleep.map(([from, to]) => ({ from: iso(from), to: iso(to) })), wakes: wokeAt.length, wokeAt: wokeAt.map(iso) };
  });
}

// The shortest of the nine windows whose wakes are at most wakes(longest) + 10% of what the longest avoids against the
// shortest; the same wakes everywhere (no request, or no gap), the shortest, which saves the most at no cost.
export function recommendWindow(rows: { minutes: number; wakes: number }[]): number {
  const candidates = IDLE_WINDOWS.map((minutes) => rows.find((r) => r.minutes === minutes)).filter((r): r is { minutes: number; wakes: number } => r !== undefined);
  if (!candidates.length) return IDLE_WINDOWS[0]!;
  const shortest = candidates[0]!.wakes;
  const longest = candidates.at(-1)!.wakes;
  const limit = longest + (1 - KNEE) * (shortest - longest);
  return (candidates.find((r) => r.wakes <= limit + 1e-9) ?? candidates.at(-1)!).minutes;
}

// actualFrom: when the history starts knowing the period (its first known phase; null when it knows none of it, or only
// its newest entries): the real wakes are compared with the replay's from then on only.
// Two lists of periods, each sorted and disjoint: the time in both.
function intersect(a: { from: string; to: string }[], b: { from: string; to: string }[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const from = a[i]!.from > b[j]!.from ? a[i]!.from : b[j]!.from;
    const to = a[i]!.to < b[j]!.to ? a[i]!.to : b[j]!.to;
    if (from < to) out.push({ from, to });
    if (a[i]!.to < b[j]!.to) i += 1;
    else j += 1;
  }
  return out;
}

// running: the backend's measured running periods (sorted, disjoint), when it does not run all the time (an instance
// stopped at night by a schedule): its asleep time is worth something only while it ran. The hours asleep and the
// wakes stay the replay's.
export async function idleWindowAdvice({ requests, current, checkMinutes, wakeMs, startAsleep, actualWakes, actualFrom, stopped, hourly, baseline, wakerTargetGroup, now, running = null }: {
  requests: RequestMinutes; current: number; checkMinutes: number; wakeMs: number | null; startAsleep: boolean; actualWakes: number; actualFrom: string | null;
  stopped: StoppedItem[] | null; hourly: (item: StoppedItem) => Promise<number | null>; baseline: Baseline; wakerTargetGroup: boolean; now: number;
  running?: { from: string; to: string }[] | null;
}): Promise<IdleWindowAdvice> {
  const wakeSeconds = wakeMs === null ? null : wakeMs / 1000;
  const replayed = replayIdle({ requests, windows: windowsFor(current), checkMinutes, wakeSeconds: wakeSeconds ?? 0, startAsleep });
  const days = (Date.parse(requests.to) - Date.parse(requests.from)) / DAY_MS;
  // Priced only when every item of what the latest nap stopped has a price: never a partial dollar figure.
  let priced = Boolean(stopped?.length);
  const windows: IdleWindowRow[] = [];
  for (const r of replayed) {
    const hours = r.asleep.reduce((n, p) => n + (Date.parse(p.to) - Date.parse(p.from)) / HOUR_MS, 0);
    let usd: number | null = null;
    if (priced) {
      const worth = running ? intersect(r.asleep, running) : r.asleep;
      const savings = await savingsOf(worth.map((p) => ({ state: 'ASLEEP', ...p, stopped: stopped! })), { hourly, baseline });
      if (savings.unpriced.length) priced = false;
      else usd = savings.usd;
    }
    windows.push({
      minutes: r.minutes, asleepHours: hours / days, usdMonth: usd === null ? null : (usd * 30) / days, wakesPerDay: r.wakes / days,
      waitSecondsPerDay: wakeSeconds === null ? null : (r.wakes / days) * wakeSeconds,
    });
  }
  if (!priced) for (const w of windows) w.usdMonth = null;
  const own = replayed.find((r) => r.minutes === current)!;
  const replayedWakes = actualFrom === null ? own.wakes : own.wokeAt.filter((at) => at >= actualFrom).length;
  return {
    computedAt: new Date(now).toISOString(), from: requests.from, to: requests.to, current, recommended: recommendWindow(replayed), checkMinutes,
    wakeSeconds, priced, windows,
    actual: { wakes: actualWakes, replayedWakes, noisy: actualFrom !== null && replayedWakes > 1.5 * actualWakes && replayedWakes >= actualWakes + 3 },
    wakerTargetGroup,
  };
}
