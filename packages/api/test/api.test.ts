import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogle, createGoogleSource, type GoogleConnection } from '@dormeto/google';
import type { InstalledRouter } from '@dormeto/operations';
import { createApi, RouterError, routerInvoker, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

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

  // dormeto gcp connect writes it through /iam: a dashboard administrator can't unregister the fleet's Google Cloud routers by
  // mistake.
  it('takes writes from IAM callers only: a Cognito administrator\'s PUT and DELETE under /api are refused; viewers read it under both', async () => {
    const { api, stored, store } = connected();
    const refusal = { error: 'forbidden', message: 'the Google Cloud connection is written by dormeto gcp connect and removed by dormeto gcp disconnect (through /iam): the dashboard only reads it' };
    const put = await api(event('PUT', '/api/discovery/google', 'dmt-admin', record));
    expect([put.statusCode, json(put)]).toEqual([403, refusal]);
    expect(stored()).toBeNull();
    expect((await api(viaIam('PUT', '/iam/discovery/google', record))).statusCode).toBe(200);
    const removed = await api(event('DELETE', '/api/discovery/google', 'dmt-admin'));
    expect([removed.statusCode, json(removed)]).toEqual([403, refusal]);
    expect(stored()).toEqual(record);
    expect(store.has('dormeto-dev#europe-west1')).toBe(true);
    expect(json(await api(event('GET', '/api/discovery/google', 'dmt-viewer')))).toEqual({ connection: record });
    expect(json(await api(viaIam('GET', '/iam/discovery/google')))).toEqual({ connection: record });
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
    await api(viaIam('PUT', '/iam/discovery/google', record));
    store.set('dormeto-dev#europe-west1', { ...store.get('dormeto-dev#europe-west1'), controller: 'https://c.run.app', version: '0.40.0' });
    await api(viaIam('PUT', '/iam/discovery/google', record));
    expect(store.get('dormeto-dev#europe-west1').controller).toBe('https://c.run.app');
    expect(store.get('dormeto-dev#europe-west1').version).toBe('0.40.0');
  });

  it('registers a router with the controller and version the record carries, and updates them on a later PUT', async () => {
    const { api, store } = connected();
    const withUrl = (controller: string, version: string) => ({ ...record, routers: [{ ...record.routers[0], controller, version }] });
    expect((await api(viaIam('PUT', '/iam/discovery/google', withUrl('https://dmtr-europe-west1-controller-abc-ew.a.run.app', '0.40.0')))).statusCode).toBe(200);
    expect(store.get('dormeto-dev#europe-west1')).toMatchObject({ controller: 'https://dmtr-europe-west1-controller-abc-ew.a.run.app', version: '0.40.0' });
    await api(viaIam('PUT', '/iam/discovery/google', withUrl('https://dmtr-europe-west1-controller-abc-ew.a.run.app', '0.41.0')));
    expect(store.get('dormeto-dev#europe-west1').version).toBe('0.41.0');
    await api(viaIam('PUT', '/iam/discovery/google', withUrl('', '')));
    expect(store.get('dormeto-dev#europe-west1')).toMatchObject({ controller: 'https://dmtr-europe-west1-controller-abc-ew.a.run.app', version: '0.41.0' });
  });

  it('refuses a controller that is not an https run.app URL and a version that is not semver', async () => {
    const { api } = connected();
    for (const bad of [{ controller: 'http://x.a.run.app' }, { controller: 'https://example.com' }, { version: 'latest' }, { version: 4 }]) {
      const res = await api(viaIam('PUT', '/iam/discovery/google', { ...record, routers: [{ ...record.routers[0], ...bad }] }));
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a pool, provider, scope, service account or controller host that is not the shape connect writes', async () => {
    const { api, store } = connected();
    const accounts = record.serviceAccounts;
    const named = 'serviceAccounts must be dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com and dmt-dev-command@dormeto-host.iam.gserviceaccount.com';
    const scopes = 'scopes must each be organizations/<number>, folders/<number> or projects/<project ID>';
    const controller = 'routers[].controller must be an https://….run.app URL or empty';
    for (const [bad, message] of [
      [{ pool: 'workload-pool' }, 'pool must be dmt-<env>'], [{ pool: 'dmt-' }, 'pool must be dmt-<env>'], [{ pool: 'dmt-Dev' }, 'pool must be dmt-<env>'],
      [{ provider: 'oidc' }, 'provider must be aws'],
      [{ scopes: ['projects/dormeto-dev', 'billingAccounts/01ABCD'] }, scopes], [{ scopes: ['organizations/acme'] }, scopes], [{ scopes: ['folders/'] }, scopes],
      [{ scopes: ['projects/123456789012'] }, scopes],
      [{ serviceAccounts: { ...accounts, discovery: 'dmt-dev-discovery@another-project.iam.gserviceaccount.com' } }, named],
      [{ serviceAccounts: { ...accounts, command: 'someone@dormeto-host.iam.gserviceaccount.com' } }, named],
      [{ serviceAccounts: { discovery: accounts.command, command: accounts.discovery } }, named],
      [{ pool: 'dmt-prod' }, 'serviceAccounts must be dmt-prod-discovery@dormeto-host.iam.gserviceaccount.com and dmt-prod-command@dormeto-host.iam.gserviceaccount.com'],
      [{ routers: [{ ...record.routers[0], controller: 'https://a..run.app' }] }, controller], [{ routers: [{ ...record.routers[0], controller: 'https://.run.app' }] }, controller],
      [{ routers: [{ ...record.routers[0], controller: 'https://-a.run.app' }] }, controller], [{ routers: [{ ...record.routers[0], controller: 'https://run.app' }] }, controller],
    ] as [Record<string, unknown>, string][]) {
      const res = await api(viaIam('PUT', '/iam/discovery/google', { ...record, ...bad }));
      expect([res.statusCode, json(res).message], JSON.stringify(bad)).toEqual([400, message]);
    }
    expect([...store.keys()]).toEqual(['121014831971#eu-west-1']);
  });

  it('takes the scopes connect writes, and a router version with a prerelease (a dev router) as the router reports it', async () => {
    const { api, store } = connected();
    const dev = { ...record.routers[0], controller: 'https://dmtr-europe-west1-controller-abc-ew.a.run.app', version: '0.40.0-dev.1' };
    const res = await api(viaIam('PUT', '/iam/discovery/google', { ...record, scopes: ['organizations/123456789', 'folders/42', 'projects/dormeto-dev'], routers: [dev] }));
    expect(res.statusCode).toBe(200);
    expect(store.get('dormeto-dev#europe-west1')).toMatchObject({ controller: dev.controller, version: '0.40.0-dev.1' });
  });

  it('unregisters the routers a later PUT drops, and never an AWS one', async () => {
    const { api, store } = connected();
    await api(viaIam('PUT', '/iam/discovery/google', record));
    await api(viaIam('PUT', '/iam/discovery/google', { ...record, routers: [record.routers[0]] }));
    expect([...store.keys()].sort()).toEqual(['121014831971#eu-west-1', 'dormeto-dev#europe-west1']);
  });

  it('refuses a 12-digit project, a bad region and a missing field', async () => {
    const { api, store } = connected();
    for (const bad of [
      { ...record, project: '123456789012' },
      { ...record, routers: [{ project: '123456789012', region: 'europe-west1' }] },
      { ...record, routers: [{ project: 'dormeto-dev', region: 'eu-west-1' }] },
      { ...record, pool: undefined },
    ]) expect((await api(viaIam('PUT', '/iam/discovery/google', bad))).statusCode).toBe(400);
    expect([...store.keys()]).toEqual(['121014831971#eu-west-1']);
  });

  it('answers a GET with no connection as null', async () => {
    const { api } = connected();
    expect(json(await api(event('GET', '/api/discovery/google', 'dmt-admin')))).toEqual({ connection: null });
  });

  it('deletes the record and the Google Cloud routers, keeping the AWS ones', async () => {
    const { api, store, stored, audit } = connected();
    await api(viaIam('PUT', '/iam/discovery/google', record));
    expect((await api(event('DELETE', '/api/discovery/google', 'dmt-operator'))).statusCode).toBe(403);
    expect((await api(viaIam('DELETE', '/iam/discovery/google'))).statusCode).toBe(200);
    expect(stored()).toBeNull();
    expect([...store.keys()]).toEqual(['121014831971#eu-west-1']);
    expect(audit.at(-1)?.action).toBe('google-connection');
  });
});

