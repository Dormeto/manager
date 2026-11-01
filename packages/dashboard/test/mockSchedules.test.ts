import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import { state } from '../src/mock/state';
import { repeatChoice, TIMES, type Schedule, type ScheduleView, type ScheduleWindow } from '../src/schedule';
import { windowProblems } from '../src/occurrences';

describe('the demo\'s schedules', () => {
  const scheduled = () => state().routers.length ? [...new Set(state().workloads.filter((w) => w.schedule))] : [];
  it('vary per workload and stay valid', () => {
    const list = scheduled();
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(new Set(list.map((w) => JSON.stringify({ ...w.schedule, exceptions: undefined, at: undefined }))).size).toBeGreaterThanOrEqual(5);
    for (const { schedule: s } of list) {
      expect((s!.windows ?? []).length).toBeLessThanOrEqual(20);
      for (const w of s!.windows ?? []) {
        expect(windowProblems(w, 'window')).toEqual([]);
        if (w.repeat?.pattern !== 'cron') {
          expect(TIMES).toContain(w.start);
          expect(TIMES).toContain(w.end);
        }
        if (w.kind === 'awake') expect(w.wake).toBeUndefined();
      }
      expect(s!.windows?.length || s!.maxNapDays).toBeTruthy();
    }
  });

  it('show one example of each kind of recurrence, on routers that know them', () => {
    const recurring = scheduled().filter((w) => w.schedule!.windows?.some((x) => x.repeat));
    const kinds = new Set(recurring.flatMap((w) => w.schedule!.windows!.map(repeatChoice)));
    for (const kind of ['once', 'daily', 'monthly', 'yearly', 'cron']) expect(kinds, kind).toContain(kind);
    expect(recurring.flatMap((w) => w.schedule!.windows!).some((x) => x.repeat?.pattern === 'weekly' && (x.repeat.interval ?? 1) > 1)).toBe(true);
    expect(recurring.flatMap((w) => w.schedule!.windows!).some((x) => x.repeat?.pattern === 'monthly' && x.repeat.nth)).toBe(true);
    for (const w of recurring) expect(state().routers.find((r) => r.name === w.router)!.version).toBe('0.36.0');
  });
});

describe('the demo\'s schedule route', () => {
  const put = (router: string, id: string, body: unknown) => mockApi(`/workloads/${encodeURIComponent(router)}/${encodeURIComponent(id)}/schedule`, { method: 'PUT', body: JSON.stringify(body) }) as Promise<ScheduleView>;
  const on = (older: boolean) => state().workloads.find((w) => (state().routers.find((r) => r.name === w.router)!.version === '0.36.0') !== older)!;
  const WINDOWS: ScheduleWindow[] = [
    { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 12 * * 1-5', minutes: 60 } },
  ];

  it('takes and gives back the recurrence fields, with the next events they make', async () => {
    const w = on(false);
    const view = await put(w.router, w.workloadId, { timeZone: 'Europe/Paris', windows: WINDOWS });
    expect((view.schedule as Schedule).windows).toEqual(WINDOWS);
    expect(view.next).toHaveLength(5);
    const read = await mockApi(`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`) as ScheduleView;
    expect(read.schedule!.windows).toEqual(WINDOWS);
  });

  it('refuses a recurrence as the router words it', async () => {
    const w = on(false);
    await expect(put(w.router, w.workloadId, { timeZone: 'UTC', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron: '* 8 * * *', minutes: 60 } }] })).rejects.toMatchObject({ status: 400, message: 'windows[0].repeat.cron: minutes must be multiples of 5, as schedule times are: * is every minute, */5 every five' });
  });

  it('a router before 0.36.0 says it does not know the fields, and takes a plain window', async () => {
    const w = on(true);
    await expect(put(w.router, w.workloadId, { timeZone: 'UTC', windows: WINDOWS })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('windows[0].repeat: unknown field') });
    await expect(put(w.router, w.workloadId, { timeZone: 'UTC', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: '2027-01-04' }] })).rejects.toMatchObject({ message: 'windows[0].from: unknown field' });
    await expect(put(w.router, w.workloadId, { timeZone: 'UTC', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' }] })).resolves.toBeTruthy();
  });
});
