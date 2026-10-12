// A workload's time in each state over the last 7 days (user request): on a Workloads page and its own view, from its
// history (R8), kept 5 minutes per workload while its state stays the same.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type Router } from '../src/api.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ACCOUNT = '121014831971';
const WEEK = 7 * 86_400;
const ROUTERS: Router[] = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT }];
const iso = (ms: number) => new Date(ms).toISOString();
const routerSummary = {
  account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev', version: '0.27.0', build: 'b1', checkSchedule: 'rate(5 minutes)', checkedAt: iso(NOW - 60_000), durationMs: 900,
  health: { status: 'ok', problems: [], lastScheduledCheckAt: iso(NOW - 60_000) }, pauses: [], counts: { ASLEEP: 2 }, check: { checkedAt: iso(NOW - 60_000), total: 2, received: [0] },
};
const workload = (id: string, over: Record<string, unknown> = {}) => ({
  account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, state: 'ASLEEP', targetGroupArn: `arn:tg/${id}`, updatedAt: iso(NOW - 3_600_000), pauses: [],
  checkedAt: iso(NOW - 60_000), historySince: iso(NOW - 60 * 86_400_000), ...over,
});
// Awake before the week, asleep for its last hour, its nap having stopped two t3.medium instances and a database.
const STOPPED = [{ kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' }, { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false }, { kind: 'unknown', backend: 'ecs:svc', reason: 'AccessDenied' }];
const entries = [{ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', from: 'AWAKE', to: 'ASLEEP', at: iso(NOW - 3_600_000), stopped: STOPPED }];
const PRICES: Record<string, number> = { ec2: 0.0912, rds: 0.017 };
const before = { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', from: null, to: 'AWAKE', at: iso(NOW - 10 * 86_400_000) };

function setup({ workloads = [workload('a'), workload('b')], fail = false, priced = true, pricesFail = false, statesCacheMs = undefined as number | undefined, hidden = false } = {}) {
  let t = NOW;
  const read: string[] = [];
  const list = workloads.map((w) => ({ ...w }));
  const api = createApi({
    routers: ROUTERS, now: () => t, version: '0.7.0', managerAccount: ACCOUNT, ...(statesCacheMs ? { statesCacheMs } : {}), ...(hidden ? { visible: () => false } : {}),
    audit: { write: async () => {}, list: async () => [] },
    invoke: async (_r, payload) => (payload.action === 'status' ? { workloadId: 'a', state: list[0]!.state } : null),
    fleet: {
      // A router reporting every few minutes: its summary stays fresh as time goes by.
      listRouters: async () => [{ ...routerSummary, checkedAt: iso(t - 60_000), check: { ...routerSummary.check, checkedAt: iso(t - 60_000) } }] as never,
      listWorkloads: async () => list as never,
      getWorkload: async (_a: string, _r: string, id: string) => (list.find((w) => w.workloadId === id) ?? null) as never,
      listHistory: async (_a: string, _r: string, id: string) => {
        read.push(id);
        if (fail) throw new Error('DynamoDB unavailable');
        return { entries: (id === 'a' ? entries : []) as never, truncated: false };
      },
      historyBefore: async (_a: string, _r: string, id: string) => (id === 'a' ? before : null) as never,
    },
    ...(priced ? { savings: { baseline: { kind: 'always' as const }, hourly: async (_region: string, item: { kind: string }) => { if (pricesFail) throw new Error('throttled'); return PRICES[item.kind] ?? null; } } } : {}),
    discovery: { store: { getCandidate: async (arn: string) => (arn === 'arn:tg/a' ? { idleHours7d: 150, requests7d: 12 } : null) as never }, run: async () => {} } as never,
  });
  return { api, read, list, later: (ms: number) => { t += ms; } };
}
const event = (path: string, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'v@example.com', sub: 'u1', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const page = async (s: ReturnType<typeof setup>) => json(await s.api(event('/api/workloads', { limit: '25', states: '1' }))).workloads as Record<string, any>[];

describe('time in each state over 7 days', () => {
  it('gives a Workloads page each workload\'s seconds per state over the last 7 days, from its history', async () => {
    const s = setup();
    const [a, b] = await page(s);
    expect(a!.states7d).toEqual({ from: iso(NOW - WEEK * 1000), to: iso(NOW), totals: { AWAKE: WEEK - 3_600, ASLEEP: 3_600 } });
    // Asleep since before the week (its history began 60 days ago): the whole week asleep.
    expect(b!.states7d.totals).toEqual({ ASLEEP: WEEK });
    expect(s.read).toEqual(['a', 'b']);
  });

  it('reads no history unless asked', async () => {
    const s = setup();
    const plain = json(await s.api(event('/api/workloads', { limit: '25' }))).workloads;
    expect(['states7d' in plain[0], s.read]).toEqual([false, []]);
  });

  it('gives the workload\'s view the same figures, with its idle hours and requests from discovery', async () => {
    const s = setup();
    const body = json(await s.api(event('/api/workloads/dmt-dev/a')));
    expect(body.states7d.totals).toEqual({ AWAKE: WEEK - 3_600, ASLEEP: 3_600 });
    expect([body.idleHours7d, body.requests7d]).toEqual([150, 12]);
    // Its account and region (the ARNs of its backends and targets).
    expect([body.account, body.region]).toEqual([ACCOUNT, 'eu-west-1']);
    expect((await page(s))[0]!.states7d).toEqual(body.states7d);
  });

  it('keeps them 5 minutes while the state stays the same: a change of state, or 5 minutes later, reads the history again', async () => {
    const s = setup();
    await page(s);
    s.later(60_000);
    await page(s);
    await s.api(event('/api/workloads/dmt-dev/a'));
    expect(s.read).toEqual(['a', 'b']);
    s.list[0]!.state = 'WAKING';
    await page(s);
    expect(s.read).toEqual(['a', 'b', 'a']);
    s.later(300_000);
    await page(s);
    expect(s.read).toEqual(['a', 'b', 'a', 'a', 'b']);
  });

  it('over the last 30 days: what its naps saved, the share of its time asleep within the baseline, its last nap priced (user request)', async () => {
    const s = setup();
    const body = json(await s.api(event('/api/workloads/dmt-dev/a')));
    const { saved, ...costs } = body.costs;
    expect(costs).toEqual({
      baseline: { kind: 'always' }, from: iso(NOW - 30 * 86_400_000), to: iso(NOW), napAt: iso(NOW - 3_600_000), savedShare: 1 / 720,
      items: [{ item: STOPPED[0], hourly: 0.0912 }, { item: STOPPED[1], hourly: 0.017 }, { item: STOPPED[2], hourly: null }],
    });
    // Its hour asleep: the two instances and the database; the service not described.
    expect(saved.usd).toBeCloseTo(0.1082, 6);
    expect([saved.hours, saved.unpricedHours]).toEqual([1, 1]);
    // The same on a Workloads page; a workload whose naps said nothing has no item, and its time asleep is not priced.
    const [a, b] = await page(s);
    expect(a!.costs).toEqual(body.costs);
    expect(b!.costs).toEqual({ baseline: { kind: 'always' }, from: iso(NOW - 30 * 86_400_000), to: iso(NOW), napAt: null, savedShare: 1, items: [], saved: { usd: 0, hours: 720, unpricedHours: 720 } });
  });

  it('says no price when prices fail, and gives no costs without prices', async () => {
    const failing = json(await setup({ pricesFail: true }).api(event('/api/workloads/dmt-dev/a')));
    expect(failing.costs.items.map((i: { hourly: number | null }) => i.hourly)).toEqual([null, null, null]);
    expect('costs' in json(await setup({ priced: false }).api(event('/api/workloads/dmt-dev/a')))).toBe(false);
  });

  it('never fails the page or the view: without its history, a workload has no figures', async () => {
    const s = setup({ fail: true });
    const listed = await page(s);
    expect(listed.map((w) => 'states7d' in w)).toEqual([false, false]);
    const view = await s.api(event('/api/workloads/dmt-dev/a'));
    expect([view.statusCode, 'states7d' in json(view)]).toEqual([200, false]);
  });
});

describe('all the workloads over 7 days (the Workloads view\'s bar)', () => {
  const fleet = async (s: ReturnType<typeof setup>) => json(await s.api(event('/api/workloads/states')));

  it('adds up the time in each state and the savings of every workload the caller sees', async () => {
    const body = await fleet(setup());
    expect([body.workloads, body.computedAt, body.cacheMinutes]).toEqual([2, iso(NOW), 60]);
    expect(body.states7d).toEqual({ from: iso(NOW - WEEK * 1000), to: iso(NOW), totals: { AWAKE: WEEK - 3_600, ASLEEP: WEEK + 3_600 } });
    // a's hour asleep priced; b's 30 days asleep not described.
    expect(body.costs.saved.usd).toBeCloseTo(0.1082, 6);
    expect(body.costs.saved.unpricedHours).toBe(721);
    expect(body.costs.hourly).toBeCloseTo(0.1082, 6);
    expect(body.costs.monthly).toBeCloseTo((0.1082 * 730) / 720, 6);
    expect(body.costs.priced).toBe(1);
  });

  it('keeps each workload\'s figures an hour whatever its state, and says since when', async () => {
    const s = setup();
    await fleet(s);
    s.later(30 * 60_000);
    s.list[0]!.state = 'WAKING';
    const kept = await fleet(s);
    expect([s.read, kept.computedAt]).toEqual([['a', 'b'], iso(NOW)]);
    s.later(31 * 60_000);
    const fresh = await fleet(s);
    expect([s.read, fresh.computedAt]).toEqual([['a', 'b', 'a', 'b'], iso(NOW + 61 * 60_000)]);
  });

  it('keeps them as long as the manager is set to (states_cache_minutes)', async () => {
    const s = setup({ statesCacheMs: 600_000 });
    await fleet(s);
    s.later(11 * 60_000);
    expect((await fleet(s)).cacheMinutes).toBe(10);
    expect(s.read).toEqual(['a', 'b', 'a', 'b']);
  });

  it('counts only the workloads the caller sees, and gives no costs without prices', async () => {
    const hidden = await fleet(setup({ hidden: true }));
    expect([hidden.workloads, hidden.states7d.totals]).toEqual([0, {}]);
    expect('costs' in (await fleet(setup({ priced: false })))).toBe(false);
  });
});
