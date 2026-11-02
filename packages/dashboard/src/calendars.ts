// The Schedules calendar's data: the fixed palette, the enabled calendars kept in the browser (per user), the support of
// routers, and the events drawn from a workload's schedule. Pure apart from the storage helpers.
import { browserZone, recurrenceText, type NextEvent, type Schedule } from './schedule';
import { occurrencesByDay, type Occurrence } from './occurrences';

export const MAX_CALENDARS = 20;
// Workloads as the dashboard lists them: by name, whatever the case, w-2 before w-10.
export const naturalCompare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
export const MIN_ROUTER = '0.31.0';
export const NEEDS_ROUTER = `router ${MIN_ROUTER} needed`;

// Twelve distinct hues, each at least 4.5:1 against white (a fill with white text, an outline on the light theme).
export const PALETTE = ['#1a73e8', '#d93025', '#188038', '#a85500', '#9334e6', '#00838f', '#c2185b', '#5d4037', '#455a64', '#4e6b00', '#b34700', '#3949ab'] as const;
// The surfaces the outlined text sits on (the themes' cards).
const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACE = '#0d1422';

const channels = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// The WCAG contrast ratio of two #rrggbb colors.
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
// The color itself when it reads on the surface, else mixed toward white (dark surface) or black until it does.
export function readableOn(color: string, surface: string): string {
  const target = luminance(surface) < 0.5 ? 255 : 0;
  const base = channels(color);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const out = `#${base.map((v) => Math.round(v + (target - v) * t).toString(16).padStart(2, '0')).join('')}`;
    if (contrast(out, surface) >= 4.5) return out;
  }
  return target ? '#ffffff' : '#000000';
}
export const colorFor = (index: number): string => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
// The first palette slot no enabled calendar uses (past twelve, the slots repeat).
export function freeColor(used: number[]): number {
  for (let i = 0; i < PALETTE.length; i++) if (!used.includes(i)) return i;
  return used.length;
}

export const calendarKey = (router: string, id: string): string => `${router}/${id}`;

// A router's version "0.31.0" or "0.31.0-dev.1": at least 0.31.0 (a pre-release counts as its release). Unknown: supported
// (the workload's own answer then says whether it has a schedule).
export function supportsSchedules(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return true;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a !== 0 ? a > 0 : b !== 31 ? b > 31 : c >= 0;
}

export interface Enabled { key: string; color: number }
export interface Saved { enabled: Enabled[]; last?: string; view?: string }

const storageKey = (userId: string) => `dm-schedules:${userId || 'anonymous'}`;
export function loadSaved(userId: string): Saved {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? 'null') as Partial<Saved> | null;
    const enabled = (Array.isArray(raw?.enabled) ? raw!.enabled : []).filter((e): e is Enabled => typeof e?.key === 'string' && Number.isInteger(e.color)).slice(0, MAX_CALENDARS);
    return { enabled, ...(typeof raw?.last === 'string' ? { last: raw.last } : {}), ...(typeof raw?.view === 'string' ? { view: raw.view } : {}) };
  } catch {
    return { enabled: [] };
  }
}
export function saveSaved(userId: string, saved: Saved): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(saved));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

export interface Calendar {
  key: string;
  name: string;
  color: string;
  schedule: Schedule | null;
  state?: string;
  maintenanceDue?: string | null;
  next?: NextEvent[];
  // Whether the user may edit it: only then can its windows be dragged.
  canEdit?: boolean;
  // The value of joined windows in force, from the status answer. None: 0, a router that does not join.
  joinMinutes?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  classNames: string[];
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  startEditable: boolean;
  durationEditable: boolean;
  // tip: the tooltip's lines, read only when it opens (a view can draw 24,000 items).
  // windows: the windows a bar holds (a gap that joins), which a drag changes.
  extendedProps: { key: string; kind: 'awake' | 'nap' | 'maintenance'; window?: number; windows?: number[]; tip: () => string[] };
}

