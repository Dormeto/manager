import { describe, expect, it } from 'vitest';
import { causeText, collapseRows, dayRows, MIN_WIDTH } from '../src/history';

// Local times: the rows follow the viewer's days.
const local = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).toISOString();

describe('history rows', () => {
  it('a row per local day, a phase crossing midnight split in two', () => {
    const rows = dayRows([{ state: 'ASLEEP', from: local(7, 20), to: local(8, 8) }, { state: 'AWAKE', from: local(8, 8), to: local(8, 12) }], local(7, 12), local(8, 12));
    expect(rows.map((r) => r.day.getDate())).toEqual([7, 8]);
    expect(rows[0]!.segments.map((s) => [s.state, Math.round(s.left), Math.round(s.width)])).toEqual([['ASLEEP', 83, 17]]);
    expect(rows[1]!.segments.map((s) => [s.state, Math.round(s.left), Math.round(s.width)])).toEqual([['ASLEEP', 0, 33], ['AWAKE', 33, 17]]);
  });

  it('a 40-second wake stays visible, at least MIN_WIDTH wide', () => {
    const [row] = dayRows([
      { state: 'ASLEEP', from: local(8, 0), to: local(8, 9) }, { state: 'WAKING', from: local(8, 9), to: local(8, 9, 0, 40) }, { state: 'AWAKE', from: local(8, 9, 0, 40), to: local(8, 10) },
    ], local(8, 0), local(8, 10));
    const waking = row!.segments.find((s) => s.state === 'WAKING')!;
    expect(waking.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(row!.segments.find((s) => s.state === 'AWAKE')!.left).toBeGreaterThanOrEqual(waking.left + waking.width);
  });

  it('phases too narrow to draw are merged into their neighbor, which says how many changes it holds', () => {
    const phases = Array.from({ length: 1000 }, (_, i) => ({ state: i % 2 ? 'ASLEEP' : 'AWAKE', from: local(8, 0, 0, i * 30), to: local(8, 0, 0, i * 30 + 30) }));
    const [row] = dayRows(phases, local(8, 0), local(8, 23, 59));
    expect(row!.segments.length).toBeLessThanOrEqual(Math.ceil(100 / MIN_WIDTH));
    expect(row!.segments.reduce((n, s) => n + 1 + s.merged, 0)).toBe(1000);
    expect(row!.segments[0]!.merged).toBeGreaterThan(0);
  });
});

describe('causes in words', () => {
  it('says what started a phase, who asked, and when it was inferred', () => {
    expect(causeText({ state: 'WAKING', cause: 'normal' })).toBe('a request');
    expect(causeText({ state: 'WAKING', cause: 'rule office' })).toBe('the wake rule office');
    expect(causeText({ state: 'NAPPING', cause: 'idle' })).toBe('the idle check (no request for its idle window)');
    expect(causeText({ state: 'NAPPING', cause: 'manager', by: 'ops@example.com' })).toBe('napped from the manager by ops@example.com');
    expect(causeText({ state: 'WAKING', cause: 'manager', by: 'ops@example.com' })).toBe('woken from the manager by ops@example.com');
    expect(causeText({ state: 'ASLEEP', cause: 'failed-released' })).toBe('released after its idle window (the wake had failed)');
    expect(causeText({ state: 'AWAKE', inferred: true })).toBe('seen at a check (its event was lost)');
    expect(causeText({ state: 'AWAKE' })).toBe('');
    expect(causeText({ state: 'WAKING', cause: 'something-new' })).toBe('something-new');
    // Review M7: a first entry is not a lost event, and the router's own wake names no one.
    expect(causeText({ state: 'ASLEEP', inferred: true, first: true })).toBe('first seen by the manager');
    expect(causeText({ state: 'WAKING', cause: 'rule-issues', by: 'dormeto' })).toBe('its rules, which the router could not switch');
  });
});

describe('days without history', () => {
  it('consecutive days before the history are one line, not empty rows (found live)', () => {
    const rows = dayRows([{ state: 'UNKNOWN', from: local(1, 12), to: local(8, 20) }, { state: 'ASLEEP', from: local(8, 20), to: local(8, 21) }], local(1, 12), local(8, 21));
    const items = collapseRows(rows);
    expect(items.map((i) => i.kind)).toEqual(['gap', 'day']);
    expect(items[0]).toMatchObject({ kind: 'gap', days: 7 });
    expect((items[0] as { first: Date }).first.getDate()).toBe(1);
    expect((items[0] as { last: Date }).last.getDate()).toBe(7);
  });
});

