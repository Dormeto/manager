// Schedules (R12): awake and nap windows of a workload, on weekly days or by a recurrence within a range of dates (router
// 0.36.0), as the dashboard writes and reads them.
export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
// Yearly is not a pattern of its own: monthly, interval 12, its month given by `from`.
export type Repeat =
  | { pattern: 'daily'; interval?: number }
  | { pattern: 'weekly'; interval?: number; days: Day[] }
  | { pattern: 'monthly'; interval?: number; day?: number; nth?: number; weekday?: Day }
  | { pattern: 'cron'; cron: string; minutes: number };
// `days` or `repeat`, never both; `start` and `end` but with a cron repeat, whose `minutes` say how long.
// exceptions: the window's own dates without it (router 0.36.0); the schedule's skip every window.
export interface ScheduleWindow { kind: 'awake' | 'nap'; days?: Day[]; start?: string; end?: string; repeat?: Repeat; from?: string; until?: string; wake?: 'never' | 'header'; exceptions?: string[] }
// `joinMinutes`: the workload's own level of joined windows; null is the same as absent, 0 is kept.
export interface Schedule { timeZone: string; windows?: ScheduleWindow[]; exceptions?: string[]; maxNapDays?: number; joinMinutes?: number | null; by?: string; at?: string }
export interface NextEvent { at: string; kind: 'awake-start' | 'awake-end' | 'nap-start' | 'nap-end'; window: number }
// Joined windows (router 0.36.0): the value in force and its level, and what removing the workload's own would give.
export type JoinFrom = 'workload' | 'router' | 'organization' | 'default';
export interface JoinLevel { joinMinutes: number; joinFrom: JoinFrom }
export interface JoinAnswer { joinMinutes?: number; joinFrom?: JoinFrom; joinInherited?: JoinLevel }
export interface ScheduleView extends JoinAnswer { schedule: Schedule | null; next: NextEvent[]; maintenanceDue: string | null }

export const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Two occurrences of one kind with a gap of at most this count as one (schedule recurrence design, section 11).
export const JOIN_DEFAULT_MINUTES = 15;
export const JOIN_MINUTES_MAX = 120;
export const JOIN_PROBLEM = `joinMinutes: a whole number from 0 to ${JOIN_MINUTES_MAX}, a multiple of 5`;
// How long after its end a window stays in its schedule, the organization's (router 0.36.0): 0 keeps them, else 30 to 3650 days.
export const ENDED_DAYS_DEFAULT = 365;
export const ENDED_PROBLEM = 'endedWindowDays: 0 to keep them, or 30 to 3650 days';
export const isEndedDays = (value: unknown): value is number => Number.isInteger(value) && ((value as number) === 0 || ((value as number) >= 30 && (value as number) <= 3650));
export const isJoinMinutes = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= JOIN_MINUTES_MAX && (value as number) % 5 === 0;
const JOIN_FROM: Record<JoinFrom, string> = { workload: 'set on this workload', router: 'from the router', organization: 'from the organization', default: 'the default' };
// "15 min, from the organization".
export const joinText = ({ joinMinutes, joinFrom }: JoinLevel): string => `${joinMinutes} min, ${JOIN_FROM[joinFrom]}`;
// What a router inherits: the organization's as it last read it, else the default.
export const routerJoinInherited = (m: { joinMinutes?: number | null }): JoinLevel => (isJoinMinutes(m.joinMinutes) ? { joinMinutes: m.joinMinutes, joinFrom: 'organization' } : { joinMinutes: JOIN_DEFAULT_MINUTES, joinFrom: 'default' });
// The value a calendar and a helper compute with: the status answer's. A router that answers none does not join.
export const joinInForce = (answer: JoinAnswer | null | undefined): number => answer?.joinMinutes ?? 0;
const LABEL: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const dayLabel = (d: Day): string => LABEL[d];

