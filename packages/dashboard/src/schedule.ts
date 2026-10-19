// Schedules (R12): weekly awake and nap windows of a workload, as the dashboard writes and reads them.
export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface ScheduleWindow { kind: 'awake' | 'nap'; days: Day[]; start: string; end: string; wake?: 'never' | 'header' }
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

export function hoursText(w: ScheduleWindow): string {
  if (w.start === w.end) return 'all day (24 hours)';
  return `${w.start}–${w.end}${w.end < w.start ? ' next day' : ''}`;
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

// The body of the PUT: the zone in its canonical form (none without windows), the wake mode of nap windows only, the
// exceptions and the maximum nap only when set. `maxNap` is the form field (blank for none).
export function scheduleBody(s: Schedule, maxNap: string): Schedule {
  const windows = (s.windows ?? []).map((w) => ({ kind: w.kind, days: DAYS.filter((d) => w.days.includes(d)), start: w.start, end: w.end, ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}) }));
  const zone = canonicalZone(s.timeZone) ?? String(s.timeZone ?? '').trim();
  const max = maxNap.trim();
  return {
    ...(windows.length ? { timeZone: zone } : {}),
    windows,
    ...(s.exceptions?.length ? { exceptions: s.exceptions } : {}),
    ...(max ? { maxNapDays: Number(max) } : {}),
  } as Schedule;
}

// What the form refuses before sending (the router refuses the rest, in its words).
export function formProblem(s: Schedule, maxNap: string): string {
  if (s.windows?.length && !canonicalZone(s.timeZone)) return 'timeZone: an IANA time zone name, such as Europe/Paris, not a UTC offset';
  const empty = (s.windows ?? []).findIndex((w) => !w.days.length);
  if (empty >= 0) return `windows[${empty}].days: pick at least one day`;
  const max = maxNap.trim();
  if (max && !(Number.isInteger(Number(max)) && Number(max) >= 1 && Number(max) <= 60)) return 'maxNapDays: a whole number from 1 to 60';
  if (!s.windows?.length && !max) return 'Add a window or set a maximum nap';
  return '';
}
