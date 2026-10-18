// A demo workload's life: bursts of requests (a working day, a busy service, a few visits), the wakes and naps they
// cause with its idle window, and the views the API computes from them (R8 history, R10 idle window replay).
import type { Phase } from '../history';
import type { HistoryEntry, IdleWindowRow } from '../types';
import type { Profile } from './fixtures';
import { DAY, HOUR, MINUTE, SECOND, random, type Random } from './util';

export interface Burst { start: number; end: number; requests: number; noise?: boolean }

const CHECK = 5 * MINUTE;
// The idle check that naps a workload idle since `t` (every 5 minutes, a few seconds past).
export const checkAfter = (t: number) => Math.ceil((t - 7 * SECOND) / CHECK) * CHECK + 7 * SECOND;

// Bursts from `start` to `end`: a few minutes of requests, then a pause (sometimes a long one).
function fill(r: Random, start: number, end: number, { gap, min, max, rate }: { gap: number; min: number; max: number; rate: number }): Burst[] {
  const out: Burst[] = [];
  for (let t = start; t < end;) {
    const length = r.between(min, max) * MINUTE;
    const stop = Math.min(t + length, end);
    out.push({ start: t, end: stop, requests: Math.max(1, Math.round(((stop - t) / MINUTE) * rate * r.between(0.5, 1.5))) });
    t = stop + (r.chance(0.12) ? r.between(25, 55) : r.between(1, gap * 2)) * MINUTE;
  }
  return out;
}

// The requests of a workload between two times, day by day in its users' time zone; the same for a given day on every
// load. noise: scanner requests a day (the waker ignores them, the load balancer counts them).
export function bursts(seed: string, profile: Profile, tz: number, from: number, to: number, noise = 0): Burst[] {
  const out: Burst[] = [];
  const first = Math.floor((from + tz * HOUR) / DAY);
  const last = Math.floor((to + tz * HOUR) / DAY);
  for (let n = first; n <= last; n += 1) {
    const r = random(`${seed}:${n}`);
    const midnight = n * DAY - tz * HOUR;
    const at = (hours: number) => midnight + hours * HOUR;
    const weekday = ![0, 6].includes(new Date(n * DAY).getUTCDay());
    if (profile === 'office') {
      if (weekday && !r.chance(0.06)) {
        const lunch = r.between(12, 12.75);
        out.push(...fill(r, at(r.between(8, 9.5)), at(lunch), { gap: 8, min: 2, max: 15, rate: 5 }));
        out.push(...fill(r, at(lunch + r.between(0.75, 1.25)), at(r.between(17.25, 19)), { gap: 8, min: 2, max: 15, rate: 5 }));
        if (r.chance(0.15)) out.push(...fill(r, at(r.between(20.5, 21.5)), at(22), { gap: 6, min: 2, max: 8, rate: 3 }));
      } else if (!weekday && r.chance(0.2)) {
        const start = r.between(10, 16);
        out.push(...fill(r, at(start), at(start + r.between(0.2, 0.8)), { gap: 5, min: 2, max: 8, rate: 3 }));
      }
    } else if (profile === 'busy') {
      if (weekday) out.push(...fill(r, at(r.between(6.5, 7.5)), at(r.between(22, 23.5)), { gap: 4, min: 3, max: 20, rate: 12 }));
      else out.push(...fill(r, at(r.between(9, 11)), at(r.between(17, 20)), { gap: 10, min: 2, max: 10, rate: 6 }));
    } else {
      const visits = weekday ? Number(r.chance(0.5)) + Number(r.chance(0.15)) : Number(r.chance(0.12));
      for (let v = 0; v < visits; v += 1) {
        const start = r.between(9, 19);
        out.push(...fill(r, at(start), at(start + r.between(0.1, 0.9)), { gap: 6, min: 2, max: 12, rate: 3 }));
      }
    }
    // Scanners and bots, any time of day.
    for (let i = 0; i < r.int(0, 2 * noise); i += 1) {
      const t = at(r.between(0, 24));
      out.push({ start: t, end: t + MINUTE, requests: r.int(1, 3), noise: true });
    }
  }
  return out.filter((b) => b.start >= from && b.end <= to).sort((a, b) => a.start - b.start);
}

