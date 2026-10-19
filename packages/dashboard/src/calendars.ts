// The Schedules calendar's data: the fixed palette, the enabled calendars kept in the browser (per user), the support of
// routers, and the events drawn from a workload's schedule. Pure apart from the storage helpers.
import { browserZone, type NextEvent, type Schedule } from './schedule';
import { occurrencesIn } from './occurrences';

export const MAX_CALENDARS = 20;
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
// outlined (its text readable on the theme's surface); a maximum nap's maintenance due time of an asleep workload is a short marker. The tooltip gives the times in the
// schedule's own zone when it is not the browser's.
export function eventsFor(calendars: Calendar[], from: number, to: number, here: string = browserZone(), dark = false): CalendarEvent[] {
  const surface = dark ? DARK_SURFACE : LIGHT_SURFACE;
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
        backgroundColor: nap ? 'transparent' : c.color, borderColor: c.color, textColor: nap ? readableOn(c.color, surface) : '#ffffff',
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
