// The port held to the router (R12): occurrencesIn against lambda/src/lib/schedule.mjs's occurrenceAt, for seeded
// random valid schedules (overnight and 24-hour windows, exceptions) in zones with clock changes (Lord Howe's half
// hour) and a quarter-hour offset (Kathmandu), at random instants near the changes and at every occurrence's and every
// router event's boundary, and the starts and ends against its nextEvents. Reads the router's checkout beside the
// manager's (as scripts/parity/product.mjs does), skipped when it is absent. A failure names the seed (PARITY_SEED
// overrides it), the schedule and the instant. The same for recurring windows (daily, weekly, monthly, yearly and cron,
// within a range of dates), and the refusals of a window word for word. In Node's environment: jsdom's goes through Vite's
// client transform, which serves no file outside the manager's workspace.
// @vitest-environment node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moveWindow, nextEvents, occurrencesIn, windowProblems, type Occurrence } from '../src/occurrences';
import { DAYS, JOIN_PROBLEM, isJoinMinutes, isOnce, type Day, type Schedule, type ScheduleWindow } from '../src/schedule';
import { OVERLAP_SAMPLES } from '../src/overlap-samples';
import { state } from '../src/mock/state';
import { joinLevelsOf, scheduleView } from '../src/mock/schedule';
import { AVAILABLE } from '../src/mock/fixtures';

const ROUTER_SCHEDULE = '../../../../router/lambda/src/lib/schedule.mjs';
const file = resolve(import.meta.dirname, ROUTER_SCHEDULE);

interface RouterOccurrence { kind: 'awake' | 'nap'; window: number; id: string; start: number; end: number; wake?: string }
interface RouterSchedule {
  occurrenceAt(s: Schedule, t: number, options?: { joinMinutes?: number }): RouterOccurrence | null;
  nextEvents(s: Schedule, t: number, options: { count: number; horizonDays?: number; joinMinutes?: number }): { at: string; kind: string; window: number }[];
  isJoinMinutes(value: unknown): boolean;
  resolveJoin(levels: { workload?: unknown; router?: unknown; manager?: unknown }): { joinMinutes: number; from: string };
  scheduleProblems(s: unknown, options?: { now: number }): string[];
  normalizeSchedule(s: Schedule): Schedule;
}

const router = (existsSync(file) ? await import(/* @vite-ignore */ file) : null) as RouterSchedule | null;

