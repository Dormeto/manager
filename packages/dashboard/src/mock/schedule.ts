// Schedules in the demo (R12): the PUT and DELETE routes validated as the router's words them (the main refusals, a window's
// all of them), a router before 0.36.0 not knowing recurrences, and the next events and maintenance date computed in the
// schedule's zone.
import { nextEvents as routerNextEvents, windowProblems } from '../occurrences';
import { canonicalZone, type NextEvent, type Schedule, type ScheduleView, type ScheduleWindow } from '../schedule';
import { audited, fail, routerOf, workloadOf, type Demo, type DemoWorkload } from './state';
import { DAY, iso } from './util';

type Body = Record<string, unknown>;

// A router before 0.36.0 refuses the fields of a recurrence, as any field it does not know.
function unknownToOlder(s: Body): string[] {
  const windows = Array.isArray(s.windows) ? (s.windows as Body[]) : [];
  return windows.flatMap((w, i) => ['repeat', 'from', 'until'].filter((f) => f in w).map((f) => `windows[${i}].${f}: unknown field`));
}
const knowsRecurrences = (version: string): boolean => {
  const [major, minor] = version.split('.').map(Number);
  return major! > 0 || minor! >= 36;
};

function problems(s: Body): string[] {
  const out: string[] = [];
  const windows = Array.isArray(s.windows) ? (s.windows as Body[]) : null;
  if (!windows) return ['windows: an array'];
  if (windows.length > 20) out.push('windows: at most 20');
  if (windows.length && !canonicalZone(String(s.timeZone ?? ''))) out.push('timeZone: required when there are windows, an IANA time zone');
  windows.forEach((w, i) => out.push(...windowProblems(w as unknown as ScheduleWindow, `windows[${i}]`)));
  if (Array.isArray(s.exceptions) && s.exceptions.length > 100) out.push('exceptions: at most 100');
  if (s.maxNapDays !== undefined && !(Number.isInteger(s.maxNapDays) && (s.maxNapDays as number) >= 1 && (s.maxNapDays as number) <= 60)) out.push('maxNapDays: a whole number from 1 to 60');
  return out;
}

// The next window boundaries (the first 5), from the router's arithmetic.
export const nextEvents = (s: Schedule, now: number): NextEvent[] => routerNextEvents(s, now);

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
  const found = knowsRecurrences(routerOf(d, router).version) ? problems(body) : unknownToOlder(body);
  if (found.length) fail(400, 'bad_request', found.join('; '));
  return audited(d, 'schedule', `${router}/${id}`, () => {
    const timeZone = canonicalZone(String(body.timeZone ?? ''));
    w.schedule = { ...(body as unknown as Schedule), ...(timeZone ? { timeZone } : {}), by: d.me.email, at: iso(now) };
    return { result: `${w.schedule.windows?.length ?? 0} windows`, response: scheduleView(w, now) };
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