// "Mon–Fri", "Mon, Wed, Fri", "Mon–Tue, Thu–Sat", "every day": runs of three or more days (or two, written with a comma
// so that "Sat, Sun" stays plain) are ranges.
export function daysText(days: Day[]): string {
  const set = DAYS.filter((d) => days.includes(d));
  if (set.length === 7) return 'every day';
  const runs: Day[][] = [];
  for (const d of set) {
    const last = runs.at(-1);
    if (last && DAYS.indexOf(last.at(-1)!) + 1 === DAYS.indexOf(d)) last.push(d);
    else runs.push([d]);
  }
  return runs.map((r) => (r.length >= 3 || (r.length === 2 && runs.length > 1) ? `${LABEL[r[0]!]}–${LABEL[r.at(-1)!]}` : r.map((d) => LABEL[d]).join(', '))).join(', ');
}

// "10 h 30 min", "45 min", "1 day 5 min".
export function durationText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return [days ? `${days} day${days > 1 ? 's' : ''}` : '', hours ? `${hours} h` : '', minutes % 60 ? `${minutes % 60} min` : ''].filter(Boolean).join(' ');
}

export function hoursText(w: ScheduleWindow): string {
  if (w.repeat?.pattern === 'cron') return durationText(w.repeat.minutes);
  if (w.start === '00:00' && w.end === '00:00') return 'all day (24 hours)';
  return `${w.start}–${w.end}${w.end! <= w.start! ? ' next day' : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NTHS: [number, string][] = [[1, 'first'], [2, 'second'], [3, 'third'], [4, 'fourth'], [-1, 'last']];
const nthWord = (nth: number | undefined): string => NTHS.find(([n]) => n === nth)?.[1] ?? '';
const monthOf = (date: string | undefined): string | undefined => MONTHS[Number(date?.slice(5, 7)) - 1];

// "4 Jan 2027", from a date YYYY-MM-DD.
export const dateText = (date: string): string => `${Number(date.slice(8, 10))} ${monthOf(date)} ${date.slice(0, 4)}`;

// A number in the words, none until there is one: a field being typed is blank.
const numberText = (n: number | undefined): string => (Number.isFinite(n) ? String(n) : '…');

// "Do not repeat" is a daily window of one date: `from` and `until` the same, interval 1. No field of its own, so any router since
// recurrences reads it, and a window of that shape reads as this whatever wrote it. A blank date while it is edited stays this.
export function isOnce(w: ScheduleWindow): boolean {
  const repeat = w.repeat as { pattern?: string; interval?: number } | null | undefined;
  return repeat?.pattern === 'daily' && (repeat.interval ?? 1) === 1 && typeof w.from === 'string' && w.from === w.until;
}

// What a window repeats on: "Mon–Fri" as it always read, "Every 2 weeks on Mon, Thu", "Yearly on 25 Dec", "Cron 30 8 * * 1-5".
export function repeatText(w: ScheduleWindow): string {
  const { repeat } = w;
  if (!repeat) return daysText(w.days ?? []);
  if (isOnce(w)) return w.from ? `Once on ${dateText(w.from)}` : 'Once';
  const every = (unit: string, once: string, interval = (repeat as { interval?: number }).interval ?? 1) => (interval === 1 ? once : `Every ${numberText(interval)} ${unit}`);
  switch (repeat.pattern) {
    case 'cron': return `Cron ${String(repeat.cron ?? '').trim().replace(/\s+/g, ' ')}`;
    case 'daily': return every('days', 'Every day');
    case 'weekly': {
      const days = daysText(repeat.days ?? []);
      if (days === 'every day') return every('weeks, every day', 'Every day');
      return `${every('weeks', 'Weekly')} on ${days}`;
    }
    case 'monthly': {
      const on = repeat.nth === undefined || repeat.nth === null ? `day ${numberText(repeat.day)}` : `the ${nthWord(repeat.nth)} ${repeat.weekday ? LABEL[repeat.weekday] : ''}`;
      const month = repeat.interval === 12 ? monthOf(w.from) : undefined;
      if (month) return repeat.nth === undefined || repeat.nth === null ? `Yearly on ${numberText(repeat.day)} ${month}` : `Yearly on ${on} of ${month}`;
      return `${every('months', 'Monthly')} on ${on}`;
    }
    default: return `Repeats by ${(repeat as { pattern: string }).pattern}`;
  }
}

// "from 4 Jan 2027, no end date", "until 30 Jun 2027", "from 4 Jan 2027 to 30 Jun 2027", nothing without a range.
export function rangeText(w: ScheduleWindow): string {
  if (isOnce(w)) return '';
  if (w.from && w.until) return `from ${dateText(w.from)} to ${dateText(w.until)}`;
  if (w.from) return `from ${dateText(w.from)}, no end date`;
  return w.until ? `until ${dateText(w.until)}` : '';
}

// A window's own dates without it, in date order, three at most: "except 4 Jan 2027 and 11 Jan 2027", "except 4 Jan 2027, 11 Jan
// 2027, 18 Jan 2027 and 2 more".
export function exceptText(w: ScheduleWindow): string {
  const dates = [...(w.exceptions ?? [])].sort().map(dateText);
  if (!dates.length) return '';
  const shown = dates.length > 3 ? [...dates.slice(0, 3), `${dates.length - 3} more`] : dates;
  return `except ${shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]}`;
}

// A recurrence in one sentence, as the helper says it back and the card reads it.
export function recurrenceText(w: ScheduleWindow): string {
  const text = [repeatText(w), hoursText(w), rangeText(w), exceptText(w)].filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A window in a few words, for its tab in the Schedule dialog: what it repeats on and its hours, without its range of dates.
export function windowTitle(w: ScheduleWindow): string {
  const text = [repeatText(w), hoursText(w)].filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// What a drag says it did: the whole window moved, in the sentence's words.
export function movedText(name: string, w: ScheduleWindow): string {
  return `Window moved: every occurrence of ${name} now runs ${recurrenceText(w).replace(/^(Every|Weekly|Monthly|Yearly|Once|Cron)\b/, (word) => word.toLowerCase())}`;
}

// "Mon 4 Jan 2027, 08:00–12:00", "Mon 4 Jan 2027, 20:00 – Tue 5 Jan, 07:00", in the schedule's own zone.
export function occurrenceText(o: { start: number; end: number }, timeZone: string): string {
  const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const [a, b] = [parts(o.start), parts(o.end)];
  const day = `${a.weekday} ${a.day} ${a.month}`;
  const end = `${b.weekday} ${b.day} ${b.month}`;
  return `${day} ${a.year}, ${a.hour}:${a.minute}${day === end ? '–' : ` – ${end}, `}${b.hour}:${b.minute}`;
}

const EVENTS: Record<NextEvent['kind'], string> = {
  'awake-start': 'awake window starts', 'awake-end': 'awake window ends', 'nap-start': 'nap window starts', 'nap-end': 'nap window ends',
};

// "Tue 20 Oct, 07:00 · nap window ends", in the schedule's own zone.
export function eventText(e: NextEvent, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(e.at)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} · ${EVENTS[e.kind]}`;
}

