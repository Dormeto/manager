// What a drag or a resize on the Schedules calendar does to a schedule (the user, 2026-11-02): an item moved, or its start or end
// dragged, changes the whole series or this occurrence alone. Alone, its date is skipped on its window (the window's own
// exceptions) and a window of that one date (Do not repeat) runs at the new times. A bar the calendar draws can hold several
// occurrences (a gap that joins, a cron's that touch): its parts are those occurrences as written; a move changes every part, a
// start the first, an end the last.
import { moveWindow, movesDay, occurrencesIn, resizeWindow, startsOnDate, wallOf } from './occurrences';
import { dateText, isOnce, occurrenceText, recurrenceText, windowBody, type Schedule, type ScheduleWindow } from './schedule';

export type Edge = 'move' | 'start' | 'end';
export type Scope = 'series' | 'occurrence';
// An occurrence as written, not joined.
export interface Part { window: number; start: number; end: number }
// What the calendar did: the edge dragged, by `minutes` on its clock (dragMinutes of its delta), the instants by `ms`.
export interface CalendarEdit { edge: Edge; minutes: number; ms: number }
// summary: what a choice would do, in the dialog that asks; done: what it did, in the notification.
export type Edited = { schedule: Schedule; summary: string; done: string } | { problem: string };

const STEP = 5;
const OWN_MAX = 100;
const WINDOW_SIZE = 'A window lasts from 5 minutes to 24 hours.';
const CRON_SIZE = 'A cron window lasts from 5 minutes to 7 days.';
const CRON_SERIES = 'A cron window\'s starts are its expression\'s: move this occurrence alone, or edit the series in the dialog.';
const NOT_ALIKE = 'Its occurrences would not all move alike (a day past a month\'s end, a first weekday that becomes a second, a count of weeks): edit it in the dialog.';
const EXCEPTED = 'This schedule has dates without a window, and this move would change which occurrence they skip: edit it in the dialog.';
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const withoutDate = (date: string) => `${dateText(date)} is a date without a window in this schedule: the occurrence would not run.`;
// A sentence inside another: "every occurrence of Shop now runs every day, …", as movedText words it.
const lower = (text: string): string => text.replace(/^(Every|Weekly|Monthly|Yearly|Once|Cron)\b/, (word) => word.toLowerCase());

// The parts of a bar drawn from `start` to `end` for these windows.
export function partsOf(s: Schedule, windows: number[], start: number, end: number): Part[] {
  return occurrencesIn(s, start, end, { joinMinutes: 0 })
    .filter((o) => windows.includes(o.window) && o.start >= start && o.start < end)
    .map((o) => ({ window: o.window, start: o.start, end: o.end }));
}

// The parts an edge changes: a move all, a start the one that starts first, an end the one that ends last.
function touchedParts(parts: Part[], edge: Edge): Part[] {
  if (edge === 'move' || !parts.length) return parts;
  const pick = edge === 'start' ? parts.reduce((a, b) => (b.start < a.start ? b : a)) : parts.reduce((a, b) => (b.end >= a.end ? b : a));
  return [pick];
}

// Whether to ask: a part it changes belongs to a window that repeats. A window of one date has nothing else to change.
export function asksScope(s: Schedule, parts: Part[], edge: Edge): boolean {
  return touchedParts(parts, edge).some((p) => {
    const w = s.windows?.[p.window];
    return Boolean(w) && !isOnce(w!);
  });
}

// The schedule after a change of `scope`, or why it cannot be made. `today` is the schedule's date, where a series move is checked.
export function editSchedule(s: Schedule, parts: Part[], edit: CalendarEdit, scope: Scope, today: string, name: string): Edited {
  const touched = touchedParts(parts, edit.edge);
  if (!touched.length || touched.some((p) => !s.windows?.[p.window])) return { problem: 'The schedule changed: read it again.' };
  return scope === 'series' ? series(s, touched, edit, today, name) : occurrence(s, touched, edit, name);
}

