import { describe, expect, it } from 'vitest';
import { state } from '../src/mock/state';
import { TIMES } from '../src/schedule';

describe('the demo\'s schedules', () => {
  const scheduled = () => state().routers.length ? [...new Set(state().workloads.filter((w) => w.schedule))] : [];
  it('vary per workload and stay valid', () => {
    const list = scheduled();
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(new Set(list.map((w) => JSON.stringify({ ...w.schedule, exceptions: undefined, at: undefined }))).size).toBeGreaterThanOrEqual(5);
    for (const { schedule: s } of list) {
      expect((s!.windows ?? []).length).toBeLessThanOrEqual(20);
      for (const w of s!.windows ?? []) {
        expect(TIMES).toContain(w.start);
        expect(TIMES).toContain(w.end);
        if (w.kind === 'awake') expect(w.wake).toBeUndefined();
      }
      expect(s!.windows?.length || s!.maxNapDays).toBeTruthy();
    }
  });
});
