// Workload schedules in the API (time-based behavior design §5): the routes that set and clear one through the router,
// who may, their audit, and the router before 0.31.0.
import { describe, expect, it } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0);
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const GROUPS = [
  { name: 'pausers', description: '', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }], updatedAt: null, updatedBy: null },
  { name: 'payers', description: '', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake'] }], updatedAt: null, updatedBy: null },
];
const SCHEDULE = { timeZone: 'Europe/Paris', windows: [{ kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00' }], exceptions: [], maxNapDays: 7 };
const ANSWER = { schedule: SCHEDULE, next: [{ at: '2026-10-24T22:00:00.000Z', kind: 'nap-start', window: 0 }], maintenanceDue: null };

function setup(invoke?: Invoke) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.16.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (invoke) return invoke(router, payload, options);
      if (payload.action === 'schedule') return ANSWER;
      if (payload.action === 'clear-schedule') return { cleared: true };
      if (payload.action === 'status') return { workloadId: payload.workloadId, state: 'AWAKE', tags: { team: 'payments' }, ...ANSWER };
      return null;
    },
    fleet: { listRouters: async () => [], listGroups: async () => GROUPS, getWorkload: async () => null } as never,
  });
  return { api, audit, calls };
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
const PUT = '/api/workloads/dmt-dev/pay/schedule';

describe('PUT /api/workloads/:router/:id/schedule', () => {
  it('sets the schedule through the router and answers its schedule, next events and maintenance, audited', async () => {
    const s = setup();
    const res = await s.api(event('PUT', PUT, 'dmt-operator', SCHEDULE));
    expect([res.statusCode, json(res)]).toEqual([200, ANSWER]);
    expect(s.calls).toEqual([{ action: 'schedule', workloadId: 'pay', schedule: SCHEDULE, by: 'dmt-operator@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', target: 'dmt-dev/pay', who: 'dmt-operator@example.com' });
  });

  it('answers 400 with the router\'s problems joined by "; ", audited with them', async () => {
    const s = setup(async () => ({ problems: ['windows[0].end: must be after start', 'maxNapDays: 1 to 60'] }));
    const res = await s.api(event('PUT', PUT, 'dmt-admin', SCHEDULE));
    expect([res.statusCode, json(res)]).toEqual([400, { error: 'bad_request', message: 'windows[0].end: must be after start; maxNapDays: 1 to 60' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', target: 'dmt-dev/pay', result: expect.stringContaining('error:') });
  });

  it('audits a schedule without windows as its maximum nap, not as "0 windows"', async () => {
    const s = setup();
    const res = await s.api(event('PUT', PUT, 'dmt-operator', { maxNapDays: 7 }));
    expect(res.statusCode).toBe(200);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', result: 'maximum nap 7 days' });
  });

  it('answers 409 asking to upgrade the router to 0.31.0 when it does not know the action', async () => {
    const s = setup(async () => { throw new RouterError('unknown action: schedule'); });
    const res = await s.api(event('PUT', PUT, 'dmt-admin', SCHEDULE));
    expect([res.statusCode, json(res).message]).toEqual([409, 'router dmt-dev too old for schedules, upgrade the router to 0.31.0 or later']);
  });

  it('answers 404 for a workload the router does not configure', async () => {
    const s = setup(async () => { throw new RouterError('workload not configured: pay'); });
    expect((await s.api(event('PUT', PUT, 'dmt-admin', SCHEDULE))).statusCode).toBe(404);
  });

  it('refuses a viewer with 403, audited, without calling the router', async () => {
    const s = setup();
    const res = await s.api(event('PUT', PUT, 'dmt-viewer', SCHEDULE));
    expect(res.statusCode).toBe(403);
    // Like a wake or a nap, the refusal reads the workload's tags first (status); nothing is written.
    expect(s.calls.map((c) => c.action)).not.toContain('schedule');
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', target: 'dmt-dev/pay', result: 'refused' });
  });

  it('lets a member granted wake and nap on the workload\'s tags, and refuses one granted wake only', async () => {
    const s = setup();
    expect((await s.api(event('PUT', PUT, 'pausers', SCHEDULE))).statusCode).toBe(200);
    const refused = await s.api(event('PUT', PUT, 'payers', SCHEDULE));
    expect(refused.statusCode).toBe(403);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', result: 'refused' });
    expect(s.calls.filter((c) => c.action === 'schedule')).toHaveLength(1);
  });

  it('works under /iam/ as an administrator', async () => {
    const s = setup();
    const res = await s.api(iam('PUT', '/iam/workloads/dmt-dev/pay/schedule', SCHEDULE));
    expect([res.statusCode, json(res)]).toEqual([200, ANSWER]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule', target: 'dmt-dev/pay' });
  });
});

describe('DELETE /api/workloads/:router/:id/schedule', () => {
  it('clears it through the router and answers whether one existed, audited', async () => {
    const s = setup();
    const res = await s.api(event('DELETE', PUT, 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([200, { cleared: true }]);
    expect(s.calls).toEqual([{ action: 'clear-schedule', workloadId: 'pay', by: 'dmt-operator@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'schedule-clear', target: 'dmt-dev/pay', result: 'cleared' });
  });

  it('refuses a viewer and a member without nap; lets a member with both; 409 on an old router; /iam/ alike', async () => {
    const s = setup();
    expect((await s.api(event('DELETE', PUT, 'dmt-viewer'))).statusCode).toBe(403);
    expect((await s.api(event('DELETE', PUT, 'payers'))).statusCode).toBe(403);
    expect((await s.api(event('DELETE', PUT, 'pausers'))).statusCode).toBe(200);
    expect(s.audit.map((e) => [e.action, e.result])).toEqual([['schedule-clear', 'refused'], ['schedule-clear', 'refused'], ['schedule-clear', 'cleared']]);
    expect(json(await s.api(iam('DELETE', '/iam/workloads/dmt-dev/pay/schedule')))).toEqual({ cleared: true });
    const old = setup(async () => { throw new RouterError('unknown action: clear-schedule'); });
    expect((await old.api(event('DELETE', PUT, 'dmt-admin'))).statusCode).toBe(409);
  });
});

describe('GET /api/workloads/:router/:id', () => {
  it('relays the schedule, the next events and the maintenance due of the router\'s status', async () => {
    const s = setup();
    const res = json(await s.api(event('GET', '/api/workloads/dmt-dev/pay', 'dmt-viewer')));
    expect([res.schedule, res.next, res.maintenanceDue]).toEqual([SCHEDULE, ANSWER.next, null]);
  });
});
