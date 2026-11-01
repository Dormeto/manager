// The Schedules calendar's arithmetic: a schedule's occurrences at literal instants (overnight and 24-hour windows,
// clock changes, exceptions, another zone than the browser's), and a calendar selection as a window in a zone.
import { describe, expect, it } from 'vitest';
import { allDayWindow, cronShortestGap, editProblems, fieldProblems, localDate, nextEvents, nextOccurrences, occurrencesIn, windowFromSelection, windowProblems, type Occurrence } from '../src/occurrences';
import { browserZone, type Schedule, type ScheduleWindow } from '../src/schedule';

const at = (text: string): number => Date.parse(text);
const HOUR = 3_600_000;
const hours = (o: Occurrence): number => (o.end - o.start) / HOUR;
const nights: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '20:00', end: '07:00' }] };

describe('occurrences of a schedule', () => {
  it('an overnight window runs from its day at start to the next day at end', () => {
    expect(occurrencesIn(nights, at('2026-10-12T00:00:00+02:00'), at('2026-10-13T00:00:00+02:00'))).toEqual([
      { kind: 'nap', window: 0, start: at('2026-10-12T20:00:00+02:00'), end: at('2026-10-13T07:00:00+02:00'), wake: 'never' },
    ]);
  });

  it('a range starting inside an overnight occurrence includes it; a range touching an occurrence does not', () => {
    expect(occurrencesIn(nights, at('2026-10-13T03:00:00+02:00'), at('2026-10-13T12:00:00+02:00'))).toEqual([
      { kind: 'nap', window: 0, start: at('2026-10-12T20:00:00+02:00'), end: at('2026-10-13T07:00:00+02:00'), wake: 'never' },
    ]);
    expect(occurrencesIn(nights, at('2026-10-13T07:00:00+02:00'), at('2026-10-13T20:00:00+02:00'))).toEqual([]);
    expect(occurrencesIn(nights, at('2026-10-13T12:00:00+02:00'), at('2026-10-13T12:00:00+02:00'))).toEqual([]);
  });

  it('an exception removes the occurrence that starts on that local date, not the one ending on it', () => {
    const s: Schedule = { ...nights, exceptions: ['2026-10-13'] };
    expect(occurrencesIn(s, at('2026-10-12T00:00:00+02:00'), at('2026-10-15T00:00:00+02:00')).map((o) => o.start)).toEqual([
      at('2026-10-12T20:00:00+02:00'), at('2026-10-14T20:00:00+02:00'),
    ]);
  });

  it('a 24-hour window ends at the same local time the next day: 25 hours when Paris falls back, 23 when it springs forward', () => {
    const weekend: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00', wake: 'header' }] };
    const autumn = occurrencesIn(weekend, at('2026-10-24T00:00:00+02:00'), at('2026-10-26T00:00:00+01:00'));
    expect(autumn).toEqual([
      { kind: 'nap', window: 0, start: at('2026-10-23T22:00:00Z'), end: at('2026-10-24T22:00:00Z'), wake: 'header' },
      { kind: 'nap', window: 0, start: at('2026-10-24T22:00:00Z'), end: at('2026-10-25T23:00:00Z'), wake: 'header' },
    ]);
    expect(autumn.map(hours)).toEqual([24, 25]);
    const spring = occurrencesIn(weekend, at('2027-03-27T00:00:00+01:00'), at('2027-03-29T00:00:00+02:00'));
    expect(spring.map((o) => [o.start, o.end])).toEqual([
      [at('2027-03-26T23:00:00Z'), at('2027-03-27T23:00:00Z')],
      [at('2027-03-27T23:00:00Z'), at('2027-03-28T22:00:00Z')],
    ]);
    expect(spring.map(hours)).toEqual([24, 23]);
  });

  it('a 24-hour window on Lord Howe\'s spring day lasts 23 and a half hours', () => {
    const s: Schedule = { timeZone: 'Australia/Lord_Howe', windows: [{ kind: 'nap', days: ['sun'], start: '00:00', end: '00:00' }] };
    expect(occurrencesIn(s, at('2026-10-04T00:00:00+10:30'), at('2026-10-05T00:00:00+11:00')).map((o) => [o.start, o.end])).toEqual([
      [at('2026-10-04T00:00:00+10:30'), at('2026-10-05T00:00:00+11:00')],
    ]);
  });

  it('a start the spring change skips is the change (02:30 drawn at 03:00); a repeated one is its first instance', () => {
    const s: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['sun'], start: '02:30', end: '05:00' }] };
    expect(occurrencesIn(s, at('2027-03-28T00:00:00+01:00'), at('2027-03-29T00:00:00+02:00'))).toEqual([
      { kind: 'awake', window: 0, start: at('2027-03-28T03:00:00+02:00'), end: at('2027-03-28T05:00:00+02:00') },
    ]);
    expect(occurrencesIn(s, at('2026-10-25T00:00:00+02:00'), at('2026-10-26T00:00:00+01:00'))).toEqual([
      { kind: 'awake', window: 0, start: at('2026-10-25T02:30:00+02:00'), end: at('2026-10-25T05:00:00+01:00') },
    ]);
  });

  it('a window the spring change leaves empty has no occurrence that day', () => {
    const s: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['sun'], start: '02:00', end: '02:30' }] };
    expect(occurrencesIn(s, at('2027-03-21T00:00:00+01:00'), at('2027-03-29T00:00:00+02:00')).map((o) => [o.start, o.end])).toEqual([
      [at('2027-03-21T02:00:00+01:00'), at('2027-03-21T02:30:00+01:00')],
    ]);
  });

  it('a schedule in New York is drawn at its own instants from anywhere: 5 hours from Paris the week the clocks differ, 6 after', () => {
    const s: Schedule = { timeZone: 'America/New_York', windows: [{ kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }] };
    expect(occurrencesIn(s, at('2026-10-26T00:00:00+01:00'), at('2026-10-27T00:00:00+01:00')).map((o) => [o.start, o.end])).toEqual([
      [at('2026-10-26T14:00:00+01:00'), at('2026-10-26T22:00:00+01:00')],
    ]);
    expect(occurrencesIn(s, at('2026-11-02T00:00:00+01:00'), at('2026-11-03T00:00:00+01:00')).map((o) => [o.start, o.end])).toEqual([
      [at('2026-11-02T15:00:00+01:00'), at('2026-11-02T23:00:00+01:00')],
    ]);
  });

  it('a quarter-hour zone (Kathmandu, +05:45)', () => {
    const s: Schedule = { timeZone: 'Asia/Kathmandu', windows: [{ kind: 'awake', days: ['mon'], start: '09:00', end: '17:30' }] };
    expect(occurrencesIn(s, at('2026-10-19T00:00:00Z'), at('2026-10-20T00:00:00Z')).map((o) => [o.start, o.end])).toEqual([
      [at('2026-10-19T03:15:00Z'), at('2026-10-19T11:45:00Z')],
    ]);
  });

  it('each window has its own occurrences, in order of start: same-kind windows are not merged', () => {
    const s: Schedule = {
      timeZone: 'Europe/Paris',
      windows: [
        { kind: 'awake', days: ['mon'], start: '10:00', end: '14:00' },
        { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' },
        { kind: 'nap', days: ['mon'], start: '20:00', end: '07:00', wake: 'header' },
      ],
    };
    expect(occurrencesIn(s, at('2026-10-19T00:00:00+02:00'), at('2026-10-20T00:00:00+02:00'))).toEqual([
      { kind: 'awake', window: 1, start: at('2026-10-19T08:00:00+02:00'), end: at('2026-10-19T12:00:00+02:00') },
      { kind: 'awake', window: 0, start: at('2026-10-19T10:00:00+02:00'), end: at('2026-10-19T14:00:00+02:00') },
      { kind: 'nap', window: 2, start: at('2026-10-19T20:00:00+02:00'), end: at('2026-10-20T07:00:00+02:00'), wake: 'header' },
    ]);
  });

  it('a schedule without windows (a maximum nap only) has no occurrence', () => {
    const from = at('2026-10-19T00:00:00Z');
    expect(occurrencesIn({ timeZone: 'Europe/Paris', maxNapDays: 5 }, from, from + 7 * 24 * HOUR)).toEqual([]);
    expect(occurrencesIn({ timeZone: 'Europe/Paris', windows: [] }, from, from + 7 * 24 * HOUR)).toEqual([]);
  });
});