// The canonical form of a zone Intl accepts in any case ("europe/paris" is "Europe/Paris"), null when it knows none:
// the router and the dashboard then read the same name. Intl also takes UTC offsets (+01:00, -05:00), resolved with a
// leading sign: not zone names, and the router refuses them (UTC and Etc/GMT+5 are names).
export function canonicalZone(zone: string | null | undefined): string | null {
  const z = String(zone ?? '').trim();
  if (!z || /^[+-]/.test(z)) return null;
  try {
    const name = new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone;
    return /^[+-]/.test(name) ? null : name;
  } catch {
    return null;
  }
}

export const browserZone = (): string => canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';

export const TIMES: string[] = Array.from({ length: 288 }, (_, i) => `${String(Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`);

export const newWindow = (kind: 'awake' | 'nap' = 'awake'): ScheduleWindow => ({ kind, days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: kind === 'awake' ? '08:00' : '20:00', end: kind === 'awake' ? '19:00' : '07:00', ...(kind === 'nap' ? { wake: 'never' as const } : {}) });

// What the helper's Repeats select offers, and which of them a window is (null: a stored pattern this dashboard cannot read).
export type RepeatChoice = 'once' | 'weekly' | 'daily' | 'monthly' | 'yearly' | 'cron';
export function repeatChoice(w: ScheduleWindow): RepeatChoice | null {
  if (isOnce(w)) return 'once';
  const pattern: string = w.repeat?.pattern ?? 'weekly';
  if (pattern === 'monthly') return (w.repeat as { interval?: number }).interval === 12 ? 'yearly' : 'monthly';
  return ['weekly', 'daily', 'cron'].includes(pattern) ? pattern as RepeatChoice : null;
}

