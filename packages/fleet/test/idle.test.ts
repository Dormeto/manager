// The idle window advisor (R10): the last 14 days of requests replayed against idle windows with the router's rules,
// each window priced as the savings of R9, and the window at the knee recommended.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore } from '../src/index.js';
import { IDLE_WINDOWS, checkMinutesOf, idleWindowAdvice, recommendWindow, replayIdle, requestHours, windowsFor, type IdleWindowAdvice, type RequestMinutes } from '../src/idle.js';
import { baselineHours } from '../src/savings.js';
import type { StoppedItem } from '../src/prices.js';

const FROM = '2026-09-26T00:00:00.000Z';
const DAYS = 14;
const TO = new Date(Date.parse(FROM) + DAYS * 86_400_000).toISOString();
const END = DAYS * 1440; // minutes
const at = (minute: number) => new Date(Date.parse(FROM) + minute * 60_000).toISOString();
const requests = (minutes: [number, number][]): RequestMinutes => ({ from: FROM, to: TO, minutes });
// One request a day at 10:00 UTC.
const daily = requests(Array.from({ length: DAYS }, (_, d) => [600 + d * 1440, 1] as [number, number]));
const replay = (minutes: [number, number][], window: number, { wakeSeconds = 0, startAsleep = true, checkMinutes = 5 } = {}) =>
  replayIdle({ requests: requests(minutes), windows: [window], checkMinutes, wakeSeconds, startAsleep })[0]!;

const T3: StoppedItem = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };
const ODD: StoppedItem = { kind: 'unknown', name: 'something' } as unknown as StoppedItem;
const hourly = async (item: StoppedItem) => (item.kind === 'ec2' ? 0.0456 : null);
const ALWAYS = { kind: 'always' as const };
const PARIS = { kind: 'business-hours' as const, timeZone: 'Europe/Paris' };
const advice = (over: Partial<Parameters<typeof idleWindowAdvice>[0]> = {}) => idleWindowAdvice({
  requests: daily, current: 15, checkMinutes: 5, wakeMs: 30_000, startAsleep: false, actualWakes: 14, actualFrom: FROM, stopped: [T3], hourly,
  baseline: ALWAYS, wakerTargetGroup: true, now: Date.parse(TO), ...over,
});
const row = (a: IdleWindowAdvice, minutes: number) => a.windows.find((w) => w.minutes === minutes)!;

