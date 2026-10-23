// Descriptions of routers and workloads in the API (descriptions design §4): who writes, the checks, the audit, what the
// details and the lists carry, and what a member never reads.
import { describe, expect, it } from 'vitest';
import { createFleetStore } from '@dormeto/fleet';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const ACCOUNT = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT }];
const summary = (id: string, tags: Record<string, string> = {}) => ({
  account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: id, name: `Name ${id}`, state: 'AWAKE', targetGroupArn: `arn:tg/${id}`, url: null,
  updatedAt: '2026-10-24T11:00:00.000Z', pauses: [], checkedAt: '2026-10-24T11:58:00.000Z', tags,
});
const ROUTER_SUMMARY = {
  account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev', version: '0.32.0', build: 'b1', checkSchedule: 'rate(5 minutes)', checkedAt: '2026-10-24T11:58:00.000Z', durationMs: 900,
  health: { status: 'ok', problems: [], lastScheduledCheckAt: '2026-10-24T11:58:00.000Z' }, pauses: [], counts: { AWAKE: 2 },
};
const WORKLOADS = [summary('shop', { team: 'a' }), summary('secret', { team: 'b' })];

async function setup() {
  const audit: AuditEntry[] = [];
  const store = createFleetStore({ dynamo: fakeDynamo(), table: 't', now: () => NOW });
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.19.0', managerAccount: ACCOUNT,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    invoke: async (_r, payload) => (payload.action === 'status' ? { workloadId: payload.workloadId, state: 'AWAKE' } : payload.action === 'router' ? { router: { name: 'dmt-dev' } } : null),
    fleet: {
      listRouters: async () => [ROUTER_SUMMARY] as never, listWorkloads: async () => WORKLOADS as never,
      getWorkload: async (account: string, region: string, id: string) => (WORKLOADS.find((w) => w.account === account && w.region === region && w.workloadId === id) ?? null) as never,
      getDescription: (k) => store.getDescription(k), putDescription: (k, d) => store.putDescription(k, d),
      deleteDescription: (k) => store.deleteDescription(k), listDescriptions: (kind) => store.listDescriptions(kind),
    },
  });
  return { api, audit, store };
}
type S = Awaited<ReturnType<typeof setup>>;
const as = (groups: string, extra: Record<string, string> = {}) => (method: string, path: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: 'ops@example.com', sub: 'u-1', 'cognito:groups': `[${groups}]`, ...extra } } } },
});
const admin = as('dmt-admin');
const operator = as('dmt-operator');
const viewer = as('dmt-viewer');
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const W = '/api/workloads/dmt-dev/shop/description';
const R = '/api/routers/dmt-dev/description';
const lastAudit = (s: S) => s.audit.at(-1)!;

