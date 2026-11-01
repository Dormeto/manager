import { describe, expect, it } from 'vitest';
import { canonicalZone, dateText, daysText, durationText, eventText, formProblem, hoursText, newMemory, occurrenceText, rangeText, recurrenceText, recurrenceError, repeatChoice, repeatText, scheduleBody, TIMES, windowBody, withChoice, withFrom, withInterval, withOnceDate, isOnce, movedText, type RepeatChoice, type Schedule, type ScheduleWindow } from '../src/schedule';
import { causeText } from '../src/history';

describe('schedule formatting', () => {
  it('writes days as ranges where they are consecutive', () => {
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon–Fri');
    expect(daysText(['fri', 'mon', 'tue', 'wed', 'thu'])).toBe('Mon–Fri');
    expect(daysText(['sat'])).toBe('Sat');
    expect(daysText(['mon', 'wed', 'fri'])).toBe('Mon, Wed, Fri');
    expect(daysText(['sat', 'sun'])).toBe('Sat, Sun');
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('every day');
    expect(daysText(['mon', 'tue', 'thu', 'fri', 'sat'])).toBe('Mon–Tue, Thu–Sat');
  });

  it('writes a window\'s hours: the next day, and the whole day', () => {
    expect(hoursText({ kind: 'awake', days: ['mon'], start: '08:30', end: '19:00' })).toBe('08:30–19:00');
    expect(hoursText({ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00' })).toBe('20:00–07:00 next day');
    expect(hoursText({ kind: 'nap', days: ['sat'], start: '00:00', end: '00:00' })).toBe('all day (24 hours)');
    expect(hoursText({ kind: 'nap', days: ['mon'], start: '08:00', end: '08:00' })).toBe('08:00–08:00 next day');
  });

  it('labels the next events in the schedule\'s zone', () => {
    // 2026-10-20 05:00 UTC is 07:00 in Paris (summer time).
    expect(eventText({ at: '2026-10-20T05:00:00.000Z', kind: 'nap-end', window: 1 }, 'Europe/Paris')).toBe('Tue 20 Oct, 07:00 · nap window ends');
    expect(eventText({ at: '2026-10-20T06:30:00.000Z', kind: 'awake-start', window: 0 }, 'Europe/Paris')).toBe('Tue 20 Oct, 08:30 · awake window starts');
  });

  it('stores a zone in its canonical case', () => {
    expect(canonicalZone('europe/paris')).toBe('Europe/Paris');
    expect(canonicalZone(' Europe/Paris ')).toBe('Europe/Paris');
    expect(canonicalZone('Nowhere/Land')).toBeNull();
    expect(canonicalZone('')).toBeNull();
  });

  it('refuses a UTC offset as the router does (IANA names only); UTC and Etc/GMT±N are names', () => {
    for (const offset of ['+01:00', '-05:00', '+0100', ' -03:30 ']) expect(canonicalZone(offset), offset).toBeNull();
    expect(canonicalZone('UTC')).toBe('UTC');
    expect(canonicalZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    expect(canonicalZone('etc/gmt-3')).toBe('Etc/GMT-3');
    const windows: ScheduleWindow[] = [{ kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' }];
    expect(formProblem({ timeZone: '+01:00', windows }, '')).toBe('timeZone: an IANA time zone name, such as Europe/Paris, not a UTC offset');
    expect(formProblem({ timeZone: 'Etc/GMT+5', windows }, '')).toBe('');
  });

  it('offers times in 5-minute steps', () => {
    expect(TIMES).toHaveLength(288);
    expect(TIMES[0]).toBe('00:00');
    expect(TIMES[1]).toBe('00:05');
    expect(TIMES.at(-1)).toBe('23:55');
  });

  it('builds the body: canonical zone, no empty fields, wake only on nap windows', () => {
    const form: Schedule = {
      timeZone: 'europe/paris',
      windows: [
        { kind: 'awake', days: ['mon', 'tue'], start: '08:30', end: '19:00', wake: 'header' },
        { kind: 'nap', days: ['sat'], start: '00:00', end: '00:00' },
      ],
      exceptions: [],
      by: 'someone', at: '2026-10-01T00:00:00.000Z',
    };
    expect(scheduleBody(form, '5')).toEqual({
      timeZone: 'Europe/Paris',
      windows: [
        { kind: 'awake', days: ['mon', 'tue'], start: '08:30', end: '19:00' },
        { kind: 'nap', days: ['sat'], start: '00:00', end: '00:00', wake: 'never' },
      ],
      maxNapDays: 5,
    });
    expect(scheduleBody({ ...form, exceptions: ['2026-12-25'] }, '').exceptions).toEqual(['2026-12-25']);
    expect('maxNapDays' in scheduleBody(form, '')).toBe(false);
  });

  it('puts no zone in a schedule without windows (only a maximum nap)', () => {
    expect(scheduleBody({ timeZone: '', windows: [], exceptions: [] }, '7')).toEqual({ windows: [], maxNapDays: 7 });
  });
});

describe('a recurrence in words', () => {
  const nap = (fields: Partial<ScheduleWindow>): ScheduleWindow => ({ kind: 'nap', start: '00:00', end: '00:00', ...fields });
  const hours = (fields: Partial<ScheduleWindow>): ScheduleWindow => ({ kind: 'awake', start: '08:00', end: '18:00', ...fields });

  it('reads the design\'s examples', () => {
    expect(recurrenceText({ kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04' })).toBe('Every 2 weeks on Mon, Thu, 20:00–07:00 next day, from 4 Jan 2027, no end date');
    expect(repeatText(nap({ repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' }))).toBe('Yearly on 25 Dec');
    expect(recurrenceText({ kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } })).toBe('Cron 30 8 * * 1-5, 10 h 30 min');
    expect(recurrenceText(nap({ repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' }))).toBe('Yearly on 25 Dec, all day (24 hours), from 1 Dec 2026, no end date');
  });

  it('reads every pattern', () => {
    const text = (repeat: ScheduleWindow['repeat'], from?: string) => repeatText(hours({ repeat, ...(from ? { from } : {}) }));
    expect(text({ pattern: 'daily' })).toBe('Every day');
    expect(text({ pattern: 'daily', interval: 1 })).toBe('Every day');
    expect(text({ pattern: 'daily', interval: 3 }, '2027-01-04')).toBe('Every 3 days');
    expect(text({ pattern: 'weekly', days: ['thu', 'mon'] })).toBe('Weekly on Mon, Thu');
    expect(text({ pattern: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] })).toBe('Every day');
    expect(text({ pattern: 'weekly', interval: 2, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, '2027-01-04')).toBe('Every 2 weeks, every day');
    expect(text({ pattern: 'monthly', day: 15 })).toBe('Monthly on day 15');
    expect(text({ pattern: 'monthly', interval: 3, day: 15 }, '2027-01-01')).toBe('Every 3 months on day 15');
    expect(text({ pattern: 'monthly', nth: 1, weekday: 'mon' })).toBe('Monthly on the first Mon');
    expect(text({ pattern: 'monthly', interval: 3, nth: -1, weekday: 'sun' }, '2027-01-01')).toBe('Every 3 months on the last Sun');
    expect(text({ pattern: 'monthly', interval: 12, nth: 2, weekday: 'tue' }, '2027-03-01')).toBe('Yearly on the second Tue of Mar');
    expect(text({ pattern: 'cron', cron: ' 0  8 * * * ', minutes: 60 })).toBe('Cron 0 8 * * *');
  });

  it('reads a plain weekly window as it always did', () => {
    const plain = hours({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    expect(repeatText(plain)).toBe('Mon–Fri');
    expect(recurrenceText(plain)).toBe('Mon–Fri, 08:00–18:00');
    expect(recurrenceText(hours({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }))).toBe('Every day, 08:00–18:00');
  });

  it('reads the range: each of from and until alone, and both', () => {
    expect(rangeText(hours({ days: ['mon'] }))).toBe('');
    expect(rangeText(hours({ days: ['mon'], from: '2027-01-04' }))).toBe('from 4 Jan 2027, no end date');
    expect(rangeText(hours({ days: ['mon'], until: '2027-06-30' }))).toBe('until 30 Jun 2027');
    expect(rangeText(hours({ days: ['mon'], from: '2027-01-04', until: '2027-06-30' }))).toBe('from 4 Jan 2027 to 30 Jun 2027');
    expect(dateText('2027-12-05')).toBe('5 Dec 2027');
  });

  it('reads a duration in hours and minutes, days past 24 hours', () => {
    expect(durationText(630)).toBe('10 h 30 min');
    expect(durationText(45)).toBe('45 min');
    expect(durationText(120)).toBe('2 h');
    expect(durationText(1440)).toBe('1 day');
    expect(durationText(1445)).toBe('1 day 5 min');
    expect(durationText(10080)).toBe('7 days');
    expect(hoursText({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 90 } })).toBe('1 h 30 min');
  });

  it('survives a window it cannot read, or a form half filled', () => {
    expect(repeatText({ kind: 'awake', repeat: { pattern: 'hourly' } } as unknown as ScheduleWindow)).toBe('Repeats by hourly');
    expect(repeatText({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', interval: 12, day: 25 } })).toBe('Every 12 months on day 25');
    expect(durationText(NaN)).toBe('');
    const blank = (repeat: unknown) => repeatText({ kind: 'awake', start: '08:00', end: '09:00', repeat: repeat as ScheduleWindow['repeat'], from: '2027-12-01' });
    expect(blank({ pattern: 'daily', interval: NaN })).toBe('Every … days');
    expect(blank({ pattern: 'weekly', interval: NaN, days: ['mon'] })).toBe('Every … weeks on Mon');
    expect(blank({ pattern: 'monthly', interval: NaN, day: 3 })).toBe('Every … months on day 3');
    expect(blank({ pattern: 'monthly', day: NaN })).toBe('Monthly on day …');
    expect(blank({ pattern: 'monthly' })).toBe('Monthly on day …');
    expect(blank({ pattern: 'monthly', interval: 12, day: NaN })).toBe('Yearly on … Dec');
    expect(daysText([])).toBe('');
    expect(repeatText({ kind: 'awake', start: '08:00', end: '09:00' })).toBe('');
  });

  it('reads an occurrence in the schedule\'s zone, the year on its first day only', () => {
    const at = Date.parse;
    expect(occurrenceText({ start: at('2027-01-04T07:00:00Z'), end: at('2027-01-04T11:00:00Z') }, 'Europe/Paris')).toBe('Mon 4 Jan 2027, 08:00–12:00');
    expect(occurrenceText({ start: at('2027-01-04T19:00:00Z'), end: at('2027-01-05T06:00:00Z') }, 'Europe/Paris')).toBe('Mon 4 Jan 2027, 20:00 – Tue 5 Jan, 07:00');
    expect(occurrenceText({ start: at('2027-01-04T19:00:00Z'), end: at('2027-01-05T06:00:00Z') }, 'UTC')).toBe('Mon 4 Jan 2027, 19:00 – Tue 5 Jan, 06:00');
  });
});

describe('the body of a recurring window', () => {
  const stored: ScheduleWindow[] = [
    { kind: 'awake', days: ['mon', 'fri'], start: '08:30', end: '19:00' },
    { kind: 'awake', days: ['mon'], start: '08:30', end: '19:00', from: '2027-01-04', until: '2027-02-01' },
    { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
    { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
    { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'weekly', days: ['tue'] } },
    { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 1, day: 15 } },
    { kind: 'awake', start: '08:00', end: '18:00', repeat: { pattern: 'monthly', interval: 3, nth: 1, weekday: 'mon' }, from: '2027-01-01' },
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01', wake: 'never' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
  ];

  it('a window read back and saved again stays what it was', () => {
    expect(scheduleBody({ timeZone: 'UTC', windows: stored }, '').windows).toEqual(stored);
    expect(scheduleBody({ timeZone: 'UTC', windows: JSON.parse(JSON.stringify(stored)) }, '').windows).toEqual(stored);
  });

  it('drops the empty fields, null and blank, and what a kind or pattern does not take', () => {
    const blank = { kind: 'awake', days: null, start: '08:00', end: '09:00', from: '', until: null, wake: 'never', repeat: { pattern: 'monthly', interval: null, day: null, nth: -1, weekday: 'sun' } } as unknown as ScheduleWindow;
    expect(windowBody(blank)).toEqual({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', nth: -1, weekday: 'sun' } });
    expect(windowBody({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: null, until: null, repeat: null } as unknown as ScheduleWindow)).toEqual({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' });
    expect(windowBody({ kind: 'awake', days: [], start: '08:00', end: '09:00', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } })).toEqual({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } });
    expect(windowBody({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'weekly', days: ['fri', 'mon'] } }).repeat).toEqual({ pattern: 'weekly', days: ['mon', 'fri'] });
  });

  it('keeps the old checks for the form, and a window without days raises none', () => {
    for (const w of stored) expect(formProblem({ timeZone: 'UTC', windows: [w] }, ''), JSON.stringify(w)).toBe('');
  });
});

describe('the helper\'s changes to a window', () => {
  const today = '2026-11-03';
  const plain: ScheduleWindow = { kind: 'nap', days: ['mon', 'thu'], start: '20:00', end: '07:00', wake: 'header' };
  const memoryOf = () => ({ ...newMemory(), days: ['mon', 'tue'] as NonNullable<ScheduleWindow['days']>, start: '09:00', end: '17:00' });

  it('reads which choice a window is', () => {
    expect(repeatChoice(plain)).toBe('weekly');
    expect(repeatChoice({ ...plain, days: undefined, repeat: { pattern: 'weekly', interval: 2, days: ['mon'] } })).toBe('weekly');
    expect(repeatChoice({ ...plain, repeat: { pattern: 'daily' } })).toBe('daily');
    expect(repeatChoice({ ...plain, repeat: { pattern: 'monthly', day: 1 } })).toBe('monthly');
    expect(repeatChoice({ ...plain, repeat: { pattern: 'monthly', interval: 12, day: 1 } })).toBe('yearly');
    expect(repeatChoice({ ...plain, repeat: { pattern: 'monthly', interval: 24, day: 1 } })).toBe('monthly');
    expect(repeatChoice({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } })).toBe('cron');
    expect(repeatChoice({ kind: 'awake', repeat: { pattern: 'hourly' } } as unknown as ScheduleWindow)).toBeNull();
  });

  it('moves to each pattern, keeping the kind, the wake, the times and the range', () => {
    const ranged = { ...plain, until: '2027-06-30' };
    expect(withChoice(ranged, 'daily', today, memoryOf())).toEqual({ kind: 'nap', wake: 'header', until: '2027-06-30', start: '20:00', end: '07:00', repeat: { pattern: 'daily' } });
    expect(withChoice(ranged, 'monthly', today, memoryOf())).toEqual({ kind: 'nap', wake: 'header', until: '2027-06-30', start: '20:00', end: '07:00', repeat: { pattern: 'monthly', day: 3 } });
  });

  it('yearly needs a start date: today, its day the month\'s, unless one is set', () => {
    expect(withChoice(plain, 'yearly', today, memoryOf())).toMatchObject({ from: today, repeat: { pattern: 'monthly', interval: 12, day: 3 } });
    expect(withChoice({ ...plain, from: '2027-12-25' }, 'yearly', today, memoryOf())).toMatchObject({ from: '2027-12-25', repeat: { pattern: 'monthly', interval: 12, day: 25 } });
    expect(withChoice({ ...plain, repeat: { pattern: 'monthly', nth: 2, weekday: 'tue' }, days: undefined }, 'yearly', today, memoryOf()).repeat).toEqual({ pattern: 'monthly', interval: 12, nth: 2, weekday: 'tue' });
    expect(withChoice({ ...plain, repeat: { pattern: 'monthly', interval: 12, day: 9 }, days: undefined, from: today }, 'monthly', today, memoryOf()).repeat).toEqual({ pattern: 'monthly', day: 9 });
  });

  it('a cron starts from the window\'s start, days and length, and drops the times', () => {
    expect(withChoice(plain, 'cron', today, memoryOf())).toEqual({ kind: 'nap', wake: 'header', repeat: { pattern: 'cron', cron: '0 20 * * 1,4', minutes: 660 } });
    expect(withChoice({ kind: 'awake', start: '08:30', end: '08:30', repeat: { pattern: 'daily' } }, 'cron', today, memoryOf())).toEqual({ kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * *', minutes: 1440 } });
  });

  it('comes back from a cron to the times and days it remembers', () => {
    const cron: ScheduleWindow = { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } };
    expect(withChoice(cron, 'weekly', today, memoryOf())).toEqual({ kind: 'awake', days: ['mon', 'tue'], start: '09:00', end: '17:00' });
    const memory = memoryOf();
    const there = withChoice({ ...plain, kind: 'awake', wake: undefined, start: '06:00', end: '07:00' }, 'cron', today, memory);
    expect(withChoice(there, 'daily', today, memory)).toMatchObject({ start: '06:00', end: '07:00' });
  });

  // A slip on the select loses nothing: out through every other pattern and back gives the very window it left.
  const WINDOWS: [string, ScheduleWindow][] = [
    ['plain days', { kind: 'awake', days: ['sat', 'sun'], start: '08:00', end: '09:00' }],
    ['plain days in a range', { kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: '2027-01-04', until: '2027-02-01' }],
    ['every 3 days', { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' }],
    ['every 2 weeks', { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', wake: 'header' }],
    ['a weekly repeat of interval 1', { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'weekly', days: ['tue'] } }],
    ['every 3 months on the last Fri', { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', interval: 3, nth: -1, weekday: 'fri' }, from: '2027-01-01' }],
    ['monthly with a stored interval 1', { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', interval: 1, day: 15 } }],
    ['yearly on 25 Dec', { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01', wake: 'never' }],
    ['a cron', { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 1 * 1-5', minutes: 630 } }],
  ];
  const CHOICES: RepeatChoice[] = ['weekly', 'daily', 'monthly', 'yearly', 'cron'];
  for (const [name, w] of WINDOWS) {
    it(`${name}: out to each pattern and back is what it was`, () => {
      const own = repeatChoice(w)!;
      for (const other of CHOICES.filter((c) => c !== own)) {
        const memory = newMemory();
        expect(withChoice(withChoice(w, other, today, memory), own, today, memory), other).toEqual(w);
      }
      const memory = newMemory();
      let through = w;
      for (const other of [...CHOICES.filter((c) => c !== own), own]) through = withChoice(through, other, today, memory);
      expect(through, 'through all of them').toEqual(w);
    });
  }

  it('each pattern keeps its own: a monthly\'s day is not overwritten by a yearly\'s, once each has one', () => {
    const memory = newMemory();
    const monthly: ScheduleWindow = { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', day: 9 } };
    const yearly = withChoice(monthly, 'yearly', today, memory);
    expect(yearly.repeat).toEqual({ pattern: 'monthly', interval: 12, day: 9 });
    const changed = { ...yearly, repeat: { pattern: 'monthly', interval: 12, day: 25 } } as ScheduleWindow;
    expect(withChoice(changed, 'monthly', today, memory).repeat).toEqual({ pattern: 'monthly', day: 9 });
    expect(withChoice(withChoice(changed, 'monthly', today, memory), 'yearly', today, memory).repeat).toEqual({ pattern: 'monthly', interval: 12, day: 25 });
  });

  it('an interval above 1 sets the start date, and a weekly window takes a repeat for it; back at 1 a plain one again', () => {
    const memory = newMemory();
    const two = withInterval(plain, 2, today, memory);
    expect(two).toEqual({ kind: 'nap', wake: 'header', start: '20:00', end: '07:00', from: today, repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] } });
    expect(withInterval(two, 1, today, memory)).toEqual(plain);
    expect(withInterval({ ...plain, days: undefined, repeat: { pattern: 'daily' } }, 3, today, newMemory())).toMatchObject({ from: today, repeat: { pattern: 'daily', interval: 3 } });
    expect(withInterval({ ...plain, days: undefined, repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-01' }, 1, today, newMemory())).toMatchObject({ from: '2027-01-01', repeat: { pattern: 'daily' } });
    expect(withInterval({ ...plain, days: undefined, repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-01' }, 1, today, newMemory()).repeat).toEqual({ pattern: 'daily' });
    expect(withInterval({ ...plain, days: undefined, repeat: { pattern: 'daily' } }, NaN, today, newMemory()).repeat).toEqual({ pattern: 'daily', interval: NaN });
  });

  it('a start date the helper filled in goes with what needed it; one stored or chosen stays', () => {
    const filled = newMemory();
    expect(withInterval(withInterval(plain, 2, today, filled), 1, today, filled).from).toBeUndefined();
    const blankOnTheWay = newMemory();
    const typing = withInterval(withInterval(plain, 2, today, blankOnTheWay), NaN, today, blankOnTheWay);
    expect(typing.from).toBe(today);
    const stored = newMemory();
    expect(withInterval(withInterval({ ...plain, from: '2027-01-04' }, 2, today, stored), 1, today, stored).from).toBe('2027-01-04');
    const chosen = newMemory();
    const moved = withFrom(withInterval(plain, 2, today, chosen), '2027-02-01', chosen);
    expect(withInterval(moved, 1, today, chosen).from).toBe('2027-02-01');
    const again = newMemory();
    const same = withFrom(withInterval(plain, 2, today, again), today, again);
    expect(withInterval(same, 1, today, again).from).toBe(today);
    // Leaving for a pattern that does not count from it too: a plain window any router reads.
    const leaving = newMemory();
    expect(withChoice(withChoice(plain, 'yearly', today, leaving), 'weekly', today, leaving)).toEqual(plain);
    expect(withChoice(withChoice(plain, 'yearly', today, leaving), 'cron', today, leaving).from).toBeUndefined();
  });

  it('a yearly or monthly day the helper filled in follows the start date, until the user edits it', () => {
    const memory = newMemory();
    const yearly = withChoice(plain, 'yearly', '2026-11-01', memory);
    expect(yearly.repeat).toEqual({ pattern: 'monthly', interval: 12, day: 1 });
    const moved = withFrom(yearly, '2026-12-25', memory);
    expect(moved.from).toBe('2026-12-25');
    expect(moved.repeat).toEqual({ pattern: 'monthly', interval: 12, day: 25 });
    expect(repeatText(moved)).toBe('Yearly on 25 Dec');
    expect(withFrom(moved, '', memory).from).toBeUndefined();
    expect(withFrom(moved, '', memory).repeat).toEqual({ pattern: 'monthly', interval: 12, day: 25 });
    const monthly = newMemory();
    expect(withFrom(withChoice(plain, 'monthly', '2026-11-01', monthly), '2027-01-15', monthly).repeat).toEqual({ pattern: 'monthly', day: 15 });
  });

  it('a stored day, or one on a weekday, stays where it is', () => {
    const stored: ScheduleWindow = { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01' };
    expect(withFrom(stored, '2027-12-03', newMemory()).repeat).toEqual(stored.repeat);
    const memory = newMemory();
    const onWeekday = { ...withChoice(plain, 'yearly', today, memory), repeat: { pattern: 'monthly', interval: 12, nth: 1, weekday: 'mon' } } as ScheduleWindow;
    expect(withFrom(onWeekday, '2027-12-03', memory).repeat).toEqual(onWeekday.repeat);
  });

  it('a day the user edited stays, through a slip on the select too', () => {
    const memory = newMemory();
    const yearly = withChoice(plain, 'yearly', today, memory);
    memory.filledDay.yearly = false;
    const edited = { ...yearly, repeat: { pattern: 'monthly', interval: 12, day: 7 } } as ScheduleWindow;
    expect(withFrom(edited, '2026-12-25', memory).repeat).toEqual(edited.repeat);
    expect(withFrom(withChoice(withChoice(edited, 'daily', today, memory), 'yearly', today, memory), '2027-03-25', memory).repeat).toEqual(edited.repeat);
  });
});

describe('Do not repeat', () => {
  const once: ScheduleWindow = { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: '2027-01-04', until: '2027-01-04' };
  const today = '2026-11-03';

  it('is a daily window, interval 1, from equal to until, and reads in its own words', () => {
    expect(isOnce(once)).toBe(true);
    expect(repeatChoice(once)).toBe('once');
    expect(isOnce({ ...once, repeat: { pattern: 'daily', interval: 1 } })).toBe(true);
    expect(recurrenceText(once)).toBe('Once on 4 Jan 2027, 08:00–12:00');
    expect(rangeText(once)).toBe('');
    expect(recurrenceText({ ...once, start: '20:00', end: '07:00' })).toBe('Once on 4 Jan 2027, 20:00–07:00 next day');
    expect(recurrenceText({ ...once, start: '00:00', end: '00:00' })).toBe('Once on 4 Jan 2027, all day (24 hours)');
  });

  it('any other shape is not it', () => {
    expect(isOnce({ ...once, until: '2027-01-05' })).toBe(false);
    expect(isOnce({ ...once, repeat: { pattern: 'daily', interval: 2 } })).toBe(false);
    const { until: _, ...open } = once;
    expect(isOnce(open)).toBe(false);
    expect(isOnce({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', from: '2027-01-04', until: '2027-01-04' })).toBe(false);
    expect(isOnce({ ...once, repeat: { pattern: 'monthly', day: 4 } })).toBe(false);
  });

  it('a window read back stays what it was', () => {
    expect(windowBody(once)).toEqual(once);
    const explicit = { ...once, repeat: { pattern: 'daily' as const, interval: 1 } };
    expect(windowBody(explicit)).toEqual(explicit);
  });

  it('starts on the selection\'s day, else a start date already set, else today', () => {
    const plain: ScheduleWindow = { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' };
    expect(withChoice(plain, 'once', today, newMemory())).toEqual({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: today, until: today });
    expect(withChoice({ ...plain, from: '2027-03-01' }, 'once', today, newMemory())).toMatchObject({ from: '2027-03-01', until: '2027-03-01' });
    expect(withChoice(plain, 'once', today, { ...newMemory(), onceDate: '2027-05-05' })).toMatchObject({ from: '2027-05-05', until: '2027-05-05' });
  });

  it('a slip on the select loses nothing, on either side', () => {
    const ranged: ScheduleWindow = { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00', from: '2027-03-01', until: '2027-04-01' };
    const memory = newMemory();
    const there = withChoice(ranged, 'once', today, memory);
    expect(there).toMatchObject({ from: '2027-03-01', until: '2027-03-01' });
    expect(withChoice(there, 'weekly', today, memory)).toEqual(ranged);
    const other = newMemory();
    const away = withChoice(once, 'monthly', today, other);
    expect(away.until).toBeUndefined();
    expect(away.from).toBe('2027-01-04');
    expect(withChoice(away, 'once', today, other)).toEqual(once);
    for (const c of ['weekly', 'daily', 'yearly', 'cron'] as RepeatChoice[]) {
      const m = newMemory();
      expect(withChoice(withChoice(once, c, today, m), 'once', today, m), c).toEqual(once);
    }
    // Through Do not repeat, a start date the helper filled in comes back too.
    const two = newMemory();
    const every2 = withInterval(ranged, 2, today, two);
    expect(withChoice(withChoice(every2, 'once', today, two), 'weekly', today, two)).toEqual(every2);
  });

  it('its date moves both ends together, and a date the helper chose is not dropped as a filled-in one', () => {
    expect(withOnceDate(once, '2027-02-02')).toMatchObject({ from: '2027-02-02', until: '2027-02-02' });
    expect(repeatChoice(withOnceDate(once, ''))).toBe('once');
    const memory = newMemory();
    const yearly = withChoice({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }, 'yearly', today, memory);
    expect(withChoice(yearly, 'once', today, memory)).toMatchObject({ from: today, until: today });
  });
});

describe('a moved window in words', () => {
  it('says every occurrence, the sentence running on', () => {
    expect(movedText('Shop', { kind: 'awake', days: ['mon', 'tue'], start: '09:00', end: '10:00' })).toBe('Window moved: every occurrence of Shop now runs Mon, Tue, 09:00–10:00');
    expect(movedText('Shop', { kind: 'awake', start: '09:00', end: '10:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' })).toBe('Window moved: every occurrence of Shop now runs every 3 days, 09:00–10:00, from 4 Jan 2027, no end date');
    expect(movedText('Shop', { kind: 'awake', start: '09:00', end: '10:00', repeat: { pattern: 'daily' }, from: '2027-01-04', until: '2027-01-04' })).toBe('Window moved: every occurrence of Shop now runs once on 4 Jan 2027, 09:00–10:00');
  });
});

describe('a refusal of an older router', () => {
  it('adds that recurrences need router 0.36.0 when a recurrence field is unknown to it', () => {
    expect(recurrenceError('windows[0].repeat: unknown field')).toBe('windows[0].repeat: unknown field. Recurrences need router 0.36.0 or later.');
    expect(recurrenceError('windows[0].days: one or more of mon; windows[2].from: unknown field; windows[2].until: unknown field')).toContain('Recurrences need router 0.36.0');
  });

  it('leaves any other message as it is', () => {
    expect(recurrenceError('')).toBe('');
    expect(recurrenceError('boom')).toBe('boom');
    expect(recurrenceError('windows[0].other: unknown field')).toBe('windows[0].other: unknown field');
  });
});

describe('history causes', () => {
  it('words the schedule and the maintenance wakes', () => {
    expect(causeText({ state: 'NAPPING', cause: 'schedule' })).toBe('a scheduled window');
    expect(causeText({ state: 'WAKING', cause: 'schedule' })).toBe('a scheduled window');
    expect(causeText({ state: 'WAKING', cause: 'maintenance' })).toBe('the maximum nap (a maintenance wake)');
  });
});

describe('the demo\'s schedule events', () => {
  it('lists the next boundaries in the zone, in order', async () => {
    const { nextEvents } = await import('../src/mock/schedule');
    const s: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon', 'tue'], start: '08:30', end: '19:00' }, { kind: 'nap', days: ['mon'], start: '20:00', end: '07:00' }] };
    // Sunday 2026-10-18 12:00 UTC: Monday 08:30 Paris is 06:30 UTC (summer time).
    const events = nextEvents(s, Date.parse('2026-10-18T12:00:00Z'));
    expect(events.map((e) => [e.at, e.kind, e.window])).toEqual([
      ['2026-10-19T06:30:00.000Z', 'awake-start', 0],
      ['2026-10-19T17:00:00.000Z', 'awake-end', 0],
      ['2026-10-19T18:00:00.000Z', 'nap-start', 1],
      ['2026-10-20T05:00:00.000Z', 'nap-end', 1],
      ['2026-10-20T06:30:00.000Z', 'awake-start', 0],
    ]);
  });
});