const SEED = Number(process.env.PARITY_SEED ?? 20261020);
const SCHEDULES = 500;
const RECURRING = 400;
const JOINED = 150;
const ZONES = ['Europe/Paris', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.parse('2026-01-01T00:00:00Z');
const TO = Date.parse('2029-01-01T00:00:00Z');

// mulberry32: a small seeded generator, so a failure reproduces.
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The zone's offset at t, read with Intl on its own (not the module's), and its changes from FROM to TO, to the minute.
function offset(zone: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

function changes(zone: string): number[] {
  const found: number[] = [];
  for (let t = FROM; t < TO; t += 6 * HOUR) {
    if (offset(zone, t) === offset(zone, t + 6 * HOUR)) continue;
    let [lo, hi] = [t, t + 6 * HOUR];
    while (hi - lo > MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
      if (offset(zone, mid) === offset(zone, lo)) lo = mid;
      else hi = mid;
    }
    found.push(hi);
  }
  return found;
}

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const iso = (t: number): string => new Date(t).toISOString();

// A valid schedule of 1 to 5 windows (a window that the router refuses with the others, an overlap, is left out), its
// times half the time around the hours clocks change, a quarter of its windows 24 hours long, and up to 3 exception
// dates around the anchor.
function randomSchedule(random: () => number, r: RouterSchedule, zone: string, anchor: number): Schedule {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const time = () => hhmm(random() < 0.5 ? 60 + Math.floor(random() * 31) * 5 : Math.floor(random() * 288) * 5);
  const windows: ScheduleWindow[] = [];
  const count = 1 + Math.floor(random() * 5);
  for (let tries = 0; tries < count * 4 && windows.length < count; tries++) {
    const kind = random() < 0.5 ? 'awake' : 'nap';
    const days: Day[] = DAYS.filter(() => random() < 0.4);
    if (!days.length) days.push(pick(DAYS));
    const start = time();
    const end = random() < 0.25 ? start : time();
    const wake = kind === 'nap' && random() < 0.7 ? { wake: pick(['never', 'header'] as const) } : {};
    const w: ScheduleWindow = { kind, days, start, end, ...wake };
    if (!r.scheduleProblems({ timeZone: zone, windows: [...windows, w] }).length) windows.push(w);
  }
  const exceptions = Array.from({ length: Math.floor(random() * 4) }, () => iso(anchor + Math.floor(random() * 9 - 4) * DAY).slice(0, 10));
  return r.normalizeSchedule({ timeZone: zone, windows, ...(exceptions.length ? { exceptions } : {}) });
}

// A recurring window near the anchor: every pattern, its dates chosen so that it does fall around the anchor, half the time
// around the hours clocks change.
function randomRecurring(random: () => number, anchor: number): ScheduleWindow {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const near = (days: number) => iso(anchor + Math.floor(random() * (2 * days + 1) - days) * DAY).slice(0, 10);
  const time = () => hhmm(random() < 0.5 ? 60 + Math.floor(random() * 31) * 5 : Math.floor(random() * 288) * 5);
  const date = new Date(anchor);
  const dayOfMonth = () => (random() < 0.2 ? pick([29, 30, 31]) : Math.min(31, Math.max(1, date.getUTCDate() + Math.floor(random() * 5) - 2)));
  const start = time();
  const times = { start, end: random() < 0.2 ? start : time() };
  const kind = random() < 0.5 ? 'awake' as const : 'nap' as const;
  const wake = kind === 'nap' && random() < 0.7 ? { wake: pick(['never', 'header'] as const) } : {};
  const range = { ...(random() < 0.4 ? { from: near(10) } : {}), ...(random() < 0.3 ? { until: iso(anchor + Math.floor(random() * 12 + 1) * DAY).slice(0, 10) } : {}) };
  const counted = { ...range, from: range.from ?? near(30) };
  const interval = pick([2, 2, 3, 5]);
  const kindOf = pick(['daily', 'dailyN', 'weekly', 'weeklyN', 'monthDay', 'monthDayN', 'monthNth', 'yearly', 'yearlyNth', 'cron', 'cron', 'cron', 'plainRange', 'once', 'once'] as const);
  const days: Day[] = DAYS.filter(() => random() < 0.4);
  if (!days.length) days.push(pick(DAYS));
  const yearlyFrom = iso(Date.UTC(date.getUTCFullYear() - pick([0, 1]), date.getUTCMonth(), 1)).slice(0, 10);
  switch (kindOf) {
    case 'daily': return { kind, ...times, repeat: { pattern: 'daily' }, ...range, ...wake };
    case 'dailyN': return { kind, ...times, repeat: { pattern: 'daily', interval }, ...counted, ...wake };
    case 'weekly': return { kind, ...times, repeat: { pattern: 'weekly', days }, ...range, ...wake };
    case 'weeklyN': return { kind, ...times, repeat: { pattern: 'weekly', interval, days }, ...counted, ...wake };
    case 'monthDay': return { kind, ...times, repeat: { pattern: 'monthly', day: dayOfMonth() }, ...range, ...wake };
    case 'monthDayN': return { kind, ...times, repeat: { pattern: 'monthly', interval, day: dayOfMonth() }, ...counted, ...wake };
    case 'monthNth': return { kind, ...times, repeat: { pattern: 'monthly', nth: pick([1, 2, 3, 4, -1]), weekday: pick(DAYS) }, ...range, ...wake };
    case 'yearly': return { kind, ...times, repeat: { pattern: 'monthly', interval: 12, day: dayOfMonth() }, from: yearlyFrom, ...wake };
    case 'yearlyNth': return { kind, ...times, repeat: { pattern: 'monthly', interval: 12, nth: pick([1, 2, 3, 4, -1]), weekday: pick(DAYS) }, from: yearlyFrom, ...wake };
    case 'plainRange': return { kind, ...times, days, ...range, ...wake };
    case 'once': { const date = near(3); return { kind, ...times, repeat: { pattern: 'daily' }, from: date, until: date, ...wake }; }
    default: {
      const anchorDay = date.getUTCDate();
      const expression = pick([
        '30 2 * * *', '0,30 1-3 * * *', '*/30 2 * * *', '*/15 2 * * 0', '*/5 2 * * *', '0 8 * * 1-5', '0 22 * * FRI', '0 0 * * MON-WED', '30 8 ? * ?', '0 12 * * 6,7', '0 3 */2 * *',
        `0 8 ${anchorDay} * *`, `15 2 ${anchorDay} * MON`, `0 12 ${anchorDay} ${date.getUTCMonth() + 1} *`, '0 8 29 2 *',
      ]);
      return { kind, repeat: { pattern: 'cron', cron: expression, minutes: pick([5, 30, 60, 630, 1440, 1445, 2880, 10080]) }, ...range, ...wake };
    }
  }
}

// 1 to 4 recurring windows the router takes together (the overlap check reads from before the anchor), up to 3 exception
// dates around the anchor.
function randomRecurringSchedule(random: () => number, r: RouterSchedule, zone: string, anchor: number): Schedule {
  const windows: ScheduleWindow[] = [];
  const count = 1 + Math.floor(random() * 4);
  const now = anchor - 12 * DAY;
  for (let tries = 0; tries < count * 6 && windows.length < count; tries++) {
    const w = randomRecurring(random, anchor);
    if (!r.scheduleProblems({ timeZone: zone, windows: [...windows, w] }, { now }).length) windows.push(w);
  }
  const exceptions = Array.from({ length: Math.floor(random() * 4) }, () => iso(anchor + Math.floor(random() * 9 - 4) * DAY).slice(0, 10));
  return r.normalizeSchedule({ timeZone: zone, windows, ...(exceptions.length ? { exceptions } : {}) });
}

// Windows that a value of joinMinutes can join: two of one kind with a chosen gap, a third of the other kind in the gap or not,
// a range or an exception date taking the second start away, or a cron chain with gaps of its own. Half the time around the hours
// clocks change, and past midnight when the times fall so.
const GAPS = [0, 5, 10, 15, 20, 25, 30, 60, 115, 120, 125];
function randomJoinedSchedule(random: () => number, r: RouterSchedule, zone: string, anchor: number): Schedule {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const kind = pick(['awake', 'nap'] as const);
  const other = kind === 'nap' ? 'awake' as const : 'nap' as const;
  const wake = (k: 'awake' | 'nap') => (k === 'nap' ? { wake: pick(['never', 'header'] as const) } : {});
  const near = (days: number) => iso(anchor + days * DAY).slice(0, 10);
  const time = (minutes: number) => hhmm(((minutes % 1440) + 1440) % 1440);
  if (random() < 0.25) {
    const [cron, minutes] = pick([['*/15 * * * *', 5], ['*/15 1-3 * * *', 5], ['*/30 1-3 * * *', 15], ['0 1-5 * * *', 50], ['*/15 2 * * *', 5], ['0,20 22,23 * * *', 15]] as const);
    return r.normalizeSchedule({ timeZone: zone, windows: [{ kind, repeat: { pattern: 'cron', cron, minutes }, ...wake(kind) }] });
  }
  const start = random() < 0.5 ? 60 + Math.floor(random() * 31) * 5 : Math.floor(random() * 288) * 5;
  const firstEnd = start + pick([30, 55, 110, 115, 240]);
  const gap = pick(GAPS);
  const second = firstEnd + gap;
  const secondEnd = second + pick([5, 60, 120, 300]);
  const on = random() < 0.5 ? { days: DAYS } : { repeat: { pattern: 'daily' as const } };
  const windows: ScheduleWindow[] = [{ kind, ...on, start: time(start), end: time(firstEnd), ...wake(kind) }];
  const add = (w: ScheduleWindow) => { if (!r.scheduleProblems({ timeZone: zone, windows: [...windows, w] }, { now: anchor - 12 * DAY }).length) windows.push(w); };
  const range = random() < 0.15 ? { from: near(1) } : random() < 0.15 ? { until: near(-1) } : {};
  add({ kind, ...on, start: time(second), end: time(secondEnd), ...range, ...wake(kind) });
  if (gap >= 10 && random() < 0.3) {
    const from = firstEnd + pick([0, 5]);
    add({ kind: other, ...on, start: time(from), end: time(Math.min(second, from + 5)), ...wake(other) });
  }
  const exceptions = random() < 0.2 ? [near(Math.floor(random() * 5) - 2)] : [];
  return r.normalizeSchedule({ timeZone: zone, windows, ...(exceptions.length ? { exceptions } : {}) });
}

// What the router's own tests take and refuse, the two tables' expressions: its words have to come back.
const VALID_CRONS = [
  '30 8 * * *', '0,30 8 * * *', '*/30 8 * * *', '0-30/15 8 * * *', '0 8-10 * * *', '0 */12 * * *', '0 1-2,20-22/2 * * *', '0 8 *,5 * *', '0 8 15 * *', '0 8 15 3 *', '0 8 15 MAR *', '0 8 15 mAr *',
  '0 8 15 mar-may *', '0 8 * * 1', '0 8 * * MON', '0 8 * * mon', '0 8 * * MON-WED', '0 8 * * 0', '0 8 * * 7', '0 8 * * 5-7', '0 8 * * FRI-SUN', '0 8 * * SUN-MON', '0 8 * * */3', '0 8 ? * 1', '0 8 15 * ?',
  '0 8 15 * MON', '0 8 */10 * *', '0 8 * * */2', '0 8 */2 * ?', '0\t8 * * 1', '0 8 ? * ?', '  0   8 15 *  * ', '0 8 31 1,2 *', '0 8 29 2 *', '*/100 8 * * *', '0 8 * * *',
];
const REFUSED_CRONS = [
  '* 8 * * *', '3 8 * * *', '0,31 8 * * *', '*/7 8 * * *', '1-59/5 8 * * *', 'cron(0 8 * * ? *)', 'cron(0 8 * * 1)', '0 8 * * ? *', '0 8 * *', '@daily', '   ', '0 8 L * *', '0 8 1,L * *', '0 8 L-3 * *',
  '0 8 * * 5L', '0 8 * * FRIL', '0 8 15W * *', '0 8 LW * *', '0 8 * * MON#2', '0 8 31 2 *', '0 8 30,31 2 *', '0 8 31 APR *', '0 24 * * *', '60 8 * * *', '0 8 0 * *', '0 8 32 * *', '0 8 * 0 *', '0 8 * 13 *',
  '0 8 * * 8', '0 8 * MON *', '0 8 * * JAN', '0 MON * * *', '? 8 * * *', '0 ? * * *', '0 8 * ? *', '0 8 ?,1 * *', '0 8 ?/2 * *', '0 10-8 * * *', '0 8 * * 5-1', '*/0 8 * * *', '5/5 8 * * *', '0,,30 8 * * *',
  '-5 8 * * *', '0 eight * * *', '0 8 */10 * MON', '0 8 */2 * 1', '0 8 15 * */2', '0 8 *,5 * MON', '0 8 */2 * */3', '0 8 * * 1\n', '0\r8 * * 1', '0 8\n* * 1', '0 8 \0* * 1', '0 8 * * \x7f1', `0 8 ${Array(100).fill('1').join(',')} * *`,
];
const awake = (fields: Record<string, unknown>) => ({ kind: 'awake', start: '08:00', end: '12:00', ...fields });
const WINDOWS: unknown[] = [
  awake({ days: ['mon'], from: '2027-1-4' }), awake({ days: ['mon'], from: '2027-02-30' }), awake({ days: ['mon'], until: 20270104 }), awake({ days: ['mon'], from: '2027-01-05', until: '2027-01-04' }),
  awake({ days: ['mon'], from: '2027-01-04', until: '2027-01-04' }), awake({ days: ['mon'], repeat: { pattern: 'daily' } }), awake({}), awake({ repeat: 'daily' }), awake({ repeat: { interval: 2 } }),
  awake({ repeat: { pattern: 'yearly' } }), awake({ repeat: { pattern: 'daily', every: 2 } }), awake({ repeat: { pattern: 'daily', days: ['mon'] } }), awake({ repeat: { pattern: 'daily', interval: 0 } }),
  awake({ repeat: { pattern: 'daily', interval: 100 }, from: '2027-01-04' }), awake({ repeat: { pattern: 'daily', interval: 1.5 } }), awake({ repeat: { pattern: 'daily', interval: '2' } }),
  awake({ repeat: { pattern: 'daily', interval: 2 } }), awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon'] } }), awake({ repeat: { pattern: 'monthly', interval: 12, day: 25 } }),
  awake({ repeat: { pattern: 'weekly' } }), awake({ repeat: { pattern: 'weekly', days: [] } }), awake({ repeat: { pattern: 'weekly', days: ['mon', 'mon'] } }), awake({ repeat: { pattern: 'weekly', days: ['Mon'] } }),
  awake({ repeat: { pattern: 'monthly' } }), awake({ repeat: { pattern: 'monthly', day: 1, nth: 1, weekday: 'mon' } }), awake({ repeat: { pattern: 'monthly', day: 1, weekday: 'mon' } }), awake({ repeat: { pattern: 'monthly', weekday: 'mon' } }),
  awake({ repeat: { pattern: 'monthly', day: 0 } }), awake({ repeat: { pattern: 'monthly', day: 32 } }), awake({ repeat: { pattern: 'monthly', nth: 5, weekday: 'mon' } }), awake({ repeat: { pattern: 'monthly', nth: -2, weekday: 'mon' } }),
  awake({ repeat: { pattern: 'monthly', nth: 1 } }), awake({ repeat: { pattern: 'monthly', nth: 1, weekday: 'Monday' } }), { kind: 'awake', end: '12:00', repeat: { pattern: 'daily' } }, { kind: 'awake', start: '08:00', repeat: { pattern: 'daily' } },
  { kind: 'awake', start: '08:00', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 5 } }, { kind: 'awake', end: '12:00', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 5 } },
  { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 5, interval: 2 }, from: '2027-01-04' }, { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *' } }, { kind: 'awake', repeat: { pattern: 'cron', minutes: 5 } },
  ...[0, 7, 10085, '60', 5, 10080].map((minutes) => ({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes } })),
  awake({ repeat: { pattern: 'daily' }, wake: 'never' }), awake({ days: ['mon'], from: null, until: null, repeat: null }), awake({ days: null, repeat: { pattern: 'daily', interval: null } }),
  awake({ repeat: { pattern: 'monthly', day: null, nth: -1, weekday: 'sun' } }), awake({ days: ['mon'], other: 1 }), { kind: 'other', days: ['mon'], start: '08:01', end: '25:00' }, 'not an object',
  { kind: 'nap', days: ['mon'], start: '08:00', end: '09:00', wake: 'sometimes' },
];

