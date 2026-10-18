// Tag-driven access control on the routes (tags design §5): rows filtered before the counts, an unreadable workload
// answers 404, a readable one without the permission 403 (audited), and the aggregates of what the caller reads.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type AuditEntry, type Router } from '../src/api.js';
import type { Operation } from '@dormeto/operations';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ACCOUNT = '121014831971';
const ROUTERS: Router[] = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT }];
const iso = (ms: number) => new Date(ms).toISOString();

const routerSummary = {
  account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev', version: '0.30.0', build: 'b1', checkSchedule: 'rate(5 minutes)', checkedAt: iso(NOW - 120_000), durationMs: 900,
  health: { status: 'ok', problems: [], lastScheduledCheckAt: iso(NOW - 120_000) }, pauses: [], counts: { AWAKE: 2, ASLEEP: 1 },
  check: { checkedAt: iso(NOW - 120_000), total: 3, received: [0] },
};
const summary = (id: string, state: string, over: Record<string, unknown> = {}): Record<string, unknown> & { account: string; region: string; workloadId: string } => ({
  account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, name: `Name ${id}`, state, targetGroupArn: `arn:tg/${id}`, url: `https://${id}.example.com/`,
  updatedAt: iso(NOW - 3_600_000), pauses: [], checkedAt: iso(NOW - 120_000), stats7d: { wakes: 2, ignored: 1, deferred: 0 }, ...over,
});
const WORKLOADS = [
  summary('pay', 'AWAKE', { tags: { team: 'payments', env: 'prod' } }),
  summary('search', 'ASLEEP', { tags: { team: 'search' } }),
  summary('plain', 'AWAKE'),
];

