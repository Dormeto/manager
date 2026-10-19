import { beforeEach, describe, expect, it } from 'vitest';
import { PALETTE, colorFor, contrast, eventsFor, freeColor, loadSaved, saveSaved, supportsSchedules, type Calendar } from '../src/calendars';

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
  });
});

describe('eventsFor', () => {
  const events = eventsFor([paris], day, day + 2 * 86_400_000, 'Europe/Paris');
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
    expect(events.find((e) => e.title === 'Shop · Awake')!.extendedProps.tip).toBe('Shop · Awake');
    const ny = eventsFor([paris], day, day + 86_400_000, 'America/New_York').find((e) => e.title === 'Shop · Awake')!;
    expect(ny.extendedProps.tip).toContain('Wed 08:00–19:00 Europe/Paris');
  });
  it('draws nothing for a calendar without a schedule', () => {
    expect(eventsFor([{ key: 'r/b', name: 'B', color: '#000', schedule: null }], day, day + 86_400_000)).toEqual([]);
  });
});