if (!router) {
  describe('occurrences parity with the router', () => {
    it.skip(`skipped: the router checkout is absent (${file}); clone Dormeto/router beside the manager to run it`, () => {});
  });
} else {
  const r = router;
  const newCounts = () => ({ schedules: 0, overnight: 0, allDay: 0, exceptions: 0, occurrences: 0, edges: 0, instants: 0, inside: 0, nearChange: 0, ranges: 0 });
  // One schedule against the router, around its anchor: the edges, every sampled instant, and a range.
  const compare = (s: Schedule, n: number, anchor: number, near: number[], random: () => number, counts: ReturnType<typeof newCounts>, mismatches: string[], join: { joinMinutes?: number } = {}) => {
    counts.schedules += 1;
    counts.overnight += s.windows!.filter((w) => w.end! < w.start!).length;
    counts.allDay += s.windows!.filter((w) => w.start && w.end === w.start).length;
    counts.exceptions += s.exceptions?.length ?? 0;

    const [from, to] = [anchor - 3 * DAY, anchor + 3 * DAY];
    // Every occurrence that holds an instant of [from, to) overlaps this wider range.
    const ours = occurrencesIn(s, anchor - 4 * DAY, anchor + 4 * DAY, join);
    counts.occurrences += ours.length;
    const context = (t: number) => `seed ${SEED}, schedule ${n} ${JSON.stringify(s)} at ${iso(t)}`;

    // The edges in (from, to]: the router's next events, and ours as it counts them (each start; an end that no
    // occurrence of its kind holds). They also show an occurrence no instant is inside.
    const events = r.nextEvents(s, from, { count: 10_000, horizonDays: 6, ...join });
    const theirEdges = [...new Set(events.map((e) => `${e.at} ${e.kind}`))].sort();
    const held = (kind: string, t: number) => ours.some((o) => o.kind === kind && o.start <= t && t < o.end);
    const within = (t: number) => t > from && t <= to;
    const ourEdges = [...new Set(ours.flatMap((o) => [
      ...(within(o.start) ? [`${iso(o.start)} ${o.kind}-start`] : []),
      ...(within(o.end) && !held(o.kind, o.end) ? [`${iso(o.end)} ${o.kind}-end`] : []),
    ]))].sort();
    counts.edges += ourEdges.length;
    if (JSON.stringify(ourEdges) !== JSON.stringify(theirEdges)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} edges from ${iso(from)}: ours ${JSON.stringify(ourEdges)}, the router's ${JSON.stringify(theirEdges)}`);

    const instants = new Set<number>();
    for (let i = 0; i < 12; i++) instants.add(anchor + Math.round((random() * 6 - 3) * 60) * MINUTE);
    for (let i = 0; i < 8; i++) instants.add(from + Math.floor(random() * (to - from)));
    for (const o of ours) for (const t of [o.start - 1, o.start, o.end - 1, o.end]) instants.add(t);
    for (const e of events) for (const t of [Date.parse(e.at) - 1, Date.parse(e.at)]) instants.add(t);

    for (const t of instants) {
      if (t < from || t >= to) continue;
      counts.instants += 1;
      if (near.some((c) => Math.abs(c - t) <= HOUR)) counts.nearChange += 1;
      const active: Occurrence[] = ours.filter((o) => o.start <= t && t < o.end);
      const theirs = r.occurrenceAt(s, t, join);
      if (active.length) counts.inside += 1;
      if (active.length && !theirs) mismatches.push(`${context(t)}: ours ${JSON.stringify(active)}, the router's none`);
      else if (!active.length && theirs) mismatches.push(`${context(t)}: ours none, the router's ${JSON.stringify(theirs)}`);
      else if (theirs) {
        if (active.some((o) => o.kind !== theirs.kind)) mismatches.push(`${context(t)}: kinds differ, ours ${JSON.stringify(active)}, the router's ${JSON.stringify(theirs)}`);
        const latest = Math.max(...active.map((o) => o.start));
        if (latest !== theirs.start || !active.some((o) => o.start === theirs.start && o.window === theirs.window)) {
          mismatches.push(`${context(t)}: the router's occurrence ${JSON.stringify(theirs)} is not our latest of ${JSON.stringify(active)}`);
        }
        // A nap's wake mode, in a joined gap the first occurrence's: never when any active one says so.
        const wake = theirs.kind === 'nap' ? (active.some((o) => o.wake === 'never') ? 'never' : 'header') : undefined;
        if (wake !== theirs.wake) mismatches.push(`${context(t)}: the wake of ${JSON.stringify(active)} is ${wake}, the router's ${JSON.stringify(theirs)}`);
      }
    }

    // A range inside the wider one: exactly its occurrences that overlap the range.
    const a = from + Math.floor(random() * (to - from));
    const b = Math.min(a + Math.floor(random() * 2 * DAY), anchor + 4 * DAY);
    const inRange = occurrencesIn(s, a, b, join);
    const expected = ours.filter((o) => o.start < b && o.end > a);
    counts.ranges += 1;
    if (JSON.stringify(inRange) !== JSON.stringify(expected)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} in [${iso(a)}, ${iso(b)}): ${JSON.stringify(inRange)} instead of ${JSON.stringify(expected)}`);
  };

  describe('occurrences parity with the router', () => {
    it(`${SCHEDULES} random schedules agree with occurrenceAt at instants near clock changes and at every boundary, and with nextEvents (seed ${SEED})`, () => {
      const random = generator(SEED);
      const zoneChanges = new Map(ZONES.map((zone) => [zone, changes(zone)]));
      const mismatches: string[] = [];
      const counts = newCounts();
      for (let n = 0; n < SCHEDULES; n++) {
        const zone = ZONES[n % ZONES.length]!;
        const near = zoneChanges.get(zone)!;
        const anchor = near.length && random() < 0.85 ? near[Math.floor(random() * near.length)]! : FROM + Math.floor(random() * (TO - FROM - 8 * DAY)) + 4 * DAY;
        const s = randomSchedule(random, r, zone, anchor);
        const problems = r.scheduleProblems(s);
        if (problems.length) throw new Error(`seed ${SEED}, schedule ${n}: generated invalid ${JSON.stringify(s)}: ${problems.join('; ')}`);
        compare(s, n, anchor, near, random, counts, mismatches);
      }
      console.info(`occurrences parity (seed ${SEED}): ${JSON.stringify(counts)}`);
      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches, the first 5 shown`).toEqual([]);
      // Not vacuous: overnight and 24-hour windows, exceptions, instants inside occurrences and within an hour of a
      // change.
      expect(counts.schedules).toBe(SCHEDULES);
      for (const key of ['overnight', 'allDay', 'exceptions', 'edges', 'inside', 'nearChange'] as const) expect(counts[key], key).toBeGreaterThan(100);
    }, 120_000);

    it(`${RECURRING} random recurring schedules agree as well, across clock changes, and with nextEvents over its whole horizon (seed ${SEED})`, () => {
      const random = generator(SEED + 1);
      const zoneChanges = new Map(ZONES.map((zone) => [zone, changes(zone)]));
      const mismatches: string[] = [];
      const counts = newCounts();
      const patterns = { once: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0, cron: 0, longCron: 0, nextEvents: 0 };
      for (let n = 0; n < RECURRING; n++) {
        const zone = ZONES[n % ZONES.length]!;
        const near = zoneChanges.get(zone)!;
        const anchor = near.length && random() < 0.7 ? near[Math.floor(random() * near.length)]! : FROM + Math.floor(random() * (TO - FROM - 8 * DAY)) + 4 * DAY;
        const s = randomRecurringSchedule(random, r, zone, anchor);
        const problems = r.scheduleProblems(s, { now: anchor - 12 * DAY });
        if (problems.length) throw new Error(`seed ${SEED}, schedule ${n}: generated invalid ${JSON.stringify(s)}: ${problems.join('; ')}`);
        for (const w of s.windows!) {
          if (isOnce(w)) patterns.once += 1;
          else if (w.repeat?.pattern === 'monthly' && w.repeat.interval === 12) patterns.yearly += 1;
          else if (w.repeat) patterns[w.repeat.pattern] += 1;
          if (w.repeat?.pattern === 'cron' && w.repeat.minutes > 1440) patterns.longCron += 1;
        }
        compare(s, n, anchor, near, random, counts, mismatches);
        // The port's own nextEvents, on the router's default horizon, stopping early or not.
        for (const count of [1, 5, 40]) {
          const t = anchor - Math.floor(random() * 3 * DAY);
          const [ours, theirs] = [nextEvents(s, t, { count }), r.nextEvents(s, t, { count })];
          patterns.nextEvents += theirs.length;
          if (JSON.stringify(ours) !== JSON.stringify(theirs)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} next ${count} from ${iso(t)}: ours ${JSON.stringify(ours)}, the router's ${JSON.stringify(theirs)}`);
        }
      }
      console.info(`recurring parity (seed ${SEED}): ${JSON.stringify({ ...counts, ...patterns })}`);
      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches, the first 5 shown`).toEqual([]);
      expect(counts.schedules).toBe(RECURRING);
      for (const key of ['exceptions', 'edges', 'inside', 'nearChange'] as const) expect(counts[key], key).toBeGreaterThan(100);
      for (const [key, seen] of Object.entries(patterns)) expect(seen, key).toBeGreaterThan(20);
    }, 180_000);

    for (const joinMinutes of [0, 15, 30, 120]) {
      it(`${JOINED} schedules with gaps agree at joinMinutes ${joinMinutes}, across clock changes, with its next events too (seed ${SEED})`, () => {
        const random = generator(SEED + 2 + joinMinutes);
        const zoneChanges = new Map(ZONES.map((zone) => [zone, changes(zone)]));
        const mismatches: string[] = [];
        const counts = newCounts();
        let joined = 0;
        let nextChecked = 0;
        for (let n = 0; n < JOINED; n++) {
          const zone = ZONES[n % ZONES.length]!;
          const near = zoneChanges.get(zone)!;
          const anchor = near.length && random() < 0.7 ? near[Math.floor(random() * near.length)]! : FROM + Math.floor(random() * (TO - FROM - 8 * DAY)) + 4 * DAY;
          const s = randomJoinedSchedule(random, r, zone, anchor);
          joined += occurrencesIn(s, anchor - DAY, anchor + DAY, { joinMinutes }).filter((o) => o.joined).length;
          compare(s, n, anchor, near, random, counts, mismatches, { joinMinutes });
          for (const count of [1, 5, 40]) {
            const t = anchor - Math.floor(random() * 3 * DAY);
            const [ours, theirs] = [nextEvents(s, t, { count, joinMinutes }), r.nextEvents(s, t, { count, joinMinutes })];
            nextChecked += theirs.length;
            if (JSON.stringify(ours) !== JSON.stringify(theirs)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} next ${count} from ${iso(t)}: ours ${JSON.stringify(ours)}, the router's ${JSON.stringify(theirs)}`);
          }
        }
        console.info(`joined parity at ${joinMinutes} (seed ${SEED}): ${JSON.stringify({ ...counts, joined, nextChecked })}`);
        expect(mismatches.slice(0, 5), `${mismatches.length} mismatches, the first 5 shown`).toEqual([]);
        // Not vacuous: gaps joined at any value but 0, near clock changes, and instants inside what they make.
        if (joinMinutes) expect(joined).toBeGreaterThan(200);
        else expect(joined).toBe(0);
        for (const key of ['edges', 'inside', 'nearChange'] as const) expect(counts[key], key).toBeGreaterThan(100);
      }, 180_000);
    }

    // The router's own cases: each is read at the instant that tells, on both sides.
    const at = (s: Schedule, text: string, join: { joinMinutes?: number } = {}) => {
      const t = Date.parse(text);
      const theirs = r.occurrenceAt(s, t, join);
      const active = occurrencesIn(s, t - 1, t + 1, join).filter((o) => o.start <= t && t < o.end);
      expect(active.length > 0, `${JSON.stringify(s)} at ${text}: ours ${JSON.stringify(active)}, the router's ${JSON.stringify(theirs)}`).toBe(theirs !== null);
      if (theirs) expect(active.some((o) => o.start === theirs.start && o.window === theirs.window)).toBe(true);
      return theirs;
    };
    const window = (kind: 'awake' | 'nap', start: string, end: string, more: Partial<ScheduleWindow> = {}): ScheduleWindow => ({ kind, days: ['sun'], start, end, ...more });

    it('the gap is elapsed time: across the spring change 70 wall minutes are 10 and join, a second start in the skipped hour is the change', () => {
      const s = { timeZone: 'Europe/Paris', windows: [window('awake', '00:00', '01:55'), window('awake', '03:05', '05:00')] };
      expect(at(s, '2027-03-28T01:58:00+01:00')?.window).toBe(0);
      expect(at(s, '2027-03-28T01:58:00+01:00', { joinMinutes: 5 })).toBeNull();
      expect(at(s, '2027-03-28T01:58:00+01:00', { joinMinutes: 10 })?.window).toBe(0);
      const skipped = { timeZone: 'Europe/Paris', windows: [window('awake', '00:00', '01:50'), window('awake', '02:30', '05:00')] };
      expect(at(skipped, '2027-03-28T01:55:00+01:00')?.window).toBe(0);
    });

    it('the gap is elapsed time: across the autumn change 15 wall minutes are 75 and do not join', () => {
      const s = { timeZone: 'Europe/Paris', windows: [window('awake', '01:00', '02:50'), window('awake', '03:05', '05:00')] };
      expect(at(s, '2027-10-31T02:55:00+02:00')).toBeNull();
      expect(at(s, '2027-10-31T02:55:00+02:00', { joinMinutes: 70 })).toBeNull();
      expect(at(s, '2027-10-31T02:55:00+02:00', { joinMinutes: 75 })?.window).toBe(0);
      const after = { timeZone: 'Europe/Paris', windows: [window('awake', '03:30', '04:00'), window('awake', '04:15', '05:00')] };
      expect(at(after, '2027-10-31T04:05:00+01:00')?.window).toBe(0);
    });

    it('only the other kind starting in [end, next start) blocks a join: at its first minute, up to its last, not with the second start', () => {
      const around = (start: string, end: string): Schedule => ({ timeZone: 'UTC', windows: [window('awake', '08:00', '12:00'), window('nap', start, end), window('awake', '12:15', '18:00')] });
      const gap = '2026-10-18T12:02:00Z';
      expect(at(around('12:05', '12:10'), gap)).toBeNull();
      expect(at(around('12:00', '12:05'), gap)?.kind).toBe('nap');
      expect(at(around('12:10', '12:15'), gap)).toBeNull();
      expect(at(around('12:15', '12:30'), gap)?.kind).toBe('awake');
      // One the range removes holds nothing: a nap that ended before.
      const gone: Schedule = { timeZone: 'UTC', windows: [window('awake', '08:00', '12:00'), window('nap', '12:05', '12:10', { until: '2026-10-17' }), window('awake', '12:15', '18:00')] };
      expect(at(gone, gap)?.kind).toBe('awake');
    });

    it('a second start an exception date or a range removes joins nothing', () => {
      const windows: ScheduleWindow[] = [window('nap', '20:00', '23:55', { days: ['mon'] }), window('nap', '00:05', '07:00', { days: ['tue'] })];
      const gap = '2026-10-19T23:58:00Z';
      expect(at({ timeZone: 'UTC', windows }, gap)?.window).toBe(0);
      expect(at({ timeZone: 'UTC', windows, exceptions: ['2026-10-20'] }, gap)).toBeNull();
      expect(at({ timeZone: 'UTC', windows: [windows[0]!, { ...windows[1]!, from: '2026-10-21' }] }, gap)).toBeNull();
      expect(at({ timeZone: 'UTC', windows: [windows[0]!, { ...windows[1]!, until: '2026-10-19' }] }, gap)).toBeNull();
      expect(at({ timeZone: 'UTC', windows, exceptions: ['2026-10-19'] }, gap)).toBeNull();
    });

    it('a chain such as */15 lasting 5 is one, and at 0 is not', () => {
      const s: Schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', repeat: { pattern: 'cron', cron: '*/15 * * * *', minutes: 5 }, wake: 'header' }] };
      expect(at(s, '2027-01-04T10:07:00Z')?.start).toBe(Date.parse('2027-01-04T10:00:00Z'));
      expect(at(s, '2027-01-04T10:07:00Z', { joinMinutes: 0 })).toBeNull();
      expect(at(s, '2027-01-04T10:07:00Z', { joinMinutes: 5 })).toBeNull();
      expect(at(s, '2027-01-04T10:07:00Z', { joinMinutes: 10 })?.start).toBe(Date.parse('2027-01-04T10:00:00Z'));
      const t = Date.parse('2027-01-04T10:01:00Z');
      for (const joinMinutes of [0, 15]) expect(nextEvents(s, t, { count: 12, joinMinutes })).toEqual(r.nextEvents(s, t, { count: 12, joinMinutes }));
    });

    it('the option wins over the schedule\'s value, which wins over 15; an invalid option is ignored', () => {
      const s = (more: Partial<Schedule> = {}): Schedule => ({ timeZone: 'UTC', windows: [window('awake', '08:00', '12:00'), window('awake', '12:20', '18:00')], ...more });
      const gap = '2026-10-18T12:05:00Z';
      expect(at(s(), gap)).toBeNull();
      expect(at(s({ joinMinutes: 30 }), gap)?.window).toBe(0);
      expect(at(s({ joinMinutes: 30 }), gap, { joinMinutes: 0 })).toBeNull();
      expect(at(s({ joinMinutes: 0 }), gap, { joinMinutes: 20 })?.window).toBe(0);
      expect(at(s({ joinMinutes: 'x' as unknown as number }), gap)).toBeNull();
      expect(at(s({ joinMinutes: null }), gap)).toBeNull();
      expect(at(s({ joinMinutes: 30 }), gap, { joinMinutes: 7 })?.window).toBe(0);
      expect(at(s(), gap, { joinMinutes: 7 })).toBeNull();
    });

    it('takes and refuses a value in the router\'s words', () => {
      for (const value of [-5, 0, 3, 5, 15, 2.5, 120, 125, '15', true, null, undefined, NaN]) expect(isJoinMinutes(value), String(value)).toBe(r.isJoinMinutes(value));
      expect(r.scheduleProblems({ timeZone: 'UTC', windows: [window('awake', '08:00', '12:00')], joinMinutes: 7 })).toEqual([JOIN_PROBLEM]);
      expect(r.scheduleProblems({ timeZone: 'UTC', windows: [window('awake', '08:00', '12:00')], joinMinutes: null })).toEqual([]);
    });

    it('a window as it is dragged starts in the same place whatever the value in force: only an end moves', () => {
      const w: ScheduleWindow = { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' } };
      const other: ScheduleWindow = { kind: 'awake', start: '12:10', end: '18:00', repeat: { pattern: 'daily' } };
      const starts = (joinMinutes: number) => r.nextEvents({ timeZone: 'UTC', windows: [moveWindow(w, 60, '2027-01-01')!, other] }, Date.parse('2027-01-04T00:00:00Z'), { count: 12, joinMinutes }).filter((e) => e.kind.endsWith('-start')).map((e) => e.at);
      expect(starts(120)).toEqual(starts(0));
    });

    it('the demo resolves a value as the router does, at each level', () => {
      for (const levels of [{}, { manager: 20 }, { router: 30, manager: 20 }, { workload: 0, router: 30, manager: 20 }, { workload: 45 }, { router: 0 }]) {
        const { joinMinutes, joinFrom } = joinLevelsOf(levels);
        expect({ joinMinutes, from: joinFrom }, JSON.stringify(levels)).toEqual(r.resolveJoin(levels));
      }
    });

    it('refuses a window in the router\'s words, every pattern and every cron expression of its tables', () => {
      const cases = [...WINDOWS, ...[...VALID_CRONS, ...REFUSED_CRONS].map((cron) => ({ kind: 'awake', repeat: { pattern: 'cron', cron, minutes: 60 } }))];
      let refused = 0;
      for (const w of cases) {
        const theirs = r.scheduleProblems({ timeZone: 'UTC', windows: [w] });
        refused += theirs.length ? 1 : 0;
        expect(windowProblems(w as ScheduleWindow, 'windows[0]'), JSON.stringify(w)).toEqual(theirs);
      }
      expect(refused).toBeGreaterThan(70);
      for (const cron of VALID_CRONS) expect(r.scheduleProblems({ timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron, minutes: 60 } }] }), cron).toEqual([]);
      for (const cron of REFUSED_CRONS) expect(r.scheduleProblems({ timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron, minutes: 60 } }] }), cron).toHaveLength(1);
    });

    it('a stored window neither can read has no occurrence on either side, rather than an error', () => {
      const at = Date.parse('2027-01-04T09:00:00Z');
      for (const w of [{ kind: 'awake', repeat: { pattern: 'cron', cron: 'not cron', minutes: 60 } }, { kind: 'awake', start: '08:00', end: '10:00', repeat: { pattern: 'hourly' } }] as unknown as ScheduleWindow[]) {
        const s = { timeZone: 'UTC', windows: [w] };
        expect(r.occurrenceAt(s, at)).toBeNull();
        expect(occurrencesIn(s, at - DAY, at + DAY)).toEqual([]);
        expect(nextEvents(s, at)).toEqual(r.nextEvents(s, at, { count: 5 }));
      }
    });

    it('Do not repeat has one occurrence on its date for the router too, past or future, overnight or not', () => {
      for (const date of ['2020-02-29', '2027-03-28', '2099-12-31']) {
        const s: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'daily' }, from: date, until: date }] };
        expect(r.scheduleProblems(s), date).toEqual([]);
        const noon = Date.parse(`${date}T12:00:00Z`);
        const ours = occurrencesIn(s, noon - 5 * DAY, noon + 5 * DAY);
        expect(ours, date).toHaveLength(1);
        expect(new Date(ours[0]!.start).toISOString().slice(0, 10)).toBe(date);
        expect(r.occurrenceAt(s, ours[0]!.start)?.start).toBe(ours[0]!.start);
        expect(r.occurrenceAt(s, ours[0]!.end - 1)?.end).toBe(ours[0]!.end);
        expect(r.occurrenceAt(s, ours[0]!.start - 1)).toBeNull();
        expect(r.occurrenceAt(s, ours[0]!.end)).toBeNull();
        expect(r.occurrenceAt(s, ours[0]!.start + 7 * DAY)).toBeNull();
        expect(nextEvents(s, noon - 5 * DAY)).toEqual(r.nextEvents(s, noon - 5 * DAY, { count: 5 }));
      }
    });

    it('the samples the dialog draws say what the router does', () => {
      const now = Date.parse('2026-11-01T12:00:00Z');
      // Two nap windows 10 minutes apart read as one, at the default; not at 0.
      const joined = OVERLAP_SAMPLES.find((x) => x.id === 'joined')!;
      const s = { timeZone: 'UTC', windows: joined.schedules[0]! };
      expect(r.occurrenceAt(s, Date.parse('2027-01-04T12:00:00Z'))?.kind).toBe('nap');
      expect(r.occurrenceAt(s, Date.parse('2027-01-04T12:00:00Z'), { joinMinutes: 0 })).toBeNull();
      for (const sample of OVERLAP_SAMPLES) {
        for (const windows of sample.schedules) {
          const found = r.scheduleProblems({ timeZone: 'UTC', windows }, { now });
          if (sample.allowed) expect(found, sample.title).toEqual([]);
          else expect(found[0], sample.title).toMatch(/^windows\[1\]: the nap window overlaps the awake window windows\[0\] \(/);
        }
      }
      expect(OVERLAP_SAMPLES.filter((x) => !x.allowed)).toHaveLength(1);
    });

    it('a dragged window, moved or refused, starts where the router says: every occurrence shifted', () => {
      const WINDOWS: ScheduleWindow[] = [
        { kind: 'awake', days: ['mon', 'thu'], start: '08:00', end: '12:00' },
        { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', wake: 'header' },
        { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
        { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', day: 15 } },
        { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', interval: 12, day: 10 }, from: '2027-02-01' },
        { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', interval: 3, nth: 2, weekday: 'mon' }, from: '2027-01-01' },
        { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: '2027-06-04', until: '2027-06-04' },
      ];
      const starts = (w: ScheduleWindow) => r.nextEvents({ timeZone: 'UTC', windows: [w] }, Date.parse('2026-12-20T00:00:00Z'), { count: 40 }).filter((e) => e.kind.endsWith('-start')).map((e) => Date.parse(e.at));
      let moved = 0;
      for (const w of WINDOWS) {
        for (const minutes of [60, -120, 1440, 2880, 1500, -1440]) {
          const next = moveWindow(w, minutes, '2026-12-01');
          if (!next) continue;
          moved += 1;
          expect(r.scheduleProblems({ timeZone: 'UTC', windows: [next] }, { now: Date.parse('2026-11-01T00:00:00Z') }), JSON.stringify(next)).toEqual([]);
          // From the same reading, a window further along has its first occurrences shifted: compared from their common span.
          const [a, b] = [starts(w).map((t) => t + minutes * MINUTE), starts(next)];
          const common = b.filter((t) => t >= Date.parse('2027-01-01T00:00:00Z')).slice(0, 8);
          for (const t of common) expect(a, `${JSON.stringify(next)} at ${iso(t)}`).toContain(t);
        }
      }
      expect(moved).toBeGreaterThan(25);
    });

    it('the demo\'s schedules are valid for the router', () => {
      const scheduled = state().workloads.filter((w) => w.schedule);
      expect(scheduled.length).toBeGreaterThan(6);
      for (const w of scheduled) expect(r.scheduleProblems(w.schedule), JSON.stringify(w.schedule)).toEqual([]);
      // What the demo answers of each up-to-date workload is what the router would: its next events at the value in force.
      for (const w of scheduled.filter((x) => state().routers.find((y) => y.name === x.router)!.version === AVAILABLE.version)) {
        const now = Date.now();
        const { joinMinutes } = scheduleView(state(), w, now);
        expect(scheduleView(state(), w, now).next).toEqual(r.nextEvents(w.schedule!, now, { count: 5, joinMinutes: joinMinutes! }));
      }
    });
  });
}