describe('the replay of an idle window', () => {
  it('one request a day: a wake a day, asleep from the first check a window after it', () => {
    const r = replayIdle({ requests: daily, windows: [15], checkMinutes: 5, wakeSeconds: 60, startAsleep: false })[0]!;
    expect(r.minutes).toBe(15);
    expect(r.wakes).toBe(DAYS);
    // Awake at the start: asleep at the first check 15 minutes on; woken at 10:00, awake at 10:01 (its last request's
    // minute ends at 10:01 too), asleep at the check of 10:20.
    expect(r.asleep[0]).toEqual({ from: at(15), to: at(600) });
    expect(r.asleep[1]).toEqual({ from: at(620), to: at(600 + 1440) });
    expect(r.asleep.at(-1)).toEqual({ from: at(600 + 13 * 1440 + 20), to: TO });
  });

  it('a request every 10 minutes for an hour: awake through it at 15 minutes, a wake each at 5', () => {
    const burst: [number, number][] = [600, 610, 620, 630, 640, 650].map((m) => [m, 3]);
    expect(replay(burst, 15).wakes).toBe(1);
    expect(replay(burst, 15).asleep).toEqual([{ from: at(0), to: at(600) }, { from: at(670), to: TO }]);
    // At 5 minutes, each request comes at the check that naps the workload: a nap, then a wake.
    expect(replay(burst, 5).wakes).toBe(6);
    expect(replay(burst, 5).asleep).toEqual([{ from: at(0), to: at(600) }, { from: at(660), to: TO }]);
  });

  it('a silence just under the window keeps it awake, one of the window wakes it again', () => {
    // 600 then 614 (13 minutes of silence after 600's minute), then 630 (15 minutes after 614's).
    expect(replay([[600, 1], [614, 1], [630, 1]], 15).wakes).toBe(2);
  });

  it('naps only at a check: a window of 7 minutes naps at the check after it', () => {
    expect(replay([[600, 1]], 7).asleep[1]!.from).toBe(at(610));
  });

  it('requests during a wake are activity, not wakes', () => {
    const r = replay([[600, 1], [601, 2], [602, 1]], 15, { wakeSeconds: 180 });
    expect(r.wakes).toBe(1);
    // Awake at 10:03: asleep at the first check 15 minutes after it.
    expect(r.asleep[1]!.from).toBe(at(620));
  });

  it('stays awake a full window after a wake, without any further request', () => {
    // A wake of 10 minutes: awake at 10:10, asleep at 10:25 (not at 10:20, a window after the request).
    expect(replay([[600, 1]], 15, { wakeSeconds: 600 }).asleep[1]!.from).toBe(at(625));
  });

  it('asleep from the start without any request: no wake, asleep the 14 days', () => {
    expect(replay([], 15)).toEqual({ minutes: 15, wakes: 0, wokeAt: [], asleep: [{ from: FROM, to: TO }] });
  });

  it('a request starting at the check that naps comes after the nap: a wake', () => {
    const r = replay([[15, 1]], 15, { startAsleep: false });
    expect(r.wakes).toBe(1);
    expect(r.asleep).toEqual([{ from: at(35), to: TO }]);
  });

  it('a window of a day over a request every 6 hours: never asleep', () => {
    const every6h: [number, number][] = Array.from({ length: END / 360 }, (_, k) => [k * 360, 1]);
    expect(replay(every6h, 1440, { startAsleep: false })).toEqual({ minutes: 1440, wakes: 0, wokeAt: [], asleep: [] });
  });

  it('a request in the last minute wakes it', () => {
    expect(replay([[END - 1, 1]], 15)).toEqual({ minutes: 15, wakes: 1, wokeAt: [at(END - 1)], asleep: [{ from: FROM, to: at(END - 1) }] });
  });

  it('minutes out of order or repeated are added up', () => {
    expect(replay([[650, 1], [600, 2], [600, 3], [610, 1]], 15)).toEqual(replay([[600, 5], [610, 1], [650, 1]], 15));
  });
});

