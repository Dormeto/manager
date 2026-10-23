// The hibernation setting at its three levels (EC2 hibernation design §3 and §5): the manager's global settings.json,
// the router's and the workload's settings through the router, who may, their audit, and the router before 0.32.0.
import { describe, expect, it } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const TF = 'workload tf was written by Terraform: set hibernate in its workload module';

function setup(opts: { invoke?: Invoke; doc?: Record<string, unknown> | null; noStore?: boolean } = {}) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const store = { doc: opts.doc ?? null, writes: [] as Record<string, unknown>[] };
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.19.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (opts.invoke) return opts.invoke(router, payload, options);
      if (payload.action === 'settings') return { level: payload.workloadId ? 'workload' : 'router', settings: payload.settings };
      if (payload.action === 'router') return { router: { version: '0.32.0', settings: { hibernate: false, by: 'a', at: 1 }, managerSettings: { hibernate: true, readAt: 2, error: null } }, pauses: [], workloads: { total: 0, byState: {}, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } };
      if (payload.action === 'status') return { workloadId: payload.workloadId, state: 'AWAKE', hibernation: { hibernate: true, from: 'router' } };
      return null;
    },
    ...(opts.noStore ? {} : { globalSettings: { read: async () => store.doc, write: async (d: Record<string, unknown>) => { store.writes.push(d); store.doc = d; } } }),
  });
  return { api, audit, calls, store };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: `${groups || 'none'}@example.com`, sub: 'u-1', 'cognito:groups': `[${groups}]` } } } },
});
const iam = (method: string, path: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { iam: { userArn: `arn:aws:iam::${MANAGER}:user/cli`, userId: 'AIDAX', accountId: MANAGER } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const NOTE = 'routers apply it at their next check, within 5 minutes';

describe('GET /api/settings/workloads', () => {
  it('answers true and nulls while settings.json does not exist, to every signed-in role', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'dmt-admin', 'payments']) {
      const res = await s.api(event('GET', '/api/settings/workloads', groups));
      expect([res.statusCode, json(res)], groups).toEqual([200, { hibernate: true, updatedAt: null, updatedBy: null }]);
    }
  });

  it('answers what the object holds, and true when it holds no hibernate', async () => {
    const doc = { workloads: { hibernate: false }, updatedAt: '2026-10-20T10:00:00.000Z', updatedBy: 'a@example.com', other: 1 };
    expect(json(await setup({ doc }).api(event('GET', '/api/settings/workloads', 'dmt-viewer')))).toEqual({ hibernate: false, updatedAt: doc.updatedAt, updatedBy: 'a@example.com' });
    expect(json(await setup({ doc: { other: 1 } }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).hibernate).toBe(true);
  });

  it('answers the defaults in a manager without a lists bucket', async () => {
    const res = await setup({ noStore: true }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'));
    expect([res.statusCode, json(res)]).toEqual([200, { hibernate: true, updatedAt: null, updatedBy: null }]);
  });

  it('is reached through /iam/ too', async () => {
    expect((await setup().api(iam('GET', '/iam/settings/workloads'))).statusCode).toBe(200);
  });
});

describe('PUT /api/settings/workloads', () => {
  it('writes the whole document keeping the keys it does not know, audited, and says when routers apply it', async () => {
    const s = setup({ doc: { other: 1 } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
    const at = new Date(NOW).toISOString();
    expect([res.statusCode, json(res)]).toEqual([200, { hibernate: false, updatedAt: at, updatedBy: 'dmt-admin@example.com', note: NOTE }]);
    expect(s.store.writes).toEqual([{ workloads: { hibernate: false }, updatedAt: at, updatedBy: 'dmt-admin@example.com', other: 1 }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: 'hibernate off', who: 'dmt-admin@example.com' });
  });

  it('keeps the other keys of workloads, and starts a document when there is none', async () => {
    const s = setup({ doc: { workloads: { hibernate: true, later: 2 } } });
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect(s.store.writes[0]).toMatchObject({ workloads: { hibernate: true, later: 2 } });
    const t = setup();
    await t.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect(t.store.writes[0]).toEqual({ workloads: { hibernate: true }, updatedAt: new Date(NOW).toISOString(), updatedBy: 'dmt-admin@example.com' });
    expect(t.audit.at(-1)!.result).toBe('hibernate on');
  });

  it('refuses everyone but administrators, with an audited refusal and nothing written', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments', '']) expect((await s.api(event('PUT', '/api/settings/workloads', groups, { hibernate: false }))).statusCode, groups).toBe(403);
    expect(s.store.writes).toEqual([]);
    // A viewer and an operator are refused and audited; a member never reaches the route.
    expect(s.audit.map((e) => [e.action, e.target, e.result, e.reason])).toEqual([
      ['settings', 'workloads', 'refused', 'admin role required'], ['settings', 'workloads', 'refused', 'admin role required'],
    ]);
  });

  it('refuses a body that is not {hibernate: boolean} with 400', async () => {
    const s = setup();
    for (const body of [{ hibernate: 'no' }, { hibernate: null }, {}, { hibernate: 1 }]) {
      const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', body));
      expect([res.statusCode, json(res).error], JSON.stringify(body)).toEqual([400, 'bad_request']);
    }
    expect(s.store.writes).toEqual([]);
  });

  it('answers 404 in a manager without a lists bucket', async () => {
    const res = await setup({ noStore: true }).api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect([res.statusCode, json(res)]).toEqual([404, { error: 'not_found', message: 'no settings in this manager' }]);
  });

  it('is reached through /iam/, by the ARN', async () => {
    const s = setup();
    const res = await s.api(iam('PUT', '/iam/settings/workloads', { hibernate: false }));
    expect(res.statusCode).toBe(200);
    expect(json(res).updatedBy).toBe(`arn:aws:iam::${MANAGER}:user/cli`);
  });
});

describe('PUT /api/routers/:router/settings', () => {
  it('sets the router level through the controller, administrators only, audited', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments']) expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', groups, { hibernate: null }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const res = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: null }));
    expect([res.statusCode, json(res)]).toEqual([200, { level: 'router', settings: { hibernate: null } }]);
    expect(s.calls).toEqual([{ action: 'settings', settings: { hibernate: null }, by: 'dmt-admin@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'router-settings', target: 'dmt-dev', result: 'hibernate inherit' });
    await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: false }));
    expect(s.audit.at(-1)!.result).toBe('hibernate off');
  });

  it('refuses a bad body with 400 before calling, relays the router\'s problems as 400, and says an old router is too old', async () => {
    const s = setup({ invoke: async (_r, payload) => { if ((payload.settings as { hibernate: unknown }).hibernate === true) throw new RouterError('unknown action: settings'); return { problems: ['settings: hibernate must be true, false or null'] }; } });
    expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: 'x' }))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
    const problems = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: false }));
    expect([problems.statusCode, json(problems).message]).toEqual([400, 'settings: hibernate must be true, false or null']);
    const old = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: true }));
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.32.0']);
  });

  it('is reached through /iam/', async () => {
    expect((await setup().api(iam('PUT', '/iam/routers/dmt-dev/settings', { hibernate: true }))).statusCode).toBe(200);
  });

  it('relays the router\'s settings and managerSettings in its details', async () => {
    const res = json(await setup().api(event('GET', '/api/routers/dmt-dev', 'dmt-admin')));
    expect(res.router.settings).toEqual({ hibernate: false, by: 'a', at: 1 });
    expect(res.router.managerSettings).toEqual({ hibernate: true, readAt: 2, error: null });
  });
});

