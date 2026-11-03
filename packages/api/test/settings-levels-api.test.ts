// Settings at scale (vision design §8): the organization's defaults and types in settings.json, a router's and a workload's
// through the router, what a level reaches, who may, the audit, and a router before 0.37.0.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const API_TYPE = { name: 'api', tags: { kind: 'api' }, settings: { idleMinutes: 30 } };
const SUMMARIES = [
  { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', type: 'api', settingsFrom: { idleMinutes: 'router', waitSeconds: 'workload' } },
  { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'b', type: 'ecs', settingsFrom: { idleMinutes: 'workload', waitSeconds: 'default' } },
  { account: MANAGER, region: 'eu-west-1', router: 'other', workloadId: 'c', type: 'api', settingsFrom: { idleMinutes: 'default' } },
];

function setup(opts: { invoke?: Invoke; doc?: Record<string, unknown> | null } = {}) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const store = { doc: opts.doc ?? null, writes: [] as Record<string, unknown>[] };
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.22.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (opts.invoke) return opts.invoke(router, payload, options);
      if (payload.action === 'settings') return { level: payload.workloadId ? 'workload' : 'router', settings: payload.settings };
      return null;
    },
    globalSettings: { read: async () => store.doc, write: async (d: Record<string, unknown>) => { store.writes.push(d); store.doc = d; } },
    fleet: { listRouters: async () => [], listWorkloads: async () => SUMMARIES as never, getWorkload: async () => null },
  });
  return { api, audit, calls, store };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => {
  const [rawPath, query] = path.split('?');
  return {
    rawPath: rawPath!, ...(query ? { queryStringParameters: Object.fromEntries(new URLSearchParams(query)) } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: { http: { method }, authorizer: { jwt: { claims: { email: `${groups || 'none'}@example.com`, sub: 'u-1', 'cognito:groups': `[${groups}]` } } } },
  };
};
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('the organization\'s defaults in /api/settings/workloads', () => {
  it('reads the valid keys of what the file holds, none when it holds none', async () => {
    const s = setup({ doc: { workloads: { hibernate: false, defaults: { idleMinutes: 30, waitSeconds: 'x' } } } });
    expect(json(await s.api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).defaults).toEqual({ idleMinutes: 30 });
    expect(json(await setup().api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).defaults).toEqual({});
  });

  it('merges what is sent with what the file holds, null removing a key or them all, the rest of the file kept; audited before and after', async () => {
    const s = setup({ doc: { workloads: { hibernate: false, joinMinutes: 30, defaults: { idleMinutes: 30, wakeMode: 'browser' } }, waitingPage: { mode: 'template' } } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleMinutes: null, waitSeconds: 20 } }));
    expect([res.statusCode, json(res).defaults]).toEqual([200, { wakeMode: 'browser', waitSeconds: 20 }]);
    expect(s.store.doc).toMatchObject({ workloads: { hibernate: false, joinMinutes: 30, defaults: { wakeMode: 'browser', waitSeconds: 20 } }, waitingPage: { mode: 'template' } });
    expect(s.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: 'defaults idleMinutes 30 → default, waitSeconds default → 20' });
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: null }));
    expect((s.store.doc!.workloads as Record<string, unknown>).defaults).toBeUndefined();
    expect((s.store.doc!.workloads as Record<string, unknown>).hibernate).toBe(false);
  });

  it('refuses defaults the router would refuse, nothing written, and anyone but an administrator', async () => {
    const s = setup();
    const bad = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleMinutes: 4, wakeMode: 'never' } }));
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'idleMinutes must be a whole number from 5 to 1440; wakeMode must be any or browser']);
    expect((await s.api(event('PUT', '/api/settings/workloads', 'dmt-operator', { defaults: { idleMinutes: 30 } }))).statusCode).toBe(403);
    expect(s.store.writes).toEqual([]);
  });
});

describe('/api/settings/types', () => {
  it('reads the built-in names and the valid types, to every role', async () => {
    const s = setup({ doc: { workloads: { types: [API_TYPE, { name: 'Bad' }] } } });
    const res = json(await s.api(event('GET', '/api/settings/types', '')));
    expect([res.types, res.builtIn]).toEqual([[API_TYPE], ['instance', 'asg', 'ecs', 'k8s', 'databases']]);
  });

  it('replaces them, audited; an empty list removes the key; refused types answer 400, nothing written; administrators only', async () => {
    const s = setup({ doc: { workloads: { hibernate: false } } });
    const res = await s.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [API_TYPE] }));
    expect([res.statusCode, json(res).types]).toEqual([200, [API_TYPE]]);
    expect(s.store.doc).toMatchObject({ workloads: { hibernate: false, types: [API_TYPE] }, updatedBy: 'dmt-admin@example.com' });
    expect(s.audit.at(-1)).toMatchObject({ action: 'types', target: 'organization', result: 'api' });
    await s.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [] }));
    expect((s.store.doc!.workloads as Record<string, unknown>).types).toBeUndefined();
    const bad = await s.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [{ name: 'ecs', tags: { kind: 'x' } }] }));
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'type ecs: a built-in type has no tags']);
    expect((await s.api(event('PUT', '/api/settings/types', 'dmt-operator', { types: [] }))).statusCode).toBe(403);
    expect(s.store.writes).toHaveLength(2);
  });
});

