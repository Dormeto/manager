// Every listing and item takes the caller's visibility (scale design §4; everything for now, R11 scopes it by tag): a
// caller sees only the accounts and regions visible to them, and anything else answers as unknown.
import { describe, expect, it } from 'vitest';
import type { Exclusion } from '@dormeto/discovery';
import { createApi, type ApiEvent } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const ACCOUNT = '121014831971';
const tg = (region: string, name: string) => `arn:aws:elasticloadbalancing:${region}:${ACCOUNT}:targetgroup/${name}/73e2d6bc24d8a067`;
const exclusion = (id: string, region: string): Exclusion => ({
  id, target: { kind: 'target-group', arn: tg(region, id), account: ACCOUNT, region, name: id }, reason: 'test', by: 'ops@example.com', at: new Date(NOW).toISOString(),
});
const operation = (id: string, region: string) => ({ id, type: 'onboard', target: { account: ACCOUNT, region, targetGroupArn: tg(region, id) }, status: 'running', steps: [], createdAt: new Date(NOW).toISOString() });

function setup() {
  const calls: [string, Record<string, unknown>][] = [];
  const created: string[] = [];
  const store = memoryStore([candidate('ireland', { region: 'eu-west-1', targetGroupArn: tg('eu-west-1', 'ireland') }), candidate('paris', { region: 'eu-west-3', targetGroupArn: tg('eu-west-3', 'paris') })]);
  const api = createApi({
    routers: [
      { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT },
      { name: 'dmt-paris', region: 'eu-west-3', controller: 'dmt-paris-controller', account: ACCOUNT },
    ],
    async invoke(router, payload) {
      calls.push([router.name, payload]);
      return { state: 'AWAKE', workloads: [], router: {}, pauses: [], health: { status: 'ok', problems: [] } };
    },
    audit: { write: async () => {}, list: async () => [] },
    now: () => NOW, newId: () => 'x1', version: '0.2.0',
    discovery: { store, run: async () => {} },
    operations: {
      async create(type: string) { created.push(type); return { id: 'op9', type } as never; },
      list: async () => [operation('op1', 'eu-west-1'), operation('op2', 'eu-west-3')] as never,
      get: async (id: string) => (id === 'op1' ? operation('op1', 'eu-west-1') : id === 'op2' ? operation('op2', 'eu-west-3') : null) as never,
      installedRouters: async () => [],
    } as never,
    // The caller may not see eu-west-3.
    visible: (_identity, item) => item.region !== 'eu-west-3',
  });
  return { api, calls, created, store };
}

function event(method: string, path: string, body?: unknown): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-admin]' } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('visibility', () => {
  it('lists the operations and exclusions of what the caller sees; another one answers 404', async () => {
    const s = setup();
    await s.store.putExclusion(exclusion('ex-ireland', 'eu-west-1'));
    await s.store.putExclusion(exclusion('ex-paris', 'eu-west-3'));
    expect(json(await s.api(event('GET', '/api/operations'))).operations.map((o: { id: string }) => o.id)).toEqual(['op1']);
    expect((await s.api(event('GET', '/api/operations/op1'))).statusCode).toBe(200);
    expect((await s.api(event('GET', '/api/operations/op2'))).statusCode).toBe(404);
    expect(json(await s.api(event('GET', '/api/exclusions'))).exclusions.map((e: { id: string }) => e.id)).toEqual(['ex-ireland']);
    expect((await s.api(event('DELETE', '/api/exclusions/ex-paris'))).statusCode).toBe(404);
    expect(s.created).toEqual([]);
  });

  it('a router or workload the caller may not see answers 404, its actions too, and it is never called', async () => {
    const s = setup();
    for (const [method, path] of [['GET', '/api/routers/dmt-paris'], ['POST', '/api/routers/dmt-paris/pause'], ['GET', '/api/workloads/dmt-paris/shop'], ['POST', '/api/workloads/dmt-paris/shop/nap']] as const) {
      const res = await s.api(event(method, path, method === 'POST' ? { reason: 'test' } : undefined));
      expect([path, res.statusCode]).toEqual([path, 404]);
    }
    expect(s.calls).toEqual([]);
    // Nothing started there either.
    for (const [body, status] of [[{ type: 'offboard', router: 'dmt-paris', workloadId: 'shop' }, 404], [{ type: 'onboard', candidateId: 'paris' }, 400], [{ type: 'install-router', account: ACCOUNT, region: 'eu-west-3' }, 404]] as const) {
      expect([body.type, (await s.api(event('POST', '/api/operations', body))).statusCode]).toEqual([body.type, status]);
    }
    expect((await s.api(event('POST', '/api/discovery/dismiss', { ids: ['paris'] }))).statusCode).toBe(404);
    expect((await s.api(event('POST', '/api/exclusions', { target: { kind: 'target-group', arn: tg('eu-west-3', 'paris') }, reason: 'test' }))).statusCode).toBe(404);
    expect(s.created).toEqual([]);
    // What the caller sees still works.
    expect((await s.api(event('GET', '/api/routers/dmt-dev'))).statusCode).toBe(200);
  });
});