describe('PUT /api/workloads/:router/:id/settings', () => {
  const PUT = '/api/workloads/dmt-dev/pay/settings';
  it('sets the workload level through the controller, operators and administrators, audited', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'payments', '']) expect((await s.api(event('PUT', PUT, groups, { hibernate: true }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const res = await s.api(event('PUT', PUT, 'dmt-operator', { hibernate: false }));
    expect([res.statusCode, json(res)]).toEqual([200, { level: 'workload', settings: { hibernate: false } }]);
    expect(s.calls).toEqual([{ action: 'settings', workloadId: 'pay', settings: { hibernate: false }, by: 'dmt-operator@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'workload-settings', target: 'dmt-dev/pay', result: 'hibernate off' });
    expect((await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: null }))).statusCode).toBe(200);
    expect(s.audit.at(-1)!.result).toBe('hibernate inherit');
  });

  it('answers 409 with the router\'s words for a Terraform workload, 404 for an unknown one, 400 for problems, and says an old router is too old', async () => {
    const s = setup({ invoke: async (_r, payload) => {
      if (payload.workloadId === 'tf') throw new RouterError(TF);
      if (payload.workloadId === 'gone') throw new RouterError('workload not configured: gone');
      if (payload.workloadId === 'bad') return { problems: ['settings: unknown setting x'] };
      throw new RouterError('unknown action: settings');
    } });
    const put = (id: string) => s.api(event('PUT', `/api/workloads/dmt-dev/${id}/settings`, 'dmt-admin', { hibernate: true }));
    const tf = await put('tf');
    expect([tf.statusCode, json(tf)]).toEqual([409, { error: 'conflict', message: TF }]);
    expect((await put('gone')).statusCode).toBe(404);
    const bad = await put('bad');
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'settings: unknown setting x']);
    const old = await put('old');
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.32.0']);
    expect(s.audit.map((e) => e.result)).toEqual([`error: ${TF}`, 'error: workload not configured: gone', 'error: settings: unknown setting x', 'error: upgrade the router to 0.32.0']);
  });

  it('refuses a bad body with 400 before calling, and /iam/ is the same route', async () => {
    const s = setup();
    expect((await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: 'yes' }))).statusCode).toBe(400);
    expect((await s.api(event('PUT', PUT, 'dmt-admin', {}))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
    expect((await s.api(iam('PUT', '/iam/workloads/dmt-dev/pay/settings', { hibernate: true }))).statusCode).toBe(200);
  });

  it('relays hibernation in the workload\'s view', async () => {
    const res = json(await setup().api(event('GET', '/api/workloads/dmt-dev/pay', 'dmt-admin')));
    expect(res.hibernation).toEqual({ hibernate: true, from: 'router' });
  });
});
