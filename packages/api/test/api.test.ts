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

function event(method: string, path: string, groups: string | null = 'dmt-viewer', body?: unknown): ApiEvent {
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

  it('derives the role from the highest built-in Cognito group, member by default', async () => {
    const { api } = setup(async () => ({}));
    expect(json(await api(event('GET', '/api/me', 'dmt-viewer dmt-admin')))).toEqual({ email: 'ops@example.com', groups: [], role: 'admin', effectiveRole: 'admin', grants: [{ tags: {}, permissions: ['read', 'wake', 'nap'] }] });
    expect(json(await api(event('GET', '/api/me', 'dmt-operator'))).role).toBe('operator');
    expect(json(await api(event('GET', '/api/me', null))).role).toBe('member');
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
      workloads: [{ router: 'dmt-dev', region: 'eu-west-1', workloadId: 'demo', state: 'AWAKE', can: { wake: false, nap: false } }], total: 1, byState: { AWAKE: 1 }, stats7d: { wakes: 0, ignored: 0, deferred: 0 }, cursor: null,
      errors: [{ router: 'dmt-test', message: 'router unreachable' }],
    });
  });

  it('lists the routers with their version (routers older than 0.16, through list)', async () => {
    const { api } = setup(async (router, payload) => {
      if (payload.action === 'router') throw new RouterError('unknown action: router');
      return {
        router: { name: router.name, version: '0.11.2', build: 'abc', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:58:00.000Z' },
        workloads: [{}, {}],
      };
    });
    expect(json(await api(event('GET', '/api/routers'))).routers[0]).toEqual({
      name: 'dmt-dev', region: 'eu-west-1', cloud: 'aws', source: 'terraform', version: '0.11.2', build: 'abc', workloads: 2,
      checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:58:00.000Z', reporting: false,
    });
  });

  it('reads the live status of a workload', async () => {
    const calls: unknown[] = [];
    const { api } = setup(async (router, payload) => { calls.push([router.name, payload]); return { workloadId: 'demo', state: 'ASLEEP' }; });
    const res = await api(event('GET', '/api/workloads/dmt-dev/demo'));
    expect(json(res)).toEqual({ workloadId: 'demo', state: 'ASLEEP', url: null, region: 'eu-west-1', can: { wake: false, nap: false }, description: null });
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

  it('maps a router\'s refusal by its code: invalid 400, not found 404, conflict 409; unsupported stays 502 (refusals design §1)', async () => {
    for (const [code, status, error] of [['invalid', 400, 'bad_request'], ['not_found', 404, 'not_found'], ['conflict', 409, 'conflict'], ['unsupported', 502, 'router_error']] as const) {
      const { api } = setup(async () => { throw new RouterError('the router refuses', code); });
      const res = await api(event('GET', '/api/workloads/dmt-dev/demo'));
      expect([res.statusCode, json(res)], code).toEqual([status, { error, message: 'the router refuses' }]);
    }
  });
});

describe('actions', () => {
  it('nap and wake need the operator role', async () => {
    const { api, audit } = setup(async () => ({}));
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-viewer'))).statusCode).toBe(403);
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/wake'))).statusCode).toBe(403);
    // The refusals are audited, with their reason.
    expect(audit.map((e) => [e.action, e.result, e.reason])).toEqual([['nap', 'refused', 'operator role required'], ['wake', 'refused', 'operator role required']]);
  });

  it('nap is requested asynchronously from a router older than 0.16, and audited', async () => {
    const calls: unknown[] = [];
    const { api, audit } = setup(async (router, payload, options) => {
      calls.push([payload, options]);
      if (payload.action === 'request-nap') throw new RouterError('unknown action: request-nap');
      return null;
    });
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/nap', 'dmt-operator'));
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual([[{ action: 'request-nap', workloadId: 'demo', by: 'ops@example.com' }, undefined], [{ action: 'nap', workloadId: 'demo' }, { async: true }]]);
    expect(audit).toEqual([{ id: 'id-1', at: '2026-10-04T12:00:00.000Z', who: 'ops@example.com', role: 'operator', action: 'nap', target: 'dmt-dev/demo', result: 'requested', groups: [] }]);
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

  it('rename gives a workload a new name for people, checked, audited; a Terraform workload is a conflict', async () => {
    const calls: Record<string, unknown>[] = [];
    const { api, audit } = setup(async (_router, payload) => {
      calls.push(payload);
      if (payload.workloadId === 'tf') throw new RouterError('workload tf was written by Terraform: set name in its workload module');
      return { workloadId: payload.workloadId, name: payload.name };
    });
    expect((await api(event('POST', '/api/workloads/dmt-dev/demo/rename', 'dmt-viewer', { name: 'Shop' }))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/workloads/dmt-dev/demo/rename', 'dmt-operator', { name: '  Shop front ' }));
    expect([res.statusCode, json(res)]).toEqual([200, { workloadId: 'demo', name: 'Shop front' }]);
    expect(calls).toEqual([{ action: 'rename', workloadId: 'demo', name: 'Shop front', by: 'ops@example.com' }]);
    expect(audit.at(-1)).toMatchObject({ action: 'rename', target: 'dmt-dev/demo', result: 'Shop front' });
    for (const name of ['  ', 'x'.repeat(65), 42]) expect((await api(event('POST', '/api/workloads/dmt-dev/demo/rename', 'dmt-operator', { name }))).statusCode).toBe(400);
    expect((await api(event('POST', '/api/workloads/dmt-dev/tf/rename', 'dmt-operator', { name: 'x' }))).statusCode).toBe(409);
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

describe('the Google Cloud connection', () => {
  const record = {
    project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-dev'],
    serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
    routers: [{ project: 'dormeto-dev', region: 'europe-west1' }, { project: 'dormeto-dev', region: 'us-central1' }],
    googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'cli', cli: '0.14.0',
  };
  const aws = { name: 'dmt-dev', account: '121014831971', region: 'eu-west-1', controller: 'arn:aws:lambda:eu-west-1:121014831971:function:c', onboarder: 'o', version: '0.39.0', build: 'b', installedBy: 'a@example.com', installedAt: '2026-10-01T00:00:00.000Z' };

  const viaIam = (method: string, path: string, body?: unknown): ApiEvent => ({
    rawPath: path, requestContext: { http: { method }, authorizer: { iam: { userArn: 'arn:aws:iam::121014831971:user/cli', userId: 'AIDAX' } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  function connected() {
    const store = new Map<string, any>([[`${aws.account}#${aws.region}`, aws]]);
    let stored: typeof record | null = null;
    const audit: AuditEntry[] = [];
    const api = createApi({
      routers: ROUTERS, invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
      now: () => NOW, newId: () => 'id-1', version: '0.1.0',
      google: {
        get: async () => stored, put: async (r) => { stored = r as typeof record; }, delete: async () => { stored = null; },
        routers: { list: async () => [...store.values()], put: async (r) => { store.set(`${r.account}#${r.region}`, r); }, delete: async (account, region) => { store.delete(`${account}#${region}`); } },
      },
    });
    return { api, audit, store, stored: () => stored };
  }

  it('refuses a viewer\'s PUT', async () => {
    const { api, stored } = connected();
    expect((await api(event('PUT', '/api/discovery/google', 'dmt-viewer', record))).statusCode).toBe(403);
    expect(stored()).toBeNull();
  });

  it('stores an administrator\'s record, registers its routers and audits it', async () => {
    const { api, store, audit } = connected();
    const res = await api(viaIam('PUT', '/iam/discovery/google', record));
    expect(res.statusCode).toBe(200);
    expect(json(await api(event('GET', '/api/discovery/google', 'dmt-viewer')))).toEqual({ connection: record });
    expect(store.get('dormeto-dev#europe-west1')).toEqual({
      name: 'dmtr-europe-west1', account: 'dormeto-dev', region: 'europe-west1', controller: '', onboarder: '', version: '', build: '', installedBy: 'cli',
      cloud: 'gcp', installedAt: record.connectedAt,
    });
    expect(store.has('dormeto-dev#us-central1')).toBe(true);
    expect(audit.map((e) => [e.action, e.target, e.result.startsWith('error')])).toEqual([['google-connection', 'dormeto-host', false]]);
  });

  it('keeps what discovery learnt of a router the record names again', async () => {
    const { api, store } = connected();
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', record));
    store.set('dormeto-dev#europe-west1', { ...store.get('dormeto-dev#europe-west1'), controller: 'https://c.run.app', version: '0.40.0' });
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', record));
    expect(store.get('dormeto-dev#europe-west1').controller).toBe('https://c.run.app');
    expect(store.get('dormeto-dev#europe-west1').version).toBe('0.40.0');
  });

  it('registers a router with the controller and version the record carries, and updates them on a later PUT', async () => {
    const { api, store } = connected();
    const withUrl = (controller: string, version: string) => ({ ...record, routers: [{ ...record.routers[0], controller, version }] });
    expect((await api(event('PUT', '/api/discovery/google', 'dmt-admin', withUrl('https://dmtr-europe-west1-controller-abc-ew.a.run.app', '0.40.0')))).statusCode).toBe(200);
    expect(store.get('dormeto-dev#europe-west1')).toMatchObject({ controller: 'https://dmtr-europe-west1-controller-abc-ew.a.run.app', version: '0.40.0' });
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', withUrl('https://dmtr-europe-west1-controller-abc-ew.a.run.app', '0.41.0')));
    expect(store.get('dormeto-dev#europe-west1').version).toBe('0.41.0');
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', withUrl('', '')));
    expect(store.get('dormeto-dev#europe-west1')).toMatchObject({ controller: 'https://dmtr-europe-west1-controller-abc-ew.a.run.app', version: '0.41.0' });
  });

  it('refuses a controller that is not an https run.app URL and a version that is not semver', async () => {
    const { api } = connected();
    for (const bad of [{ controller: 'http://x.a.run.app' }, { controller: 'https://example.com' }, { version: 'latest' }, { version: 4 }]) {
      const res = await api(event('PUT', '/api/discovery/google', 'dmt-admin', { ...record, routers: [{ ...record.routers[0], ...bad }] }));
      expect(res.statusCode).toBe(400);
    }
  });

  it('unregisters the routers a later PUT drops, and never an AWS one', async () => {
    const { api, store } = connected();
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', record));
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', { ...record, routers: [record.routers[0]] }));
    expect([...store.keys()].sort()).toEqual(['121014831971#eu-west-1', 'dormeto-dev#europe-west1']);
  });

  it('refuses a 12-digit project, a bad region and a missing field', async () => {
    const { api, store } = connected();
    for (const bad of [
      { ...record, project: '123456789012' },
      { ...record, routers: [{ project: '123456789012', region: 'europe-west1' }] },
      { ...record, routers: [{ project: 'dormeto-dev', region: 'eu-west-1' }] },
      { ...record, pool: undefined },
    ]) expect((await api(event('PUT', '/api/discovery/google', 'dmt-admin', bad))).statusCode).toBe(400);
    expect([...store.keys()]).toEqual(['121014831971#eu-west-1']);
  });

  it('answers a GET with no connection as null', async () => {
    const { api } = connected();
    expect(json(await api(event('GET', '/api/discovery/google', 'dmt-admin')))).toEqual({ connection: null });
  });

  it('deletes the record and the Google Cloud routers, keeping the AWS ones', async () => {
    const { api, store, stored, audit } = connected();
    await api(event('PUT', '/api/discovery/google', 'dmt-admin', record));
    expect((await api(event('DELETE', '/api/discovery/google', 'dmt-operator'))).statusCode).toBe(403);
    expect((await api(viaIam('DELETE', '/iam/discovery/google'))).statusCode).toBe(200);
    expect(stored()).toBeNull();
    expect([...store.keys()]).toEqual(['121014831971#eu-west-1']);
    expect(audit.at(-1)?.action).toBe('google-connection');
  });
});
