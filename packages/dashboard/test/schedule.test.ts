import { describe, expect, it } from 'vitest';
import { canonicalZone, daysText, eventText, hoursText, scheduleBody, TIMES, type Schedule } from '../src/schedule';
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
