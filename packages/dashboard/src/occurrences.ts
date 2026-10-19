// The Schedules calendar's arithmetic: a schedule's weekly windows expanded into occurrences (instants, epoch ms) and a
// calendar selection turned into a window. Ported from the router's lambda/src/lib/schedule.mjs (R12) with its names,
// held to it by test/occurrences-parity.test.ts. Pure: local wall times come from Intl only.
import { DAYS, canonicalZone, type Day, type Schedule } from './schedule';

export type Occurrence = { kind: 'awake' | 'nap'; window: number; start: number; end: number; wake?: 'never' | 'header' };

const MINUTE = 60_000;
const DAY = 86_400_000;
const STEP = 5;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

// Minutes after local midnight of an HH:MM on a 5-minute step, or null.
function minutesOf(text: string): number | null {
  const match = HHMM.exec(text);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  return minutes % STEP === 0 ? minutes : null;
}

// Local days are numbered from 1970-01-01, a Thursday; weekdays from 0 (mon).
const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;
const dateOf = (day: number): string => iso(day * DAY).slice(0, 10);

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The local wall clock at t, read as if it were UTC, to the second.
function wallClock(t: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(t)) p[type] = Number(value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

const offsetAt = (t: number, timeZone: string): number => wallClock(t, timeZone) - Math.floor(t / 1000) * 1000;
const localDay = (t: number, timeZone: string): number => Math.floor(wallClock(t, timeZone) / DAY);

// The instant of the local wall time `minutes` after midnight of local day `day`. A wall time a clock change skips is
// the first valid minute after it (the change itself); one it repeats is its first instance. A zone changes at most
// once within a day of any wall time.
function instantOf(day: number, minutes: number, timeZone: string): number {
  const wall = day * DAY + minutes * MINUTE;
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  if (before === after) return wall - before;
  const valid = [wall - before, wall - after].filter((t) => t + offsetAt(t, timeZone) === wall);
  if (valid.length) return Math.min(...valid);
  // Skipped: the offset is `before` until the change and `after` from it; find the change to the minute.
  let [lo, hi] = [wall - after, wall - before];
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

interface PlanWindow { window: number; kind: 'awake' | 'nap'; days: Set<Day>; start: number; end: number; wake?: 'never' | 'header' }
interface Plan { timeZone: string; exceptions: Set<string>; windows: PlanWindow[] }

// A schedule's windows ready for arithmetic, or null when it has none (or a zone Intl does not know). A window the router
// would refuse (a time off the 5-minute step) is left out; the others keep their index.
function prepare(s: Schedule): Plan | null {
  if (!s?.timeZone || !s.windows?.length || !canonicalZone(s.timeZone)) return null;
  const windows: PlanWindow[] = [];
  s.windows.forEach((w, window) => {
    const start = minutesOf(w.start);
    const end = minutesOf(w.end);
    if (start === null || end === null) return;
    windows.push({ window, kind: w.kind, days: new Set(w.days), start, end, ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}) });
  });
  return { timeZone: s.timeZone, exceptions: new Set(s.exceptions ?? []), windows };
}

// The occurrences of the windows that start on local day `day`: an occurrence ends at `end` the same day, the next day
// when `end` <= `start` (24 hours of wall time when equal). None on an exception date, and none that a clock change
// leaves empty.
function occurrencesOn(plan: Plan, day: number): Occurrence[] {
  if (plan.exceptions.has(dateOf(day))) return [];
  const occurrences: Occurrence[] = [];
  for (const w of plan.windows) {
    if (!w.days.has(DAYS[weekday(day)]!)) continue;
    const start = instantOf(day, w.start, plan.timeZone);
    const end = instantOf(w.end > w.start ? day : day + 1, w.end, plan.timeZone);
    if (end > start) occurrences.push({ kind: w.kind, window: w.window, start, end, ...(w.wake ? { wake: w.wake } : {}) });
  }
  return occurrences;
}

// Every occurrence that overlaps [from, to), exceptions applied, in order of start (then window): each window's own
// occurrences, as the router computes them, not the union its occurrenceAt reports.
export function occurrencesIn(s: Schedule, from: number, to: number): Occurrence[] {
  const plan = prepare(s);
  if (!plan || !(from < to)) return [];
  const occurrences: Occurrence[] = [];
  // An occurrence ends by the next local day, so those of the day before the range's first run into it; one more day
  // each side covers a clock going back over midnight.
  for (let day = localDay(from, plan.timeZone) - 2; day <= localDay(to, plan.timeZone) + 1; day++) {
    occurrences.push(...occurrencesOn(plan, day).filter((o) => o.start < to && o.end > from));
  }
  return occurrences.sort((a, b) => a.start - b.start || a.window - b.window);
}

// A selection of the calendar (instants) as a weekly window in `timeZone`: the local weekday of its start, its times on
// that zone's clock rounded to the nearest 5 minutes (a tie rounds up; the weekday is the rounded start's). Its length is
// measured on that clock, so a day selected over a clock change stays 24 hours: exactly 24 hours is a 24-hour window
// (start = end), a local end on the next day an overnight one (end before start), and more than 24 hours is refused (a
// weekly window cannot hold it).
export function windowFromSelection(start: Date, end: Date, timeZone: string): { days: Day[]; start: string; end: string } | { problem: string } {
  if (!canonicalZone(timeZone)) return { problem: `Not a time zone: ${timeZone}` };
  const [from, to] = [start.getTime(), end.getTime()];
  if (!(from < to)) return { problem: 'Select a range that ends after it starts.' };
  // Minutes of the zone's clock since 1970-01-01 00:00, on the 5-minute step.
  const clock = (t: number): number => Math.round((t + offsetAt(t, timeZone)) / (STEP * MINUTE)) * STEP;
  const [a, b] = [clock(from), clock(to)];
  if (b - a < STEP) return { problem: `A window lasts at least ${STEP} minutes on the clock of ${timeZone}: select a longer range.` };
  if (b - a > 1440) {
    const hours = Math.round(((b - a) / 60) * 100) / 100;
    return { problem: `A window lasts at most 24 hours, and this selection lasts ${hours} hours on the clock of ${timeZone}: select a shorter range, or whole days in the month view.` };
  }
  return { days: [DAYS[weekday(Math.floor(a / 1440))]!], start: hhmm(a % 1440), end: hhmm(b % 1440) };
}

// The days of a month selection as one 24-hour window on each of them (a weekend asleep): each day once, in week order.
export function allDayWindow(days: Day[]): { days: Day[]; start: '00:00'; end: '00:00' } {
  return { days: DAYS.filter((d) => days.includes(d)), start: '00:00', end: '00:00' };
}
