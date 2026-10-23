// The requests heatmap's grid (heatmap.ts): local days and hours from the API's UTC hours, levels by quartiles.
import { describe, expect, it } from 'vitest';
import { heatmap } from '../src/heatmap';

const HOUR = 3_600_000;
// The API's hours start at a UTC hour: two weeks ending at the start of a local day plus 10 hours.
const end = new Date(2026, 9, 22, 10);
const from = new Date(end.getTime() - 14 * 24 * HOUR);
const counts = (fill: (t: Date) => number) => Array.from({ length: 14 * 24 }, (_, i) => fill(new Date(from.getTime() + i * HOUR)));

describe('heatmap', () => {
  it('a row per local day, the latest last, a cell per local hour; the hours after the period have no data', () => {
    const m = heatmap({ from: from.toISOString(), counts: counts(() => 0) }, 7);
    expect(m.rows).toHaveLength(7);
    expect(m.rows.at(-1)!.day.getDate()).toBe(new Date(end.getTime() - HOUR).getDate());
    expect(m.rows.every((r) => r.cells.length === 24)).toBe(true);
    const today = m.rows.at(-1)!.cells;
    expect(today[9]!.count).toBe(0);
    expect(today[10]!.count).toBeNull();
    expect(m.quiet).toBe(m.known);
    expect(m.busiest).toBeNull();
  });

  it('weekdays 9:00 to 18:00 busy: the totals, the quiet hours and the busiest one', () => {
    const busy = (t: Date) => (t.getDay() % 6 !== 0 && t.getHours() >= 9 && t.getHours() < 18 ? 10 + t.getHours() : 0);
    const m = heatmap({ from: from.toISOString(), counts: counts(busy) }, 14);
    const shown = m.rows.flatMap((r) => r.cells).filter((c) => c.count !== null);
    expect(m.total).toBe(shown.reduce((n, c) => n + c.count!, 0));
    expect(m.quiet).toBe(shown.filter((c) => c.count === 0).length);
    expect(m.busiest?.hour).toBe(17);
    expect(m.busiest?.count).toBe(27);
    // Levels follow the quartiles: no request is 0, the busiest hours 4, and every level from 1 to 4 is used.
    const levels = new Set(shown.filter((c) => c.count! > 0).map((c) => c.level));
    expect([...levels].sort()).toEqual([1, 2, 3, 4]);
    expect(shown.filter((c) => c.count === 0).every((c) => c.level === 0)).toBe(true);
  });

  it('days before the period have no data', () => {
    const m = heatmap({ from: new Date(end.getTime() - 30 * HOUR).toISOString(), counts: Array(30).fill(1) }, 7);
    expect(m.rows[0]!.cells.every((c) => c.count === null)).toBe(true);
    expect(m.known).toBe(30);
    expect(m.total).toBe(30);
  });
});
