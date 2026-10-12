// Workloads and routers read from the summaries the routers push (scale design §4): no router is called per poll; a
// router that does not report is called, within a timeout and a cap.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type OperationsApi, type Router } from '../src/api.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ACCOUNT = '121014831971';
const ROUTERS: Router[] = [
  { name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT },
  { name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', controller: 'c3', account: ACCOUNT },
];
const routerSummary = (region: string, name: string, over: Record<string, unknown> = {}) => ({
  account: ACCOUNT, region, name, version: '0.21.1', build: 'b1', checkSchedule: 'rate(5 minutes)', checkedAt: '2026-10-05T11:58:00.000Z', durationMs: 900,
  health: { status: 'ok', problems: [], lastScheduledCheckAt: '2026-10-05T11:58:00.000Z' }, pauses: [], counts: { AWAKE: 1, ASLEEP: 1 },
  check: { checkedAt: '2026-10-05T11:58:00.000Z', total: 1, received: [0] }, ...over,
});
const workloadSummary = (region: string, router: string, id: string, state: string, over: Record<string, unknown> = {}) => ({
  account: ACCOUNT, region, router, workloadId: id, name: `Name ${id}`, state, targetGroupArn: `arn:tg/${id}`, url: `https://${id}.example.com/`,
  updatedAt: '2026-10-05T11:00:00.000Z', pauses: [], checkedAt: '2026-10-05T11:58:00.000Z', ...over,
});

function setup({ routers = ROUTERS, summaries = [routerSummary('eu-west-1', 'dmt-dev'), routerSummary('eu-west-3', 'dmtr-dev', { counts: { ASLEEP: 1 } })], workloads = [
  workloadSummary('eu-west-1', 'dmt-dev', 'a', 'AWAKE'), workloadSummary('eu-west-1', 'dmt-dev', 'b', 'ASLEEP'), workloadSummary('eu-west-3', 'dmtr-dev', 'p', 'ASLEEP', { name: 'Paris' }),
], invoke = async (_r: Router, payload: Record<string, unknown>) => (payload.action === 'list' ? { router: { version: '0.20.1' }, workloads: [{ workloadId: 'x', state: 'AWAKE' }] } : { router: { version: '0.20.1' }, pauses: [], workloads: { total: 1, byState: { AWAKE: 1 }, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } }), visible, callTimeoutMs, callDeadlineMs, operations, candidates }: {
  routers?: Router[]; summaries?: ReturnType<typeof routerSummary>[]; workloads?: ReturnType<typeof workloadSummary>[];
  invoke?: (router: Router, payload: Record<string, unknown>) => Promise<unknown>; visible?: (identity: unknown, item: { account?: string; region: string }) => boolean; callTimeoutMs?: number;
  callDeadlineMs?: number; operations?: OperationsApi; candidates?: Record<string, { idleHours7d: number | null; requests7d: number | null }>;
} = {}) {
  const asked: string[] = [];
  const calls: [string, string][] = [];
  let listed = 0;
  const api = createApi({
    routers, now: () => NOW, version: '0.2.0', managerAccount: ACCOUNT,
    audit: { write: async () => {}, list: async () => [] },
    async invoke(router, payload) {
      calls.push([router.name, payload.action as string]);
      return invoke(router, payload);
    },
    fleet: {
      listRouters: async () => summaries as never,
      listWorkloads: async () => { listed += 1; return workloads as never; },
      getWorkload: async (account: string, region: string, id: string) => (workloads.find((w) => w.account === account && w.region === region && w.workloadId === id) ?? null) as never,
    },
    ...(visible ? { visible } : {}), ...(callTimeoutMs ? { callTimeoutMs } : {}), ...(callDeadlineMs ? { callDeadlineMs } : {}), ...(operations ? { operations } : {}),
    ...(candidates ? { discovery: { store: { getCandidate: async (id: string) => { asked.push(id); return (candidates[id] ?? null) as never; } }, run: async () => {} } as never } : {}),
  });
  return { api, calls, listed: () => listed, asked };
}
const event = (path: string, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'ops@example.com', sub: 'u1', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
// The router the manager installed in eu-west-3 (dmtr-dev), upgraded to 0.21.2 at 11:59, after its last report (11:58).
const installed = { name: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-3', controller: 'c3', onboarder: 'o3', version: '0.21.2', build: 'b2', installedBy: 'ops@example.com', installedAt: '2026-10-05T11:59:00.000Z' };
const routerOperation = (id: string, type: string, status: string, region = 'eu-west-3') => ({
  id, type, status, target: { account: ACCOUNT, region }, input: {}, steps: [], cursor: 0, holds: { locks: [], slots: [] }, activeKey: '', context: {}, by: 'ops@example.com',
  createdAt: '2026-10-05T11:59:30.000Z', updatedAt: '2026-10-05T11:59:30.000Z',
});
const withOperations = (list: ReturnType<typeof routerOperation>[] = []): OperationsApi => ({
  create: async () => { throw new Error('unused'); }, list: async () => list as never, get: async () => null, installedRouters: async () => [installed],
});

describe('workloads and routers from the summaries', () => {
  it('reads the summaries: no router is called for routers that report', async () => {
    const s = setup();
    const workloads = json(await s.api(event('/api/workloads')));
    expect(s.calls).toEqual([]);
    expect(workloads.workloads.map((w: { router: string; workloadId: string; name: string }) => [w.router, w.workloadId, w.name])).toEqual([
      ['dmt-dev', 'a', 'Name a'], ['dmt-dev', 'b', 'Name b'], ['dmtr-dev-eu-west-3', 'p', 'Paris'],
    ]);
    expect([workloads.total, workloads.byState]).toEqual([3, { AWAKE: 1, ASLEEP: 2 }]);
    const routers = json(await s.api(event('/api/routers'))).routers;
    expect(s.calls).toEqual([]);
    expect(routers.map((r: Record<string, unknown>) => [r.name, r.version, r.workloads, r.reporting, (r.health as { status: string }).status])).toEqual([
      ['dmt-dev', '0.21.1', 2, true, 'ok'], ['dmtr-dev-eu-west-3', '0.21.1', 1, true, 'ok'],
    ]);
  });

  it('shows the version an upgrade installed until the router reports after it', async () => {
    const s = setup({ routers: [ROUTERS[0]!], operations: withOperations() });
    const row = () => s.api(event('/api/routers')).then((res) => json(res).routers.find((r: { name: string }) => r.name === 'dmtr-dev-eu-west-3'));
    expect([(await row()).version, (await row()).build]).toEqual(['0.21.2', 'b2']);
  });

  it('names the router operation running on each router (install, upgrade or uninstall), not the others', async () => {
    const s = setup({ routers: [ROUTERS[0]!], operations: withOperations([
      routerOperation('op-up', 'upgrade-router', 'running'), routerOperation('op-old', 'upgrade-router', 'succeeded'), routerOperation('op-onb', 'onboard', 'running', 'eu-west-1'),
    ]) });
    const routers = json(await s.api(event('/api/routers'))).routers;
    expect(routers.map((r: { name: string; operation?: unknown }) => [r.name, r.operation ?? null])).toEqual([
      ['dmt-dev', null], ['dmtr-dev-eu-west-3', { id: 'op-up', type: 'upgrade-router' }],
    ]);
  });

  it('gives the workloads of a page their idle hours and requests over 7 days from their discovery candidate, when asked', async () => {
    const s = setup({ candidates: { 'arn:tg/a': { idleHours7d: 150, requests7d: 12 }, 'arn:tg/b': { idleHours7d: null, requests7d: null } } });
    const plain = json(await s.api(event('/api/workloads', { limit: '2' }))).workloads;
    expect([s.asked, 'idleHours7d' in plain[0]]).toEqual([[], false]);
    const page = json(await s.api(event('/api/workloads', { limit: '2', idle: '1' }))).workloads;
    expect(page.map((w: Record<string, unknown>) => [w.workloadId, w.idleHours7d ?? 'none', w.requests7d ?? 'none'])).toEqual([['a', 150, 12], ['b', 'none', 'none']]);
    expect(s.asked).toEqual(['arn:tg/a', 'arn:tg/b']);
  });

  it('calls a router that does not report (no summary, or one older than 3 periods), and only that one', async () => {
    const s = setup({ summaries: [routerSummary('eu-west-1', 'dmt-dev'), routerSummary('eu-west-3', 'dmtr-dev', { checkedAt: '2026-10-05T11:00:00.000Z' })] });
    const workloads = json(await s.api(event('/api/workloads'))).workloads;
    expect(s.calls).toEqual([['dmtr-dev-eu-west-3', 'list']]);
    expect(workloads.map((w: { router: string; workloadId: string }) => `${w.router}/${w.workloadId}`)).toEqual(['dmt-dev/a', 'dmt-dev/b', 'dmtr-dev-eu-west-3/x']);
    const routers = json(await s.api(event('/api/routers'))).routers;
    expect(routers.map((r: Record<string, unknown>) => [r.name, r.version, r.reporting])).toEqual([['dmt-dev', '0.21.1', true], ['dmtr-dev-eu-west-3', '0.20.1', false]]);
  });

  it('calls routers that do not report at most 10 at a time, each within its timeout', async () => {
    const many = Array.from({ length: 25 }, (_, i): Router => ({ name: `r${i}`, region: 'eu-west-1', controller: `c${i}`, account: String(100000000000 + i) }));
    let running = 0;
    let peak = 0;
    const s = setup({
      routers: many, summaries: [], workloads: [], callTimeoutMs: 50,
      invoke: async (router) => {
        running += 1;
        peak = Math.max(peak, running);
        // One router never answers.
        if (router.name === 'r7') return new Promise(() => {});
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return { workloads: [{ workloadId: router.name, state: 'AWAKE' }] };
      },
    });
    const body = json(await s.api(event('/api/workloads')));
    expect(peak).toBeLessThanOrEqual(10);
    expect(body.workloads).toHaveLength(24);
    expect(body.errors).toEqual([{ router: 'r7', message: 'no answer within 50 ms' }]);
  });

  it('a router call that timed out keeps its place until the router answers: at most 10 router Lambdas run at once, and the answer does not wait for them', async () => {
    const many = Array.from({ length: 30 }, (_, i): Router => ({ name: `r${i}`, region: 'eu-west-1', controller: `c${i}`, account: String(100000000000 + i) }));
    let running = 0;
    let peak = 0;
    const s = setup({
      routers: many, summaries: [], workloads: [], callTimeoutMs: 30, callDeadlineMs: 2000,
      invoke: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 300));
        running -= 1;
        return { workloads: [] };
      },
    });
    const started = Date.now();
    const body = json(await s.api(event('/api/workloads')));
    expect(peak).toBeLessThanOrEqual(10);
    // Three rounds of 10, each started when the round before has answered; the last one's answers are not awaited.
    expect(Date.now() - started).toBeLessThan(850);
    expect(body.errors).toHaveLength(30);
    expect(body.errors.every((e: { message: string }) => e.message === 'no answer within 30 ms')).toBe(true);
  });

  it('stops calling routers that do not report once the request\'s budget is spent: the others are listed as not called', async () => {
    const many = Array.from({ length: 40 }, (_, i): Router => ({ name: `r${i}`, region: 'eu-west-1', controller: `c${i}`, account: String(100000000000 + i) }));
    const s = setup({
      routers: many, summaries: [], workloads: [], callTimeoutMs: 1000, callDeadlineMs: 100,
      invoke: async (router) => {
        await new Promise((r) => setTimeout(r, 40));
        return { workloads: [{ workloadId: router.name, state: 'AWAKE' }] };
      },
    });
    const started = Date.now();
    const body = json(await s.api(event('/api/workloads')));
    // 10 at a time, 40 ms each, 100 ms of budget: three rounds at most are started, the last one cut at the deadline.
    expect(Date.now() - started).toBeLessThan(400);
    expect(body.workloads.length).toBeGreaterThanOrEqual(10);
    expect(body.workloads.length).toBeLessThan(40);
    expect(body.errors.length + body.workloads.length).toBe(40);
    expect(body.errors.some((e: { message: string }) => /not called: no time left/.test(e.message))).toBe(true);
  });

  it('never calls a router the caller may not see', async () => {
    const s = setup({ summaries: [routerSummary('eu-west-1', 'dmt-dev')], visible: (_identity, item) => item.region !== 'eu-west-3' });
    const body = json(await s.api(event('/api/workloads')));
    expect([s.calls, body.errors]).toEqual([[], []]);
  });

  it('filters by state, router and text, pages with a cursor, and hides what the caller may not see', async () => {
    const s = setup({ visible: (_identity, item) => item.region !== 'eu-west-3' });
    const asleep = json(await s.api(event('/api/workloads', { state: 'ASLEEP' })));
    expect([asleep.workloads.map((w: { workloadId: string }) => w.workloadId), asleep.total, asleep.byState]).toEqual([['b'], 1, { AWAKE: 1, ASLEEP: 1 }]);
    const first = json(await s.api(event('/api/workloads', { limit: '1' })));
    const second = json(await s.api(event('/api/workloads', { limit: '1', cursor: first.cursor })));
    expect([first.workloads[0].workloadId, second.workloads[0].workloadId, second.cursor]).toEqual(['a', 'b', null]);
    expect(json(await s.api(event('/api/workloads', { q: 'name b' }))).workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['b']);
    expect(json(await s.api(event('/api/workloads', { router: 'dmt-dev', state: 'AWAKE' }))).workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['a']);
    expect(json(await s.api(event('/api/routers'))).routers.map((r: { name: string }) => r.name)).toEqual(['dmt-dev']);
    expect((await s.api(event('/api/workloads', { cursor: 'nope' }))).statusCode).toBe(400);
    // A page by its offset (the dashboard's page number).
    expect(json(await s.api(event('/api/workloads', { limit: '1', offset: '1' }))).workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['b']);
    expect((await s.api(event('/api/workloads', { offset: '-1' }))).statusCode).toBe(400);
  });

  it('gives a workload\'s status its link from its summary, without listing every workload', async () => {
    const s = setup({ invoke: async () => ({ workloadId: 'p', state: 'ASLEEP' }) });
    const status = json(await s.api(event('/api/workloads/dmtr-dev-eu-west-3/p')));
    expect([status.state, status.url, s.listed()]).toEqual(['ASLEEP', 'https://p.example.com/', 0]);
    expect(json(await s.api(event('/api/workloads/dmt-dev/nope'))).url).toBeNull();
  });

  it('gives the Overview its routers in the same request: a router that does not report is called once, by its list', async () => {
    const s = setup({ summaries: [routerSummary('eu-west-1', 'dmt-dev')] });
    const body = json(await s.api(event('/api/workloads', { attention: '1', limit: '20', routers: '1' })));
    expect(s.calls).toEqual([['dmtr-dev-eu-west-3', 'list']]);
    expect(body.routers.map((r: Record<string, unknown>) => [r.name, r.reporting, r.version, r.workloads])).toEqual([['dmt-dev', true, '0.21.1', 2], ['dmtr-dev-eu-west-3', false, '0.20.1', 1]]);
    // Without the parameter, no router rows.
    expect(json(await s.api(event('/api/workloads', { attention: '1', limit: '20' }))).routers).toBeUndefined();
  });

  it('gives the Overview its counts, 7-day totals and the workloads that need attention, without listing them all', async () => {
    const s = setup({ workloads: [
      workloadSummary('eu-west-1', 'dmt-dev', 'a', 'AWAKE', { stats7d: { wakes: 2, ignored: 5, deferred: 1 } }),
      workloadSummary('eu-west-1', 'dmt-dev', 'b', 'FAILED', { stats7d: { wakes: 1, ignored: 0, deferred: 0 } }),
      workloadSummary('eu-west-1', 'dmt-dev', 'c', 'ASLEEP', { pauses: [{ scope: 'workload', reason: 'freeze' }] }),
      workloadSummary('eu-west-3', 'dmtr-dev', 'p', 'ASLEEP'),
    ] });
    const body = json(await s.api(event('/api/workloads', { attention: '1', limit: '20' })));
    expect(body.workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['b', 'c']);
    expect([body.byState, body.stats7d]).toEqual([{ AWAKE: 1, FAILED: 1, ASLEEP: 2 }, { wakes: 3, ignored: 5, deferred: 1 }]);
  });
});