describe('the recommended window', () => {
  const rows = (wakes: number[]) => IDLE_WINDOWS.map((minutes, i) => ({ minutes, wakes: wakes[i]! }));

  it('the shortest window avoiding 90% of the wakes the longest avoids', () => {
    // wakes(5) 40, wakes(120) 9: at most 9 + 3.1 = 12.1 wakes.
    expect(recommendWindow(rows([40, 30, 20, 12, 11, 10, 10, 9, 9]))).toBe(20);
  });

  it('the same wakes for every window, or none: the shortest, which saves the most', () => {
    expect(recommendWindow(rows([7, 7, 7, 7, 7, 7, 7, 7, 7]))).toBe(5);
    expect(recommendWindow(rows([0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(5);
  });

  it('wakes rising again for a longer window: the first window under the threshold', () => {
    expect(recommendWindow(rows([40, 30, 12, 20, 11, 10, 10, 9, 9]))).toBe(15);
  });

  it('only the nine windows are candidates: a current window of 25 or 1,440 is not', () => {
    expect(recommendWindow([...rows([40, 30, 20, 12, 11, 10, 10, 9, 9]), { minutes: 25, wakes: 11 }, { minutes: 1440, wakes: 0 }])).toBe(20);
  });

  it('the windows tried: the nine and the current one', () => {
    expect(windowsFor(15)).toEqual(IDLE_WINDOWS);
    expect(windowsFor(25)).toEqual([5, 10, 15, 20, 25, 30, 45, 60, 90, 120]);
    expect(windowsFor(1440)).toEqual([...IDLE_WINDOWS, 1440]);
  });

  it('the router\'s check period from its schedule', () => {
    expect([checkMinutesOf('rate(5 minutes)'), checkMinutesOf('rate(1 minute)'), checkMinutesOf('rate(1 hour)'), checkMinutesOf('rate(2 hours)')]).toEqual([5, 1, 60, 120]);
    expect([checkMinutesOf('cron(0/5 * * * ? *)'), checkMinutesOf('cron(0/10 * * * ? *)'), checkMinutesOf(null)]).toEqual([5, 10, 5]);
  });
});

describe('the advice of a workload', () => {
  it('each window\'s savings a month, hours asleep, wakes and wait a day; the knee; checked against the real wakes', async () => {
    const a = await advice();
    expect(a.windows.map((w) => w.minutes)).toEqual(IDLE_WINDOWS);
    expect(a).toMatchObject({ computedAt: TO, from: FROM, to: TO, current: 15, checkMinutes: 5, wakeSeconds: 30, priced: true, wakerTargetGroup: true });
    // At 15 minutes: asleep 0:15 to 10:00, then 10:20 to 10:00 the next day 13 times, then 10:20 to the end.
    const asleepHours = (585 + 13 * 1420 + 820) / 60;
    const w15 = row(a, 15);
    expect(w15.asleepHours).toBeCloseTo(asleepHours / DAYS, 6);
    expect(w15.usdMonth!).toBeCloseTo((asleepHours * 0.0456 * 30) / DAYS, 6);
    expect(w15.wakesPerDay).toBe(1);
    expect(w15.waitSecondsPerDay).toBe(30);
    // One request a day: a wake a day whatever the window, so the shortest is recommended.
    expect(a.recommended).toBe(5);
    expect(a.actual).toEqual({ wakes: 14, replayedWakes: 14, noisy: false });
  });

  it('within the business-hours baseline, only its hours are worth anything', async () => {
    const a = await advice({ baseline: PARIS });
    const phases = replayIdle({ requests: daily, windows: [15], checkMinutes: 5, wakeSeconds: 30, startAsleep: false })[0]!.asleep;
    const hours = phases.reduce((n, p) => n + baselineHours(p.from, p.to, PARIS), 0);
    expect(row(a, 15).usdMonth!).toBeCloseTo((hours * 0.0456 * 30) / DAYS, 6);
    expect(row(a, 15).usdMonth!).toBeLessThan(row(await advice(), 15).usdMonth!);
  });

  it('nothing priced (an item without a price, or no nap yet): hours asleep, never a partial dollar figure', async () => {
    for (const a of [await advice({ stopped: [T3, ODD] }), await advice({ stopped: null })]) {
      expect(a.priced).toBe(false);
      expect(a.windows.every((w) => w.usdMonth === null && w.asleepHours > 0)).toBe(true);
    }
  });

  it('a backend that does not run all the time (measured running periods): saves only its asleep time while it ran', async () => {
    // Running 08:00 to 20:00 UTC each day (stopped at night by a schedule).
    const running = Array.from({ length: DAYS }, (_, d) => ({ from: at(d * 1440 + 480), to: at(d * 1440 + 1200) }));
    const measured = await advice({ running });
    // Counted minute by minute: asleep in the replay and running.
    const asleep = replayIdle({ requests: daily, windows: [15], checkMinutes: 5, wakeSeconds: 30, startAsleep: false })[0]!.asleep;
    const within = (periods: { from: string; to: string }[], minute: number) => periods.some((p) => at(minute) >= p.from && at(minute) < p.to);
    let minutes = 0;
    for (let m = 0; m < END; m += 1) if (within(asleep, m) && within(running, m)) minutes += 1;
    expect(row(measured, 15).usdMonth).toBeCloseTo((0.0456 * (minutes / 60) * 30) / DAYS, 9);
    // The hours asleep and the wakes are the replay's, whatever the backend ran.
    expect(row(measured, 15)).toMatchObject({ asleepHours: row(await advice(), 15).asleepHours, wakesPerDay: row(await advice(), 15).wakesPerDay });
    // Running all the time: as without; never running: nothing saved.
    expect(row(await advice({ running: [{ from: FROM, to: TO }] }), 15).usdMonth).toBeCloseTo(row(await advice(), 15).usdMonth!, 9);
    expect(row(await advice({ running: [] }), 15).usdMonth).toBe(0);
  });

  it('no wake measured yet: the wait is unknown', async () => {
    const a = await advice({ wakeMs: null });
    expect(a.wakeSeconds).toBeNull();
    expect(a.windows.every((w) => w.waitSecondsPerDay === null)).toBe(true);
  });

  it('notes a replay with clearly more wakes than the real ones (requests the waker ignores)', async () => {
    expect((await advice({ actualWakes: 9 })).actual).toEqual({ wakes: 9, replayedWakes: 14, noisy: true });
    expect((await advice({ actualWakes: 10 })).actual.noisy).toBe(false);
    // Few wakes: 4 replayed for 2 real is not noisy (at least 3 more).
    const four = requests([600, 2040, 3480, 4920].map((m) => [m, 1]));
    expect((await advice({ requests: four, actualWakes: 2 })).actual).toEqual({ wakes: 2, replayedWakes: 4, noisy: false });
  });

  it('compares only over the time the history knows: onboarded 5 days into the 14, or a capped history', async () => {
    // The history starts on day 5: the replay's wakes from then on (days 5 to 13), against the 9 real ones.
    expect((await advice({ actualFrom: at(5 * 1440), actualWakes: 9 })).actual).toEqual({ wakes: 9, replayedWakes: 9, noisy: false });
    // A history that knows none of the period, or only its newest entries: no comparison.
    expect((await advice({ actualFrom: null, actualWakes: 2 })).actual).toEqual({ wakes: 2, replayedWakes: 14, noisy: false });
  });

  it('a current window of a day is shown, never recommended', async () => {
    const a = await advice({ current: 1440 });
    expect(a.windows.map((w) => w.minutes)).toEqual([...IDLE_WINDOWS, 1440]);
    expect(IDLE_WINDOWS).toContain(a.recommended);
  });
});

describe('the advice kept a day', () => {
  it('is read back until its expiresAt, then no more', async () => {
    const dynamo = fakeDynamo();
    let t = Date.parse(TO);
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => t });
    const kept = await advice();
    await store.putIdleWindow('121014831971', 'eu-west-1', 'demo', kept);
    const item = [...dynamo.items.values()].find((i) => i.sk?.S === 'IDLE#121014831971#eu-west-1#demo')!;
    expect(Number(item.expiresAt!.N) - Math.floor(t / 1000)).toBe(86_400);
    expect(await store.getIdleWindow('121014831971', 'eu-west-1', 'demo')).toEqual(kept);
    expect(await store.getIdleWindow('121014831971', 'eu-west-1', 'other')).toBeNull();
    // DynamoDB deletes an expired item within days: past its expiresAt it is not read.
    t += 86_401_000;
    expect(await store.getIdleWindow('121014831971', 'eu-west-1', 'demo')).toBeNull();
  });
});

describe('the requests per hour (the workload page heatmap)', () => {
  it('adds up the minutes of each UTC hour, every hour of the period present, quiet ones at 0', () => {
    const h = requestHours(requests([[600, 3], [659, 2], [660, 1], [END - 1, 4]]));
    expect(h.from).toBe(FROM);
    expect(h.counts).toHaveLength(DAYS * 24);
    expect(h.counts[10]).toBe(5);
    expect(h.counts[11]).toBe(1);
    expect(h.counts.at(-1)).toBe(4);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('a period starting within an hour: the first hour is that hour, in part', () => {
    const h = requestHours({ from: '2026-09-26T00:42:00.000Z', to: '2026-09-26T03:10:00.000Z', minutes: [[0, 1], [17, 2], [18, 6], [147, 1]] });
    expect(h).toEqual({ from: FROM, counts: [3, 6, 0, 1] });
  });

  it('comes with the advice', async () => {
    const a = await advice();
    expect(a.hours?.from).toBe(FROM);
    expect(a.hours?.counts.filter((n) => n > 0)).toEqual(Array(DAYS).fill(1));
  });
});
