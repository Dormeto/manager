// Schedules in the demo (R12): the PUT and DELETE routes validated as the router's words them (the main refusals, a window's
// all of them), a router before 0.36.0 not knowing recurrences, and the next events and maintenance date computed in the
// schedule's zone.
import { nextEvents as routerNextEvents, windowProblems } from '../occurrences';
import { JOIN_DEFAULT_MINUTES, JOIN_PROBLEM, canonicalZone, isJoinMinutes, type JoinAnswer, type NextEvent, type Schedule, type ScheduleView, type ScheduleWindow } from '../schedule';
import { audited, fail, knowsRecurrences, routerOf, workloadOf, type Demo, type DemoWorkload } from './state';
import { DAY, iso } from './util';

type Body = Record<string, unknown>;

// A router before 0.36.0 refuses the fields of a recurrence, as any field it does not know.
function unknownToOlder(s: Body): string[] {
  const windows = Array.isArray(s.windows) ? (s.windows as Body[]) : [];
  return [
    ...windows.flatMap((w, i) => ['repeat', 'from', 'until'].filter((f) => f in w).map((f) => `windows[${i}].${f}: unknown field`)),
    ...('joinMinutes' in s ? ['joinMinutes: unknown field'] : []),
  ];
}

function problems(s: Body): string[] {
  const out: string[] = [];
  const windows = Array.isArray(s.windows) ? (s.windows as Body[]) : null;
  if (!windows) return ['windows: an array'];
  if (windows.length > 20) out.push('windows: at most 20');
  if (windows.length && !canonicalZone(String(s.timeZone ?? ''))) out.push('timeZone: required when there are windows, an IANA time zone');
  windows.forEach((w, i) => out.push(...windowProblems(w as unknown as ScheduleWindow, `windows[${i}]`)));
  if (Array.isArray(s.exceptions) && s.exceptions.length > 100) out.push('exceptions: at most 100');
  if (s.maxNapDays !== undefined && !(Number.isInteger(s.maxNapDays) && (s.maxNapDays as number) >= 1 && (s.maxNapDays as number) <= 60)) out.push('maxNapDays: a whole number from 1 to 60');
  if (s.joinMinutes !== undefined && s.joinMinutes !== null && !isJoinMinutes(s.joinMinutes)) out.push(JOIN_PROBLEM);
  return out;
}

// The next window boundaries (the first 5), from the router's arithmetic.
export const nextEvents = (s: Schedule, now: number, joinMinutes = 0): NextEvent[] => routerNextEvents(s, now, { joinMinutes });

// The router's resolveJoin, in the words of its answers: the most specific level that sets a value, else the default.
export function joinLevelsOf({ workload, router, manager }: { workload?: unknown; router?: unknown; manager?: unknown }): { joinMinutes: number; joinFrom: 'workload' | 'router' | 'organization' | 'default' } {
  if (isJoinMinutes(workload)) return { joinMinutes: workload, joinFrom: 'workload' };
  if (isJoinMinutes(router)) return { joinMinutes: router, joinFrom: 'router' };
  if (isJoinMinutes(manager)) return { joinMinutes: manager, joinFrom: 'organization' };
  return { joinMinutes: JOIN_DEFAULT_MINUTES, joinFrom: 'default' };
}

// What a router of this release answers of joined windows, for a schedule or none; nothing on an older one, which does not join.
function joinAnswer(d: Demo, w: DemoWorkload): JoinAnswer {
  const router = routerOf(d, w.router);
  if (!knowsRecurrences(router.version)) return {};
  const levels = { router: router.joinMinutes, manager: router.readsManager ? d.hibernation.joinMinutes : null };
  return { ...joinLevelsOf({ workload: w.schedule?.joinMinutes, ...levels }), joinInherited: joinLevelsOf(levels) };
}

export function scheduleView(d: Demo, w: DemoWorkload, now: number): ScheduleView {
  const s = w.schedule;
  const join = joinAnswer(d, w);
  if (!s) return { schedule: null, next: [], maintenanceDue: null, ...join };
  const asleep = w.state === 'ASLEEP' || w.state === 'NAPPING';
  const since = w.entries.at(-1)?.at;
  const due = s.maxNapDays && asleep && since ? Date.parse(since) + s.maxNapDays * DAY : null;
  return { schedule: s, next: nextEvents(s, now, join.joinMinutes ?? 0), maintenanceDue: due ? iso(due) : null, ...join };
}

export function setSchedule(d: Demo, router: string, id: string, body: Body, now: number) {
  const w = workloadOf(d, router, id);
  const found = knowsRecurrences(routerOf(d, router).version) ? problems(body) : unknownToOlder(body);
  if (found.length) fail(400, 'bad_request', found.join('; '));
  return audited(d, 'schedule', `${router}/${id}`, () => {
    const timeZone = canonicalZone(String(body.timeZone ?? ''));
    w.schedule = { ...(body as unknown as Schedule), ...(timeZone ? { timeZone } : {}), by: d.me.email, at: iso(now) };
    return { result: `${w.schedule.windows?.length ?? 0} windows`, response: scheduleView(d, w, now) };
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