// How long a window from `start` to `end` lasts, in minutes: up to 24 hours.
const lengthOf = (start: string, end: string): number => {
  const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
  const [a, b] = [minutes(start), minutes(end)];
  return b > a ? b - a : b - a + 1440;
};

// What the helper remembers of a row while it is edited: per pattern what the row last held, the stored window included, so
// that a slip on the select loses nothing; the times and days for a pattern it has not held yet; the start date it filled in
// itself (it goes when no longer needed, unlike one stored or chosen); whether it filled in a pattern's day (which then follows
// the start date, until the user edits it); the date a Do not repeat starts on when a calendar selection gave one, and the range
// it took the place of.
export interface RepeatMemory {
  days: Day[];
  start: string;
  end: string;
  held: Partial<Record<RepeatChoice, Pick<ScheduleWindow, 'repeat' | 'days' | 'from' | 'until'>>>;
  filledFrom?: string;
  filledDay: Partial<Record<RepeatChoice, boolean>>;
  onceDate?: string;
  range?: Pick<ScheduleWindow, 'from' | 'until'>;
}
export const newMemory = (): RepeatMemory => ({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '19:00', held: {}, filledDay: {} });

// A window's start date settled with what it now repeats on: above 1 it needs one, today by default, and one the helper filled
// in goes when nothing counts from it. A number being typed (NaN) changes nothing yet.
function settleFrom(w: ScheduleWindow, today: string, memory: RepeatMemory): ScheduleWindow {
  const interval = (w.repeat as { interval?: number } | undefined)?.interval ?? 1;
  if (Number.isNaN(interval)) return w;
  if (interval > 1 && !w.from) {
    memory.filledFrom = today;
    return { ...w, from: today };
  }
  if (interval <= 1 && w.from && w.from === memory.filledFrom) {
    memory.filledFrom = undefined;
    const { from: _, ...rest } = w;
    return rest;
  }
  return w;
}

