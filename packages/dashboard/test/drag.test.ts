// What a drag or a resize on the Schedules calendar does to a schedule: the whole series, or this occurrence alone (its date
// skipped on the series, a window of that one date at the new times). A joined bar holds several occurrences as written.
import { describe, expect, it } from 'vitest';
import { asksScope, editSchedule, partsOf, type Edited, type Part } from '../src/drag';
import type { Schedule, ScheduleWindow } from '../src/schedule';

const at = Date.parse;
const TODAY = '2026-11-01';
const H = 3_600_000;
const utc = (...windows: ScheduleWindow[]): Schedule => ({ timeZone: 'UTC', windows });
const weekly: ScheduleWindow = { kind: 'awake', days: ['mon', 'tue'], start: '08:00', end: '12:00' };
const morning: ScheduleWindow = { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' };
const afternoon: ScheduleWindow = { kind: 'awake', days: ['mon'], start: '12:10', end: '18:00' };
const part = (window: number, start: string, end: string): Part => ({ window, start: at(start), end: at(end) });
const tue = part(0, '2027-01-05T08:00:00Z', '2027-01-05T12:00:00Z');
const bar = [part(0, '2027-01-04T08:00:00Z', '2027-01-04T12:00:00Z'), part(1, '2027-01-04T12:10:00Z', '2027-01-04T18:00:00Z')];
const once = (date: string, start: string, end: string, more: Partial<ScheduleWindow> = {}): ScheduleWindow => ({ kind: 'awake', start, end, repeat: { pattern: 'daily' }, from: date, until: date, ...more });
const done = (r: Edited) => {
  if ('problem' in r) throw new Error(r.problem);
  return r;
};
const problem = (r: Edited) => ('problem' in r ? r.problem : `no problem: ${JSON.stringify(r.schedule)}`);
const move = (minutes: number) => ({ edge: 'move' as const, minutes, ms: minutes * 60_000 });

describe('the parts of a bar', () => {
  it('are its windows\' occurrences as written, by start', () => {
    expect(partsOf(utc(morning, afternoon), 15, at('2027-01-04T08:00:00Z'), at('2027-01-04T18:00:00Z'), 0)).toEqual(bar);
    expect(partsOf(utc(morning, afternoon), 0, at('2027-01-04T12:10:00Z'), at('2027-01-04T18:00:00Z'), 1)).toEqual([bar[1]]);
  });

  it('are what the drawing chained, not another bar of the same windows starting inside it', () => {
    // Fri 8 Jan 2027: the daily window joins Friday's night window (10 minutes apart); Saturday's daily occurrence, inside that
    // bar, is a bar of its own.
    const daily: ScheduleWindow = { kind: 'awake', start: '08:00', end: '20:00', repeat: { pattern: 'daily' } };
    const friday: ScheduleWindow = { kind: 'awake', days: ['fri'], start: '20:10', end: '09:00' };
    const s = utc(daily, friday);
    const parts = partsOf(s, 15, at('2027-01-08T08:00:00Z'), at('2027-01-09T09:00:00Z'), 0);
    expect(parts).toEqual([part(0, '2027-01-08T08:00:00Z', '2027-01-08T20:00:00Z'), part(1, '2027-01-08T20:10:00Z', '2027-01-09T09:00:00Z')]);
    // Its bottom edge is Friday's night window.
    expect(done(editSchedule(s, parts, { edge: 'end', minutes: 60, ms: H }, 'series', TODAY, 'Shop')).schedule.windows).toEqual([daily, { ...friday, end: '10:00' }]);
    expect(partsOf(s, 15, at('2027-01-09T08:00:00Z'), at('2027-01-09T20:00:00Z'), 0)).toEqual([part(0, '2027-01-09T08:00:00Z', '2027-01-09T20:00:00Z')]);
  });
});

describe('whether to ask: this occurrence or the series', () => {
  it('asks for a window that repeats, not for a window of one date', () => {
    expect(asksScope(utc(weekly), [tue], 'move')).toBe(true);
    const single = once('2027-01-05', '08:00', '12:00');
    expect(asksScope(utc(single), [tue], 'move')).toBe(false);
    // An end changes the last part's window only.
    expect(asksScope(utc(morning, single), [part(0, '2027-01-04T08:00:00Z', '2027-01-04T12:00:00Z'), part(1, '2027-01-04T12:10:00Z', '2027-01-04T18:00:00Z')], 'end')).toBe(false);
    expect(asksScope(utc(morning, single), [part(0, '2027-01-04T08:00:00Z', '2027-01-04T12:00:00Z'), part(1, '2027-01-04T12:10:00Z', '2027-01-04T18:00:00Z')], 'move')).toBe(true);
  });
});

describe('the series', () => {
  it('moves every window of a bar by the calendar\'s minutes, and says how they run', () => {
    const r = done(editSchedule(utc(morning, afternoon), bar, move(60), 'series', TODAY, 'Shop'));
    expect(r.schedule.windows).toEqual([{ ...morning, start: '09:00', end: '13:00' }, { ...afternoon, start: '13:10', end: '19:00' }]);
    expect(r.summary).toBe('Every occurrence: Mon, 09:00–13:00; Mon, 13:10–19:00.');
    expect(r.done).toBe('Windows moved: every occurrence of Shop now runs Mon, 09:00–13:00; Mon, 13:10–19:00');
    expect(done(editSchedule(utc(weekly), [tue], move(60), 'series', TODAY, 'Shop')).done).toBe('Window moved: every occurrence of Shop now runs Mon, Tue, 09:00–13:00');
  });

  it('a start changes the first part\'s window, an end the last part\'s', () => {
    expect(done(editSchedule(utc(morning, afternoon), bar, { edge: 'start', minutes: -60, ms: -H }, 'series', TODAY, 'Shop')).schedule.windows)
      .toEqual([{ ...morning, start: '07:00' }, afternoon]);
    const end = done(editSchedule(utc(morning, afternoon), bar, { edge: 'end', minutes: 60, ms: H }, 'series', TODAY, 'Shop'));
    expect(end.schedule.windows).toEqual([morning, { ...afternoon, end: '19:00' }]);
    expect(end.done).toBe('Window changed: every occurrence of Shop now runs Mon, 12:10–19:00');
  });

  it('a window of one date says it runs once', () => {
    const r = done(editSchedule(utc(once('2027-01-05', '08:00', '12:00')), [tue], move(60), 'series', TODAY, 'Shop'));
    expect(r.schedule.windows).toEqual([once('2027-01-05', '09:00', '13:00')]);
    expect(r.done).toBe('Window moved: Shop now runs once on 5 Jan 2027, 09:00–13:00');
  });

  it('a window of one date goes where it was dropped, by its instants, whatever the browser\'s clock says', () => {
    // A browser in Paris, a schedule in New York: dropped a week later on the browser's clock across 14 March 2027 (New York's
    // change, not Paris's), it is 168 hours of instants later, which New York's clock reads 10:00, where it was dropped.
    const ny: Schedule = { timeZone: 'America/New_York', windows: [once('2027-03-08', '09:00', '12:00')] };
    const monday = part(0, '2027-03-08T14:00:00Z', '2027-03-08T17:00:00Z');
    const week = { edge: 'move' as const, minutes: 7 * 1440, ms: 168 * H };
    expect(done(editSchedule(ny, [monday], week, 'series', TODAY, 'Shop')).schedule.windows).toEqual([once('2027-03-15', '10:00', '13:00')]);
    expect(problem(editSchedule({ ...ny, exceptions: ['2027-03-15'] }, [monday], week, 'series', TODAY, 'Shop'))).toContain('15 Mar 2027 is a date without a window');
  });

  it('refuses what a series cannot do, and says why', () => {
    const cron: ScheduleWindow = { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 240 } };
    expect(problem(editSchedule(utc(cron), [tue], move(60), 'series', TODAY, 'Shop'))).toContain('A cron window\'s starts are its expression\'s');
    expect(done(editSchedule(utc(cron), [tue], { edge: 'end', minutes: 60, ms: H }, 'series', TODAY, 'Shop')).schedule.windows![0]!.repeat).toEqual({ pattern: 'cron', cron: '0 8 * * *', minutes: 300 });
    expect(problem(editSchedule(utc(weekly), [tue], { edge: 'end', minutes: 21 * 60, ms: 21 * H }, 'series', TODAY, 'Shop'))).toBe('A window lasts from 5 minutes to 24 hours.');
    expect(problem(editSchedule(utc({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'monthly', day: 31 } }), [tue], move(1440), 'series', TODAY, 'Shop')))
      .toContain('would not all move alike');
    expect(problem(editSchedule({ ...utc(weekly), exceptions: ['2099-01-01'] }, [tue], move(1440), 'series', TODAY, 'Shop'))).toContain('dates without a window');
    // A past date skips nothing any more, and a move within the day changes no date.
    expect('problem' in editSchedule({ ...utc(weekly), exceptions: ['2020-01-01'] }, [tue], move(1440), 'series', TODAY, 'Shop')).toBe(false);
    expect('problem' in editSchedule({ ...utc(weekly), exceptions: ['2099-01-01'] }, [tue], move(60), 'series', TODAY, 'Shop')).toBe(false);
  });
});

