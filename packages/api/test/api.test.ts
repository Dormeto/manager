import { describe, expect, it } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const ROUTERS = [
  { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller' },
  { name: 'dmt-test', region: 'eu-west-3', controller: 'dmt-test-controller' },
];
const NOW = Date.UTC(2026, 9, 4, 12, 0);

function setup(invoke: Invoke) {
  const audit: AuditEntry[] = [];
  const api = createApi({
    routers: ROUTERS,
    invoke,
    audit: { write: async (entry) => { audit.push(entry); }, list: async () => audit },
    now: () => NOW,
    newId: () => 'id-1',
    version: '0.1.0',
  });
  return { api, audit };
}

function event(method: string, path: string, groups: string | null = null, body?: unknown): ApiEvent {
  const claims: Record<string, string> = { email: 'ops@example.com', sub: 'u-1' };
  if (groups !== null) claims['cognito:groups'] = `[${groups}]`;
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('health and identity', () => {
  it('answers health without authentication', async () => {
    const { api } = setup(async () => ({}));
    const res = await api({ rawPath: '/api/health', requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'ok', version: '0.1.0' });
  });

  it('derives the role from the highest Cognito group, viewer by default', async () => {
    const { api } = setup(async () => ({}));
    expect(json(await api(event('GET', '/api/me', 'dmt-viewer dmt-admin')))).toEqual({ email: 'ops@example.com', groups: ['dmt-viewer', 'dmt-admin'], role: 'admin' });
    expect(json(await api(event('GET', '/api/me', 'dmt-operator'))).role).toBe('operator');
    expect(json(await api(event('GET', '/api/me'))).role).toBe('viewer');
  });

  it('rejects calls without identity', async () => {
    const { api } = setup(async () => ({}));
    const res = await api({ rawPath: '/api/workloads', requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(401);
  });
});

describe('workloads', () => {
  it('lists the workloads of every router, a failing router reported apart', async () => {
    const { api } = setup(async (router) => {
      if (router.name === 'dmt-test') throw new RouterError('router unreachable');
      return { router: { name: 'dmt-dev', version: '0.11.0', build: 'abc' }, workloads: [{ workloadId: 'demo', state: 'AWAKE' }] };
    });
    const res = await api(event('GET', '/api/workloads'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      workloads: [{ router: 'dmt-dev', workloadId: 'demo', state: 'AWAKE' }],
      errors: [{ router: 'dmt-test', message: 'router unreachable' }],
    });
  });

  it('lists the routers with their version', async () => {
    const { api } = setup(async (router) => ({
      router: { name: router.name, version: '0.11.2', build: 'abc', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:58:00.000Z' },
      workloads: [{}, {}],
    }));
    expect(json(await api(event('GET', '/api/routers'))).routers[0]).toEqual({
      name: 'dmt-dev', region: 'eu-west-1', version: '0.11.2', build: 'abc', workloads: 2,
      checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:58:00.000Z',
    });
  });

  it('reads the live status of a workload', async () => {
    const calls: unknown[] = [];
    const { api } = setup(async (router, payload) => { calls.push([router.name, payload]); return { workloadId: 'demo', state: 'ASLEEP' }; });
    const res = await api(event('GET', '/api/workloads/dmt-dev/demo'));
    expect(json(res)).toEqual({ workloadId: 'demo', state: 'ASLEEP' });
    expect(calls).toEqual([['dmt-dev', { action: 'status', workloadId: 'demo' }]]);
  });

  it('answers 404 for an unknown router, 400 for an invalid workload id', async () => {
    const { api } = setup(async () => ({}));
    expect((await api(event('GET', '/api/workloads/nope/demo'))).statusCode).toBe(404);
    expect((await api(event('GET', '/api/workloads/dmt-dev/..%2Fx'))).statusCode).toBe(400);
  });

  it('maps router errors to 502', async () => {
    const { api } = setup(async () => { throw new RouterError('workload not configured: demo'); });
    const res = await api(event('GET', '/api/workloads/dmt-dev/demo'));
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: 'router_error', message: 'workload not configured: demo' });
  });
});

describe('actions', () => {
  it('nap and wake need the operator role', async () => {
    const { api, audit } = setup(async () => ({}));
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-viewer'))).statusCode).toBe(403);
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/wake'))).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });

  it('nap is requested asynchronously and audited', async () => {
    const calls: unknown[] = [];
    const { api, audit } = setup(async (router, payload, options) => { calls.push([payload, options]); return null; });
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-operator'));
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual([[{ action: 'nap', workloadId: 'demo' }, { async: true }]]);
    expect(audit).toEqual([{ id: 'id-1', at: '2026-10-04T12:00:00.000Z', who: 'ops@example.com', role: 'operator', action: 'nap', target: 'dmt-dev/demo', result: 'requested' }]);
  });

  it('wake forces the wake, records who asked and is audited', async () => {
    const calls: unknown[] = [];
    const { api, audit } = setup(async (router, payload) => { calls.push(payload); return { state: 'WAKING' }; });
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/wake', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ state: 'WAKING' });
    expect(calls).toEqual([{ action: 'force-wake', workloadId: 'demo', by: 'ops@example.com' }]);
    expect(audit[0]).toMatchObject({ action: 'wake', target: 'dmt-dev/demo', result: 'WAKING' });
  });

  it('a failed action is audited with its error', async () => {
    const { api, audit } = setup(async () => { throw new RouterError('throttled'); });
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/wake', 'dmt-operator'))).statusCode).toBe(502);
    expect(audit[0]).toMatchObject({ action: 'wake', result: 'error: throttled' });
  });
});

describe('audit', () => {
  it('lists the audit for admins only', async () => {
    const { api } = setup(async () => ({ state: 'WAKING' }));
    await api(event('POST', '/api/workloads/dmt-dev/demo/wake', 'dmt-operator'));
    expect((await api(event('GET', '/api/audit', 'dmt-operator'))).statusCode).toBe(403);
    const res = await api(event('GET', '/api/audit', 'dmt-admin'));
    expect(json(res).entries).toHaveLength(1);
  });

  it('answers 404 for an unknown route', async () => {
    const { api } = setup(async () => ({}));
    expect((await api(event('GET', '/api/nothing'))).statusCode).toBe(404);
  });
});
