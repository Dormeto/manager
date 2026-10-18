// Workload tags in the API (tags design §3): the list's tag filter, the administrators' route that sets them through the
// router, and the tags of an onboarding.
import { describe, expect, it } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller' }];
const LISTED = [
  { workloadId: 'pay', state: 'AWAKE', tags: { team: 'payments', env: 'prod' } },
  { workloadId: 'pay-stg', state: 'ASLEEP', tags: { team: 'payments', env: 'staging' } },
  { workloadId: 'search', state: 'AWAKE', tags: { team: 'search', env: 'prod' } },
  { workloadId: 'plain', state: 'AWAKE' },
];

function setup(invoke?: Invoke, operations?: unknown) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.14.0',
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (invoke) return invoke(router, payload, options);
      if (payload.action === 'list') return { router: { name: 'dmt-dev' }, workloads: LISTED };
      if (payload.action === 'tag') return { workloadId: payload.workloadId, tags: payload.tags };
      return null;
    },
    ...(operations ? { operations: operations as never } : {}),
  });
  return { api, audit, calls };
}
const event = (method: string, path: string, groups: string, body?: unknown, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: 'ops@example.com', sub: 'u-1', 'cognito:groups': `[${groups}]` } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const ids = async (s: ReturnType<typeof setup>, query: Record<string, string>) => {
  const res = await s.api(event('GET', '/api/workloads', 'dmt-viewer', undefined, query));
  return [res.statusCode, json(res).workloads?.map((w: { workloadId: string }) => w.workloadId), json(res).total];
};

describe('the tag filter of the workloads list', () => {
  it('lists the tags of each workload, none for one whose source carries none (a router before 0.30.0), with `can` still answered', async () => {
    const s = setup();
    const rows = json(await s.api(event('GET', '/api/workloads', 'dmt-viewer'))).workloads;
    expect(rows.map((w: { tags?: unknown }) => w.tags)).toEqual([{ team: 'payments', env: 'prod' }, { team: 'payments', env: 'staging' }, { team: 'search', env: 'prod' }, undefined]);
    expect(rows[3]).not.toHaveProperty('tags');
    expect(rows[3].can).toEqual({ wake: false, nap: false });
  });

  it('omits the tags of a workload read live from a router that reports none', async () => {
    const s = setup(async (_r, payload) => (payload.action === 'status' ? { workloadId: 'plain', state: 'AWAKE' } : null));
    const res = json(await s.api(event('GET', '/api/workloads/dmt-dev/plain', 'dmt-operator')));
    expect(res).not.toHaveProperty('tags');
    expect(res.can).toBeDefined();
    const s2 = setup(async (_r, payload) => (payload.action === 'status' ? { workloadId: 'pay', state: 'AWAKE', tags: { team: 'payments' } } : null));
    expect(json(await s2.api(event('GET', '/api/workloads/dmt-dev/pay', 'dmt-operator'))).tags).toEqual({ team: 'payments' });
  });

  it('keeps the workloads with the tag; several tags must all match, repeated or joined by commas as the gateway sends them', async () => {
    const s = setup();
    expect(await ids(s, { tag: 'team=payments' })).toEqual([200, ['pay', 'pay-stg'], 2]);
    expect(await ids(s, { tag: 'team=payments,env=prod' })).toEqual([200, ['pay'], 1]);
    expect(await ids(s, { tag: 'env=prod,team=search' })).toEqual([200, ['search'], 1]);
    expect(await ids(s, { tag: 'team=billing' })).toEqual([200, [], 0]);
    expect(await ids(s, { tag: 'team=payments,team=search' })).toEqual([200, [], 0]);
  });

  it('matches a value exactly and a key as written; a workload without tags never matches', async () => {
    const s = setup();
    expect(await ids(s, { tag: 'team=pay' })).toEqual([200, [], 0]);
    expect(await ids(s, { tag: 'Team=payments' })).toEqual([200, [], 0]);
    expect(await ids(s, { tag: 'env=' })).toEqual([200, [], 0]);
  });

  it('refuses a filter that is not key=value', async () => {
    const s = setup();
    for (const tag of ['team', '=payments', 'team=payments,']) expect((await ids(s, { tag }))[0], tag).toBe(400);
  });
});

