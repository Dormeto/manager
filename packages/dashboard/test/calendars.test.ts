import { beforeEach, describe, expect, it } from 'vitest';
import { CALENDAR_EVENTS_MAX, PALETTE, calendarEvents, cappedText, colorFor, naturalCompare, contrast, eventsFor, freeColor, loadSaved, saveSaved, supportsSchedules, type Calendar } from '../src/calendars';
import type { Day } from '../src/schedule';

const paris: Calendar = {
  key: 'r/a', name: 'Shop', color: '#112233', state: 'ASLEEP', maintenanceDue: '2026-10-21T10:00:00.000Z',
  schedule: { timeZone: 'Europe/Paris', maxNapDays: 7, windows: [
    { kind: 'awake', days: ['wed'], start: '08:00', end: '19:00' },
    { kind: 'nap', days: ['wed'], start: '20:00', end: '07:00', wake: 'header' },
    { kind: 'nap', days: ['thu'], start: '20:00', end: '07:00' },
  ] },
};
const day = Date.UTC(2026, 9, 21);
const DARK_SURFACE = '#0d1422';

describe('sorting workloads', () => {
  it('is natural and ignores case', () => {
    expect(['w-10', 'W-3', 'b', 'w-2', 'A'].sort(naturalCompare)).toEqual(['A', 'b', 'w-2', 'W-3', 'w-10']);
  });
});

describe('palette', () => {
  it('repeats past its end and picks the first free slot', () => {
    expect(colorFor(0)).toBe(PALETTE[0]);
    expect(colorFor(PALETTE.length)).toBe(PALETTE[0]);
    expect(freeColor([0, 1, 3])).toBe(2);
    expect(freeColor(PALETTE.map((_, i) => i))).toBe(PALETTE.length);
  });
});

