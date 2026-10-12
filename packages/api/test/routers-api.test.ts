import { describe, expect, it } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Router } from '../src/api.js';
import { fleetRouters } from '../src/routers.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const HOUR = 3_600_000;
const ROUTERS: Router[] = [
  { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: '121014831971' },
  { name: 'dmt-old', region: 'eu-west-3', controller: 'dmt-old-controller', account: '121014831971' },
];

const ROUTER_INFO = {
  router: { name: 'dmt-dev', version: '0.16.0', build: 'abc' },
  configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' } },
  pauses: [{ scope: 'router', by: 'ops@example.com', at: '2026-10-05T11:00:00.000Z', reason: 'freeze', until: null, keepAsleep: true }],
  workloads: { total: 4, byState: { AWAKE: 1, ASLEEP: 3 }, paused: 4, lastActivityAt: '2026-10-05T11:30:00.000Z' },
  health: { status: 'warning', problems: [{ level: 'warning', text: 'controller: 5 errors in 24 hours' }], checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-05T11:58:00.000Z', lambda: {}, queues: {}, ipLists: [] },
};

// dmt-dev is a 0.16 router; dmt-old a 0.15 router (no router, pause, resume or request-nap action).
function setup(answers: Record<string, (payload: Record<string, unknown>) => unknown> = {}) {
  const calls: [string, Record<string, unknown>, unknown][] = [];
  const audit: AuditEntry[] = [];
  const api = createApi({
    routers: ROUTERS,
    async invoke(router, payload, options) {
      calls.push([router.name, payload, options]);
      const action = payload.action as string;
      if (router.name === 'dmt-old' && ['router', 'pause', 'resume', 'request-nap'].includes(action)) throw new RouterError(`unknown action: ${action}`);
      if (answers[action]) return answers[action](payload);
      if (action === 'router') return ROUTER_INFO;
      if (action === 'list') return { router: { name: router.name, version: '0.15.0', build: 'old', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-05T11:58:00.000Z' }, workloads: [{}, {}] };
      return null;
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.2.0',
  });
  return { api, calls, audit };
}

function event(method: string, path: string, groups = '', body?: unknown): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('routers', () => {
  it('lists every router with its account, version, health, pauses and workloads; an older router through list', async () => {
    const { api } = setup();
    const { routers } = json(await api(event('GET', '/api/routers')));
    expect(routers[0]).toEqual({
      name: 'dmt-dev', region: 'eu-west-1', account: '121014831971', source: 'terraform', version: '0.16.0', build: 'abc', workloads: 4,
      checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-05T11:58:00.000Z',
      health: { status: 'warning', problems: [{ level: 'warning', text: 'controller: 5 errors in 24 hours' }] },
      pauses: ROUTER_INFO.pauses, workloadStates: { AWAKE: 1, ASLEEP: 3 }, paused: 4, lastActivityAt: '2026-10-05T11:30:00.000Z', reporting: false,
    });
    expect(routers[1]).toEqual({
      name: 'dmt-old', region: 'eu-west-3', account: '121014831971', source: 'terraform', version: '0.15.0', build: 'old', workloads: 2,
      checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-05T11:58:00.000Z', reporting: false,
    });
  });

  it('reports an unreachable router apart', async () => {
    const { api } = setup({ router: () => { throw new RouterError('throttled'); } });
    const { routers } = json(await api(event('GET', '/api/routers')));
    expect(routers[0]).toEqual({ name: 'dmt-dev', region: 'eu-west-1', account: '121014831971', source: 'terraform', error: 'throttled', reporting: false });
  });

  it('gives the details of one router: configuration and health figures', async () => {
    const { api } = setup();
    const res = json(await api(event('GET', '/api/routers/dmt-dev')));
    expect(res).toMatchObject({ name: 'dmt-dev', region: 'eu-west-1', account: '121014831971', configuration: ROUTER_INFO.configuration, health: ROUTER_INFO.health });
    expect((await api(event('GET', '/api/routers/nope'))).statusCode).toBe(404);
  });
});

describe('the router\'s clusters (R10.5)', () => {
  it('lists and details a router with the EKS clusters of its account and region, as its last check found them', async () => {
    const clusters = [{ name: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes'], checkedAt: '2026-10-05T11:00:00.000Z' }];
    const api = createApi({
      routers: [{ ...ROUTERS[0]!, clusters }],
      async invoke(_router, payload) { return payload.action === 'router' ? ROUTER_INFO : null; },
      audit: { write: async () => {}, list: async () => [] },
      now: () => NOW, newId: () => 'id-1', version: '0.2.0',
    });
    expect(json(await api(event('GET', '/api/routers/dmt-dev'))).clusters).toEqual(clusters);
    expect(json(await api(event('GET', '/api/routers'))).routers[0].clusters).toEqual(clusters);
  });

  it('the manager\'s routers carry the clusters their operations checked', () => {
    const clusters = [{ name: 'eks-demo', reachable: true, allowed: true, missing: [], checkedAt: '2026-10-05T11:00:00.000Z' }];
    const [router] = fleetRouters([], [{ name: 'dmtr-dev', account: '121014831971', region: 'eu-west-1', controller: 'c', onboarder: 'o', version: '0.29.0', build: 'b', installedBy: 'a', installedAt: 'x', clusters }], '121014831971');
    expect(router!.clusters).toEqual(clusters);
  });
});

describe('pause and resume', () => {
  const until = new Date(NOW + 2 * HOUR).toISOString();

  it('pauses a router for operators, with the reason, the automatic resume and keep asleep, audited', async () => {
    const { api, calls, audit } = setup({ pause: () => ({ pause: { scope: 'router' }, woken: [] }) });
    expect((await api(event('POST', '/api/routers/dmt-dev/pause', 'dmt-viewer', { reason: 'freeze' }))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/routers/dmt-dev/pause', 'dmt-operator', { reason: ' change freeze ', until, keepAsleep: true }));
    expect(res.statusCode).toBe(200);
    expect(calls.at(-1)!.slice(0, 2)).toEqual(['dmt-dev', { action: 'pause', by: 'ops@example.com', reason: 'change freeze', until, keepAsleep: true }]);
    expect(audit).toEqual([{ id: 'id-1', at: new Date(NOW).toISOString(), who: 'ops@example.com', role: 'operator', action: 'router-pause', target: 'dmt-dev', result: `change freeze; until ${until}; keep asleep` }]);
  });

  it('pauses a workload and records the workloads woken; resumes it', async () => {
    const { api, calls, audit } = setup({ pause: () => ({ pause: { scope: 'workload' }, woken: ['demo'] }), resume: () => ({ resumed: true }) });
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/pause', 'dmt-operator', { reason: 'load test' }))).statusCode).toBe(200);
    expect(calls.at(-1)![1]).toEqual({ action: 'pause', workloadId: 'demo', by: 'ops@example.com', reason: 'load test', keepAsleep: false });
    expect(audit.at(-1)).toMatchObject({ action: 'pause', target: 'dmt-dev/demo', result: 'load test; woken demo' });
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/resume', 'dmt-operator'));
    expect(json(res)).toEqual({ resumed: true });
    expect(calls.at(-1)![1]).toEqual({ action: 'resume', workloadId: 'demo', by: 'ops@example.com' });
    expect(audit.at(-1)).toMatchObject({ action: 'resume', target: 'dmt-dev/demo', result: 'resumed' });
  });

  it('resumes a router; resuming what is not paused is reported', async () => {
    const { api, audit } = setup({ resume: () => ({ resumed: false }) });
    expect(json(await api(event('POST', '/api/routers/dmt-dev/resume', 'dmt-admin')))).toEqual({ resumed: false });
    expect(audit.at(-1)).toMatchObject({ action: 'router-resume', target: 'dmt-dev', result: 'not paused' });
  });

  it('refuses a pause without a reason, with an automatic resume in the past or beyond 366 days, or a non-boolean keep asleep', async () => {
    const { api, calls, audit } = setup();
    for (const body of [{}, { reason: '' }, { reason: 'x'.repeat(257) }, { reason: 'a', until: new Date(NOW - 1000).toISOString() },
      { reason: 'a', until: new Date(NOW + 367 * 24 * HOUR).toISOString() }, { reason: 'a', until: 'tomorrow' }, { reason: 'a', keepAsleep: 'yes' }]) {
      expect((await api(event('POST', '/api/routers/dmt-dev/pause', 'dmt-operator', body))).statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('a router without pause support answers 502 with an upgrade hint', async () => {
    const { api } = setup();
    const res = await api(event('POST', '/api/routers/dmt-old/pause', 'dmt-operator', { reason: 'a' }));
    expect(res.statusCode).toBe(502);
    expect(json(res).message).toBe('router dmt-old does not support pause: upgrade it to 0.16.0 or later');
  });
});

describe('nap', () => {
  it('requests the nap from the router: accepted, or refused with its reason', async () => {
    let answer: unknown = { requested: true };
    const { api, calls, audit } = setup({ 'request-nap': () => answer });
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([202, { accepted: true }]);
    expect(calls.at(-1)!.slice(0, 2)).toEqual(['dmt-dev', { action: 'request-nap', workloadId: 'demo', by: 'ops@example.com' }]);
    expect(audit.at(-1)).toMatchObject({ action: 'nap', result: 'requested' });
    answer = { requested: false, reason: 'paused by ops@example.com: load test' };
    const refused = await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-operator'));
    expect([refused.statusCode, json(refused)]).toEqual([409, { error: 'conflict', message: 'paused by ops@example.com: load test' }]);
    expect(audit.at(-1)).toMatchObject({ action: 'nap', result: 'error: paused by ops@example.com: load test' });
  });

  it('an older router naps asynchronously, as before', async () => {
    const { api, calls } = setup();
    const res = await api(event('POST', '/api/workloads/dmt-old/demo/nap', 'dmt-operator'));
    expect(res.statusCode).toBe(202);
    expect(calls.at(-1)!.slice(1)).toEqual([{ action: 'nap', workloadId: 'demo' }, { async: true }]);
  });
});
