// Schedules in the demo (R12): the PUT and DELETE routes validated as the router's words them (the main refusals), and the
// next events and maintenance date computed in the schedule's zone.
import { DAYS, TIMES, canonicalZone, type NextEvent, type Schedule, type ScheduleView } from '../schedule';
import { audited, fail, workloadOf, type Demo, type DemoWorkload } from './state';
import { DAY, iso } from './util';

type Body = Record<string, unknown>;

function problems(s: Body): string[] {
  const out: string[] = [];
  const windows = Array.isArray(s.windows) ? (s.windows as Body[]) : null;
  if (!windows) return ['windows: an array'];
  if (windows.length > 20) out.push('windows: at most 20');
  if (windows.length && !canonicalZone(String(s.timeZone ?? ''))) out.push('timeZone: required when there are windows, an IANA time zone');
  windows.forEach((w, i) => {
    if (w.kind !== 'awake' && w.kind !== 'nap') out.push(`windows[${i}].kind: awake or nap`);
    if (!Array.isArray(w.days) || !w.days.length || !w.days.every((d) => DAYS.includes(d as never))) out.push(`windows[${i}].days: a non-empty set of mon…sun`);
    for (const f of ['start', 'end'] as const) if (!TIMES.includes(String(w[f]))) out.push(`windows[${i}].${f}: HH:MM, minutes a multiple of 5`);
  });
  if (Array.isArray(s.exceptions) && s.exceptions.length > 100) out.push('exceptions: at most 100');
  if (s.maxNapDays !== undefined && !(Number.isInteger(s.maxNapDays) && (s.maxNapDays as number) >= 1 && (s.maxNapDays as number) <= 60)) out.push('maxNapDays: a whole number from 1 to 60');
  return out;
}

// The zone's offset from UTC at a moment, in milliseconds.
function offset(zone: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

// The window boundaries of the next 8 days (the first 5), the local times read in the schedule's zone.
export function nextEvents(s: Schedule, now: number): NextEvent[] {
  if (!s.windows.length) return [];
  const events: (NextEvent & { t: number })[] = [];
  const [y, mo, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: s.timeZone }).format(new Date(now)).split('-').map(Number);
  const today = Date.UTC(y!, mo! - 1, dd!);
  const local = (day: number, hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const guess = day + h! * 3_600_000 + m! * 60_000;
    return guess - offset(s.timeZone, guess - offset(s.timeZone, guess));
  };
  s.windows.forEach((w, i) => {
    for (let k = -1; k <= 8; k++) {
      const day = today + k * DAY;
      if (!w.days.includes(DAYS[(new Date(day).getUTCDay() + 6) % 7]!)) continue;
      if (s.exceptions?.includes(new Date(day).toISOString().slice(0, 10))) continue;
      const start = local(day, w.start);
      const end = w.end <= w.start ? local(day + DAY, w.end) : local(day, w.end);
      for (const [t, kind] of [[start, `${w.kind}-start`], [end, `${w.kind}-end`]] as const) {
        if (t > now && t <= now + 8 * DAY) events.push({ t, at: iso(t), kind, window: i });
      }
    }
  });
  return events.sort((a, b) => a.t - b.t).slice(0, 5).map(({ at, kind, window }) => ({ at, kind, window }));
}

export function scheduleView(w: DemoWorkload, now: number): ScheduleView {
  const s = w.schedule;
  if (!s) return { schedule: null, next: [], maintenanceDue: null };
  const asleep = w.state === 'ASLEEP' || w.state === 'NAPPING';
  const since = w.entries.at(-1)?.at;
  const due = s.maxNapDays && asleep && since ? Date.parse(since) + s.maxNapDays * DAY : null;
  return { schedule: s, next: nextEvents(s, now), maintenanceDue: due ? iso(due) : null };
}

export function setSchedule(d: Demo, router: string, id: string, body: Body, now: number) {
  const w = workloadOf(d, router, id);
  const found = problems(body);
  if (found.length) fail(400, 'bad_request', found.join('; '));
  return audited(d, 'schedule', `${router}/${id}`, () => {
    const timeZone = canonicalZone(String(body.timeZone ?? ''));
    w.schedule = { ...(body as unknown as Schedule), ...(timeZone ? { timeZone } : {}), by: d.me.email, at: iso(now) };
    return { result: `${w.schedule.windows.length} windows`, response: scheduleView(w, now) };
  });
}

export function clearSchedule(d: Demo, router: string, id: string) {
  const w = workloadOf(d, router, id);
  return audited(d, 'schedule-clear', `${router}/${id}`, () => {
    const cleared = w.schedule !== null;
    w.schedule = null;
    return { result: cleared ? 'cleared' : 'none', response: { cleared } };
  });
}