const GROUPS = [
  { name: 'payments', description: '', grants: [{ tags: { team: 'payments' }, permissions: ['read'] }], updatedAt: null, updatedBy: null },
  { name: 'payers', description: '', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake'] }], updatedAt: null, updatedBy: null },
];

const day = (date: string, id: string, usd: number) => ({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, usd, asleepHours: 2, hours: 2, unpriced: [] });
const DAYS: Record<string, ReturnType<typeof day>[]> = {};
for (const date of ['2026-10-16', '2026-10-17']) DAYS[date] = [day(date, 'pay', 1), day(date, 'search', 2), day(date, 'plain', 4)];
const dates = Array.from({ length: 31 }, (_, i) => iso(Date.parse('2026-10-17T00:00:00.000Z') - (30 - i) * 86_400_000).slice(0, 10));
const SAVINGS = {
  computedAt: iso(NOW - 3_600_000), day: '2026-10-17', baseline: { kind: 'always' },
  last30: { usd: 14, asleepHours: 12, days: dates.slice(1).map((date) => ({ date, usd: DAYS[date] ? 7 : 0 })) },
  month: { month: '2026-10', usd: 14 }, cumulative: { usd: 14, since: '2026-10-16', lastDay: '2026-10-17' }, counted: { '2026-10-16': 7, '2026-10-17': 7 }, failed: 0,
  top: [{ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'plain', usd: 8 }, { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'search', usd: 4 }, { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'pay', usd: 2 }],
  unpriced: { workloads: 0, hours: 0 }, workloads: 3, dormeto: { usdMonth: 30 },
};

const at = iso(NOW - 600_000);
const alarm = (id: string, kind: 'workload' | 'router' | 'list', over: Record<string, unknown> = {}) => ({
  subject: { id, kind, name: id, ...over }, level: 'warning', since: at, problems: [{ code: 'x', level: 'warning', text: 't', hint: 'h', since: at }], notified: [], cleared: {},
});
const ALARMS = [
  alarm('workload#pay', 'workload', { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'pay' }),
  alarm('workload#search', 'workload', { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'search' }),
  alarm('router#1', 'router', { account: ACCOUNT, region: 'eu-west-1' }),
  alarm('list#ipsum', 'list'),
];
const op = (id: string, type: string, target: Record<string, string>, context: Record<string, unknown> = {}) => ({ id, type, target, input: {}, status: 'succeeded', steps: [], cursor: 0, holds: { locks: [], slots: [] }, activeKey: id, context, by: 'a', createdAt: at, updatedAt: at }) as unknown as Operation;
const OPERATIONS = [
  op('o1', 'offboard', { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'pay' }),
  op('o2', 'offboard', { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'search' }),
  op('o3', 'upgrade-router', { account: ACCOUNT, region: 'eu-west-1' }),
  op('o4', 'onboard', { account: ACCOUNT, region: 'eu-west-1', targetGroupArn: 'arn:tg/pay' }, { workloadId: 'pay' }),
  op('o5', 'onboard', { account: ACCOUNT, region: 'eu-west-1', targetGroupArn: 'arn:tg/x' }),
];

function setup({ tagged = true }: { tagged?: boolean } = {}) {
  const audit: AuditEntry[] = [];
  const calls: [string, string][] = [];
  const workloads = tagged ? WORKLOADS : WORKLOADS.map(({ tags: _t, ...w }) => w);
  const api = createApi({
    routers: ROUTERS, now: () => NOW, version: '0.14.0', managerAccount: ACCOUNT, newId: () => 'id',
    audit: { write: async (e) => { audit.push(e); }, list: async () => [] },
    async invoke(router, payload) {
      calls.push([payload.action as string, String(payload.workloadId ?? '')]);
      if (payload.action === 'request-nap') return { requested: true };
      if (payload.action === 'force-wake') return { state: 'WAKING' };
      if (payload.action === 'status') return { workloadId: payload.workloadId, state: 'AWAKE' };
      return { ok: true };
    },
    fleet: {
      listRouters: async () => [routerSummary] as never,
      listWorkloads: async () => workloads as never,
      getWorkload: async (account: string, region: string, id: string) => (workloads.find((w) => w.account === account && w.region === region && w.workloadId === id) ?? null) as never,
      listGroups: async () => GROUPS as never,
      getSavingsSummary: async () => SAVINGS as never,
      getSavingsSettings: async () => ({ compute: 0, databases: 0, updatedAt: null, updatedBy: null }),
      listSavingsDay: async (date: string) => (DAYS[date] ?? []) as never,
      listHistory: async () => ({ entries: [], truncated: false }),
      historyBefore: async () => null,
    },
    alerts: { open: async () => ALARMS as never, subscriptions: async () => ({ topicArn: 'arn:topic', subscriptions: [] }) },
    operations: { list: async () => OPERATIONS, get: async (id: string) => OPERATIONS.find((o) => o.id === id) ?? null, create: async () => OPERATIONS[0]!, installedRouters: async () => [] } as never,
  });
  return { api, audit, calls };
}

const USERS = {
  viewer: '[dmt-viewer]', operator: '[dmt-operator]', pay: '[payments]', payWake: '[payers]', none: '',
};
const event = (user: keyof typeof USERS, method: string, path: string, query: Record<string, string> = {}, body?: unknown): ApiEvent => ({
  rawPath: path, queryStringParameters: query, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: `${user}@example.com`, sub: user, 'cognito:groups': USERS[user] } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const ids = (rows: { workloadId: string }[]) => rows.map((w) => w.workloadId);

describe('workload lists', () => {
  it('filters the rows before the counts: a member sees their workloads and counts of them only', async () => {
    const s = setup();
    const list = async (user: keyof typeof USERS) => json(await s.api(event(user, 'GET', '/api/workloads')));
    const viewer = await list('viewer');
    expect([ids(viewer.workloads), viewer.total, viewer.byState, viewer.stats7d]).toEqual([['pay', 'plain', 'search'], 3, { AWAKE: 2, ASLEEP: 1 }, { wakes: 6, ignored: 3, deferred: 0 }]);
    const pay = await list('pay');
    expect([ids(pay.workloads), pay.total, pay.byState, pay.stats7d]).toEqual([['pay'], 1, { AWAKE: 1 }, { wakes: 2, ignored: 1, deferred: 0 }]);
    const none = await list('none');
    expect([ids(none.workloads), none.total, none.byState, none.stats7d]).toEqual([[], 0, {}, { wakes: 0, ignored: 0, deferred: 0 }]);
    expect(none.errors).toEqual([]);
  });

  it('carries the tags and what the caller can do on each row', async () => {
    const s = setup();
    const rows = (await Promise.all((['viewer', 'operator', 'pay', 'payWake'] as const).map(async (u) => json(await s.api(event(u, 'GET', '/api/workloads'))).workloads))).map((w) => w.map((x: { workloadId: string; tags: unknown; can: unknown }) => [x.workloadId, x.tags, x.can]));
    expect(rows[0]).toEqual([['pay', { team: 'payments', env: 'prod' }, { wake: false, nap: false }], ['plain', {}, { wake: false, nap: false }], ['search', { team: 'search' }, { wake: false, nap: false }]]);
    expect(rows[1]!.map((r: unknown[]) => r[2])).toEqual([{ wake: true, nap: true }, { wake: true, nap: true }, { wake: true, nap: true }]);
    expect(rows[2]).toEqual([['pay', { team: 'payments', env: 'prod' }, { wake: false, nap: false }]]);
    expect(rows[3]).toEqual([['pay', { team: 'payments', env: 'prod' }, { wake: true, nap: false }]]);
  });

  it('a router before 0.30.0 (no tags): visible to built-in roles, never to a tag selector', async () => {
    const s = setup({ tagged: false });
    expect(ids(json(await s.api(event('viewer', 'GET', '/api/workloads'))).workloads)).toEqual(['pay', 'plain', 'search']);
    expect(ids(json(await s.api(event('pay', 'GET', '/api/workloads'))).workloads)).toEqual([]);
    expect(json(await s.api(event('viewer', 'GET', '/api/workloads'))).workloads[0].tags).toEqual({});
  });

  it('keeps the routers\' rows and errors to the built-in roles', async () => {
    const s = setup();
    expect(json(await s.api(event('viewer', 'GET', '/api/workloads', { routers: '1' }))).routers).toHaveLength(1);
    expect(json(await s.api(event('pay', 'GET', '/api/workloads', { routers: '1' }))).routers).toBeUndefined();
  });

  it('counts the states of what the caller reads', async () => {
    const s = setup();
    expect(json(await s.api(event('none', 'GET', '/api/workloads/states'))).workloads).toBe(0);
    expect(json(await s.api(event('pay', 'GET', '/api/workloads/states'))).workloads).toBe(1);
    expect(json(await s.api(event('viewer', 'GET', '/api/workloads/states'))).workloads).toBe(3);
  });
});

describe('one workload', () => {
  it('answers 404 as if absent when it cannot be read, whatever the route', async () => {
    const s = setup();
    for (const path of ['search', 'plain']) {
      for (const sub of ['', '/history', '/idle-window']) expect((await s.api(event('pay', 'GET', `/api/workloads/dmt-dev/${path}${sub}`))).statusCode, `${path}${sub}`).toBe(404);
      for (const act of ['wake', 'nap', 'pause', 'resume']) expect((await s.api(event('pay', 'POST', `/api/workloads/dmt-dev/${path}/${act}`, {}, { reason: 'x' }))).statusCode, `${path} ${act}`).toBe(404);
    }
    expect((await s.api(event('none', 'GET', '/api/workloads/dmt-dev/pay'))).statusCode).toBe(404);
    expect(s.calls).toEqual([]);
    expect(s.audit).toEqual([]);
  });

  it('reads a readable workload, with its tags and what the caller can do', async () => {
    const s = setup();
    const res = json(await s.api(event('payWake', 'GET', '/api/workloads/dmt-dev/pay')));
    expect([res.workloadId, res.tags, res.can]).toEqual(['pay', { team: 'payments', env: 'prod' }, { wake: true, nap: false }]);
    expect((await s.api(event('pay', 'GET', '/api/workloads/dmt-dev/pay/history'))).statusCode).toBe(200);
  });

  it('refuses with 403 and audits a nap, a pause and a resume without the permission; a wake with it goes through', async () => {
    const s = setup();
    const nap = await s.api(event('payWake', 'POST', '/api/workloads/dmt-dev/pay/nap'));
    expect([nap.statusCode, json(nap).error]).toEqual([403, 'forbidden']);
    expect((await s.api(event('payWake', 'POST', '/api/workloads/dmt-dev/pay/pause', {}, { reason: 'r' }))).statusCode).toBe(403);
    expect((await s.api(event('payWake', 'POST', '/api/workloads/dmt-dev/pay/resume'))).statusCode).toBe(403);
    expect((await s.api(event('pay', 'POST', '/api/workloads/dmt-dev/pay/wake'))).statusCode).toBe(403);
    expect(s.calls).toEqual([]);
    expect(s.audit.map((e) => [e.action, e.target, e.result, e.who, e.groups])).toEqual([
      ['nap', 'dmt-dev/pay', 'refused', 'payWake@example.com', ['payers']],
      ['pause', 'dmt-dev/pay', 'refused', 'payWake@example.com', ['payers']],
      ['resume', 'dmt-dev/pay', 'refused', 'payWake@example.com', ['payers']],
      ['wake', 'dmt-dev/pay', 'refused', 'pay@example.com', ['payments']],
    ]);
    expect(s.audit[0]!.reason).toMatch(/nap/);
    const woke = await s.api(event('payWake', 'POST', '/api/workloads/dmt-dev/pay/wake'));
    expect(woke.statusCode).toBe(200);
    expect(s.calls).toEqual([['force-wake', 'pay']]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'wake', result: 'WAKING', groups: ['payers'] });
  });

  it('keeps the built-in roles: an operator acts on every workload, a viewer is refused (and audited)', async () => {
    const s = setup();
    expect((await s.api(event('operator', 'POST', '/api/workloads/dmt-dev/plain/nap'))).statusCode).toBe(202);
    expect((await s.api(event('operator', 'POST', '/api/workloads/dmt-dev/search/pause', {}, { reason: 'r' }))).statusCode).toBe(200);
    expect((await s.api(event('viewer', 'POST', '/api/workloads/dmt-dev/plain/nap'))).statusCode).toBe(403);
    expect(s.audit.at(-1)).toMatchObject({ action: 'nap', result: 'refused', groups: [] });
  });

  it('keeps every other route closed to a member', async () => {
    const s = setup();
    for (const [method, path] of [['POST', '/api/workloads/dmt-dev/pay/rename'], ['GET', '/api/routers'], ['GET', '/api/discovery/candidates'], ['GET', '/api/users'], ['GET', '/api/audit'], ['POST', '/api/operations'], ['POST', '/api/routers/dmt-dev/pause'], ['GET', '/api/exclusions']] as const) {
      expect((await s.api(event('payWake', method, path, {}, method === 'POST' ? { name: 'x', type: 'offboard' } : undefined))).statusCode, `${method} ${path}`).toBe(403);
    }
  });
});

describe('aggregates', () => {
  const savings = async (s: ReturnType<typeof setup>, user: keyof typeof USERS) => json(await s.api(event(user, 'GET', '/api/savings'))).summary;

  it('gives a member the sums of the readable workloads\' days; a viewer\'s are unchanged', async () => {
    const s = setup();
    expect(await savings(s, 'viewer')).toEqual(SAVINGS);
    const pay = await savings(s, 'pay');
    expect([pay.last30.usd, pay.last30.asleepHours, pay.month.usd, pay.cumulative.usd, pay.counted, pay.workloads, pay.top.map((t: { workloadId: string; usd: number }) => [t.workloadId, t.usd])])
      .toEqual([2, 4, 2, 2, { '2026-10-16': 1, '2026-10-17': 1 }, 1, [['pay', 2]]]);
    expect(pay.last30.days.filter((d: { usd: number }) => d.usd > 0)).toEqual([{ date: '2026-10-16', usd: 1 }, { date: '2026-10-17', usd: 1 }]);
    const none = await savings(s, 'none');
    expect([none.last30.usd, none.month.usd, none.cumulative.usd, none.workloads, none.top]).toEqual([0, 0, 0, 0, []]);
    expect(pay.dormeto).toBeUndefined();
  });

  it('filters the alerts: workload alarms by read, the router, list alarms for the built-in roles', async () => {
    const s = setup();
    const alarms = async (user: keyof typeof USERS) => { const r = json(await s.api(event(user, 'GET', '/api/alerts'))); return [r.alarms.map((a: { id: string }) => a.id), r.notifications] as const; };
    expect((await alarms('viewer'))[0]).toEqual(['workload#pay', 'workload#search', 'router#1', 'list#ipsum']);
    expect(await alarms('pay')).toEqual([['workload#pay'], null]);
    expect((await alarms('none'))[0]).toEqual([]);
  });

  it('filters the operations: workload operations by read of the target, the others for the built-in roles', async () => {
    const s = setup();
    const list = async (user: keyof typeof USERS) => json(await s.api(event(user, 'GET', '/api/operations'))).operations.map((o: { id: string }) => o.id);
    expect(await list('viewer')).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(await list('pay')).toEqual(['o1', 'o4']);
    expect(await list('none')).toEqual([]);
    expect((await s.api(event('pay', 'GET', '/api/operations/o1'))).statusCode).toBe(200);
    for (const id of ['o2', 'o3', 'o5']) expect((await s.api(event('pay', 'GET', `/api/operations/${id}`))).statusCode, id).toBe(404);
  });
});