describe('a workload description', () => {
  it('an operator sets it: stored with who and when, audited "set (N characters)"', async () => {
    const s = await setup();
    const res = await s.api(operator('PUT', W, { text: '  # Shop team  ' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ description: { text: '# Shop team', by: 'ops@example.com', at: new Date(NOW).toISOString() } });
    expect(await s.store.getDescription({ kind: 'workload', account: ACCOUNT, region: 'eu-west-1', id: 'shop' })).toEqual(json(res).description);
    expect([lastAudit(s).action, lastAudit(s).target, lastAudit(s).result]).toEqual(['description', 'dmt-dev/shop', 'set (11 characters)']);
    expect((await s.api(admin('PUT', W, { text: '0123456789ab' }))).statusCode).toBe(200);
    expect(lastAudit(s).result).toBe('set (12 characters)');
  });

  it('a viewer and a member are refused (403), nothing stored', async () => {
    const s = await setup();
    expect((await s.api(viewer('PUT', W, { text: 'x' }))).statusCode).toBe(403);
    expect((await s.api(as('', { 'custom:x': '1' })('PUT', W, { text: 'x' }))).statusCode).toBe(403);
    expect((await s.api(viewer('DELETE', W))).statusCode).toBe(403);
    expect((await s.store.listDescriptions('workload')).size).toBe(0);
  });

  it('refuses 4,001 characters, a control character and a body without a string text (400)', async () => {
    const s = await setup();
    for (const body of [{ text: 'a'.repeat(4001) }, { text: 'bell\u0007' }, { text: 'lone\rcr' }, { text: 'csi\u009b' }, {}, { text: 12 }]) {
      expect([JSON.stringify(body).slice(0, 30), (await s.api(operator('PUT', W, body))).statusCode]).toEqual([JSON.stringify(body).slice(0, 30), 400]);
    }
    expect((await s.api(operator('PUT', W, { text: 'a'.repeat(4000) }))).statusCode).toBe(200);
  });

  it('stores Windows line endings as line feeds', async () => {
    const s = await setup();
    const res = await s.api(operator('PUT', W, { text: 'one\r\ntwo\r\n' }));
    expect(res.statusCode).toBe(200);
    expect(json(res).description.text).toBe('one\ntwo');
  });

  it('an empty text clears, and DELETE clears (audited "cleared"), also when none exists (200, null, once)', async () => {
    const s = await setup();
    await s.api(operator('PUT', W, { text: 'hello' }));
    let res = await s.api(operator('PUT', W, { text: '  \n ' }));
    expect([res.statusCode, json(res), lastAudit(s).result]).toEqual([200, { description: null }, 'cleared']);
    expect(await s.store.getDescription({ kind: 'workload', account: ACCOUNT, region: 'eu-west-1', id: 'shop' })).toBeNull();
    await s.api(operator('PUT', W, { text: 'hello' }));
    const before = s.audit.length;
    res = await s.api(operator('DELETE', W));
    expect([res.statusCode, json(res), lastAudit(s).action, lastAudit(s).result]).toEqual([200, { description: null }, 'description', 'cleared']);
    res = await s.api(operator('DELETE', W));
    expect([res.statusCode, json(res), s.audit.length - before]).toEqual([200, { description: null }, 2]);
  });

  it('a workload the fleet does not know answers 404 and stores nothing', async () => {
    const s = await setup();
    const res = await s.api(operator('PUT', '/api/workloads/dmt-dev/pending/description', { text: 'x' }));
    expect([res.statusCode, json(res).message]).toEqual([404, 'unknown workload: pending']);
    expect((await s.store.listDescriptions('workload')).size).toBe(0);
  });

  it('the detail carries it (null without), and the list rows a one-line summary', async () => {
    const s = await setup();
    expect(json(await s.api(viewer('GET', '/api/workloads/dmt-dev/shop'))).description).toBeNull();
    await s.api(operator('PUT', W, { text: '## Shop team\nmore\nlines' }));
    const detail = json(await s.api(viewer('GET', '/api/workloads/dmt-dev/shop')));
    expect(detail.description).toMatchObject({ text: '## Shop team\nmore\nlines', by: 'ops@example.com' });
    const rows = json(await s.api(viewer('GET', '/api/workloads'))).workloads;
    expect(rows.map((w: { workloadId: string; summary?: string }) => [w.workloadId, w.summary])).toEqual([['secret', undefined], ['shop', 'Shop team']]);
  });

  it('a member never gets the summary or the detail of a workload their grants do not cover', async () => {
    const s = await setup();
    await s.api(operator('PUT', W, { text: 'Shop' }));
    await s.api(operator('PUT', '/api/workloads/dmt-dev/secret/description', { text: 'Top secret' }));
    const member = as('team-a');
    const api = createApi({
      routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.19.0', managerAccount: ACCOUNT,
      audit: { write: async () => {}, list: async () => [] }, invoke: async () => ({ state: 'AWAKE', tags: { team: 'a' } }),
      fleet: {
        listRouters: async () => [ROUTER_SUMMARY] as never, listWorkloads: async () => WORKLOADS as never, listGroups: async () => [{ name: 'team-a', description: '', grants: [{ tags: { team: 'a' }, permissions: ['read'] }], updatedAt: null, updatedBy: null }],
        getWorkload: async (_a: string, _r: string, id: string) => (WORKLOADS.find((w) => w.workloadId === id) ?? null) as never,
        getDescription: (k) => s.store.getDescription(k), listDescriptions: (kind) => s.store.listDescriptions(kind),
      },
    });
    const list = await api(member('GET', '/api/workloads'));
    expect(list.statusCode).toBe(200);
    expect(json(list).workloads.map((w: { workloadId: string; summary?: string }) => [w.workloadId, w.summary])).toEqual([['shop', 'Shop']]);
    expect(JSON.stringify(json(list))).not.toContain('Top secret');
    const detail = await api(member('GET', '/api/workloads/dmt-dev/secret'));
    expect(detail.statusCode).toBe(404);
    expect(detail.body).not.toContain('Top secret');
  });
});

describe('a router description', () => {
  it('an administrator sets and clears it; an operator is refused', async () => {
    const s = await setup();
    expect((await s.api(operator('PUT', R, { text: 'x' }))).statusCode).toBe(403);
    expect((await s.api(operator('DELETE', R))).statusCode).toBe(403);
    const res = await s.api(admin('PUT', R, { text: 'Dev router' }));
    expect([res.statusCode, json(res).description.text, lastAudit(s).action, lastAudit(s).target, lastAudit(s).result]).toEqual([200, 'Dev router', 'description', 'dmt-dev', 'set (10 characters)']);
    expect((await s.api(admin('PUT', R, { text: 'a'.repeat(4001) }))).statusCode).toBe(400);
    const cleared = await s.api(admin('DELETE', R));
    expect([cleared.statusCode, json(cleared), lastAudit(s).result]).toEqual([200, { description: null }, 'cleared']);
    expect((await s.api(admin('DELETE', R))).statusCode).toBe(200);
  });

  it('an unknown router answers 404', async () => {
    const s = await setup();
    expect((await s.api(admin('PUT', '/api/routers/nope/description', { text: 'x' }))).statusCode).toBe(404);
  });

  it('the detail carries it and the list row a summary', async () => {
    const s = await setup();
    expect(json(await s.api(viewer('GET', '/api/routers/dmt-dev'))).description).toBeNull();
    await s.api(admin('PUT', R, { text: '**Dev router**\nmore' }));
    expect(json(await s.api(viewer('GET', '/api/routers/dmt-dev'))).description.text).toBe('**Dev router**\nmore');
    expect(json(await s.api(viewer('GET', '/api/routers'))).routers[0].summary).toBe('Dev router');
  });
});

describe('a failing description read', () => {
  it('leaves the description key out of the details (null means none) and still answers 200', async () => {
    const api = createApi({
      routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.19.0', managerAccount: ACCOUNT,
      audit: { write: async () => {}, list: async () => [] },
      invoke: async (_r, payload) => (payload.action === 'router' ? { router: { name: 'dmt-dev' } } : { workloadId: 'shop', state: 'AWAKE' }),
      fleet: {
        listRouters: async () => [ROUTER_SUMMARY] as never, listWorkloads: async () => WORKLOADS as never,
        getWorkload: async () => WORKLOADS[0] as never, getDescription: async () => { throw new Error('boom'); },
      },
    });
    for (const path of ['/api/workloads/dmt-dev/shop', '/api/routers/dmt-dev']) {
      const res = await api(viewer('GET', path));
      expect([path, res.statusCode, 'description' in json(res)]).toEqual([path, 200, false]);
    }
  });
});

describe('the /iam/ twins', () => {
  const iam = (method: string, path: string, body?: unknown): ApiEvent => ({
    rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: { http: { method }, authorizer: { iam: { userArn: `arn:aws:iam::${ACCOUNT}:user/cli`, userId: 'AIDAX', accountId: ACCOUNT } } },
  });
  it('set and read a workload and a router description, by the ARN', async () => {
    const s = await setup();
    const res = await s.api(iam('PUT', '/iam/workloads/dmt-dev/shop/description', { text: 'from the CLI' }));
    expect([res.statusCode, json(res).description.by]).toEqual([200, `arn:aws:iam::${ACCOUNT}:user/cli`]);
    expect((await s.api(iam('PUT', '/iam/routers/dmt-dev/description', { text: 'router' }))).statusCode).toBe(200);
    expect(json(await s.api(iam('GET', '/iam/workloads/dmt-dev/shop'))).description.text).toBe('from the CLI');
    expect(json(await s.api(iam('GET', '/iam/routers/dmt-dev'))).description.text).toBe('router');
    expect((await s.api(iam('DELETE', '/iam/workloads/dmt-dev/shop/description'))).statusCode).toBe(200);
  });
});
