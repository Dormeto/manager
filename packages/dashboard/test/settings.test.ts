import { describe, expect, it } from 'vitest';
import { settingRows } from '../src/settings';

describe('settingRows', () => {
  it('formats every workload setting with an explanation and its acceptable range', () => {
    const rows = settingRows({ waitSeconds: 60, idleMinutes: 15, drainSeconds: 30, wakeTimeoutSeconds: 1800, maxHolders: 50 });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Idle window', '15 min'],
      ['Hold', '60 s'],
      ['Drain', '30 s'],
      ['Wake timeout', '30 min'],
      ['Held requests', '≤ 50'],
    ]);
    for (const row of rows) {
      expect(row.help.length).toBeGreaterThan(80);
      expect(row.range).toMatch(/\S/);
    }
    expect(rows[1]!.range).toMatch(/load balancer idle timeout/);
  });
});