describe('Google Cloud routers', () => {
  const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
  const OTHER = 'https://dmtr-us-central1-controller-abc123-uc.a.run.app';
  const COMMAND = 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com';
  const NAME = 'dmtr-dormeto-dev-europe-west2';
  const record: GoogleConnection = {
    project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-host'],
    serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: COMMAND },
    routers: [{ project: 'dormeto-dev', region: 'europe-west2' }], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'cli', cli: '0.14.0',
  };
  const gcp = (over: Partial<InstalledRouter> = {}): InstalledRouter => ({
    name: 'dmtr-europe-west2', account: 'dormeto-dev', region: 'europe-west2', controller: CONTROLLER, onboarder: '', version: '0.40.0', build: '',
    installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z', ...over,
  });
  type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const claimsOf = (authorization: string) => JSON.parse(Buffer.from(authorization.replace(/^Bearer /, '').split('.')[1]!, 'base64url').toString());

  // The manager as index.ts builds it: the invoker's Google transport over a fake Google (its STS, iamcredentials and the
  // controllers, which `controller` answers), the AWS routers of Terraform called through Lambda (recorded).
  // `tokens` answers Google's token endpoints first when it returns a Response.
  function manager({ routers = [gcp()], controller = () => answer(200, {}), tokens }: {
    routers?: InstalledRouter[]; controller?: (req: Seen, payload: Record<string, unknown>) => Response; tokens?: (req: Seen) => Response | undefined;
  } = {}) {
    const seen: Seen[] = [];
    let n = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req: Seen = { url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') };
      seen.push(req);
      const own = tokens?.(req);
      if (own) return own;
      if (req.url === 'https://sts.googleapis.com/v1/token') return answer(200, { access_token: `federated-${++n}`, expires_in: 3600 });
      if (req.url.endsWith(':generateIdToken')) return answer(200, { token: jwt({ aud: (JSON.parse(req.body) as { audience: string }).audience, exp: Math.floor(NOW / 1000) + 3600, n: ++n }) });
      return controller(req, JSON.parse(req.body) as Record<string, unknown>);
    };
    const source = createGoogleSource({
      read: async () => record,
      create: (connection) => createGoogle({ connection, credentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret' }, fetch: fetch as typeof globalThis.fetch, now: () => NOW }),
    });
    const aws: unknown[] = [];
    const invoke = routerInvoker(async (router, input) => {
      aws.push([router.name, JSON.parse(Buffer.from(input.Payload).toString())]);
      return { Payload: new Uint8Array(Buffer.from(JSON.stringify({ workloads: [] }))) };
    }, { current: () => source.current(), env: 'dev', routerVersion: '0.40.0' });
    const audit: AuditEntry[] = [];
    const created: unknown[] = [];
    const settings = { doc: null as Record<string, unknown> | null };
    const api = createApi({
      routers: ROUTERS, invoke, audit: { write: async (e) => { audit.push(e); }, list: async () => audit }, now: () => NOW, newId: () => 'id-1', version: '0.1.0',
      routerVersion: '0.40.0', managerAccount: '121014831971',
      operations: {
        installedRouters: async () => routers, list: async () => [], get: async () => null,
        create: async (type, input, by) => { created.push([type, input]); return { id: 'op-1', type, input, by } as never; },
      },
      globalSettings: { read: async () => settings.doc, write: async (doc) => { settings.doc = doc; return '"5d41402abc4b2a76b9719d911017c592"'; } },
    });
    const actions = () => seen.filter((s) => s.url.endsWith('/v1/actions')).map((s) => ({ url: s.url, payload: JSON.parse(s.body) as Record<string, unknown>, authorization: s.headers['authorization']! }));
    return { api, seen, actions, aws, audit, created, settings };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a nap to the controller\'s /v1/actions as request-nap, with a bearer ID token of the command account for the controller', async () => {
    const m = manager({ controller: () => answer(200, { requested: true }) });
    const res = await m.api(event('POST', `/api/workloads/${NAME}/demo/nap`, 'dmt-operator'));
    expect(res.statusCode).toBe(202);
    const [call, ...more] = m.actions();
    expect(more).toEqual([]);
    expect(call!.url).toBe(`${CONTROLLER}/v1/actions`);
    expect(call!.payload).toEqual({ action: 'request-nap', workloadId: 'demo', by: 'ops@example.com', refusals: true });
    expect(claimsOf(call!.authorization)).toMatchObject({ aud: CONTROLLER });
    const asked = m.seen.filter((s) => s.url === `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${COMMAND}:generateIdToken`);
    expect(asked.map((s) => JSON.parse(s.body))).toEqual([{ audience: CONTROLLER, includeEmail: true }]);
    expect(m.aws).toEqual([]);
    expect(m.audit.at(-1)).toMatchObject({ action: 'nap', target: `${NAME}/demo`, result: 'requested' });
  });

  it('reads a refusal the controller answers as the AWS one: its code decides the status', async () => {
    const m = manager({ controller: () => answer(200, { refused: { code: 'not_found', message: 'workload not configured: gone' } }) });
    const res = await m.api(event('POST', `/api/workloads/${NAME}/gone/wake`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([404, { error: 'not_found', message: 'workload not configured: gone' }]);
  });

  it('answers Google\'s 403 with 502 and the refusal manager-access-missing, the connect command in its words', async () => {
    const m = manager({ controller: () => new Response('<html><title>403 Forbidden</title></html>', { status: 403, headers: { 'content-type': 'text/html' } }) });
    const res = await m.api(event('POST', `/api/workloads/${NAME}/demo/nap`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([502, {
      error: 'manager-access-missing', message: 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev',
    }]);
    expect(m.audit.at(-1)?.result).toBe('error: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev');
  });

  it('answers a connection broken at the token (STS invalid_target, iamcredentials 404) as manager-access-missing; STS\'s 503 stays a router error', async () => {
    const access = { error: 'manager-access-missing', message: 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev' };
    const gone = manager({ tokens: (req) => (req.url === 'https://sts.googleapis.com/v1/token' ? answer(400, { error: 'invalid_target', error_description: 'The target service indicated by the "audience" parameters is invalid.' }) : undefined) });
    const res = await gone.api(event('POST', `/api/workloads/${NAME}/demo/wake`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([502, access]);
    const deleted = manager({ tokens: (req) => (req.url.endsWith(':generateIdToken') ? answer(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }) : undefined) });
    const listed = json(await deleted.api(event('GET', '/api/workloads', 'dmt-operator')));
    expect(listed.errors).toEqual([{ router: NAME, message: access.message }]);
    expect(deleted.actions()).toEqual([]);
    const down = manager({ tokens: (req) => (req.url === 'https://sts.googleapis.com/v1/token' ? new Response('<html>Service Unavailable</html>', { status: 503 }) : undefined) });
    const failed = await down.api(event('POST', `/api/workloads/${NAME}/demo/wake`, 'dmt-operator'));
    expect([failed.statusCode, json(failed).error]).toEqual([502, 'router_error']);
  });

  it('answers router-too-old for a 0.39.0 router without calling it, the install command with the pinned version', async () => {
    const m = manager({ routers: [gcp({ version: '0.39.0' })] });
    const res = await m.api(event('POST', `/api/workloads/${NAME}/demo/wake`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([502, {
      error: 'router-too-old', message: 'router 0.39.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0',
    }]);
    expect(m.seen).toEqual([]);
  });

  it('calls a router of unknown version, and answers router-too-old when its controller has no /v1/actions (its JSON 404)', async () => {
    const m = manager({ routers: [gcp({ version: '' })], controller: () => answer(404, { error: 'no route for POST /v1/actions', reason: 'not-found' }) });
    const res = await m.api(event('GET', `/api/workloads/${NAME}/demo`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([502, {
      error: 'router-too-old', message: 'router older than 0.40.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0',
    }]);
    expect(m.actions()).toHaveLength(1);
  });

  it('answers router-unknown for a router whose controller discovery hasn\'t found yet, without a call', async () => {
    const m = manager({ routers: [gcp({ controller: '' })] });
    const res = await m.api(event('POST', `/api/workloads/${NAME}/demo/wake`, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([502, {
      error: 'router-unknown', message: 'discovery hasn\'t found this router\'s controller yet: dormeto gcp connect --project dormeto-host --profile <profile> --env dev again',
    }]);
    expect(m.seen).toEqual([]);
  });

  it('refuses install-router for a project with 400 and the CLI\'s command, and upgrade-router and uninstall-router for a Google Cloud router', async () => {
    const m = manager();
    const install = await m.api(event('POST', '/api/operations', 'dmt-admin', { type: 'install-router', account: 'dormeto-dev', region: 'europe-west2' }));
    expect([install.statusCode, json(install)]).toEqual([400, {
      error: 'bad_request', message: 'a Google Cloud router is installed with the CLI: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0',
    }]);
    const upgrade = await m.api(event('POST', '/api/operations', 'dmt-admin', { type: 'upgrade-router', router: NAME }));
    expect([upgrade.statusCode, json(upgrade)]).toEqual([400, {
      error: 'bad_request', message: 'a Google Cloud router is upgraded with the CLI: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0',
    }]);
    const uninstall = await m.api(event('POST', '/api/operations', 'dmt-admin', { type: 'uninstall-router', router: NAME }));
    expect([uninstall.statusCode, json(uninstall)]).toEqual([400, {
      error: 'bad_request', message: 'a Google Cloud router is uninstalled with the CLI: dormeto gcp uninstall --project dormeto-dev --region europe-west2',
    }]);
    expect(m.created).toEqual([]);
    // An AWS account's install is as before.
    expect((await m.api(event('POST', '/api/operations', 'dmt-admin', { type: 'install-router', account: '038606077307', region: 'eu-west-1' }))).statusCode).toBe(202);
    expect(m.created).toEqual([['install-router', { account: '038606077307', region: 'eu-west-1' }]]);
  });

  it('pushes each settings write to every Google Cloud router with a controller, as manager-settings with the object written and its ETag; the AWS routers untouched', async () => {
    const m = manager({
      routers: [gcp(), gcp({ name: 'dmtr-us-central1', region: 'us-central1', controller: OTHER }), gcp({ name: 'dmtr-asia-east1', region: 'asia-east1', controller: '' })],
      controller: () => answer(200, { etag: 'stored' }),
    });
    const res = await m.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ hibernate: false, note: 'routers apply it at their next check, within 5 minutes' });
    const pushed = m.actions();
    expect(pushed.map((a) => a.url).sort()).toEqual([`${CONTROLLER}/v1/actions`, `${OTHER}/v1/actions`]);
    for (const a of pushed) expect(a.payload).toEqual({ action: 'manager-settings', settings: m.settings.doc, etag: '"5d41402abc4b2a76b9719d911017c592"', refusals: true });
    expect(m.settings.doc).toMatchObject({ workloads: { hibernate: false }, updatedBy: 'ops@example.com' });
    expect(m.aws).toEqual([]);

    expect((await m.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [{ name: 'api', tags: { kind: 'api' }, settings: { idleMinutes: 30 } }] }))).statusCode).toBe(200);
    expect((await m.api(event('PUT', '/api/settings/waiting-page', 'dmt-admin', { page: { mode: 'template', title: 'Back soon' } }))).statusCode).toBe(200);
    expect((await m.api(event('DELETE', '/api/settings/waiting-page', 'dmt-admin'))).statusCode).toBe(200);
    expect(m.actions().map((a) => a.payload.action)).toEqual(Array(8).fill('manager-settings'));
    expect(m.actions().at(-1)!.payload.settings).toEqual(m.settings.doc);
    expect(m.aws).toEqual([]);
  });

  it('answers a settings write as before when a router refuses the push, and logs it for the poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = manager({ controller: () => new Response('<html>Forbidden</html>', { status: 403 }) });
    const res = await m.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
    expect([res.statusCode, json(res).hibernate]).toEqual([200, false]);
    expect(m.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: 'hibernate off' });
    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual([{ level: 'warn', event: 'ManagerSettingsNotPushed', router: NAME, error: 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev' }]);
  });

  it('renames, tags, sets and offboards a workload the CLI onboarded (source cli): nothing refuses it as a Terraform one is', async () => {
    const m = manager({
      controller: (_req, payload) => answer(200, payload.action === 'rename' ? { workloadId: 'demo', name: payload.name }
        : payload.action === 'tag' ? { workloadId: 'demo', tags: payload.tags } : { workloadId: 'demo', settings: payload.settings, source: 'cli' }),
    });
    const rename = await m.api(event('POST', `/api/workloads/${NAME}/demo/rename`, 'dmt-operator', { name: 'Shop' }));
    expect([rename.statusCode, json(rename)]).toEqual([200, { workloadId: 'demo', name: 'Shop' }]);
    const tags = await m.api(event('PUT', `/api/workloads/${NAME}/demo/tags`, 'dmt-admin', { tags: { team: 'shop' } }));
    expect([tags.statusCode, json(tags)]).toEqual([200, { workloadId: 'demo', tags: { team: 'shop' } }]);
    const settings = await m.api(event('PUT', `/api/workloads/${NAME}/demo/settings`, 'dmt-operator', { idleMinutes: 30 }));
    expect(settings.statusCode).toBe(200);
    expect(m.actions().map((a) => a.payload.action)).toEqual(['rename', 'tag', 'settings']);
    const offboard = await m.api(event('POST', '/api/operations', 'dmt-operator', { type: 'offboard', router: NAME, workloadId: 'demo' }));
    expect(offboard.statusCode).toBe(202);
    expect(m.created).toEqual([['offboard', { router: NAME, account: 'dormeto-dev', region: 'europe-west2', workloadId: 'demo' }]]);
  });

  it('gives a Google Cloud router 10 s to answer a list, an AWS one 5 s', async () => {
    vi.useFakeTimers({ now: NOW });
    const slow = (ms: number, value: unknown) => new Promise((resolve) => { setTimeout(() => resolve(value), ms); });
    const api = createApi({
      routers: ROUTERS, invoke: async (router) => slow(7_000, { workloads: [{ workloadId: router.cloud === 'gcp' ? 'g' : 'a', state: 'AWAKE' }] }),
      audit: { write: async () => {}, list: async () => [] }, now: () => NOW, version: '0.1.0',
      operations: { installedRouters: async () => [gcp()], list: async () => [], get: async () => null, create: async () => { throw new Error('none'); } },
    });
    const listed = api(event('GET', '/api/workloads'));
    await vi.advanceTimersByTimeAsync(8_000);
    const body = json(await listed);
    expect(body.workloads.map((w: { router: string; workloadId: string }) => [w.router, w.workloadId])).toEqual([[NAME, 'g']]);
    expect(body.errors).toEqual([{ router: 'dmt-dev', message: 'no answer within 5000 ms' }, { router: 'dmt-test', message: 'no answer within 5000 ms' }]);
  });
});