describe('this occurrence', () => {
  it('skips its date on the series, and adds a window of that date at the new times', () => {
    const r = done(editSchedule(utc(weekly), [tue], move(60), 'occurrence', TODAY, 'Shop'));
    expect(r.schedule.windows).toEqual([{ ...weekly, exceptions: ['2027-01-05'] }, once('2027-01-05', '09:00', '13:00')]);
    expect(r.summary).toBe('Tue 5 Jan 2027, 09:00–13:00 only; the series skips 5 Jan 2027.');
    expect(r.done).toBe('One occurrence of Shop moved: Tue 5 Jan 2027, 09:00–13:00; the series skips 5 Jan 2027');
  });

  it('reads the new times on the schedule\'s clock: past midnight, to another date', () => {
    const paris: Schedule = { timeZone: 'Europe/Paris', windows: [weekly] };
    const night = part(0, '2027-01-05T07:00:00Z', '2027-01-05T11:00:00Z');
    expect(done(editSchedule(paris, [night], { edge: 'move', minutes: 840, ms: 14 * H }, 'occurrence', TODAY, 'Shop')).schedule.windows)
      .toEqual([{ ...weekly, exceptions: ['2027-01-05'] }, once('2027-01-05', '22:00', '02:00')]);
    expect(done(editSchedule(paris, [night], { edge: 'move', minutes: 1440, ms: 24 * H }, 'occurrence', TODAY, 'Shop')).schedule.windows)
      .toEqual([{ ...weekly, exceptions: ['2027-01-05'] }, once('2027-01-06', '08:00', '12:00')]);
  });

  it('an end or a start changes that occurrence alone', () => {
    expect(done(editSchedule(utc(weekly), [tue], { edge: 'end', minutes: 60, ms: H }, 'occurrence', TODAY, 'Shop')).schedule.windows![1]).toEqual(once('2027-01-05', '08:00', '13:00'));
    const start = done(editSchedule(utc(weekly), [tue], { edge: 'start', minutes: -60, ms: -H }, 'occurrence', TODAY, 'Shop'));
    expect(start.schedule.windows![1]).toEqual(once('2027-01-05', '07:00', '12:00'));
    expect(start.done).toBe('One occurrence of Shop changed: Tue 5 Jan 2027, 07:00–12:00; the series skips 5 Jan 2027');
  });

  it('a joined bar: each part skipped on its window, and a window of that date for each', () => {
    expect(done(editSchedule(utc(morning, afternoon), bar, move(60), 'occurrence', TODAY, 'Shop')).schedule.windows).toEqual([
      { ...morning, exceptions: ['2027-01-04'] }, { ...afternoon, exceptions: ['2027-01-04'] }, once('2027-01-04', '09:00', '13:00'), once('2027-01-04', '13:10', '19:00'),
    ]);
  });

  it('keeps a nap\'s wake, and a date the series already skips once', () => {
    const nap: ScheduleWindow = { kind: 'nap', days: ['tue'], start: '08:00', end: '12:00', wake: 'header', exceptions: ['2027-01-05'] };
    const r = done(editSchedule(utc(nap), [tue], move(60), 'occurrence', TODAY, 'Shop'));
    expect(r.schedule.windows).toEqual([nap, { ...once('2027-01-05', '09:00', '13:00'), kind: 'nap', wake: 'header' }]);
  });

  it('refuses a cron window that starts more than once that date, a date without a window, and a length out of bounds', () => {
    const twice: ScheduleWindow = { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8,14 * * *', minutes: 60 } };
    expect(problem(editSchedule(utc(twice), [tue], move(60), 'occurrence', TODAY, 'Shop'))).toBe('This cron window starts more than once on 5 Jan 2027: one occurrence can\'t be moved alone. Edit it in the dialog.');
    const daily: ScheduleWindow = { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 240 } };
    expect(done(editSchedule(utc(daily), [tue], move(60), 'occurrence', TODAY, 'Shop')).schedule.windows).toEqual([{ ...daily, exceptions: ['2027-01-05'] }, once('2027-01-05', '09:00', '13:00')]);
    expect(problem(editSchedule({ ...utc(weekly), exceptions: ['2027-01-06'] }, [tue], move(1440), 'occurrence', TODAY, 'Shop'))).toBe('6 Jan 2027 is a date without a window in this schedule: the occurrence would not run.');
    expect(problem(editSchedule(utc(weekly), [tue], { edge: 'end', minutes: 21 * 60, ms: 21 * H }, 'occurrence', TODAY, 'Shop'))).toBe('A window lasts from 5 minutes to 24 hours.');
  });

  it('a window of one date is changed in place', () => {
    const r = done(editSchedule(utc(once('2027-01-05', '08:00', '12:00')), [tue], move(60), 'occurrence', TODAY, 'Shop'));
    expect(r.schedule.windows).toEqual([once('2027-01-05', '09:00', '13:00')]);
    expect(r.done).toBe('One occurrence of Shop moved: Tue 5 Jan 2027, 09:00–13:00');
  });
});
