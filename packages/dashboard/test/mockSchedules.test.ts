import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import { state } from '../src/mock/state';
import { AVAILABLE } from '../src/mock/fixtures';
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

describe('the demo\'s joined windows', () => {
  type View = ScheduleView;
  const path = (w: { router: string; workloadId: string }) => `/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`;
  const view = (w: { router: string; workloadId: string }) => mockApi(path(w)) as Promise<View>;
  const current = () => state().workloads.filter((w) => state().routers.find((r) => r.name === w.router)!.version === AVAILABLE.version);
  const older = () => state().workloads.filter((w) => state().routers.find((r) => r.name === w.router)!.version !== AVAILABLE.version);

  it('answers the value, its level and what is inherited on an up-to-date router, with or without a schedule; nothing on an older one', async () => {
    const without = current().at(-1)!;
    await mockApi(`${path(without)}/schedule`, { method: 'DELETE' });
    const answer = await view(without);
    expect(answer.schedule).toBeNull();
    expect(answer.joinInherited).toEqual({ joinMinutes: answer.joinMinutes, joinFrom: answer.joinFrom });
    for (const w of older().slice(0, 3)) expect(await view(w)).not.toHaveProperty('joinMinutes');
  });

  it('has a schedule with a gap that joins at each level, and the router\'s next events say no end in the gap', async () => {
    const seen = new Set<string>();
    for (const w of current().filter((x) => x.schedule?.windows?.[1]?.start?.startsWith('12:'))) {
      const answer = await view(w);
      const gap = Number(w.schedule!.windows![1]!.start!.slice(3, 5));
      if (gap <= answer.joinMinutes!) seen.add(answer.joinFrom!);
      expect(answer.next.some((e) => e.kind === 'awake-end' && e.window === 0), w.workloadId).toBe(false);
    }
    expect([...seen].sort()).toEqual(['organization', 'router', 'workload']);
  });

  it('takes joinMinutes on a schedule, keeps 0, refuses another in the router\'s words; an older router does not know it', async () => {
    const w = current().at(-1)!;
    const body = { timeZone: 'UTC', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }] };
    const put = (x: { router: string; workloadId: string }, more: object) => mockApi(`${path(x)}/schedule`, { method: 'PUT', body: JSON.stringify({ ...body, ...more }) }) as Promise<View>;
    expect(await put(w, { joinMinutes: 0 })).toMatchObject({ joinMinutes: 0, joinFrom: 'workload', schedule: { joinMinutes: 0 } });
    await expect(put(w, { joinMinutes: 7 })).rejects.toMatchObject({ status: 400, message: 'joinMinutes: a whole number from 0 to 120, a multiple of 5' });
    await expect(put(older()[0]!, { joinMinutes: 15 })).rejects.toMatchObject({ status: 400, message: 'joinMinutes: unknown field' });
  });

  it('the settings routes keep what is not sent, answer null when unset, and refuse a workload\'s', async () => {
    const put = (route: string, body: object) => mockApi(route, { method: 'PUT', body: JSON.stringify(body) }) as Promise<Record<string, unknown>>;
    expect(await put('/settings/workloads', { joinMinutes: 35 })).toMatchObject({ joinMinutes: 35, hibernate: state().hibernation.hibernate });
    expect(await put('/settings/workloads', { hibernate: false })).toMatchObject({ joinMinutes: 35, hibernate: false });
    expect(await put('/settings/workloads', { joinMinutes: null })).toMatchObject({ joinMinutes: null, hibernate: false });
    await put('/settings/workloads', { hibernate: true, joinMinutes: 20 });
    await expect(put('/settings/workloads', { joinMinutes: 7 })).rejects.toMatchObject({ status: 400 });
    const r = state().routers.find((x) => x.version === AVAILABLE.version && x.readsManager)!;
    const route = `/routers/${encodeURIComponent(r.name)}/settings`;
    expect(await put(route, { joinMinutes: 40 })).toMatchObject({ level: 'router', settings: { hibernate: r.hibernate, joinMinutes: 40 } });
    expect(await put(route, { hibernate: true })).toMatchObject({ settings: { hibernate: true, joinMinutes: 40 } });
    expect(await put(route, { hibernate: null })).toMatchObject({ settings: { hibernate: null, joinMinutes: 40 } });
    expect(await put(route, { joinMinutes: null })).toMatchObject({ settings: { hibernate: null, joinMinutes: null, by: null, at: null } });
    const details = await mockApi(`/routers/${encodeURIComponent(r.name)}`) as { managerSettings: { joinMinutes: number } };
    expect(details.managerSettings.joinMinutes).toBe(20);
    const w = current()[0]!;
    await expect(put(`${path(w)}/settings`, { joinMinutes: 30 })).rejects.toMatchObject({ status: 400, message: 'settings: a workload\'s joinMinutes is on its schedule' });
  });
});
