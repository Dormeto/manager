// A workload's idle window advice (R10): its last 14 days of requests (read by the discovery function) replayed against
// idle windows, priced as its savings, kept a day; viewers too.
import { describe, expect, it } from 'vitest';
import type { IdleWindowAdvice, RequestMinutes } from '@dormeto/fleet';
import { createApi, type ApiEvent, type Router } from '../src/api.js';

const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const MINUTE = Date.parse('2026-10-10T12:00:00.000Z');
const ACCOUNT = '121014831971';
const APP = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/dmt-dev-demo-app/cdccfbae00eb59a6';
const ROUTERS: Router[] = [
  { name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT },
  { name: 'other', region: 'eu-west-3', controller: 'c3', account: '038606077307' },
];
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T3 = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };
const entry = (to: string, ms: number, extra: Record<string, unknown> = {}) => ({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', from: null, to, at: iso(ms), ...extra });
// Asleep before the 14 days, woken twice in them (40 s and 50 s), and once 20 days ago (100 s): the median of 30 days, 50 s.
const ENTRIES = [
  entry('WAKING', NOW - 20 * DAY), entry('AWAKE', NOW - 20 * DAY + 100_000, { durationMs: 100_000 }), entry('ASLEEP', NOW - 19 * DAY, { stopped: [T3] }),
  entry('WAKING', NOW - 5 * DAY), entry('AWAKE', NOW - 5 * DAY + 40_000, { durationMs: 40_000 }), entry('ASLEEP', NOW - 5 * DAY + 3_600_000, { stopped: [T3] }),
  entry('WAKING', NOW - 2 * DAY), entry('AWAKE', NOW - 2 * DAY + 50_000, { durationMs: 50_000 }), entry('ASLEEP', NOW - 2 * DAY + 3_600_000, { stopped: [T3] }),
];

function setup({ summary = { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', state: 'ASLEEP', targetGroupArn: APP, settings: { idleMinutes: 15 } } as Record<string, unknown> | null, requests = { from: iso(MINUTE - 14 * DAY), to: iso(MINUTE), minutes: [] as [number, number][], wakerTargetGroupArn: 'arn:waker' } as RequestMinutes & { wakerTargetGroupArn: string | null }, fail = null as string | null, withSavings = true, entries = ENTRIES as ReturnType<typeof entry>[], truncated = false } = {}) {
  let t = NOW;
  const asked: { requests: unknown[][]; history: string[] } = { requests: [], history: [] };
  const kept = new Map<string, { advice: IdleWindowAdvice; until: number }>();
  const puts: string[] = [];
  const api = createApi({
    routers: ROUTERS, now: () => t, version: '0.9.0', managerAccount: ACCOUNT,
    audit: { write: async () => {}, list: async () => [] },
    invoke: async () => null,
    visible: (_identity, item) => item.account !== '038606077307',
    fleet: {
      listRouters: async () => [{ account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev', version: '0.28.1', build: null, checkSchedule: 'rate(10 minutes)', checkedAt: iso(NOW), durationMs: 1, health: null, pauses: [], counts: {} }] as never,
      listWorkloads: async () => [], getWorkload: async () => summary as never,
      listHistory: async (_a: string, _r: string, _id: string, from: string, to: string) => { asked.history.push(from); return { entries: entries.filter((e) => e.at >= from && e.at < to) as never, truncated }; },
      historyBefore: async (_a: string, _r: string, _id: string, at: string) => (entries.filter((e) => e.at < at).at(-1) ?? null) as never,
      getIdleWindow: async (account: string, region: string, id: string) => { const k = kept.get(`${account}#${region}#${id}`); return k && k.until > t ? k.advice : null; },
      putIdleWindow: async (account: string, region: string, id: string, advice: IdleWindowAdvice) => { puts.push(id); kept.set(`${account}#${region}#${id}`, { advice, until: t + DAY }); },
    },
    ...(withSavings ? { savings: { baseline: { kind: 'always' as const }, hourly: async (region: string, item: { kind: string }) => (region === 'eu-west-1' && item.kind === 'ec2' ? 0.0456 : null) } } : {}),
    idleRequests: async (...args: unknown[]) => { asked.requests.push(args); if (fail) throw new Error(fail); return requests; },
  });
  return { api, asked, puts, advance: (ms: number) => { t += ms; }, set: (s: Record<string, unknown>) => { summary = s; } };
}
const event = (path: string): ApiEvent => ({
  rawPath: path, queryStringParameters: {}, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'v@example.com', sub: 'u1', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const PATH = '/api/workloads/dmt-dev/a/idle-window';

describe('a workload\'s idle window advice (R10)', () => {
  it('computes it for a viewer from its requests, its history and its router, then keeps it a day', async () => {
    const s = setup();
    const res = await s.api(event(PATH));
    expect(res.statusCode).toBe(200);
    const body = json(res) as IdleWindowAdvice;
    expect(s.asked.requests).toEqual([[ACCOUNT, 'eu-west-1', APP, 14]]);
    // The 30 days of the median wake, and the replay's 14 days.
    expect(s.asked.history).toEqual(expect.arrayContaining([iso(NOW - 30 * DAY), iso(MINUTE - 14 * DAY)]));
    expect(body).toMatchObject({ current: 15, checkMinutes: 10, wakeSeconds: 50, priced: true, wakerTargetGroup: true, recommended: 5 });
    // Asleep at the start of the 14 days and no request: asleep all the time, whatever the window.
    expect(body.windows.find((w) => w.minutes === 15)!.asleepHours).toBeCloseTo(24, 6);
    expect(body.windows.find((w) => w.minutes === 15)!.usdMonth).toBeCloseTo(24 * 30 * 0.0456, 6);
    expect(body.actual).toEqual({ wakes: 2, replayedWakes: 0, noisy: false });
    // Kept: the next read asks nothing more.
    expect(json(await s.api(event(PATH)))).toEqual(body);
    expect(s.asked.requests).toHaveLength(1);
    expect(s.puts).toEqual(['a']);
  });

  it('computes it again once a day has passed, or when the idle window changed since', async () => {
    const s = setup();
    await s.api(event(PATH));
    s.advance(DAY + 1000);
    await s.api(event(PATH));
    expect(s.asked.requests).toHaveLength(2);
    s.set({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', state: 'ASLEEP', targetGroupArn: APP, settings: { idleMinutes: 30 } });
    expect(json(await s.api(event(PATH))).current).toBe(30);
    expect(s.asked.requests).toHaveLength(3);
  });

  it('the requests unreadable (the discovery function busy or failing): 502 with why, nothing kept', async () => {
    const s = setup({ fail: 'discovery is busy (a discovery run uses its capacity): try again in a few minutes' });
    const res = await s.api(event(PATH));
    expect(res.statusCode).toBe(502);
    expect(json(res).message).toContain('try again in a few minutes');
    expect(s.puts).toEqual([]);
    await s.api(event(PATH));
    expect(s.asked.requests).toHaveLength(2);
  });

  it('compares the real wakes with the replay only over the time the history knows (onboarded during the 14 days)', async () => {
    const FROM14 = MINUTE - 14 * DAY;
    // A request a day at 10:00 for 14 days; the manager first saw the workload on day 11, and it woke on days 11 to 13.
    const daily = { from: iso(FROM14), to: iso(MINUTE), minutes: Array.from({ length: 14 }, (_, d) => [600 + d * 1440, 1] as [number, number]), wakerTargetGroupArn: 'arn:waker' };
    const seen = [entry('AWAKE', FROM14 + 11 * DAY), ...[11, 12, 13].flatMap((d) => [entry('ASLEEP', FROM14 + d * DAY + 60_000, { stopped: [T3] }), entry('WAKING', FROM14 + d * DAY + 600 * 60_000), entry('AWAKE', FROM14 + d * DAY + 600 * 60_000 + 30_000, { durationMs: 30_000 })])];
    const s = setup({ requests: daily, entries: seen });
    expect((json(await s.api(event(PATH))) as IdleWindowAdvice).actual).toEqual({ wakes: 3, replayedWakes: 3, noisy: false });
    // A capped history knows only its newest entries: no comparison.
    const capped = setup({ requests: daily, entries: seen, truncated: true });
    expect((json(await capped.api(event(PATH))) as IdleWindowAdvice).actual.noisy).toBe(false);
  });

  it('an unknown workload or an unseen router: 404', async () => {
    expect((await setup({ summary: null }).api(event(PATH))).statusCode).toBe(404);
    expect((await setup().api(event('/api/workloads/other/a/idle-window'))).statusCode).toBe(404);
  });

  it('without prices: the advice in hours, no error', async () => {
    const body = json(await setup({ withSavings: false }).api(event(PATH))) as IdleWindowAdvice;
    expect(body.priced).toBe(false);
    expect(body.windows.every((w) => w.usdMonth === null)).toBe(true);
  });

  it('a workload with no idle window in its summary: 15 minutes, the router\'s default', async () => {
    const s = setup({ summary: { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', state: 'AWAKE', targetGroupArn: APP } });
    expect(json(await s.api(event(PATH))).current).toBe(15);
  });
});