function series(s: Schedule, touched: Part[], edit: CalendarEdit, today: string, name: string): Edited {
  const windows = [...s.windows!];
  const indexes = [...new Set(touched.map((p) => p.window))];
  for (const i of indexes) {
    const w = windows[i]!;
    const cron = w.repeat?.pattern === 'cron';
    if (cron && edit.edge !== 'end') return { problem: CRON_SERIES };
    if (edit.edge !== 'end' && !moveWindow(w, edit.minutes, today)) return { problem: NOT_ALIKE };
    const next = edit.edge === 'move' ? moveWindow(w, edit.minutes, today) : resizeWindow(w, edit.edge, edit.minutes, today);
    if (!next) return { problem: cron ? CRON_SIZE : WINDOW_SIZE };
    if (isOnce(next)) {
      if (s.exceptions?.includes(next.from!)) return { problem: withoutDate(next.from!) };
    } else if (edit.edge !== 'end' && movesDay(w, edit.minutes) && s.exceptions?.some((date) => date >= today)) {
      return { problem: EXCEPTED };
    }
    windows[i] = next;
  }
  const changed = indexes.map((i) => windows[i]!);
  const texts = changed.map((w) => recurrenceText(windowBody(w)));
  const verb = `Window${indexes.length > 1 ? 's' : ''} ${edit.edge === 'move' ? 'moved' : 'changed'}`;
  const runs = texts.map(lower).join('; ');
  const once = changed.every(isOnce);
  return {
    schedule: { ...s, windows },
    summary: once ? `${texts.join('; ')}.` : `Every occurrence: ${texts.join('; ')}.`,
    done: once ? `${verb}: ${name} now runs ${runs}` : `${verb}: every occurrence of ${name} now runs ${runs}`,
  };
}

function occurrence(s: Schedule, touched: Part[], edit: CalendarEdit, name: string): Edited {
  const zone = s.timeZone;
  const windows = [...s.windows!];
  const added: ScheduleWindow[] = [];
  const said: string[] = [];
  const skipped = new Set<string>();
  for (const p of touched) {
    const w = windows[p.window]!;
    const [start, end] = edit.edge === 'move' ? [p.start + edit.ms, p.end + edit.ms] : edit.edge === 'start' ? [p.start + edit.ms, p.end] : [p.start, p.end + edit.ms];
    const [a, b] = [wallOf(start, zone), wallOf(end, zone)];
    const length = (Date.parse(b.date) - Date.parse(a.date)) / 60_000 + b.minutes - a.minutes;
    if (length < STEP || length > 1440) return { problem: WINDOW_SIZE };
    if (s.exceptions?.includes(a.date)) return { problem: withoutDate(a.date) };
    const single: ScheduleWindow = {
      kind: w.kind, start: hhmm(a.minutes), end: hhmm(b.minutes), repeat: { pattern: 'daily' }, from: a.date, until: a.date,
      ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}),
    };
    said.push(occurrenceText({ start, end }, zone));
    if (isOnce(w)) {
      windows[p.window] = { ...w, ...single };
      continue;
    }
    const date = wallOf(p.start, zone).date;
    if (w.repeat?.pattern === 'cron' && startsOnDate(w, date) > 1) return { problem: `This cron window starts more than once on ${dateText(date)}: one occurrence can't be moved alone. Edit it in the dialog.` };
    const own = w.exceptions ?? [];
    if (!own.includes(date)) {
      if (own.length >= OWN_MAX) return { problem: `This window already skips ${OWN_MAX} dates: edit it in the dialog.` };
      windows[p.window] = { ...w, exceptions: [...own, date] };
    }
    skipped.add(date);
    added.push(single);
  }
  const skips = [...skipped].sort().map(dateText).join(' and ');
  const times = said.join('; ');
  return {
    schedule: { ...s, windows: [...windows, ...added] },
    summary: skips ? `${times} only; the series skips ${skips}.` : `${times}.`,
    done: `One occurrence of ${name} ${edit.edge === 'move' ? 'moved' : 'changed'}: ${times}${skips ? `; the series skips ${skips}` : ''}`,
  };
}