describe('palette contrast', () => {
  it('reads with white text as a fill, and as an outlined text on each theme', () => {
    for (const c of PALETTE) expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(4.5);
    for (const c of ['#112233', ...PALETTE]) {
      expect(contrast(eventsFor([{ ...paris, color: c }], day, day + 86_400_000, 'Europe/Paris', true).find((e) => e.extendedProps.kind === 'nap')!.textColor, DARK_SURFACE), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(eventsFor([{ ...paris, color: c }], day, day + 86_400_000, 'Europe/Paris', false).find((e) => e.extendedProps.kind === 'nap')!.textColor, '#ffffff'), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('router support', () => {
  it('needs 0.31.0, and takes an unknown version as supported', () => {
    expect(supportsSchedules('0.30.9')).toBe(false);
    expect(supportsSchedules('0.31.0')).toBe(true);
    expect(supportsSchedules('0.31.1-dev.2')).toBe(true);
    expect(supportsSchedules('1.0.0')).toBe(true);
    expect(supportsSchedules(null)).toBe(true);
  });
});

describe('saved calendars', () => {
  beforeEach(() => window.localStorage.clear());
  it('are kept per user and ignore a damaged value', () => {
    saveSaved('u1', { enabled: [{ key: 'r/a', color: 2 }], last: 'r/a', view: 'week' });
    expect(loadSaved('u1')).toEqual({ enabled: [{ key: 'r/a', color: 2 }], last: 'r/a', view: 'week' });
    expect(loadSaved('u2')).toEqual({ enabled: [] });
    window.localStorage.setItem('dm-schedules:u3', '{oops');
    expect(loadSaved('u3')).toEqual({ enabled: [] });
    window.localStorage.setItem('dm-schedules:u4', JSON.stringify({ enabled: [{ key: 3 }, { key: 'x/y', color: 1 }] }));
    expect(loadSaved('u4').enabled).toEqual([{ key: 'x/y', color: 1 }]);
    saveSaved('u5', { enabled: Array.from({ length: 25 }, (_, i) => ({ key: `r/${i}`, color: i % 12 })) });
    expect(loadSaved('u5').enabled.map((e) => e.key)).toEqual(Array.from({ length: 20 }, (_, i) => `r/${i}`));
  });
});

describe('eventsFor past occurrences', () => {
  it('marks the occurrences that ended before now as dm-past', () => {
    const wed = eventsFor([paris], day, day + 86_400_000, 'Europe/Paris', false, day + 12 * 3_600_000).filter((e) => e.extendedProps.kind === 'awake');
    expect(wed).toHaveLength(1);
    expect(wed[0]!.classNames).not.toContain('dm-past');
    expect(eventsFor([paris], day, day + 86_400_000, 'Europe/Paris', false, day + 20 * 3_600_000).find((e) => e.extendedProps.kind === 'awake')!.classNames).toContain('dm-past');
  });
});

describe('eventsFor', () => {
  // A fixed clock before the fixtures, so nothing reads as past whatever the real date is.
  const events = eventsFor([paris], day, day + 2 * 86_400_000, 'Europe/Paris', false, day - 86_400_000);
  it('fills awake windows and outlines naps, with their titles', () => {
    const by = Object.fromEntries(events.map((e) => [e.title, e]));
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['Shop · Awake', 'Shop · Nap (wake: header)', 'Shop · Nap']));
    expect(by['Shop · Awake']).toMatchObject({ backgroundColor: '#112233', textColor: '#ffffff', classNames: ['dm-ev', 'dm-ev--awake'] });
    expect(by['Shop · Nap (wake: header)']).toMatchObject({ backgroundColor: 'transparent', borderColor: '#112233', textColor: '#112233', classNames: ['dm-ev', 'dm-ev--nap'] });
    expect(by['Shop · Awake']!.start.toISOString()).toBe('2026-10-21T06:00:00.000Z');
  });
  it('marks the maintenance due of an asleep workload with a maximum nap, and only then', () => {
    expect(events.find((e) => e.extendedProps.kind === 'maintenance')?.title).toBe('Shop · maintenance due');
    expect(eventsFor([{ ...paris, state: 'AWAKE' }], day, day + 2 * 86_400_000, 'Europe/Paris').some((e) => e.extendedProps.kind === 'maintenance')).toBe(false);
  });
  it('gives the schedule\'s own zone in the tooltip only when it differs from the browser\'s', () => {
    expect(events.find((e) => e.title === 'Shop · Awake')!.extendedProps.tip().join(' | ')).not.toContain('Europe/Paris');
    const ny = eventsFor([paris], day, day + 86_400_000, 'America/New_York').find((e) => e.title === 'Shop · Awake')!;
    expect(ny.extendedProps.tip().join(' | ')).toContain('Wed 08:00–19:00 Europe/Paris');
  });
  it('draws a recurring window, and says its recurrence in the tooltip', () => {
    const c: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: [
      { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
      { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
      { kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily' }, until: '2020-01-01' },
    ] } };
    const from = Date.UTC(2027, 0, 4);
    const drawn = eventsFor([c], from, from + 2 * 86_400_000, 'UTC', false, from);
    expect(drawn.map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Blog · Awake', '2027-01-04T08:30:00.000Z'],
      ['Blog · Nap (wake: header)', '2027-01-04T20:00:00.000Z'],
      ['Blog · Awake', '2027-01-05T08:30:00.000Z'],
    ]);
    expect(drawn[0]!.extendedProps.tip()).toEqual(['Blog · Awake', 'Cron 30 8 * * 1-5, 10 h 30 min', 'Mon 08:30–19:00', 'A cron window can\'t be dragged: edit it in the dialog.']);
    expect(drawn[1]!.extendedProps.tip().slice(0, 3)).toEqual(['Blog · Nap (wake: header)', 'Every 2 weeks on Mon, Thu, 20:00–07:00 next day, from 4 Jan 2027 to 30 Jun 2027', 'Mon 20:00–07:00']);
  });
  it('draws the touching starts of a frequent cron window as one bar, not one a start', () => {
    const c: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: [
      { kind: 'awake', repeat: { pattern: 'cron', cron: '*/5 8-9 * * *', minutes: 5 } },
      { kind: 'awake', repeat: { pattern: 'cron', cron: '0,30 12 * * *', minutes: 5 } },
    ] } };
    const from = Date.UTC(2027, 0, 4);
    const drawn = eventsFor([c], from, from + 86_400_000, 'UTC', false, from);
    expect(drawn.map((e) => [e.start.toISOString().slice(11, 16), e.end.toISOString().slice(11, 16)])).toEqual([['08:00', '10:00'], ['12:00', '12:05'], ['12:30', '12:35']]);
    expect(new Set(drawn.map((e) => e.id)).size).toBe(3);
  });
  it('keeps the touching days of a plain window apart, as it always drew them', () => {
    const c: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00' }] } };
    const from = Date.UTC(2027, 0, 9);
    expect(eventsFor([c], from, from + 2 * 86_400_000, 'UTC', false, from)).toHaveLength(2);
  });
  it('gives a bar or a long occurrence its real span in the tooltip, dates included', () => {
    const c: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 3 1 *', minutes: 11520 / 2 } }, { kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * 2 *', minutes: 1440 } }] } };
    const from = Date.UTC(2027, 0, 1);
    const [long] = eventsFor([c], from, from + 10 * 86_400_000, 'Europe/Paris', false, from);
    expect(long!.extendedProps.tip().join(' | ')).toContain('Sun 3 Jan 08:00–Thu 7 Jan 08:00 UTC');
    const feb = Date.UTC(2027, 1, 1);
    const [bar] = eventsFor([c], feb, feb + 9 * 86_400_000, 'Europe/Paris', false, feb);
    expect(bar!.start.toISOString()).toBe('2027-02-01T08:00:00.000Z');
    expect(bar!.extendedProps.tip().join(' | ')).toContain('Mon 1 Feb 08:00–Wed 10 Feb 08:00 UTC');
    // Up to a day it reads as it always did, a 24-hour one on a clock change included.
    const day: Calendar = { key: 'r/d', name: 'Day', color: '#112233', schedule: { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['sun'], start: '00:00', end: '00:00' }] } };
    const autumn = Date.parse('2026-10-25T00:00:00+02:00');
    expect(eventsFor([day], autumn, autumn + 3_600_000, 'UTC', false, autumn)[0]!.extendedProps.tip().join(' | ')).toContain('Sun 00:00–00:00 Europe/Paris');
  });
  it('says in the tooltip what it is, and only a window a user may edit, with a start to move, can be dragged', () => {
    const c: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', canEdit: true, state: 'ASLEEP', maintenanceDue: '2027-01-04T10:00:00.000Z', schedule: { timeZone: 'UTC', maxNapDays: 7, windows: [
      { kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' },
      { kind: 'nap', repeat: { pattern: 'cron', cron: '*/5 12 * * *', minutes: 5 } },
    ] } };
    const from = Date.UTC(2027, 0, 4);
    const of = (calendar: Calendar) => calendarEvents([calendar], from, from + 86_400_000, 'UTC', false, from).events;
    const [plain, due] = [...of(c)].sort((a, b) => a.start.getTime() - b.start.getTime());
    expect(plain!.startEditable).toBe(true);
    expect(plain!.durationEditable).toBe(false);
    expect(plain!.extendedProps.tip()).toEqual(['Blog · Awake', 'Mon, 08:00–09:00', 'Mon 08:00–09:00', 'Drag to move every occurrence of this window.']);
    expect(due!.extendedProps.kind).toBe('maintenance');
    expect(due!.startEditable).toBe(false);
    const cron = of(c).find((e) => e.extendedProps.kind === 'nap')!;
    expect(cron.startEditable).toBe(false);
    expect(cron.extendedProps.tip().at(-1)).toBe('A cron window can\'t be dragged: edit it in the dialog.');
    const read = of({ ...c, canEdit: false }).find((e) => e.extendedProps.kind === 'awake')!;
    expect(read.startEditable).toBe(false);
    expect(read.extendedProps.tip().at(-1)).toBe('You may not edit this workload: it can\'t be dragged.');
  });
  it('draws at most so many occurrences of a calendar, the first ones, and says how many it has', () => {
    const dense: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: Array.from({ length: 20 }, () => ({ kind: 'awake' as const, repeat: { pattern: 'cron' as const, cron: '0,10,20,30,40,50 * * * *', minutes: 5 } })) } };
    const from = Date.UTC(2027, 0, 4);
    const to = from + 42 * 86_400_000;
    const { events: drawn, capped } = calendarEvents([dense, paris], from, to, 'UTC', false, from);
    expect(drawn.filter((e) => e.extendedProps.key === 'r/b')).toHaveLength(CALENDAR_EVENTS_MAX);
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({ key: 'r/b', name: 'Blog' });
    expect(cappedText(capped, 'UTC')).toBe(`Blog: only the first ${CALENDAR_EVENTS_MAX.toLocaleString('en-US')} occurrences are drawn here, up to 4 Jan. Too many to draw, and the schedule applies in full.`);
    const starts = drawn.filter((e) => e.extendedProps.key === 'r/b').map((e) => e.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[0]).toBe(from);
    expect(drawn.some((e) => e.extendedProps.key === 'r/a'), 'another calendar keeps its own').toBe(true);
  });
  it('reads no further than it draws: 20 such calendars stay quick', () => {
    const dense = (i: number): Calendar => ({ key: `r/${i}`, name: `w${i}`, color: '#112233', schedule: { timeZone: 'UTC', windows: Array.from({ length: 20 }, () => ({ kind: 'awake' as const, repeat: { pattern: 'cron' as const, cron: '0,10,20,30,40,50 * * * *', minutes: 5 } })) } });
    const from = Date.UTC(2027, 0, 4);
    const begin = performance.now();
    const { events: drawn, capped } = calendarEvents(Array.from({ length: 20 }, (_, i) => dense(i)), from, from + 42 * 86_400_000, 'UTC', false, from);
    expect(performance.now() - begin).toBeLessThan(1000);
    expect(drawn).toHaveLength(20 * CALENDAR_EVENTS_MAX);
    expect(capped).toHaveLength(20);
  });
  it('an hourly cron window on a month view is not cut, nor a bar that merges down below the cap', () => {
    const c = (cron: string): Calendar => ({ key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron, minutes: 5 } }] } });
    const from = Date.UTC(2027, 0, 4);
    const to = from + 42 * 86_400_000;
    expect(calendarEvents([c('0 * * * *')], from, to, 'UTC', false, from).capped).toEqual([]);
    expect(calendarEvents([c('*/5 * * * *')], from, to, 'UTC', false, from).events).toHaveLength(1);
  });
  it('a plain schedule at its largest is never cut: 20 windows on every day of a month view', () => {
    const full: Calendar = { key: 'r/b', name: 'Blog', color: '#112233', schedule: { timeZone: 'UTC', windows: Array.from({ length: 20 }, () => ({ kind: 'awake' as const, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as Day[], start: '08:00', end: '09:00' })) } };
    const from = Date.UTC(2027, 0, 4);
    const { events: drawn, capped } = calendarEvents([full], from, from + 42 * 86_400_000, 'UTC', false, from);
    expect(drawn).toHaveLength(840);
    expect(capped).toEqual([]);
  });
  it('draws nothing for a calendar without a schedule', () => {
    expect(eventsFor([{ key: 'r/b', name: 'B', color: '#000', schedule: null }], day, day + 86_400_000)).toEqual([]);
  });
});
