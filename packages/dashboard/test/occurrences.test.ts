// The Schedules calendar's arithmetic: a schedule's occurrences at literal instants (overnight and 24-hour windows,
// clock changes, exceptions, another zone than the browser's), and a calendar selection as a window in a zone.
import { describe, expect, it } from 'vitest';
import { allDayWindow, occurrencesIn, windowFromSelection, type Occurrence } from '../src/occurrences';
import { browserZone, type Schedule } from '../src/schedule';

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
