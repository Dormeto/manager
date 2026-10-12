// Workloads and routers read from the summaries the routers push (scale design §4): no router is called per poll; a
// router that does not report is called, within a timeout and a cap.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type Router } from '../src/api.js';

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
], invoke = async (_r: Router, payload: Record<string, unknown>) => (payload.action === 'list' ? { router: { version: '0.20.1' }, workloads: [{ workloadId: 'x', state: 'AWAKE' }] } : { router: { version: '0.20.1' }, pauses: [], workloads: { total: 1, byState: { AWAKE: 1 }, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } }), visible, callTimeoutMs }: {
  routers?: Router[]; summaries?: ReturnType<typeof routerSummary>[]; workloads?: ReturnType<typeof workloadSummary>[];
  invoke?: (router: Router, payload: Record<string, unknown>) => Promise<unknown>; visible?: (identity: unknown, item: { account?: string; region: string }) => boolean; callTimeoutMs?: number;
} = {}) {
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
    ...(visible ? { visible } : {}), ...(callTimeoutMs ? { callTimeoutMs } : {}),
  });
  return { api, calls, listed: () => listed };
}
const event = (path: string, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'ops@example.com', sub: 'u1', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

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