describe('a selection as a window', () => {
  it('in the browser\'s zone: the start\'s weekday and times', () => {
    expect(windowFromSelection(new Date(2026, 9, 19, 8, 0), new Date(2026, 9, 19, 10, 0), browserZone())).toEqual({ days: ['mon'], start: '08:00', end: '10:00' });
  });

  it('in another zone: a Monday early morning in Paris is a Sunday evening in New York', () => {
    const w = windowFromSelection(new Date('2026-10-19T03:00:00+02:00'), new Date('2026-10-19T05:00:00+02:00'), 'America/New_York');
    expect(w).toEqual({ days: ['sun'], start: '21:00', end: '23:00' });
    if ('problem' in w) throw new Error(w.problem);
    // Saved, it is drawn where it was selected.
    const s: Schedule = { timeZone: 'America/New_York', windows: [{ kind: 'awake', ...w }] };
    expect(occurrencesIn(s, at('2026-10-19T00:00:00+02:00'), at('2026-10-20T00:00:00+02:00')).map((o) => [o.start, o.end])).toEqual([
      [at('2026-10-19T03:00:00+02:00'), at('2026-10-19T05:00:00+02:00')],
    ]);
    expect(windowFromSelection(new Date('2026-10-19T08:00:00+02:00'), new Date('2026-10-19T09:00:00+02:00'), 'Asia/Kathmandu')).toEqual({ days: ['mon'], start: '11:45', end: '12:45' });
  });

  it('across midnight: an overnight window (end before start)', () => {
    expect(windowFromSelection(new Date('2026-10-19T22:00:00+02:00'), new Date('2026-10-20T06:00:00+02:00'), 'Europe/Paris')).toEqual({ days: ['mon'], start: '22:00', end: '06:00' });
    // Midnight in the target zone, not the browser's: 05:00–07:00 in Paris is 23:00–01:00 in New York.
    expect(windowFromSelection(new Date('2026-10-19T05:00:00+02:00'), new Date('2026-10-19T07:00:00+02:00'), 'America/New_York')).toEqual({ days: ['sun'], start: '23:00', end: '01:00' });
  });

  it('exactly 24 hours of the zone\'s clock: start = end, also on the days the clocks change', () => {
    expect(windowFromSelection(new Date('2026-10-17T00:00:00+02:00'), new Date('2026-10-18T00:00:00+02:00'), 'Europe/Paris')).toEqual({ days: ['sat'], start: '00:00', end: '00:00' });
    expect(windowFromSelection(new Date('2026-10-25T00:00:00+02:00'), new Date('2026-10-26T00:00:00+01:00'), 'Europe/Paris')).toEqual({ days: ['sun'], start: '00:00', end: '00:00' });
    expect(windowFromSelection(new Date('2027-03-28T00:00:00+01:00'), new Date('2027-03-29T00:00:00+02:00'), 'Europe/Paris')).toEqual({ days: ['sun'], start: '00:00', end: '00:00' });
    // 24 elapsed hours that the change makes 23 on the clock.
    expect(windowFromSelection(new Date('2026-10-25T00:00:00+02:00'), new Date('2026-10-25T23:00:00+01:00'), 'Europe/Paris')).toEqual({ days: ['sun'], start: '00:00', end: '23:00' });
  });

  it('more than 24 hours is refused, with the month view as the hint', () => {
    const longer = windowFromSelection(new Date('2026-10-19T08:00:00+02:00'), new Date('2026-10-20T08:05:00+02:00'), 'Europe/Paris');
    expect(longer).toEqual({ problem: expect.stringContaining('at most 24 hours') });
    expect((longer as { problem: string }).problem).toContain('month view');
    expect(windowFromSelection(new Date('2026-10-19T00:00:00+02:00'), new Date('2026-10-21T00:00:00+02:00'), 'Europe/Paris')).toHaveProperty('problem');
    // The day Paris falls back, 24 hours of Paris's clock (25 elapsed) are 25 hours of New York's: refused there only.
    const [sunday, monday] = [new Date('2026-10-25T00:00:00+02:00'), new Date('2026-10-26T00:00:00+01:00')];
    expect(windowFromSelection(sunday, monday, 'Europe/Paris')).toEqual({ days: ['sun'], start: '00:00', end: '00:00' });
    expect(windowFromSelection(sunday, monday, 'America/New_York')).toEqual({ problem: expect.stringContaining('25 hours on the clock of America/New_York') });
  });

  it('an empty, reversed or too short selection, and an unknown zone, are refused', () => {
    const t = new Date('2026-10-19T08:00:00+02:00');
    expect(windowFromSelection(t, t, 'Europe/Paris')).toHaveProperty('problem');
    expect(windowFromSelection(t, new Date(t.getTime() - HOUR), 'Europe/Paris')).toHaveProperty('problem');
    expect(windowFromSelection(t, new Date(t.getTime() + 2 * 60_000), 'Europe/Paris')).toEqual({ problem: expect.stringContaining('at least 5 minutes') });
    expect(windowFromSelection(t, new Date(t.getTime() + HOUR), 'Nowhere/Land')).toHaveProperty('problem');
    // A UTC offset is not a zone name (the router refuses it).
    expect(windowFromSelection(t, new Date(t.getTime() + HOUR), '+01:00')).toHaveProperty('problem');
    expect(windowFromSelection(new Date(Number.NaN), t, 'Europe/Paris')).toHaveProperty('problem');
  });

  it('a selection that the zone\'s repeated hour makes end before (or where) it starts on its clock is refused', () => {
    const backwards = { problem: expect.stringContaining('On the clock of Europe/Paris, this selection does not end after it starts (a clock change)') };
    // 02:30 summer time to 02:15 winter time: 45 minutes, backwards on the clock.
    expect(windowFromSelection(new Date('2026-10-25T02:30:00+02:00'), new Date('2026-10-25T02:15:00+01:00'), 'Europe/Paris')).toEqual(backwards);
    // 02:30 to the second 02:30: an hour, nothing on the clock.
    expect(windowFromSelection(new Date('2026-10-25T02:30:00+02:00'), new Date('2026-10-25T02:30:00+01:00'), 'Europe/Paris')).toEqual(backwards);
  });

  it('rounds each time to the nearest 5 minutes (a tie rounds up), the weekday after rounding', () => {
    const paris = (text: string) => new Date(`${text}+02:00`);
    expect(windowFromSelection(paris('2026-10-19T08:02:00'), paris('2026-10-19T09:58:00'), 'Europe/Paris')).toEqual({ days: ['mon'], start: '08:00', end: '10:00' });
    expect(windowFromSelection(paris('2026-10-19T08:03:00'), paris('2026-10-19T09:57:29'), 'Europe/Paris')).toEqual({ days: ['mon'], start: '08:05', end: '09:55' });
    expect(windowFromSelection(paris('2026-10-19T08:02:30'), paris('2026-10-19T09:00:00'), 'Europe/Paris')).toEqual({ days: ['mon'], start: '08:05', end: '09:00' });
    // 23:58 is Tuesday 00:00.
    expect(windowFromSelection(paris('2026-10-19T23:58:00'), paris('2026-10-20T02:00:00'), 'Europe/Paris')).toEqual({ days: ['tue'], start: '00:00', end: '02:00' });
    // 24 hours from an odd minute stays 24 hours.
    expect(windowFromSelection(paris('2026-10-19T08:02:00'), paris('2026-10-20T08:02:00'), 'Europe/Paris')).toEqual({ days: ['mon'], start: '08:00', end: '08:00' });
  });
});

