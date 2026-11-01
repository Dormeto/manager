// The Schedules calendar's arithmetic: a schedule's windows (weekly, or by a pattern or a cron expression within a range of
// dates) expanded into occurrences (instants, epoch ms), a window's refusals and a calendar selection turned into a window.
// Ported from the router's lambda/src/lib/schedule.mjs (R12 and the schedule recurrence design) with its names, held to it by
// test/occurrences-parity.test.ts. Pure: local wall times come from Intl only.
import { DAYS, JOIN_DEFAULT_MINUTES, canonicalZone, isJoinMinutes, isOnce, windowBody, type Day, type NextEvent, type Schedule, type ScheduleWindow } from './schedule';

// `joined`: its end is the next start of its kind, across a gap the value in force joins (schedule recurrence design, section 11).
export type Occurrence = { kind: 'awake' | 'nap'; window: number; start: number; end: number; wake?: 'never' | 'header'; joined?: true };
// `joinMinutes`: the value the levels resolve to, in the status answer; without a valid one, the schedule's own or the default.
export interface JoinOption { joinMinutes?: number }

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * 1440;
const STEP = 5;
const HORIZON_DAYS = 8;
// What nextEvents reads when a window has a repeat or a from, long enough for a yearly one.
const REPEAT_HORIZON_DAYS = 400;
// At least what a clock change moves a wall time by: how far a joined gap's local day can be from its minutes.
const CLOCK_CHANGE_MINUTES = 120;
// What the helper reads for its next occurrences: five of a yearly window are five years away.
const PREVIEW_DAYS = 3660;
const INTERVAL_MAX = 99;
const CRON_LENGTH_MAX = 200;
const CRON_MINUTES_MAX = WEEK;
const WAKES = ['never', 'header'];
const WINDOW_FIELDS = ['kind', 'days', 'start', 'end', 'repeat', 'from', 'until', 'wake'];
// The fields of a repeat, by pattern.
const REPEAT_FIELDS: Record<string, string[]> = {
  daily: ['pattern', 'interval'],
  weekly: ['pattern', 'interval', 'days'],
  monthly: ['pattern', 'interval', 'day', 'nth', 'weekday'],
  cron: ['pattern', 'cron', 'minutes'],
};
const PATTERNS = Object.keys(REPEAT_FIELDS);
const REPEAT_KNOWN = [...new Set(Object.values(REPEAT_FIELDS).flat())];
const NTHS = [1, 2, 3, 4, -1];
const CRON_WORDING = 'five fields: minute hour day-of-month month day-of-week';
// What EventBridge and Quartz take and crontab does not: it reads as their expression, not as a typing mistake.
const CRON_FOREIGN = /^cron\(|#|(^|[\s,])(\d*L|L-\d+|LW|\d*W|[a-z]{3}L)(?=$|[\s,])/i;
const CRON_ITEM = /^(?:\*|(\w+)(?:-(\w+))?)(?:\/(\d+))?$/;
interface CronField { name: string; low: number; high: number; days?: boolean; names?: string[] }
// `days`: a day field, which takes `?`. A weekday is 0 to 7, 0 and 7 both Sunday.
const CRON_FIELDS: CronField[] = [
  { name: 'minute', low: 0, high: 59 },
  { name: 'hour', low: 0, high: 23 },
  { name: 'day-of-month', low: 1, high: 31, days: true },
  { name: 'month', low: 1, high: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day-of-week', low: 0, high: 7, days: true, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
// The longest each month can be, from 1: a cron date only has to exist in some year.
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const absent = (value: unknown): value is undefined | null => value === undefined || value === null;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = (ms: number): string => new Date(ms).toISOString();
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

// Minutes after local midnight of an HH:MM on a 5-minute step, or null.
function minutesOf(text: unknown): number | null {
  const match = typeof text === 'string' ? HHMM.exec(text) : null;
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  return minutes % STEP === 0 ? minutes : null;
}

// A calendar date: Date.parse takes 2027-02-30 for March 2, so it must come back unchanged.
function isDate(text: unknown): boolean {
  const ms = typeof text === 'string' && DATE.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && iso(ms).startsWith(text as string);
}

// Local days are numbered from 1970-01-01, a Thursday; weekdays from 0 (mon).
const weekday = (day: number): number => (((day + 3) % 7) + 7) % 7;
const dateOf = (day: number): string => iso(day * DAY).slice(0, 10);
const dayOfDate = (text: string | null | undefined): number | null => (absent(text) ? null : Date.parse(text) / DAY);
const mondayOf = (day: number): number => day - weekday(day);
const monthOf = (date: Date): number => date.getUTCFullYear() * 12 + date.getUTCMonth();

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

// The zone's offset at a UTC midnight, read once per plan.
function midnightOffset(plan: Plan, day: number): number {
  let offset = plan.midnights.get(day);
  if (offset === undefined) plan.midnights.set(day, offset = offsetAt(day * DAY, plan.timeZone));
  return offset;
}

// The offset of a local day's every wall time when no clock change is near it (the day before to the day after), or
// null. Most days are like this, so a day costs one read of the zone however many occurrences it has.
function steadyOffset(plan: Plan, day: number): number | null {
  const before = midnightOffset(plan, day - 1);
  return before === midnightOffset(plan, day + 2) ? before : null;
}

// The instant of the local wall time `minutes` after midnight of local day `day`, past that day's end when it is over a
// day. A wall time a clock change skips is the first valid minute after it (the change itself); one it repeats is its
// first instance. A zone changes at most once within a day of any wall time.
function instantOf(plan: Plan, day: number, minutes: number): number {
  const { timeZone } = plan;
  const wall = day * DAY + minutes * MINUTE;
  const steady = steadyOffset(plan, Math.floor(wall / DAY));
  if (steady !== null) return wall - steady;
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

// The values of one cron field, or null when it does not read: `*`, a number, a range `a-b`, a step `*/s` or `a-b/s`, or
// a comma list of those. Names in any case. `?` is a whole day field. FRI-SUN runs up to the 7 that is Sunday.
function cronValues(text: string, { low, high, days, names }: CronField): Set<number> | null {
  const value = (word: string): number => {
    const named = names ? names.indexOf(word.toLowerCase()) : -1;
    if (named >= 0) return named + low;
    return /^\d+$/.test(word) ? Number(word) : NaN;
  };
  const values = new Set<number>();
  for (const item of (days && text === '?' ? '*' : text).split(',')) {
    const match = CRON_ITEM.exec(item);
    if (!match) return null;
    const [, first, last, step] = match;
    if (first && !last && step) return null;
    const from = first ? value(first) : low;
    let to = first ? value(last ?? first) : high;
    if (high === 7 && to === 0 && from > 0 && /^sun$/i.test(last ?? '')) to = 7;
    const by = step ? Number(step) : 1;
    if (!(from >= low && to <= high && from <= to && by >= 1)) return null;
    for (let v = from; v <= to; v += by) values.add(v);
  }
  return values;
}

interface ParsedCron { starts?: number[]; days?: Set<number>; months?: Set<number>; weekdays?: Set<number>; eitherDay?: boolean; problem?: string }

// A cron expression ready for arithmetic: its start minutes in a day, sorted, and its day fields; { problem } when refused.
function parseCron(text: unknown): ParsedCron {
  if (typeof text !== 'string') return { problem: CRON_WORDING };
  if (text.length > CRON_LENGTH_MAX) return { problem: `at most ${CRON_LENGTH_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x08\x0a-\x1f\x7f]/.test(text)) return { problem: 'one line, without control characters' };
  const fields = text.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS.length || CRON_FOREIGN.test(text.trim())) return { problem: CRON_WORDING };
  const values: Set<number>[] = [];
  for (const [i, field] of CRON_FIELDS.entries()) {
    const read = cronValues(fields[i]!, field);
    if (!read) {
      const { name, low, high, names } = field;
      return { problem: `the ${name} field takes *, a number from ${low} to ${high}${names ? ' or a name' : ''}, a range a-b, a step */s or a-b/s, or a comma list of those: ${fields[i]}` };
    }
    values.push(read);
  }
  const [minutes, hours, days, months, weekdays] = values as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if ([...minutes].some((m) => m % 5 !== 0)) return { problem: 'minutes must be multiples of 5, as schedule times are: * is every minute, */5 every five' };
  const open = (i: number) => fields[i] === '*' || fields[i] === '?';
  // Crontab's manual and its implementations disagree on whether */2 restricts a day field: refused beside the other one.
  const starred = (i: number) => fields[i]!.startsWith('*') && !open(i);
  if ((starred(2) && !open(4)) || (starred(4) && !open(2))) return { problem: 'a day field starting with * goes alone: cron versions read */2 with the other day field differently, so give a list or a range' };
  // A weekday comes in every month, so only a day of the month alone can never match.
  if (open(4) && ![...months].some((m) => [...days].some((d) => d <= MONTH_DAYS[m]!))) return { problem: 'never matches: no such date in that month' };
  return {
    starts: [...hours].flatMap((h) => [...minutes].map((m) => h * 60 + m)).sort((a, b) => a - b),
    days, months, weekdays: new Set([...weekdays].map((d) => d % 7)), eitherDay: !open(2) && !open(4),
  };
}

// As crontab: the month, and the day fields, either of them when both are restricted.
function cronMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.months!.has(date.getUTCMonth() + 1)) return false;
  const inMonth = cron.days!.has(date.getUTCDate());
  const inWeek = cron.weekdays!.has(date.getUTCDay());
  return cron.eitherDay ? inMonth || inWeek : inMonth && inWeek;
}

// The shortest time between two starts of a cron expression, in minutes (the last of a day to the first of the next
// included), or null when it does not read or starts once a day. An occurrence is a new id: a window starting this often
// applies again at each start.
export function cronShortestGap(text: unknown): number | null {
  const starts = parseCron(text).starts;
  if (!starts || starts.length < 2) return null;
  return Math.min(...starts.map((start, i) => (starts[i + 1] ?? starts[0]! + 1440) - start));
}

interface PlanWindow {
  window: number; kind: 'awake' | 'nap'; from: number | null; until: number | null; pattern: string; interval: number;
  days: Set<Day>; day?: number; nth?: number; weekday: number; cron: ParsedCron | null; starts: number[]; length: number; wake?: 'never' | 'header';
}
interface Written { all: Occurrence[]; awake: Occurrence[]; nap: Occurrence[] }
interface Plan { timeZone: string; exceptions: Set<string>; windows: PlanWindow[]; midnights: Map<number, number>; written: Map<number, Written>; joinMs: number; lookback: number; horizonDays: number }

// A window ready for arithmetic: plain days are a weekly pattern, and an occurrence is a start minute and a length in wall
// minutes, from `end` (up to 24 hours) or from a cron's `minutes`. Null for a pattern or a cron it cannot read, which has no
// occurrence on the router's side either, and for a time off the 5-minute step or an interval with nothing to count from: the
// router would still give those occurrences, but both refuse such a window at validation, so neither is ever stored.
function prepareWindow(w: ScheduleWindow, window: number): PlanWindow | null {
  const repeat = (w.repeat ?? { pattern: 'weekly', days: w.days }) as { pattern: string; interval?: number; days?: Day[]; day?: number; nth?: number; weekday?: Day; cron?: string; minutes?: number };
  const cron = repeat.pattern === 'cron' ? parseCron(repeat.cron) : null;
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  const interval = repeat.interval ?? 1;
  if (!PATTERNS.includes(repeat.pattern) || cron?.problem || (!cron && (start === null || end === null)) || (interval > 1 && absent(w.from))) return null;
  return {
    window, kind: w.kind, from: dayOfDate(w.from), until: dayOfDate(w.until), pattern: repeat.pattern, interval,
    days: new Set(repeat.days), day: repeat.day, nth: repeat.nth, weekday: DAYS.indexOf(repeat.weekday!), cron,
    starts: cron ? cron.starts! : [start!],
    length: cron ? Number(repeat.minutes) || 0 : (end! > start! ? end! - start! : end! - start! + 1440),
    ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}),
  };
}

// How many days before a day an occurrence of this length can have started and still run on that day.
const lookbackOf = (w: PlanWindow, join = 0): number => Math.max(1, Math.ceil((w.length + (join ? join + CLOCK_CHANGE_MINUTES : 0)) / 1440));

// A schedule's windows ready for arithmetic, or null when it has none (or a zone Intl does not know). A window prepareWindow
// gives nothing for is left out; the others keep their index. `joinMinutes`: the value its levels resolve to; without one, the
// schedule's own or the default.
function prepare(s: Schedule, { joinMinutes }: JoinOption = {}): Plan | null {
  if (!s?.timeZone || !s.windows?.length || !canonicalZone(s.timeZone)) return null;
  const windows = s.windows.flatMap((w, window) => prepareWindow(w, window) ?? []);
  const join = isJoinMinutes(joinMinutes) ? joinMinutes : isJoinMinutes(s.joinMinutes) ? s.joinMinutes : JOIN_DEFAULT_MINUTES;
  return {
    timeZone: s.timeZone,
    exceptions: new Set(s.exceptions ?? []),
    windows,
    midnights: new Map(),
    written: new Map(),
    joinMs: join * MINUTE,
    lookback: Math.max(1, ...windows.map((w) => lookbackOf(w, join))),
    horizonDays: s.windows.some((w) => !absent(w.repeat) || !absent(w.from)) ? REPEAT_HORIZON_DAYS : HORIZON_DAYS,
  };
}

// Whether a window's pattern has local day `day`. Counting an interval needs `from`, and `day` is never before it.
function patternHas(w: PlanWindow, day: number): boolean {
  if (w.pattern === 'weekly') return w.days.has(DAYS[weekday(day)]!) && (w.interval === 1 || (mondayOf(day) - mondayOf(w.from!)) % (7 * w.interval) === 0);
  if (w.pattern === 'daily') return w.interval === 1 || (day - w.from!) % w.interval === 0;
  const date = new Date(day * DAY);
  if (w.pattern === 'cron') return cronMatches(w.cron!, date);
  if (w.interval > 1 && (monthOf(date) - monthOf(new Date(w.from! * DAY))) % w.interval !== 0) return false;
  const inMonth = date.getUTCDate();
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (absent(w.nth)) return inMonth === Math.min(w.day!, monthEnd);
  return weekday(day) === w.weekday && (w.nth === -1 ? inMonth + 7 > monthEnd : Math.ceil(inMonth / 7) === w.nth);
}

const NO_STARTS: number[] = [];

// The start minutes of a window's occurrences on local day `day`: none outside its range or its pattern.
function startsOn(w: PlanWindow, day: number): number[] {
  if ((w.from !== null && day < w.from) || (w.until !== null && day > w.until)) return NO_STARTS;
  return patternHas(w, day) ? w.starts : NO_STARTS;
}

const byStart = (a: Occurrence, b: Occurrence): number => a.start - b.start;

// The occurrences of the windows that start on local day `day`, as written, once per plan: an occurrence ends at `end` the
// same day, the next day when `end` <= `start` (24 hours of wall time when equal), or `minutes` of wall time later. None on an
// exception date, and none that a clock change leaves empty. `all` in the windows' order, each kind by start.
function writtenOn(plan: Plan, day: number): Written {
  let written = plan.written.get(day);
  if (written) return written;
  const all: Occurrence[] = [];
  if (!plan.exceptions.has(dateOf(day))) {
    for (const w of plan.windows) {
      for (const minutes of startsOn(w, day)) {
        const start = instantOf(plan, day, minutes);
        const end = instantOf(plan, day, minutes + w.length);
        if (end > start) all.push({ kind: w.kind, window: w.window, start, end, ...(w.wake ? { wake: w.wake } : {}) });
      }
    }
  }
  written = { all, awake: all.filter((o) => o.kind === 'awake').sort(byStart), nap: all.filter((o) => o.kind === 'nap').sort(byStart) };
  plan.written.set(day, written);
  return written;
}

// The first start of a kind from `from` to `to`, both included, or null. Starts are in the order of their days. The
// offset at the UTC day's midnight gives the local day of `from` within a day either way, and a gap ends within two more.
function firstStart(plan: Plan, kind: Occurrence['kind'], from: number, to: number): number | null {
  const near = Math.floor((from + midnightOffset(plan, Math.floor(from / DAY))) / DAY);
  for (let day = near - 1; day <= near + 2; day++) {
    const starts = writtenOn(plan, day)[kind];
    let [lo, hi] = [0, starts.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]!.start < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo < starts.length) return starts[lo]!.start <= to ? starts[lo]!.start : null;
  }
  return null;
}

// Where an occurrence ends once joined: at the next start of its kind when the gap, in elapsed time, is within the value,
// unless the other kind starts in the gap. A start an exception date or a range removes is no start.
function joinedEnd(plan: Plan, o: Occurrence): number {
  const next = firstStart(plan, o.kind, o.end, o.end + plan.joinMs);
  if (next === null) return o.end;
  return firstStart(plan, o.kind === 'nap' ? 'awake' : 'nap', o.end, next - 1) === null ? next : o.end;
}

// The occurrences (of one window, when given) that start on local day `day`, joined. What handles overlapping windows of one
// kind then applies to the gap: the union's end, nextEvents, a nap's wake mode.
function occurrencesOn(plan: Plan, day: number, window?: number): Occurrence[] {
  const { all } = writtenOn(plan, day);
  const occurrences = window === undefined ? all : all.filter((o) => o.window === window);
  if (!plan.joinMs) return occurrences;
  return occurrences.map((o) => {
    const end = joinedEnd(plan, o);
    return end === o.end ? o : { ...o, end, joined: true };
  });
}

// The occurrences that overlap [from, to), exceptions applied, a local day at a time in order of start (then window): each
// window's own occurrences, joined, as the router computes them, not the union its occurrenceAt reports. A reader who has enough
// stops there, and the days after it cost nothing.
export function* occurrencesByDay(s: Schedule, from: number, to: number, join: JoinOption = {}): Generator<Occurrence[]> {
  const plan = prepare(s, join);
  if (!plan || !(from < to)) return;
  // An occurrence ends within its look back of the local day it starts on, so those of the days before the range's first
  // run into it; one more day each side covers a clock going back over midnight.
  for (let day = localDay(from, plan.timeZone) - plan.lookback - 1; day <= localDay(to, plan.timeZone) + 1; day++) {
    const found = occurrencesOn(plan, day).filter((o) => o.start < to && o.end > from);
    if (found.length) yield found.sort((a, b) => a.start - b.start || a.window - b.window);
  }
}

// Every occurrence that overlaps [from, to), in order of start (then window).
export function occurrencesIn(s: Schedule, from: number, to: number, join: JoinOption = {}): Occurrence[] {
  return [...occurrencesByDay(s, from, to, join)].flat().sort((a, b) => a.start - b.start || a.window - b.window);
}

// The next `count` occurrences that start after t, within 10 years of the later of t and the windows' from dates, exceptions
// applied: what the helper shows, so a recurrence can be checked before saving, however far ahead it starts. It stops as
// soon as it has them. `window`: those of this window alone, the schedule's others only joining it.
export function nextOccurrences(s: Schedule, t: number, count = 5, { window, ...join }: JoinOption & { window?: number } = {}): Occurrence[] {
  const plan = prepare(s, join);
  if (!plan?.windows.length) return [];
  const own = plan.windows.filter((w) => window === undefined || w.window === window);
  const first = Math.max(localDay(t, plan.timeZone), Math.min(...own.map((w) => w.from ?? -Infinity)));
  const found: Occurrence[] = [];
  for (let day = first; day <= first + PREVIEW_DAYS && found.length < count; day++) {
    if (own.some((w) => startsOn(w, day).length)) found.push(...occurrencesOn(plan, day, window).filter((o) => o.start > t));
  }
  return found.sort((a, b) => a.start - b.start || a.window - b.window).slice(0, count);
}

// Where the union of a kind's occurrences ends: an end that another occurrence of that kind holds (including one starting
// then) is not an end.
function unionEnds(occurrences: Occurrence[], kind: Occurrence['kind']): Set<number> {
  const ends = new Set<number>();
  let end = -Infinity;
  for (const o of occurrences.filter((n) => n.kind === kind).sort(byStart)) {
    if (o.start > end) ends.add(end);
    end = o.start > end ? o.end : Math.max(end, o.end);
  }
  return ends.add(end);
}

type Edge = { at: number; kind: NextEvent['kind']; window: number };

// The starts and ends of these occurrences after t and up to `last`, in order, each once.
function edgesOf(occurrences: Occurrence[], t: number, last: number): Edge[] {
  const ends = { awake: unionEnds(occurrences, 'awake'), nap: unionEnds(occurrences, 'nap') };
  const edges: Edge[] = [];
  for (const o of occurrences) {
    if (o.start > t && o.start <= last) edges.push({ at: o.start, kind: `${o.kind}-start`, window: o.window });
    if (o.end > t && o.end <= last && ends[o.kind].has(o.end)) edges.push({ at: o.end, kind: `${o.kind}-end`, window: o.window });
  }
  const rank = (e: Edge) => (e.kind.endsWith('-end') ? 0 : 1);
  return edges.sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.window - b.window)
    .filter((e, i, sorted) => i === 0 || e.at !== sorted[i - 1]!.at || e.kind !== sorted[i - 1]!.kind);
}

// The next `count` window starts and ends after t, within `horizonDays` (by default 8 days, 400 with a repeat or a from);
// at one instant, an end comes first. Windows of one kind count as their union, as in occurrenceAt: an end that another
// occurrence of that kind holds (including one starting then) is not an end, while each start stays (a new occurrence);
// identical events are the lowest window's. It reads day by day and stops once `count` events can no longer change.
export function nextEvents(s: Schedule, t: number, { count = 5, horizonDays, joinMinutes }: { count?: number; horizonDays?: number } & JoinOption = {}): NextEvent[] {
  const plan = prepare(s, { joinMinutes });
  if (!plan) return [];
  const shown = (edges: Edge[]): NextEvent[] => edges.slice(0, count).map((e) => ({ ...e, at: iso(e.at) }));
  const last = t + (horizonDays ?? plan.horizonDays) * DAY;
  const lastDay = localDay(last, plan.timeZone);
  const occurrences: Occurrence[] = [];
  // An occurrence gives at most 2 events; reading them again only once there are twice as many keeps this linear.
  let enough = count;
  for (let day = localDay(t, plan.timeZone) - plan.lookback; day <= lastDay; day++) {
    occurrences.push(...occurrencesOn(plan, day).filter((o) => o.end > t));
    if (day < lastDay && occurrences.length * 2 >= enough) {
      // What is still to come starts at the next midnight or later: nothing before it can move or be held.
      const settled = edgesOf(occurrences, t, Math.min(last, instantOf(plan, day + 1, 0) - 1));
      if (settled.length >= count) return shown(settled);
      enough = occurrences.length * 4;
    }
  }
  return shown(edgesOf(occurrences, t, last));
}

// The date YYYY-MM-DD at t in a zone.
export const localDate = (t: number, timeZone: string): string => dateOf(localDay(t, timeZone));

const isDayList = (days: unknown): boolean => Array.isArray(days) && !!days.length && new Set(days).size === days.length && days.every((d) => DAYS.includes(d));

function monthlyProblems({ day, nth, weekday: named }: Record<string, unknown>, prefix: string): string[] {
  if (absent(day) === absent(nth) || (!absent(day) && !absent(named))) return [`${prefix}: monthly takes day, or nth with weekday`];
  if (!absent(day)) return Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 31 ? [] : [`${prefix}.day: a whole number from 1 to 31`];
  return [
    ...(NTHS.includes(nth as number) ? [] : [`${prefix}.nth: 1, 2, 3, 4, or -1 for the last`]),
    ...(DAYS.includes(named as Day) ? [] : [`${prefix}.weekday: one of ${DAYS.join(', ')}`]),
  ];
}

// Own keys, so a parsed __proto__ or constructor key is caught too.
const unknownFields = (object: object, fields: string[], prefix: string): string[] => Object.keys(object).filter((k) => !fields.includes(k)).map((k) => `${prefix}${k}: unknown field`);

function repeatProblems(w: Record<string, unknown>, field: string): string[] {
  const prefix = `${field}.repeat`;
  const { repeat } = w;
  if (!isObject(repeat)) return [`${prefix}: an object with a pattern`];
  const { pattern, interval, days, minutes } = repeat;
  const fields = unknownFields(repeat, REPEAT_KNOWN, `${prefix}.`);
  if (!PATTERNS.includes(pattern as string)) return [`${prefix}.pattern: ${PATTERNS.slice(0, -1).join(', ')} or ${PATTERNS.at(-1)}`, ...fields];
  const problems = Object.keys(repeat).filter((k) => REPEAT_KNOWN.includes(k) && !REPEAT_FIELDS[pattern as string]!.includes(k) && !absent(repeat[k]))
    .map((k) => `${prefix}.${k}: not with the ${pattern} pattern`);
  if (pattern === 'cron') {
    const { problem } = parseCron(repeat.cron);
    if (problem) problems.push(`${prefix}.cron: ${problem}`);
    if (!(Number.isInteger(minutes) && (minutes as number) % 5 === 0 && (minutes as number) >= 5 && (minutes as number) <= CRON_MINUTES_MAX)) problems.push(`${prefix}.minutes: a multiple of 5 from 5 to ${CRON_MINUTES_MAX}`);
    return [...problems, ...fields];
  }
  if (!absent(interval) && !(Number.isInteger(interval) && (interval as number) >= 1 && (interval as number) <= INTERVAL_MAX)) problems.push(`${prefix}.interval: a whole number from 1 to ${INTERVAL_MAX}`);
  else if ((interval as number) > 1 && absent(w.from)) problems.push(`${field}.from: required when repeat.interval is above 1, it anchors the count`);
  if (pattern === 'weekly' && !isDayList(days)) problems.push(`${prefix}.days: one or more of ${DAYS.join(', ')}, each once`);
  if (pattern === 'monthly') problems.push(...monthlyProblems(repeat, prefix));
  return [...problems, ...fields];
}

// Why the router refuses a window, each problem naming its field, in its words: what the dialogs check before sending and
// the demo answers. Empty when it is valid. Overlaps between windows are the router's to tell.
export function windowProblems(window: ScheduleWindow, field = ''): string[] {
  const w: unknown = window;
  if (!isObject(w)) return [`${field}: an object with kind, days, start and end`];
  const problems: string[] = [];
  if (w.kind !== 'awake' && w.kind !== 'nap') problems.push(`${field}.kind: awake or nap`);
  if (!absent(w.repeat)) {
    if (!absent(w.days)) problems.push(`${field}.days: days or repeat, never both`);
    problems.push(...repeatProblems(w, field));
  } else if (!isDayList(w.days)) {
    problems.push(`${field}.days: one or more of ${DAYS.join(', ')}, each once`);
  }
  if (isObject(w.repeat) && w.repeat.pattern === 'cron') {
    if (!absent(w.start)) problems.push(`${field}.start: not with the cron pattern, repeat.minutes says how long`);
    if (!absent(w.end)) problems.push(`${field}.end: not with the cron pattern, repeat.minutes says how long`);
  } else {
    if (minutesOf(w.start) === null) problems.push(`${field}.start: HH:MM, minutes a multiple of 5`);
    if (minutesOf(w.end) === null) problems.push(`${field}.end: HH:MM, minutes a multiple of 5`);
  }
  if (!absent(w.wake)) {
    if (w.kind === 'awake') problems.push(`${field}.wake: nap windows only`);
    else if (!WAKES.includes(w.wake as string)) problems.push(`${field}.wake: never or header`);
  }
  if (!absent(w.from) && !isDate(w.from)) problems.push(`${field}.from: a date YYYY-MM-DD`);
  if (!absent(w.until) && !isDate(w.until)) problems.push(`${field}.until: a date YYYY-MM-DD`);
  else if (!absent(w.until) && isDate(w.from) && (w.until as string) < (w.from as string)) problems.push(`${field}.until: not before from`);
  return [...problems, ...unknownFields(w, WINDOW_FIELDS, `${field}.`)];
}

// A window's problems by field, its first for each: what a form shows under that field ("repeat.cron", "from").
export function fieldProblems(w: ScheduleWindow): Record<string, string> {
  const found: Record<string, string> = {};
  for (const problem of windowProblems(w, 'w')) {
    const [, name, why] = /^w\.?([^:]*): (.*)$/.exec(problem)!;
    found[name!] ??= why!;
  }
  return found;
}

// A window's problems in a form: the body's, and an end date chosen and left blank, which the body would drop as no end date.
export function editProblems(w: ScheduleWindow): Record<string, string> {
  const found = fieldProblems(windowBody(w));
  if (w.until === '') found.until ??= isOnce(w) ? 'choose a date' : 'choose a date, or No end date';
  return found;
}

// The offset of a drag in a zone's wall time, in minutes on the 5-minute step: the view may show another zone, and a day on the
// schedule's clock is a day whatever a clock change does to its instants.
export function wallOffset(from: number, to: number, timeZone: string): number {
  return Math.round(((to + offsetAt(to, timeZone)) - (from + offsetAt(from, timeZone))) / (STEP * MINUTE)) * STEP;
}

// The same window `minutes` of wall time later: the times shift, a start crossing midnight adds to a day offset, which rotates
// weekly days, moves from and until, and moves a monthly day or weekday. Null for a window with no start of its own (a cron).
function shifted(w: ScheduleWindow, minutes: number): ScheduleWindow | null {
  const [start, end] = [minutesOf(w.start), minutesOf(w.end)];
  if (w.repeat?.pattern === 'cron' || start === null || end === null) return null;
  const length = end > start ? end - start : end - start + 1440;
  const days = Math.floor((start + minutes) / 1440);
  const moved = start + minutes - days * 1440;
  const rotate = (list: Day[]) => DAYS.filter((d) => list.includes(DAYS[weekday(DAYS.indexOf(d) - days - 3)]!));
  const date = (text: string) => dateOf(dayOfDate(text)! + days);
  const repeat = w.repeat;
  return {
    ...w,
    start: hhmm(moved),
    end: hhmm((moved + length) % 1440),
    ...(w.days ? { days: rotate(w.days) } : {}),
    ...(w.from ? { from: date(w.from) } : {}),
    ...(w.until ? { until: date(w.until) } : {}),
    ...(repeat?.pattern === 'weekly' ? { repeat: { ...repeat, days: rotate(repeat.days) } } : {}),
    ...(repeat?.pattern === 'monthly' && !absent(repeat.day) ? { repeat: { ...repeat, day: repeat.day + days } } : {}),
    ...(repeat?.pattern === 'monthly' && !absent(repeat.nth) ? { repeat: { ...repeat, weekday: DAYS[weekday(DAYS.indexOf(repeat.weekday!) + days - 3)] } } : {}),
  } as ScheduleWindow;
}

// A window moved as a drag moves it: every occurrence by the same offset of wall time, or null when that cannot be said. Whether it
// can is checked, not assumed: the new window's starts from today (the exceptions aside: they stay on their dates) must be the old
// ones shifted. A monthly day past a month's end, a first weekday that becomes a second, a week counted from `from` do not.
export function moveWindow(w: ScheduleWindow, minutes: number, today: string): ScheduleWindow | null {
  const moved = shifted(w, minutes);
  if (!moved || windowProblems(windowBody(moved)).length) return null;
  const [before, after] = [prepareWindow(w, 0), prepareWindow(moved, 0)];
  if (!before || !after) return null;
  const days = Math.floor((before.starts[0]! + minutes) / 1440);
  const first = dayOfDate(today)!;
  const startsOf = (plan: PlanWindow, from: number) => {
    const found: number[] = [];
    for (let day = from; day <= from + PREVIEW_DAYS; day++) for (const start of startsOn(plan, day)) found.push(day * 1440 + start);
    return found;
  };
  const [old, fresh] = [startsOf(before, first).map((t) => t + minutes), startsOf(after, first + days)];
  return old.length === fresh.length && old.every((t, i) => t === fresh[i]) ? moved : null;
}

// A selection of the calendar (instants) as a weekly window in `timeZone`: the local weekday of its start, its times on
// that zone's clock rounded to the nearest 5 minutes (a tie rounds up; the weekday is the rounded start's). Its length
// is measured on that clock, so a day selected over a clock change stays 24 hours: exactly 24 hours is a 24-hour window
// (start = end), a local end on the next day an overnight one (end before start), and more than 24 hours is refused (a
// weekly window cannot hold it), as is a selection that a repeated hour makes end before it starts on that clock.
export function windowFromSelection(start: Date, end: Date, timeZone: string): { days: Day[]; start: string; end: string } | { problem: string } {
  if (!canonicalZone(timeZone)) return { problem: `Not a time zone: ${timeZone}` };
  const [from, to] = [start.getTime(), end.getTime()];
  if (!(from < to)) return { problem: 'Select a range that ends after it starts.' };
  // Minutes of the zone's clock since 1970-01-01 00:00, on the 5-minute step.
  const clock = (t: number): number => Math.round((t + offsetAt(t, timeZone)) / (STEP * MINUTE)) * STEP;
  const [a, b] = [clock(from), clock(to)];
  // Rounded, a range of 5 minutes or more is 5 minutes or more on the clock, unless a repeated hour turns it back.
  if (b < a || (b === a && to - from >= STEP * MINUTE)) {
    return { problem: `On the clock of ${timeZone}, this selection does not end after it starts (a clock change): select another range.` };
  }
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