// A window moved to another pattern: its kind, wake and range stay, its times where the pattern has them, and what the row last
// held for that pattern comes back as it was. For one it has not held: a yearly window needs a start date, by default `today`,
// and takes its day from it; monthly and yearly keep the day or weekday of each other; a cron starts as the window did, on its
// days, for as long.
export function withChoice(w: ScheduleWindow, choice: RepeatChoice, today: string, memory: RepeatMemory): ScheduleWindow {
  const leaving = repeatChoice(w);
  if (leaving) memory.held[leaving] = { ...(w.repeat ? { repeat: w.repeat } : {}), ...(w.days ? { days: w.days } : {}), ...(leaving === 'once' ? { from: w.from!, until: w.until! } : {}) };
  if (w.start) memory.start = w.start;
  if (w.end) memory.end = w.end;
  const { repeat, days, start = memory.start, end = memory.end, from, until, ...others } = w;
  // Leaving a date: the range it took the place of, or that date as a start.
  const range: Pick<ScheduleWindow, 'from' | 'until'> = leaving === 'once' ? memory.range ?? (from ? { from } : {}) : { ...(from ? { from } : {}), ...(until !== undefined && until !== null ? { until } : {}) };
  const rest = { ...others, ...range };
  const times = choice === 'cron' ? {} : { start, end };
  if (choice === 'once') {
    memory.range = range;
    const date = memory.onceDate ?? range.from ?? today;
    return { ...others, ...times, repeat: { pattern: 'daily' }, from: date, until: date, ...memory.held.once };
  }
  if (leaving === 'once') memory.range = undefined;
  const held = memory.held[choice];
  if (held) return settleFrom({ ...rest, ...times, ...held }, today, memory);
  const weekly = repeat?.pattern === 'weekly' ? repeat.days : days;
  // Monthly and yearly keep the day or weekday they were on, and whether it was filled in.
  const onDay = repeat?.pattern === 'monthly' ? (repeat.nth ? { nth: repeat.nth, weekday: repeat.weekday } : { day: repeat.day }) : null;
  const fill = (date: string) => {
    memory.filledDay[choice] = onDay ? Boolean(leaving && memory.filledDay[leaving]) : true;
    return onDay ?? { day: Number(date.slice(8, 10)) };
  };
  switch (choice) {
    case 'weekly': return settleFrom({ ...rest, days: weekly ?? memory.days, ...times }, today, memory);
    case 'daily': return settleFrom({ ...rest, ...times, repeat: { pattern: 'daily' } }, today, memory);
    case 'monthly': return settleFrom({ ...rest, ...times, repeat: { pattern: 'monthly', ...fill(rest.from ?? today) } }, today, memory);
    case 'yearly': return settleFrom({ ...rest, ...times, repeat: { pattern: 'monthly', interval: 12, ...fill(rest.from ?? today) } }, today, memory);
    default: {
      const on = weekly?.length && weekly.length < 7 ? DAYS.filter((d) => weekly.includes(d)).map((d) => DAYS.indexOf(d) + 1).join(',') : '*';
      return settleFrom({ ...rest, repeat: { pattern: 'cron', cron: `${Number(start.slice(3, 5))} ${Number(start.slice(0, 2))} * * ${on}`, minutes: lengthOf(start, end) } }, today, memory);
    }
  }
}

// A window repeating every `interval` days, weeks or months: above 1 it needs a start date, today by default, and plain
// weekly days take a repeat for it; back at 1 they are plain days again and the start date the helper filled in goes, so that a
// router of any version reads it. NaN is what is being typed: refused, and kept so that the field stays blank.
export function withInterval(w: ScheduleWindow, interval: number, today: string, memory: RepeatMemory): ScheduleWindow {
  if (!w.repeat || w.repeat.pattern === 'weekly') {
    const { repeat, days, ...rest } = w;
    const chosen = repeat?.pattern === 'weekly' ? repeat.days : days ?? [];
    return settleFrom(interval === 1 ? { ...rest, days: chosen } : { ...rest, repeat: { pattern: 'weekly', interval, days: chosen } }, today, memory);
  }
  if (w.repeat.pattern === 'cron') return w;
  const { interval: _, ...repeat } = w.repeat as { interval?: number } & Repeat;
  return settleFrom({ ...w, repeat: { ...repeat, ...(interval === 1 ? {} : { interval }) } as Repeat }, today, memory);
}

// A start date the user chose (blank when cleared): one the helper had filled in is theirs now, and a day the helper filled in
// follows it, so that the first occurrence is on that date.
export function withFrom(w: ScheduleWindow, value: string, memory: RepeatMemory): ScheduleWindow {
  memory.filledFrom = undefined;
  const { from: _, ...rest } = w;
  if (!value) return rest;
  const choice = repeatChoice(w);
  const follows = choice && memory.filledDay[choice] && w.repeat?.pattern === 'monthly' && !w.repeat.nth;
  return { ...rest, from: value, ...(follows ? { repeat: { ...w.repeat, day: Number(value.slice(8, 10)) } as Repeat } : {}) };
}