describe('a month selection as a window', () => {
  it('00:00–00:00 on the days selected, each once, in week order', () => {
    expect(allDayWindow(['sun', 'sat', 'sat'])).toEqual({ days: ['sat', 'sun'], start: '00:00', end: '00:00' });
  });
});

// Recurrences (schedule recurrence design): literal instants, so these hold without the router's checkout.
describe('recurring windows', () => {
  const NOW = at('2027-01-01T00:00:00Z');
  const utc = (w: ScheduleWindow, more: Partial<Schedule> = {}): Schedule => ({ timeZone: 'UTC', windows: [w], ...more });
  const paris = (w: ScheduleWindow): Schedule => ({ timeZone: 'Europe/Paris', windows: [w] });
  const awake = (fields: Partial<ScheduleWindow>): ScheduleWindow => ({ kind: 'awake', start: '08:00', end: '12:00', ...fields });
  const cron = (expression: string, minutes = 5): ScheduleWindow => ({ kind: 'awake', repeat: { pattern: 'cron', cron: expression, minutes } });
  const dates = (s: Schedule, count = 5, t = NOW): string[] => nextOccurrences(s, t, count).map((o) => new Date(o.start).toISOString().slice(0, 16).replace('T', ' '));
  const at8 = (...days: string[]) => days.map((d) => `${d} 08:00`);

  it('daily counts days from from, across a month and a year', () => {
    expect(dates(utc(awake({ repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' })), 3)).toEqual(at8('2027-01-04', '2027-01-07', '2027-01-10'));
    expect(dates(utc(awake({ repeat: { pattern: 'daily', interval: 10 }, from: '2026-12-25' })), 2)).toEqual(at8('2027-01-04', '2027-01-14'));
  });

  it('weekly counts weeks, Monday to Sunday, from the week of from', () => {
    expect(dates(utc(awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-06' })))).toEqual(at8('2027-01-07', '2027-01-18', '2027-01-21', '2027-02-01', '2027-02-04'));
    expect(dates(utc(awake({ repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'sun'] }, from: '2027-01-10' })), 3)).toEqual(at8('2027-01-10', '2027-01-18', '2027-01-24'));
  });

  it('monthly counts months from the month of from, and a day past the month\'s end falls on its last day', () => {
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', interval: 3, day: 15 }, from: '2027-01-20' })), 2)).toEqual(at8('2027-04-15', '2027-07-15'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', day: 31 } })), 4)).toEqual(at8('2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', day: 31 } })), 1, at('2028-02-01T00:00:00Z'))).toEqual(at8('2028-02-29'));
  });

  it('monthly on the first to fourth weekday, and the last', () => {
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', nth: 1, weekday: 'mon' } })), 2)).toEqual(at8('2027-01-04', '2027-02-01'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', nth: 4, weekday: 'mon' } })), 2)).toEqual(at8('2027-01-25', '2027-02-22'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', nth: -1, weekday: 'mon' } })), 3)).toEqual(at8('2027-01-25', '2027-02-22', '2027-03-29'));
  });

  it('yearly is monthly every 12 months, its month given by from, and is found within 400 days', () => {
    const christmas: ScheduleWindow = { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' };
    const after = at('2027-01-15T12:00:00+01:00');
    expect(nextOccurrences(paris(christmas), after, 1)).toEqual([{ kind: 'nap', window: 0, start: at('2027-12-24T23:00:00Z'), end: at('2027-12-25T23:00:00Z'), wake: 'never' }]);
    expect(nextEvents(paris(christmas), after)).toEqual([
      { at: '2027-12-24T23:00:00.000Z', kind: 'nap-start', window: 0 },
      { at: '2027-12-25T23:00:00.000Z', kind: 'nap-end', window: 0 },
    ]);
  });

  it('from and until both count, and an occurrence started on until runs past it', () => {
    const s = utc({ kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'daily' }, from: '2027-01-04', until: '2027-01-05' });
    expect(occurrencesIn(s, at('2027-01-01T00:00:00Z'), at('2027-01-10T00:00:00Z')).map((o) => [o.start, o.end])).toEqual([
      [at('2027-01-04T20:00:00Z'), at('2027-01-05T07:00:00Z')],
      [at('2027-01-05T20:00:00Z'), at('2027-01-06T07:00:00Z')],
    ]);
    expect(dates(utc(awake({ days: ['mon'], until: '2026-12-31' })))).toEqual([]);
    expect(dates(utc(awake({ days: ['mon'], from: '2027-01-11' })), 1)).toEqual(at8('2027-01-11'));
  });

  it('a cron expression: its grammar, either day field, and each start its own occurrence', () => {
    expect(dates(utc(cron('0,30 8 * * *')), 3)).toEqual(['2027-01-01 08:00', '2027-01-01 08:30', '2027-01-02 08:00']);
    expect(dates(utc(cron('0 8 15 * MON')), 3)).toEqual(at8('2027-01-04', '2027-01-11', '2027-01-15'));
    expect(dates(utc(cron('0 8 */10 * *')), 3)).toEqual(at8('2027-01-01', '2027-01-11', '2027-01-21'));
    expect(dates(utc(cron('0 8 *,5 * *')), 2)).toEqual(at8('2027-01-01', '2027-01-02'));
    expect(dates(utc(cron('0 8 * * FRI-SUN')), 3)).toEqual(at8('2027-01-01', '2027-01-02', '2027-01-03'));
    expect(dates(utc(cron('0 8 * * 0')), 1)).toEqual(at8('2027-01-03'));
    expect(dates(utc(cron('0 8 * * 7')), 1)).toEqual(at8('2027-01-03'));
    expect(dates(utc(cron('0 8 ? mar ?')), 1)).toEqual(at8('2027-03-01'));
    expect(dates(utc(cron('0 8 29 2 *')), 1, at('2028-01-01T00:00:00Z'))).toEqual(at8('2028-02-29'));
  });

  it('minutes up to 7 days: an occurrence started long ago still reaches the range', () => {
    const week = utc(cron('0 8 1 * *', 10080));
    expect(occurrencesIn(week, at('2027-01-08T07:55:00Z'), at('2027-01-08T08:05:00Z'))).toEqual([{ kind: 'awake', window: 0, start: at('2027-01-01T08:00:00Z'), end: at('2027-01-08T08:00:00Z') }]);
  });

  it('clock changes: a skipped start applies at the change, a repeated one at its first instance, minutes in wall time', () => {
    const on = (expression: string, minutes: number, t: string) => occurrencesIn(paris(cron(expression, minutes)), at(t), at(t) + 1).map((o) => [o.start, o.end]);
    expect(on('30 2 * * *', 60, '2027-03-28T03:10:00+02:00')).toEqual([[at('2027-03-28T01:00:00Z'), at('2027-03-28T01:30:00Z')]]);
    expect(on('30 2 * * *', 60, '2027-10-31T02:40:00+01:00')).toEqual([[at('2027-10-31T00:30:00Z'), at('2027-10-31T02:30:00Z')]]);
    expect(on('0 12 27 3 *', 1440, '2027-03-28T11:55:00+02:00')).toEqual([[at('2027-03-27T11:00:00Z'), at('2027-03-28T10:00:00Z')]]);
  });

  it('an exception date removes what starts on it, of every pattern', () => {
    const more = { exceptions: ['2027-01-15'] };
    for (const w of [awake({ repeat: { pattern: 'monthly', day: 15 } }), awake({ repeat: { pattern: 'daily' } }), cron('0 8 15 * *', 240)]) {
      expect(occurrencesIn(utc(w), at('2027-01-15T09:00:00Z'), at('2027-01-15T09:05:00Z'))).toHaveLength(1);
      expect(occurrencesIn(utc(w, more), at('2027-01-15T09:00:00Z'), at('2027-01-15T09:05:00Z'))).toEqual([]);
    }
  });

  it('a stored window it cannot read has no occurrence, rather than an error, and the others keep their index', () => {
    const windows = [
      { kind: 'awake', repeat: { pattern: 'cron', cron: 'not cron', minutes: 60 } },
      { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'hourly' } },
      { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily' } },
    ] as unknown as ScheduleWindow[];
    expect(nextOccurrences({ timeZone: 'UTC', windows }, NOW, 1).map((o) => o.window)).toEqual([2]);
    expect(nextOccurrences({ timeZone: 'UTC', windows: windows.slice(0, 2) }, NOW)).toEqual([]);
    expect(nextEvents({ timeZone: 'UTC', windows: windows.slice(0, 2) }, NOW)).toEqual([]);
  });

  it('nextOccurrences gives the coming starts only, a */5 window quickly', () => {
    const begin = performance.now();
    expect(dates(utc(cron('*/5 * * * *')), 3, at('2027-01-06T12:02:00Z'))).toEqual(['2027-01-06 12:05', '2027-01-06 12:10', '2027-01-06 12:15']);
    expect(performance.now() - begin).toBeLessThan(200);
  });

  it('nextOccurrences reads from the start date when it is far ahead, and 10 years on from there', () => {
    expect(dates(utc(awake({ repeat: { pattern: 'daily' }, from: '2099-01-04' })), 1)).toEqual(at8('2099-01-04'));
    expect(dates(utc(cron('0 8 29 2 *')), 1)).toEqual(at8('2028-02-29'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2027-12-01' })))).toEqual(at8('2027-12-25', '2028-12-25', '2029-12-25', '2030-12-25', '2031-12-25'));
    expect(dates(utc(awake({ repeat: { pattern: 'monthly', interval: 99, day: 1 }, from: '2027-02-01' })))).toEqual(at8('2027-02-01', '2035-05-01'));
    expect(nextOccurrences({ timeZone: 'UTC', windows: [] }, NOW)).toEqual([]);
  });

  it('says how often a cron expression starts at its shortest, or null with one start a day or an expression it cannot read', () => {
    expect(cronShortestGap('*/5 * * * *')).toBe(5);
    expect(cronShortestGap('*/15 8 * * *')).toBe(15);
    expect(cronShortestGap('0,10 8 * * *')).toBe(10);
    expect(cronShortestGap('0,30 8 * * *')).toBe(30);
    expect(cronShortestGap('55 23 * * *')).toBeNull();
    expect(cronShortestGap('0,55 0,23 * * *')).toBe(5);
    expect(cronShortestGap('nope')).toBeNull();
  });

  it('gives the local date in a zone', () => {
    expect(localDate(at('2026-12-31T23:30:00Z'), 'Europe/Paris')).toBe('2027-01-01');
    expect(localDate(at('2026-12-31T23:30:00Z'), 'UTC')).toBe('2026-12-31');
  });
});