// A stretch of time awake: the wake at its first request, the nap at the idle check after its last one.
export interface Session { start: number; awake: number; napStart: number; asleep: number; wakeMs: number; pendingWake: boolean }

// The sessions of a list of bursts with an idle window: a burst before the nap keeps the workload awake, one during the
// nap wakes it once the nap ends.
export function sessions(list: Burst[], idleMs: number, wake: () => number, napMs: number): Session[] {
  const out: Session[] = [];
  let current: { start: number; lastEnd: number; wakeMs: number; pendingWake: boolean } | null = null;
  const close = (c: NonNullable<typeof current>) => {
    const awake = c.start + c.wakeMs;
    const napStart = Math.max(checkAfter(c.lastEnd + idleMs), awake + MINUTE);
    const session = { start: c.start, awake, napStart, asleep: napStart + napMs, wakeMs: c.wakeMs, pendingWake: c.pendingWake };
    out.push(session);
    return session;
  };
  for (const b of list) {
    if (current) {
      const napStart = Math.max(checkAfter(current.lastEnd + idleMs), current.start + current.wakeMs + MINUTE);
      if (b.start <= napStart) {
        current.lastEnd = Math.max(current.lastEnd, b.end);
        continue;
      }
      const done = close(current);
      const start = Math.max(b.start, done.asleep);
      current = { start, lastEnd: Math.max(b.end, start), wakeMs: wake(), pendingWake: b.start < done.asleep };
      continue;
    }
    current = { start: b.start, lastEnd: b.end, wakeMs: wake(), pendingWake: false };
  }
  if (current) close(current);
  return out;
}

// What started a wake: a request, the waiting page's check (browser mode), the wake header or rule, or someone from
// the manager.
export function wakeCause(r: Random, browser: boolean, rule: string | null, manager: string): { cause: string; by?: string } {
  if (r.chance(0.04)) return { cause: 'manager', by: manager };
  if (rule && r.chance(0.3)) return { cause: `rule ${rule}` };
  if (r.chance(0.06)) return { cause: 'header' };
  return { cause: browser ? 'probe' : 'normal' };
}

// The history entries of sessions (each from ASLEEP).
export function entriesOf(list: Session[], causes: (s: Session) => { cause: string; by?: string }, nap: (s: Session) => { cause: string; by?: string }): HistoryEntry[] {
  return list.flatMap((s) => [
    { from: 'ASLEEP', to: 'WAKING', at: new Date(s.start).toISOString(), ...(s.pendingWake ? { cause: 'pending-wake' } : causes(s)) },
    { from: 'WAKING', to: 'AWAKE', at: new Date(s.awake).toISOString(), durationMs: s.wakeMs },
    { from: 'AWAKE', to: 'NAPPING', at: new Date(s.napStart).toISOString(), ...nap(s) },
    { from: 'NAPPING', to: 'ASLEEP', at: new Date(s.asleep).toISOString() },
  ]);
}

export interface View {
  from: string;
  to: string;
  phases: Phase[];
  totals: Record<string, number>;
  wakes: { count: number; failed: number; medianMs: number | null; maxMs: number | null };
  before: HistoryEntry | null;
  entries: HistoryEntry[];
}