// The date of a Do not repeat: both ends together.
export const withOnceDate = (w: ScheduleWindow, value: string): ScheduleWindow => ({ ...w, from: value, until: value });

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '';
const filled = <T extends object>(object: T): T => Object.fromEntries(Object.entries(object).filter(([, value]) => !isEmpty(value))) as T;

// A window as the PUT sends it: what is empty dropped (null, a date cleared), what its kind or pattern does not take too,
// its days in week order. A window read back stays what it was.
export function windowBody(w: ScheduleWindow): ScheduleWindow {
  const repeat = isEmpty(w.repeat) ? undefined : filled(w.repeat!);
  const weekOrder = (days: Day[]) => (Array.isArray(days) ? DAYS.filter((d) => days.includes(d)) : days);
  return {
    kind: w.kind,
    ...(repeat ? {} : { days: weekOrder(w.days ?? []) }),
    ...(repeat?.pattern === 'cron' ? {} : { start: w.start, end: w.end }),
    ...(repeat ? { repeat: repeat.pattern === 'weekly' ? { ...repeat, days: weekOrder(repeat.days) } : repeat } : {}),
    ...filled({ from: w.from, until: w.until }),
    ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}),
    ...(w.exceptions?.length ? { exceptions: [...w.exceptions] } : {}),
  };
}

// A schedule as it can be written back: a router that answers no joinInherited (rolled back) refuses a stored joinMinutes as
// unknown, on every save, and the field that could remove it is not offered.
export function writableSchedule(s: Schedule, answer: JoinAnswer | null | undefined): Schedule {
  if (answer?.joinInherited) return s;
  const { joinMinutes: _, ...rest } = s;
  return rest;
}

// The body of the PUT: the zone in its canonical form (none without windows), the wake mode of nap windows only, the
// exceptions, the maximum nap and the joined windows' value (0 is one) only when set, so that a schedule without them still
// reads on an older router. `maxNap` is the form field (blank for none).
export function scheduleBody(s: Schedule, maxNap: string): Schedule {
  const windows = (s.windows ?? []).map(windowBody);
  const zone = canonicalZone(s.timeZone) ?? String(s.timeZone ?? '').trim();
  const max = maxNap.trim();
  return {
    ...(windows.length ? { timeZone: zone } : {}),
    windows,
    ...(s.exceptions?.length ? { exceptions: s.exceptions } : {}),
    ...(max ? { maxNapDays: Number(max) } : {}),
    ...(isEmpty(s.joinMinutes) ? {} : { joinMinutes: s.joinMinutes }),
  } as Schedule;
}

// What the form refuses before sending, the schedule's own fields (windowProblems the windows', the router the rest, in its
// words).
export function formProblem(s: Schedule, maxNap: string): string {
  if (s.windows?.length && !canonicalZone(s.timeZone)) return 'timeZone: an IANA time zone name, such as Europe/Paris, not a UTC offset';
  const max = maxNap.trim();
  if (max && !(Number.isInteger(Number(max)) && Number(max) >= 1 && Number(max) <= 60)) return 'maxNapDays: a whole number from 1 to 60';
  if (!s.windows?.length && !max) return 'Add a window or set a maximum nap';
  return '';
}

// The refusal of a router as it words it, with what it takes when it is a router before recurrences or joined windows: it does
// not know their fields.
export function recurrenceError(message: string): string {
  if (/\.(repeat|from|until): unknown field/.test(message)) return `${message.replace(/\.$/, '')}. Recurrences need router 0.36.0 or later.`;
  return /(^|; )(joinMinutes: unknown field|settings: unknown setting joinMinutes)/.test(message) ? `${message.replace(/\.$/, '')}. Joined windows need router 0.36.0 or later.` : message;
}
