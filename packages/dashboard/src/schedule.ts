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
export interface ScheduleWindow { kind: 'awake' | 'nap'; days?: Day[]; start?: string; end?: string; repeat?: Repeat; from?: string; until?: string; wake?: 'never' | 'header' }
export interface Schedule { timeZone: string; windows?: ScheduleWindow[]; exceptions?: string[]; maxNapDays?: number; by?: string; at?: string }
export interface NextEvent { at: string; kind: 'awake-start' | 'awake-end' | 'nap-start' | 'nap-end'; window: number }
export interface ScheduleView { schedule: Schedule | null; next: NextEvent[]; maintenanceDue: string | null }

export const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
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

// What a window repeats on: "Mon–Fri" as it always read, "Every 2 weeks on Mon, Thu", "Yearly on 25 Dec", "Cron 30 8 * * 1-5".
export function repeatText(w: ScheduleWindow): string {
  const { repeat } = w;
  if (!repeat) return daysText(w.days ?? []);
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
  if (w.from && w.until) return `from ${dateText(w.from)} to ${dateText(w.until)}`;
  if (w.from) return `from ${dateText(w.from)}, no end date`;
  return w.until ? `until ${dateText(w.until)}` : '';
}

// A recurrence in one sentence, as the helper says it back and the card reads it.
export function recurrenceText(w: ScheduleWindow): string {
  const text = [repeatText(w), hoursText(w), rangeText(w)].filter(Boolean).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
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
export type RepeatChoice = 'weekly' | 'daily' | 'monthly' | 'yearly' | 'cron';
export function repeatChoice(w: ScheduleWindow): RepeatChoice | null {
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
// itself (it goes when no longer needed, unlike one stored or chosen); and whether it filled in a pattern's day (which then
// follows the start date, until the user edits it).
export interface RepeatMemory {
  days: Day[];
  start: string;
  end: string;
  held: Partial<Record<RepeatChoice, Pick<ScheduleWindow, 'repeat' | 'days'>>>;
  filledFrom?: string;
  filledDay: Partial<Record<RepeatChoice, boolean>>;
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
  if (leaving) memory.held[leaving] = { ...(w.repeat ? { repeat: w.repeat } : {}), ...(w.days ? { days: w.days } : {}) };
  if (w.start) memory.start = w.start;
  if (w.end) memory.end = w.end;
  const { repeat, days, start = memory.start, end = memory.end, ...rest } = w;
  const times = choice === 'cron' ? {} : { start, end };
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
    case 'monthly': return settleFrom({ ...rest, ...times, repeat: { pattern: 'monthly', ...fill(w.from ?? today) } }, today, memory);
    case 'yearly': return settleFrom({ ...rest, ...times, repeat: { pattern: 'monthly', interval: 12, ...fill(w.from ?? today) } }, today, memory);
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
  };
}

// The body of the PUT: the zone in its canonical form (none without windows), the wake mode of nap windows only, the
// exceptions and the maximum nap only when set. `maxNap` is the form field (blank for none).
export function scheduleBody(s: Schedule, maxNap: string): Schedule {
  const windows = (s.windows ?? []).map(windowBody);
  const zone = canonicalZone(s.timeZone) ?? String(s.timeZone ?? '').trim();
  const max = maxNap.trim();
  return {
    ...(windows.length ? { timeZone: zone } : {}),
    windows,
    ...(s.exceptions?.length ? { exceptions: s.exceptions } : {}),
    ...(max ? { maxNapDays: Number(max) } : {}),
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

// The refusal of a router as it words it, with what it takes when it is a router before recurrences: it does not know their
// fields.
export function recurrenceError(message: string): string {
  return /\.(repeat|from|until): unknown field/.test(message) ? `${message.replace(/\.$/, '')}. Recurrences need router 0.36.0 or later.` : message;
}