describe('/api/settings/reach', () => {
  it('counts, per setting, the workloads of the scope whose value comes from the level or below', async () => {
    const s = setup();
    expect(json(await s.api(event('GET', '/api/settings/reach?level=organization', 'dmt-admin')))).toEqual({
      workloads: 3, keys: { idleMinutes: 1, waitSeconds: 1, drainSeconds: 0, wakeTimeoutSeconds: 0, maxHolders: 0, failedRetrySeconds: 0, wakeMode: 0 },
    });
    expect(json(await s.api(event('GET', '/api/settings/reach?level=router&name=dmt-dev', 'dmt-admin'))).keys).toMatchObject({ idleMinutes: 1, waitSeconds: 1 });
    expect(json(await s.api(event('GET', '/api/settings/reach?level=type&name=api', 'dmt-admin')))).toMatchObject({ workloads: 2, keys: { idleMinutes: 2, waitSeconds: 0 } });
    expect((await s.api(event('GET', '/api/settings/reach?level=workload', 'dmt-admin'))).statusCode).toBe(400);
    expect((await s.api(event('GET', '/api/settings/reach?level=router', 'dmt-admin'))).statusCode).toBe(400);
    expect((await s.api(event('GET', '/api/settings/reach?level=organization', 'dmt-operator'))).statusCode).toBe(403);
  });
});

describe('a router\'s and a workload\'s defaults through the router', () => {
  const OLD: Invoke = async (_r, payload) => (payload.action === 'settings' ? { problems: [`settings: unknown setting ${Object.keys(payload.settings as object)[0]}`] } : null);

  it('a router takes its defaults, checked first; a router before 0.37.0 says to upgrade it', async () => {
    const s = setup();
    const res = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { defaults: { idleMinutes: 30 } }));
    expect(res.statusCode).toBe(200);
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { defaults: { idleMinutes: 30 } }, by: 'dmt-admin@example.com', refusals: undefined });
    expect(s.audit.at(-1)).toMatchObject({ action: 'router-settings', target: 'dmt-dev', result: 'defaults idleMinutes 30' });
    expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { defaults: { idleMinutes: 2 } }))).statusCode).toBe(400);
    const old = await setup({ invoke: OLD }).api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { defaults: { idleMinutes: 30 } }));
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.37.0']);
  });

  it('a workload takes its settings and type, operators may; joinMinutes and unknown keys refused; a router before 0.37.0 says to upgrade it', async () => {
    const s = setup();
    const res = await s.api(event('PUT', '/api/workloads/dmt-dev/shop/settings', 'dmt-operator', { idleMinutes: 45, type: 'api', noWakeRules: null }));
    expect(res.statusCode).toBe(200);
    expect(s.calls.at(-1)).toMatchObject({ action: 'settings', workloadId: 'shop', settings: { idleMinutes: 45, type: 'api', noWakeRules: null } });
    expect(s.audit.at(-1)).toMatchObject({ action: 'workload-settings', target: 'dmt-dev/shop', result: 'idleMinutes 45, type api, noWakeRules inherit' });
    expect((await s.api(event('PUT', '/api/workloads/dmt-dev/shop/settings', 'dmt-viewer', { idleMinutes: 45 }))).statusCode).toBe(403);
    for (const body of [{ joinMinutes: 30 }, { idleMinutes: 2 }, { defaults: {} }, {}]) {
      expect((await s.api(event('PUT', '/api/workloads/dmt-dev/shop/settings', 'dmt-operator', body))).statusCode, JSON.stringify(body)).toBe(400);
    }
    // Hibernate alone, as before.
    expect((await s.api(event('PUT', '/api/workloads/dmt-dev/shop/settings', 'dmt-operator', { hibernate: false }))).statusCode).toBe(200);
    const old = await setup({ invoke: OLD }).api(event('PUT', '/api/workloads/dmt-dev/shop/settings', 'dmt-operator', { idleMinutes: 45 }));
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.37.0']);
  });
});