// A period of the history as the manager's store gives it (fleet historyView): its phases from the entry before it,
// the seconds in each state, the wakes.
export function historyView(all: HistoryEntry[], fromMs: number, toMs: number): View {
  const before = [...all].reverse().find((e) => Date.parse(e.at) < fromMs) ?? null;
  const entries = all.filter((e) => Date.parse(e.at) >= fromMs && Date.parse(e.at) <= toMs);
  const details = (e: HistoryEntry) => ({ ...(e.cause ? { cause: e.cause } : {}), ...(e.by ? { by: e.by } : {}), ...(e.inferred ? { inferred: true } : {}), ...(e.from === null ? { first: true } : {}) });
  const phases: { state: string; from: number; to: number; cause?: string; by?: string; inferred?: boolean; first?: boolean }[] = [];
  let current: (typeof phases)[number] = before ? { state: before.to, from: fromMs, to: toMs, ...details(before) } : { state: 'UNKNOWN', from: fromMs, to: toMs };
  for (const e of entries) {
    if (e.to === current.state) continue;
    const at = Date.parse(e.at);
    phases.push({ ...current, to: at });
    current = { state: e.to, from: at, to: toMs, ...details(e) };
  }
  phases.push(current);
  const kept: typeof phases = [];
  for (const p of phases.filter((x) => x.to > x.from)) {
    const last = kept.at(-1);
    if (last && last.state === p.state) last.to = p.to;
    else kept.push({ ...p });
  }
  const totals: Record<string, number> = {};
  for (const p of kept) totals[p.state] = (totals[p.state] ?? 0) + Math.round((p.to - p.from) / SECOND);
  const durations = entries.filter((e) => e.to === 'AWAKE' && typeof e.durationMs === 'number').map((e) => e.durationMs!).sort((a, b) => a - b);
  return {
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    phases: kept.map((p) => ({ ...p, from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() })),
    totals,
    wakes: {
      count: entries.filter((e) => e.to === 'WAKING').length,
      failed: entries.filter((e) => e.to === 'FAILED' && e.failure?.step !== 'nap' && e.from !== 'NAPPING').length,
      medianMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null,
      maxMs: durations.length ? durations.at(-1)! : null,
    },
    before,
    entries,
  };
}

// Milliseconds in a state within a period.
export const timeIn = (view: View, state: string): number => view.phases.filter((p) => p.state === state).reduce((n, p) => n + Date.parse(p.to) - Date.parse(p.from), 0);

// The idle window advice (R10): the bursts of the last 14 days replayed against windows from 5 to 120 minutes; every
// request counts as a wake, the scanners' too.
const WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const KNEE = 0.9;
export function replayWindows(list: Burst[], current: number, from: number, to: number, wakeMs: number, napMs: number, hourly: number | null): { rows: IdleWindowRow[]; recommended: number; replayedWakes: number } {
  const days = (to - from) / DAY;
  const minutes = [...new Set([...WINDOWS, current])].sort((a, b) => a - b);
  const replayed = minutes.map((m) => {
    const s = sessions(list, m * MINUTE, () => wakeMs, napMs);
    const awake = s.reduce((n, x) => n + Math.min(x.asleep, to) - x.start, 0);
    const asleepHours = Math.max(0, (to - from - awake) / HOUR / days);
    return {
      minutes: m, asleepHours: Math.round(asleepHours * 10) / 10, wakes: s.length,
      usdMonth: hourly === null ? null : Math.round(((asleepHours / 24) * hourly * 730) * 100) / 100,
      wakesPerDay: Math.round((s.length / days) * 10) / 10, waitSecondsPerDay: Math.round((s.length / days) * (wakeMs / SECOND)),
    };
  });
  // The knee (fleet recommendWindow): the shortest window that avoids 90% of the wakes the longest one avoids.
  const candidates = replayed.filter((r) => WINDOWS.includes(r.minutes));
  const shortest = candidates[0]!.wakes;
  const longest = candidates.at(-1)!.wakes;
  const limit = longest + (1 - KNEE) * (shortest - longest);
  const recommended = (candidates.find((r) => r.wakes <= limit + 1e-9) ?? candidates.at(-1)!).minutes;
  return {
    rows: replayed.map(({ wakes: _w, ...row }) => row), recommended,
    replayedWakes: replayed.find((r) => r.minutes === current)?.wakes ?? 0,
  };
}