// One formatter a zone: a frequent cron window has thousands of occurrences on a month.
const clocks = new Map<string, Intl.DateTimeFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
const clock = (t: number, timeZone: string, day = true) => {
  const key = `${timeZone} ${day}`;
  let f = clocks.get(key);
  if (!f) clocks.set(key, f = new Intl.DateTimeFormat('en-GB', { timeZone, ...(day ? { weekday: 'short' as const } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return f.format(new Date(t)).replace(',', '');
};

// An occurrence's times in a zone, "Wed 20:00–07:00", and the dates too when it runs past a day: "Sun 3 Jan 08:00–Mon 11 Jan 08:00".
const FULL_DAY = 25 * 3_600_000;
function spanText(o: Occurrence, timeZone: string): string {
  if (o.end - o.start <= FULL_DAY) return `${clock(o.start, timeZone)}–${clock(o.end, timeZone, false)}`;
  let f = dates.get(timeZone);
  if (!f) dates.set(timeZone, f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const full = (t: number) => f!.format(new Date(t)).replace(/,/g, '');
  return `${full(o.start)}–${full(o.end)}`;
}

const CAN_DRAG = 'Drag it, or its top or bottom edge, to change this occurrence or the whole series.';
const READ_ONLY = 'You may not edit this workload: it can\'t be dragged.';

// What the calendar draws of one workload in a view. In a month view it puts every event in the page, hidden or not, about 0.1 s
// for each 1,000 (the demo in Edge: 1,008 in 0.13 s, 5,040 in 0.5 s, 20,160 in 1.9 to 2.3 s, 30,240 in 2.6 to 4.4 s, 120,960 in
// 10 to 30 s). 1,200 leaves room for the largest plain schedule (20 windows on each of a month view's 42 days: 840) and an hourly
// cron window (1,008), and 20 calendars at the most stay near 2 s.
export const CALENDAR_EVENTS_MAX = 1200;

// A bar: its occurrences as one, with the windows they are of, the first's above all.
// members: the occurrences it draws, each its window and start.
type Bar = Occurrence & { windows: Set<number>; members: { window: number; start: number }[] };

// The bars of a schedule in [from, to), the first CALENDAR_EVENTS_MAX, and whether there are more. Occurrences of a cron window
// that touch or overlap are one bar: every 5 minutes for 5 minutes draws the hours it holds, not a tile for each start. So is a
// gap that joins, across two windows too, and its wake is never when either says so, as the router's union. Others stay one a
// day, as they always were. It reads no further than it draws.
function barsOf(s: Schedule, from: number, to: number, joinMinutes: number): { bars: Bar[]; more: boolean } {
  const windows = s.windows ?? [];
  const bars: Bar[] = [];
  const last = new Map<number, Bar>();
  // The bars whose joined end waits for a start of their kind.
  const joining = new Map<string, Bar>();
  const reaching = (o: Occurrence) => `${o.kind} ${o.end}`;
  for (const day of occurrencesByDay(s, from, to, { joinMinutes })) {
    for (const o of day) {
      const touched = windows[o.window]?.repeat?.pattern === 'cron' ? last.get(o.window) : undefined;
      const started = `${o.kind} ${o.start}`;
      const bar = joining.get(started) ?? (touched && o.start <= touched.end ? touched : undefined);
      if (bar) {
        joining.delete(started);
        bar.end = Math.max(bar.end, o.end);
        bar.windows.add(o.window);
        bar.members.push({ window: o.window, start: o.start });
        if (o.wake === 'never') bar.wake = 'never';
        if (o.joined) { bar.joined = true; joining.set(reaching(o), bar); }
        last.set(o.window, bar);
        continue;
      }
      const copy = { ...o, windows: new Set([o.window]), members: [{ window: o.window, start: o.start }] };
      if (o.joined) joining.set(reaching(o), copy);
      last.set(o.window, copy);
      bars.push(copy);
    }
    if (bars.length > CALENDAR_EVENTS_MAX) return { bars: bars.slice(0, CALENDAR_EVENTS_MAX), more: true };
  }
  return { bars, more: false };
}

// The occurrences the bar drawn from `start` to `end` with `window` holds, as the calendar chained them (a gap that joins, a cron's
// that touch): what a drag of it changes. Another bar of the same windows starting inside it is not one of them.
export function barMembers(s: Schedule, joinMinutes: number, start: number, end: number, window: number): { window: number; start: number }[] {
  return barsOf(s, start, end, joinMinutes).bars.find((b) => b.start === start && b.windows.has(window))?.members ?? [];
}

export interface Capped { key: string; name: string; until: Date }

// What the calendars leave out of a view, for a note: "Blog: only the first 1,200 occurrences are drawn, up to 8 Jan".
export function cappedText(capped: Capped[], here: string = browserZone()): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: here, day: 'numeric', month: 'short' });
  const names = capped.map((c) => `${c.name}: only the first ${CALENDAR_EVENTS_MAX.toLocaleString('en-US')} occurrences are drawn here, up to ${day.format(c.until)}`);
  return `${names.join('; ')}. Too many to draw, and the schedule applies in full.`;
}

// The events of the calendars in [from, to): a window's occurrence is "<workload> · Awake" filled, or "· Nap (wake: header)"
// outlined (its text readable on the theme's surface); a maximum nap's maintenance due time of an asleep workload is a short marker. The tooltip gives the times in the
// schedule's own zone when it is not the browser's, and the recurrence in its words. An occurrence that ended before `now` carries `dm-past` (drawn dimmed).
export function calendarEvents(calendars: Calendar[], from: number, to: number, here: string = browserZone(), dark = false, now: number = Date.now()): { events: CalendarEvent[]; capped: Capped[] } {
  const surface = dark ? DARK_SURFACE : LIGHT_SURFACE;
  const out: CalendarEvent[] = [];
  const capped: Capped[] = [];
  for (const c of calendars) {
    const s = c.schedule;
    if (!s) continue;
    const windows = s.windows ?? [];
    const { bars, more } = barsOf(s, from, to, c.joinMinutes ?? 0);
    if (more) capped.push({ key: c.key, name: c.name, until: new Date(bars.at(-1)!.start) });
    for (const o of bars) {
      const nap = o.kind === 'nap';
      const label = nap ? `Nap${o.wake === 'header' ? ' (wake: header)' : ''}` : 'Awake';
      const title = `${c.name} · ${label}`;
      const w = windows[o.window]!;
      const tip = () => [
        title, recurrenceText(w), ...[...o.windows].filter((i) => i !== o.window).map((i) => recurrenceText(windows[i]!)),
        `${spanText(o, here)}${s.timeZone && s.timeZone !== here ? ` here, ${spanText(o, s.timeZone)} ${s.timeZone}` : ''}`,
        ...(o.joined ? [`Windows of one kind up to ${c.joinMinutes} min apart read as one.`] : []),
        c.canEdit ? CAN_DRAG : READ_ONLY,
      ];
      out.push({
        id: `${c.key}#${o.window}@${o.start}`, title, start: new Date(o.start), end: new Date(o.end),
        classNames: ['dm-ev', nap ? 'dm-ev--nap' : 'dm-ev--awake', ...(o.end < now ? ['dm-past'] : [])],
        backgroundColor: nap ? 'transparent' : c.color, borderColor: c.color, textColor: nap ? readableOn(c.color, surface) : '#ffffff',
        startEditable: Boolean(c.canEdit), durationEditable: Boolean(c.canEdit),
        extendedProps: { key: c.key, kind: o.kind, window: o.window, windows: [...o.windows].sort((a, b) => a - b), tip },
      });
    }
    const due = c.maintenanceDue ? Date.parse(c.maintenanceDue) : NaN;
    if (s.maxNapDays && c.state === 'ASLEEP' && due >= from && due < to) {
      const tip = `${c.name} · maintenance due (the maximum nap of ${s.maxNapDays} days)${s.timeZone && s.timeZone !== here ? ` — ${clock(due, s.timeZone)} ${s.timeZone}` : ''}`;
      out.push({
        id: `${c.key}#maintenance`, title: `${c.name} · maintenance due`, start: new Date(due), end: new Date(due + 15 * 60_000),
        classNames: ['dm-ev', 'dm-ev--maintenance'], backgroundColor: c.color, borderColor: c.color, textColor: '#ffffff',
        startEditable: false, durationEditable: false,
        extendedProps: { key: c.key, kind: 'maintenance', tip: () => [tip] },
      });
    }
  }
  return { events: out, capped };
}

export const eventsFor = (...args: Parameters<typeof calendarEvents>): CalendarEvent[] => calendarEvents(...args).events;

// A workload as the calendars panel lists it.
export interface PanelRow { key: string; id: string; router: string; name: string; scheduled?: boolean; supported: boolean; locked: boolean }
export type CalendarStatus = 'loading' | 'ok' | 'failed' | 'unsupported';
