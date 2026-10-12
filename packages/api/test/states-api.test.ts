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

type Discounts = { compute: number; databases: number };
function setup({ workloads = [workload('a'), workload('b')], fail = false, priced = true, pricesFail = false, statesCacheMs = undefined as number | undefined, hidden = false, settings = { compute: 0, databases: 0 } as Discounts } = {}) {
  let t = NOW;
  const read: string[] = [];
  const list = workloads.map((w) => ({ ...w }));
  const audits: Record<string, unknown>[] = [];
  const discountsSeen: (Discounts | undefined)[] = [];
  let stored = { ...settings, updatedAt: null as string | null, updatedBy: null as string | null };
  let settingsReads = 0;
  const api = createApi({
    routers: ROUTERS, now: () => t, version: '0.7.0', managerAccount: ACCOUNT, ...(statesCacheMs ? { statesCacheMs } : {}), ...(hidden ? { visible: () => false } : {}),
    audit: { write: async (e) => { audits.push({ ...e }); }, list: async () => [] },
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
      getSavingsSettings: async () => { settingsReads += 1; return { ...stored }; },
      putSavingsSettings: async (d: Discounts, by: string) => { stored = { ...d, updatedAt: iso(t), updatedBy: by }; },
    },
    ...(priced ? { savings: { baseline: { kind: 'always' as const }, hourly: async (_region: string, item: { kind: string }, d?: Discounts) => {
      discountsSeen.push(d);
      if (pricesFail) throw new Error('throttled');
      const usd = PRICES[item.kind];
      return usd === undefined ? null : usd * (1 - ((item.kind === 'rds' ? d?.databases : d?.compute) ?? 0) / 100);
    } } } : {}),
    discovery: { store: { getCandidate: async (arn: string) => (arn === 'arn:tg/a' ? { idleHours7d: 150, requests7d: 12 } : null) as never }, run: async () => {} } as never,
  });
  return {
    api, read, list, audits, discountsSeen, later: (ms: number) => { t += ms; },
    settingsReads: () => settingsReads, setStored: (d: Discounts) => { stored = { ...d, updatedAt: iso(t), updatedBy: 'other@example.com' }; },
  };
}
const request = (method: string, path: string, group: string, body?: unknown): ApiEvent => ({
  rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: { email: 'admin@example.com', sub: 'u2', 'cognito:groups': `[${group}]` } } } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
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

describe('discounts for commitments (R9.5)', () => {
  const costsOf = async (s: ReturnType<typeof setup>) => json(await s.api(event('/api/workloads/dmt-dev/a'))).costs;

  it('are given to every role with the summary, with who set them and when', async () => {
    const s = setup();
    expect(json(await s.api(event('/api/savings')))).toEqual({ summary: null, settings: { compute: 0, databases: 0, updatedAt: null, updatedBy: null } });
  });

  it('are set by administrators only, as whole percentages from 0 to 90', async () => {
    const s = setup();
    expect((await s.api(request('PUT', '/api/savings/settings', 'dmt-operator', { compute: 20, databases: 30 }))).statusCode).toBe(403);
    for (const body of [{ compute: '20', databases: 0 }, { compute: 20.5, databases: 0 }, { compute: -1, databases: 0 }, { compute: 91, databases: 0 }, { compute: 20 }]) {
      expect((await s.api(request('PUT', '/api/savings/settings', 'dmt-admin', body))).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect([s.audits, json(await s.api(event('/api/savings'))).settings.compute]).toEqual([[], 0]);
  });

  it('a change is stored, audited, and prices the workload figures at once', async () => {
    const s = setup();
    expect('discounts' in (await costsOf(s))).toBe(false);
    const res = await s.api(request('PUT', '/api/savings/settings', 'dmt-admin', { compute: 20, databases: 30 }));
    expect([res.statusCode, json(res)]).toEqual([200, { settings: { compute: 20, databases: 30, updatedAt: iso(NOW), updatedBy: 'admin@example.com' } }]);
    expect(s.audits).toEqual([expect.objectContaining({ action: 'savings-discounts', target: 'savings', result: 'compute 20%, databases 30%' })]);
    const costs = await costsOf(s);
    expect(costs.discounts).toEqual({ compute: 20, databases: 30 });
    expect(costs.items.map((i: { hourly: number | null }) => i.hourly)).toEqual([expect.closeTo(0.8 * 0.0912, 6), expect.closeTo(0.7 * 0.017, 6), null]);
    expect(costs.saved.usd).toBeCloseTo(0.8 * 0.0912 + 0.7 * 0.017, 6);
  });

  it('are read at most once a minute: a change made by another container is seen after a minute', async () => {
    const s = setup();
    await costsOf(s);
    s.setStored({ compute: 50, databases: 50 });
    s.list[0]!.state = 'WAKING';
    expect('discounts' in (await costsOf(s))).toBe(false);
    expect(s.settingsReads()).toBe(1);
    s.later(61_000);
    s.list[0]!.state = 'ASLEEP';
    expect((await costsOf(s)).discounts).toEqual({ compute: 50, databases: 50 });
    expect(s.settingsReads()).toBe(2);
  });

  it('the history\'s savings, a workload\'s figures and the bar of all workloads are priced with the same discounts', async () => {
    const s = setup({ settings: { compute: 20, databases: 30 } });
    await s.api(event('/api/workloads/dmt-dev/a/history', { days: '7' }));
    await costsOf(s);
    const fleet = json(await s.api(event('/api/workloads/states')));
    expect(fleet.costs.discounts).toEqual({ compute: 20, databases: 30 });
    expect(s.discountsSeen.length).toBeGreaterThan(0);
    expect(new Set(s.discountsSeen.map((d) => JSON.stringify(d)))).toEqual(new Set([JSON.stringify({ compute: 20, databases: 30 })]));
  });
});