describe('PUT /api/workloads/:router/:id/tags', () => {
  it('sets the tags through the router, for administrators only, audited', async () => {
    const s = setup();
    const tags = { team: 'payments', env: 'prod' };
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments', '']) expect((await s.api(event('PUT', '/api/workloads/dmt-dev/pay/tags', groups, { tags }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const res = await s.api(event('PUT', '/api/workloads/dmt-dev/pay/tags', 'dmt-admin', { tags }));
    expect([res.statusCode, json(res)]).toEqual([200, { workloadId: 'pay', tags }]);
    expect(s.calls).toEqual([{ action: 'tag', workloadId: 'pay', tags, by: 'ops@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'tag', target: 'dmt-dev/pay', result: 'team=payments, env=prod', who: 'ops@example.com' });
  });

  it('clears the tags with an empty object', async () => {
    const s = setup();
    const res = await s.api(event('PUT', '/api/workloads/dmt-dev/pay/tags', 'dmt-admin', { tags: {} }));
    expect([res.statusCode, json(res)]).toEqual([200, { workloadId: 'pay', tags: {} }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'tag', result: 'no tags' });
  });

  it('refuses bad tags with 400 and the checker\'s message, before calling the router', async () => {
    const s = setup();
    const cases: [unknown, string][] = [
      [{ 'dormeto:x': '1' }, 'tag "dormeto:x": the dormeto: prefix is reserved'],
      [{ team: 'a,b' }, 'tag "team": value characters: letters, digits, spaces and _ . : / = + - @'],
      [{ team: 7 }, 'tag "team": value must be a string'],
      [Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])), 'tags: at most 50'],
      [['a'], 'tags: an object of key and value strings'],
      [undefined, 'tags: an object of key and value strings'],
    ];
    for (const [tags, message] of cases) {
      const res = await s.api(event('PUT', '/api/workloads/dmt-dev/pay/tags', 'dmt-admin', { tags }));
      expect([res.statusCode, json(res)], message).toEqual([400, { error: 'bad_request', message }]);
    }
    expect((await s.api(event('PUT', '/api/workloads/dmt-dev/bad%20id/tags', 'dmt-admin', { tags: {} }))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it('answers 409 with the router\'s words for a Terraform workload, 404 for one not configured, and says an old router is too old', async () => {
    const s = setup(async (_router, payload) => {
      if (payload.workloadId === 'tf') throw new RouterError('workload tf was written by Terraform: set tags in its workload module');
      if (payload.workloadId === 'gone') throw new RouterError('workload not configured: gone');
      throw new RouterError('unknown action: tag');
    });
    const tf = await s.api(event('PUT', '/api/workloads/dmt-dev/tf/tags', 'dmt-admin', { tags: { a: 'b' } }));
    expect([tf.statusCode, json(tf)]).toEqual([409, { error: 'conflict', message: 'workload tf was written by Terraform: set tags in its workload module' }]);
    expect((await s.api(event('PUT', '/api/workloads/dmt-dev/gone/tags', 'dmt-admin', { tags: {} }))).statusCode).toBe(404);
    const old = await s.api(event('PUT', '/api/workloads/dmt-dev/old/tags', 'dmt-admin', { tags: {} }));
    expect([old.statusCode, json(old).message]).toEqual([409, 'router dmt-dev too old to set tags, upgrade it to 0.30.0 or later']);
    expect(s.audit.map((e) => e.result)).toEqual(['error: workload tf was written by Terraform: set tags in its workload module', 'error: workload not configured: gone', 'error: router dmt-dev too old to set tags, upgrade it to 0.30.0 or later']);
  });
});

describe('the tags of an onboarding', () => {
  const candidate = { targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/app/73e2d6bc24d8a067', account: '111111111111', region: 'eu-west-1' };
  // Discovery is optional in the API: a store with the candidate.
  function withDiscovery() {
    const created: Record<string, unknown>[] = [];
    const audit: AuditEntry[] = [];
    const api = createApi({
      routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.14.0', audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
      async invoke() { return null; },
      discovery: { store: { getCandidate: async () => candidate, getAccountScan: async () => null } as never, run: async () => {} },
      operations: { async create(_t: string, input: Record<string, unknown>) { created.push(input); return { id: 'op1' }; }, list: async () => [], get: async () => null, installedRouters: async () => [] } as never,
    });
    return { api, created, audit };
  }

  it('passes valid tags to the operation, none when not given, and refuses bad ones with 400', async () => {
    const s = withDiscovery();
    const post = (body: Record<string, unknown>) => s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: candidate.targetGroupArn, ...body }));
    const admin = (body: Record<string, unknown>) => s.api(event('POST', '/api/operations', 'dmt-admin', { type: 'onboard', candidateId: candidate.targetGroupArn, ...body }));
    expect((await admin({ tags: { team: 'payments' } })).statusCode).toBe(202);
    expect((await post({})).statusCode).toBe(202);
    expect((await post({ tags: {} })).statusCode).toBe(202);
    expect(s.created[0]).toMatchObject({ tags: { team: 'payments' } });
    expect(s.created[1]).not.toHaveProperty('tags');
    const bad = await post({ tags: { 'dormeto:x': '1' } });
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'tag "dormeto:x": the dormeto: prefix is reserved']);
    expect(s.created).toHaveLength(3);
  });

  it('refuses tags at onboarding to an operator with 403, audited, and creates nothing', async () => {
    const s = withDiscovery();
    const res = await s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: candidate.targetGroupArn, tags: { team: 'payments' } }));
    expect([res.statusCode, json(res).error]).toEqual([403, 'forbidden']);
    expect(s.created).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'onboard', result: 'refused', who: 'ops@example.com' });
  });
});
