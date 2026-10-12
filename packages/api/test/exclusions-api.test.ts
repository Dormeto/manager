import { describe, expect, it } from 'vitest';
import type { Candidate, Exclusion } from '@dormeto/discovery';
import { createApi, RouterError, type ApiEvent, type AuditEntry } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const DAY = 86_400_000;
const ACCOUNT = '121014831971';
const LB = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:loadbalancer/app/dmt-dev/50dc6c495c0c9188`;
const TG = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/dmt-dev-asg-app/73e2d6bc24d8a067`;
const TG2 = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/dmt-dev-ecs-app/1111111111111111`;

const managed = (id: string, workloadId: string, targetGroupArn: string, over: Partial<Candidate> = {}) => candidate(id, {
  loadBalancerArn: LB, loadBalancer: 'dmt-dev', targetGroupArn, eligibility: 'managed', workloadId, backend: null,
  status: 'managed', statusReason: 'managed', ...over,
});

type Answer = (router: string, payload: Record<string, unknown>) => unknown;
function setup(candidates: Candidate[] = [managed(TG, 'demo-asg', TG), managed(TG2, 'other', TG2), candidate('free', { loadBalancerArn: LB, targetGroupArn: 'arn:free' })], answer?: Answer, workloads: Record<string, unknown>[] = []) {
  const audit: AuditEntry[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const store = memoryStore(candidates);
  store.config = { config: { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [], filters: [{ name: 'a', include: [{ accountIds: [ACCOUNT] }], exclude: [] }] }, updatedAt: '', updatedBy: '' };
  let ids = 0;
  // The workflow: the API creates the operation; its steps run elsewhere (operations engine tests).
  const created: [string, Record<string, unknown>, string][] = [];
  const operations = {
    // An operation already running on the exclusion: the workflow refuses a second one.
    busy: null as string | null,
    async create(type: string, input: Record<string, unknown>, by: string) {
      if (operations.busy) throw Object.assign(new Error(`operation ${operations.busy} is running`), { name: 'Conflict', operationId: operations.busy });
      created.push([type, input, by]);
      return { id: `op${created.length}`, type, input } as never;
    },
    list: async () => [], get: async () => null, installedRouters: async () => [],
  };
  const api = createApi({
    routers: [
      { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT },
      { name: 'dmt-dev2', region: 'eu-west-1', controller: 'dmt-dev2-controller', account: ACCOUNT },
      { name: 'dmt-paris', region: 'eu-west-3', controller: 'dmt-paris-controller', account: ACCOUNT },
    ],
    async invoke(router, payload) {
      calls.push([router.name, payload]);
      if (answer) return answer(router.name, payload);
      if (payload.workloadId === 'other') throw new RouterError('workload not configured: other');
      if (payload.action === 'pause') return { pause: {}, woken: [payload.workloadId] };
      if (payload.action === 'resume') return { resumed: true };
      return null;
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => `x${++ids}`, version: '0.2.0',
    discovery: { store, run: async () => {} },
    operations: operations as never,
    fleet: {
      listRouters: async () => [], listWorkloads: async () => { throw new Error('exclusions never list every workload'); },
      getWorkload: async (account: string, region: string, id: string) => (workloads.find((w) => w.account === account && w.region === region && w.workloadId === id) ?? null) as never,
    },
  });
  return { api, audit, calls, store, created, operations };
}

function event(method: string, path: string, groups = '', body?: unknown): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const expiresAt = new Date(NOW + 7 * DAY).toISOString();

describe('exclusions', () => {
  it('excludes a target group: stored, its candidate waits for offboarding, the workflow pauses its workloads, audited', async () => {
    const { api, audit, calls, store, created } = setup();
    expect((await api(event('POST', '/api/exclusions', 'dmt-viewer', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: ' migration ', expiresAt }));
    expect(res.statusCode).toBe(202);
    const exclusion: Exclusion = {
      id: 'x1', target: { kind: 'target-group', arn: TG, account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev-asg-app' },
      reason: 'migration', by: 'ops@example.com', at: new Date(NOW).toISOString(), expiresAt,
    };
    expect(json(res)).toMatchObject({ exclusion, candidates: 1, operation: { id: 'op1' } });
    expect(await store.getExclusion('x1')).toEqual(exclusion);
    // The API answers at once: no router is called, the operation pauses the workloads.
    expect([calls, created]).toEqual([[], [['exclude', { exclusionId: 'x1' }, 'ops@example.com']]]);
    const stored = await store.getCandidate(TG);
    expect([stored!.status, stored!.statusReason]).toEqual(['pending-offboarding', 'excluded: manual exclusion by ops@example.com: migration']);
    expect((await store.getCandidate('free'))!.status).toBe('pending-onboarding');
    expect(audit).toEqual([{ id: 'x2', at: new Date(NOW).toISOString(), who: 'ops@example.com', role: 'operator', action: 'exclude', target: 'target group dmt-dev-asg-app', result: `migration; until ${expiresAt}; operation op1` }]);
  });

  it('excludes a load balancer: every candidate on it', async () => {
    const { api, store } = setup();
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'legacy' })));
    expect(res.candidates).toBe(3);
    expect((await store.getCandidate('free'))!.status).toBe('excluded');
    expect((await store.getExclusion('x1'))!.target).toEqual({ kind: 'load-balancer', arn: LB, account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev' });
  });

  it('excludes an account, named from the organization inventory', async () => {
    const { api, store } = setup();
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'account', account: ACCOUNT }, reason: 'payments' })));
    expect(res.exclusion.target).toEqual({ kind: 'account', account: ACCOUNT, name: 'dormeto' });
    expect((await store.listCandidates()).map((c) => c.status).sort()).toEqual(['excluded', 'pending-offboarding', 'pending-offboarding']);
  });

  it('passes the workload it was created from to the workflow, even without a discovery candidate', async () => {
    const { api, created } = setup([]);
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration', workload: { router: 'dmt-dev', id: 'demo-asg' } }));
    // The workflow finds the routers from the target group's account and region: it names installed routers otherwise.
    expect(created).toEqual([['exclude', { exclusionId: 'x1', hint: { workloadId: 'demo-asg' } }, 'ops@example.com']]);
  });

  it('refuses a workload whose router is not in the target group\'s account and region', async () => {
    const { api, store } = setup([]);
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration', workload: { router: 'dmt-paris', id: 'demo-asg' } }));
    expect(res.statusCode).toBe(400);
    expect(await store.listExclusions()).toEqual([]);
  });

  it('refuses an unknown kind, a malformed ARN or account, a missing reason, an expiry in the past or an unknown router', async () => {
    const { api, store, audit } = setup();
    for (const body of [
      { target: { kind: 'rule', arn: TG }, reason: 'a' },
      { target: { kind: 'target-group', arn: LB }, reason: 'a' },
      { target: { kind: 'load-balancer', arn: 'web' }, reason: 'a' },
      { target: { kind: 'account', account: '1234' }, reason: 'a' },
      { target: { kind: 'target-group', arn: TG } },
      { target: { kind: 'target-group', arn: TG }, reason: 'a', expiresAt: new Date(NOW - 1).toISOString() },
      { target: { kind: 'target-group', arn: TG }, reason: 'a', workload: { router: 'nope', id: 'demo' } },
    ]) {
      expect((await api(event('POST', '/api/exclusions', 'dmt-operator', body))).statusCode).toBe(400);
    }
    expect(await store.listExclusions()).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('refuses a reason the router could not take once prefixed with "excluded: "', async () => {
    const { api, store } = setup();
    const at = (reason: string) => api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason }));
    expect((await at('x'.repeat(247))).statusCode).toBe(400);
    expect((await at('x'.repeat(246))).statusCode).toBe(202);
    expect(await store.listExclusions()).toHaveLength(1);
  });

  it('accepts the workload it was created from with a target group exclusion only', async () => {
    const { api } = setup();
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'a', workload: { router: 'dmt-dev', id: 'demo-asg' } }));
    expect(res.statusCode).toBe(400);
  });

  it('a lift marks the exclusion lifted, brings the candidates back and lets the workflow resume its workloads; lifting again retries', async () => {
    const { api, store, created, calls } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    const first = await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'));
    expect([first.statusCode, json(first)]).toEqual([202, { candidates: 1, operation: expect.objectContaining({ id: 'op2' }) }]);
    expect(created.at(-1)).toEqual(['lift-exclusion', { exclusionId: 'x1' }, 'ops@example.com']);
    expect((await store.getExclusion('x1'))!.liftedAt).toBe(new Date(NOW).toISOString());
    expect((await store.getCandidate(TG))!.status).toBe('managed');
    const { exclusions } = json(await api(event('GET', '/api/exclusions')));
    expect(exclusions[0].lifting).toBe(true);
    // Still listed (the operation deletes it once everything is resumed): lifting again starts another operation.
    expect((await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'))).statusCode).toBe(202);
    expect(calls).toEqual([]);
  });

  it('a lift while an operation runs on the exclusion is a conflict, and changes nothing', async () => {
    const { api, store, operations } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    const before = structuredClone(await store.getExclusion('x1'));
    operations.busy = 'op1';
    const res = await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'));
    expect([res.statusCode, json(res)]).toEqual([409, { error: 'conflict', message: 'operation op1 is running', operationId: 'op1' }]);
    expect(await store.getExclusion('x1')).toEqual(before);
    expect((await store.getCandidate(TG))!.status).toBe('pending-offboarding');
  });

  it('an expired exclusion brings its candidates back without a run, once', async () => {
    const { api, store } = setup();
    let now = NOW;
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration', expiresAt: new Date(NOW + DAY).toISOString() }));
    expect((await store.getCandidate(TG))!.status).toBe('pending-offboarding');
    now = NOW + 2 * DAY;
    const later = createApi({
      routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c', account: ACCOUNT }], invoke: async () => null,
      audit: { write: async () => {}, list: async () => [] }, now: () => now, version: '0.2.0', discovery: { store, run: async () => {} },
    });
    expect((await later(event('GET', '/api/discovery'))).statusCode).toBe(200);
    expect((await store.getCandidate(TG))!.status).toBe('managed');
    expect((await store.getExclusion('x1'))!.lapsedAt).toBe(new Date(NOW + 2 * DAY).toISOString());
  });

  it('names the workloads an exclusion paused from their summaries', async () => {
    const { api, store } = setup([], undefined, [{ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a4dffc5bf369a297', name: 'Shop' }]);
    await store.putExclusion({
      id: 'x9', target: { kind: 'account', account: ACCOUNT, name: 'dormeto' }, reason: 'a', by: 'ops@example.com', at: '2026-10-04T00:00:00.000Z',
      paused: [{ router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'a4dffc5bf369a297' }, { router: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: 'gone' }],
    });
    const [e] = json(await api(event('GET', '/api/exclusions'))).exclusions;
    expect(e.paused.map((p: { name?: string }) => p.name ?? null)).toEqual(['Shop', null]);
  });

  it('lists exclusions to viewers, expired ones marked', async () => {
    const { api, store } = setup();
    await store.putExclusion({ id: 'old', target: { kind: 'account', account: ACCOUNT, name: 'dormeto' }, reason: 'a', by: 'ops@example.com', at: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z' });
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    const { exclusions } = json(await api(event('GET', '/api/exclusions')));
    expect(exclusions.map((e: Exclusion & { expired: boolean }) => [e.id, e.expired])).toEqual([['old', true], ['x1', false]]);
  });

  it('lifting is for operators, audited, and an unknown exclusion is a 404', async () => {
    const { api, audit } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    expect((await api(event('DELETE', '/api/exclusions/x1', 'dmt-viewer'))).statusCode).toBe(403);
    await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'));
    expect(audit.at(-1)).toMatchObject({ action: 'exclusion-lift', target: 'target group dmt-dev-asg-app', result: 'migration; operation op2' });
    expect((await api(event('DELETE', '/api/exclusions/nope', 'dmt-operator'))).statusCode).toBe(404);
  });

  it('the perimeter lint counts the active exclusions', async () => {
    const { api } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'account', account: ACCOUNT }, reason: 'payments' }));
    const { lint } = json(await api(event('GET', '/api/discovery/config')));
    expect(lint).toEqual([expect.objectContaining({ code: 'include-shadowed-by-global-exclude', by: 'manual exclusion by ops@example.com: payments' })]);
  });
});
