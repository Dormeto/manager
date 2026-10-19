// The Schedules calendar's data: the fixed palette, the enabled calendars kept in the browser (per user), the support of
// routers, and the events drawn from a workload's schedule. Pure apart from the storage helpers.
import { browserZone, type NextEvent, type Schedule } from './schedule';
import { occurrencesIn } from './occurrences';

export const MAX_CALENDARS = 20;
export const MIN_ROUTER = '0.31.0';
export const NEEDS_ROUTER = `router ${MIN_ROUTER} needed`;

// Twelve distinct hues, readable as a fill with white text and as an outline on both themes.
export const PALETTE = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#00838f', '#c2185b', '#5d4037', '#455a64', '#6a8b00', '#e8710a', '#3949ab'] as const;
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
  extendedProps: { key: string; kind: 'awake' | 'nap' | 'maintenance'; window?: number; tip: string };
}

const clock = (t: number, timeZone: string, day = true) => new Intl.DateTimeFormat('en-GB', { timeZone, ...(day ? { weekday: 'short' as const } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)).replace(',', '');

// The events of the calendars in [from, to): a window's occurrence is "<workload> · Awake" filled, or "· Nap (wake: header)"
// outlined; a maximum nap's maintenance due time of an asleep workload is a short marker. The tooltip gives the times in the
// schedule's own zone when it is not the browser's.
export function eventsFor(calendars: Calendar[], from: number, to: number, here: string = browserZone()): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const c of calendars) {
    const s = c.schedule;
    if (!s) continue;
    for (const o of occurrencesIn(s, from, to)) {
      const nap = o.kind === 'nap';
      const label = nap ? `Nap${o.wake === 'header' ? ' (wake: header)' : ''}` : 'Awake';
      const title = `${c.name} · ${label}`;
      const there = s.timeZone && s.timeZone !== here ? ` — ${clock(o.start, s.timeZone)}–${clock(o.end, s.timeZone, false)} ${s.timeZone}` : '';
      out.push({
        id: `${c.key}#${o.window}@${o.start}`, title, start: new Date(o.start), end: new Date(o.end),
        classNames: ['dm-ev', nap ? 'dm-ev--nap' : 'dm-ev--awake'],
        backgroundColor: nap ? 'transparent' : c.color, borderColor: c.color, textColor: nap ? c.color : '#ffffff',
        extendedProps: { key: c.key, kind: o.kind, window: o.window, tip: `${title}${there}` },
      });
    }
    const due = c.maintenanceDue ? Date.parse(c.maintenanceDue) : NaN;
    if (s.maxNapDays && c.state === 'ASLEEP' && due >= from && due < to) {
      const tip = `${c.name} · maintenance due (the maximum nap of ${s.maxNapDays} days)${s.timeZone && s.timeZone !== here ? ` — ${clock(due, s.timeZone)} ${s.timeZone}` : ''}`;
      out.push({
        id: `${c.key}#maintenance`, title: `${c.name} · maintenance due`, start: new Date(due), end: new Date(due + 15 * 60_000),
        classNames: ['dm-ev', 'dm-ev--maintenance'], backgroundColor: c.color, borderColor: c.color, textColor: '#ffffff',
        extendedProps: { key: c.key, kind: 'maintenance', tip },
      });
    }
  }
  return out;
}

// A workload as the calendars panel lists it.
export interface PanelRow { key: string; id: string; router: string; name: string; scheduled?: boolean; supported: boolean; locked: boolean }
export type CalendarStatus = 'loading' | 'ok' | 'failed' | 'unsupported';