describe('what a form holds beyond a window', () => {
  const window: ScheduleWindow = { kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' };

  it('an end date chosen and left blank is a problem, though the body would drop it', () => {
    expect(editProblems(window)).toEqual({});
    expect(editProblems({ ...window, until: '' })).toEqual({ until: 'choose a date, or No end date' });
    expect(editProblems({ ...window, until: '2027-01-01' })).toEqual({});
    expect(editProblems({ ...window, from: '2027-01-02', until: '2027-01-01' })).toEqual({ until: 'not before from' });
  });

  it('a wake left on an awake window is the body\'s to drop', () => {
    expect(editProblems({ ...window, wake: 'never' })).toEqual({});
  });
});

describe('a window\'s problems, in the router\'s words', () => {
  const problems = (w: unknown) => windowProblems(w as ScheduleWindow, 'windows[1]');
  const cron = (expression: string) => ({ kind: 'awake', repeat: { pattern: 'cron', cron: expression, minutes: 60 } });

  it('finds none in the design\'s examples', () => {
    for (const w of [
      { kind: 'awake', days: ['mon', 'fri'], start: '08:30', end: '19:00' },
      { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
      { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
      { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 1, day: 15 } },
      { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 3, nth: 1, weekday: 'mon' }, from: '2027-01-01' },
      { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' },
      { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
    ]) expect(problems(w), JSON.stringify(w)).toEqual([]);
  });

  it('names the field and says why', () => {
    expect(problems(cron('* 8 * * *'))).toEqual(['windows[1].repeat.cron: minutes must be multiples of 5, as schedule times are: * is every minute, */5 every five']);
    expect(problems(cron('cron(0 8 * * ? *)'))).toEqual(['windows[1].repeat.cron: five fields: minute hour day-of-month month day-of-week']);
    expect(problems(cron('0 8 31 2 *'))).toEqual(['windows[1].repeat.cron: never matches: no such date in that month']);
    expect(problems({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily', interval: 2 } })).toEqual(['windows[1].from: required when repeat.interval is above 1, it anchors the count']);
    expect(problems({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: '2027-01-05', until: '2027-01-04' })).toEqual(['windows[1].until: not before from']);
    expect(problems({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 7 } })).toEqual(['windows[1].repeat.minutes: a multiple of 5 from 5 to 10080']);
    expect(problems({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily', interval: NaN } })).toEqual(['windows[1].repeat.interval: a whole number from 1 to 99']);
  });

  it('refuses a day field starting with * beside the other one, and more than a line', () => {
    const STAR_DAY = 'windows[1].repeat.cron: a day field starting with * goes alone: cron versions read */2 with the other day field differently, so give a list or a range';
    const ONE_LINE = 'windows[1].repeat.cron: one line, without control characters';
    for (const expression of ['0 8 */2 * 1', '0 8 15 * */2', '0 8 *,5 * MON', '0 8 */2 * */3']) expect(problems(cron(expression)), expression).toEqual([STAR_DAY]);
    for (const expression of ['0 8 * * 1\n', '0\r8 * * 1', '0 8\n* * 1', '0 8 * * \x7f1', '0 8 \0* * 1']) expect(problems(cron(expression)), expression).toEqual([ONE_LINE]);
    for (const expression of ['0 8 */2 * *', '0 8 * * */2', '0 8 */2 * ?', '0\t8 * * 1', '0 8 1-31 * 1']) expect(problems(cron(expression)), expression).toEqual([]);
  });

  it('reads them by field for a form', () => {
    expect(fieldProblems({ kind: 'awake', days: [], start: '08:00', end: '09:00', from: '2027-1-5' })).toEqual({
      days: 'one or more of mon, tue, wed, thu, fri, sat, sun, each once', from: 'a date YYYY-MM-DD',
    });
  });
});
